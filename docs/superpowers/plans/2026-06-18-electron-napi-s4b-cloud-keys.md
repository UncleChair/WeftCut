# S4b — safeStorage keys + re-enabled cloud surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move cloud API-key storage from the Rust `keyring` crate to Electron `safeStorage` (push-model into a Rust in-memory cache) and re-enable the cloud MCP tools/prompts deleted in S4a.

**Architecture:** Electron `main` owns persistence (`safeStorage`-encrypted `cloud_keys.json`) and pushes decrypted keys into a `Backend.cloud_keys` in-memory cache via two dedicated `#[napi]` methods. `reqwest` providers read the cache synchronously. `settings_set/clear_api_key` are intercepted in main's `backend:invoke`; `settings_get_api_key_status`/`settings_test_provider` stay Rust dispatch arms. Cloud tools/prompts come back under `#[cfg(feature="cloud")]`.

**Tech Stack:** Rust (napi-rs cdylib `@weftcut/core`), Electron 40 main (`safeStorage`), `@modelcontextprotocol/sdk` (e2e client), Playwright-for-Electron.

**Spec:** `docs/superpowers/specs/2026-06-18-electron-napi-s4b-cloud-keys-design.md`

## Global Constraints

- **Branch:** `migration/electron-napi`. Never commit to `main`. **Stage by explicit path** (parallel sessions edit this checkout) — never `git add -A`/`.`.
- **No `src/**` app-code edits.** The renderer's `src/ipc/index.ts` (which calls the four `settings_*` commands) is frozen. Only `electron/**`, `src-tauri/**`, `e2e/**`, `package.json`, and `docs/**` are editable. `ConnectAgentPanel.tsx` rework is OUT of scope (deferred to the post-S5 UI-gap pass).
- **Rust build/test feature set becomes `jobs,export,mcp,cloud`** from Task 2 onward. `cloud = ["jobs"]` (audio extraction needs `jobs::ffmpeg_sem`).
- **`cloud_keys.json` never holds plaintext** — `safeStorage.encryptString` output (base64) only. The Rust dispatcher never exposes key material (status reports presence only; the napi key-setters are not renderer-`invoke` arms).
- **Port transform (documented in `src-tauri/src/mcp/tools.rs:3-7`)** for any code recovered from the pre-S4a rmcp `WeftCutServer`: `self.project` → `b.project()?`, `self.cache` → `&b.cache`, `crate::logs::emit_via_app(&self.app, e)` → `b.log_slot.emit(e)`, `ok_text/ok_json/ok_void` → `ToolResult::{text,json,empty}`, `McpError::<ctor>` → `McpToolError::<ctor>` (1:1).
- **Recovery sources (git blobs):** cloud tools/helpers/args → `97e3c7f2:apps/desktop/src-tauri/src/mcp/mod.rs`; cloud prompts → `97e3c7f2:apps/desktop/src-tauri/src/mcp/prompts.rs`; old cloud commands + `ApiKeyStatus` → `4a0dda90:apps/desktop/src-tauri/src/commands.rs`. View with `git show <ref>:<path> | sed -n 'A,Bp'`.
- **Node:** v22.20.0 (fnm default). Do NOT install Node any other way.
- Rust test command (run from `apps/desktop/`): `cargo test --lib --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml`.

---

## File Structure

**Rust (`apps/desktop/src-tauri/`):**
- `Cargo.toml` — modify: `cloud = ["jobs"]`; remove `keyring = "3"`.
- `src/napi_backend.rs` — modify: add `cloud_keys` field + init; `set_cloud_key`/`clear_cloud_key` napi methods; two `#[cfg(feature="cloud")]` dispatch arms.
- `src/cloud/keys.rs` — modify: drop `keyring`; keep `Provider` metadata; add cache-lookup helpers `has_key`/`get_key` taking `&HashMap`.
- `src/cloud/http.rs` — modify: `bearer_auth(key: &str) -> String`; drop the keyring read.
- `src/cloud/mod.rs` — modify: `pick_transcriber`/`pick_synthesizer` take `&HashMap`; `test_connection(p, key)`; `construct_*` take the key.
- `src/cloud/providers/openai.rs` — modify: `OpenAiWhisper{key}`/`OpenAiTts{key}` constructed with the key; `test_connection(key)`.
- `src/commands/mod.rs` — modify: add `#[cfg(feature="cloud")] pub mod cloud;` + `ApiKeyStatus` struct.
- `src/commands/cloud.rs` — create: `settings_get_api_key_status` + `settings_test_provider` (+ args, `parse_provider`).
- `src/mcp/tools.rs` — modify: add `transcribe_clip`/`synthesize_speech` handlers + args + `resolve_clip_audio_source`/`write_voiceover_atomic`/`SynthesizeSpeechResult`, under `#[cfg(feature="cloud")]`.
- `src/mcp/catalog.rs` — modify: two `#[cfg(feature="cloud")]` `tool_table!` entries.
- `src/mcp/prompts.rs` — modify: `auto-caption` + `voiceover` prompts under `#[cfg(feature="cloud")]`.

**Electron main (`apps/desktop/electron/main/`):**
- `keys.ts` — create: `safeStorage` persistence (`loadAllKeys`/`setKey`/`clearKey`).
- `index.ts` — modify: startup push + `backend:invoke` interception of the two key-write commands.

**Build + e2e:**
- `apps/desktop/package.json` — modify: `napi:build` script → `--features jobs,export,mcp,cloud`.
- `apps/desktop/e2e/electron/s4b-cloud-keys.spec.ts` — create: safeStorage round-trip + `listTools` includes cloud tools.

---

## Task 1: Backend cloud-key cache + napi setters

Always-compiled (no `cfg`) so main can push keys regardless of feature set and the S4a "cfg-on-a-napi-method → linker error" trap is avoided. Built/tested with the CURRENT feature set (`jobs,export,mcp`) — this task does not touch the `cloud` feature.

**Files:**
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs`

**Interfaces:**
- Produces: `Backend.cloud_keys: std::sync::Mutex<HashMap<String,String>>` (pub(crate)); napi methods `set_cloud_key(provider, key)` / `clear_cloud_key(provider)` → JS `setCloudKey`/`clearCloudKey`.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `napi_backend.rs`:

```rust
    #[tokio::test]
    async fn cloud_key_cache_set_and_clear() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        assert!(!b.cloud_keys.lock().unwrap().contains_key("openai"));
        b.set_cloud_key("openai".into(), "sk-abc".into());
        assert_eq!(
            b.cloud_keys.lock().unwrap().get("openai").map(String::as_str),
            Some("sk-abc"),
        );
        b.clear_cloud_key("openai".into());
        assert!(!b.cloud_keys.lock().unwrap().contains_key("openai"));
    }
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/desktop && cargo test --lib --features jobs,export,mcp --manifest-path src-tauri/Cargo.toml cloud_key_cache_set_and_clear`
Expected: FAIL — `no field cloud_keys` / `no method set_cloud_key`.

- [ ] **Step 3: Add the field**

In the `pub struct Backend { ... }` block, add after `pub(crate) cache_dir: String,`:
```rust
    /// Plaintext cloud-provider API keys, keyed by provider tag ("openai").
    /// Pushed in by Electron main (decrypted from safeStorage) via
    /// `set_cloud_key`; read synchronously by the cloud reqwest providers.
    /// Always compiled (cache is feature-independent) so main can push keys
    /// regardless of the addon's feature set.
    pub(crate) cloud_keys: std::sync::Mutex<std::collections::HashMap<String, String>>,
```

In `build_backend`, in the `Backend { ... }` literal, add after `cache_dir,`:
```rust
        cloud_keys: std::sync::Mutex::new(std::collections::HashMap::new()),
```

- [ ] **Step 4: Add the napi setters**

In the main `#[napi] impl Backend { ... }` block (the one with `new`/`init`/`invoke`), add after the `invoke` method:
```rust
    /// Push a decrypted cloud API key into the in-memory cache. Called by
    /// Electron main after reading safeStorage; never a renderer-invoke arm
    /// (key material stays off the webview).
    #[napi]
    pub fn set_cloud_key(&self, provider: String, key: String) {
        self.cloud_keys.lock().expect("cloud_keys poisoned").insert(provider, key);
    }

    /// Remove a cloud API key from the cache (key cleared in Settings).
    #[napi]
    pub fn clear_cloud_key(&self, provider: String) {
        self.cloud_keys.lock().expect("cloud_keys poisoned").remove(&provider);
    }
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd apps/desktop && cargo test --lib --features jobs,export,mcp --manifest-path src-tauri/Cargo.toml cloud_key_cache_set_and_clear`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s4b): Backend cloud-key in-memory cache + napi set/clear (always-compiled)"
```

---

## Task 2: Cloud key-flow rewrite — drop keyring, read the cache

Makes the `cloud` module compile without `keyring`, reading keys passed in from the cache. Enables `cloud = ["jobs"]`. No cloud *callers* exist yet (tools/commands come in Tasks 3–5), so the module compiles standalone. From here the Rust build/test feature set is `jobs,export,mcp,cloud`.

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/cloud/keys.rs`
- Modify: `apps/desktop/src-tauri/src/cloud/http.rs`
- Modify: `apps/desktop/src-tauri/src/cloud/mod.rs`
- Modify: `apps/desktop/src-tauri/src/cloud/providers/openai.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `keys::has_key(&HashMap<String,String>, Provider) -> bool`, `keys::get_key(&HashMap<String,String>, Provider) -> Option<String>`; `http::bearer_auth(&str) -> String`; `cloud::pick_transcriber(&HashMap<String,String>) -> Option<Box<dyn Transcriber>>`, `cloud::pick_synthesizer(...)`; `cloud::test_connection(Provider, &str) -> Result<ConnectionTestInfo, CloudError>`; `OpenAiWhisper::new(String)`, `OpenAiTts::new(String)`, `providers::openai::test_connection(&str)`.

- [ ] **Step 1: Enable the feature graph + drop the dep**

In `Cargo.toml`, under `[features]`, change:
```toml
cloud = []       # transcription/TTS + keyring (S4)
```
to:
```toml
cloud = ["jobs"]  # transcription/TTS (S4b); needs jobs for audio_extract's ffmpeg_sem
```
Then delete the `keyring = "3"` dependency line (and its preceding comment block, lines describing keyring 4 migration).

- [ ] **Step 2: Rewrite `cloud/keys.rs` — keep metadata, drop keyring**

Replace the `use keyring::Entry;` line with `use std::collections::HashMap;` (keep `use serde::{Deserialize, Serialize};`). Keep `Provider`, `Capabilities`, and all their `impl` methods (`as_str`/`label`/`all`/`capabilities`) verbatim. **Delete** `fn entry`, `set_key`, `get_key`, `has_key`, `clear_key` and replace with cache lookups:
```rust
/// Presence check against the in-memory key cache (keyed by provider tag).
pub fn has_key(keys: &HashMap<String, String>, p: Provider) -> bool {
    keys.contains_key(p.as_str())
}

/// Read a provider's key from the in-memory cache, cloned for owned use.
pub fn get_key(keys: &HashMap<String, String>, p: Provider) -> Option<String> {
    keys.get(p.as_str()).cloned()
}
```
In `#[cfg(test)] mod tests`, **delete** the keyring-backed `test_entry` helper and the `#[ignore] roundtrip` test. Keep `provider_tags_are_stable` and `openai_provider_supports_both_surfaces`. Add:
```rust
    #[test]
    fn has_and_get_key_read_the_cache() {
        let mut keys = HashMap::new();
        assert!(!has_key(&keys, Provider::OpenAi));
        keys.insert("openai".to_string(), "sk-x".to_string());
        assert!(has_key(&keys, Provider::OpenAi));
        assert_eq!(get_key(&keys, Provider::OpenAi).as_deref(), Some("sk-x"));
    }
```

- [ ] **Step 3: Rewrite `cloud/http.rs::bearer_auth`**

Remove the top-level `use super::keys::{self, Provider};`. Replace `bearer_auth` with:
```rust
/// Build the `Authorization: Bearer <key>` header value. The caller resolves
/// the key from the in-memory cache (missing-key handling lives at the call
/// site / picker, which returns `CloudError::MissingKey` cleanly).
pub fn bearer_auth(key: &str) -> String {
    format!("Bearer {key}")
}
```
In `#[cfg(test)] mod tests`, the `missing_key_returns_structured_error` test constructs `CloudError::MissingKey { provider: Provider::OpenAi }`; add `use crate::cloud::keys::Provider;` inside the test module (top of `mod tests`) so it still resolves after the top-level import is gone.

- [ ] **Step 4: Rewrite `cloud/mod.rs` pickers + test_connection**

Add `use std::collections::HashMap;` near the top. Replace `pick_transcriber`/`pick_synthesizer`/`construct_transcriber`/`construct_synthesizer`/`test_connection` (drop the long rmcp "deferred list_tools filtering" doc-comment on `pick_transcriber`):
```rust
/// Pick a transcription-capable provider that has a key in the cache.
pub fn pick_transcriber(keys: &HashMap<String, String>) -> Option<Box<dyn Transcriber>> {
    for &p in keys::Provider::all() {
        if !p.capabilities().transcription {
            continue;
        }
        if let Some(key) = keys::get_key(keys, p) {
            return Some(construct_transcriber(p, key));
        }
    }
    None
}

/// TTS-capable counterpart to [`pick_transcriber`].
pub fn pick_synthesizer(keys: &HashMap<String, String>) -> Option<Box<dyn Synthesizer>> {
    for &p in keys::Provider::all() {
        if !p.capabilities().tts {
            continue;
        }
        if let Some(key) = keys::get_key(keys, p) {
            return Some(construct_synthesizer(p, key));
        }
    }
    None
}

fn construct_transcriber(p: keys::Provider, key: String) -> Box<dyn Transcriber> {
    match p {
        keys::Provider::OpenAi => Box::new(providers::openai::OpenAiWhisper::new(key)),
    }
}

fn construct_synthesizer(p: keys::Provider, key: String) -> Box<dyn Synthesizer> {
    match p {
        keys::Provider::OpenAi => Box::new(providers::openai::OpenAiTts::new(key)),
    }
}
```
And change `test_connection`'s signature + body to take the key:
```rust
pub async fn test_connection(p: keys::Provider, key: &str) -> Result<ConnectionTestInfo, CloudError> {
    match p {
        keys::Provider::OpenAi => {
            let info = providers::openai::test_connection(key).await?;
            Ok(ConnectionTestInfo {
                provider: p.as_str().to_string(),
                summary: format!("{} models available", info.model_count),
            })
        }
    }
}
```

- [ ] **Step 5: Rewrite `cloud/providers/openai.rs` to carry the key**

`OpenAiWhisper`:
```rust
pub struct OpenAiWhisper {
    key: String,
}

impl OpenAiWhisper {
    pub fn new(key: String) -> Self {
        Self { key }
    }
}
```
Delete the `impl Default for OpenAiWhisper`. In `transcribe`, change `let auth = bearer_auth(Provider::OpenAi)?;` to `let auth = bearer_auth(&self.key);`.

`OpenAiTts`: identical pattern — add `key: String`, `new(key)`, delete `impl Default for OpenAiTts`, change `let auth = bearer_auth(Provider::OpenAi)?;` to `let auth = bearer_auth(&self.key);`.

`test_connection`:
```rust
pub async fn test_connection(key: &str) -> Result<OpenAiConnectionInfo, CloudError> {
    let auth = bearer_auth(key);
    let response = shared_client()
        .get(MODELS_ENDPOINT)
        .header("Authorization", auth)
        .send()
        .await?;
    // ... rest unchanged ...
```
Update the import: `use crate::cloud::http::{bearer_auth, ...}` stays; `use crate::cloud::keys::Provider;` STAYS (still used by `CloudError::InvalidKey { provider: Provider::OpenAi }` etc.). In the `#[cfg(test)] mod tests`, change the three `OpenAiTts::new()` calls to `OpenAiTts::new("test-key".into())`.

- [ ] **Step 6: Build + run the cloud unit tests**

Run: `cd apps/desktop && cargo test --lib --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml cloud::`
Expected: PASS — the cloud module compiles with no `keyring`; `keys`, `http`, `openai` tests green.

- [ ] **Step 7: Full lib build to confirm no stragglers**

Run: `cd apps/desktop && cargo build --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml`
Expected: compiles clean (no `keyring`, no unused-import errors).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/cloud
git commit -m "migrate(s4b): cloud key-flow off keyring -> in-memory cache; cloud=[jobs]"
```

---

## Task 3: Settings commands — status + test against the cache

The two read-side commands stay Rust dispatch arms. `set`/`clear` do NOT get arms (main intercepts them).

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`
- Create: `apps/desktop/src-tauri/src/commands/cloud.rs`
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs`

**Interfaces:**
- Consumes: `Backend.cloud_keys` (Task 1), `cloud::test_connection` (Task 2).
- Produces: dispatch arms `settings_get_api_key_status` → `Vec<ApiKeyStatus>`, `settings_test_provider {provider}` → `ConnectionTestInfo`. `ApiKeyStatus { provider, label, configured }`.

- [ ] **Step 1: Write the failing test**

Add to `napi_backend.rs` `#[cfg(test)] mod tests`:
```rust
    #[cfg(feature = "cloud")]
    #[tokio::test]
    async fn settings_status_reflects_cache() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        // Unconfigured: openai present in the list, configured=false.
        let out = b.dispatch("settings_get_api_key_status", "{}").await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let openai = v.as_array().unwrap().iter().find(|e| e["provider"] == "openai").unwrap();
        assert_eq!(openai["configured"], false);
        assert!(openai["label"].as_str().unwrap().contains("OpenAI"));
        // After a push: configured=true.
        b.set_cloud_key("openai".into(), "sk-x".into());
        let out = b.dispatch("settings_get_api_key_status", "{}").await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let openai = v.as_array().unwrap().iter().find(|e| e["provider"] == "openai").unwrap();
        assert_eq!(openai["configured"], true);
    }

    #[cfg(feature = "cloud")]
    #[tokio::test]
    async fn settings_test_provider_missing_key_is_clean_error() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let err = b
            .dispatch("settings_test_provider", r#"{"provider":"openai"}"#)
            .await
            .unwrap_err();
        assert!(err.contains("Settings"), "missing-key error should hint Settings, got: {err}");
    }
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd apps/desktop && cargo test --lib --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml settings_status_reflects_cache settings_test_provider_missing_key`
Expected: FAIL — `unavailable: 'settings_get_api_key_status'`.

- [ ] **Step 3: Add `ApiKeyStatus` + the module declaration**

In `commands/mod.rs`, after the existing `#[cfg(feature = "export")] pub mod export;` declarations add:
```rust
#[cfg(feature = "cloud")]
pub mod cloud;
```
And add the view struct (near the other `#[derive(Serialize, Clone)]` view structs):
```rust
#[cfg(feature = "cloud")]
#[derive(Serialize, Clone)]
pub struct ApiKeyStatus {
    pub provider: String,
    pub label: String,
    pub configured: bool,
}
```

- [ ] **Step 4: Create `commands/cloud.rs`**

```rust
//! Cloud-provider Settings commands (S4b). Key MATERIAL never crosses this
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
    let key = b.cloud_keys.lock().expect("cloud_keys poisoned").get(p.as_str()).cloned();
    let key = key.ok_or_else(|| format!("{}", cloud::errors::CloudError::MissingKey { provider: p }))?;
    cloud::test_connection(p, &key).await.map_err(|e| format!("{e}"))
}
```

- [ ] **Step 5: Add the dispatch arms**

In `napi_backend.rs` `dispatch`, immediately before the final `other =>` arm, add:
```rust
            #[cfg(feature = "cloud")]
            "settings_get_api_key_status" => {
                ser(crate::commands::cloud::settings_get_api_key_status(self).await)
            }
            #[cfg(feature = "cloud")]
            "settings_test_provider" => {
                let a: crate::commands::cloud::SettingsTestProviderArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::cloud::settings_test_provider(self, a.provider).await)
            }
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `cd apps/desktop && cargo test --lib --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml settings_status_reflects_cache settings_test_provider_missing_key`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/commands/cloud.rs apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s4b): settings_get_api_key_status + settings_test_provider dispatch arms (cache-backed)"
```

---

## Task 4: Re-enable the cloud MCP tools

Port `transcribe_clip` + `synthesize_speech` (and their args + the `resolve_clip_audio_source` / `write_voiceover_atomic` helpers + `SynthesizeSpeechResult`) into `tools.rs` under `#[cfg(feature="cloud")]`, then advertise them in the catalog.

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs`
- Modify: `apps/desktop/src-tauri/src/mcp/catalog.rs`

**Interfaces:**
- Consumes: `Backend.cloud_keys`, `cloud::pick_transcriber/pick_synthesizer`, `cloud::audio_extract::extract_audio_window`, `cloud::srt::shift_srt`, `b.cache.voiceover(hash, ext)`.
- Produces: `tools::transcribe_clip(&Backend, TranscribeClipArgs)`, `tools::synthesize_speech(&Backend, SynthesizeSpeechArgs)`; catalog entries `transcribe_clip` / `synthesize_speech`.

- [ ] **Step 1: Recover the deleted bodies for reference**

Run and read:
```bash
git show 97e3c7f2:apps/desktop/src-tauri/src/mcp/mod.rs | sed -n '555,640p'    # transcribe_clip + _inner
git show 97e3c7f2:apps/desktop/src-tauri/src/mcp/mod.rs | sed -n '745,905p'    # synthesize_speech
git show 97e3c7f2:apps/desktop/src-tauri/src/mcp/mod.rs | sed -n '2085,2160p'  # TranscribeClipArgs / SynthesizeSpeechArgs / SynthesizeSpeechResult
git show 97e3c7f2:apps/desktop/src-tauri/src/mcp/mod.rs | sed -n '2748,2870p'  # resolve_clip_audio_source (+ ResolvedClipAudio struct)
git show 97e3c7f2:apps/desktop/src-tauri/src/mcp/mod.rs | sed -n '2960,3015p'  # write_voiceover_atomic
```

- [ ] **Step 2: Write the failing test**

Add to `mcp/catalog.rs` `#[cfg(test)] mod tests`:
```rust
    #[cfg(feature = "cloud")]
    #[test]
    fn catalog_advertises_cloud_tools() {
        let cat = catalog();
        assert!(cat.tools.iter().any(|t| t.name == "transcribe_clip"));
        assert!(cat.tools.iter().any(|t| t.name == "synthesize_speech"));
        // every advertised tool must dispatch — schema is an object.
        for t in &cat.tools {
            assert!(t.input_schema.is_object(), "{} schema not an object", t.name);
        }
    }
```
And add to `napi_backend.rs` `#[cfg(test)] mod tests`:
```rust
    #[cfg(feature = "cloud")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transcribe_clip_without_key_is_clean_error() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        // Bogus layer id, but the no-provider check fires before layer lookup
        // resolves to a transcribe — either way the reply is ok:false.
        let reply: serde_json::Value = serde_json::from_str(
            &b.mcp_call_tool("transcribe_clip".into(), r#"{"layer_id":"00000000-0000-0000-0000-000000000000"}"#.into())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(reply["ok"], false);
    }
```

- [ ] **Step 3: Run to confirm it fails**

Run: `cd apps/desktop && cargo test --lib --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml catalog_advertises_cloud_tools transcribe_clip_without_key`
Expected: FAIL — tools absent / unknown tool.

- [ ] **Step 4: Port the tool bodies into `tools.rs`**

At the top of `tools.rs`, add the cloud imports (gated):
```rust
#[cfg(feature = "cloud")]
use crate::cloud;
```
Append a `#[cfg(feature = "cloud")]`-gated section. Apply the **port transform** (Global Constraints) to the Step-1 bodies, with the key-flow change. Concretely:

The arg/result structs (recovered, `#[derive(Debug, Deserialize, JsonSchema)] pub(super)` for args; `Serialize` for the result):
```rust
#[cfg(feature = "cloud")]
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct TranscribeClipArgs {
    pub layer_id: String,
    #[serde(default)]
    pub t_start_us: Option<i64>,
    #[serde(default)]
    pub t_end_us: Option<i64>,
    #[serde(default)]
    pub language: Option<String>,
}
// SynthesizeSpeechArgs { text, voice, speed?, target_track_id?, t_start_us? }
// SynthesizeSpeechResult { layer_id, media_id, t_start_us, t_end_us, cached }
```
(Copy the exact field set + serde attrs + doc comments from the Step-1 `sed` output for `2085,2160`.)

`transcribe_clip` — port the `transcribe_clip` + `transcribe_clip_inner` pair into a single `pub(super) async fn transcribe_clip(b: &Backend, args: TranscribeClipArgs) -> Result<ToolResult, McpToolError>` (you MAY keep the producer-logging wrapper via `b.log_slot.emit(...)`, or inline — preserve the log entries). The provider lookup changes to read the cache:
```rust
    let transcriber = {
        let keys = b.cloud_keys.lock().expect("cloud_keys poisoned");
        cloud::pick_transcriber(&keys)
    }
    .ok_or_else(|| {
        McpToolError::invalid_request(
            "no transcription provider configured — open Settings → API keys and add an OpenAI API key",
            None,
        )
    })?;
```
(The `{ ... }` block drops the lock before the subsequent `.await`s.) Everything else (`resolve_clip_audio_source`, `extract_audio_window`, `transcribe`, `shift_srt`, `ToolResult::text(shifted)`) ports verbatim under the transform.

`synthesize_speech` — same: read `cloud::pick_synthesizer(&keys)` inside a lock-dropping block, then port the cache-key / `b.cache.voiceover(&cache_key, "mp3")` / `write_voiceover_atomic` / add-audio-layer / `ToolResult::json(&SynthesizeSpeechResult{..})` body under the transform. `map_cloud_error` (old free fn) becomes a local helper: map `CloudError` → `McpToolError` (recover its body from `git show 97e3c7f2:.../mcp/mod.rs | grep -n "fn map_cloud_error"` and port `McpError`→`McpToolError`).

Also port the helpers `resolve_clip_audio_source` (+ its `ResolvedClipAudio` struct) and `write_voiceover_atomic` into the same `#[cfg(feature="cloud")]` section (they're only used by these two tools).

- [ ] **Step 5: Add the catalog entries**

In `catalog.rs` `tool_table! { ... }`, add (descriptions copied verbatim from the Step-1 `#[tool(description = …)]` attributes at old lines ~556 and ~744):
```rust
    #[cfg(feature = "cloud")]
    "transcribe_clip" => ("<verbatim description from old line ~556>", tools::TranscribeClipArgs, tools::transcribe_clip),
    #[cfg(feature = "cloud")]
    "synthesize_speech" => ("<verbatim description from old line ~744>", tools::SynthesizeSpeechArgs, tools::synthesize_speech),
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `cd apps/desktop && cargo test --lib --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml catalog_advertises_cloud_tools transcribe_clip_without_key mcp_catalog_property_schemas_are_objects`
Expected: PASS (incl. the existing property-schema guard — the cloud args have no bare `serde_json::Value` fields).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/tools.rs apps/desktop/src-tauri/src/mcp/catalog.rs
git commit -m "migrate(s4b): re-enable transcribe_clip + synthesize_speech MCP tools (cfg cloud, cache-backed)"
```

---

## Task 5: Re-enable the cloud MCP prompts

Port `auto-caption` + `voiceover` into `prompts.rs` under `#[cfg(feature="cloud")]`.

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/prompts.rs`

**Interfaces:**
- Produces: prompt-catalog entries `auto-caption` (arg `layer_id` required, `language` optional) + `voiceover` (arg `script` required; `voice`/`speed`/`target_track_id` optional); `expand` handles both names.

- [ ] **Step 1: Recover the deleted prompt bodies for reference**

```bash
git show 97e3c7f2:apps/desktop/src-tauri/src/mcp/prompts.rs | sed -n '1,135p'    # consts, catalog entries
git show 97e3c7f2:apps/desktop/src-tauri/src/mcp/prompts.rs | sed -n '137,202p'  # expand_auto_caption + expand_voiceover
```

- [ ] **Step 2: Write the failing test**

Add to `prompts.rs` `#[cfg(test)] mod tests`:
```rust
    #[cfg(feature = "cloud")]
    #[test]
    fn catalog_includes_cloud_prompts() {
        let names: Vec<_> = catalog().into_iter().map(|p| p.name).collect();
        assert!(names.iter().any(|n| n == "auto-caption"));
        assert!(names.iter().any(|n| n == "voiceover"));
    }

    #[cfg(feature = "cloud")]
    #[test]
    fn voiceover_expands_with_script() {
        let a = args(&[("script", json!("hello there"))]);
        let r = expand("voiceover", Some(&a)).expect("expand voiceover");
        let body = message_text(&r.messages[0]);
        assert!(body.contains("hello there"));
    }
```

- [ ] **Step 3: Run to confirm it fails**

Run: `cd apps/desktop && cargo test --lib --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml catalog_includes_cloud_prompts voiceover_expands_with_script`
Expected: FAIL — `unknown prompt 'voiceover'`.

- [ ] **Step 4: Port the prompts**

Add the name consts (gated):
```rust
#[cfg(feature = "cloud")]
pub const NAME_AUTO_CAPTION: &str = "auto-caption";
#[cfg(feature = "cloud")]
pub const NAME_VOICEOVER: &str = "voiceover";
```
In `catalog()`, build the vec mutably and conditionally push the two cloud prompts. Replace the `vec![ PromptDef { cut-silences ... } ]` with:
```rust
pub(crate) fn catalog() -> Vec<PromptDef> {
    let mut prompts = vec![PromptDef {
        name: NAME_CUT_SILENCES.into(),
        // ... existing cut-silences PromptDef unchanged ...
    }];
    #[cfg(feature = "cloud")]
    {
        prompts.push(PromptDef {
            name: NAME_AUTO_CAPTION.into(),
            description: Some("<verbatim from old catalog>".into()),
            arguments: vec![
                PromptArgDef { name: "layer_id".into(), description: Some("...".into()), required: true },
                PromptArgDef { name: "language".into(), description: Some("...".into()), required: false },
            ],
        });
        prompts.push(PromptDef {
            name: NAME_VOICEOVER.into(),
            description: Some("<verbatim from old catalog>".into()),
            arguments: vec![
                PromptArgDef { name: "script".into(), description: Some("...".into()), required: true },
                PromptArgDef { name: "voice".into(), description: Some("...".into()), required: false },
                PromptArgDef { name: "speed".into(), description: Some("...".into()), required: false },
                PromptArgDef { name: "target_track_id".into(), description: Some("...".into()), required: false },
            ],
        });
    }
    prompts
}
```
(Fill the `description` strings + arg descriptions verbatim from the Step-1 recovery.)

In `expand()`, add gated arms before the `other =>`:
```rust
        #[cfg(feature = "cloud")]
        NAME_AUTO_CAPTION => expand_auto_caption(args),
        #[cfg(feature = "cloud")]
        NAME_VOICEOVER => expand_voiceover(args),
```
Add the two `#[cfg(feature = "cloud")] fn expand_auto_caption(...)` / `fn expand_voiceover(...)` functions, porting the old bodies: rmcp `GetPromptResult { description, messages: vec![PromptMessage { role: PromptMessageRole::User, content: PromptMessageContent::text(text) }] }` → `PromptResult { description: Some(...), messages: vec![PromptMessage { role: PromptRole::User, content: ContentBlock::Text { text } }] }`. Reuse the existing `require_str`/`optional_str` helpers. Update the module doc-comment's "dropped here and recoverable from git" note (they're back now) and the `expand` unknown-name available-list string.

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `cd apps/desktop && cargo test --lib --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml --  mcp::prompts`
Expected: PASS — including the existing cut-silences tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/prompts.rs
git commit -m "migrate(s4b): re-enable auto-caption + voiceover MCP prompts (cfg cloud)"
```

---

## Task 6: Electron main safeStorage + interception + e2e gate

The main-process half: persist/decrypt keys, push at startup, intercept the two write commands. Gated by an e2e that drives the renderer commands and a real MCP client.

**Files:**
- Create: `apps/desktop/electron/main/keys.ts`
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/e2e/electron/s4b-cloud-keys.spec.ts`

**Interfaces:**
- Consumes: `Backend.setCloudKey/clearCloudKey` (Task 1), the `settings_*` dispatch arms (Task 3), the cloud tools (Task 4).
- Produces: `cloud_keys.json` in userData; `set`/`clear` intercepts in `backend:invoke`; startup push.

- [ ] **Step 1: Create `electron/main/keys.ts`**

```ts
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const KEYS_FILE = () => path.join(app.getPath('userData'), 'cloud_keys.json')

/// On-disk shape: { "<provider>": "<base64(safeStorage.encryptString)>" }.
type Stored = Record<string, string>

function readStored(): Stored {
  try {
    const raw = fs.readFileSync(KEYS_FILE(), 'utf8')
    const obj = JSON.parse(raw) as Stored
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function writeStored(s: Stored): void {
  try {
    fs.writeFileSync(KEYS_FILE(), JSON.stringify(s), 'utf8')
  } catch {
    /* best-effort */
  }
}

/// Decrypt every stored key. A blob that fails to decrypt (OS backend rotated,
/// corrupt entry) is dropped from the file and skipped — never throws.
export function loadAllKeys(): Record<string, string> {
  const stored = readStored()
  const out: Record<string, string> = {}
  let mutated = false
  for (const [provider, b64] of Object.entries(stored)) {
    try {
      out[provider] = safeStorage.decryptString(Buffer.from(b64, 'base64'))
    } catch {
      delete stored[provider]
      mutated = true
    }
  }
  if (mutated) writeStored(stored)
  return out
}

/// Encrypt + persist one provider key. Trims; empty key is a no-op clear.
export function setKey(provider: string, key: string): void {
  const trimmed = (key ?? '').trim()
  const stored = readStored()
  if (!trimmed) {
    delete stored[provider]
  } else {
    stored[provider] = safeStorage.encryptString(trimmed).toString('base64')
  }
  writeStored(stored)
}

/// Remove one provider key (idempotent).
export function clearKey(provider: string): void {
  const stored = readStored()
  delete stored[provider]
  writeStored(stored)
}
```

- [ ] **Step 2: Wire it into `index.ts`**

Add the import near the other main imports:
```ts
import { loadAllKeys, setKey, clearKey } from './keys.js'
```
After `await backend.init()` (and the `console.log('[main] backend init OK')` line), push persisted keys:
```ts
  // Push any safeStorage-persisted cloud API keys into the backend cache so
  // reqwest providers + settings_test_provider see them without a renderer round-trip.
  for (const [provider, key] of Object.entries(loadAllKeys())) {
    backend.setCloudKey(provider, key)
  }
```
Replace the existing `backend:invoke` handler with one that intercepts the two key-write commands:
```ts
  ipcMain.handle('backend:invoke', async (_e, { channel, args }) => {
    // API-key writes need safeStorage (main-only) + a push into the backend
    // cache. Intercept here; status/test fall through to the Rust dispatcher.
    if (channel === 'settings_set_api_key') {
      const { provider, key } = (args ?? {}) as { provider: string; key: string }
      setKey(provider, key)
      backend!.setCloudKey(provider, (key ?? '').trim())
      return null
    }
    if (channel === 'settings_clear_api_key') {
      const { provider } = (args ?? {}) as { provider: string }
      clearKey(provider)
      backend!.clearCloudKey(provider)
      return null
    }
    const json = await backend!.invoke(channel, JSON.stringify(args ?? {}))
    return JSON.parse(json)
  })
```

- [ ] **Step 3: Flip the addon build to include `cloud`**

In `package.json`, change the `napi:build` script's feature list from `--features jobs,export,mcp` to `--features jobs,export,mcp,cloud`.

- [ ] **Step 4: Write the e2e gate**

Create `apps/desktop/e2e/electron/s4b-cloud-keys.spec.ts`:
```ts
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

interface Info { sse_url: string; bearer_token: string }
type Status = { provider: string; label: string; configured: boolean }

async function connect(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'e2e-s4b', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

test('S4b: safeStorage key round-trip + cloud tools advertised', async () => {
  const { app, page } = await launchApp()

  const invoke = (cmd: string, args: unknown) =>
    page.evaluate(([c, a]) => (window as any).api.invoke(c, a), [cmd, args] as const)

  // Clean slate.
  await invoke('settings_clear_api_key', { provider: 'openai' })

  // Set a dummy key → status flips to configured + cloud_keys.json holds an entry.
  await invoke('settings_set_api_key', { provider: 'openai', key: 'sk-test-dummy' })
  let status = (await invoke('settings_get_api_key_status', {})) as Status[]
  const openai = status.find((s) => s.provider === 'openai')!
  expect(openai.configured).toBe(true)

  const userData = (await app.evaluate(({ app }) => app.getPath('userData'))) as string
  const stored = (await app.evaluate(({}, ud) => {
    const fs = require('node:fs'); const path = require('node:path')
    return JSON.parse(fs.readFileSync(path.join(ud, 'cloud_keys.json'), 'utf8'))
  }, userData)) as Record<string, string>
  expect(typeof stored.openai).toBe('string')
  expect(stored.openai).not.toContain('sk-test-dummy') // encrypted, not plaintext

  // The cloud MCP tools are now advertised to an external client.
  const info = (await invoke('get_mcp_info', {})) as Info
  const client = await connect(info.sse_url, info.bearer_token)
  const names = (await client.listTools()).tools.map((t) => t.name)
  expect(names).toContain('transcribe_clip')
  expect(names).toContain('synthesize_speech')
  await client.close()

  // Clear → status flips back + entry gone.
  await invoke('settings_clear_api_key', { provider: 'openai' })
  status = (await invoke('settings_get_api_key_status', {})) as Status[]
  expect(status.find((s) => s.provider === 'openai')!.configured).toBe(false)
  const after = (await app.evaluate(({}, ud) => {
    const fs = require('node:fs'); const path = require('node:path')
    try { return JSON.parse(fs.readFileSync(path.join(ud, 'cloud_keys.json'), 'utf8')) } catch { return {} }
  }, userData)) as Record<string, string>
  expect(after.openai).toBeUndefined()

  await app.close()
})
```

- [ ] **Step 5: Build the addon + Electron, then run the gate RED→GREEN**

Build (the addon must be rebuilt with `cloud` so the cloud tools + napi setters ship):
```bash
cd apps/desktop && npm run napi:build && npm run electron:build
```
Run only the new spec:
```bash
cd apps/desktop && node node_modules/@playwright/test/cli.js test e2e/electron/s4b-cloud-keys.spec.ts
```
Expected: PASS. (If you ran it before Step 1–3 were built into the addon it would fail on `settings_get_api_key_status` being `unavailable` or the cloud tools missing — confirming the gate is genuine.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/keys.ts apps/desktop/electron/main/index.ts apps/desktop/package.json apps/desktop/e2e/electron/s4b-cloud-keys.spec.ts
git commit -m "migrate(s4b): safeStorage cloud-key persistence in main + push/intercept + e2e gate"
```

---

## Task 7: Full-suite gate + acceptance notes

Integration gate: the whole Rust suite + the whole Playwright suite, Tauri-free, plus an S4b-NOTES record.

**Files:**
- Create: `apps/desktop/electron/S4b-NOTES.md`

- [ ] **Step 1: Full Rust suite**

Run: `cd apps/desktop && cargo test --lib --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml`
Expected: all pass (≈486 + the S4b additions). Note the count.

- [ ] **Step 2: Confirm Tauri is absent + keyring is gone**

Run: `cd apps/desktop && cargo tree --manifest-path src-tauri/Cargo.toml --features jobs,export,mcp,cloud -i tauri ; cargo tree --manifest-path src-tauri/Cargo.toml --features jobs,export,mcp,cloud -i keyring`
Expected: both report "package ID not found" (neither is in the graph).

- [ ] **Step 3: Full Playwright-for-Electron suite**

Build then run the whole electron e2e dir:
```bash
cd apps/desktop && $env:VITE_WEFTCUT_E2E='1'; npm run napi:build && npm run electron:build
cd apps/desktop && node node_modules/@playwright/test/cli.js test e2e/electron
```
Expected: the full suite (s2-smoke, s3a*, s3b-fs, conformance, export_*, s4a-mcp, s4b-cloud-keys) green. Note the pass count.

- [ ] **Step 4: Write `electron/S4b-NOTES.md`**

Record: feature set is now `jobs,export,mcp,cloud`; key storage = safeStorage `cloud_keys.json` (encrypted) → push into `Backend.cloud_keys`; `keyring` dropped; cloud tools/prompts back under `cfg(cloud)`; the Rust + Playwright pass counts from Steps 1 & 3; the explicit deferral of `ConnectAgentPanel.tsx` (post-S5 UI-gap pass); the Linux `safeStorage` `basic_text` fallback caveat (S6); and the S6 packaging carry (bundle express + `@modelcontextprotocol/sdk`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/S4b-NOTES.md
git commit -m "migrate(s4b): acceptance notes — full suite green, Tauri/keyring-free"
```

---

## Self-Review notes (for the executor)

- **Lock-before-await discipline:** every place that reads `b.cloud_keys` and then `.await`s (transcribe/synthesize tool bodies, `settings_test_provider`) MUST scope the `MutexGuard` in a block and drop it before the await — `std::sync::MutexGuard` is not `Send`. The provided snippets already do this; preserve it when porting.
- **`cloud_keys` is `pub(crate)`** so `commands/cloud.rs` and `mcp/tools.rs` can lock it directly. Keep it `pub(crate)`, never `pub` (no napi getter for key material).
- **Catalog/prompt feature gating** rides the existing `#[cfg(feature="cloud")]`-on-table-entry support (`detect_silences`/`import_media` already prove it for `jobs`).
- **No `settings_set/clear_api_key` Rust dispatch arms** — they are main-intercepted only. If you find yourself porting their old keyring bodies, stop: they're replaced by `keys.ts` + the napi setters.
