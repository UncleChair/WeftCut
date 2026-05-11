//! OS keyring-backed storage for cloud-provider API keys.
//!
//! Service name `"videtor"`, username = the [`Provider`] tag (lowercase, kebab).
//! - Windows: Credential Manager (Generic Credential)
//! - macOS: Keychain (Generic Password)
//! - Linux: Secret Service (libsecret) — needs a daemon at runtime; on a
//!   headless box keyring calls fail and the tools that need a key surface
//!   an "unavailable" hint to the agent.
//!
//! The Tauri command surface only exposes presence/absence, not the key
//! material. Internal callers (e.g., the Whisper client) use [`get_key`].

use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "videtor";

/// Cloud providers we know how to talk to. Keep the serde tag stable — it's
/// the keyring username and travels over the IPC wire.
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

fn entry(p: Provider) -> Result<Entry, keyring::Error> {
    Entry::new(SERVICE, p.as_str())
}

pub fn set_key(p: Provider, key: &str) -> Result<(), keyring::Error> {
    entry(p)?.set_password(key)
}

/// `Ok(None)` when no entry exists; `Err` only on platform failures.
pub fn get_key(p: Provider) -> Result<Option<String>, keyring::Error> {
    match entry(p)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn has_key(p: Provider) -> bool {
    matches!(get_key(p), Ok(Some(_)))
}

/// Idempotent: clearing a missing entry is a no-op.
pub fn clear_key(p: Provider) -> Result<(), keyring::Error> {
    match entry(p)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Keyring tests touch the real OS keystore. They're skipped by default —
    // run with `--ignored` when you actively want to exercise the platform
    // backend. Each test uses a unique pseudo-provider key via a separate
    // entry to avoid clobbering the user's real OpenAI key.
    fn test_entry(name: &str) -> Entry {
        Entry::new(SERVICE, &format!("test-{name}")).unwrap()
    }

    #[test]
    #[ignore]
    fn roundtrip() {
        let e = test_entry("roundtrip");
        let _ = e.delete_credential();
        e.set_password("hunter2").unwrap();
        assert_eq!(e.get_password().unwrap(), "hunter2");
        e.delete_credential().unwrap();
    }

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
}
