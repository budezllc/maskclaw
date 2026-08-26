// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Stable session-scoped placeholder tokens.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// ASCII prefix of every MaskClaw placeholder.
pub const PREFIX: &str = "__MC_";
/// ASCII suffix of every MaskClaw placeholder.
pub const SUFFIX: &str = "__";

/// Regex matching a complete placeholder. Static pattern; compile failure is a bug.
pub const PATTERN: &str = r"__MC_[a-z0-9]+(?:_[a-z0-9]+)*_[0-9a-f]{12}__";

/// Turns a config type name into the `[a-z0-9_]+` slug used in placeholders.
pub fn sanitize_kind(kind: &str) -> String {
    let mut out = String::new();
    for character in kind.chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('_') {
            out.push('_');
        }
    }
    if out.is_empty() {
        "data".to_string()
    } else {
        out
    }
}

/// Builds `__MC_<kind>_<12hex>__` with a session-scoped HMAC of `(kind, value)`.
pub fn mint(hmac_key: &[u8; 32], kind: &str, value: &str) -> String {
    let slug = sanitize_kind(kind);
    let digest = keyed_digest(hmac_key, &slug, value);
    format!("{PREFIX}{slug}_{digest}{SUFFIX}")
}

fn keyed_digest(hmac_key: &[u8; 32], kind: &str, value: &str) -> String {
    let mut mac = match HmacSha256::new_from_slice(hmac_key) {
        Ok(mac) => mac,
        Err(_) => {
            // HMAC-SHA256 accepts any key length; a 32-byte key cannot fail.
            tracing::error!("HMAC-SHA256 rejected a 32-byte session key");
            return hex::encode(&hmac_key[..6]);
        }
    };
    mac.update(kind.as_bytes());
    mac.update(&[0u8]);
    mac.update(value.as_bytes());
    hex::encode(&mac.finalize().into_bytes()[..6])
}

/// Longest suffix of `text` that might be an incomplete placeholder.
pub fn partial_suffix_len(text: &str) -> usize {
    let max = PREFIX.len() + 48;
    let bytes = text.as_bytes();
    let start = bytes.len().saturating_sub(max);
    for offset in start..bytes.len() {
        if let Ok(suffix) = std::str::from_utf8(&bytes[offset..])
            && is_potential_partial(suffix)
        {
            return bytes.len() - offset;
        }
    }
    0
}

fn is_potential_partial(suffix: &str) -> bool {
    if suffix.is_empty() {
        return false;
    }
    if suffix.len() < PREFIX.len() {
        return PREFIX.starts_with(suffix);
    }
    if !suffix.starts_with(PREFIX) {
        return false;
    }
    suffix
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '_')
        && !suffix.ends_with(SUFFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_is_stable_for_the_same_key_kind_and_value() {
        let key = [7u8; 32];
        assert_eq!(
            mint(&key, "email", "a@b.com"),
            mint(&key, "email", "a@b.com")
        );
        assert_ne!(
            mint(&key, "email", "a@b.com"),
            mint(&key, "email", "c@d.com")
        );
    }

    #[test]
    fn sanitize_kind_strips_punctuation() {
        assert_eq!(sanitize_kind("Employee ID"), "employee_id");
        assert_eq!(sanitize_kind("???"), "data");
    }

    #[test]
    fn partial_suffix_holds_an_opening_placeholder() {
        assert_eq!(partial_suffix_len("hello __MC_em"), "__MC_em".len());
        assert_eq!(partial_suffix_len("hello"), 0);
    }
}
