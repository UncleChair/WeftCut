//! `Transcriber` capability surface — audio file in, a format-tagged
//! [`RawTranscript`] out.
//!
//! The trait is deliberately *thin*: a backend produces one raw output style
//! (SRT or whisper JSON), it does NOT normalize. Normalization is a separate
//! pluggable layer ([`super::parse`]) so no backend reimplements SRT→words.
//! A backend advertises the styles it can emit via [`Transcriber::output_formats`]
//! and, honoring the request's [`want_word_timing`](TranscribeRequest::want_word_timing)
//! hint, returns the appropriate [`RawTranscript`] variant.
//!
//! The trait is `Send + Sync + dyn`-compatible so the resolver can hand back a
//! `Box<dyn Transcriber>` regardless of which backend was configured. Owned
//! `PathBuf` / `String` in the request struct (not borrows) keep the
//! async-trait desugaring clean.
//!
//! Backend impls (OpenAI Whisper today; whisper.cpp / FunASR sidecars next)
//! live in sibling modules and `impl Transcriber for ...`.

use std::path::PathBuf;

use async_trait::async_trait;

use super::error::SpeechError;
use super::parse::{RawTranscript, TranscriptFormat};

#[derive(Debug, Clone)]
pub struct TranscribeRequest {
    /// Mono 16 kHz WAV. Produce via [`super::audio_extract::extract_audio_window`].
    pub audio_path: PathBuf,
    /// Optional BCP-47 hint (`"en"`, `"zh"`); pass `None` for auto-detect.
    pub language: Option<String>,
    /// Prefer a word-timed output style if the backend supports one. Cloud
    /// OpenAI ignores it (SRT-only, always interpolated); whisper.cpp emits
    /// exact-timed JSON when `true`, SRT otherwise. The backend reconciles the
    /// hint against its own [`Transcriber::output_formats`].
    pub want_word_timing: bool,
}

#[async_trait]
pub trait Transcriber: Send + Sync {
    /// Transcribe the request's audio and return one raw output style. Which
    /// style is the backend's choice, constrained by [`Self::output_formats`]
    /// and guided by [`TranscribeRequest::want_word_timing`].
    async fn transcribe(&self, req: TranscribeRequest) -> Result<RawTranscript, SpeechError>;

    /// The raw output styles this backend can emit, preferred first. Advertised
    /// for introspection (Settings, resolver) and to let the pipeline reason
    /// about word-timing availability before a call.
    fn output_formats(&self) -> &'static [TranscriptFormat];
}
