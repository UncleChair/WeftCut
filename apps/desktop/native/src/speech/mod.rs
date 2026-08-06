//! Pluggable speech backends behind a locality-neutral trait surface.
//!
//! Two capability surfaces (tool contracts in `docs/mcp.md`):
//! - **Transcription** — [`Transcriber`] trait → `transcribe_clip` MCP tool.
//! - **Text-to-speech** — [`Synthesizer`] trait → `synthesize_speech` MCP tool.
//!
//! Selection generalizes "has an API key" to "the preferred backend that is
//! *available*". Each [`backend::SpeechBackend`] declares its
//! [`backend::Locality`] (Cloud/Local) and [`backend::Capabilities`]; its
//! config (an API key, or a local engine's binary/model paths) lives in
//! [`config::BackendConfig`], and [`config::availability`] decides whether it
//! can run right now (cloud → key present; local → binary + model on disk).
//!
//! [`resolve_transcriber`] / [`resolve_synthesizer`] are the soft-preference
//! entry points; [`resolve_transcriber_exact`] is the STRICT counterpart for an
//! explicit per-call `backend` override. Each documents its own walk.
//!
//! Design: `docs/adr/0036-pluggable-speech-backends-normalized-transcript.md`;
//! `docs/mcp.md` "Speech".

use std::collections::HashMap;

pub mod audio_extract;
pub mod backend;
pub mod backends;
pub mod config;
pub mod error;
pub mod http;
pub mod parse;
pub mod synthesizer;
pub mod transcriber;
pub mod transcript;

pub use backend::{Capabilities, Locality, SpeechBackend, DEFAULT_ORDER};
pub use config::{availability, Availability, BackendConfig};
pub use error::SpeechError;
// `parse_raw` is the tool-layer chokepoint; `Segment`/`WordTiming` name the
// `transcribe_clip` result envelope. The rest of the transcript/parse
// vocabulary (RawTranscript, TranscriptFormat, TranscriptParser, Transcript,
// Word) is reached via its module path by the backends that produce it.
pub use parse::parse_raw;
pub use synthesizer::{AudioFormat, SynthesizeRequest, Synthesizer};
pub use transcriber::{TranscribeRequest, Transcriber};
pub use transcript::{Segment, WordTiming};

/// Actionable "nothing can transcribe" message, naming BOTH remedies (cloud
/// key + local engine). Shared so the tool layer's error and this module's
/// tests read the same string (ADR 0036 acceptance #1).
pub const NO_TRANSCRIBER_CONFIGURED: &str =
    "no transcription backend available — add an OpenAI API key in Settings, or configure a \
     local engine (whisper.cpp) binary + model path";

/// Actionable "nothing can synthesize speech" message. TTS is cloud-only today
/// (no local backend advertises `tts`), so this names just the API-key remedy.
pub const NO_SYNTHESIZER_CONFIGURED: &str =
    "no speech-synthesis backend available — add an OpenAI API key in Settings (local TTS \
     engines are not supported yet)";

/// Resolve a transcription-capable backend by **preference then availability**:
/// honor `preferred` as a soft hint, then fall through [`DEFAULT_ORDER`],
/// picking the first backend whose [`Capabilities::transcription`] holds AND
/// whose [`availability`] (given its `speech_config` entry) is `Available`.
/// Returns the chosen backend alongside the transcriber so the tool layer can
/// report which engine actually served the request; `None` when nothing is
/// configured. For a caller that *requires* a specific engine, use
/// [`resolve_transcriber_exact`] instead — this function substitutes freely.
pub fn resolve_transcriber(
    preferred: Option<SpeechBackend>,
    cfg: &HashMap<String, BackendConfig>,
) -> Option<(SpeechBackend, Box<dyn Transcriber>)> {
    let chosen = select_backend(preferred, cfg, |c| c.transcription)?;
    let t = construct_transcriber(chosen, cfg.get(chosen.as_str()))?;
    Some((chosen, t))
}

/// STRICT single-backend resolution for an explicit per-call override: build
/// `backend` or error naming exactly what is missing. Never falls back — the
/// caller asked for THIS engine (possibly local-for-privacy), so substituting
/// another (possibly cloud) engine would silently violate that choice. The
/// error text tells the agent both remedies: fix the gap, or omit `backend`
/// to let the resolver fall back.
pub fn resolve_transcriber_exact(
    backend: SpeechBackend,
    cfg: &HashMap<String, BackendConfig>,
) -> Result<Box<dyn Transcriber>, SpeechError> {
    if !backend.capabilities().transcription {
        return Err(SpeechError::Provider {
            provider: backend,
            message: "backend does not support transcription".into(),
        });
    }
    let entry = cfg.get(backend.as_str());
    match availability(backend, entry) {
        Availability::Available => {
            construct_transcriber(backend, entry).ok_or_else(|| SpeechError::Provider {
                provider: backend,
                // Available but unconstructable = a config-shape hole this
                // module failed to keep in sync; degrade to a clean error.
                message: "backend is configured but could not be constructed".into(),
            })
        }
        Availability::NeedsKey => Err(SpeechError::MissingKey { provider: backend }),
        Availability::NeedsBinary => Err(SpeechError::Provider {
            provider: backend,
            message: "requested explicitly but its binary was not found — set its path in \
                      Settings, or omit `backend` to fall back to another engine"
                .into(),
        }),
        Availability::NeedsModel => Err(SpeechError::Provider {
            provider: backend,
            message: "requested explicitly but its model file (for FunASR, also tokens.txt) was \
                      not found — set its path in Settings, or omit `backend` to fall back to \
                      another engine"
                .into(),
        }),
    }
}

/// TTS-capable counterpart to [`resolve_transcriber`].
pub fn resolve_synthesizer(
    preferred: Option<SpeechBackend>,
    cfg: &HashMap<String, BackendConfig>,
) -> Option<Box<dyn Synthesizer>> {
    let chosen = select_backend(preferred, cfg, |c| c.tts)?;
    construct_synthesizer(chosen, cfg.get(chosen.as_str()))
}

/// Which transcription backend the resolver would pick right now, WITHOUT
/// constructing it — the public counterpart to [`select_backend`] for the
/// Settings "which engine is active" (`selected`) marker. Same
/// preference-then-availability walk as [`resolve_transcriber`]; `None` when
/// nothing is available.
pub fn resolve_selected_transcriber_backend(
    preferred: Option<SpeechBackend>,
    cfg: &HashMap<String, BackendConfig>,
) -> Option<SpeechBackend> {
    select_backend(preferred, cfg, |c| c.transcription)
}

/// Pick the backend to use for a surface: `[preferred] ++ DEFAULT_ORDER`,
/// filtered to backends whose capabilities satisfy `wants`, first one that is
/// `Available`. Duplicates (when `preferred` is also in `DEFAULT_ORDER`) are
/// harmless — `find` short-circuits on the first available match.
fn select_backend(
    preferred: Option<SpeechBackend>,
    cfg: &HashMap<String, BackendConfig>,
    wants: impl Fn(Capabilities) -> bool,
) -> Option<SpeechBackend> {
    preferred
        .into_iter()
        .chain(DEFAULT_ORDER.iter().copied())
        .filter(|b| wants(b.capabilities()))
        .find(|b| availability(*b, cfg.get(b.as_str())) == Availability::Available)
}

/// Build the concrete transcriber for an already-selected, `Available` backend.
/// OpenAI (cloud), whisper.cpp and FunASR (local sidecars) all have real
/// `impl`s. FunASR additionally requires its `tokens.txt` to be present — the
/// arm only matches `tokens: Some(_)`, mirroring [`availability`] (which reports
/// `NeedsModel` without it), so a tokens-less FunASR config falls to `None`
/// rather than constructing an engine that cannot run. Reaching a `None` arm
/// means a caller hand-built config against a not-yet-runnable engine — we
/// return `None` rather than panic.
fn construct_transcriber(
    b: SpeechBackend,
    cfg: Option<&BackendConfig>,
) -> Option<Box<dyn Transcriber>> {
    match (b, cfg) {
        (SpeechBackend::OpenAi, Some(BackendConfig::ApiKey(key))) => {
            Some(Box::new(backends::openai::OpenAiWhisper::new(key.clone())))
        }
        (
            SpeechBackend::WhisperCpp,
            Some(BackendConfig::Local {
                binary,
                model,
                device,
                threads,
                // whisper.cpp ignores tokens.
                ..
            }),
        ) => Some(Box::new(backends::whisper_cpp::WhisperCpp::new(
            binary.clone(),
            model.clone(),
            *threads,
            device.clone(),
        ))),
        (
            SpeechBackend::FunAsr,
            Some(BackendConfig::Local {
                binary,
                model,
                tokens: Some(tokens),
                device,
                threads,
            }),
        ) => Some(Box::new(backends::funasr::FunAsr::new(
            binary.clone(),
            model.clone(),
            tokens.clone(),
            *threads,
            device.clone(),
        ))),
        _ => None,
    }
}

/// TTS counterpart to [`construct_transcriber`]. Only OpenAI advertises `tts`,
/// so `select_backend` only ever hands this `OpenAi`.
fn construct_synthesizer(
    b: SpeechBackend,
    cfg: Option<&BackendConfig>,
) -> Option<Box<dyn Synthesizer>> {
    match (b, cfg) {
        (SpeechBackend::OpenAi, Some(BackendConfig::ApiKey(key))) => {
            Some(Box::new(backends::openai::OpenAiTts::new(key.clone())))
        }
        _ => None,
    }
}

/// Result of [`probe_backend`] — provider-agnostic shape for the Settings
/// "Test" button. Fields stay shallow so the IPC layer can serde-pass them
/// without per-backend type juggling; the wire shape is frozen — TS Settings
/// parses it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionTestInfo {
    /// The backend tag (`"openai"`, etc.) so the UI can attribute the result
    /// to the right row when multiple backends exist.
    pub provider: String,
    /// One-line success summary for the user (e.g., `"42 models available"`).
    pub summary: String,
}

/// Probe whether a backend can serve requests, for the Settings "Test" button.
/// The availability verdict is conveyed through the `Ok`/`Err` split:
///
/// - **Cloud** — no key in [`BackendConfig::ApiKey`] → `SpeechError::MissingKey`
///   (its message hints Settings); with a key, a live smoke check reports what
///   it found.
/// - **Local** — GUARD: the [`availability`] (file-existence) verdict errors
///   early, naming the missing binary/model (incl. FunASR's tokens), with **no
///   spawn**. Only once the files exist does the engine get a liveness spawn.
pub async fn probe_backend(
    backend: SpeechBackend,
    cfg: Option<&BackendConfig>,
) -> Result<ConnectionTestInfo, SpeechError> {
    match backend.locality() {
        Locality::Cloud => {
            let key = match cfg {
                Some(BackendConfig::ApiKey(k)) => k.clone(),
                // Missing or shape-mismatched config → a clean MissingKey.
                _ => return Err(SpeechError::MissingKey { provider: backend }),
            };
            match backend {
                SpeechBackend::OpenAi => {
                    let info = backends::openai::test_connection(&key).await?;
                    Ok(ConnectionTestInfo {
                        provider: backend.as_str().to_string(),
                        summary: format!("{} models available", info.model_count),
                    })
                }
                // No other cloud backend exists yet.
                _ => Err(SpeechError::MissingKey { provider: backend }),
            }
        }
        Locality::Local => {
            // GUARD: bail on the file-existence verdict BEFORE any spawn, so a
            // missing binary/model reports NeedsBinary/NeedsModel with no child
            // process ever started.
            match availability(backend, cfg) {
                Availability::Available => {}
                Availability::NeedsBinary => {
                    return Err(SpeechError::Provider {
                        provider: backend,
                        message: "local engine binary not found — set its path in Settings".into(),
                    })
                }
                Availability::NeedsModel => {
                    return Err(SpeechError::Provider {
                        provider: backend,
                        message: "local engine model file not found — set its path in Settings"
                            .into(),
                    })
                }
                // Locality::Local never yields NeedsKey.
                Availability::NeedsKey => {
                    return Err(SpeechError::Provider {
                        provider: backend,
                        message: "local engine is not configured".into(),
                    })
                }
            }
            // Available ⇒ both files exist ⇒ the config is `Local`. Extract the
            // binary for the liveness spawn.
            let binary = match cfg {
                Some(BackendConfig::Local { binary, .. }) => binary,
                // Unreachable given Available above; degrade to a clean error.
                _ => {
                    return Err(SpeechError::Provider {
                        provider: backend,
                        message: "local engine is not configured".into(),
                    })
                }
            };
            match backend {
                SpeechBackend::WhisperCpp => {
                    // `--help` liveness: exit code is ignored; we only care that
                    // the binary is runnable. 15 s is a generous ceiling for a
                    // help/usage print.
                    let args = [std::ffi::OsString::from("--help")];
                    match backends::sidecar::probe_liveness(
                        binary,
                        &args,
                        std::time::Duration::from_secs(15),
                    )
                    .await
                    {
                        Ok(()) => Ok(ConnectionTestInfo {
                            provider: backend.as_str().to_string(),
                            summary: "whisper.cpp binary responds; model present".to_string(),
                        }),
                        Err(e) => Err(SpeechError::Provider {
                            provider: backend,
                            message: format!("whisper.cpp binary failed to run: {e}"),
                        }),
                    }
                }
                SpeechBackend::FunAsr => {
                    // Same `--help` liveness as whisper.cpp; the availability
                    // guard above already proved binary + model + tokens exist.
                    let args = [std::ffi::OsString::from("--help")];
                    match backends::sidecar::probe_liveness(
                        binary,
                        &args,
                        std::time::Duration::from_secs(15),
                    )
                    .await
                    {
                        Ok(()) => Ok(ConnectionTestInfo {
                            provider: backend.as_str().to_string(),
                            summary: "sherpa-onnx binary responds; model + tokens present"
                                .to_string(),
                        }),
                        Err(e) => Err(SpeechError::Provider {
                            provider: backend,
                            message: format!("sherpa-onnx binary failed to run: {e}"),
                        }),
                    }
                }
                // OpenAI is Cloud — never reaches this Local arm.
                _ => Ok(ConnectionTestInfo {
                    provider: backend.as_str().to_string(),
                    summary: "binary and model present".to_string(),
                }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_with(entries: &[(&str, BackendConfig)]) -> HashMap<String, BackendConfig> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn empty_config_resolves_to_none() {
        let cfg = HashMap::new();
        assert!(resolve_transcriber(None, &cfg).is_none());
        assert!(resolve_synthesizer(None, &cfg).is_none());
    }

    #[test]
    fn openai_key_resolves_a_transcriber() {
        let cfg = cfg_with(&[("openai", BackendConfig::ApiKey("sk-x".into()))]);
        assert!(resolve_transcriber(Some(SpeechBackend::OpenAi), &cfg).is_some());
        assert!(resolve_transcriber(None, &cfg).is_some());
        // OpenAI also serves TTS off the same key.
        assert!(resolve_synthesizer(None, &cfg).is_some());
    }

    #[test]
    fn preferred_unavailable_falls_through_to_openai() {
        // whisper.cpp SOFT-preferred but has no local config (unavailable) →
        // the resolver falls through DEFAULT_ORDER to OpenAI, which has a key.
        // The returned backend tag proves the fall-through landed on OpenAI.
        let cfg = cfg_with(&[("openai", BackendConfig::ApiKey("sk-x".into()))]);
        let (chosen, _) =
            resolve_transcriber(Some(SpeechBackend::WhisperCpp), &cfg).expect("falls back");
        assert_eq!(chosen, SpeechBackend::OpenAi);
    }

    /// The STRICT counterpart never substitutes: an explicitly-requested but
    /// unconfigured whisper.cpp errors (naming the gap and the omit-`backend`
    /// remedy) even though OpenAI is available and could serve the request.
    #[test]
    fn exact_unavailable_errors_instead_of_falling_back() {
        let cfg = cfg_with(&[("openai", BackendConfig::ApiKey("sk-x".into()))]);
        // (`Box<dyn Transcriber>` has no Debug, so no expect_err — destructure.)
        let Err(err) = resolve_transcriber_exact(SpeechBackend::WhisperCpp, &cfg) else {
            panic!("must not substitute OpenAI for an explicit whisper.cpp request");
        };
        let msg = format!("{err}");
        assert!(msg.contains("binary was not found"), "names the gap: {msg}");
        assert!(msg.contains("omit `backend`"), "names the fallback remedy: {msg}");
    }

    #[test]
    fn exact_available_backend_constructs() {
        let cfg = cfg_with(&[("openai", BackendConfig::ApiKey("sk-x".into()))]);
        assert!(resolve_transcriber_exact(SpeechBackend::OpenAi, &cfg).is_ok());
    }

    #[test]
    fn exact_cloud_without_key_is_missing_key() {
        let Err(err) = resolve_transcriber_exact(SpeechBackend::OpenAi, &HashMap::new()) else {
            panic!("no key must not resolve");
        };
        assert!(matches!(err, SpeechError::MissingKey { .. }));
    }

    #[test]
    fn preferred_openai_with_key_picks_openai() {
        let cfg = cfg_with(&[("openai", BackendConfig::ApiKey("sk-x".into()))]);
        assert!(resolve_transcriber(Some(SpeechBackend::OpenAi), &cfg).is_some());
    }

    #[tokio::test]
    async fn probe_whisper_cpp_with_no_config_reports_needs_binary_without_spawning() {
        // No config at all → availability is NeedsBinary → probe returns the
        // "binary not found" error BEFORE reaching any spawn (there is nothing
        // to spawn, which is the structural guarantee we assert).
        let err = probe_backend(SpeechBackend::WhisperCpp, None)
            .await
            .expect_err("no binary");
        let msg = format!("{err}");
        assert!(msg.contains("binary not found"), "unexpected: {msg}");
    }

    #[tokio::test]
    async fn probe_whisper_cpp_missing_binary_needs_binary_no_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = BackendConfig::Local {
            binary: dir.path().join("whisper-cli"), // does not exist
            model: dir.path().join("ggml.bin"),
            tokens: None,
            device: None,
            threads: None,
        };
        let err = probe_backend(SpeechBackend::WhisperCpp, Some(&cfg))
            .await
            .expect_err("missing binary");
        assert!(format!("{err}").contains("binary not found"));
    }

    #[tokio::test]
    async fn probe_whisper_cpp_binary_present_model_missing_needs_model_no_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("whisper-cli");
        std::fs::write(&binary, b"not a real binary").unwrap();
        let cfg = BackendConfig::Local {
            binary,
            model: dir.path().join("ggml.bin"), // does not exist
            tokens: None,
            device: None,
            threads: None,
        };
        // Model gap is detected by availability() → error before the liveness
        // spawn is ever attempted (so the bogus non-binary file is never run).
        let err = probe_backend(SpeechBackend::WhisperCpp, Some(&cfg))
            .await
            .expect_err("missing model");
        assert!(format!("{err}").contains("model file not found"));
    }

    /// FunASR with a present binary + model but missing tokens reports the
    /// model-bundle gap (tokens → NeedsModel) BEFORE any spawn — the same
    /// no-spawn structural guarantee as whisper.cpp, extended to the tokens file.
    #[tokio::test]
    async fn probe_funasr_binary_and_model_present_tokens_missing_no_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("sherpa-onnx-offline");
        let model = dir.path().join("model.onnx");
        std::fs::write(&binary, b"not a real binary").unwrap();
        std::fs::write(&model, b"\x00").unwrap();
        let cfg = BackendConfig::Local {
            binary,
            model,
            tokens: Some(dir.path().join("tokens.txt")), // does not exist
            device: None,
            threads: None,
        };
        let err = probe_backend(SpeechBackend::FunAsr, Some(&cfg))
            .await
            .expect_err("missing tokens");
        assert!(format!("{err}").contains("model file not found"));
    }

    #[test]
    fn no_provider_message_names_both_remedies() {
        // Acceptance #1: the message the tool layer surfaces when the resolver
        // returns None must name the cloud AND local remedies.
        assert!(resolve_transcriber(None, &HashMap::new()).is_none());
        assert!(
            NO_TRANSCRIBER_CONFIGURED.contains("OpenAI API key"),
            "must name the cloud remedy: {NO_TRANSCRIBER_CONFIGURED}"
        );
        assert!(
            NO_TRANSCRIBER_CONFIGURED.contains("whisper.cpp"),
            "must name the local remedy: {NO_TRANSCRIBER_CONFIGURED}"
        );
    }
}
