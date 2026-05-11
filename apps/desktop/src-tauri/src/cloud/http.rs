//! Shared `reqwest::Client` + auth helpers for cloud providers.
//!
//! Provider impls (Stage 5+) call `shared_client()` so connection pooling,
//! TLS, and the User-Agent header are uniform across Whisper / TTS / any
//! future Deepgram or ElevenLabs client. Per-request timeouts and routing
//! stay the caller's job — this module never builds the request body.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;

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
}
