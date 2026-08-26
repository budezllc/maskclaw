// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! MaskClaw: deterministic PII masking for Switchyard's provider-neutral IR.

#![warn(missing_docs)]

mod config;
mod detect;
mod engine;
mod error;
mod ir;
mod placeholders;
mod policy;
mod restore;
mod session;
mod stats;

pub use config::{CustomRegex, DetectorToggles, DictionaryEntry, MaskclawConfig};
pub use engine::{Engine, ScrubOutcome, SessionKey};
pub use error::Error;
pub use policy::ForceLocalPolicy;
pub use stats::{SessionGauges, StatsSnapshot};

/// Loads a sidecar next to a Switchyard deployment TOML, or from an explicit path.
///
/// `explicit` wins when set. Otherwise `maskclaw.toml` beside `deployment_config` is
/// used when that file exists. Missing sidecar, or `enabled = false`, returns `Ok(None)`.
pub fn load_sidecar(
    deployment_config: &std::path::Path,
    explicit: Option<&std::path::Path>,
) -> Result<Option<Engine>, Error> {
    let path = match explicit {
        Some(path) => path.to_path_buf(),
        None => {
            let Some(dir) = deployment_config.parent() else {
                return Ok(None);
            };
            let candidate = dir.join("maskclaw.toml");
            if !candidate.is_file() {
                return Ok(None);
            }
            candidate
        }
    };
    let config = MaskclawConfig::from_path(&path)?;
    if !config.enabled {
        return Ok(None);
    }
    Engine::from_config(config).map(Some)
}
