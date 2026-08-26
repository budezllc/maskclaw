// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Detector trait and v1 deterministic implementations.

mod builtin;
mod dictionary;

use crate::config::MaskclawConfig;
use crate::error::Error;
use crate::placeholders;

pub use builtin::{Allowlist, RegexDetector, residual_high_entropy_count};
pub use dictionary::DictionaryDetector;

/// One secret span found in a text buffer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Finding {
    /// Byte offset of the match start.
    pub start: usize,
    /// Byte offset of the match end (exclusive).
    pub end: usize,
    /// Placeholder type slug.
    pub kind: String,
    /// Matched secret text.
    pub value: String,
    /// Whether this hit can force local routing.
    pub critical: bool,
}

impl Finding {
    /// Match length in bytes.
    pub fn len(&self) -> usize {
        self.end.saturating_sub(self.start)
    }
}

/// A detector that reports secret spans in a UTF-8 buffer.
pub trait Detector: Send + Sync {
    /// Returns non-overlapping-at-source findings; the engine merges across detectors.
    fn detect(&self, text: &str) -> Vec<Finding>;
}

/// Compiles every enabled detector from config.
pub fn compile_detectors(config: &MaskclawConfig) -> Result<Vec<Box<dyn Detector>>, Error> {
    let mut detectors: Vec<Box<dyn Detector>> = Vec::new();
    detectors.extend(builtin::compile(&config.detectors)?);
    for entry in &config.dictionary {
        if let Some(detector) = DictionaryDetector::new(entry) {
            detectors.push(Box::new(detector));
        }
    }
    for entry in &config.regex {
        detectors.push(Box::new(RegexDetector::custom(entry)?));
    }
    Ok(detectors)
}

/// Drops overlapping findings, preferring earlier then longer matches.
pub fn merge_findings(
    mut findings: Vec<Finding>,
    text: &str,
    allowlist: &Allowlist,
) -> Vec<Finding> {
    findings.retain(|finding| {
        !allowlist.contains(&finding.value)
            && !overlaps_placeholder(text, finding.start, finding.end)
    });
    findings.sort_by(|left, right| {
        left.start
            .cmp(&right.start)
            .then_with(|| right.len().cmp(&left.len()))
    });
    let mut kept = Vec::new();
    let mut last_end = 0usize;
    for finding in findings {
        if finding.start >= last_end && finding.start < finding.end && finding.end <= text.len() {
            last_end = finding.end;
            kept.push(finding);
        }
    }
    kept
}

fn overlaps_placeholder(text: &str, start: usize, end: usize) -> bool {
    let Ok(re) = regex::Regex::new(placeholders::PATTERN) else {
        return false;
    };
    re.find_iter(text)
        .any(|matched| matched.start() < end && start < matched.end())
}
