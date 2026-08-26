// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Tiny MaskClaw call sites. All scrubbing logic lives in `crates/maskclaw`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use maskclaw::ScrubOutcome;
use serde_json::json;
use switchyard_protocol::Request;

use crate::{RouteEntry, ServerState, error_response};

pub(crate) async fn scrub_request(
    state: &ServerState,
    request: &mut Request,
) -> Result<Option<ScrubOutcome>, Response> {
    let Some(engine) = state.maskclaw.clone() else {
        return Ok(None);
    };
    let mut owned = std::mem::take(request);
    match tokio::task::spawn_blocking(move || {
        let outcome = engine.scrub_request(&mut owned);
        (owned, outcome)
    })
    .await
    {
        Ok((scrubbed, outcome)) => {
            *request = scrubbed;
            Ok(Some(outcome))
        }
        Err(error) => {
            tracing::error!(error = %error, "maskclaw scrub task failed");
            Err(error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "maskclaw failed to scrub the request",
                "server_error",
                "maskclaw_scrub_failed",
            ))
        }
    }
}

pub(crate) fn select_route<'a>(
    state: &'a ServerState,
    current: &'a RouteEntry,
    outcome: Option<&ScrubOutcome>,
) -> &'a RouteEntry {
    let Some(outcome) = outcome else {
        return current;
    };
    if !outcome.force_local {
        return current;
    }
    let Some(engine) = state.maskclaw.as_ref() else {
        return current;
    };
    let Some(id) = engine.local_route_id() else {
        return current;
    };
    match state.route_for_model(id) {
        Some(route) => route,
        None => {
            tracing::warn!(
                local_route_id = id,
                "maskclaw force-local route is not configured"
            );
            current
        }
    }
}

pub(crate) fn restore_response(
    engine: Option<&Arc<maskclaw::Engine>>,
    response: switchyard_protocol::Response,
    outcome: Option<&ScrubOutcome>,
) -> switchyard_protocol::Response {
    let Some(engine) = engine else {
        return response;
    };
    let Some(outcome) = outcome else {
        return response;
    };
    engine.restore_response(response, outcome)
}

/// Serves process-lifetime MaskClaw counters. Secrets never appear in the body.
pub(crate) async fn get_stats(State(state): State<ServerState>) -> Response {
    match state.maskclaw.as_ref() {
        Some(engine) => Json(engine.stats_snapshot()).into_response(),
        None => Json(json!({"enabled": false})).into_response(),
    }
}
