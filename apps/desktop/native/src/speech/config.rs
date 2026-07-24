//! Per-backend configuration (split by secrecy) and the availability check the
//! resolver uses to decide whether a backend can actually run right now.
//!
//! ADR 0036 "Config splits by secrecy": the OpenAI **key** is secret — it lives
//! in the `safeStorage`-backed cache and is persisted as `cloud_keys.json`. A
//! local engine's **paths** (binary, model) are non-secret and come from a
//! TS-owned config store (`main/speech-config.ts` → `speech_config.json`).
//! Electron main merges both into the single
//! `Backend.speech_config: HashMap<String, BackendConfig>` snapshot the
//! stateless Rust resolver reads (keyed by [`SpeechBackend::as_str`]) — the
//! `ApiKey` arm arrives via the unchanged `set_cloud_key`, the `Local` arm via
//! `set_local_backend`.

use std::path::PathBuf;

use super::backend::{Locality, SpeechBackend};

/// One backend's configuration, tagged by locality.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendConfig {
    /// A cloud backend's API key (secret). Inserted by `Backend::set_cloud_key`
    /// under the backend tag — this is the OpenAI path, byte-for-byte unchanged
    /// from before the generalization, which is what keeps existing users'
    /// `cloud_keys.json` resolving.
    ApiKey(String),
    /// A local sidecar's on-disk config: the CLI binary + model file, with
    /// optional device / thread hints. Populated from the TS config store via
    /// `Backend::set_local_backend`.
    Local {
        binary: PathBuf,
        model: PathBuf,
        /// FunASR (sherpa-onnx Paraformer) needs a `tokens.txt` beside the model
        /// (`--tokens=`); it is part of the model bundle. ADDITIVE — whisper.cpp
        /// leaves this `None` and ignores it entirely.
        tokens: Option<PathBuf>,
        device: Option<String>,
        threads: Option<u32>,
    },
}

/// Whether a backend can run right now, and if not, the single most-actionable
/// missing piece — so the Settings UI and the resolver's error can name the
/// exact gap rather than a generic "not configured".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// Ready to use: cloud has a key, or local has both files present.
    Available,
    /// Cloud backend with no API key configured.
    NeedsKey,
    /// Local backend whose CLI binary path does not exist on disk.
    NeedsBinary,
    /// Local backend whose model file path does not exist on disk.
    NeedsModel,
}

/// Decide whether `backend` can run given its (optional) config map entry.
///
/// - **Cloud** → `Available` iff an [`BackendConfig::ApiKey`] entry is present,
///   else `NeedsKey`. (Presence only — matches the pre-generalization
///   `has_key` semantics; an empty string still counts as "a key is set".)
/// - **Local** → `NeedsBinary` if the binary path is missing, then `NeedsModel`
///   if the model path is missing, then — for FunASR only — `NeedsModel` again
///   if its `tokens.txt` is unset/absent (tokens are part of the model bundle,
///   so they reuse `NeedsModel` rather than a new variant), then `Available`.
///   Checks **file existence only**; the liveness spawn is [`super::probe_backend`].
///
/// A config entry whose shape mismatches the backend's locality (e.g. an
/// `ApiKey` filed under a local backend) is treated as "the thing it needs is
/// absent" — a cloud backend reads it as `NeedsKey`, a local one as
/// `NeedsBinary`.
pub fn availability(backend: SpeechBackend, cfg: Option<&BackendConfig>) -> Availability {
    match backend.locality() {
        Locality::Cloud => match cfg {
            Some(BackendConfig::ApiKey(_)) => Availability::Available,
            _ => Availability::NeedsKey,
        },
        Locality::Local => match cfg {
            Some(BackendConfig::Local { binary, model, tokens, .. }) => {
                if !binary.exists() {
                    Availability::NeedsBinary
                } else if !model.exists() {
                    Availability::NeedsModel
                } else if backend == SpeechBackend::FunAsr
                    && tokens.as_deref().map_or(true, |t| !t.exists())
                {
                    // FunASR's sherpa-onnx Paraformer additionally needs a
                    // `tokens.txt` beside the model; a missing/unset one is part
                    // of the model bundle → NeedsModel (no new variant).
                    // whisper.cpp leaves `tokens: None` and never reaches here.
                    Availability::NeedsModel
                } else {
                    Availability::Available
                }
            }
            // No local config (or a mismatched ApiKey): the binary is the first
            // thing missing.
            _ => Availability::NeedsBinary,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_available_iff_api_key_present() {
        assert_eq!(
            availability(SpeechBackend::OpenAi, Some(&BackendConfig::ApiKey("sk-x".into()))),
            Availability::Available,
        );
        assert_eq!(
            availability(SpeechBackend::OpenAi, None),
            Availability::NeedsKey,
        );
    }

    #[test]
    fn local_missing_binary_then_model_then_available() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("whisper-cli");
        let model = dir.path().join("ggml-base.bin");

        // Neither file yet → binary is the first gap.
        let cfg = BackendConfig::Local {
            binary: binary.clone(),
            model: model.clone(),
            tokens: None,
            device: None,
            threads: None,
        };
        assert_eq!(
            availability(SpeechBackend::WhisperCpp, Some(&cfg)),
            Availability::NeedsBinary,
        );

        // Binary present, model still missing → NeedsModel.
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        assert_eq!(
            availability(SpeechBackend::WhisperCpp, Some(&cfg)),
            Availability::NeedsModel,
        );

        // Both present → Available.
        std::fs::write(&model, b"\x00\x01\x02").unwrap();
        assert_eq!(
            availability(SpeechBackend::WhisperCpp, Some(&cfg)),
            Availability::Available,
        );
    }

    #[test]
    fn local_with_no_config_needs_binary() {
        assert_eq!(
            availability(SpeechBackend::WhisperCpp, None),
            Availability::NeedsBinary,
        );
    }

    /// FunASR additionally requires a `tokens.txt`: with binary + model present
    /// but tokens unset/absent it reports `NeedsModel` (the tokens are part of
    /// the model bundle — no new variant); adding the tokens file → `Available`.
    #[test]
    fn funasr_needs_tokens_after_binary_and_model() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("sherpa-onnx-offline");
        let model = dir.path().join("model.onnx");
        let tokens = dir.path().join("tokens.txt");
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        std::fs::write(&model, b"\x00\x01\x02").unwrap();

        // tokens: None → NeedsModel (the bundle is incomplete).
        let cfg_none = BackendConfig::Local {
            binary: binary.clone(),
            model: model.clone(),
            tokens: None,
            device: None,
            threads: None,
        };
        assert_eq!(
            availability(SpeechBackend::FunAsr, Some(&cfg_none)),
            Availability::NeedsModel,
        );

        // tokens set but the file does not exist yet → still NeedsModel.
        let cfg = BackendConfig::Local {
            binary,
            model,
            tokens: Some(tokens.clone()),
            device: None,
            threads: None,
        };
        assert_eq!(
            availability(SpeechBackend::FunAsr, Some(&cfg)),
            Availability::NeedsModel,
        );

        // tokens file present → Available.
        std::fs::write(&tokens, b"<blk> 0\n").unwrap();
        assert_eq!(
            availability(SpeechBackend::FunAsr, Some(&cfg)),
            Availability::Available,
        );
    }

    /// whisper.cpp ignores `tokens` entirely: binary + model present with
    /// `tokens: None` is `Available` (the FunASR-only tokens gate must not
    /// regress the whisper path).
    #[test]
    fn whisper_ignores_tokens_and_is_available_without_them() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("whisper-cli");
        let model = dir.path().join("ggml.bin");
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        std::fs::write(&model, b"\x00").unwrap();
        let cfg = BackendConfig::Local {
            binary,
            model,
            tokens: None,
            device: None,
            threads: None,
        };
        assert_eq!(
            availability(SpeechBackend::WhisperCpp, Some(&cfg)),
            Availability::Available,
        );
    }
}
