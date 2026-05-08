//! Optional cloud API integrations behind a provider-agnostic trait surface.
//!
//! Two capability surfaces (added in Phase 6, see `docs/roadmap.md`):
//! - **Transcription** — `Transcriber` trait → `transcribe_clip` MCP tool.
//!   v1 provider: OpenAI Whisper. Future: Deepgram, AssemblyAI.
//! - **Text-to-speech** — `Synthesizer` trait → `synthesize_speech` MCP tool.
//!   v1 provider: OpenAI tts-1 (same key as Whisper). Future: ElevenLabs,
//!   Deepgram Aura.
//!
//! Keyring entries are keyed by **API provider** (e.g. `Provider::OpenAi`),
//! not by feature surface — one OpenAI key activates both surfaces. Each
//! provider declares which surfaces it supports; tool default-pickers walk
//! the configured list and grab the first that can serve the surface.
//!
//! Tools surface `Unavailable` (or are omitted from `list_tools` entirely)
//! when no configured provider supports the requested surface — the agent
//! should not see "cloud vs local", only "this tool exists or doesn't."
//!
//! Design: `docs/mcp.md` "Cloud APIs"; scope decision recorded in
//! `memory/project_phase6_scope.md`.

pub mod keys;
