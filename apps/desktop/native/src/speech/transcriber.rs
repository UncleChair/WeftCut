//! `Transcriber` capability surface — audio file in, a format-tagged
//! [`RawTranscript`] out.
//!
//! The trait is deliberately *thin*: a backend produces one raw output style
//! (SRT or whisper JSON), it does NOT normalize. Normalization is a separate
//! pluggable layer ([`super::parse`]) so no backend reimplements SRT→words.
//! Honoring the request's
//! [`want_word_timing`](TranscribeRequest::want_word_timing) hint, a backend
//! returns the [`RawTranscript`] variant it can best serve it with — the
//! choice is internal to each impl. Whether a backend can deliver EXACT word
//! timing is a static fact exposed on
//! [`Capabilities::exact_word_timing`](crate::speech::Capabilities), not a
//! trait method.
//!
//! The trait is `Send + Sync + dyn`-compatible so the resolver can hand back a
//! `Box<dyn Transcriber>` regardless of which backend was configured. Owned
//! `PathBuf` / `String` in the request struct (not borrows) keep the
//! async-trait desugaring clean.
//!
//! Backend impls (OpenAI Whisper cloud; whisper.cpp / FunASR sidecars) live in
//! sibling modules and `impl Transcriber for ...`.

use std::path::PathBuf;

use async_trait::async_trait;

use super::error::SpeechError;
use super::parse::RawTranscript;

#[derive(Debug, Clone)]
pub struct TranscribeRequest {
    /// Mono 16 kHz WAV. Produce via [`super::audio_extract::extract_audio_window`].
    pub audio_path: PathBuf,
    /// Optional BCP-47 hint (`"en"`, `"zh"`); pass `None` for auto-detect.
    pub language: Option<String>,
    /// Prefer a word-timed output style if the backend supports one. Cloud
    /// OpenAI ignores it (SRT-only, always interpolated); whisper.cpp emits
    /// exact-timed JSON when `true`, SRT otherwise. The tool layer defaults it
    /// to `true` — the backend's best precision — since exact timing costs the
    /// engine nothing extra; `false` is an explicit opt-down to SRT style.
    pub want_word_timing: bool,
}

#[async_trait]
pub trait Transcriber: Send + Sync {
    /// Transcribe the request's audio and return one raw output style. Which
    /// style is the backend's choice, guided by
    /// [`TranscribeRequest::want_word_timing`].
    async fn transcribe(&self, req: TranscribeRequest) -> Result<RawTranscript, SpeechError>;
}
