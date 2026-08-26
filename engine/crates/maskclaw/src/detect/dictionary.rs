// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Aho-Corasick dictionaries of exact secrets.

use aho_corasick::AhoCorasick;

use crate::config::DictionaryEntry;

use super::{Detector, Finding};

/// Literal multi-pattern detector.
pub struct DictionaryDetector {
    kind: String,
    critical: bool,
    automaton: AhoCorasick,
    patterns: Vec<String>,
}

impl DictionaryDetector {
    /// Returns `None` when the dictionary has no non-empty values.
    pub fn new(entry: &DictionaryEntry) -> Option<Self> {
        let patterns: Vec<String> = entry
            .values
            .iter()
            .filter(|value| !value.is_empty())
            .cloned()
            .collect();
        if patterns.is_empty() {
            return None;
        }
        let automaton = AhoCorasick::new(&patterns).ok()?;
        Some(Self {
            kind: entry.kind.clone(),
            critical: entry.critical,
            automaton,
            patterns,
        })
    }
}

impl Detector for DictionaryDetector {
    fn detect(&self, text: &str) -> Vec<Finding> {
        self.automaton
            .find_iter(text)
            .map(|matched| Finding {
                start: matched.start(),
                end: matched.end(),
                kind: self.kind.clone(),
                value: self.patterns[matched.pattern().as_usize()].clone(),
                critical: self.critical,
            })
            .collect()
    }
}
