# S5 — Motif capture on Electron — design

> Stage S5 of the Tauri → Electron + napi-rs migration (`migration/electron-napi`).
> Master plan: `docs/superpowers/plans/2026-06-17-electron-napi-migration.md` (S5 row).
> Prior stages: S1 shell · S2 state core · S3a/b media+jobs+export · S4a MCP server · S4b safeStorage keys.

## Goal

Bring the full Motif subsystem online under Electron: place/preview a Motif deterministically, export with Motifs (the "preparing" bake), and the complete authoring + cross-project lifecycle the frozen renderer already calls. The Tauri Motifs feature (Plan 1–4) is shipped on `origin/main`; S5 ports it to the Electron shell **without editing `src/**`**.

## The core architectural inversion

In Tauri, **Rust drives CDP** against the hidden WebView2 host (`webview2-com` / `ICoreWebView2::CallDevToolsProtocolMethod` / `with_webview`). Electron exposes no such Rust hook — CDP is driven from the **main process (JS)** via `webContents.debugger`. So the capture *driver* moves to JS main; the Motif *brain* (catalog / store / authoring / staleness / watcher) stays in Rust behind napi.

```
            Tauri (current)                              Electron (S5)
  renderer ──invoke("motif_capture_frame")──> renderer ──invoke──> preload ─backend:invoke─> MAIN
       │                                                                        │ intercept (S4b key pattern)
  Rust commands.rs::capture_motif_frame_b64                       electron/main/motif/capture.ts
       │  ensure_host (WebView2 window)                              offscreen BrowserWindow
       │  cdp.rs eval_await / capture_png_base64                    webContents.debugger CDP
       └─ builtin.rs handle_request (motif: scheme)                 protocol.handle('motif', …)
                                                                        │ bytes from →
  Rust brain (catalog/store/authoring/staleness/watcher) ───── unchanged, via napi ────┘
```

The PoC (`apps/desktop/poc/electron-napi/`) validated the JS capture path: an offscreen `BrowserWindow` + `webContents.debugger` `Page.captureScreenshot` is **byte-deterministic in GPU mode** (maxChannelDiff 0), ~70 ms/frame, transparent backdrop intact — no software rendering and no separate capture process needed.

## Renderer surface (frozen — must all be satisfied)

`src/**` is out of scope. The renderer hard-calls, via the `@tauri-apps/api/core` → `electron-compat` shim:

- **Capture / runtime:** `motif_register_runtime` (boot, `src/main.tsx`), `motif_capture_frame` (`src/render/motifs/host.ts`).
- **Brain (state + authoring):** `list_motifs`, `add_motif`, `get_motif_source`, `write_motif_draft`, `amend_motif_draft`, `create_edit_draft`, `install_motif`, `delete_motif`, `import_motif`, `motif_staleness_report`, `acknowledge_motif_staleness`.
- **Events:** `motifs:changed` (file-watch + lifecycle resync), `project:changed` (already bridged in S2).

`rebind_motif` is an actor command invoked *internally* by `install_motif` (Update mode) — not a renderer or MCP entry point.

## Rust changes

### Delete (WebView2 / Tauri-specific)

- `motifs/cdp.rs` — entirely. `CallDevToolsProtocolMethod`/`webview2-com` is WebView2-only.
- `motifs/host.rs` — entirely. Tauri `WebviewWindowBuilder` host window.
- `motifs/commands.rs` — the `motif_capture_frame` `#[tauri::command]` + the `capture_motif_frame_b64` orchestration (re-expressed in JS, §JS main). Preserve the *logic* of `resolve_capture_duration` by re-exposing it (see new napi methods).
- `motifs/mod.rs` — drop `MotifRuntime`, `MotifCapture`, `CaptureState`, `should_probe`/`should_set_metrics`, and the `motif_register_runtime` command. These are capture-state and move to JS.
- `builtin.rs::handle_request` (the Tauri `register_uri_scheme_protocol` handler). **Keep** `lookup`, `resolve_bytes`, `content_type_for`, `csp`, `parse_path` — re-exposed via napi.

The `webview2-com` / `windows` / `tauri` deps used only by the capture path leave the `motifs` graph. (The crate is already Tauri-free since S2; this removes the last gated-but-Tauri-referencing modules so the `motifs` feature compiles on the napi cdylib.)

### Keep + un-gate + port to `&Backend` dispatch arms

Add a `motifs` cargo feature; build becomes `napi:build --features jobs,export,mcp,cloud,motifs`. Un-gate `authoring.rs`, `authoring_commands.rs`, `store.rs`, `staleness.rs`, `watcher.rs`, `catalog.rs`, and the bytes-resolution half of `builtin.rs`. (The `#[cfg(not(feature="motifs"))] mod motifs { pub mod catalog; }` shim in `lib.rs` is replaced by the real module under the feature.)

Port the `#[tauri::command]` fns to `&Backend` async fns wired into the `napi_backend.rs` dispatcher (the S3/S4 mechanical pattern — the `*_core` fns already take plain refs: `write_motif_draft_core`, `install_motif_core`, `create_edit_draft_core`, `import_motif_from_source`, `amend_draft_html`, `build_rebind_updates`). Arg structs are `#[serde(rename_all="camelCase")]` `*Args` deserialized from the dispatcher's `argsJson`.

Dispatch arms added (all `#[cfg(feature="motifs")]`): `list_motifs`, `add_motif`, `get_motif_source`, `write_motif_draft`, `amend_motif_draft`, `create_edit_draft`, `install_motif`, `delete_motif`, `import_motif`, `motif_staleness_report`, `acknowledge_motif_staleness`.

- **`emit_motifs_changed(app: &AppHandle)`** (uses `tauri::Emitter`) → `Backend` emits `self.events.emit("motifs:changed", serde_json::json!({}))`. Every mutating arm (write/amend/install/delete/import/create_edit + the watcher + acknowledge) fires it, matching the Tauri behavior the UI relies on (UI-actor-bridge principle).
- **Backend gains** `pub(crate) motif_store: UserMotifStore` (rooted at `<config_dir>/motifs/`, built in `build_backend`) and a kept-alive watcher handle (`OnceLock<MotifWatcher>` set in `init`).
- `install_motif` Update mode needs `ProjectHandle` (already a `Backend` field) for `rebind_motif` — same as the Tauri command's `State<ProjectHandle>`.

### Watcher (stays Rust)

`watcher.rs` (`notify` crate, recursive watch of `<config_dir>/motifs/` with the existing hand-rolled 400 ms debounce) is spawned in `Backend::init` and emits **`motifs:changed`** via `EventSink` → the S2 bridge → `webContents.send('evt:motifs:changed')`. The renderer's whole resync pipeline (syncCatalog → content_hash cache key → host `?v=` buster → sprite refresh) is reused with **zero TS change**. The `AppHandle` it took for emitting becomes `Arc<dyn EventSink>`.

### New dedicated napi methods (main calls them, not the renderer)

These are `#[napi]` methods on `Backend` in a `#[cfg(feature="motifs")]` impl block (the S4a linker-trap workaround: cfg-gated napi methods go in a separate impl block, not inline in an existing `#[napi] impl`). They are NOT renderer-`invoke` arms — main calls them directly, keeping the capture orchestration in main.

- `motif_resolve_file(id: String, rest: String) -> Option<MotifFile>` where `MotifFile { bytes: Buffer, content_type: String }` — backs `protocol.handle('motif')`. Reuses `resolve_bytes` (embedded built-ins first, then `UserMotifStore`) + `content_type_for`. Returns `None` for an unknown file (main → 404). The CSP header is a constant string set in main, identical to Tauri's `builtin::csp()`: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: motif:; font-src data: motif:` (a constant, so no napi round-trip).
- `motif_ctx_duration_s(id: String, props_json: String) -> f64` — backs the capture `meta.duration`. The renderer's `host.ts` shim can't pass it and `src/**` is frozen, so main resolves it. Reuses `resolve_capture_duration` precedence (content_duration_s → max_duration_prop value → max_duration_s → default 5.0), built-ins-first (no disk walk for built-ins).

### MCP motif tools (S4a deferred these to S5)

Re-add the **brain** tools to the Rust `mcp/catalog.rs` `tool_table!` (single-sourcing `tool_catalog()` + `dispatch_tool()`): `list_motifs`, `add_motif`, `get_motif_source`, `write_motif_draft` (`{ from }`), `install_motif` (`{ mode: "new"|"update" }`), `delete_motif`. Bodies are `&Backend` async fns calling the same cores as the renderer arms (so the two surfaces can't drift). `list_motifs` / the `motifs://current` resource strip `html` (manifest-only for agents; the picker keeps html). Recover bodies + descriptions from the pre-S4a `mcp/mod.rs` blob, transformed to the transport-free `tools.rs` shape.

`preview_motif_draft` (base64 PNG via capture) **cannot** be a pure Rust tool — capture lives in JS. Its schema is listed by the Rust catalog (so `listTools` shows it), but it is **special-cased in the JS MCP server** (`electron/main/mcp/server.ts`, `CallToolRequestSchema`): if `req.params.name === 'preview_motif_draft'`, call the shared JS capture orchestrator and return the image content; else `backend.mcpCallTool`. The Rust `dispatch_tool` arm for `preview_motif_draft` returns a clear "handled by host" error (never reached because the server intercepts first), so the catalog stays the single schema source.

## JS main changes (`electron/main/`)

### Scheme + protocol

- `protocol.registerSchemesAsPrivileged([{ scheme: 'motif', privileges: { standard: true, secure: true, supportFetchAPI: true } }])` (mirrors `weftcut-media`; before `app.whenReady`). `standard:true` gives `motif://<id>/…` proper origin semantics so same-origin assets + CSP behave; `secure:true` lets it host fonts.
- `protocol.handle('motif', async (req) => …)`: parse `motif://<id>/<rest>` (default `index.html`), call `backend.motifResolveFile(id, rest)`; 404 on `None`; else `new Response(bytes, { headers: { 'Content-Type': contentType, 'Content-Security-Policy': csp } })`. No caching headers (the host reloads each id; `?v=` query is ignored by resolution).

### `electron/main/motif/capture.ts` — the orchestrator

Ported from the proven PoC `capture.ts` + the Tauri `capture_motif_frame_b64` semantics, single source for both the renderer capture path and the MCP `preview_motif_draft` tool.

- **Host:** one reused offscreen `BrowserWindow` (`webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }`, no preload). Init order (PoC + master-plan gotcha): `loadURL('about:blank')` → `debugger.attach('1.3')` → `Page.enable` → `Runtime.enable` → `Page.addScriptToEvaluateOnNewDocument({ source: runtimeSource })` → `loadURL('motif://<id>/index.html?v=<hash>')`.
- **`ensureHost(motifId, contentHash, w, h)`** mirrors Rust `ensure_host`: reuse when the loaded URL's id AND `?v=` match; else navigate (re-`addScriptToEvaluateOnNewDocument` is automatic per document via the registered script) and signal reset. Returns `{ send, needsReset }`.
- **Ready-probe** mirrors Rust: bounded retry of `typeof window.__motifRender==='function' && document.readyState==='complete' && location.pathname.indexOf('/<id>/')===0` (the pathname guard closes the navigate→stale-page race). Skipped when warm (`readyFor === id`).
- **`CaptureState`** (`lastSize`, `readyFor`) re-implemented in JS; `setDeviceMetricsOverride` + `setDefaultBackgroundColorOverride { a:0 }` issued once per host/size (skip-when-warm).
- **Render + capture:** `Runtime.evaluate(window.__motifRender(t, props, meta), { awaitPromise:true })` where `meta = { duration: await backend.motifCtxDurationS(id, propsJson), width, height, fps:30, settleRafs }`; then `Page.captureScreenshot({ format:'png' })` → base64. **Debugger-only** — no paint fallback; a screenshot failure errors (preserves determinism + transparency).
- **Serialization:** a promise-chain mutex (`let chain = chain.then(() => doCapture())`) serializes all captures (on-demand sprite / prewarmer / baker / MCP) on the one host, replacing the Rust `tokio::Mutex`. Guards `CaptureState`.
- **Wedge recovery:** a capture/eval timeout tears down the host (`win.destroy()`) and resets state; the next call rebuilds.

### Interception in `backend:invoke` (S4b key pattern)

In `electron/main/index.ts`, before the `backend.invoke` fall-through:

- `motif_register_runtime` → store `args.source` in a module-scoped `runtimeSource` (used by `ensureHost`'s `addScriptToEvaluateOnNewDocument`). Return early. If a capture arrives before registration, error clearly (matches the Tauri "runtime not registered" path).
- `motif_capture_frame` → `{ motifId, tSec, propsJson, width, height, settleRafs, contentHash }` → run the orchestrator → return the base64 PNG string. Return early.

All other `motif_*` channels fall through to `backend.invoke` (the Rust brain).

## Testing

- **Rust unit tests** un-gated under `--features … motifs` (catalog / authoring / store / staleness / watcher / builtin bytes-resolution). The deleted capture modules' tests go with them.
- **Playwright-for-Electron specs** (the parity oracle), built with the `motifs` feature, mirroring the wdio `e2e/specs/motif/` gates:
  - `s5-motif-capture` — determinism (same inputs → identical PNG within Electron; the PoC showed byte-identical), transparent backdrop, ready/navigate across two built-in ids.
  - `s5-motif-preview` — place a `countdown`/`lower-third` layer, capture through the live CDP producer into the Pixi canvas (accent-pixel assert, mirroring `motif_live_preview`).
  - `s5-motif-export` — export-with-Motif: starting → preparing → progress → complete, self-SSIM proves the Motif animates in the exported frames.
  - `s5-motif-lifecycle` — write_draft → install(new) → list status → delete; and staleness/filewatch (disk-placed renders; version bump → `motif_staleness_report` non-empty → acknowledge), via a `motifReopenProject`-style hook.
- **MCP:** extend `s4a-mcp` (or a new `s5-mcp-motif`) — `listTools` includes the motif tools incl. `preview_motif_draft`; `add_motif` parity; `preview_motif_draft` returns image content via the JS capture path.
- Parity vs Tauri is **perceptual** (different engine); byte-determinism is asserted *within* Electron.

## Constraints & gotchas (carried)

- **`src/**` frozen** — only `electron/**`, `src/electron-compat/**`, configs, and `src-tauri/**` (the napi crate) are editable. The renderer keeps calling `motif_capture_frame` / `motif_register_runtime` verbatim.
- **napi cfg-on-method linker trap** (S4a): the two new `#[napi]` motif methods go in a *separate* `#[cfg(feature="motifs")] #[napi] impl Backend` block.
- **Capture-init order** (master plan): about:blank-first, then attach, then enable, then add-script, then navigate — CDP enable hangs on a fresh offscreen window otherwise.
- **Host-page cache** (`reference-motif-capture-host-page-cache`): the `?v=<content_hash>` URL buster is mandatory — a draft edit busts the frame cache but the host reuses the loaded page on id match unless the `v` query changes.
- **Determinism gotchas** (`reference-motif-capture-determinism`): keep `runtime.ts seek()` pure re-seekable; assert *perceptual* determinism for cross-run, byte-determinism only for same-run re-seek.
- **Dual-manifest** (Motifs program): a built-in needs BOTH the Rust `src-tauri/.../motifs/catalog/<id>/` and the TS `src/render/motifs/builtin/<id>/` manifest — unchanged by S5 (no new built-ins).
- **wdio `--spec` / Windows** carried into the Playwright migration: invoke the runner directly, verify the spec count.

## Non-goals

- Editing `src/**` renderer business logic.
- Cross-platform capture (macOS/Linux offscreen CDP) — S6, with the determinism negative control.
- New Motifs features or new built-ins. S5 is a port.
- `ConnectAgentPanel.tsx` streamable-HTTP rework (the separate S4a UI-gap follow-up).
- Merging to `main` / deleting `src-tauri` Tauri remnants — S6 cut-over.

## Exit criteria

- App built with `--features jobs,export,mcp,cloud,motifs`; renderer boots, `motif_register_runtime` succeeds, no `unavailable` motif errors.
- Place a built-in Motif → it renders live in the Pixi preview via the JS CDP producer (deterministic).
- Export a project containing a Motif → "preparing" bake completes and the Motif appears (animated) in the output.
- The authoring lifecycle works under Electron: new draft → edit (source panel / amend) → install (new + update with rebind) → delete → import `.html`; staleness dialog on version bump; file-watch hot-reload.
- MCP `listTools` shows the motif tools; an external client can `add_motif` and `preview_motif_draft`.
- Rust tests green under the `motifs` feature; the S5 Playwright specs pass on the Electron build; the full S2+S3+S4+S5 suite stays green.
