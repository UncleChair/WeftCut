# S4b — Cloud Key Storage Migration: Acceptance Notes

## What ships in S4b

### Feature set

S4b extends the Rust feature set to `jobs,export,mcp,cloud`.  The `cloud` feature gate is new; it activates:

- `napi_backend.rs` cloud-key setters (`set_cloud_key`, `clear_cloud_key`)
- `settings_test_provider` / `settings_get_api_key_status` Rust arms
- `mcp/catalog.rs` — `transcribe_clip` and `synthesize_speech` tool entries
- `mcp/prompts.rs` — `auto-caption` and `voiceover` prompts

### Key storage: safeStorage + `cloud_keys.json` (push model)

`keyring` is **removed** from `Cargo.toml`.  Cloud API keys are now stored by Electron main via Chromium `safeStorage` (OS-credential-store-backed AES encryption on Windows/macOS; `basic_text` plaintext fallback on Linux — see caveat below):

- `apps/desktop/electron/main/keys.ts` — `loadKeys()` / `saveKeys()` manage a `cloud_keys.json` file in `app.getPath('userData')`; values are `safeStorage.encryptString` / `decryptString` round-tripped.
- On app boot and after every `set_api_key` / `clear_api_key` IPC call, Electron main calls `backend.setCloudKeys(json)` to push the decrypted key map into `Backend.cloud_keys` (a `Mutex<HashMap<String,String>>`).
- Rust never touches the filesystem for key storage; it only reads from `cloud_keys` at tool-call time.
- The napi getter for `cloud_keys` is deliberately absent — key material never flows back to the renderer.

### Cloud MCP tools (`cfg(cloud)`)

`transcribe_clip` and `synthesize_speech` are re-added to the MCP catalog and dispatch under `#[cfg(feature="cloud")]`.  Tool bodies follow the lock-before-await discipline: the `MutexGuard` over `cloud_keys` is scoped and dropped before every `.await` point so the guard is never held across an async boundary.

### Cloud prompts (`cfg(cloud)`)

`auto-caption` and `voiceover` prompts are re-added to `mcp/prompts.rs` under `#[cfg(feature="cloud")]`.

### Settings status / test arms

`settings_get_api_key_status` and `settings_test_provider` Rust dispatch arms are restored under `#[cfg(feature="cloud")]`.  `settings_test_provider` follows the same lock-before-await discipline as the tool bodies.

---

## Test evidence

### Cargo lib tests (`--features jobs,export,mcp,cloud`)

Command:
```
cd apps/desktop
cargo test --lib --features jobs,export,mcp,cloud --manifest-path src-tauri/Cargo.toml
```

Result: **530 passed; 0 failed** (finished in 1.68s)

### Tauri / keyring dependency audit

```
cd apps/desktop
cargo tree --manifest-path src-tauri/Cargo.toml --features jobs,export,mcp,cloud -i tauri
cargo tree --manifest-path src-tauri/Cargo.toml --features jobs,export,mcp,cloud -i keyring
```

Both commands return `error: package ID specification '<name>' did not match any packages` — confirming neither `tauri` nor `keyring` appears anywhere in the dependency graph.

### Playwright e2e (full suite)

Command:
```
cd apps/desktop
node <root>/node_modules/@playwright/test/cli.js test e2e/electron
```

Result: **16 passed; 0 failed** (2m 36s, 1 worker)

Specs executed:

| Spec | Result |
|---|---|
| `s2-smoke.spec.ts` | ✓ pass |
| `s3a-handlers.spec.ts` | ✓ pass |
| `s3a-import.spec.ts` | ✓ pass |
| `s3a-protocol.spec.ts` | ✓ pass |
| `s3a-window-visible.spec.ts` | ✓ pass |
| `s3b-fs.spec.ts` | ✓ pass |
| `s4a-mcp.spec.ts` | ✓ pass |
| `s4b-cloud-keys.spec.ts` | ✓ pass |
| `conformance.spec.ts` | ✓ pass |
| `export_codecs.spec.ts` (3 cases) | ✓ pass |
| `export_eos_tail.spec.ts` | ✓ pass |
| `export_overlap_same_source.spec.ts` (3 cases) | ✓ pass |

All fixture-dependent specs (`conformance`, `export_codecs`, `export_eos_tail`, `export_overlap_same_source`) ran against committed fixtures in `e2e/fixtures/media/` and passed.

---

## Deferred follow-ups

### ConnectAgentPanel UI (post-S5, deliberate UI-gap pass)

`ConnectAgentPanel.tsx` still surfaces SSE-shaped snippets and reads the old `McpInfoView.sse_url` / `events_url` fields (carried forward from S4a).  This is a **deliberate deferral**:

1. The interim bridge — the `[mcp] connect:` startup log line — provides a copy-pasteable streamable-HTTP config for agent clients until the panel is reworked.
2. The rework (retire `sse_url`/`events_url`, single `url` field, updated locale strings) is scheduled as a post-S5 UI-gap pass so it lands together with the motif-tool surface and any other panel touches.

### Linux safeStorage caveat (S6)

On Linux, `safeStorage.isEncryptionAvailable()` returns `false` in environments without a desktop keyring (headless CI, minimal containers).  Electron falls back to `basic_text` in that case, storing key material in plaintext in `cloud_keys.json`.  Mitigation options for S6:

- Document the caveat and require users to secure the `userData` directory themselves.
- Add a startup warning when `isEncryptionAvailable()` is false.
- Consider `libsecret` / `kwallet` detection and explicit failure rather than silent fallback.

### S6 packaging carry

`electron-builder` must include the following npm packages in the app bundle:

- `express` (the MCP HTTP server, already a production dependency)
- `@modelcontextprotocol/sdk` (MCP session transport, already a production dependency)

Both are listed in `dependencies` (not `devDependencies`) in `package.json`.  Confirm that `electron-builder`'s `files` / `asar` configuration does not exclude them, and that any native sub-deps (if added later) are either pre-built or rebuilt at package time.

### S5 — Motif tools

- `list_motifs`, `install_motif`, and related tools + `motifs://current` resource + `preview_motif_draft` against the new `Backend` motif handle.

---

## Known carry-forward items (from S4a)

1. **Stale-session transport leak** — unchanged from S4a.  Non-exploitable on localhost behind the bearer gate; canonical fix is to guard `!sid && isInitializeRequest(req.body)` before creating a new transport pair.

2. **Non-constant-time bearer compare** — unchanged from S4a.  No meaningful attack surface for a 256-bit localhost token; `crypto.timingSafeEqual` is the correct form if the server ever becomes network-exposed.
