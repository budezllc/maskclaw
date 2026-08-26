use keyring::Entry;

pub const SERVICE: &str = "com.switchyard.app";

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretBinding {
    pub env_name: String,
    pub value: String,
}

pub fn store_secrets(secrets: &[SecretBinding]) -> Result<(), String> {
    for secret in secrets {
        if secret.env_name.is_empty() || secret.value.is_empty() {
            continue;
        }
        let entry = Entry::new(SERVICE, &secret.env_name).map_err(|e| e.to_string())?;
        entry
            .set_password(&secret.value)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn load_secret(env_name: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, env_name).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

pub fn load_named(env_names: &[String]) -> Result<Vec<SecretBinding>, String> {
    let mut out = Vec::new();
    for name in env_names {
        if let Some(value) = load_secret(name)? {
            out.push(SecretBinding {
                env_name: name.clone(),
                value,
            });
        }
    }
    Ok(out)
}

pub fn sidecar_env(secrets: &[SecretBinding], telemetry_opt_in: bool) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = secrets
        .iter()
        .map(|s| (s.env_name.clone(), s.value.clone()))
        .collect();
    if !telemetry_opt_in {
        env.push((
            "SWITCHYARD_TELEMETRY_OPT_OUT".into(),
            "1".into(),
        ));
    }
    env
}

/// Local OpenAI-compatible servers often need *some* key value even when auth is off.
pub fn ensure_local_api_keys(toml: &str, env: &mut Vec<(String, String)>) {
    for name in api_key_envs_from_toml(toml) {
        if !matches!(
            name.as_str(),
            "UNSLOTH_API_KEY" | "LM_STUDIO_API_KEY" | "OLLAMA_API_KEY"
        ) {
            continue;
        }
        if !env.iter().any(|(key, _)| key == &name) {
            env.push((name, "local".into()));
        }
    }
}

pub fn api_key_envs_from_toml(toml: &str) -> Vec<String> {
    toml.lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("api_key_env")?;
            let rest = rest.trim().trim_start_matches('=').trim();
            let name = rest.trim_matches('"').trim();
            if name.is_empty() {
                None
            } else {
                Some(name.to_string())
            }
        })
        .collect()
}

pub fn toml_contains_secret(toml: &str, secrets: &[SecretBinding]) -> Option<String> {
    secrets.iter().find_map(|secret| {
        if !secret.value.is_empty() && toml.contains(&secret.value) {
            Some(secret.env_name.clone())
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_api_key_env_lines() {
        let toml = r#"
api_key_env = "MINIMAX_API_KEY"
api_key_env = "UNSLOTH_API_KEY"
"#;
        assert_eq!(
            api_key_envs_from_toml(toml),
            vec!["MINIMAX_API_KEY", "UNSLOTH_API_KEY"]
        );
    }

    #[test]
    fn injects_opt_out_and_named_secrets() {
        let secrets = vec![SecretBinding {
            env_name: "MINIMAX_API_KEY".into(),
            value: "sk-test".into(),
        }];
        let env = sidecar_env(&secrets, false);
        assert!(env.contains(&("MINIMAX_API_KEY".into(), "sk-test".into())));
        assert!(env.contains(&("SWITCHYARD_TELEMETRY_OPT_OUT".into(), "1".into())));
        let opted = sidecar_env(&secrets, true);
        assert!(!opted
            .iter()
            .any(|(k, _)| k == "SWITCHYARD_TELEMETRY_OPT_OUT"));
    }

    #[test]
    fn fills_missing_unsloth_key_so_the_engine_can_boot() {
        let toml = "api_key_env = \"UNSLOTH_API_KEY\"\napi_key_env = \"MINIMAX_API_KEY\"\n";
        let mut env = sidecar_env(&[], true);
        ensure_local_api_keys(toml, &mut env);
        assert!(env.contains(&("UNSLOTH_API_KEY".into(), "local".into())));
        assert!(!env.iter().any(|(k, _)| k == "MINIMAX_API_KEY"));
    }

    #[test]
    fn skips_empty_secret_values() {
        let secrets = vec![
            SecretBinding {
                env_name: "".into(),
                value: "x".into(),
            },
            SecretBinding {
                env_name: "UNSLOTH_API_KEY".into(),
                value: "".into(),
            },
        ];
        assert!(store_secrets(&secrets).is_ok());
    }

    #[test]
    fn detects_secret_leak_in_toml() {
        let secrets = vec![SecretBinding {
            env_name: "MINIMAX_API_KEY".into(),
            value: "sk-leaked".into(),
        }];
        assert_eq!(
            toml_contains_secret(r#"api_key = "sk-leaked""#, &secrets).as_deref(),
            Some("MINIMAX_API_KEY")
        );
        assert!(toml_contains_secret(r#"api_key_env = "MINIMAX_API_KEY""#, &secrets).is_none());
    }
}
