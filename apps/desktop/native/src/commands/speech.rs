//! Speech-backend Settings commands. Key MATERIAL never crosses this surface —
//! status reports presence only, and the key used by `settings_test_provider`
//! is read from the in-memory `speech_config` cache (pushed in by Electron main
//! from safeStorage), never returned. `set`/`clear` are handled in the Electron
//! main process (safeStorage + `Backend::set_cloud_key`), so they have no
//! dispatch arm here.

use crate::commands::ApiKeyStatus;
use crate::napi_backend::Backend;
use crate::speech;
use crate::speech::backend::{Locality, SpeechBackend};
use crate::speech::config::{availability, Availability, BackendConfig};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTestProviderArgs {
    pub provider: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechBackendsArgs {
    /// The user's preferred engine tag (`"openai"` / `"whisper_cpp"` /
    /// `"funasr"`), or `None`/`"auto"` for automatic (fall through
    /// `DEFAULT_ORDER`). Injected by Electron main from the TS-owned
    /// `speech_config.json` store, since the preferred engine is non-secret
    /// TS-side config, not part of the Rust `speech_config` snapshot.
    pub preferred: Option<String>,
}

/// Static capability surface of a backend, echoed to the Settings UI so it can
/// gray out rows a locality can never serve (e.g. TTS on a local engine).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCapabilities {
    pub transcription: bool,
    pub tts: bool,
}

/// One row for the Settings → Transcription/Speech panel: a backend's identity
/// + static facts + its LIVE availability + whether the resolver would pick it
/// right now (`selected`). The non-secret local paths/hints are merged in by
/// Electron main from the TS store — they are NOT echoed here.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechBackendStatus {
    /// Stable wire tag (`SpeechBackend::as_str`).
    pub backend: String,
    pub label: String,
    /// `"cloud"` | `"local"`.
    pub locality: String,
    pub capabilities: SpeechCapabilities,
    /// `"available"` | `"needs_key"` | `"needs_binary"` | `"needs_model"`.
    pub availability: String,
    /// True on the single backend the transcription resolver would use right
    /// now given the user's preference + what is available. `false` on every
    /// row when nothing is configured (the "no backend" degrade case).
    pub selected: bool,
}

/// Stable wire tag for an [`Availability`] verdict.
fn availability_tag(a: Availability) -> &'static str {
    match a {
        Availability::Available => "available",
        Availability::NeedsKey => "needs_key",
        Availability::NeedsBinary => "needs_binary",
        Availability::NeedsModel => "needs_model",
    }
}

/// Resolve a wire tag (`"openai"`, …) to its [`SpeechBackend`]. Matches against
/// the stable `as_str` tag, not the serde form.
fn parse_backend(s: &str) -> Result<SpeechBackend, String> {
    SpeechBackend::all()
        .iter()
        .copied()
        .find(|b| b.as_str() == s)
        .ok_or_else(|| format!("unknown provider: {s}"))
}

/// Presence-only status for the Settings → API keys panel. Reports whether an
/// API key is cached for each cloud backend.
///
/// Ticket 02 keeps this listing **cloud backends only** (the ones an API key
/// applies to), so the wire content is identical to today's single OpenAI row.
/// Local-engine rows — configured by binary/model path, not a key — are ticket
/// 05's UI generalization, not this one. `configured` is strictly "an `ApiKey`
/// entry is present".
pub async fn settings_get_api_key_status(b: &Backend) -> Result<Vec<ApiKeyStatus>, String> {
    let cfg = b.speech_config.lock().expect("speech_config poisoned");
    Ok(SpeechBackend::all()
        .iter()
        .copied()
        .filter(|b| b.locality() == Locality::Cloud)
        .map(|p| ApiKeyStatus {
            provider: p.as_str().to_string(),
            label: p.label().to_string(),
            configured: matches!(cfg.get(p.as_str()), Some(BackendConfig::ApiKey(_))),
        })
        .collect())
}

/// Live smoke check for a backend, routed through [`speech::probe_backend`]
/// (cloud: `GET /v1/models`; local: binary/model file existence). Returns
/// `SpeechError::MissingKey` (message mentions Settings) cleanly when a cloud
/// backend has no key cached, rather than a misleading "test failed".
pub async fn settings_test_provider(
    b: &Backend,
    provider: String,
) -> Result<speech::ConnectionTestInfo, String> {
    let backend = parse_backend(&provider)?;
    // Clone the config entry out and drop the lock before the await.
    let cfg = b
        .speech_config
        .lock()
        .expect("speech_config poisoned")
        .get(backend.as_str())
        .cloned();
    speech::probe_backend(backend, cfg.as_ref())
        .await
        .map_err(|e| format!("{e}"))
}

/// Full backend listing for the Settings → Transcription/Speech panel: EVERY
/// [`SpeechBackend`], each with its label / locality / capabilities, its live
/// [`availability`] against the current `speech_config`, and a `selected`
/// marker for the one the transcription resolver would use given `preferred`.
///
/// Generalizes [`settings_get_api_key_status`] (which lists cloud backends
/// only) to cover local engines too — but that command is KEPT alongside this
/// one so existing TS callers don't break. `preferred` is injected by Electron
/// main from the TS-owned preferred-engine store (`"auto"` / absent → automatic
/// fall-through).
pub async fn settings_get_speech_backends(
    b: &Backend,
    preferred: Option<String>,
) -> Result<Vec<SpeechBackendStatus>, String> {
    let cfg = b.speech_config.lock().expect("speech_config poisoned");
    // "auto" / unknown / absent → None (automatic); a known tag → that backend.
    let preferred_backend = preferred
        .as_deref()
        .filter(|s| *s != "auto")
        .and_then(|s| SpeechBackend::all().iter().copied().find(|bk| bk.as_str() == s));
    let selected = speech::resolve_selected_transcriber_backend(preferred_backend, &cfg);
    Ok(SpeechBackend::all()
        .iter()
        .copied()
        .map(|p| {
            let caps = p.capabilities();
            SpeechBackendStatus {
                backend: p.as_str().to_string(),
                label: p.label().to_string(),
                locality: match p.locality() {
                    Locality::Cloud => "cloud",
                    Locality::Local => "local",
                }
                .to_string(),
                capabilities: SpeechCapabilities {
                    transcription: caps.transcription,
                    tts: caps.tts,
                },
                availability: availability_tag(availability(p, cfg.get(p.as_str()))).to_string(),
                selected: selected == Some(p),
            }
        })
        .collect())
}
