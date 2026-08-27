// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Step timeline for MaskClaw auto-route (`llm_classifier`) vs a pinned cloud
//! passthrough. Auto-route consults the local model as a judge before it may
//! forward to cloud; a pinned cloud route skips that judge. This test records
//! every upstream hit so a long "thinking" wait can be attributed.

#![cfg(feature = "maskclaw")]

use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request as HttpRequest, StatusCode};
use axum::response::{IntoResponse, Response as HttpResponse};
use axum::routing::post;
use axum::{Json, Router};
use http_body_util::BodyExt;
use maskclaw::{Engine, MaskclawConfig};
use serde_json::{Value, json};
use switchyard_server::config::load_server_state;
use switchyard_server::{ServerState, build_switchyard_router};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tower::ServiceExt;

type TestError = Box<dyn std::error::Error + Send + Sync>;
type TestResult<T = ()> = Result<T, TestError>;

const CLASSIFIER_THINKING: Duration = Duration::from_millis(150);
const CLOUD_SERVE: Duration = Duration::from_millis(8);
const LOCAL_MODEL: &str = "local-qwen";
const CLOUD_MODEL: &str = "cloud-strong";
const AUTO_ROUTE: &str = "maskclaw";
const CLOUD_ROUTE: &str = "minimax-m3";

/// One observed step on the request path.
#[derive(Clone, Debug)]
struct Step {
    at: Duration,
    name: &'static str,
    detail: String,
}

struct Timeline {
    origin: Instant,
    steps: Mutex<Vec<Step>>,
}

impl Timeline {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            origin: Instant::now(),
            steps: Mutex::new(Vec::new()),
        })
    }

    async fn push(&self, name: &'static str, detail: impl Into<String>) {
        self.steps.lock().await.push(Step {
            at: self.origin.elapsed(),
            name,
            detail: detail.into(),
        });
    }

    async fn snapshot(&self) -> Vec<Step> {
        self.steps.lock().await.clone()
    }
}

fn format_timeline(steps: &[Step]) -> String {
    let mut lines = Vec::new();
    for step in steps {
        lines.push(format!(
            "{:>8.1}ms  {:<36} {}",
            step.at.as_secs_f64() * 1000.0,
            step.name,
            step.detail
        ));
    }
    lines.join("\n")
}

fn first_at(steps: &[Step], name: &str) -> Option<Duration> {
    steps
        .iter()
        .find(|step| step.name == name)
        .map(|step| step.at)
}

/// Captured upstream request plus when it arrived and when the mock finished thinking.
#[derive(Clone, Debug)]
struct UpstreamHit {
    arrived: Duration,
    model: String,
    is_classifier: bool,
    stream: bool,
    max_tokens: Option<u64>,
    thinking_disabled: Option<bool>,
    prompt_chars: usize,
}

struct TimedUpstream {
    base_url: String,
    hits: Arc<Mutex<Vec<UpstreamHit>>>,
    task: JoinHandle<()>,
}

struct UpstreamState {
    timeline: Arc<Timeline>,
    hits: Arc<Mutex<Vec<UpstreamHit>>>,
    delay: Duration,
    label: &'static str,
}

impl TimedUpstream {
    async fn start(
        timeline: Arc<Timeline>,
        delay: Duration,
        label: &'static str,
    ) -> TestResult<Self> {
        let hits = Arc::new(Mutex::new(Vec::new()));
        let state = Arc::new(UpstreamState {
            timeline,
            hits: Arc::clone(&hits),
            delay,
            label,
        });
        let app = Router::new()
            .route("/v1/chat/completions", post(timed_chat))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                tracing::error!(error = %error, "timed upstream stopped");
            }
        });
        Ok(Self {
            base_url: format!("http://{addr}/v1"),
            hits,
            task,
        })
    }

    async fn hits(&self) -> Vec<UpstreamHit> {
        self.hits.lock().await.clone()
    }
}

impl Drop for TimedUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn is_classifier_body(body: &Value) -> bool {
    body.pointer("/response_format/json_schema").is_some()
        || body
            .pointer("/response_format/type")
            .and_then(Value::as_str)
            == Some("json_schema")
}

fn thinking_disabled(body: &Value) -> Option<bool> {
    body.pointer("/chat_template_kwargs/enable_thinking")
        .and_then(Value::as_bool)
        .map(|enabled| !enabled)
}

fn prompt_chars(body: &Value) -> usize {
    body["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .map(|message| message["content"].as_str().unwrap_or("").len())
                .sum()
        })
        .unwrap_or(0)
}

fn max_tokens(body: &Value) -> Option<u64> {
    body.get("max_tokens")
        .or_else(|| body.get("max_completion_tokens"))
        .and_then(Value::as_u64)
}

async fn timed_chat(
    State(state): State<Arc<UpstreamState>>,
    Json(body): Json<Value>,
) -> HttpResponse {
    let arrived = state.timeline.origin.elapsed();
    let model = body["model"].as_str().unwrap_or("unknown").to_string();
    let classifier = is_classifier_body(&body);
    let stream = body["stream"].as_bool().unwrap_or(false);
    let tokens = max_tokens(&body);
    let thinking = thinking_disabled(&body);
    let chars = prompt_chars(&body);
    let kind = if classifier { "classifier" } else { "serving" };
    state
        .timeline
        .push(
            match (state.label, classifier) {
                ("local", true) => "local.classifier_received",
                ("local", false) => "local.serving_received",
                ("cloud", true) => "cloud.classifier_received",
                _ => "cloud.serving_received",
            },
            format!(
                "model={model} stream={stream} max_tokens={tokens:?} thinking_disabled={thinking:?} prompt_chars={chars}"
            ),
        )
        .await;

    // The judge waits for a complete completion. Sleeping here is the local
    // model's thinking / generation time before a JSON verdict exists.
    if classifier {
        tokio::time::sleep(state.delay).await;
    } else {
        tokio::time::sleep(state.delay.min(CLOUD_SERVE)).await;
    }

    state.hits.lock().await.push(UpstreamHit {
        arrived,
        model: model.clone(),
        is_classifier: classifier,
        stream,
        max_tokens: tokens,
        thinking_disabled: thinking,
        prompt_chars: chars,
    });
    state
        .timeline
        .push(
            if classifier {
                "local.classifier_replied"
            } else if state.label == "cloud" {
                "cloud.serving_replied"
            } else {
                "local.serving_replied"
            },
            format!("kind={kind} model={model}"),
        )
        .await;

    let content = if classifier {
        // Unsupported + low p_solve sends the turn to the strong (cloud) target.
        r#"{"crux":"needs a frontier model","primary_rule":"LIM-1","capability_boundary":"unsupported","p_solve":0.1}"#
    } else {
        "ok"
    };
    Json(json!({
        "id": "chatcmpl-timed",
        "object": "chat.completion",
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12}
    }))
    .into_response()
}

fn auto_route_toml(local_url: &str, cloud_url: &str, disable_local_thinking: bool) -> String {
    let extra = if disable_local_thinking {
        r#"
extra_body = { chat_template_kwargs = { enable_thinking = false } }
"#
    } else {
        ""
    };
    format!(
        r#"
schema_version = 1

[llm_clients.cloud]
format = "openai_chat"
base_url = "{cloud_url}"
max_retries = 0

[llm_clients.local]
format = "openai_chat"
base_url = "{local_url}"
max_retries = 0

[targets.strong]
id = "{CLOUD_MODEL}"
llm_client = "cloud"

[targets.weak]
id = "{LOCAL_MODEL}"
llm_client = "local"
{extra}
[routes.smart]
id = "{AUTO_ROUTE}"
type = "llm_classifier"
mode = "capability"
classifier_target = "weak"
strong_target = "strong"
weak_target = "weak"
base_threshold = 0.5
threshold_step = 0.1
session_affinity = true
message_hash_fallback = true

[routes.cloud]
id = "{CLOUD_ROUTE}"
type = "passthrough"
target = "strong"
"#
    )
}

fn load_state(toml: &str) -> TestResult<ServerState> {
    let mut config = tempfile::Builder::new()
        .prefix("maskclaw-auto-route-")
        .suffix(".toml")
        .tempfile()?;
    config.write_all(toml.as_bytes())?;
    config.flush()?;
    Ok(load_server_state(config.path())?)
}

async fn send(
    app: &Router,
    model: &str,
    timeline: &Timeline,
    label: &'static str,
) -> TestResult<StatusCode> {
    timeline.push(label, format!("model={model}")).await;
    let response = app
        .clone()
        .oneshot(
            HttpRequest::builder()
                .method("POST")
                .uri("/v1/chat/completions")
                .header("content-type", "application/json")
                .header("x-switchyard-session-id", "maskclaw-timing")
                .body(Body::from(serde_json::to_vec(&json!({
                    "model": model,
                    "messages": [{"role": "user", "content": "explain this stack trace and patch it"}]
                }))?))?,
        )
        .await?;
    let status = response.status();
    let _ = response.into_body().collect().await?;
    timeline
        .push(
            if label.contains("auto") {
                "http.auto_route_complete"
            } else {
                "http.cloud_pin_complete"
            },
            format!("status={}", status.as_u16()),
        )
        .await;
    Ok(status)
}

/// Auto-route waits for the local classifier (including simulated thinking)
/// before the cloud serving call starts. A pinned cloud route does not.
#[tokio::test]
async fn auto_route_delay_is_the_classifier_thinking_gate() -> TestResult {
    let timeline = Timeline::new();
    let local = TimedUpstream::start(Arc::clone(&timeline), CLASSIFIER_THINKING, "local").await?;
    let cloud = TimedUpstream::start(Arc::clone(&timeline), CLOUD_SERVE, "cloud").await?;
    let engine = Engine::from_config(MaskclawConfig::default())?;
    let state = load_state(&auto_route_toml(&local.base_url, &cloud.base_url, true))?
        .with_maskclaw(Some(Arc::new(engine)));
    let app = build_switchyard_router(state);

    let auto_status = send(&app, AUTO_ROUTE, &timeline, "http.auto_route_sent").await?;
    assert_eq!(
        auto_status,
        StatusCode::OK,
        "{}",
        format_timeline(&timeline.snapshot().await)
    );

    let pin_status = send(&app, CLOUD_ROUTE, &timeline, "http.cloud_pin_sent").await?;
    assert_eq!(
        pin_status,
        StatusCode::OK,
        "{}",
        format_timeline(&timeline.snapshot().await)
    );

    let steps = timeline.snapshot().await;
    let dump = format_timeline(&steps);
    let local_hits = local.hits().await;
    let cloud_hits = cloud.hits().await;

    let classifiers: Vec<_> = local_hits.iter().filter(|hit| hit.is_classifier).collect();
    assert_eq!(
        classifiers.len(),
        1,
        "auto-route should make exactly one local classifier call\n{dump}\nlocal={local_hits:?}"
    );
    let classifier = classifiers[0];
    assert_eq!(classifier.model, LOCAL_MODEL);
    assert!(
        !classifier.stream,
        "classifier should be a buffered completion, not a client stream: {classifier:?}"
    );
    assert!(
        classifier.prompt_chars > 1_000,
        "capability-classifier prompt should be large enough to slow a local model; got {} chars\n{dump}",
        classifier.prompt_chars
    );
    assert_eq!(
        classifier.thinking_disabled,
        Some(true),
        "weak-target extra_body should disable thinking on the judge call too: {classifier:?}\n{dump}"
    );
    assert_eq!(
        classifier.max_tokens,
        Some(4096),
        "judge max_output_tokens default is 4096; a thinking local model can fill that budget: {classifier:?}\n{dump}"
    );

    let cloud_serving: Vec<_> = cloud_hits.iter().filter(|hit| !hit.is_classifier).collect();
    assert_eq!(
        cloud_serving.len(),
        2,
        "one auto-route serving call and one pinned-cloud call\n{dump}\ncloud={cloud_hits:?}"
    );

    let auto_sent = first_at(&steps, "http.auto_route_sent").expect(&dump);
    let classifier_received = first_at(&steps, "local.classifier_received").expect(&dump);
    let classifier_replied = first_at(&steps, "local.classifier_replied").expect(&dump);
    let auto_cloud = cloud_serving[0].arrived;
    let pin_sent = first_at(&steps, "http.cloud_pin_sent").expect(&dump);
    let pin_cloud = cloud_serving[1].arrived;

    let until_classifier = classifier_received.saturating_sub(auto_sent);
    let classifier_hold = classifier_replied.saturating_sub(classifier_received);
    let after_verdict = auto_cloud.saturating_sub(classifier_replied);
    let auto_to_cloud = auto_cloud.saturating_sub(auto_sent);
    let pin_to_cloud = pin_cloud.saturating_sub(pin_sent);

    assert!(
        until_classifier < Duration::from_millis(80),
        "MaskClaw scrub + route resolve should be fast; classifier was not contacted for {:?}\n{dump}",
        until_classifier
    );
    assert!(
        classifier_hold >= Duration::from_millis(120),
        "mock thinking delay should dominate the judge call; held {:?}\n{dump}",
        classifier_hold
    );
    assert!(
        after_verdict < Duration::from_millis(80),
        "once the verdict exists, cloud serving should start immediately; gap {:?}\n{dump}",
        after_verdict
    );
    assert!(
        auto_cloud >= classifier_replied,
        "cloud serving must not start until the classifier finishes thinking\n{dump}"
    );
    assert!(
        pin_to_cloud < Duration::from_millis(80),
        "pinned cloud should skip the judge; took {:?}\n{dump}",
        pin_to_cloud
    );
    assert!(
        auto_to_cloud >= pin_to_cloud + Duration::from_millis(80),
        "auto-route should be slower than a cloud pin by about the thinking delay (auto {:?} vs pin {:?})\n{dump}",
        auto_to_cloud,
        pin_to_cloud
    );
    assert!(
        local
            .hits()
            .await
            .iter()
            .all(|hit| hit.is_classifier || hit.arrived < pin_sent),
        "pinned cloud must not call the local model\n{dump}\nlocal={:?}",
        local.hits().await
    );

    Ok(())
}

/// Without extra_body, the judge call does not disable thinking. That is the
/// LM Studio / Gemma MaskClaw path today, and it is why the UI sits on
/// "thinking" before any cloud token.
#[tokio::test]
async fn auto_route_classifier_does_not_disable_thinking_without_extra_body() -> TestResult {
    let timeline = Timeline::new();
    let local =
        TimedUpstream::start(Arc::clone(&timeline), Duration::from_millis(1), "local").await?;
    let cloud =
        TimedUpstream::start(Arc::clone(&timeline), Duration::from_millis(1), "cloud").await?;
    let engine = Engine::from_config(MaskclawConfig::default())?;
    let state = load_state(&auto_route_toml(&local.base_url, &cloud.base_url, false))?
        .with_maskclaw(Some(Arc::new(engine)));
    let app = build_switchyard_router(state);

    let status = send(&app, AUTO_ROUTE, &timeline, "http.auto_route_sent").await?;
    assert_eq!(status, StatusCode::OK);

    let classifier = local
        .hits()
        .await
        .into_iter()
        .find(|hit| hit.is_classifier)
        .expect("classifier call");
    assert_eq!(
        classifier.thinking_disabled, None,
        "lmstudio/gemma-style weak targets send no enable_thinking=false on the judge: {classifier:?}"
    );
    Ok(())
}
