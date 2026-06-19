//! In-memory key cache helpers for cloud-provider API keys.
//!
//! Keys are stored in `Backend.cloud_keys: Mutex<HashMap<String,String>>`,
//! keyed by the provider tag (lowercase, e.g. `"openai"`). Electron main
//! populates the cache via `safeStorage` — no OS keyring dependency.
//!
//! The napi command surface only exposes presence/absence, not the key
//! material. Internal callers (e.g., the Whisper client) use [`get_key`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Cloud providers we know how to talk to. Keep the serde tag stable — it's
/// the cache key and travels over the IPC wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    /// OpenAI API key. Activates both Whisper transcription and tts-1
    /// synthesis (Phase 6). Same key works for any future OpenAI-hosted
    /// endpoint.
    OpenAi,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::OpenAi => "openai",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Provider::OpenAi => "OpenAI (Whisper)",
        }
    }

    pub fn all() -> &'static [Provider] {
        &[Provider::OpenAi]
    }

    /// Which Phase 6 capability surfaces this provider can serve. The default
    /// provider picker (Stage 5) walks [`Provider::all`], filters by the
    /// requested capability, requires `has_key`, and returns the first match —
    /// so a single OpenAI key activates both transcription and TTS without
    /// any per-surface configuration on the user side.
    pub fn capabilities(self) -> Capabilities {
        match self {
            Provider::OpenAi => Capabilities {
                transcription: true,
                tts: true,
            },
        }
    }
}

/// Per-provider declaration of which Phase 6 surfaces are reachable through it.
/// Adding a provider that does TTS only is `transcription: false, tts: true`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub transcription: bool,
    pub tts: bool,
}

/// Presence check against the in-memory key cache (keyed by provider tag).
pub fn has_key(keys: &HashMap<String, String>, p: Provider) -> bool {
    keys.contains_key(p.as_str())
}

/// Read a provider's key from the in-memory cache, cloned for owned use.
pub fn get_key(keys: &HashMap<String, String>, p: Provider) -> Option<String> {
    keys.get(p.as_str()).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_tags_are_stable() {
        assert_eq!(Provider::OpenAi.as_str(), "openai");
    }

    #[test]
    fn openai_provider_supports_both_surfaces() {
        let caps = Provider::OpenAi.capabilities();
        assert!(caps.transcription);
        assert!(caps.tts);
    }

    #[test]
    fn has_and_get_key_read_the_cache() {
        let mut keys = HashMap::new();
        assert!(!has_key(&keys, Provider::OpenAi));
        keys.insert("openai".to_string(), "sk-x".to_string());
        assert!(has_key(&keys, Provider::OpenAi));
        assert_eq!(get_key(&keys, Provider::OpenAi).as_deref(), Some("sk-x"));
    }
}
