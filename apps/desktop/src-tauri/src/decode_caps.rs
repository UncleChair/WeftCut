//! Per-machine WebCodecs decode capability, reported by the webview probe
//! (`src/decode/probeDecodeCaps.ts`) at startup and persisted so the first
//! import after launch — before the probe round-trips — can still use the
//! previous session's verdict. H.264 is always decodable and is NOT stored.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const DECODE_CAPS_FILE: &str = "decode_caps.json";

/// Codecs WebCodecs can decode on this machine (beyond H.264, which is
/// always decodable). Missing fields default false (conservative).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodeCaps {
    #[serde(default)]
    pub hevc: bool,
    #[serde(default)]
    pub av1: bool,
    #[serde(default)]
    pub vp9: bool,
}

impl DecodeCaps {
    /// Conservative default used when no probe has reported yet: only
    /// H.264 is treated as directly decodable.
    pub fn none() -> Self {
        Self::default()
    }
}

#[derive(Clone)]
pub struct DecodeCapabilityStore {
    path: Arc<RwLock<PathBuf>>,
}

impl DecodeCapabilityStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            path: Arc::new(RwLock::new(config_dir.join(DECODE_CAPS_FILE))),
        }
    }

    pub fn get(&self) -> DecodeCaps {
        let path = self.path.read().expect("decode_caps path lock").clone();
        if !path.exists() {
            return DecodeCaps::none();
        }
        match fs::read_to_string(&path) {
            Ok(body) if !body.trim().is_empty() => {
                serde_json::from_str(&body).unwrap_or_else(|e| {
                    tracing::warn!("decode_caps parse {}: {e:#}", path.display());
                    DecodeCaps::none()
                })
            }
            Ok(_) => DecodeCaps::none(),
            Err(e) => {
                tracing::warn!("decode_caps read {}: {e:#}", path.display());
                DecodeCaps::none()
            }
        }
    }

    pub fn set(&self, caps: DecodeCaps) -> Result<()> {
        let path = self.path.read().expect("decode_caps path lock").clone();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(&caps).context("serialize decode_caps")?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
        fs::rename(&tmp, &path)
            .with_context(|| format!("promote {} -> {}", tmp.display(), path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn none_when_no_file() {
        let tmp = TempDir::new().unwrap();
        let store = DecodeCapabilityStore::new(tmp.path().to_path_buf());
        assert_eq!(store.get(), DecodeCaps::none());
    }

    #[test]
    fn set_then_get_roundtrips() {
        let tmp = TempDir::new().unwrap();
        let store = DecodeCapabilityStore::new(tmp.path().to_path_buf());
        store
            .set(DecodeCaps {
                hevc: true,
                av1: true,
                vp9: false,
            })
            .unwrap();
        let got = DecodeCapabilityStore::new(tmp.path().to_path_buf()).get();
        assert!(got.hevc && got.av1 && !got.vp9);
    }

    #[test]
    fn corrupt_file_falls_back_to_none() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(DECODE_CAPS_FILE);
        fs::write(&path, "{ not json").unwrap();
        let store = DecodeCapabilityStore::new(tmp.path().to_path_buf());
        assert_eq!(store.get(), DecodeCaps::none());
    }

    #[test]
    fn missing_field_defaults_false() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(DECODE_CAPS_FILE);
        fs::write(&path, r#"{ "hevc": true }"#).unwrap();
        let got = DecodeCapabilityStore::new(tmp.path().to_path_buf()).get();
        assert!(got.hevc && !got.av1 && !got.vp9);
    }
}
