// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use maskclaw::{DictionaryEntry, Engine, ForceLocalPolicy, MaskclawConfig, ScrubOutcome, SessionKey};
use switchyard_protocol::{
    LlmResponse, LlmResponseChunk, LlmResponseStreamEvent, Metadata, Request, Response,
    text_request, text_response,
};

fn engine_with(config: MaskclawConfig) -> Engine {
    Engine::from_config(config).expect("engine")
}

fn user_request(session: Option<&str>, prompt: &str) -> Request {
    Request {
        llm_request: text_request(Some("switchyard".into()), prompt),
        raw_request: Some(serde_json::json!({"messages": [{"role": "user", "content": prompt}]})),
        metadata: Some(Metadata {
            session_id: session.map(str::to_string),
            ..Metadata::default()
        }),
    }
}

fn prompt(request: &Request) -> String {
    switchyard_protocol::prompt_text(&request.llm_request)
}

#[test]
fn masks_email_and_api_key() {
    let engine = engine_with(MaskclawConfig::default());
    let mut request = user_request(
        Some("s1"),
        "mail ada@example.com key sk-abcdefghijklmnopqrstuvwxyz",
    );
    let outcome = engine.scrub_request(&mut request);
    let text = prompt(&request);
    assert!(!text.contains("ada@example.com"));
    assert!(!text.contains("sk-abcdefghijklmnopqrstuvwxyz"));
    assert!(text.contains("__MC_email_"));
    assert!(text.contains("__MC_api_key_"));
    assert!(outcome.match_count >= 2);
    assert!(request.raw_request.is_none());
    assert!(request.llm_request.preservation.requests.is_empty());
}

#[test]
fn dictionary_masks_and_allowlist_skips() {
    let engine = engine_with(MaskclawConfig {
        allowlist: vec!["noreply@example.com".into()],
        dictionary: vec![DictionaryEntry {
            kind: "person".into(),
            critical: false,
            values: vec!["John Doe".into()],
        }],
        ..MaskclawConfig::default()
    });
    let mut request = user_request(Some("s1"), "John Doe wrote noreply@example.com");
    engine.scrub_request(&mut request);
    let text = prompt(&request);
    assert!(!text.contains("John Doe"));
    assert!(text.contains("noreply@example.com"));
    assert!(text.contains("__MC_person_"));
}

#[test]
fn same_secret_reuses_placeholder_in_one_session() {
    let engine = engine_with(MaskclawConfig::default());
    let mut first = user_request(Some("shared"), "ada@example.com");
    let mut second = user_request(Some("shared"), "ping ada@example.com again");
    engine.scrub_request(&mut first);
    engine.scrub_request(&mut second);
    let placeholder = prompt(&first)
        .split_whitespace()
        .find(|token| token.starts_with("__MC_email_"))
        .expect("placeholder")
        .to_string();
    assert!(prompt(&second).contains(&placeholder));
}

#[test]
fn restore_is_inverse_of_scrub() {
    let engine = engine_with(MaskclawConfig {
        dictionary: vec![DictionaryEntry {
            kind: "project".into(),
            critical: false,
            values: vec!["Project Apollo".into()],
        }],
        ..MaskclawConfig::default()
    });
    let mut request = user_request(Some("round"), "keep Project Apollo; write ada@example.com");
    let outcome = engine.scrub_request(&mut request);
    let masked = prompt(&request);
    assert!(!masked.contains("Project Apollo"));
    assert!(!masked.contains("ada@example.com"));

    let response = Response {
        llm_response: LlmResponse::Agg(text_response(None, masked)),
        metadata: None,
    };
    let restored = engine.restore_response(response, &outcome);
    let LlmResponse::Agg(agg) = restored.llm_response else {
        panic!("expected aggregate response");
    };
    let text = switchyard_protocol::completion_text(&agg);
    assert!(text.contains("Project Apollo"));
    assert!(text.contains("ada@example.com"));
}

#[tokio::test]
async fn stream_restore_reassembles_split_placeholder() {
    let engine = engine_with(MaskclawConfig::default());
    let mut request = user_request(Some("stream"), "secret ada@example.com");
    let outcome = engine.scrub_request(&mut request);
    let placeholder = prompt(&request)
        .split_whitespace()
        .find(|token| token.starts_with("__MC_email_"))
        .expect("placeholder")
        .to_string();
    let mid = placeholder.len() / 2;
    let events = vec![
        Ok(LlmResponseStreamEvent::preserved(
            "openai_chat",
            serde_json::json!({"leak": "ada@example.com"}),
            vec![LlmResponseChunk::TextDelta {
                index: 0,
                text: placeholder[..mid].to_string(),
            }],
        )),
        Ok(LlmResponseStreamEvent::new(vec![
            LlmResponseChunk::TextDelta {
                index: 0,
                text: placeholder[mid..].to_string(),
            },
        ])),
    ];
    let stream = futures::stream::iter(events);
    let response = Response {
        llm_response: LlmResponse::Stream(Box::pin(stream)),
        metadata: None,
    };
    let restored = engine.restore_response(response, &outcome);
    let LlmResponse::Stream(mut out) = restored.llm_response else {
        panic!("expected stream");
    };
    let mut text = String::new();
    while let Some(item) = futures::StreamExt::next(&mut out).await {
        let event = item.expect("event");
        assert!(
            event.preservation().is_none(),
            "same-format replay must be dropped"
        );
        for chunk in event.normalized() {
            if let LlmResponseChunk::TextDelta { text: delta, .. } = chunk {
                text.push_str(delta);
            }
        }
    }
    assert_eq!(text, "ada@example.com");
}

#[test]
fn force_local_always_and_on_unmaskable_critical() {
    let always = engine_with(MaskclawConfig {
        force_local: ForceLocalPolicy::Always,
        local_route_id: Some("local".into()),
        ..MaskclawConfig::default()
    });
    let mut request = user_request(Some("p"), "hello");
    assert!(always.scrub_request(&mut request).force_local);

    let critical = engine_with(MaskclawConfig {
        force_local: ForceLocalPolicy::OnUnmaskable,
        local_route_id: Some("local".into()),
        dictionary: vec![DictionaryEntry {
            kind: "project".into(),
            critical: true,
            values: vec!["Project Apollo".into()],
        }],
        ..MaskclawConfig::default()
    });
    let mut sensitive = user_request(Some("p2"), "ship Project Apollo");
    assert!(critical.scrub_request(&mut sensitive).force_local);
    let mut benign = user_request(Some("p3"), "ship the docs");
    assert!(!critical.scrub_request(&mut benign).force_local);
}

#[test]
fn stats_snapshot_counts_kinds_without_secrets() {
    let engine = engine_with(MaskclawConfig {
        dictionary: vec![DictionaryEntry {
            kind: "person".into(),
            critical: false,
            values: vec!["Jane Doe".into()],
        }],
        ..MaskclawConfig::default()
    });
    let mut request = user_request(
        Some("stats"),
        "Jane Doe mailed ada@example.com and bob@example.com",
    );
    engine.scrub_request(&mut request);
    let snapshot = engine.stats_snapshot();
    assert!(snapshot.enabled);
    assert!(snapshot.matches >= 3);
    assert!(snapshot.requests_with_matches >= 1);
    assert!(snapshot.by_kind.get("email").copied().unwrap_or(0) >= 2);
    assert!(snapshot.by_kind.get("person").copied().unwrap_or(0) >= 1);
    assert_eq!(snapshot.sessions.active, 1);
    assert!(snapshot.sessions.unique_values >= 3);

    let json = serde_json::to_string(&snapshot).expect("json");
    assert!(!json.contains("ada@example.com"));
    assert!(!json.contains("bob@example.com"));
    assert!(!json.contains("Jane Doe"));
    assert!(!json.contains("__MC_"));

    let response = Response {
        llm_response: LlmResponse::Agg(text_response(None, "ok")),
        metadata: None,
    };
    engine.restore_response(
        response,
        &ScrubOutcome {
            session_key: SessionKey("missing".into()),
            force_local: false,
            match_count: 0,
            critical_count: 0,
        },
    );
    assert_eq!(engine.stats_snapshot().restore_misses, 1);
}

#[test]
fn sidecar_disabled_returns_none() {
    let dir = std::env::temp_dir().join(format!("maskclaw-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let deployment = dir.join("routes.toml");
    let sidecar = dir.join("maskclaw.toml");
    std::fs::write(&deployment, "schema_version = 1\n").expect("write");
    std::fs::write(&sidecar, "enabled = false\n").expect("write");
    let loaded = maskclaw::load_sidecar(&deployment, None).expect("load");
    assert!(loaded.is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn invalid_card_is_not_masked() {
    let engine = engine_with(MaskclawConfig::default());
    let mut request = user_request(Some("card"), "card 4111111111111112");
    engine.scrub_request(&mut request);
    assert!(prompt(&request).contains("4111111111111112"));

    let mut valid = user_request(Some("card2"), "card 4111111111111111");
    engine.scrub_request(&mut valid);
    let text = prompt(&valid);
    assert!(!text.contains("4111111111111111"));
    assert!(text.contains("__MC_credit_card_"));
}

#[test]
fn jwt_and_aws_key_mask() {
    let engine = engine_with(MaskclawConfig::default());
    let jwt = concat!(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.",
        "8E3b0abcdefghij"
    );
    let mut request = user_request(
        Some("keys"),
        &format!("token {jwt} aws AKIAIOSFODNN7EXAMPLE"),
    );
    engine.scrub_request(&mut request);
    let text = prompt(&request);
    assert!(!text.contains("AKIAIOSFODNN7EXAMPLE"));
    assert!(text.contains("__MC_aws_key_"));
    assert!(text.contains("__MC_jwt_"));
}
