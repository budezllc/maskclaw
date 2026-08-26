// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Overlap-safe restore of placeholders, including SSE fragment splits.

use std::collections::HashMap;

use regex::Regex;
use switchyard_protocol::LlmResponseChunk;

use crate::placeholders;

/// Restores complete placeholders and holds a suffix that might still grow.
pub struct StreamRestorer {
    leftover: String,
    placeholder: Regex,
}

impl StreamRestorer {
    /// Creates a restorer for one response stream.
    pub fn new(placeholder: Regex) -> Self {
        Self {
            leftover: String::new(),
            placeholder,
        }
    }

    /// Restores `fragment` plus any leftover prefix; keeps a partial suffix.
    pub fn push(&mut self, fragment: &str, map: &HashMap<String, String>) -> String {
        self.leftover.push_str(fragment);
        let restored = restore_text(&self.leftover, map, &self.placeholder);
        let hold = placeholders::partial_suffix_len(&restored);
        let mut split = restored.len().saturating_sub(hold);
        if !restored.is_char_boundary(split) {
            split = restored.len();
        }
        let ready = restored[..split].to_string();
        self.leftover = restored[split..].to_string();
        ready
    }

    /// Flushes leftover bytes at stream end.
    pub fn finish(&mut self, map: &HashMap<String, String>) -> String {
        let leftover = std::mem::take(&mut self.leftover);
        restore_text(&leftover, map, &self.placeholder)
    }

    /// Restores text-bearing chunks; other variants pass through.
    pub fn restore_chunks(
        &mut self,
        chunks: Vec<LlmResponseChunk>,
        map: &HashMap<String, String>,
        last: bool,
    ) -> Vec<LlmResponseChunk> {
        let mut out = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            out.push(self.restore_chunk(chunk, map));
        }
        if last {
            let flushed = self.finish(map);
            if !flushed.is_empty() {
                out.push(LlmResponseChunk::TextDelta {
                    index: 0,
                    text: flushed,
                });
            }
        }
        out
    }

    fn restore_chunk(
        &mut self,
        chunk: LlmResponseChunk,
        map: &HashMap<String, String>,
    ) -> LlmResponseChunk {
        match chunk {
            LlmResponseChunk::TextDelta { index, text } => LlmResponseChunk::TextDelta {
                index,
                text: self.push(&text, map),
            },
            LlmResponseChunk::ReasoningDelta { index, text } => LlmResponseChunk::ReasoningDelta {
                index,
                text: self.push(&text, map),
            },
            LlmResponseChunk::ReasoningDetailsDelta {
                index,
                details,
                text,
            } => LlmResponseChunk::ReasoningDetailsDelta {
                index,
                details,
                text: self.push(&text, map),
            },
            LlmResponseChunk::ToolCallDelta {
                index,
                id,
                name,
                arguments_delta,
            } => LlmResponseChunk::ToolCallDelta {
                index,
                id,
                name,
                arguments_delta: arguments_delta.map(|delta| self.push(&delta, map)),
            },
            other => other,
        }
    }
}

/// Replaces complete placeholders in a fully buffered string.
pub fn restore_text(text: &str, map: &HashMap<String, String>, placeholder: &Regex) -> String {
    placeholder
        .replace_all(text, |caps: &regex::Captures| {
            let Some(full) = caps.get(0) else {
                return String::new();
            };
            map.get(full.as_str())
                .cloned()
                .unwrap_or_else(|| full.as_str().to_string())
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placeholders::{PATTERN, mint};

    #[test]
    fn split_placeholder_reassembles_across_fragments() {
        let key = [3u8; 32];
        let placeholder = mint(&key, "email", "ada@example.com");
        let mut map = HashMap::new();
        map.insert(placeholder.clone(), "ada@example.com".to_string());
        let re = Regex::new(PATTERN).expect("static placeholder pattern");
        let mut restorer = StreamRestorer::new(re);
        let mid = placeholder.len() / 2;
        let first = restorer.push(&placeholder[..mid], &map);
        let second = restorer.push(&placeholder[mid..], &map);
        let tail = restorer.finish(&map);
        assert_eq!(format!("{first}{second}{tail}"), "ada@example.com");
    }
}
