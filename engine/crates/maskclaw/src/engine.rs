// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Public MaskClaw engine: scrub a request, restore a response.

use std::sync::atomic::{AtomicU64, Ordering};

use futures::StreamExt;
use regex::Regex;
use switchyard_protocol::{LlmResponse, LlmResponseStreamEvent, Request, Response};

use crate::config::MaskclawConfig;
use crate::detect::{self, Allowlist};
use crate::error::Error;
use crate::placeholders;
use crate::policy::ScanStats;
use crate::restore::StreamRestorer;
use crate::session::SessionStore;
use crate::stats::{EngineStatus, SessionGauges, StatsAccumulator, StatsSnapshot};
use crate::{ir, policy::ForceLocalPolicy};

static ANON_SESSION: AtomicU64 = AtomicU64::new(1);

/// Opaque session key for looking up a RAM mask map.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionKey(pub String);

/// Result of scrubbing one request. Secrets stay inside the engine.
#[derive(Clone, Debug)]
pub struct ScrubOutcome {
    /// Key used to restore this turn (and later turns in the same session).
    pub session_key: SessionKey,
    /// Whether the host should swap onto the configured local route.
    pub force_local: bool,
    /// Number of replacements applied.
    pub match_count: usize,
    /// Critical dictionary/regex hits.
    pub critical_count: usize,
}

/// Compiled detectors, session store, and restore regex.
pub struct Engine {
    detectors: Vec<Box<dyn detect::Detector>>,
    allowlist: Allowlist,
    sessions: SessionStore,
    policy: ForceLocalPolicy,
    local_route_id: Option<String>,
    placeholder: Regex,
    status: EngineStatus,
    stats: StatsAccumulator,
}

impl Engine {
    /// Compiles detectors and session state from a sidecar config.
    pub fn from_config(config: MaskclawConfig) -> Result<Self, Error> {
        let placeholder = Regex::new(placeholders::PATTERN).map_err(|source| Error::Regex {
            name: "placeholder".to_string(),
            source,
        })?;
        let local_route_id = config
            .local_route_id
            .clone()
            .filter(|id| !id.trim().is_empty());
        let status = EngineStatus {
            force_local: config.force_local,
            local_route_id: local_route_id.clone(),
            session_ttl_secs: config.session_ttl_secs.max(1),
            detectors: config.detectors.clone(),
            dictionary_count: config.dictionary.len(),
            regex_count: config.regex.len(),
            allowlist_count: config.allowlist.len(),
        };
        Ok(Self {
            detectors: detect::compile_detectors(&config)?,
            allowlist: Allowlist::new(config.allowlist.iter().cloned()),
            sessions: SessionStore::new(config.session_ttl()),
            policy: config.force_local,
            local_route_id,
            placeholder,
            status,
            stats: StatsAccumulator::default(),
        })
    }

    /// Route `id` to use when [`ScrubOutcome::force_local`] is set.
    pub fn local_route_id(&self) -> Option<&str> {
        self.local_route_id.as_deref()
    }

    /// Process-lifetime counters and config status for the dashboard JSON.
    pub fn stats_snapshot(&self) -> StatsSnapshot {
        let (active, unique_values) = self.sessions.gauges();
        self.stats.snapshot(
            &self.status,
            SessionGauges {
                active,
                unique_values,
            },
        )
    }

    /// Masks request IR in place and clears preservation so codecs cannot replay secrets.
    pub fn scrub_request(&self, request: &mut Request) -> ScrubOutcome {
        let session_key = session_key_for(request);
        let mut stats = ScanStats::default();
        self.sessions.with_session(&session_key.0, |session| {
            ir::scrub_request(
                &mut request.llm_request,
                &self.detectors,
                &self.allowlist,
                session,
                &mut stats,
            );
        });
        request.llm_request.preservation = Default::default();
        request.raw_request = None;

        let force_local = self.local_route_id.is_some() && self.policy.decide(&stats);
        self.stats.record(&stats, force_local);
        tracing::debug!(
            match_count = stats.matches,
            critical_count = stats.critical,
            residual = stats.residual,
            force_local,
            "maskclaw scrubbed request"
        );
        ScrubOutcome {
            session_key,
            force_local,
            match_count: stats.matches,
            critical_count: stats.critical,
        }
    }

    /// Restores placeholders on the final response only. Drops stream preservation.
    pub fn restore_response(&self, response: Response, outcome: &ScrubOutcome) -> Response {
        let Some(map) = self.sessions.snapshot_map(&outcome.session_key.0) else {
            self.stats.record_restore_miss();
            return response;
        };
        let placeholder = self.placeholder.clone();
        let Response {
            llm_response,
            metadata,
        } = response;
        let llm_response = match llm_response {
            LlmResponse::Agg(mut agg) => {
                ir::restore_agg(&mut agg, &map, &placeholder);
                LlmResponse::Agg(agg)
            }
            LlmResponse::Stream(mut stream) => {
                let wrapped = async_stream::stream! {
                    let mut restorer = StreamRestorer::new(placeholder);
                    while let Some(item) = stream.next().await {
                        match item {
                            Ok(event) => {
                                let (_, chunks) = event.into_parts();
                                let chunks = restorer.restore_chunks(chunks, &map, false);
                                yield Ok(LlmResponseStreamEvent::new(chunks));
                            }
                            Err(error) => {
                                yield Err(error);
                                return;
                            }
                        }
                    }
                    let leftover = restorer.finish(&map);
                    if !leftover.is_empty() {
                        yield Ok(LlmResponseStreamEvent::new(vec![
                            switchyard_protocol::LlmResponseChunk::TextDelta {
                                index: 0,
                                text: leftover,
                            },
                        ]));
                    }
                };
                LlmResponse::Stream(Box::pin(wrapped))
            }
        };
        Response {
            llm_response,
            metadata,
        }
    }
}

fn session_key_for(request: &Request) -> SessionKey {
    if let Some(session_id) = request
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.session_id.as_deref())
        .filter(|id| !id.is_empty())
    {
        return SessionKey(session_id.to_string());
    }
    if let Some(correlation_id) = request
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.correlation_id.as_deref())
        .filter(|id| !id.is_empty())
    {
        return SessionKey(format!("corr:{correlation_id}"));
    }
    SessionKey(format!(
        "anon:{}",
        ANON_SESSION.fetch_add(1, Ordering::Relaxed)
    ))
}
