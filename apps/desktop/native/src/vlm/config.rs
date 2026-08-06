//! Per-backend configuration (split by secrecy) and the availability check the
//! resolver uses to decide whether a backend can run right now.
//!
//! Same secrecy split as ADR 0036 (STT): a cloud VLM **key** is secret and
//! arrives from the `safeStorage`-backed cache (`cloud_keys.json`); a local
//! engine's **paths** (binary, model GGUF, mmproj GGUF, device) are non-secret
//! and come from the TS-owned `vlm-config` store; a BYO endpoint's **URL** is
//! non-secret (its optional key is secret). Electron main merges all of it into
//! the single `vlm_config: HashMap<String, BackendConfig>` snapshot the
//! stateless Rust resolver reads (keyed by [`VlmBackend::as_str`]).
//!
//! Unlike STT (which reads config off a `Backend` field populated by napi
//! setters), the video-understanding tool is fully stateless (ADR 0024): the TS
//! host injects this map into the `describe_clip` args, so no napi surface holds
//! VLM config. The types still `Deserialize` so the injected JSON parses.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;

use super::backend::{Locality, VlmBackend};

/// One backend's configuration, tagged by locality. `Deserialize` so the TS
/// host can inject the merged snapshot as JSON into `describe_clip` args.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BackendConfig {
    /// A cloud backend's API key (secret). Injected from `cloud_keys.json`.
    ApiKey { key: String },
    /// A local sidecar's on-disk config: the `llama-mtmd-cli` binary, the model
    /// GGUF, and its vision projector (`--mmproj`). A text-only GGUF without the
    /// mmproj cannot do vision, so mmproj is required for `Available`.
    Local {
        binary: PathBuf,
        model: PathBuf,
        mmproj: PathBuf,
        /// Reserved device hint (e.g. GPU index); not mapped to a CLI arg.
        #[serde(default)]
        device: Option<String>,
    },
    /// A BYO OpenAI-compatible endpoint. `url` is the full
    /// `/v1/chat/completions` URL; `api_key` is optional (self-hosted servers
    /// usually need none); `model` names the served model (defaults downstream).
    Endpoint {
        url: String,
        #[serde(default)]
        api_key: Option<String>,
        #[serde(default)]
        model: Option<String>,
    },
}

/// Whether a backend can run right now, and if not, the single most-actionable
/// missing piece — so the resolver's error names the exact gap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// Ready: cloud has a key, local has all three files, endpoint has a URL.
    Available,
    /// Cloud backend with no API key configured.
    NeedsKey,
    /// Local backend whose CLI binary path does not exist on disk.
    NeedsBinary,
    /// Local backend whose model GGUF or mmproj GGUF is missing.
    NeedsModel,
    /// BYO endpoint with no URL configured.
    NeedsEndpoint,
}

/// Decide whether `backend` can run given its (optional) config map entry.
///
/// Presence of the file / URL / key only — the liveness spawn is a separate
/// concern. Each [`Availability`] variant names the gap it stands for.
///
/// A config entry whose shape mismatches the backend's locality is treated as
/// "the thing it needs is absent".
pub fn availability(backend: VlmBackend, cfg: Option<&BackendConfig>) -> Availability {
    match backend.locality() {
        Locality::Local => match cfg {
            Some(BackendConfig::Local { binary, model, mmproj, .. }) => {
                if !binary.exists() {
                    Availability::NeedsBinary
                } else if !model.exists() || !mmproj.exists() {
                    Availability::NeedsModel
                } else {
                    Availability::Available
                }
            }
            _ => Availability::NeedsBinary,
        },
        Locality::Endpoint => match cfg {
            Some(BackendConfig::Endpoint { url, .. }) if !url.trim().is_empty() => {
                Availability::Available
            }
            _ => Availability::NeedsEndpoint,
        },
        Locality::Cloud => match cfg {
            Some(BackendConfig::ApiKey { .. }) => Availability::Available,
            _ => Availability::NeedsKey,
        },
    }
}

/// Convenience: look a backend's config entry up by its stable tag.
pub fn entry<'a>(
    cfg: &'a HashMap<String, BackendConfig>,
    backend: VlmBackend,
) -> Option<&'a BackendConfig> {
    cfg.get(backend.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_available_iff_api_key_present() {
        assert_eq!(
            availability(VlmBackend::Cloud, Some(&BackendConfig::ApiKey { key: "sk-x".into() })),
            Availability::Available,
        );
        assert_eq!(availability(VlmBackend::Cloud, None), Availability::NeedsKey);
    }

    #[test]
    fn endpoint_available_iff_url_nonempty() {
        assert_eq!(
            availability(
                VlmBackend::ByoEndpoint,
                Some(&BackendConfig::Endpoint {
                    url: "http://localhost:8080/v1/chat/completions".into(),
                    api_key: None,
                    model: None,
                }),
            ),
            Availability::Available,
        );
        assert_eq!(
            availability(
                VlmBackend::ByoEndpoint,
                Some(&BackendConfig::Endpoint { url: "  ".into(), api_key: None, model: None }),
            ),
            Availability::NeedsEndpoint,
        );
        assert_eq!(
            availability(VlmBackend::ByoEndpoint, None),
            Availability::NeedsEndpoint,
        );
    }

    #[test]
    fn local_missing_binary_then_model_then_mmproj_then_available() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("llama-mtmd-cli");
        let model = dir.path().join("qwen.gguf");
        let mmproj = dir.path().join("mmproj.gguf");
        let cfg = BackendConfig::Local {
            binary: binary.clone(),
            model: model.clone(),
            mmproj: mmproj.clone(),
            device: None,
        };

        // Nothing on disk → binary is the first gap.
        assert_eq!(availability(VlmBackend::Qwen3Vl, Some(&cfg)), Availability::NeedsBinary);
        // Binary present, model missing → NeedsModel.
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        assert_eq!(availability(VlmBackend::Qwen3Vl, Some(&cfg)), Availability::NeedsModel);
        // Model present, mmproj missing → still NeedsModel (bundle incomplete).
        std::fs::write(&model, b"\x00").unwrap();
        assert_eq!(availability(VlmBackend::Qwen3Vl, Some(&cfg)), Availability::NeedsModel);
        // All three present → Available.
        std::fs::write(&mmproj, b"\x00").unwrap();
        assert_eq!(availability(VlmBackend::Qwen3Vl, Some(&cfg)), Availability::Available);
    }

    #[test]
    fn config_deserializes_from_injected_json() {
        // The TS host injects this exact tagged JSON shape.
        let local: BackendConfig = serde_json::from_value(serde_json::json!({
            "kind": "local",
            "binary": "/b/llama-mtmd-cli",
            "model": "/m/qwen.gguf",
            "mmproj": "/m/mmproj.gguf",
        }))
        .unwrap();
        assert!(matches!(local, BackendConfig::Local { .. }));

        let key: BackendConfig =
            serde_json::from_value(serde_json::json!({ "kind": "api_key", "key": "sk-x" })).unwrap();
        assert_eq!(key, BackendConfig::ApiKey { key: "sk-x".into() });

        let ep: BackendConfig = serde_json::from_value(serde_json::json!({
            "kind": "endpoint", "url": "http://h/v1/chat/completions"
        }))
        .unwrap();
        assert!(matches!(ep, BackendConfig::Endpoint { .. }));
    }
}
