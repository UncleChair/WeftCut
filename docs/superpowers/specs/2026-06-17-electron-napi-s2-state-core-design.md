# S2 — napi-rs state core + event bridge (design)

> Stage S2 of the Tauri → Electron + napi-rs migration. Master plan:
> `docs/superpowers/plans/2026-06-17-electron-napi-migration.md`. Overall spec:
> `docs/superpowers/specs/2026-06-17-electron-napi-migration-design.md`. Branch:
> `migration/electron-napi`.

## Goal

Make the existing Rust domain core run **in-process under Electron via napi-rs**,
so the React renderer (already booting under Electron on a stub backend from S1)
loads, mutates, and queries a **real** project, with the UI updating live through
a `project:changed` event bridge — all without rewriting domain logic.

S2 is the state core only. Media/jobs/export, MCP, cloud, and Motif capture are
deferred to S3–S5 and are **feature-gated off** for this stage.

## Context (verified against the code)

- The Rust crate is `weftcut` at `apps/desktop/src-tauri/` (lib name
  `weftcut_lib`), ~42k LOC. It currently builds as a Tauri 2 app.
- **Tauri penetration is shallow in the domain core.** `state/`, `io/`,
  `cache/`, `app_settings`, `recents`, `keybindings`, `view_state`,
  `export_settings_store`, `workspace` are essentially Tauri-free. The deep
  coupling is all at the shell boundary: `lib.rs` (675-line `tauri::Builder`),
  `commands.rs` (82 `#[tauri::command]`), plus `mcp/`, `motifs/`, `jobs/`,
  `export/`, `media_drop`, `sysmon`.
- A thin **event-emit layer** uses `AppHandle.emit(...)` in `agent_session.rs`,
  `logs/bus.rs`, the actor→UI bridge inlined in `lib.rs`, and the
  `app_settings:changed` emit in `commands.rs`. (Plus import/export/motif emits
  in the deferred subsystems.)
- **No command in `commands.rs` uses `app.path()`, dialogs, or window handles.**
  Dialogs and filesystem are entirely renderer-side via the Tauri plugin shims;
  `project_save_as`/`project_open` receive the path as a parameter.
- The IPC contract is already **string-channel** (`invoke(channel, args)`), which
  the S1 preload + compat shims already speak.
- The renderer subscribes to these events (`rg "listen<"`): `project:changed`,
  `agent_session:changed`, `log:entry`, `app_settings:changed` (all S2-active),
  plus `import:*`, `media:job:*`, `export:transcode`, `motifs:changed`,
  `media:external-drop` (S3–S5; their listeners stay dormant until wired).
- **Compile risk is concentrated in the deferred subsystems** (ffmpeg-sidecar,
  rmcp/axum, keyring, reqwest, image, webview2-com), not the S2 state core,
  whose deps (serde, imbl, uuid, blake3, chrono, tokio, notify, ts-rs, regex)
  are all portable to a napi cdylib.

## Decisions (approved)

1. **Crate structure: retarget in place.** Keep the `src-tauri/` directory and
   the `weftcut` package; switch `crate-type` to a napi cdylib (`["cdylib",
   "rlib"]`); add napi v3; delete the Tauri bin/build + replaced plugins. The
   ~90-file domain tree stays put (minimal diff, lowest conflict risk). The
   cosmetic rename `src-tauri → native` is deferred to cut-over (S6).
2. **S2 scope: state core only.** Feature-gate off `jobs/`, `export/`,
   `ffmpeg/`, `cloud/`, `mcp/`, `motifs/`, `media_drop`, `sysmon` and make their
   heavy deps `optional`.
3. **Dispatch: single method, not 82 napi methods.** `Backend::invoke(cmd,
   argsJson) -> Promise<jsonString>` with an internal `match cmd`. Matches the
   existing string-channel contract; keeps the `.d.ts` tiny.
4. **Test driver: start Playwright-for-Electron now** as the S2 parity-oracle
   smoke (the cross-cutting workstream the master plan flags beginning at S2).
5. **Paths injected from Electron** (`app.getPath('userData')` etc.) into the
   `Backend` constructor, replacing Tauri's `app.path()`.
6. **Electron-native plugins**: dialog/fs/shell/notification/single-instance/
   window-state are dropped from Rust; the renderer reaches them through the
   preload (shims already point there) and Electron `main`.

## Architecture

The `weftcut` crate becomes a napi-rs cdylib instead of a Tauri app:

- `Cargo.toml`: `[lib] crate-type = ["cdylib", "rlib"]` (drop `staticlib`); add
  `napi`/`napi-derive` v3 with `tokio_rt`; add `napi-build` to build-deps;
  remove `tauri`, the six `tauri-plugin-*`, and `tauri-build`. Move the deferred
  subsystems' deps under `optional = true` gated by cargo features
  (`jobs`, `export`, `cloud`, `mcp`, `motifs`, default = none for S2).
- Delete `src/main.rs`, the `[[bin]]`, and `build.rs`/`tauri-build`.
- Replace `lib.rs::run()` (the `tauri::Builder`) with a napi `Backend`
  constructor that performs the same setup minus Tauri.

```
Electron main (CJS)                         napi cdylib (weftcut_lib)
─────────────────                           ─────────────────────────
createRequire('weftcut.node')   ──build──▶  #[napi] struct Backend
new Backend(appConfigDir,                     ├─ ProjectHandle (actor)
            appCacheDir, onEvent) ──────────▶ ├─ Recents/Keybindings/AppSettings
ipcMain.handle('backend:invoke') ─invoke()─▶  ├─ CacheLayout / WorkspaceSlot
  → backend.invoke(cmd, argsJson)             ├─ AgentSessionSlot / LogBusSlot
TSFN onEvent({event,payload})  ◀─EventSink─   ├─ AutosaveController
  → webContents.send('evt:'+e)                └─ Arc<dyn EventSink> (TSFN)
```

## Components

- **`Backend` — `src/napi_backend.rs` (new).** `#[napi]` struct holding the
  fields `lib.rs` currently `app.manage()`s: `ProjectHandle`, `RecentsStore`,
  `KeybindingsStore`, `AppSettingsStore`, `CacheLayout`, `WorkspaceSlot`,
  `AgentSessionSlot`, `LogBusSlot` (+ slot), `AutosaveController`,
  `Arc<dyn EventSink>`. The `#[napi(constructor)]` takes `app_config_dir`,
  `app_cache_dir`, and the event callback (`ThreadsafeFunction`); it runs the
  de-Tauri'd setup (spawn actor, install stores, wire the tracing/log bus,
  spawn the actor→UI bridge and autosave subscriber). Exposes one async method:
  `invoke(cmd, args_json) -> napi::Result<String>`.
- **`EventSink` — `src/events.rs` (new).** `trait EventSink: Send + Sync { fn
  emit(&self, event: &str, payload: serde_json::Value); }`. The production impl
  (`TsfnEventSink`) wraps the constructor's `ThreadsafeFunction`, calling it
  non-blocking with `{ event, payload }`. The test impl (`VecEventSink`) records
  emits for assertions. Replaces every `AppHandle.emit` in in-scope code.
- **Command dispatch — `src/commands.rs` (modified) + a `dispatch` fn.** The
  in-scope command bodies are re-signed from `(State<'_, T>, …, params)` to
  `(&self / &Backend, params)` reading the managed values from `Backend` fields
  and emitting via `self.events`. A `dispatch(&self, cmd, args_json)` matches the
  command name, deserializes `args_json` into that command's params struct, calls
  the body, and serializes the `Ok` value to a JSON string. `Err(String)` →
  `napi::Error`. Gated commands are absent from the `match` arm under their
  feature and fall through to a default `Err("unavailable: wired in S3/S4/S5")`.
- **Electron `main` — `electron/main/index.ts` (modified).**
  - Load the addon: `const { Backend } = createRequire(import.meta.url)('weftcut')`
    (the `.node` is marked `external` in the electron-vite main build).
  - Construct: `new Backend(app.getPath('userData'), app.getPath('userData') +
    '/Cache', (msg) => win?.webContents.send('evt:' + msg.event, msg.payload))`.
  - `ipcMain.handle('backend:invoke', (_e, { cmd, args }) =>
    backend.invoke(cmd, JSON.stringify(args ?? {})))` — returns the JSON string;
    the renderer shim `JSON.parse`s it. A thrown napi error rejects the handler →
    the renderer promise rejects (Tauri parity).
  - `ipcMain.handle('window:*')` for the window-control surface S1 shimmed
    (minimize/toggleMaximize/close/isMaximized/setTitle/…) via `BrowserWindow`.
- **Preload — `electron/preload/index.ts` (modified).** Replace the S1 `invoke`
  stub with `ipcRenderer.invoke('backend:invoke', { channel, args })`. The
  `on('evt:'+event)` subscription is already correct from S1.
- **Compat shims — `src/electron-compat/*` (modified where S2 can serve).**
  `tauri-window.ts` window controls → `window:*` ipc; `tauri-path.ts`
  `documentDir` → a `path:documentDir` handler. Gated-subsystem shims
  (plugin-dialog already wired; fs/shell/notification handled in main) keep
  their current behavior. No `src/**` app code changes — shims and config only.

## Command inventory (≈100 total)

**In scope (S2 — wired):** `ping`, `project_summary`; all mutation commands
(`add_track`, `separate_audio_to_new_track`, `add_color_layer`,
`add_media_layer`, `add_text_layer`, `add_subtitles_layer`, demo layers,
`update_layer`, `update_layer_params`, `update_layer_param_track[s]`,
`move_layer`, `trim_layer`, `split_layer_grouped`, `groups_create`,
`groups_dissolve`, `duplicate_layer`, `delete_layer`, `set_composition`,
`fit_composition_to_layers`, `add_marker`, `update_track_flags`, `set_role_gain`,
`update_role_flags`); history (`project_undo`, `project_redo`,
`project_restore_checkpoint`, debug lock/unlock); persistence (`project_save`,
`project_save_as`, `project_open`, `project_new_workspace`); settings
(`get/update_project_settings`, `app_settings_get/set`, `view_state_get/set`,
`export_settings_get/set`); `recents_*`; `keybindings_*`; `workspace_dir`;
`agent_session_get/end`; `log_list/clear/emit/dir_path`.

**Gated off (return "unavailable: wired in S{3,4,5}"):** import/jobs
(`import_media`, `import_cancel`, `import_queue_list`, `get_waveform_peaks`,
`get_media_thumbnail`, `ensure_full_proxy`, `ensure_conform`,
`ensure_export_audio_conform`, `report_audio_meter`); export
(`export_project_audio_only`, `mux_export`, `export_video_sink_*`); cloud
(`settings_*_api_key`, `settings_test_provider`); MCP (`get_mcp_info`,
`reset_mcp_token`); motifs (`list_motifs`, `add_motif`, the `motifs::*`
authoring/staleness/runtime/capture commands); dev (`get_system_stats`).

The renderer already has graceful catch/empty paths for these (S1 proved the
stub-reject contract produces error banners, not white screens).

## Data flow

- **Command:** renderer `invoke('add_track')` → `tauri-core` shim →
  `window.api.invoke` → preload `ipcRenderer.invoke('backend:invoke', …)` →
  main → `backend.invoke('add_track', argsJson)` → actor mutation → JSON result
  → resolves the renderer promise.
- **Event:** actor `ChangeEvent` (broadcast) → bridge task →
  `EventSink.emit("project:changed", summary)` → TSFN → main →
  `webContents.send('evt:project:changed', payload)` → preload `on` →
  `tauri-event` shim `listen` callback → React refetches `projectSummary()`.
  Identical path for `app_settings:changed`, `agent_session:changed`,
  `log:entry`.

## Build integration

- `@napi-rs/cli` builds the addon: `napi build --platform --release` produces
  `weftcut.node` + an `index.js`/`index.d.ts` loader. The `apps/desktop`
  `package.json` gains a `napi:build` script and depends on the addon by package
  name so `createRequire('weftcut')` resolves it.
- The electron-vite **main** build marks the addon `external` (Vite must not try
  to bundle a `.node`). Dev: build the addon once (and on Rust change) before
  `electron-vite dev`; the master plan's later stages can add a watch.
- `electron-vite 6.0.0-beta.1` (Vite 8) carries over from S1; revisit at 6.0
  stable. Not S2-blocking.

## Error handling

- Command `Err(String)` → `napi::Error` → rejected renderer promise with the
  message (Tauri `invoke` parity). `Result<_, ()>` errors map to a generic
  message.
- `Backend` construction failure (bad paths, actor spawn) throws from the napi
  constructor; main shows a fatal dialog and quits rather than leaving a
  half-live window.
- Broadcast `Lagged(n)` keeps the existing behavior: emit a `project:changed`
  refresh signal so the UI re-syncs.
- Gated commands return a structured, recognizable error so the renderer's
  existing catch paths run.

## Testing / parity oracle

1. **Rust unit tests pass on the addon build** — `cargo test` over the `rlib`
   (`state/actor/tests.rs`, etc.). The cheapest proof the de-Tauri'd core is
   behavior-equivalent. This is the primary gate.
2. **EventSink in-process test** — drive a mutation through `Backend` with a
   `VecEventSink` and assert a `project:changed` (and, for the relevant
   commands, `app_settings:changed`/`agent_session:changed`/`log:entry`) fired.
3. **Playwright-for-Electron smoke** (new) — boot the Electron app → new project
   → `add_track` → assert the UI reflects it (the `project:changed` round-trip)
   → open a fixture project → assert the summary renders. The S2 exit gate.
4. **Parity spot-check vs Tauri** — open the same fixture project under both
   shells and diff `project_summary` JSON; differences must be explainable
   (e.g., ordering), not semantic.

## Risks / open questions

- **napi ↔ electron-vite build wiring** (load `.node` via `createRequire`, mark
  external, rebuild on Rust change). Minor; the PoC validated the load+call
  mechanics under esbuild.
- **Compile surprises in the trimmed core** — a domain file may transitively
  pull a gated module; resolve by tightening `mod`/feature boundaries. Expected
  low given the penetration map above.
- **Re-signing ~50 commands** is mechanical but voluminous. Execute with
  subagent-driven development under a strict fence: no auto-formatters, no codex
  delegation (see `feedback_subagent_fences`), per-task commits, explicit-path
  staging.
- **electron-vite 6.0.0-beta.1** decision still pending (carried from S1).

## Exit criteria

- The Electron app boots, loads/creates a real project, and every in-scope
  command works; mutations + undo/redo update the UI live via the
  `project:changed` bridge.
- Existing Rust state unit tests pass on the napi addon build.
- The Playwright-for-Electron smoke passes.
- Parity spot-check vs Tauri on a fixture project agrees.
- Gated commands fail gracefully (no white screen).

## Out of scope (later stages)

- Media/jobs/export, the export WS/IPC transport decision, `protocol.handle`
  media serving with Range → **S3**.
- MCP (TS SDK) and `safeStorage` API-key storage → **S4**.
- Motif capture (offscreen + debugger CDP) → **S5**.
- Packaging, cross-platform prebuilds, the `src-tauri → native` rename →
  **S6**.
