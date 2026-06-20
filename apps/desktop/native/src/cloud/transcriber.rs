//! `Transcriber` capability surface — audio file in, SRT body out.
//!
//! The trait is `Send + Sync + dyn`-compatible so the picker can hand back a
//! `Box<dyn Transcriber>` regardless of which provider was configured. Owned
//! `PathBuf` / `String` in the request struct (not borrows) keep the
//! async-trait desugaring clean.
//!
//! Provider impls (OpenAI Whisper today; Deepgram / AssemblyAI would slot in)
//! live in sibling modules and `impl Transcriber for ...`. Adding a second
//! provider is a single-file change as long as the new impl uses the shared
//! [`super::http::shared_client`] and surfaces failures through
//! [`super::errors::CloudError`].

use std::path::PathBuf;

use async_trait::async_trait;

use super::errors::CloudError;

#[derive(Debug, Clone)]
pub struct TranscribeRequest {
    /// Mono 16 kHz WAV. Produce via [`super::audio_extract::extract_audio_window`].
    pub audio_path: PathBuf,
    /// Optional BCP-47 hint (`"en"`, `"zh"`); pass `None` for auto-detect.
    pub language: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TranscribeResponse {
    /// SRT body. Cue timestamps are **relative to the start of the supplied
    /// audio file** (i.e., 0 = the first sample of the slice). The caller —
    /// the `transcribe_clip` MCP tool — shifts these to timeline-absolute
    /// before returning to the agent.
    pub srt_body: String,
    /// Detected language if the provider returns one, else `None`.
    pub language_detected: Option<String>,
}

#[async_trait]
pub trait Transcriber: Send + Sync {
    async fn transcribe(
        &self,
        req: TranscribeRequest,
    ) -> Result<TranscribeResponse, CloudError>;
}
