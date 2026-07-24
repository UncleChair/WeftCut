//! Backend resolution — the twin of `speech::resolve_transcriber`.
//!
//! [`resolve_scene_describer`] honors an optional `preferred` backend as a SOFT
//! hint, then walks [`DEFAULT_ORDER`], returning the first backend that is
//! [`Available`]. [`resolve_scene_describer_exact`] is the STRICT counterpart for
//! an explicit per-call `backend`: that engine or an error naming its gap, never
//! a silent substitute.
//!
//! **Privacy-strict.** [`DEFAULT_ORDER`] is local-first and cloud-last, and the
//! exact resolver never falls back, so an explicit local choice can never
//! degrade into a cloud frame upload — frames are heavier and more sensitive
//! than audio, which is why this rule is stricter here than the STT default.

use std::collections::HashMap;

use super::backend::{VlmBackend, DEFAULT_ORDER};
use super::config::{availability, entry, Availability, BackendConfig};
use super::describer::SceneDescriber;
use super::endpoint::{OpenAiCompatDescriber, CLOUD_MODEL, CLOUD_URL};
use super::error::VlmError;
use super::sidecar::{LlamaMtmdSidecar, OutputStyle};

/// Actionable "nothing can describe" message, naming every remedy (local engine,
/// BYO endpoint, cloud key). Shared so the tool layer's error and these tests
/// read the same string (ticket 06 acceptance #1).
pub const NO_DESCRIBER_CONFIGURED: &str =
    "no video-understanding backend available — configure a local engine (llama-mtmd-cli binary \
     + Qwen3-VL GGUF model + mmproj) in Settings, point WeftCut at a self-hosted \
     OpenAI-compatible endpoint, or add a cloud VLM API key";

/// Resolve a describer by **preference then availability**. Returns the chosen
/// backend alongside the describer so the tool layer can report which engine
/// actually served the request; `None` when nothing is configured.
pub fn resolve_scene_describer(
    preferred: Option<VlmBackend>,
    cfg: &HashMap<String, BackendConfig>,
) -> Option<(VlmBackend, Box<dyn SceneDescriber>)> {
    let chosen = select_backend(preferred, cfg)?;
    let d = construct_describer(chosen, entry(cfg, chosen))?;
    Some((chosen, d))
}

/// STRICT single-backend resolution for an explicit per-call override: build
/// `backend` or error naming exactly what is missing. Never falls back — the
/// caller asked for THIS engine (possibly local-for-privacy), so substituting
/// another (possibly cloud) engine would silently violate that choice.
pub fn resolve_scene_describer_exact(
    backend: VlmBackend,
    cfg: &HashMap<String, BackendConfig>,
) -> Result<Box<dyn SceneDescriber>, VlmError> {
    let e = entry(cfg, backend);
    match availability(backend, e) {
        Availability::Available => {
            construct_describer(backend, e).ok_or_else(|| VlmError::Provider {
                provider: backend,
                message: "backend is configured but could not be constructed".into(),
            })
        }
        Availability::NeedsKey => Err(VlmError::MissingKey { provider: backend }),
        Availability::NeedsEndpoint => Err(VlmError::MissingEndpoint { provider: backend }),
        Availability::NeedsBinary => Err(VlmError::Provider {
            provider: backend,
            message: "requested explicitly but its binary was not found — set its path in \
                      Settings, or omit `backend` to fall back to another engine"
                .into(),
        }),
        Availability::NeedsModel => Err(VlmError::Provider {
            provider: backend,
            message: "requested explicitly but its model or mmproj GGUF was not found — set its \
                      path in Settings, or omit `backend` to fall back to another engine"
                .into(),
        }),
    }
}

/// Which backend the resolver would pick right now, WITHOUT constructing it —
/// same preference-then-availability walk. `[preferred] ++ DEFAULT_ORDER`,
/// first one that is `Available`.
pub fn select_backend(
    preferred: Option<VlmBackend>,
    cfg: &HashMap<String, BackendConfig>,
) -> Option<VlmBackend> {
    preferred
        .into_iter()
        .chain(DEFAULT_ORDER.iter().copied())
        .find(|b| availability(*b, entry(cfg, *b)) == Availability::Available)
}

/// Build the concrete describer for an already-selected, `Available` backend.
/// Both local models drive the SAME `LlamaMtmdSidecar` (differing only in the
/// output style tag); BYO + cloud share `OpenAiCompatDescriber`. A `None` arm
/// means a caller hand-built config against a shape the backend can't use.
fn construct_describer(
    b: VlmBackend,
    cfg: Option<&BackendConfig>,
) -> Option<Box<dyn SceneDescriber>> {
    match (b, cfg) {
        (VlmBackend::Qwen3Vl, Some(BackendConfig::Local { binary, model, mmproj, device })) => {
            Some(Box::new(LlamaMtmdSidecar::new(
                binary.clone(),
                model.clone(),
                mmproj.clone(),
                device.clone(),
                OutputStyle::Qwen3VlJson,
            )))
        }
        (VlmBackend::MiniCpmV, Some(BackendConfig::Local { binary, model, mmproj, device })) => {
            Some(Box::new(LlamaMtmdSidecar::new(
                binary.clone(),
                model.clone(),
                mmproj.clone(),
                device.clone(),
                OutputStyle::MiniCpmVText,
            )))
        }
        (VlmBackend::ByoEndpoint, Some(BackendConfig::Endpoint { url, api_key, model })) => {
            Some(Box::new(OpenAiCompatDescriber::new(
                url.clone(),
                api_key.clone(),
                model.clone().unwrap_or_else(|| "default".into()),
                VlmBackend::ByoEndpoint,
            )))
        }
        (VlmBackend::Cloud, Some(BackendConfig::ApiKey { key })) => {
            Some(Box::new(OpenAiCompatDescriber::new(
                CLOUD_URL.to_string(),
                Some(key.clone()),
                CLOUD_MODEL.to_string(),
                VlmBackend::Cloud,
            )))
        }
        _ => None,
    }
}

/// The `model` string for the result envelope — the model file stem (local),
/// the configured / default endpoint model (BYO), or the cloud model.
pub fn model_label(b: VlmBackend, cfg: Option<&BackendConfig>) -> String {
    match (b, cfg) {
        (_, Some(BackendConfig::Local { model, .. })) => model
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("local")
            .to_string(),
        (_, Some(BackendConfig::Endpoint { model, .. })) => {
            model.clone().unwrap_or_else(|| "endpoint".into())
        }
        (VlmBackend::Cloud, _) => CLOUD_MODEL.to_string(),
        _ => b.as_str().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cfg_with(entries: &[(&str, BackendConfig)]) -> HashMap<String, BackendConfig> {
        entries.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    /// A local config with all three files present on disk.
    fn present_local(dir: &std::path::Path) -> BackendConfig {
        let binary = dir.join("llama-mtmd-cli");
        let model = dir.join("qwen.gguf");
        let mmproj = dir.join("mmproj.gguf");
        for p in [&binary, &model, &mmproj] {
            std::fs::write(p, b"\x00").unwrap();
        }
        BackendConfig::Local { binary, model, mmproj, device: None }
    }

    #[test]
    fn empty_config_resolves_to_none() {
        assert!(resolve_scene_describer(None, &HashMap::new()).is_none());
    }

    #[test]
    fn present_local_qwen_resolves_and_reports_backend() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = cfg_with(&[("qwen3_vl", present_local(dir.path()))]);
        let (chosen, _d) = resolve_scene_describer(None, &cfg).expect("resolves");
        assert_eq!(chosen, VlmBackend::Qwen3Vl);
    }

    #[test]
    fn preferred_unavailable_falls_through_default_order() {
        // MiniCPM soft-preferred but unconfigured; Qwen present → falls through.
        let dir = tempfile::tempdir().unwrap();
        let cfg = cfg_with(&[("qwen3_vl", present_local(dir.path()))]);
        let (chosen, _) =
            resolve_scene_describer(Some(VlmBackend::MiniCpmV), &cfg).expect("falls back");
        assert_eq!(chosen, VlmBackend::Qwen3Vl);
    }

    #[test]
    fn exact_unavailable_errors_instead_of_falling_back() {
        // Cloud key present, but an explicit Qwen request must NOT substitute
        // cloud — it errors naming the gap + the omit-`backend` remedy.
        let cfg = cfg_with(&[("cloud", BackendConfig::ApiKey { key: "sk-x".into() })]);
        let Err(err) = resolve_scene_describer_exact(VlmBackend::Qwen3Vl, &cfg) else {
            panic!("must not substitute cloud for an explicit local request");
        };
        let msg = format!("{err}");
        assert!(msg.contains("binary was not found"), "names the gap: {msg}");
        assert!(msg.contains("omit `backend`"), "names the remedy: {msg}");
    }

    #[test]
    fn exact_cloud_without_key_is_missing_key() {
        let Err(err) = resolve_scene_describer_exact(VlmBackend::Cloud, &HashMap::new()) else {
            panic!("no key must not resolve");
        };
        assert!(matches!(err, VlmError::MissingKey { .. }));
    }

    #[test]
    fn exact_endpoint_without_url_is_missing_endpoint() {
        let Err(err) = resolve_scene_describer_exact(VlmBackend::ByoEndpoint, &HashMap::new())
        else {
            panic!("no endpoint must not resolve");
        };
        assert!(matches!(err, VlmError::MissingEndpoint { .. }));
    }

    #[test]
    fn endpoint_and_cloud_construct_when_configured() {
        let cfg = cfg_with(&[
            (
                "byo_endpoint",
                BackendConfig::Endpoint {
                    url: "http://localhost:8080/v1/chat/completions".into(),
                    api_key: None,
                    model: Some("qwen2-vl".into()),
                },
            ),
            ("cloud", BackendConfig::ApiKey { key: "sk-x".into() }),
        ]);
        assert!(resolve_scene_describer_exact(VlmBackend::ByoEndpoint, &cfg).is_ok());
        assert!(resolve_scene_describer_exact(VlmBackend::Cloud, &cfg).is_ok());
        // Preference honored: explicitly prefer cloud → cloud (even though BYO
        // precedes it in DEFAULT_ORDER).
        assert_eq!(select_backend(Some(VlmBackend::Cloud), &cfg), Some(VlmBackend::Cloud));
    }

    #[test]
    fn model_label_is_the_local_file_stem() {
        let cfg = BackendConfig::Local {
            binary: PathBuf::from("/b/llama-mtmd-cli"),
            model: PathBuf::from("/m/Qwen3VL-4B-Instruct-Q4_K_M.gguf"),
            mmproj: PathBuf::from("/m/mmproj.gguf"),
            device: None,
        };
        assert_eq!(model_label(VlmBackend::Qwen3Vl, Some(&cfg)), "Qwen3VL-4B-Instruct-Q4_K_M");
        assert_eq!(model_label(VlmBackend::Cloud, None), CLOUD_MODEL);
    }

    #[test]
    fn no_provider_message_names_every_remedy() {
        assert!(NO_DESCRIBER_CONFIGURED.contains("local engine"));
        assert!(NO_DESCRIBER_CONFIGURED.contains("endpoint"));
        assert!(NO_DESCRIBER_CONFIGURED.contains("cloud"));
    }
}
