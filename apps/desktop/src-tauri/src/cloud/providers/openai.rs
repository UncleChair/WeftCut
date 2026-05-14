//! OpenAI provider — Whisper transcription (Stage 5) and tts-1 synthesis
//! (Stage 6). Both share the same API key pulled from `keys::Provider::OpenAi`
//! so the user configures one credential.

use std::time::Instant;

use async_trait::async_trait;
use reqwest::multipart::{Form, Part};
use reqwest::StatusCode;
use serde::Serialize;
use tokio::fs;

use crate::cloud::errors::CloudError;
use crate::cloud::http::{
    bearer_auth, retry_delay_for_status, shared_client, MAX_RETRY_ATTEMPTS, RETRY_TOTAL_BUDGET,
};
use crate::cloud::keys::Provider;
use crate::cloud::synthesizer::{
    AudioFormat, SynthesizeRequest, SynthesizeResponse, Synthesizer,
};
use crate::cloud::transcriber::{TranscribeRequest, TranscribeResponse, Transcriber};

/// OpenAI's documented Whisper upload cap. Surfacing this as a structured
/// `PayloadTooLarge` error lets the agent narrow `[t_start_us, t_end_us]`
/// rather than crashing into an opaque 413.
pub const WHISPER_MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;

const WHISPER_ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL: &str = "whisper-1";

/// Whisper transcription client. Construction is free — credentials are
/// fetched per request via `http::bearer_auth` so a key change in Settings
/// doesn't require restarting anything.
pub struct OpenAiWhisper;

impl OpenAiWhisper {
    pub fn new() -> Self {
        Self
    }
}

impl Default for OpenAiWhisper {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Transcriber for OpenAiWhisper {
    async fn transcribe(
        &self,
        req: TranscribeRequest,
    ) -> Result<TranscribeResponse, CloudError> {
        let bytes = fs::read(&req.audio_path).await?;
        let size = bytes.len() as u64;
        if size > WHISPER_MAX_UPLOAD_BYTES {
            return Err(CloudError::PayloadTooLarge {
                bytes: size,
                cap: WHISPER_MAX_UPLOAD_BYTES,
            });
        }

        let filename = req
            .audio_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("audio.wav")
            .to_string();

        let auth = bearer_auth(Provider::OpenAi)?;
        let started = Instant::now();
        let mut attempt: u32 = 0;
        let response = loop {
            // Rebuild the multipart form each iteration — `Form`/`Part` aren't
            // cleanly cloneable, but the bytes/filename/language are cheap to
            // re-wrap. Bytes are owned via `Vec<u8>::clone` only on retry.
            let file_part = Part::bytes(bytes.clone())
                .file_name(filename.clone())
                .mime_str("audio/wav")
                .expect("audio/wav is a valid mime");
            let mut form = Form::new()
                .text("model", WHISPER_MODEL)
                .text("response_format", "srt")
                .part("file", file_part);
            if let Some(lang) = req.language.as_deref() {
                form = form.text("language", lang.to_string());
            }
            let response = shared_client()
                .post(WHISPER_ENDPOINT)
                .header("Authorization", &auth)
                .multipart(form)
                .send()
                .await?;
            let status = response.status();
            if status.is_success() {
                break response;
            }
            if let Some(delay) =
                next_retry_delay(status, &response, attempt, started)
            {
                tracing::warn!(
                    target: "weftcut::cloud",
                    "OpenAI Whisper {status} (attempt {attempt}); retrying in {delay:?}",
                );
                drop(response);
                tokio::time::sleep(delay).await;
                attempt += 1;
                continue;
            }
            let retry_after_s = parse_retry_after(&response);
            let body_text = response.text().await.unwrap_or_default();
            return Err(map_status_to_cloud_error(status, retry_after_s, body_text));
        };
        let srt_body = response.text().await?;
        Ok(TranscribeResponse {
            srt_body,
            language_detected: None, // SRT response_format doesn't include it
        })
    }
}

/// Shared retry-decision helper used by both Whisper and tts-1. Returns the
/// delay to sleep, or `None` if the failure is permanent or the budget is
/// exhausted.
fn next_retry_delay(
    status: StatusCode,
    response: &reqwest::Response,
    attempt: u32,
    started: Instant,
) -> Option<std::time::Duration> {
    if attempt + 1 >= MAX_RETRY_ATTEMPTS {
        return None;
    }
    let retry_after_s = parse_retry_after(response);
    let delay = retry_delay_for_status(status, retry_after_s, attempt)?;
    if started.elapsed() + delay > RETRY_TOTAL_BUDGET {
        return None;
    }
    Some(delay)
}

// ============================================================
// TTS — tts-1
// ============================================================

const TTS_ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";
pub const TTS_MODEL: &str = "tts-1";
/// OpenAI's documented per-request input cap for tts-1 (characters of `input`).
pub const TTS_MAX_INPUT_CHARS: usize = 4096;
/// Voices documented in the OpenAI tts-1 docs. The provider checks the list
/// before sending so the agent gets a clean rejection rather than a 400 from
/// the API.
pub const TTS_VOICES: &[&str] =
    &["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

/// OpenAI tts-1 client. Like `OpenAiWhisper`, construction is free —
/// credentials are pulled per request via `http::bearer_auth`.
pub struct OpenAiTts;

impl OpenAiTts {
    pub fn new() -> Self {
        Self
    }
}

impl Default for OpenAiTts {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
struct TtsBody<'a> {
    model: &'a str,
    input: &'a str,
    voice: &'a str,
    response_format: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    speed: Option<f32>,
}

#[async_trait]
impl Synthesizer for OpenAiTts {
    async fn synthesize(
        &self,
        req: SynthesizeRequest,
    ) -> Result<SynthesizeResponse, CloudError> {
        if req.text.is_empty() {
            return Err(CloudError::Provider {
                provider: Provider::OpenAi,
                message: "text is empty — tts-1 requires non-empty input".into(),
            });
        }
        if req.text.chars().count() > TTS_MAX_INPUT_CHARS {
            return Err(CloudError::PayloadTooLarge {
                bytes: req.text.len() as u64,
                cap: TTS_MAX_INPUT_CHARS as u64,
            });
        }
        if !TTS_VOICES.iter().any(|v| v.eq_ignore_ascii_case(&req.voice)) {
            return Err(CloudError::Provider {
                provider: Provider::OpenAi,
                message: format!(
                    "unknown voice {:?}; expected one of {}",
                    req.voice,
                    TTS_VOICES.join(", "),
                ),
            });
        }
        if let Some(s) = req.speed {
            if !(0.25..=4.0).contains(&s) {
                return Err(CloudError::Provider {
                    provider: Provider::OpenAi,
                    message: format!(
                        "speed {s} outside tts-1 range [0.25, 4.0]",
                    ),
                });
            }
        }

        let body = TtsBody {
            model: TTS_MODEL,
            input: &req.text,
            voice: &req.voice,
            response_format: "mp3",
            speed: req.speed,
        };
        let auth = bearer_auth(Provider::OpenAi)?;
        let started = Instant::now();
        let mut attempt: u32 = 0;
        let response = loop {
            let response = shared_client()
                .post(TTS_ENDPOINT)
                .header("Authorization", &auth)
                .json(&body)
                .send()
                .await?;
            let status = response.status();
            if status.is_success() {
                break response;
            }
            if let Some(delay) =
                next_retry_delay(status, &response, attempt, started)
            {
                tracing::warn!(
                    target: "weftcut::cloud",
                    "OpenAI tts-1 {status} (attempt {attempt}); retrying in {delay:?}",
                );
                drop(response);
                tokio::time::sleep(delay).await;
                attempt += 1;
                continue;
            }
            let retry_after_s = parse_retry_after(&response);
            let body_text = response.text().await.unwrap_or_default();
            return Err(map_status_to_cloud_error(status, retry_after_s, body_text));
        };
        let bytes = response.bytes().await?.to_vec();
        Ok(SynthesizeResponse {
            audio: bytes,
            format: AudioFormat::Mp3,
        })
    }
}

/// Cache key for a content-addressed tts result. Stable across calls so the
/// Stage 6 `synthesize_speech` MCP tool can skip the API entirely on a repeat
/// request. Composition is `blake3(model || '\0' || lowercase(voice) || '\0'
/// || speed-or-"default" || '\0' || text)`.
///
/// Voice is lowercased before hashing because OpenAI tts-1 is case-insensitive
/// on the voice argument (we lowercase for matching too); a future provider
/// that's case-sensitive on voice will need its own key composition.
///
/// `speed: None` and `speed: Some(1.0)` produce DIFFERENT keys on purpose:
/// the agent might rely on "no `speed` parameter" being the provider's
/// untouched default, which can be observably different from explicitly
/// passing 1.0 in some providers' rate-shaping logic.
pub fn tts_cache_key(text: &str, voice: &str, speed: Option<f32>) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(TTS_MODEL.as_bytes());
    hasher.update(&[0]);
    hasher.update(voice.to_ascii_lowercase().as_bytes());
    hasher.update(&[0]);
    match speed {
        Some(s) => hasher.update(format!("{s}").as_bytes()),
        None => hasher.update(b"default"),
    };
    hasher.update(&[0]);
    hasher.update(text.as_bytes());
    hasher.finalize().to_hex().to_string()
}

// ============================================================
// Test connection — Settings "Test" button
// ============================================================

const MODELS_ENDPOINT: &str = "https://api.openai.com/v1/models";

#[derive(Debug, Clone, Serialize)]
pub struct OpenAiConnectionInfo {
    /// Number of models the configured key can list. Acts as a smoke check:
    /// a working key sees dozens of models, an invalid key gets 401 (mapped
    /// to `CloudError::InvalidKey` before we reach here).
    pub model_count: usize,
}

/// Validate the configured OpenAI API key with a cheap GET /v1/models call.
/// Returns model count on success; surfaces InvalidKey / RateLimited /
/// network errors per the shared mapping. Used by the Settings → "Test"
/// button so users learn about a bad key BEFORE the first agent call.
pub async fn test_connection() -> Result<OpenAiConnectionInfo, CloudError> {
    let auth = bearer_auth(Provider::OpenAi)?;
    let response = shared_client()
        .get(MODELS_ENDPOINT)
        .header("Authorization", auth)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let retry_after_s = parse_retry_after(&response);
        let body_text = response.text().await.unwrap_or_default();
        return Err(map_status_to_cloud_error(status, retry_after_s, body_text));
    }
    let json: serde_json::Value = response.json().await?;
    let model_count = json
        .get("data")
        .and_then(|v| v.as_array())
        .map(|arr| arr.len())
        .unwrap_or(0);
    Ok(OpenAiConnectionInfo { model_count })
}

// ============================================================
// Shared HTTP-status mapping (Whisper + tts-1)
// ============================================================

fn map_status_to_cloud_error(
    status: StatusCode,
    retry_after_s: Option<u64>,
    body_text: String,
) -> CloudError {
    match status {
        StatusCode::UNAUTHORIZED => CloudError::InvalidKey {
            provider: Provider::OpenAi,
        },
        StatusCode::PAYLOAD_TOO_LARGE => CloudError::PayloadTooLarge {
            // We already pre-checked against `WHISPER_MAX_UPLOAD_BYTES`, so
            // landing here means OpenAI tightened the cap or we miscounted.
            // Surface their advertised cap so the message stays accurate.
            bytes: 0,
            cap: WHISPER_MAX_UPLOAD_BYTES,
        },
        StatusCode::TOO_MANY_REQUESTS => CloudError::RateLimited {
            provider: Provider::OpenAi,
            retry_after_s,
        },
        _ => CloudError::Provider {
            provider: Provider::OpenAi,
            message: format!(
                "{} {}: {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or(""),
                trim_body(&body_text),
            ),
        },
    }
}

fn parse_retry_after(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

fn trim_body(s: &str) -> String {
    const MAX: usize = 400;
    let trimmed = s.trim();
    if trimmed.len() <= MAX {
        trimmed.to_string()
    } else {
        format!("{}…", &trimmed[..MAX])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_401_to_invalid_key() {
        let err = map_status_to_cloud_error(
            StatusCode::UNAUTHORIZED,
            None,
            "{\"error\":{\"message\":\"Invalid Authentication\"}}".into(),
        );
        match err {
            CloudError::InvalidKey { provider: Provider::OpenAi } => {}
            other => panic!("expected InvalidKey, got {other:?}"),
        }
    }

    #[test]
    fn maps_429_to_rate_limited_with_retry_after() {
        let err = map_status_to_cloud_error(
            StatusCode::TOO_MANY_REQUESTS,
            Some(20),
            "rate limit".into(),
        );
        match err {
            CloudError::RateLimited {
                provider: Provider::OpenAi,
                retry_after_s: Some(20),
            } => {}
            other => panic!("expected RateLimited(20), got {other:?}"),
        }
    }

    #[test]
    fn maps_413_to_payload_too_large() {
        let err = map_status_to_cloud_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            None,
            "too big".into(),
        );
        match err {
            CloudError::PayloadTooLarge { cap, .. } => {
                assert_eq!(cap, WHISPER_MAX_UPLOAD_BYTES);
            }
            other => panic!("expected PayloadTooLarge, got {other:?}"),
        }
    }

    #[test]
    fn maps_500_to_provider_error_with_body() {
        let err = map_status_to_cloud_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            None,
            "kaboom".into(),
        );
        match err {
            CloudError::Provider { provider: Provider::OpenAi, message } => {
                assert!(message.contains("500"), "missing status: {message}");
                assert!(message.contains("kaboom"), "missing body: {message}");
            }
            other => panic!("expected Provider, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn tts_rejects_empty_text() {
        let tts = OpenAiTts::new();
        let err = tts
            .synthesize(SynthesizeRequest {
                text: String::new(),
                voice: "alloy".into(),
                speed: None,
            })
            .await
            .expect_err("empty text");
        assert!(format!("{err}").contains("empty"));
    }

    #[tokio::test]
    async fn tts_rejects_text_exceeding_cap() {
        let tts = OpenAiTts::new();
        let too_long = "a".repeat(TTS_MAX_INPUT_CHARS + 1);
        let err = tts
            .synthesize(SynthesizeRequest {
                text: too_long,
                voice: "alloy".into(),
                speed: None,
            })
            .await
            .expect_err("text too long");
        match err {
            CloudError::PayloadTooLarge { cap, .. } => {
                assert_eq!(cap, TTS_MAX_INPUT_CHARS as u64);
            }
            other => panic!("expected PayloadTooLarge, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn tts_rejects_unknown_voice() {
        let tts = OpenAiTts::new();
        let err = tts
            .synthesize(SynthesizeRequest {
                text: "hello".into(),
                voice: "no-such-voice".into(),
                speed: None,
            })
            .await
            .expect_err("unknown voice");
        assert!(format!("{err}").contains("unknown voice"));
    }

    #[tokio::test]
    async fn tts_rejects_speed_outside_supported_range() {
        let tts = OpenAiTts::new();
        let err = tts
            .synthesize(SynthesizeRequest {
                text: "hello".into(),
                voice: "alloy".into(),
                speed: Some(5.0),
            })
            .await
            .expect_err("speed too high");
        assert!(format!("{err}").contains("speed 5"));
    }

    #[test]
    fn tts_cache_key_is_stable_and_input_sensitive() {
        let a = tts_cache_key("hello world", "alloy", None);
        let b = tts_cache_key("hello world", "alloy", None);
        assert_eq!(a, b, "same inputs → same key");

        // Voice change → different key.
        let c = tts_cache_key("hello world", "nova", None);
        assert_ne!(a, c);

        // Voice case-insensitive (we lowercase before hashing).
        let d = tts_cache_key("hello world", "Alloy", None);
        assert_eq!(a, d);

        // Speed: None and Some(1.0) MUST collide if both are "use default".
        // We use a literal "default" sentinel for None so they're distinct.
        let e = tts_cache_key("hello world", "alloy", Some(1.0));
        assert_ne!(
            a, e,
            "speed=None and speed=Some(1.0) should be distinct cache entries — the agent might rely on the default vs. explicit-1.0 distinction",
        );

        // Text change → different key.
        let f = tts_cache_key("hello world!", "alloy", None);
        assert_ne!(a, f);
    }

    #[test]
    fn trim_body_caps_at_400() {
        let long = "x".repeat(1000);
        let trimmed = trim_body(&long);
        // 400 'x' bytes + '…' (3 bytes in UTF-8).
        assert_eq!(trimmed.chars().count(), 401);
        assert!(trimmed.ends_with('…'));
    }
}
