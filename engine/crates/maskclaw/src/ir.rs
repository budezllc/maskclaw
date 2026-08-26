// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Walks Switchyard IR strings that can carry user or tool text.

use std::collections::HashMap;

use regex::Regex;
use serde_json::Value;
use switchyard_protocol::{
    AggLlmResponse, ContentBlock, FileSource, ImageSource, LlmRequest, MediaSource, ToolChoice,
    ToolDefinition,
};

use crate::placeholders;
use crate::restore;
use crate::session::SessionRecord;
use crate::{detect, policy::ScanStats};

const SKIP_INLINE_LEN: usize = 256;

/// Applies detectors to every text-bearing request field.
pub fn scrub_request(
    request: &mut LlmRequest,
    detectors: &[Box<dyn detect::Detector>],
    allowlist: &detect::Allowlist,
    session: &mut SessionRecord,
    stats: &mut ScanStats,
) {
    for instruction in &mut request.instructions {
        scrub_blocks(
            &mut instruction.content,
            detectors,
            allowlist,
            session,
            stats,
        );
    }
    for message in &mut request.messages {
        scrub_blocks(&mut message.content, detectors, allowlist, session, stats);
    }
    for tool in &mut request.tools {
        scrub_tool_definition(tool, detectors, allowlist, session, stats);
    }
    if let Some(ToolChoice::Raw(raw)) = &mut request.tool_choice {
        scrub_json(raw, detectors, allowlist, session, stats);
    }
    if let Some(format) = &mut request.output.response_format {
        scrub_json(format, detectors, allowlist, session, stats);
    }
    if let Some(raw) = &mut request.reasoning.raw {
        scrub_json(raw, detectors, allowlist, session, stats);
    }
    for value in request.extensions.fields.values_mut() {
        scrub_json(value, detectors, allowlist, session, stats);
    }
}

/// Restores placeholders in a buffered response.
pub fn restore_agg(
    response: &mut AggLlmResponse,
    map: &HashMap<String, String>,
    placeholder: &Regex,
) {
    for output in &mut response.outputs {
        restore_blocks(&mut output.content, map, placeholder);
    }
    for value in response.extensions.fields.values_mut() {
        restore_json(value, map, placeholder);
    }
    response.preservation = Default::default();
}

fn scrub_tool_definition(
    tool: &mut ToolDefinition,
    detectors: &[Box<dyn detect::Detector>],
    allowlist: &detect::Allowlist,
    session: &mut SessionRecord,
    stats: &mut ScanStats,
) {
    if let Some(description) = &mut tool.description {
        scrub_string(description, detectors, allowlist, session, stats);
    }
    scrub_json(&mut tool.parameters, detectors, allowlist, session, stats);
}

fn scrub_blocks(
    blocks: &mut [ContentBlock],
    detectors: &[Box<dyn detect::Detector>],
    allowlist: &detect::Allowlist,
    session: &mut SessionRecord,
    stats: &mut ScanStats,
) {
    for block in blocks {
        match block {
            ContentBlock::Text { text } | ContentBlock::Refusal { text } => {
                scrub_string(text, detectors, allowlist, session, stats);
            }
            ContentBlock::Reasoning { text, .. } => {
                scrub_string(text, detectors, allowlist, session, stats);
            }
            ContentBlock::ToolCall(call) => {
                scrub_json(&mut call.arguments, detectors, allowlist, session, stats);
            }
            ContentBlock::ToolResult(result) => {
                scrub_blocks(&mut result.content, detectors, allowlist, session, stats);
            }
            ContentBlock::Unknown { raw, .. } => {
                scrub_json(raw, detectors, allowlist, session, stats);
            }
            ContentBlock::Image { source } => match source {
                ImageSource::Url { url, .. } if !url.starts_with("data:") => {
                    scrub_string(url, detectors, allowlist, session, stats);
                }
                ImageSource::Raw(raw) => scrub_json(raw, detectors, allowlist, session, stats),
                _ => {}
            },
            ContentBlock::File { source } => match source {
                FileSource::FileData {
                    filename: Some(name),
                    ..
                } => {
                    scrub_string(name, detectors, allowlist, session, stats);
                }
                FileSource::Raw(raw) => scrub_json(raw, detectors, allowlist, session, stats),
                _ => {}
            },
            ContentBlock::Audio { source } | ContentBlock::Video { source } => {
                if let MediaSource::Url { url, .. } = source {
                    scrub_string(url, detectors, allowlist, session, stats);
                }
            }
        }
    }
}

fn restore_blocks(blocks: &mut [ContentBlock], map: &HashMap<String, String>, placeholder: &Regex) {
    for block in blocks {
        match block {
            ContentBlock::Text { text } | ContentBlock::Refusal { text } => {
                *text = restore::restore_text(text, map, placeholder);
            }
            ContentBlock::Reasoning { text, .. } => {
                *text = restore::restore_text(text, map, placeholder);
            }
            ContentBlock::ToolCall(call) => restore_json(&mut call.arguments, map, placeholder),
            ContentBlock::ToolResult(result) => {
                restore_blocks(&mut result.content, map, placeholder)
            }
            ContentBlock::Unknown { raw, .. } => restore_json(raw, map, placeholder),
            ContentBlock::Image { source } => {
                if let ImageSource::Url { url, .. } = source {
                    *url = restore::restore_text(url, map, placeholder);
                }
            }
            ContentBlock::File { source } => {
                if let FileSource::FileData {
                    filename: Some(name),
                    ..
                } = source
                {
                    *name = restore::restore_text(name, map, placeholder);
                }
            }
            ContentBlock::Audio { source } | ContentBlock::Video { source } => {
                if let MediaSource::Url { url, .. } = source {
                    *url = restore::restore_text(url, map, placeholder);
                }
            }
        }
    }
}

fn scrub_json(
    value: &mut Value,
    detectors: &[Box<dyn detect::Detector>],
    allowlist: &detect::Allowlist,
    session: &mut SessionRecord,
    stats: &mut ScanStats,
) {
    match value {
        Value::String(text) if text.len() <= SKIP_INLINE_LEN || looks_textual(text) => {
            scrub_string(text, detectors, allowlist, session, stats);
        }
        Value::String(_) => {}
        Value::Array(items) => {
            for item in items {
                scrub_json(item, detectors, allowlist, session, stats);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                scrub_json(item, detectors, allowlist, session, stats);
            }
        }
        _ => {}
    }
}

fn restore_json(value: &mut Value, map: &HashMap<String, String>, placeholder: &Regex) {
    match value {
        Value::String(text) => *text = restore::restore_text(text, map, placeholder),
        Value::Array(items) => {
            for item in items {
                restore_json(item, map, placeholder);
            }
        }
        Value::Object(object) => {
            for item in object.values_mut() {
                restore_json(item, map, placeholder);
            }
        }
        _ => {}
    }
}

fn looks_textual(text: &str) -> bool {
    text.chars()
        .any(|character| character.is_ascii_whitespace())
}

pub fn scrub_string(
    text: &mut String,
    detectors: &[Box<dyn detect::Detector>],
    allowlist: &detect::Allowlist,
    session: &mut SessionRecord,
    stats: &mut ScanStats,
) {
    let mut findings = Vec::new();
    for detector in detectors {
        findings.extend(detector.detect(text));
    }
    let findings = detect::merge_findings(findings, text, allowlist);
    if findings.is_empty() {
        stats.residual += detect::residual_high_entropy_count(text);
        return;
    }
    for finding in findings.iter().rev() {
        let placeholder = session.placeholder_for(&finding.kind, &finding.value);
        text.replace_range(finding.start..finding.end, &placeholder);
        stats.matches += 1;
        *stats
            .by_kind
            .entry(placeholders::sanitize_kind(&finding.kind))
            .or_default() += 1;
        if finding.critical {
            stats.critical += 1;
        }
    }
    stats.residual += detect::residual_high_entropy_count(text);
}

#[cfg(test)]
mod tests {
    use switchyard_protocol::{ContentBlock, Role, ToolCall, ToolResult, text_request};

    use super::*;
    use crate::config::{DictionaryEntry, MaskclawConfig};
    use crate::detect::compile_detectors;
    use crate::session::SessionRecord;

    #[test]
    fn walker_masks_nested_tool_results_not_just_prompt_text() {
        let config = MaskclawConfig {
            dictionary: vec![DictionaryEntry {
                kind: "project".into(),
                critical: false,
                values: vec!["Project Apollo".into()],
            }],
            ..MaskclawConfig::default()
        };
        let detectors = compile_detectors(&config).expect("detectors");
        let allowlist = detect::Allowlist::default();
        let mut session = SessionRecord::new();
        let mut stats = ScanStats::default();
        let mut request = text_request(Some("model".into()), "no secret in the user turn");
        request.messages.push(switchyard_protocol::Message {
            role: Role::Tool,
            content: vec![ContentBlock::ToolResult(ToolResult {
                tool_call_id: "call-1".into(),
                content: vec![ContentBlock::Text {
                    text: "working on Project Apollo".into(),
                }],
                is_error: None,
            })],
        });
        request.messages[0]
            .content
            .push(ContentBlock::ToolCall(ToolCall {
                id: "call-1".into(),
                name: "search".into(),
                arguments: serde_json::json!({"q": "Project Apollo status"}),
            }));
        scrub_request(
            &mut request,
            &detectors,
            &allowlist,
            &mut session,
            &mut stats,
        );
        let prompt = switchyard_protocol::prompt_text(&request);
        assert!(!prompt.contains("Project Apollo"));
        let tool_text = format!("{:?}", request.messages);
        assert!(!tool_text.contains("Project Apollo"));
        assert!(tool_text.contains("__MC_project_"));
        assert!(stats.matches >= 2);
    }
}
