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
//! Keyring entries are keyed by **API provider** (e.g. [`keys::Provider::OpenAi`]),
//! not by feature surface — one OpenAI key activates both surfaces. Each
//! provider declares [`keys::Capabilities`] so a future Deepgram (transcription
//! only) or ElevenLabs (TTS only) drops in cleanly. The pickers [`pick_transcriber`]
//! / [`pick_synthesizer`] walk [`keys::Provider::all`] and grab the first that
//! supports the requested surface AND has a key configured.
//!
//! Tools surface `Unavailable` (or are omitted from `list_tools` entirely)
//! when no configured provider supports the requested surface — the agent
//! should not see "cloud vs local", only "this tool exists or doesn't."
//!
//! Design: `docs/mcp.md` "Cloud APIs"; scope decision recorded in
//! `memory/project_phase6_scope.md`.

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

/// Pick a transcription-capable provider. Walks [`keys::Provider::all`] in
/// declaration order, skips any that don't declare `transcription` capability
/// or don't have a key in the OS keyring, and returns a fresh `Box<dyn
/// Transcriber>` for the first match.
///
/// Returns `None` when no provider can serve transcription right now — the
/// `transcribe_clip` MCP tool maps that to a structured "configure an API
/// key in Settings" error so the agent has a clean recovery path.
pub fn pick_transcriber() -> Option<Box<dyn Transcriber>> {
    for &p in keys::Provider::all() {
        if !p.capabilities().transcription {
            continue;
        }
        if !keys::has_key(p) {
            continue;
        }
        return Some(construct_transcriber(p));
    }
    None
}

/// TTS-capable counterpart to [`pick_transcriber`] — same walk, filtered by
/// `capabilities().tts`. Used by the `synthesize_speech` MCP tool (Stage 6).
pub fn pick_synthesizer() -> Option<Box<dyn Synthesizer>> {
    for &p in keys::Provider::all() {
        if !p.capabilities().tts {
            continue;
        }
        if !keys::has_key(p) {
            continue;
        }
        return Some(construct_synthesizer(p));
    }
    None
}

fn construct_transcriber(p: keys::Provider) -> Box<dyn Transcriber> {
    match p {
        keys::Provider::OpenAi => Box::new(providers::openai::OpenAiWhisper::new()),
    }
}

fn construct_synthesizer(p: keys::Provider) -> Box<dyn Synthesizer> {
    match p {
        keys::Provider::OpenAi => Box::new(providers::openai::OpenAiTts::new()),
    }
}
