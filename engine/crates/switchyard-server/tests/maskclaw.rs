// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Server integration for MaskClaw: preservation leak, SSE restore, force-local.

#![cfg(feature = "maskclaw")]

use std::convert::Infallible;
use std::io::Write;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request as HttpRequest, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response as HttpResponse};
use axum::routing::post;
use axum::{Json, Router};
use http_body_util::BodyExt;
use maskclaw::{Engine, ForceLocalPolicy, MaskclawConfig};
use serde_json::{Value, json};
use switchyard_server::config::load_server_state;
use switchyard_server::{ServerState, build_switchyard_router};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tower::ServiceExt;

type TestError = Box<dyn std::error::Error + Send + Sync>;
type TestResult<T = ()> = Result<T, TestError>;

struct EchoUpstream {
    base_url: String,
    calls: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}

impl EchoUpstream {
    async fn start() -> TestResult<Self> {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/v1/chat/completions", post(echo_chat))
            .with_state(Arc::clone(&calls));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                tracing::error!(error = %error, "maskclaw echo upstream stopped");
            }
        });
        Ok(Self {
            base_url: format!("http://{addr}/v1"),
            calls,
            task,
        })
    }

    async fn prompts(&self) -> Vec<String> {
        self.calls
            .lock()
            .await
            .iter()
            .filter_map(|call| call["messages"][0]["content"].as_str().map(str::to_string))
            .collect()
    }
}

impl Drop for EchoUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn echo_chat(
    State(calls): State<Arc<Mutex<Vec<Value>>>>,
    Json(body): Json<Value>,
) -> HttpResponse {
    calls.lock().await.push(body.clone());
    let content = body["messages"][0]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let model = body["model"].as_str().unwrap_or("unknown").to_string();
    if body["stream"].as_bool() == Some(true) {
        let (a, b) = split_mid(&content);
        let events = [
            json!({"id": "chatcmpl-echo", "model": model, "choices": [{"index": 0, "delta": {"role": "assistant"}}]}).to_string(),
            json!({"id": "chatcmpl-echo", "model": model, "choices": [{"index": 0, "delta": {"content": a}}]}).to_string(),
            json!({"id": "chatcmpl-echo", "model": model, "choices": [{"index": 0, "delta": {"content": b}}]}).to_string(),
            json!({"id": "chatcmpl-echo", "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}).to_string(),
            "[DONE]".to_string(),
        ];
        let stream = futures_util::stream::iter(
            events
                .into_iter()
                .map(|data| Ok::<Event, Infallible>(Event::default().data(data))),
        );
        return Sse::new(stream).into_response();
    }
    Json(json!({
        "id": "chatcmpl-echo",
        "object": "chat.completion",
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
    }))
    .into_response()
}

fn split_mid(text: &str) -> (String, String) {
    if text.is_empty() {
        return (String::new(), String::new());
    }
    let mid = (text.len() / 2).max(1).min(text.len());
    (text[..mid].to_string(), text[mid..].to_string())
}

fn passthrough_toml(base_url: &str, route_id: &str, target_id: &str, client: &str) -> String {
    format!(
        r#"
schema_version = 1

[llm_clients.{client}]
format = "openai_chat"
base_url = "{base_url}"
max_retries = 0

[targets.{client}]
id = "{target_id}"
llm_client = "{client}"

[routes.{client}]
id = "{route_id}"
type = "passthrough"
target = "{client}"
"#
    )
}

fn load_state(toml: &str) -> TestResult<ServerState> {
    let mut config = tempfile::Builder::new()
        .prefix("maskclaw-server-")
        .suffix(".toml")
        .tempfile()?;
    config.write_all(toml.as_bytes())?;
    config.flush()?;
    Ok(load_server_state(config.path())?)
}

async fn send(app: &Router, body: Value, stream: bool) -> TestResult<(StatusCode, String)> {
    let mut body = body;
    if stream {
        body["stream"] = json!(true);
    }
    let response = app
        .clone()
        .oneshot(
            HttpRequest::builder()
                .method("POST")
                .uri("/v1/chat/completions")
                .header("content-type", "application/json")
                .header("x-switchyard-session-id", "maskclaw-test")
                .body(Body::from(serde_json::to_vec(&body)?))?,
        )
        .await?;
    let status = response.status();
    let bytes = response.into_body().collect().await?.to_bytes();
    Ok((status, String::from_utf8(bytes.to_vec())?))
}

async fn get_stats(app: &Router) -> TestResult<(StatusCode, Value)> {
    let response = app
        .clone()
        .oneshot(
            HttpRequest::builder()
                .method("GET")
                .uri("/v1/maskclaw/stats")
                .body(Body::empty())?,
        )
        .await?;
    let status = response.status();
    let bytes = response.into_body().collect().await?.to_bytes();
    Ok((status, serde_json::from_slice(&bytes)?))
}

#[tokio::test]
async fn same_format_chat_sends_placeholders_upstream_and_restores_for_client() -> TestResult {
    let upstream = EchoUpstream::start().await?;
    let engine = Engine::from_config(MaskclawConfig::default())?;
    let state = load_state(&passthrough_toml(
        &upstream.base_url,
        "switchyard",
        "model/cloud",
        "cloud",
    ))?
    .with_maskclaw(Some(Arc::new(engine)));
    let app = build_switchyard_router(state);

    let (status, body) = send(
        &app,
        json!({
            "model": "switchyard",
            "messages": [{"role": "user", "content": "write ada@example.com"}]
        }),
        false,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let payload: Value = serde_json::from_str(&body)?;
    let client_text = payload["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(
        client_text.contains("ada@example.com"),
        "client should see restored secret: {client_text}"
    );

    let prompts = upstream.prompts().await;
    assert_eq!(prompts.len(), 1);
    assert!(
        !prompts[0].contains("ada@example.com"),
        "upstream leaked secret: {}",
        prompts[0]
    );
    assert!(
        prompts[0].contains("__MC_email_"),
        "upstream should see a placeholder: {}",
        prompts[0]
    );
    Ok(())
}

#[tokio::test]
async fn streaming_chat_restores_split_placeholder() -> TestResult {
    let upstream = EchoUpstream::start().await?;
    let engine = Engine::from_config(MaskclawConfig::default())?;
    let state = load_state(&passthrough_toml(
        &upstream.base_url,
        "switchyard",
        "model/cloud",
        "cloud",
    ))?
    .with_maskclaw(Some(Arc::new(engine)));
    let app = build_switchyard_router(state);

    let (status, body) = send(
        &app,
        json!({
            "model": "switchyard",
            "messages": [{"role": "user", "content": "write ada@example.com"}]
        }),
        true,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains("ada@example.com"),
        "stream should restore the secret: {body}"
    );
    assert!(
        !body.contains("__MC_email_"),
        "client stream leaked a placeholder: {body}"
    );
    let prompts = upstream.prompts().await;
    assert!(!prompts[0].contains("ada@example.com"));
    Ok(())
}

#[tokio::test]
async fn force_local_swaps_to_the_configured_local_route() -> TestResult {
    let cloud = EchoUpstream::start().await?;
    let local = EchoUpstream::start().await?;
    let toml = format!(
        r#"
schema_version = 1

[llm_clients.cloud]
format = "openai_chat"
base_url = "{cloud}"
max_retries = 0

[llm_clients.local]
format = "openai_chat"
base_url = "{local}"
max_retries = 0

[targets.cloud]
id = "model/cloud"
llm_client = "cloud"

[targets.local]
id = "model/local"
llm_client = "local"

[routes.switchyard]
id = "switchyard"
type = "passthrough"
target = "cloud"

[routes.local]
id = "local"
type = "passthrough"
target = "local"
"#,
        cloud = cloud.base_url,
        local = local.base_url
    );
    let engine = Engine::from_config(MaskclawConfig {
        force_local: ForceLocalPolicy::Always,
        local_route_id: Some("local".into()),
        ..MaskclawConfig::default()
    })?;
    let state = load_state(&toml)?.with_maskclaw(Some(Arc::new(engine)));
    let app = build_switchyard_router(state);

    let (status, _) = send(
        &app,
        json!({
            "model": "switchyard",
            "messages": [{"role": "user", "content": "hello"}]
        }),
        false,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert!(
        cloud.prompts().await.is_empty(),
        "cloud upstream should not be called"
    );
    assert_eq!(local.prompts().await.len(), 1);
    Ok(())
}

#[tokio::test]
async fn missing_engine_leaves_secrets_in_the_upstream_body() -> TestResult {
    let upstream = EchoUpstream::start().await?;
    let state = load_state(&passthrough_toml(
        &upstream.base_url,
        "switchyard",
        "model/cloud",
        "cloud",
    ))?;
    let app = build_switchyard_router(state);
    let (status, _) = send(
        &app,
        json!({
            "model": "switchyard",
            "messages": [{"role": "user", "content": "write ada@example.com"}]
        }),
        false,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let prompts = upstream.prompts().await;
    assert!(
        prompts[0].contains("ada@example.com"),
        "no-sidecar path should not scrub: {}",
        prompts[0]
    );
    Ok(())
}

#[tokio::test]
async fn stats_without_engine_reports_disabled() -> TestResult {
    let upstream = EchoUpstream::start().await?;
    let state = load_state(&passthrough_toml(
        &upstream.base_url,
        "switchyard",
        "model/cloud",
        "cloud",
    ))?;
    let app = build_switchyard_router(state);
    let (status, body) = get_stats(&app).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"enabled": false}));
    Ok(())
}

#[tokio::test]
async fn stats_after_chat_counts_email_without_secrets() -> TestResult {
    let upstream = EchoUpstream::start().await?;
    let engine = Engine::from_config(MaskclawConfig::default())?;
    let state = load_state(&passthrough_toml(
        &upstream.base_url,
        "switchyard",
        "model/cloud",
        "cloud",
    ))?
    .with_maskclaw(Some(Arc::new(engine)));
    let app = build_switchyard_router(state);

    let (status, _) = send(
        &app,
        json!({
            "model": "switchyard",
            "messages": [{"role": "user", "content": "write ada@example.com"}]
        }),
        false,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = get_stats(&app).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], true);
    assert!(
        body["matches"].as_u64().unwrap_or(0) >= 1,
        "expected matches: {body}"
    );
    assert!(
        body["by_kind"]["email"].as_u64().unwrap_or(0) >= 1,
        "expected email kind: {body}"
    );
    let encoded = body.to_string();
    assert!(
        !encoded.contains("ada@example.com"),
        "stats leaked secret: {encoded}"
    );
    assert!(
        !encoded.contains("__MC_"),
        "stats leaked placeholder: {encoded}"
    );
    Ok(())
}
