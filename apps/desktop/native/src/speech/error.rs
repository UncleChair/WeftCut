//! Shared error type for cloud-provider calls (transcription / synthesis).
//! Concrete providers map their HTTP responses onto these
//! variants so the MCP tool layer can render a single, agent-friendly error
//! shape regardless of which provider served the request.
//!
//! The `From<reqwest::Error>` and `From<std::io::Error>` derives let provider
//! impls use `?` without manual mapping; everything else (auth, payload, rate
//! limits) needs an explicit constructor so the provider sees the failure mode.

use super::backend::SpeechBackend;

#[derive(Debug, thiserror::Error)]
pub enum SpeechError {
    #[error("no API key configured for {provider:?}; configure it in Settings → API keys")]
    MissingKey { provider: SpeechBackend },

    #[error("{provider:?} rejected the API key (401 unauthorized)")]
    InvalidKey { provider: SpeechBackend },

    #[error("{provider:?} is rate-limited{}", retry_after_s.map(|s| format!(" (retry after {s}s)")).unwrap_or_default())]
    RateLimited {
        provider: SpeechBackend,
        retry_after_s: Option<u64>,
    },

    #[error("audio payload is {bytes} bytes; provider cap is {cap} bytes — narrow the [in_us, out_us] window")]
    PayloadTooLarge { bytes: u64, cap: u64 },

    #[error("{provider:?} returned an error: {message}")]
    Provider {
        provider: SpeechBackend,
        message: String,
    },

    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("audio extraction failed: {0}")]
    AudioExtract(String),

    #[error("failed to parse transcript: {0}")]
    Parse(String),

    // ── Local CLI-sidecar failures (whisper.cpp / FunASR); ADR 0036 ─────────
    #[error("failed to spawn speech engine {program}: {cause}")]
    Spawn { program: String, cause: String },

    #[error("speech engine exited with {}: {stderr}", code.map(|c| format!("code {c}")).unwrap_or_else(|| "a signal".into()))]
    EngineExit { code: Option<i32>, stderr: String },

    #[error("speech engine timed out after {secs}s")]
    Timeout { secs: u64 },
}
