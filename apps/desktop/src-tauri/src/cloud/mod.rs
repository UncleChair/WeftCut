//! Optional cloud API integrations behind a provider-agnostic trait surface.
//!
//! Two capability surfaces (added in Phase 6, see `docs/roadmap.md`):
//! - **Transcription** — [`Transcriber`] trait → `transcribe_clip` MCP tool.
//!   v1 provider: OpenAI Whisper. Future: Deepgram, AssemblyAI.
//! - **Text-to-speech** — [`Synthesizer`] trait → `synthesize_speech` MCP
//!   tool. v1 provider: OpenAI tts-1 (same key as Whisper). Future:
//!   ElevenLabs, Deepgram Aura.
//!
//! Keyring entries are keyed by **API provider** (e.g. [`keys::Provider::OpenAi`]),
//! not by feature surface — one OpenAI key activates both surfaces. Each
//! provider declares [`keys::Capabilities`] so a future Deepgram (transcription
//! only) or ElevenLabs (TTS only) drops in cleanly. The Stage 5 picker walks
//! [`keys::Provider::all`] and grabs the first that supports the requested
//! surface AND has a key configured.
//!
//! Tools surface `Unavailable` (or are omitted from `list_tools` entirely)
//! when no configured provider supports the requested surface — the agent
//! should not see "cloud vs local", only "this tool exists or doesn't."
//!
//! Stage 4 (this commit) ships plumbing only: traits, shared error type,
//! shared `reqwest::Client`, audio-extract helper. The concrete provider
//! impls and the `pick_*` functions land in Stage 5 (Whisper) and Stage 6
//! (tts-1) — see the TODO at the bottom of this module.
//!
//! Design: `docs/mcp.md` "Cloud APIs"; scope decision recorded in
//! `memory/project_phase6_scope.md`.

pub mod audio_extract;
pub mod errors;
pub mod http;
pub mod keys;
pub mod synthesizer;
pub mod transcriber;

pub use errors::CloudError;
pub use synthesizer::{AudioFormat, SynthesizeRequest, SynthesizeResponse, Synthesizer};
pub use transcriber::{TranscribeRequest, TranscribeResponse, Transcriber};

// TODO(stage 5): once the first concrete provider (`OpenAiWhisper`) lands,
// add `pub fn pick_transcriber() -> Option<Box<dyn Transcriber>>` here that
// walks `keys::Provider::all()`, filters by `capabilities().transcription`,
// requires `keys::has_key`, and returns the first match. Mirror the same
// shape for `pick_synthesizer()` in Stage 6. Until concrete impls exist
// there's nothing to dispatch to.
