//! Optional cloud API integrations behind a provider-agnostic trait surface.
//!
//! Two capability surfaces (added in Phase 6, see `docs/roadmap.md`):
//! - **Transcription** — [`Transcriber`] trait → `transcribe_clip` MCP tool.
//!   v1 provider: OpenAI Whisper (`providers::openai::OpenAiWhisper`).
//!   Future: Deepgram, AssemblyAI.
//! - **Text-to-speech** — [`Synthesizer`] trait → `synthesize_speech` MCP
//!   tool. v1 provider: OpenAI tts-1 (same key as Whisper; impl arrives in
//!   Stage 6). Future: ElevenLabs, Deepgram Aura.
//!
//! Keys are stored in the in-memory cache (`Backend.cloud_keys`) populated by
//! Electron main via `safeStorage`. One OpenAI key activates both surfaces.
//! Each provider declares [`keys::Capabilities`] so a future Deepgram
//! (transcription only) or ElevenLabs (TTS only) drops in cleanly. The pickers
//! [`pick_transcriber`] / [`pick_synthesizer`] walk [`keys::Provider::all`] and
//! grab the first that supports the requested surface AND has a key in the cache.
//!
//! Tools surface `Unavailable` (or are omitted from `list_tools` entirely)
//! when no configured provider supports the requested surface — the agent
//! should not see "cloud vs local", only "this tool exists or doesn't."
//!
//! Design: `docs/mcp.md` "Cloud APIs"; scope decision recorded in
//! `memory/project_phase6_scope.md`.

use std::collections::HashMap;

pub mod audio_extract;
pub mod errors;
pub mod http;
pub mod keys;
pub mod providers;
pub mod srt;
pub mod synthesizer;
pub mod transcriber;

pub use errors::CloudError;
pub use synthesizer::{AudioFormat, SynthesizeRequest, SynthesizeResponse, Synthesizer};
pub use transcriber::{TranscribeRequest, TranscribeResponse, Transcriber};

/// Pick a transcription-capable provider that has a key in the cache.
pub fn pick_transcriber(keys: &HashMap<String, String>) -> Option<Box<dyn Transcriber>> {
    for &p in self::keys::Provider::all() {
        if !p.capabilities().transcription {
            continue;
        }
        if let Some(key) = self::keys::get_key(keys, p) {
            return Some(construct_transcriber(p, key));
        }
    }
    None
}

/// TTS-capable counterpart to [`pick_transcriber`].
pub fn pick_synthesizer(keys: &HashMap<String, String>) -> Option<Box<dyn Synthesizer>> {
    for &p in self::keys::Provider::all() {
        if !p.capabilities().tts {
            continue;
        }
        if let Some(key) = self::keys::get_key(keys, p) {
            return Some(construct_synthesizer(p, key));
        }
    }
    None
}

fn construct_transcriber(p: self::keys::Provider, key: String) -> Box<dyn Transcriber> {
    match p {
        self::keys::Provider::OpenAi => Box::new(providers::openai::OpenAiWhisper::new(key)),
    }
}

fn construct_synthesizer(p: self::keys::Provider, key: String) -> Box<dyn Synthesizer> {
    match p {
        self::keys::Provider::OpenAi => Box::new(providers::openai::OpenAiTts::new(key)),
    }
}

/// Result of [`test_connection`] — provider-agnostic shape for the Settings
/// "Test" button. Fields stay shallow so the IPC layer can serde-pass them
/// without per-provider type juggling.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionTestInfo {
    /// The provider tag (`"openai"`, etc.) so the UI can attribute the result
    /// to the right row when multiple providers exist.
    pub provider: String,
    /// One-line success summary for the user (e.g., `"42 models available"`).
    pub summary: String,
}

/// Verify a provider's configured key works. Dispatches to the right
/// provider-side smoke check (OpenAI's `/v1/models` listing today). Returns
/// `CloudError::InvalidKey` / network errors per the shared mapping.
pub async fn test_connection(p: self::keys::Provider, key: &str) -> Result<ConnectionTestInfo, CloudError> {
    match p {
        self::keys::Provider::OpenAi => {
            let info = providers::openai::test_connection(key).await?;
            Ok(ConnectionTestInfo {
                provider: p.as_str().to_string(),
                summary: format!("{} models available", info.model_count),
            })
        }
    }
}
