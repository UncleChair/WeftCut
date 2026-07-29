//! Shared error type for the video-understanding backends (local llama.cpp
//! sidecar, BYO OpenAI-compatible endpoint, cloud VLM). Concrete backends map
//! their spawn/HTTP failures onto these variants so the MCP tool layer renders
//! one agent-friendly error shape regardless of which engine served the request.
//!
//! Architectural twin of [`speech::error::SpeechError`](crate::speech) — the
//! variants line up 1:1 (missing key/endpoint, spawn/exit/timeout for the local
//! sidecar, network/parse for HTTP), so the tool-layer error mapper reads the
//! same way for both subsystems.

use super::backend::VlmBackend;

#[derive(Debug, thiserror::Error)]
pub enum VlmError {
    #[error("no API key configured for {provider:?}; configure it in Settings → Transcription")]
    MissingKey { provider: VlmBackend },

    #[error("{provider:?} rejected the API key (401 unauthorized)")]
    InvalidKey { provider: VlmBackend },

    #[error("no endpoint URL configured for {provider:?}; set it in Settings")]
    MissingEndpoint { provider: VlmBackend },

    #[error("{provider:?} is rate-limited{}", retry_after_s.map(|s| format!(" (retry after {s}s)")).unwrap_or_default())]
    RateLimited {
        provider: VlmBackend,
        retry_after_s: Option<u64>,
    },

    #[error("{provider:?} returned an error: {message}")]
    Provider {
        provider: VlmBackend,
        message: String,
    },

    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("frame extraction failed: {0}")]
    FrameExtract(String),

    #[error("failed to parse scene description: {0}")]
    Parse(String),

    // ── Local CLI-sidecar failures (llama-mtmd-cli) — mirror SpeechError ─────
    #[error("failed to spawn video-understanding engine {program}: {cause}")]
    Spawn { program: String, cause: String },

    #[error("video-understanding engine exited with {}: {stderr}", code.map(|c| format!("code {c}")).unwrap_or_else(|| "a signal".into()))]
    EngineExit { code: Option<i32>, stderr: String },

    #[error("video-understanding engine timed out after {secs}s")]
    Timeout { secs: u64 },
}
