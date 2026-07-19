//! Cloud-provider Settings commands. Key MATERIAL never crosses this
//! surface — status reports presence only, and the key used by
//! `settings_test_provider` is read from the in-memory cache (pushed in by
//! Electron main from safeStorage), never returned. `set`/`clear` are handled
//! in the Electron main process (safeStorage + `Backend::set_cloud_key`), so
//! they have no dispatch arm here.

use crate::cloud;
use crate::commands::ApiKeyStatus;
use crate::napi_backend::Backend;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTestProviderArgs {
    pub provider: String,
}

fn parse_provider(s: &str) -> Result<cloud::keys::Provider, String> {
    match s {
        "openai" => Ok(cloud::keys::Provider::OpenAi),
        other => Err(format!("unknown provider: {other}")),
    }
}

/// Presence-only status for the Settings panel. Walks every known provider and
/// reports whether a key is in the cache.
pub async fn settings_get_api_key_status(b: &Backend) -> Result<Vec<ApiKeyStatus>, String> {
    let keys = b.cloud_keys.lock().expect("cloud_keys poisoned");
    Ok(cloud::keys::Provider::all()
        .iter()
        .map(|p| ApiKeyStatus {
            provider: p.as_str().to_string(),
            label: p.label().to_string(),
            configured: cloud::keys::has_key(&keys, *p),
        })
        .collect())
}

/// Live smoke check against the configured key (GET /v1/models for OpenAI).
/// Returns `CloudError::MissingKey` (message mentions Settings) cleanly when
/// no key is cached, rather than a misleading "test failed".
pub async fn settings_test_provider(
    b: &Backend,
    provider: String,
) -> Result<cloud::ConnectionTestInfo, String> {
    let p = parse_provider(&provider)?;
    // Clone the key out and drop the lock before the await.
    let key = b
        .cloud_keys
        .lock()
        .expect("cloud_keys poisoned")
        .get(p.as_str())
        .cloned();
    let key =
        key.ok_or_else(|| format!("{}", cloud::errors::CloudError::MissingKey { provider: p }))?;
    cloud::test_connection(p, &key)
        .await
        .map_err(|e| format!("{e}"))
}
