// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Typed errors for config loading and detector compilation.

/// Failure loading or compiling a MaskClaw sidecar.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Sidecar TOML could not be parsed or failed validation.
    #[error("invalid maskclaw config: {0}")]
    Config(String),
    /// Sidecar file could not be read.
    #[error("failed to read maskclaw config {path}: {source}")]
    Io {
        /// Path that failed.
        path: String,
        /// Underlying IO error.
        #[source]
        source: std::io::Error,
    },
    /// A detector regex failed to compile.
    #[error("invalid detector regex '{name}': {source}")]
    Regex {
        /// Detector name.
        name: String,
        /// Underlying regex error.
        #[source]
        source: regex::Error,
    },
}
