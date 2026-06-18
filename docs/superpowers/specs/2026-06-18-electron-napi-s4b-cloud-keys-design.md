# S4b — API-key storage (safeStorage) + re-enabled cloud surface

Stage S4b of the Tauri→Electron+napi-rs migration (branch `migration/electron-napi`).
Companion to `2026-06-18-s4a-mcp-server-design.md`. Closes S4: S4a moved the MCP
server to the TS SDK and **deliberately deleted the cloud tools/prompts, parking
them for S4b**; S4b restores them on top of a new key-storage substrate.

## Goal

1. Replace the Rust `keyring` crate with Electron **`safeStorage`** for cloud
   API-key persistence (the master-plan S4 exit: "API-key storage → `safeStorage`;
   cloud HTTP stays Rust (reqwest)").
2. Restore the four `settings_*` key commands the renderer already calls.
3. Re-enable the cloud MCP surface deleted in S4a: tools `transcribe_clip` /
   `synthesize_speech` and prompts auto-caption / voiceover, behind
   `#[cfg(feature = "cloud")]`.

## Non-goals (explicitly deferred)

- **`ConnectAgentPanel.tsx` rework.** It still reads the removed `McpInfoView.sse_url`
  and renders SSE-shaped connect snippets; the server is now streamable-HTTP.
  Fixing it edits `src/**` renderer business logic, which the migration's global
  constraint forbids. **Deferred to the post-S5 UI-gap pass (at or before S6),** per
  the user. S4b does not touch it.
- Adding new providers (Deepgram/ElevenLabs). The provider-agnostic trait surface
  is preserved; OpenAI stays the only v1 provider.
- Real cloud network calls in CI. Live provider tests stay `#[ignore]`.

## Background — current state

- `cloud/keys.rs` persists keys via `keyring = "3"` (Windows Credential Manager /
  macOS Keychain / Linux Secret Service). `keyring::Entry` is read **synchronously**
  by the providers (`OpenAiWhisper::new()` etc.) when a cloud call runs.
- The `cloud` cargo feature exists but is empty/OFF; `mod cloud` is `#[cfg(feature="cloud")]`.
  Its `audio_extract.rs` does `use crate::jobs;` + `jobs::ffmpeg_sem()`, so **`cloud`
  requires `jobs`**.
- The renderer (`src/ipc/index.ts`, frozen) calls four commands:
  | command | args | returns |
  |---|---|---|
  | `settings_get_api_key_status` | — | `ApiKeyStatus[]` = `{provider, label, configured}` |
  | `settings_set_api_key` | `{provider, key}` | void |
  | `settings_clear_api_key` | `{provider}` | void |
  | `settings_test_provider` | `{provider}` | `ConnectionTestInfo` = `{provider, summary}` |
- The preload routes all four (unprefixed) through `backend:invoke` → the Rust
  dispatcher. `safeStorage` is a **main-process-only** API.
- The pre-S4a tool bodies live in git: recover the cloud tools/prompts from the
  `mcp/mod.rs` blob before S4a's `c7fbb9a0`; the gated command bodies (set/clear/
  status/test) from `4a0dda90:apps/desktop/src-tauri/src/commands.rs`.

## Architecture — `safeStorage` in main + push-model into a Rust in-memory cache

The split that matters: **main owns persistence + encryption; Rust owns a plaintext
in-memory cache that `reqwest` reads synchronously.** Keys flow one way (main → Rust),
pushed at startup and on every change. No per-request boundary crossing; no pull
callback from Rust into Node.

```
renderer ── invoke("settings_set_api_key",{provider,key})
   │
   ▼ window.api.invoke → ipcRenderer.invoke("backend:invoke",{channel,args})
main: backend:invoke handler
   ├─ channel === settings_set_api_key  ─┐  (intercept — NOT forwarded to backend.invoke)
   │     keys.ts: safeStorage.encryptString → cloud_keys.json
   │     backend.setCloudKey(provider, key)   ──────────────┐
   │     return                                              │
   ├─ channel === settings_clear_api_key ─┐                  │
   │     keys.ts: delete entry, rewrite cloud_keys.json      │
   │     backend.clearCloudKey(provider)   ──────────────────┤
   │     return                                              ▼
   └─ else → backend.invoke(channel,args)        Backend.cloud_keys: Mutex<HashMap<String,String>>
                                                  (plaintext, in-memory, process-lifetime)
startup (after backend.init()):
   keys.ts: read cloud_keys.json, decrypt each → backend.setCloudKey(p,k) for each

settings_get_api_key_status / settings_test_provider:  Rust dispatch arms (read the cache)
cloud tools (transcribe_clip / synthesize_speech):     read the cache via cloud::pick_*(&Backend)
```

### Components

**1. `electron/main/keys.ts` (new)** — mirrors `mcp/auth.ts`.
- `cloud_keys.json` in `app.getPath('userData')`, shape `{ "<provider>": "<base64(encryptedBuffer)>" }`.
- `loadAllKeys(): Record<string,string>` — read file, `safeStorage.decryptString(Buffer.from(b64,'base64'))` per entry; on decrypt failure (OS backend changed) drop that entry and rewrite. Returns plaintext map.
- `setKey(provider, key)` — `safeStorage.encryptString(key).toString('base64')`, merge into file.
- `clearKey(provider)` — delete entry, rewrite (idempotent).
- All calls happen after `app.whenReady()` (we already run inside `whenReady`). Linux without a keyring backend → `safeStorage` falls back to `basic_text` (plaintext) with an Electron warning; accepted, flagged as an S6 cross-platform concern.

**2. `electron/main/index.ts` (edit)** — two touch points:
- In the existing `backend:invoke` handler, intercept the two **write** commands before forwarding (read commands fall through unchanged):
  ```ts
  if (channel === 'settings_set_api_key') {
    setKey(args.provider, args.key); await backend!.setCloudKey(args.provider, args.key); return null
  }
  if (channel === 'settings_clear_api_key') {
    clearKey(args.provider); await backend!.clearCloudKey(args.provider); return null
  }
  ```
- After `await backend.init()`: `for (const [p,k] of Object.entries(loadAllKeys())) await backend.setCloudKey(p,k)`.

**3. `Backend` (Rust, `napi_backend.rs`) — the cache + two napi methods.**
- New always-compiled field `cloud_keys: Arc<Mutex<HashMap<String, String>>>` (keyed by provider **tag string**, e.g. `"openai"` — so the field does not depend on the `cfg(cloud)` `Provider` type and stays compilable with `cloud` off).
- Two always-compiled `#[napi]` methods `set_cloud_key(provider: String, key: String)` and `clear_cloud_key(provider: String)` that lock + insert/remove. Always-compiled ⇒ no `#[cfg]` on a method inside the `#[napi] impl` (avoids the S4a linker-error trap) and main can call them unconditionally. They are **not** renderer-`invoke` arms — the plaintext-injection surface stays off the webview, matching the `mcp_*` methods.

**4. `cloud/keys.rs` (edit)** — drop `keyring`.
- Keep `Provider` (enum, `as_str`/`label`/`all`/`capabilities`) and `Capabilities` verbatim — that metadata is unchanged.
- Remove `entry()`, `set_key`, `get_key`, `has_key`, `clear_key` (all keyring-backed) and the `keyring` import.
- Add cache-reading helpers that take the map: `has_key(keys: &HashMap<String,String>, p: Provider) -> bool`, `get_key(keys: &HashMap<String,String>, p: Provider) -> Option<String>`. (The cache lives on `Backend`; these are pure lookups by `p.as_str()`.)

**5. `cloud/mod.rs` + `cloud/providers/openai.rs` (edit)** — invert the key flow so the
cloud module never fetches secrets itself:
- `pick_transcriber` / `pick_synthesizer` take the cache map `&HashMap<String,String>`
  and consult it (instead of `keys::has_key()` hitting the OS). The caller (an MCP
  tool handler or the `settings_test_provider` arm, both holding `&Backend`) locks
  `b.cloud_keys`, clones the needed entry, and passes the map/key in.
- Providers are **constructed with the key**: `OpenAiWhisper::new(key)` /
  `OpenAiTts::new(key)` / `test_connection(key)` take the plaintext key as a param
  rather than reading `keys::get_key()` internally. This is the only change that
  removes the last keyring read-site.
- Drop the rmcp-era "deferred list_tools filtering" doc-comment (the SDK now filters
  by feature-gated catalog entries).

**6. `mcp/catalog.rs` + `mcp/tools.rs` + `mcp/prompts.rs` (edit)** — re-add under `#[cfg(feature="cloud")]`:
- catalog `tool_table!`: `transcribe_clip` and `synthesize_speech` entries (the macro already supports per-entry `#[cfg]`, as `detect_silences`/`import_media` show). Handlers `tools::transcribe_clip` / `tools::synthesize_speech`, arg structs + descriptions recovered verbatim from the pre-S4a blob.
- `tools.rs`: the two handler fns (`&Backend` async fns returning `ToolResult`), reading keys from the cache via `cloud::pick_*`.
- `prompts.rs`: the auto-caption + voiceover prompt definitions.

**7. `lib.rs` dispatcher (edit)** — add `#[cfg(feature="cloud")]` dispatch arms for `settings_get_api_key_status` (walks `Provider::all`, reports `configured` from the cache + `label`) and `settings_test_provider` (cache key + live `reqwest` smoke check). With `cloud` OFF these names hit the existing "unavailable" fallback (renderer catches gracefully). Bodies recovered from the `commands.rs` blob, rewired to the cache.

**8. Build (edit)** — `cloud = ["jobs"]` in `Cargo.toml`. Build/test become
`napi:build --features jobs,export,mcp,cloud` / `cargo test --lib --features jobs,export,mcp,cloud`.
Drop `keyring` from `[dependencies]`.

## Data flow summary

- **Set:** renderer → main intercept → encrypt+persist (`cloud_keys.json`) → `backend.setCloudKey` → cache.
- **Clear:** renderer → main intercept → delete+rewrite → `backend.clearCloudKey` → cache.
- **Status:** renderer → `backend.invoke("settings_get_api_key_status")` → reads cache, returns per-provider `{provider,label,configured}`.
- **Test:** renderer → `backend.invoke("settings_test_provider",{provider})` → cache key → `reqwest` `/v1/models` → `{provider,summary}` or structured `CloudError`.
- **Startup:** main decrypts `cloud_keys.json` → pushes each into the cache after `init()`.
- **Tool call (agent):** MCP client → main → `backend.mcp_call_tool("transcribe_clip",…)` → `cloud::pick_transcriber(&Backend)` reads cache → `reqwest`.

## Error handling

- `safeStorage` decrypt failure (OS backend rotated / corrupt file): drop the entry, rewrite the file, treat as "no key configured" — never crash startup.
- Missing key at call time: providers/`pick_*` return `None` → tools surface the existing structured `CloudError::MissingKey` ("configure an API key in Settings"); `settings_test_provider` returns `MissingKey` (not a misleading "test failed").
- Corrupt/absent `cloud_keys.json`: treated as empty (same best-effort try/catch as `mcp/auth.ts`).

## Testing / parity oracle

- **Rust (`--features jobs,export,mcp,cloud`):**
  - in-memory cache round-trip on `Backend` (set → get/has → clear).
  - `cloud::pick_transcriber/pick_synthesizer` return `Some` iff the cache has an OpenAI key; `None` when empty.
  - `catalog()` advertises `transcribe_clip` + `synthesize_speech` when `cloud` is on; the existing `mcp_catalog_property_schemas_are_objects` guard still passes.
  - existing cloud provider/SRT/audio-extract unit tests compile and pass under the feature; live-network tests stay `#[ignore]`.
- **e2e (Playwright-for-Electron):** a new spec that
  - drives `settings_set_api_key` for `openai` with a dummy key → asserts `cloud_keys.json` exists in userData and `settings_get_api_key_status` shows `configured:true`; then `settings_clear_api_key` → `configured:false` and the file entry is gone.
  - via a real MCP SDK client (reuse the `s4a-mcp` harness), asserts `listTools` now includes `transcribe_clip` and `synthesize_speech`.
  - **No real OpenAI call.** `settings_test_provider` against a dummy key is asserted only to reject with the structured error (not to succeed).
- The whole prior suite (s2-smoke, s3*, s4a-mcp) must stay green; Tauri stays absent from the dep graph.

## Open items / S6 carry

- `safeStorage` Linux `basic_text` fallback (no keyring backend) → plaintext on disk; revisit in the S6 cross-platform pass.
- Packaging: no new bundled JS dep (safeStorage is built into Electron) — S6 carry unchanged from S4a (express + `@modelcontextprotocol/sdk`).
- `ConnectAgentPanel.tsx` streamable rework remains the tracked UI-gap follow-up (post-S5, at/before S6).
