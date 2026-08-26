// SPDX-FileCopyrightText: Copyright (c) 2026 Budez LLC. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! RAM-only per-session placeholder maps with TTL eviction.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rand::Rng;

use crate::placeholders;

/// One conversation's HMAC key and secret map. Never written to disk.
pub struct SessionRecord {
    hmac_key: [u8; 32],
    placeholder_to_secret: HashMap<String, String>,
    secret_to_placeholder: HashMap<(String, String), String>,
    last_used: Instant,
}

impl SessionRecord {
    pub(crate) fn new() -> Self {
        let mut hmac_key = [0u8; 32];
        rand::rng().fill_bytes(&mut hmac_key);
        Self {
            hmac_key,
            placeholder_to_secret: HashMap::new(),
            secret_to_placeholder: HashMap::new(),
            last_used: Instant::now(),
        }
    }

    /// Returns the existing placeholder for `(kind, value)` or mints a new one.
    pub fn placeholder_for(&mut self, kind: &str, value: &str) -> String {
        let slug = placeholders::sanitize_kind(kind);
        let key = (slug.clone(), value.to_string());
        if let Some(placeholder) = self.secret_to_placeholder.get(&key) {
            return placeholder.clone();
        }
        let placeholder = placeholders::mint(&self.hmac_key, &slug, value);
        self.secret_to_placeholder.insert(key, placeholder.clone());
        self.placeholder_to_secret
            .insert(placeholder.clone(), value.to_string());
        placeholder
    }

    /// Snapshot of placeholder → secret for response restore.
    pub fn restore_map(&self) -> HashMap<String, String> {
        self.placeholder_to_secret.clone()
    }
}

/// Process-local session store. Secrets never leave this map.
pub struct SessionStore {
    inner: Mutex<HashMap<String, SessionRecord>>,
    ttl: Duration,
}

impl SessionStore {
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// Runs `f` with the session for `key`, creating it if needed.
    pub fn with_session<R>(&self, key: &str, f: impl FnOnce(&mut SessionRecord) -> R) -> R {
        let mut map = self.inner.lock();
        evict_expired(&mut map, self.ttl);
        let session = map
            .entry(key.to_string())
            .or_insert_with(SessionRecord::new);
        session.last_used = Instant::now();
        f(session)
    }

    /// Clones the restore map so a stream can outlive a later TTL eviction.
    pub fn snapshot_map(&self, key: &str) -> Option<HashMap<String, String>> {
        let mut map = self.inner.lock();
        evict_expired(&mut map, self.ttl);
        let session = map.get_mut(key)?;
        session.last_used = Instant::now();
        Some(session.restore_map())
    }

    /// Live session count and unique masked values. Does not copy secrets.
    pub(crate) fn gauges(&self) -> (u64, u64) {
        let mut map = self.inner.lock();
        evict_expired(&mut map, self.ttl);
        let unique_values = map
            .values()
            .map(|session| session.placeholder_to_secret.len() as u64)
            .sum();
        (map.len() as u64, unique_values)
    }
}

fn evict_expired(map: &mut HashMap<String, SessionRecord>, ttl: Duration) {
    let now = Instant::now();
    map.retain(|_, session| now.saturating_duration_since(session.last_used) < ttl);
}
