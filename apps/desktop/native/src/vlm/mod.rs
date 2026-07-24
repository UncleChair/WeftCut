//! Pluggable video-understanding backends behind a locality-neutral trait
//! surface — the architectural TWIN of the STT sidecar (`speech/`, ADR 0036).
//!
//! One capability surface: **scene description** — the [`SceneDescriber`] trait
//! → the `describe_clip` MCP tool + the `media://{id}/description` resource.
//! Take a clip's sampled frames, produce open-vocabulary timestamped
//! descriptions, cache them incrementally.
//!
//! The pieces line up 1:1 with `speech/`:
//! - [`backend::VlmBackend`] (↔ `SpeechBackend`) — the engine catalog + localities.
//! - [`config::BackendConfig`] / [`config::availability`] (↔ same) — config split
//!   by secrecy + the file/URL/key availability check.
//! - [`describer::SceneDescriber`] (↔ `Transcriber`) — frames in, a
//!   format-tagged [`parser::RawDescription`] out.
//! - [`parser::DescriptionParser`] (↔ `parse`) — one impl per output style,
//!   converging on [`description::DescSegment`] (↔ `Segment`).
//! - [`sidecar::LlamaMtmdSidecar`] (↔ the whisper.cpp/FunASR sidecar) — one-shot
//!   `llama-mtmd-cli` child, one spawn per clip.
//! - [`endpoint::OpenAiCompatDescriber`] — BYO endpoint + cloud (ticket 07).
//! - [`resolve`] (↔ `resolve_transcriber` / `_exact`) — preference-then-
//!   availability + a strict, privacy-strict per-call override.
//!
//! `SceneDescription`/`DescSegment` are the twins of `Transcript`/`Segment`;
//! timestamps are microseconds, **source-absolute** once the tool has shifted
//! the parser's window-relative output.

pub mod backend;
pub mod config;
pub mod describer;
pub mod description;
pub mod endpoint;
pub mod error;
pub mod frame_extract;
pub mod parser;
pub mod resolve;
pub mod sidecar;

// Re-exports the tool + resource layers reach for by the short `vlm::` path.
// Types used only within the module (the `SceneDescriber` / `DescriptionParser`
// traits, `TimedFrame`, `RawDescription`, `Availability`, `DescSegment`) are
// reached via their module path at the (few) sites that need them.
pub use backend::VlmBackend;
pub use config::BackendConfig;
pub use describer::{DescribeRequest, Focus};
pub use description::{cache_key, shift_segments, DescriptionCache, SceneDescription};
pub use error::VlmError;
pub use parser::parse_raw;
pub use resolve::{
    model_label, resolve_scene_describer, resolve_scene_describer_exact, NO_DESCRIBER_CONFIGURED,
};
