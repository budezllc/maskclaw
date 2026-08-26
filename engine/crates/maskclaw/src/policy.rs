// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Force-local policy evaluated from a scrub scan.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// When MaskClaw should swap the request onto the configured local route.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForceLocalPolicy {
    /// Never override the caller's route.
    #[default]
    Never,
    /// Override when a critical dictionary/regex hit remains, or residual high-entropy tokens.
    OnUnmaskable,
    /// Always override when a local route id is configured.
    Always,
}

/// Counters collected while walking a request.
#[derive(Clone, Debug, Default)]
pub struct ScanStats {
    /// Total replacements applied.
    pub matches: usize,
    /// Hits tagged `critical` in config.
    pub critical: usize,
    /// High-entropy tokens still present after masking.
    pub residual: usize,
    /// Replacements grouped by placeholder slug.
    pub by_kind: BTreeMap<String, usize>,
}

impl ForceLocalPolicy {
    /// Returns whether the scan should force the local route.
    pub fn decide(self, stats: &ScanStats) -> bool {
        match self {
            Self::Never => false,
            Self::Always => true,
            Self::OnUnmaskable => stats.critical > 0 || stats.residual > 0,
        }
    }
}
