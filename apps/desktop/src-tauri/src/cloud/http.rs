//! Shared `reqwest::Client` + auth helpers for cloud providers.
//!
//! Provider impls (Stage 5+) call `shared_client()` so connection pooling,
//! TLS, and the User-Agent header are uniform across Whisper / TTS / any
//! future Deepgram or ElevenLabs client. Per-request timeouts and routing
//! stay the caller's job — this module never builds the request body.
//!
//! Stage 8 hardening adds [`retry_delay_for_status`] so providers retry
//! transient failures (429 / 5xx) with sensible backoff. The retry loop
//! lives in each provider's `transcribe` / `synthesize` impl — we don't
//! abstract the loop here because the request body needs to be rebuilt
//! each iteration (multipart `Form`s aren't cheaply cloneable) and the
//! success-path body extraction differs per provider.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::{Client, StatusCode};

use super::errors::CloudError;
use super::keys::{self, Provider};

/// Default timeout cap for any single cloud request. Whisper on a 13-minute
/// 25 MB upload takes ~60s end-to-end; 180s is comfortable headroom without
/// letting a wedged provider freeze the MCP tool indefinitely. Stage 8 may
/// re-tune per surface.
const REQUEST_TIMEOUT_SECS: u64 = 180;

/// Process-global HTTP client. `reqwest::Client` is cheap to clone and pools
/// connections internally, so a single static instance is the right shape.
pub fn shared_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(concat!("videtor/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .expect("reqwest::Client::build with rustls-tls cannot fail")
    })
}

/// Build the `Authorization: Bearer <key>` value for a provider. Returns
/// [`CloudError::MissingKey`] cleanly when no key is configured so the
/// caller (eventually the MCP tool) can surface a structured "configure
/// your API key" hint instead of crashing.
pub fn bearer_auth(provider: Provider) -> Result<String, CloudError> {
    match keys::get_key(provider) {
        Ok(Some(k)) => Ok(format!("Bearer {k}")),
        Ok(None) => Err(CloudError::MissingKey { provider }),
        Err(e) => Err(CloudError::Provider {
            provider,
            message: format!("keyring failure: {e}"),
        }),
    }
}

/// Maximum retry attempts per request (1 initial + 2 retries = up to 3 sends).
/// Beyond this the loop returns the last error rather than burning more time.
pub const MAX_RETRY_ATTEMPTS: u32 = 3;

/// Time budget spent **between** retries — i.e., sum of sleep durations. This
/// is NOT a tail-latency cap on a wedged single attempt; the per-request
/// timeout in [`shared_client`] (180s) bounds that. If OpenAI hangs on the
/// first send for 180s and we never get a response, this budget is irrelevant
/// because we never enter [`retry_delay_for_status`]. The budget kicks in
/// once we've actually received an error response and need to decide whether
/// the cumulative back-off so far makes another attempt worth waiting for.
pub const RETRY_TOTAL_BUDGET: Duration = Duration::from_secs(45);

/// `Retry-After`-header cap. OpenAI sometimes returns large values during
/// outage windows; we'd rather fail fast than block the agent for minutes.
const RETRY_AFTER_CAP: Duration = Duration::from_secs(10);

/// Decide whether a failed HTTP status should be retried. Returns the delay
/// to wait before the next attempt, or `None` if the failure is permanent
/// (auth errors, validation errors, …).
///
/// 429: prefer `Retry-After` header (capped at [`RETRY_AFTER_CAP`]). If no
/// header, fall back to exponential. 5xx and 408 use exponential (500ms,
/// 1s, 2s, ...). Everything else is permanent.
pub fn retry_delay_for_status(
    status: StatusCode,
    retry_after_s: Option<u64>,
    attempt: u32,
) -> Option<Duration> {
    if !is_transient_status(status) {
        return None;
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        if let Some(s) = retry_after_s {
            return Some(Duration::from_secs(s).min(RETRY_AFTER_CAP));
        }
    }
    let shift = attempt.min(4);
    let backoff_ms = 500u64.saturating_mul(1u64 << shift);
    Some(Duration::from_millis(backoff_ms))
}

fn is_transient_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_client_is_a_singleton() {
        let a = shared_client();
        let b = shared_client();
        assert!(std::ptr::eq(a, b), "shared_client must return the same instance");
    }

    #[test]
    fn missing_key_returns_structured_error() {
        // No real keyring access — this test relies on the user not having a
        // bogus "test-only" provider key. The `Provider::OpenAi` variant is
        // intentionally not used here because it may be configured locally;
        // when we add a second provider variant this test will exercise that
        // unconfigured path. For now we just verify the error constructor is
        // wired up.
        let err = CloudError::MissingKey {
            provider: Provider::OpenAi,
        };
        assert!(format!("{err}").contains("Settings"));
    }

    #[test]
    fn retry_delay_returns_none_for_4xx_non_429() {
        for &status in &[
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::PAYLOAD_TOO_LARGE,
        ] {
            assert_eq!(
                retry_delay_for_status(status, None, 0),
                None,
                "{status} should not retry",
            );
        }
    }

    #[test]
    fn retry_delay_for_429_honors_retry_after_capped_at_10s() {
        let d = retry_delay_for_status(StatusCode::TOO_MANY_REQUESTS, Some(3), 0);
        assert_eq!(d, Some(Duration::from_secs(3)));

        // Over-cap: 60s gets clamped to 10s so we don't freeze the agent.
        let d = retry_delay_for_status(StatusCode::TOO_MANY_REQUESTS, Some(60), 0);
        assert_eq!(d, Some(RETRY_AFTER_CAP));
    }

    #[test]
    fn retry_delay_for_429_falls_back_to_exponential_without_header() {
        let d0 = retry_delay_for_status(StatusCode::TOO_MANY_REQUESTS, None, 0)
            .expect("retry");
        let d1 = retry_delay_for_status(StatusCode::TOO_MANY_REQUESTS, None, 1)
            .expect("retry");
        assert!(d1 > d0, "exponential should grow: {d0:?} -> {d1:?}");
    }

    #[test]
    fn retry_delay_for_5xx_uses_exponential_backoff() {
        for &status in &[
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::GATEWAY_TIMEOUT,
        ] {
            let d0 = retry_delay_for_status(status, None, 0).expect("retry");
            let d2 = retry_delay_for_status(status, None, 2).expect("retry");
            assert!(d2 > d0, "{status}: backoff should grow with attempt");
        }
    }

    #[test]
    fn retry_delay_caps_exponential_at_attempt_4() {
        // attempt=5 should not produce a larger delay than attempt=4 — the
        // shift saturates at 4 so we never enter pathological wait territory.
        let d4 = retry_delay_for_status(StatusCode::SERVICE_UNAVAILABLE, None, 4)
            .expect("retry");
        let d5 = retry_delay_for_status(StatusCode::SERVICE_UNAVAILABLE, None, 5)
            .expect("retry");
        assert_eq!(d4, d5);
    }
}
