// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Compiled regex detectors and residual high-entropy scan.

use std::collections::HashSet;

use regex::Regex;

use crate::config::{CustomRegex, DetectorToggles};
use crate::error::Error;
use crate::placeholders;

use super::{Detector, Finding};

/// Exact-string skip list applied after detection.
#[derive(Clone, Debug, Default)]
pub struct Allowlist {
    values: HashSet<String>,
}

impl Allowlist {
    pub fn new(values: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            values: values
                .into_iter()
                .map(Into::into)
                .filter(|value| !value.is_empty())
                .collect(),
        }
    }

    pub fn contains(&self, value: &str) -> bool {
        self.values.contains(value)
    }
}

/// One compiled regex detector.
pub struct RegexDetector {
    kind: String,
    regex: Regex,
    critical: bool,
    luhn: bool,
}

impl RegexDetector {
    fn builtin(kind: &str, pattern: &str, luhn: bool) -> Result<Self, Error> {
        Ok(Self {
            kind: kind.to_string(),
            regex: Regex::new(pattern).map_err(|source| Error::Regex {
                name: kind.to_string(),
                source,
            })?,
            critical: false,
            luhn,
        })
    }

    /// Compiles a sidecar `[[regex]]` entry.
    pub fn custom(entry: &CustomRegex) -> Result<Self, Error> {
        Ok(Self {
            kind: entry.kind.clone(),
            regex: Regex::new(&entry.pattern).map_err(|source| Error::Regex {
                name: entry.kind.clone(),
                source,
            })?,
            critical: entry.critical,
            luhn: false,
        })
    }
}

impl Detector for RegexDetector {
    fn detect(&self, text: &str) -> Vec<Finding> {
        self.regex
            .find_iter(text)
            .filter_map(|matched| {
                let value = matched.as_str();
                if self.luhn && !luhn_ok(value) {
                    return None;
                }
                Some(Finding {
                    start: matched.start(),
                    end: matched.end(),
                    kind: self.kind.clone(),
                    value: value.to_string(),
                    critical: self.critical,
                })
            })
            .collect()
    }
}

pub fn compile(toggles: &DetectorToggles) -> Result<Vec<Box<dyn Detector>>, Error> {
    let mut detectors: Vec<Box<dyn Detector>> = Vec::new();
    if toggles.email {
        detectors.push(Box::new(RegexDetector::builtin(
            "email",
            r"(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,24}\b",
            false,
        )?));
    }
    if toggles.phone {
        detectors.push(Box::new(RegexDetector::builtin(
            "phone",
            r"\b(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}\b",
            false,
        )?));
    }
    if toggles.ssn {
        detectors.push(Box::new(RegexDetector::builtin(
            "ssn",
            r"\b\d{3}-\d{2}-\d{4}\b",
            false,
        )?));
    }
    if toggles.credit_card {
        detectors.push(Box::new(RegexDetector::builtin(
            "credit_card",
            r"\b(?:\d{4}[ -]?){3}\d{3,4}\b",
            true,
        )?));
    }
    if toggles.jwt {
        detectors.push(Box::new(RegexDetector::builtin(
            "jwt",
            r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
            false,
        )?));
    }
    if toggles.aws_key {
        detectors.push(Box::new(RegexDetector::builtin(
            "aws_key",
            r"\bAKIA[0-9A-Z]{16}\b",
            false,
        )?));
    }
    if toggles.api_key {
        detectors.push(Box::new(RegexDetector::builtin(
            "api_key",
            r"\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_\-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b",
            false,
        )?));
    }
    Ok(detectors)
}

/// Counts leftover tokens that look like unmasked secrets.
pub fn residual_high_entropy_count(text: &str) -> usize {
    let Ok(token) = Regex::new(r"\b[A-Za-z0-9_\-]{40,}\b") else {
        return 0;
    };
    let Ok(placeholder) = Regex::new(placeholders::PATTERN) else {
        return 0;
    };
    token
        .find_iter(text)
        .filter(|matched| {
            let value = matched.as_str();
            !placeholder.is_match(value) && has_letter_and_digit(value)
        })
        .count()
}

fn has_letter_and_digit(value: &str) -> bool {
    value
        .chars()
        .any(|character| character.is_ascii_alphabetic())
        && value.chars().any(|character| character.is_ascii_digit())
}

fn luhn_ok(value: &str) -> bool {
    let digits: Vec<u32> = value
        .chars()
        .filter_map(|character| character.to_digit(10))
        .collect();
    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }
    let checksum = digits
        .iter()
        .rev()
        .enumerate()
        .fold(0u32, |acc, (index, digit)| {
            let mut value = *digit;
            if index % 2 == 1 {
                value *= 2;
                if value > 9 {
                    value -= 9;
                }
            }
            acc + value
        });
    checksum.is_multiple_of(10)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visa_test_number_passes_luhn() {
        assert!(luhn_ok("4111111111111111"));
        assert!(!luhn_ok("4111111111111112"));
    }
}
