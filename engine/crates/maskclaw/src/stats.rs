// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Process-lifetime MaskClaw counters for the dashboard JSON snapshot.

use std::collections::BTreeMap;

use parking_lot::Mutex;
use serde::Serialize;

use crate::config::DetectorToggles;
use crate::policy::{ForceLocalPolicy, ScanStats};

/// RAM session occupancy. Secrets stay in the session store.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
pub struct SessionGauges {
    /// Sessions still inside the TTL window.
    pub active: u64,
    /// Distinct secrets currently mapped in RAM.
    pub unique_values: u64,
}

/// JSON body for `GET /v1/maskclaw/stats` when the engine is loaded.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StatsSnapshot {
    /// Always true for an engine-produced snapshot.
    pub enabled: bool,
    /// Configured force-local policy.
    pub force_local: ForceLocalPolicy,
    /// Route id used when force-local fires.
    pub local_route_id: Option<String>,
    /// Session map TTL in seconds.
    pub session_ttl_secs: u64,
    /// Built-in detector toggles (no secret material).
    pub detectors: DetectorToggles,
    /// Number of dictionary entries in the sidecar.
    pub dictionary_count: usize,
    /// Number of custom regex detectors in the sidecar.
    pub regex_count: usize,
    /// Number of allowlist strings in the sidecar.
    pub allowlist_count: usize,
    /// Scrubbed requests this process.
    pub requests: u64,
    /// Requests that applied at least one replacement.
    pub requests_with_matches: u64,
    /// Total replacements applied.
    pub matches: u64,
    /// Replacements tagged `critical`.
    pub critical: u64,
    /// Residual high-entropy tokens after masking.
    pub residual: u64,
    /// Requests that selected the local route.
    pub force_local_overrides: u64,
    /// Restores that found no session map.
    pub restore_misses: u64,
    /// Replacements grouped by placeholder slug.
    pub by_kind: BTreeMap<String, u64>,
    /// Live session occupancy.
    pub sessions: SessionGauges,
}

/// Compact config fields copied onto the engine for the snapshot.
pub(crate) struct EngineStatus {
    pub force_local: ForceLocalPolicy,
    pub local_route_id: Option<String>,
    pub session_ttl_secs: u64,
    pub detectors: DetectorToggles,
    pub dictionary_count: usize,
    pub regex_count: usize,
    pub allowlist_count: usize,
}

/// Running totals. Separate mutex from the session store.
#[derive(Default)]
pub(crate) struct StatsAccumulator {
    inner: Mutex<Totals>,
}

#[derive(Clone, Debug, Default)]
struct Totals {
    requests: u64,
    requests_with_matches: u64,
    matches: u64,
    critical: u64,
    residual: u64,
    force_local_overrides: u64,
    restore_misses: u64,
    by_kind: BTreeMap<String, u64>,
}

impl StatsAccumulator {
    pub(crate) fn record(&self, stats: &ScanStats, force_local: bool) {
        let mut inner = self.inner.lock();
        inner.requests = inner.requests.saturating_add(1);
        if stats.matches > 0 {
            inner.requests_with_matches = inner.requests_with_matches.saturating_add(1);
        }
        inner.matches = inner.matches.saturating_add(stats.matches as u64);
        inner.critical = inner.critical.saturating_add(stats.critical as u64);
        inner.residual = inner.residual.saturating_add(stats.residual as u64);
        if force_local {
            inner.force_local_overrides = inner.force_local_overrides.saturating_add(1);
        }
        for (kind, count) in &stats.by_kind {
            let slot = inner.by_kind.entry(kind.clone()).or_default();
            *slot = slot.saturating_add(*count as u64);
        }
    }

    pub(crate) fn record_restore_miss(&self) {
        let mut inner = self.inner.lock();
        inner.restore_misses = inner.restore_misses.saturating_add(1);
    }

    pub(crate) fn snapshot(&self, status: &EngineStatus, sessions: SessionGauges) -> StatsSnapshot {
        let inner = self.inner.lock();
        StatsSnapshot {
            enabled: true,
            force_local: status.force_local,
            local_route_id: status.local_route_id.clone(),
            session_ttl_secs: status.session_ttl_secs,
            detectors: status.detectors.clone(),
            dictionary_count: status.dictionary_count,
            regex_count: status.regex_count,
            allowlist_count: status.allowlist_count,
            requests: inner.requests,
            requests_with_matches: inner.requests_with_matches,
            matches: inner.matches,
            critical: inner.critical,
            residual: inner.residual,
            force_local_overrides: inner.force_local_overrides,
            restore_misses: inner.restore_misses,
            by_kind: inner.by_kind.clone(),
            sessions,
        }
    }
}
