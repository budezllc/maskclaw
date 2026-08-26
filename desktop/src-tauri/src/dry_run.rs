#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRunError {
    pub kind: &'static str,
    pub path: Option<String>,
    pub technical: String,
    pub user_message: String,
}

pub fn parse_dry_run_stderr(stderr: &str, exit_code: i32) -> Option<DryRunError> {
    let text = stderr.trim();
    if exit_code == 0 {
        return None;
    }

    let (path, rest) = split_config_prefix(text);
    let body = if rest.is_empty() { text } else { rest };

    if body.to_ascii_lowercase().contains("failed to parse toml") {
        return Some(DryRunError {
            kind: "parse",
            path,
            technical: text.to_string(),
            user_message: rewrite_parse(body),
        });
    }

    if text.to_ascii_lowercase().contains("invalid server config")
        || body.to_ascii_lowercase().contains("deny_unknown_fields")
        || body.to_ascii_lowercase().contains("unknown field")
        || body.to_ascii_lowercase().contains("missing field")
    {
        return Some(DryRunError {
            kind: "validate",
            path,
            technical: text.to_string(),
            user_message: rewrite_validate(body),
        });
    }

    Some(DryRunError {
        kind: "unknown",
        path,
        technical: if text.is_empty() {
            format!("switchyard-server exited with code {exit_code}")
        } else {
            text.to_string()
        },
        user_message:
            "The routing file did not start. Check the highlighted field or open Raw config in Settings."
                .into(),
    })
}

fn split_config_prefix(text: &str) -> (Option<String>, &str) {
    let lower = text.to_ascii_lowercase();
    if let Some(idx) = lower.find("invalid server config ") {
        let after = &text[idx + "invalid server config ".len()..];
        if let Some(sep) = find_message_separator(after) {
            let path = after[..sep].trim().to_string();
            return (Some(path), after[sep + 1..].trim());
        }
    }
    (None, text)
}

fn find_message_separator(after: &str) -> Option<usize> {
    after.char_indices().find_map(|(i, ch)| {
        if ch != ':' {
            return None;
        }
        let next = after[i + 1..].chars().next();
        if next == Some('\\') {
            return None;
        }
        Some(i)
    })
}

fn rewrite_parse(inner: &str) -> String {
    if inner.to_ascii_lowercase().contains("deny_unknown_fields") {
        return "This file has a key Switchyard does not use. Remove the extra line and try again."
            .into();
    }
    if let Some(field) = capture_missing_field(inner) {
        return format!("The routing file is missing “{field}”. Add it or re-run Setup.");
    }
    format!("The routing file could not be read. {}", plain(inner))
}

fn rewrite_validate(inner: &str) -> String {
    let lower = inner.to_ascii_lowercase();
    if lower.contains("deny_unknown_fields") || lower.contains("unknown field") {
        return "This file has a key Switchyard does not use. Remove the extra line and try again."
            .into();
    }
    if lower.contains("missing field targets") {
        return "The routing file needs a targets section. Re-run Setup to rebuild it.".into();
    }
    if lower.contains("api_key_env")
        && (lower.contains("empty") || lower.contains("missing") || lower.contains("not set"))
    {
        return "A cloud or local key is missing. Paste it in Setup — keys are not stored in the routing file.".into();
    }
    if lower.contains("api_key") && (lower.contains("empty") || lower.contains("missing")) {
        return "A cloud or local key is missing. Paste it in Setup — keys are not stored in the routing file.".into();
    }
    plain(inner)
}

fn capture_missing_field(inner: &str) -> Option<String> {
    let marker = "missing field";
    let lower = inner.to_ascii_lowercase();
    let idx = lower.find(marker)?;
    let after = inner[idx + marker.len()..].trim();
    let token = after
        .trim_start_matches(['`', '"', ' '])
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .next()?;
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn plain(inner: &str) -> String {
    inner
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace("deny_unknown_fields", "")
        .trim()
        .to_string()
}

pub fn format_for_wizard(error: &DryRunError) -> String {
    error.user_message.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_is_none() {
        assert!(parse_dry_run_stderr("", 0).is_none());
    }

    #[test]
    fn parse_missing_targets() {
        let err = parse_dry_run_stderr(
            r#"invalid server config C:\Users\a\routes.toml: failed to parse TOML: missing field `targets`"#,
            1,
        )
        .unwrap();
        assert_eq!(err.kind, "parse");
        assert!(err.path.unwrap().contains("routes.toml"));
        assert!(err.user_message.contains("targets"));
    }

    #[test]
    fn deny_unknown_fields_is_rewritten() {
        let err = parse_dry_run_stderr(
            "invalid server config routes.toml: failed to parse TOML: deny_unknown_fields: unknown field `hot_reload`",
            2,
        )
        .unwrap();
        assert!(!err.user_message.contains("deny_unknown_fields"));
        assert!(!err.user_message.to_ascii_lowercase().contains("panic"));
        assert!(err.user_message.contains("does not use"));
    }

    #[test]
    fn missing_key_env() {
        let err = parse_dry_run_stderr(
            "invalid server config routes.toml: MINIMAX_API_KEY is missing or empty",
            1,
        )
        .unwrap();
        assert_eq!(err.kind, "validate");
        assert!(err.user_message.contains("key is missing"));
    }
}
