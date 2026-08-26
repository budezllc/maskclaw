// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Sidecar TOML schema for MaskClaw. Kept out of Switchyard's `schema_version = 1`.

use std::fs;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::policy::ForceLocalPolicy;

const DEFAULT_SESSION_TTL_SECS: u64 = 900;

/// Top-level MaskClaw sidecar configuration.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaskclawConfig {
    /// When false, [`crate::load_sidecar`] returns `None`.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// How long a session mask map lives in RAM after last use.
    #[serde(default = "default_session_ttl_secs")]
    pub session_ttl_secs: u64,
    /// When to override the resolved route with [`Self::local_route_id`].
    #[serde(default)]
    pub force_local: ForceLocalPolicy,
    /// Switchyard route `id` used when force-local fires.
    #[serde(default)]
    pub local_route_id: Option<String>,
    /// Built-in detector toggles.
    #[serde(default)]
    pub detectors: DetectorToggles,
    /// Exact strings that must never be masked.
    #[serde(default)]
    pub allowlist: Vec<String>,
    /// Literal dictionaries compiled with Aho-Corasick.
    #[serde(default)]
    pub dictionary: Vec<DictionaryEntry>,
    /// Extra user-supplied regex detectors.
    #[serde(default)]
    pub regex: Vec<CustomRegex>,
}

impl Default for MaskclawConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            session_ttl_secs: DEFAULT_SESSION_TTL_SECS,
            force_local: ForceLocalPolicy::Never,
            local_route_id: None,
            detectors: DetectorToggles::default(),
            allowlist: Vec::new(),
            dictionary: Vec::new(),
            regex: Vec::new(),
        }
    }
}

impl MaskclawConfig {
    /// Parses a sidecar TOML file.
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref();
        let toml = fs::read_to_string(path).map_err(|source| Error::Io {
            path: path.display().to_string(),
            source,
        })?;
        toml::from_str(&toml).map_err(|error| Error::Config(format!("{}: {error}", path.display())))
    }

    /// Session map TTL.
    pub fn session_ttl(&self) -> Duration {
        Duration::from_secs(self.session_ttl_secs.max(1))
    }
}

/// On/off switches for compiled built-in detectors.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DetectorToggles {
    /// Email addresses.
    #[serde(default = "default_true")]
    pub email: bool,
    /// North-American phone numbers with separators.
    #[serde(default = "default_true")]
    pub phone: bool,
    /// Social-security numbers (`###-##-####`).
    #[serde(default = "default_true")]
    pub ssn: bool,
    /// Payment-card numbers that pass a Luhn check.
    #[serde(default = "default_true")]
    pub credit_card: bool,
    /// Compact JWT-shaped tokens.
    #[serde(default = "default_true")]
    pub jwt: bool,
    /// AWS access key IDs (`AKIA…`).
    #[serde(default = "default_true")]
    pub aws_key: bool,
    /// Common API-key prefixes (`sk-`, `ghp_`, `glpat-`, Slack `xox…`).
    #[serde(default = "default_true")]
    pub api_key: bool,
}

impl Default for DetectorToggles {
    fn default() -> Self {
        Self {
            email: true,
            phone: true,
            ssn: true,
            credit_card: true,
            jwt: true,
            aws_key: true,
            api_key: true,
        }
    }
}

/// One Aho-Corasick dictionary of secrets that share an entity type.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DictionaryEntry {
    /// Placeholder type, for example `person` or `project`.
    #[serde(rename = "type")]
    pub kind: String,
    /// Whether a hit is enough to force local routing under `on_unmaskable`.
    #[serde(default)]
    pub critical: bool,
    /// Literal strings to mask.
    pub values: Vec<String>,
}

/// One user-supplied regex detector.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomRegex {
    /// Placeholder type.
    #[serde(rename = "type")]
    pub kind: String,
    /// Rust `regex` pattern.
    pub pattern: String,
    /// Whether a hit is enough to force local routing under `on_unmaskable`.
    #[serde(default)]
    pub critical: bool,
}

fn default_true() -> bool {
    true
}

fn default_session_ttl_secs() -> u64 {
    DEFAULT_SESSION_TTL_SECS
}
