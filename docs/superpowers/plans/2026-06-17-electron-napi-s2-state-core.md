# S2 — napi-rs state core + event bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Rust domain core run in-process under Electron via napi-rs, so the React renderer loads/mutates/queries a real project with live UI updates through a `project:changed` event bridge — domain logic moved near-verbatim, no rewrite.

**Architecture:** The `weftcut` crate (`apps/desktop/src-tauri/`) is retargeted in place from a Tauri app to a **napi-rs cdylib**. A `#[napi] Backend` class holds what `lib.rs` previously `app.manage()`'d, exposes a single `invoke(cmd, argsJson) -> Promise<jsonString>` dispatcher, and emits events through an `EventSink` trait backed by one `ThreadsafeFunction`. Electron `main` constructs the `Backend`, bridges `ipcMain.handle('backend:invoke')`, and forwards events to `webContents.send`. Deferred subsystems (jobs/export/cloud/mcp/motifs/media_drop/sysmon) are cfg-gated OFF for S2.

**Tech Stack:** Rust + napi-rs v3 (`napi`/`napi-derive` 3.x, `@napi-rs/cli` 3.6.x, `napi-build` 2, `tokio_rt`); Electron 40 + electron-vite 6.0.0-beta.1; the existing Vite 8 / React 19 / PixiJS 8 renderer (unchanged behind S1 compat shims); Playwright-for-Electron for e2e.

## Global Constraints

- **Branch:** `migration/electron-napi`. Never commit to `main`. Stage by **explicit path** every commit (parallel sessions edit this checkout).
- **No `src/**` app-code edits.** Only `electron/`, `src/electron-compat/`, config, `package.json`, and the Rust crate change. The renderer keeps importing `@tauri-apps/*`; the S1 Vite aliases stay.
- **Crate retargeted in place:** keep the `apps/desktop/src-tauri/` directory and the `weftcut` package name. The cosmetic rename to `native/` is **S6**, not now.
- **napi-rs setup (PoC-proven):** `napi = { version = "3", default-features = false, features = ["napi6", "tokio_rt"] }`, `napi-derive = "3"`, build-dep `napi-build = "2"`, `build.rs` = `napi_build::setup();`. Lift the exact `ThreadsafeFunction<String>` type + `tsfn.call(Ok(s), ThreadsafeFunctionCallMode::NonBlocking)` pattern from `apps/desktop/poc/electron-napi/native/src/lib.rs` (the PoC is the last reference for this; leave it on disk through S2).
- **Dispatch:** ONE `#[napi] async fn invoke(&self, cmd, args_json) -> napi::Result<String>`. Command bodies return their result already-serialized; a `ser()` helper serializes typed `Ok` values; `Err(String)` → `napi::Error` via `Error::from_reason` (renderer promise rejects = Tauri parity).
- **Arg casing:** the renderer sends **camelCase** keys (`trackId`, `tStartUs`); Rust params are snake_case. Every dispatch `*Args` struct uses `#[derive(Deserialize)] #[serde(rename_all = "camelCase")]`.
- **Events:** ONE `ThreadsafeFunction<String>` carrying `{"event":<name>,"payload":<value>}` JSON. Main `JSON.parse`s and re-dispatches to `webContents.send('evt:'+event, payload)`. The S2-active events are `project:changed`, `app_settings:changed`, `agent_session:changed`, `log:entry`.
- **Gated subsystems** (`jobs`, `export`, `cloud`, `mcp`, `motifs`, `media_drop`, `sysmon`) are cargo features, all OFF by default in S2. Their commands fall through dispatch to `Err("unavailable: wired in a later stage (S3/S4/S5)")`. The renderer already has graceful catch paths (S1 proved no white screen).
- **Node:** v22.20.0 (fnm default). Do NOT install Node any other way. `@napi-rs/cli` is a devDependency.
- **Addon npm package:** `@weftcut/core`, loaded via `createRequire(import.meta.url)('@weftcut/core')`; the electron-vite **main** build marks it `external`.
- **Subagent fence (per `feedback_subagent_fences`):** NO auto-formatters (no `cargo fmt`/`prettier` sweeps), NO codex delegation, per-task commits, touch only the files a task names. On Windows, write Rust source with the Edit/Write tools — never `Set-Content` (cp1252 mangles em-dashes; see `feedback_powershell_setcontent_cp1252`).
- **`#![recursion_limit = "512"]`** stays in `lib.rs` (imbl; see `feedback_imbl_recursion_limit`).

## File Structure

**Rust crate (`apps/desktop/src-tauri/`):**
- Modify `Cargo.toml` — crate-type, napi deps, drop tauri deps, feature gates.
- Modify `build.rs` — `tauri_build::build()` → `napi_build::setup()`.
- Delete `src/main.rs` (the `[[bin]]` binary).
- Rewrite `src/lib.rs` — module declarations (gated) + `#![recursion_limit]`; the `run()` Tauri builder is gone.
- Create `src/events.rs` — `EventSink` trait + `TsfnEventSink` + `VecEventSink` (test).
- Create `src/napi_backend.rs` — `#[napi] Backend` (new/init/invoke), the actor→UI bridge, `ser()`.
- Create `src/commands/mod.rs` — `dispatch()` match + response structs (moved from `commands.rs`) + `*Args` structs.
- Create `src/commands/{query,mutations,history,persistence,prefs}.rs` — re-signed command bodies by group.
- Keep `src/commands.rs` renamed to `src/commands_legacy.rs` (orphaned reference; deleted at end of Task 7).
- Modify `src/state/actor.rs`, `src/io/autosave.rs`, `src/logs/bus.rs`, `src/agent_session.rs` — decouple from `tauri` (EventSink + `tokio::spawn`).
- Modify `src/io/mod.rs` — gate `pub mod probe;` behind `feature = "jobs"`.
- Modify `src/workspace.rs` — delete `allow_workspace_fs` (Tauri fs-scope grant, obsolete under Electron).
- Create `src/package.json` + `.gitignore` entries — the `@weftcut/core` napi package descriptor.

**Electron / renderer-config (`apps/desktop/`):**
- Modify `electron/main/index.ts` — load addon, construct+init Backend, `backend:invoke` + `window:*` + `path:documentDir` handlers, event TSFN → `webContents.send`.
- Modify `electron/preload/index.ts` — real `invoke` over `ipcRenderer.invoke('backend:invoke', …)`.
- Modify `electron.vite.config.ts` — mark `@weftcut/core` external in the main build.
- Modify `package.json` — add `@weftcut/core` (workspace/file dep), `@napi-rs/cli` dev-dep, `napi:build` script.
- Modify `src/electron-compat/tauri-window.ts`, `tauri-path.ts` — real bodies (window controls + documentDir).
- Create `e2e/electron/s2-smoke.spec.ts` + `playwright.config.ts` — the S2 exit-gate smoke.

---

## Task 1: Crate → napi cdylib skeleton (compiles, `ping` only)

The foundational big-bang: strip Tauri, gate deferred modules, add the EventSink + a minimal `Backend`, and decouple the in-scope files that used `tauri`. End state: `cargo build --lib` and `cargo test` are green with deferred subsystems off and a `Backend` exposing `ping`.

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/build.rs`, `apps/desktop/src-tauri/src/lib.rs`
- Delete: `apps/desktop/src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/src/events.rs`, `apps/desktop/src-tauri/src/napi_backend.rs`
- Modify: `apps/desktop/src-tauri/src/state/actor.rs`, `src/io/autosave.rs`, `src/io/mod.rs`, `src/logs/bus.rs`, `src/agent_session.rs`, `src/workspace.rs`
- Rename: `apps/desktop/src-tauri/src/commands.rs` → `src/commands_legacy.rs` (drop from module tree)

**Interfaces:**
- Produces: `pub trait EventSink: Send + Sync { fn emit(&self, event: &str, payload: serde_json::Value); }` (in `events.rs`); `#[napi] pub struct Backend` with `#[napi(constructor)] pub fn new(app_config_dir: String, app_cache_dir: String, on_event: ThreadsafeFunction<String>) -> Self`, `#[napi] pub async fn init(&self) -> napi::Result<()>`, `#[napi] pub async fn invoke(&self, cmd: String, args_json: String) -> napi::Result<String>`, and a plain `pub async fn dispatch(&self, cmd: &str, args: &str) -> Result<String, String>` (in `napi_backend.rs`).

- [ ] **Step 1: Convert `Cargo.toml`**

In `[lib]`, set `crate-type = ["cdylib", "rlib"]` (drop `staticlib`). Delete the `[[bin]]` block. In `[dependencies]` delete `tauri`, `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-shell`, `tauri-plugin-single-instance`, `tauri-plugin-window-state`, `tauri-plugin-notification`, `tauri-plugin-mcp-bridge`. In `[build-dependencies]` replace `tauri-build` with `napi-build = "2"`. Add to `[dependencies]`:
```toml
napi = { version = "3", default-features = false, features = ["napi6", "tokio_rt"] }
napi-derive = "3"
```
Replace the `[features]` block with:
```toml
[features]
default = []
# Deferred subsystems — OFF in S2, each turned on in its own stage.
jobs = []        # import/proxy/conform/thumbnails/waveform + io::probe + ffmpeg (S3)
export = []      # video export + WS videosink (S3)
cloud = []       # transcription/TTS + keyring (S4)
mcp = []         # MCP server (S4)
motifs = []      # Motif capture (S5)
media_drop = []  # webview drag-drop path recovery (S3)
sysmon = []      # dev PerfHUD sampler
```
Leave every other dependency untouched (unused deps compile harmlessly; the user does not care about size). Keep `[profile.dev] opt-level = 1` and `[profile.dev.package."*"] debug = false`.

- [ ] **Step 2: Convert `build.rs`**

Replace its entire contents with:
```rust
fn main() {
    napi_build::setup();
}
```

- [ ] **Step 3: Delete the binary and rename the legacy command file**

```bash
git rm apps/desktop/src-tauri/src/main.rs
git mv apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/commands_legacy.rs
```

- [ ] **Step 4: Rewrite `src/lib.rs`**

Replace the whole file with module declarations only (no `run()`), gating the deferred subsystems:
```rust
//! WeftCut domain core, exposed to Electron via napi-rs (`Backend`).
//! Architecture: see `docs/superpowers/specs/2026-06-17-electron-napi-s2-state-core-design.md`.
#![recursion_limit = "512"]

mod app_settings;
mod audio;
mod cache;
mod commands;
mod events;
mod napi_backend;

#[cfg(any(feature = "jobs", feature = "export"))]
mod ffmpeg;
mod io;
#[cfg(feature = "jobs")]
mod jobs;
#[cfg(feature = "export")]
mod export;
#[cfg(feature = "export")]
mod export_settings_store;
#[cfg(feature = "cloud")]
mod cloud;
#[cfg(feature = "mcp")]
mod mcp;
#[cfg(feature = "motifs")]
mod motifs;
#[cfg(all(windows, feature = "media_drop"))]
mod media_drop;
#[cfg(all(debug_assertions, feature = "sysmon"))]
mod sysmon;

mod keybindings;
mod logs;
mod preview;
mod agent_session;
mod recents;
mod state;
mod view_state;
mod workspace;
```
Note: `export_settings_store` is gated with `export` above only if it imports export types; if `commands::prefs` (Task 7) needs `export_settings_get/set`, instead keep `mod export_settings_store;` ungated (it is a plain JSON store). **Verify by compile**: if `export_settings_store` has no `export`/ffmpeg dependency, leave it ungated. Likewise `preview` and `audio` — keep ungated unless cargo reports they pull a gated module; if they do, gate them and drop their commands from later tasks' scope.

- [ ] **Step 5: Create `src/events.rs`**

```rust
//! Event sink — replaces `tauri::AppHandle::emit`. The production impl wraps
//! one napi `ThreadsafeFunction`; the test impl records emits.

use std::sync::{Arc, Mutex};

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde_json::Value;

pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// Production sink: serialize `{event, payload}` to a JSON string and call the
/// JS callback non-blocking. Match the TSFN generic arity to the PoC's
/// `subscribe_and_fire`.
pub struct TsfnEventSink {
    tsfn: ThreadsafeFunction<String>,
}

impl TsfnEventSink {
    pub fn new(tsfn: ThreadsafeFunction<String>) -> Self {
        Self { tsfn }
    }
}

impl EventSink for TsfnEventSink {
    fn emit(&self, event: &str, payload: Value) {
        let msg = serde_json::json!({ "event": event, "payload": payload }).to_string();
        let _ = self.tsfn.call(Ok(msg), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// Test sink: records `(event, payload)` for assertions.
#[derive(Clone, Default)]
pub struct VecEventSink {
    pub events: Arc<Mutex<Vec<(String, Value)>>>,
}

impl VecEventSink {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn names(&self) -> Vec<String> {
        self.events.lock().unwrap().iter().map(|(n, _)| n.clone()).collect()
    }
}

impl EventSink for VecEventSink {
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push((event.to_string(), payload));
    }
}
```
(If napi v3's `ThreadsafeFunction<String>` needs extra generic args to compile, copy the exact parameterization from `poc/electron-napi/native/src/lib.rs`'s `subscribe_and_fire` signature — it is proven on this toolchain.)

- [ ] **Step 6: Decouple `agent_session.rs`**

Remove `use tauri::Emitter;`. Change `begin_and_emit`/`end_and_emit` to take `&dyn EventSink` instead of `&tauri::AppHandle`:
```rust
use crate::events::EventSink;

pub fn begin_and_emit(
    events: &dyn EventSink,
    slot: &AgentSessionSlot,
    session: AgentSession,
) -> Option<AgentSession> {
    let prior = slot.begin(session.clone());
    events.emit(EVENT_AGENT_SESSION_CHANGED, serde_json::to_value(Some(session)).unwrap_or(serde_json::Value::Null));
    prior
}

pub fn end_and_emit(events: &dyn EventSink, slot: &AgentSessionSlot) -> Option<AgentSession> {
    let prior = slot.end();
    events.emit(EVENT_AGENT_SESSION_CHANGED, serde_json::Value::Null);
    prior
}
```
Update the module doc comment line "Tauri event `agent_session:changed`" → "Event `agent_session:changed`". The existing tests in this file stay green (they don't touch the emit fns).

- [ ] **Step 7: Decouple `logs/bus.rs`**

Remove `use tauri::AppHandle;` and `use tauri::Emitter;`. Add `use crate::events::EventSink; use std::sync::Arc;`. Change `LogBus::spawn` signature and its two `tauri::async_runtime::spawn` calls + the bridge emit:
```rust
pub fn spawn(workspace: &PathBuf, events: Arc<dyn EventSink>) -> Self {
    let logs_dir = workspace.join("Logs");
    let (broadcast_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let (writer_tx, writer_rx) = mpsc::channel(WRITER_CAPACITY);

    tokio::spawn(writer::run(logs_dir, writer_rx));

    let mut bridge_rx = broadcast_tx.subscribe();
    let events_for_bridge = events.clone();
    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match bridge_rx.recv().await {
                Ok(entry) => {
                    let payload = serde_json::to_value(&entry).unwrap_or(serde_json::Value::Null);
                    events_for_bridge.emit(EVENT_LOG_ENTRY, payload);
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });

    Self { inner: Arc::new(Inner { ring: RwLock::new(VecDeque::with_capacity(RING_CAPACITY)), broadcast: broadcast_tx, writer: writer_tx }) }
}
```
Delete the stale test comment at the bottom about "full bus tests require a `tauri::AppHandle`" (the bus is now testable with `VecEventSink`, but no new test is required in this task).

- [ ] **Step 8: Decouple `state/actor.rs` and `io/autosave.rs`**

In `state/actor.rs` change `tauri::async_runtime::spawn(actor.run());` → `tokio::spawn(actor.run());`. In `io/autosave.rs` change `tauri::async_runtime::spawn(autosave_loop(handle, workspace, force_rx));` → `tokio::spawn(autosave_loop(handle, workspace, force_rx));`. Remove any now-unused `use tauri::...` imports those files had.

- [ ] **Step 9: Gate `io::probe` and delete `workspace::allow_workspace_fs`**

In `io/mod.rs` change `pub mod probe;` → `#[cfg(feature = "jobs")] pub mod probe;`. In `workspace.rs` delete `allow_workspace_fs` and its `use tauri::AppHandle; use tauri_plugin_fs::FsExt;` imports. (Its callers are in `commands_legacy.rs`, which is out of the module tree, so nothing else references it.)

- [ ] **Step 10: Create `src/napi_backend.rs` (skeleton + dispatch with `ping` only)**

```rust
//! `Backend` — the napi entry point. Holds the actor handle + managed stores,
//! exposes a single `invoke` dispatcher and an `init` that spawns the actor and
//! the actor→UI event bridge.

use std::sync::{Arc, OnceLock};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde::Serialize;

use crate::events::{EventSink, TsfnEventSink};
use crate::state::{self, ProjectHandle};

#[napi]
pub struct Backend {
    events: Arc<dyn EventSink>,
    project: OnceLock<ProjectHandle>,
    config_dir: String,
    cache_dir: String,
    // Stores/slots added as their command groups land (Tasks 3-7):
    // recents, keybindings, app_settings, cache, workspace, agent_session,
    // log_slot, autosave.
}

#[napi]
impl Backend {
    #[napi(constructor)]
    pub fn new(app_config_dir: String, app_cache_dir: String, on_event: ThreadsafeFunction<String>) -> Self {
        let events: Arc<dyn EventSink> = Arc::new(TsfnEventSink::new(on_event));
        Backend {
            events,
            project: OnceLock::new(),
            config_dir: app_config_dir,
            cache_dir: app_cache_dir,
        }
    }

    /// Spawn the actor + bridge. Must be awaited once before any `invoke`.
    /// Runs inside napi's tokio runtime, so `tokio::spawn` has a runtime.
    #[napi]
    pub async fn init(&self) -> napi::Result<()> {
        let handle = state::spawn(state::Project::new_blank("untitled"));
        self.project.set(handle).map_err(|_| Error::from_reason("init called twice"))?;
        // The project:changed bridge is wired in Task 3 once query/summary exists.
        Ok(())
    }

    #[napi]
    pub async fn invoke(&self, cmd: String, args_json: String) -> napi::Result<String> {
        self.dispatch(&cmd, &args_json).await.map_err(Error::from_reason)
    }
}

impl Backend {
    fn project(&self) -> Result<&ProjectHandle, String> {
        self.project.get().ok_or_else(|| "backend not initialized".to_string())
    }

    pub async fn dispatch(&self, cmd: &str, _args: &str) -> Result<String, String> {
        match cmd {
            "ping" => Ok(serde_json::to_string("pong").unwrap()),
            other => Err(format!("unavailable: '{other}' is wired in a later stage (S3/S4/S5)")),
        }
    }
}

/// Serialize a typed command result into the dispatcher's JSON-string contract.
pub(crate) fn ser<T: Serialize>(r: Result<T, String>) -> Result<String, String> {
    r.and_then(|v| serde_json::to_string(&v).map_err(|e| e.to_string()))
}
```
Create an empty module file `src/commands/mod.rs` containing only `// command groups land in Tasks 3-7` plus `pub mod`-nothing for now, OR defer creating `commands/` to Task 3 and temporarily change `mod commands;` in `lib.rs` to a comment. Choose the latter to keep this task's surface minimal: comment out `mod commands;` in `lib.rs` and re-enable it in Task 3.

- [ ] **Step 11: Build and test**

Run: `cd apps/desktop/src-tauri && cargo build --lib`
Expected: compiles (warnings about unused deps are fine). If a non-gated module fails because it transitively needs a gated module, gate that module too and note it.
Run: `cargo test --lib`
Expected: existing unit tests in `state/`, `logs/`, `agent_session/`, etc. PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/build.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/events.rs apps/desktop/src-tauri/src/napi_backend.rs apps/desktop/src-tauri/src/state/actor.rs apps/desktop/src-tauri/src/io/mod.rs apps/desktop/src-tauri/src/io/autosave.rs apps/desktop/src-tauri/src/logs/bus.rs apps/desktop/src-tauri/src/agent_session.rs apps/desktop/src-tauri/src/workspace.rs apps/desktop/src-tauri/src/commands_legacy.rs
git rm --cached apps/desktop/src-tauri/src/main.rs 2>/dev/null; git add -A apps/desktop/src-tauri/src
git commit -m "migrate(s2): crate -> napi cdylib skeleton; strip tauri; gate deferred modules"
```

---

## Task 2: napi build pipeline → `@weftcut/core`; Node smoke

Make the addon buildable as the `@weftcut/core` npm package and prove it loads + constructs + initializes + answers `ping` from Node, before piling on commands.

**Files:**
- Create: `apps/desktop/src-tauri/package.json`
- Modify: `apps/desktop/package.json` (dep + script), `apps/desktop/.gitignore` (ignore built `.node`)

**Interfaces:**
- Produces: a loadable `@weftcut/core` exporting `{ Backend }`; `npm run napi:build` in `apps/desktop`.

- [ ] **Step 1: Create the napi package descriptor `apps/desktop/src-tauri/package.json`**

```json
{
  "name": "@weftcut/core",
  "version": "0.0.0",
  "main": "index.js",
  "types": "index.d.ts",
  "napi": { "binaryName": "weftcut-core" },
  "devDependencies": { "@napi-rs/cli": "^3.6.2" },
  "scripts": { "build": "napi build --platform --release" }
}
```

- [ ] **Step 2: Wire `apps/desktop/package.json`**

Add to `dependencies`: `"@weftcut/core": "file:src-tauri"`. Add to `devDependencies`: `"@napi-rs/cli": "^3.6.2"`. Add to `scripts`: `"napi:build": "napi build --platform --release --manifest-path src-tauri/Cargo.toml --output-dir src-tauri"`. (If `@napi-rs/cli` rejects `--manifest-path`/`--output-dir` flags for this version, instead `cd src-tauri && napi build --platform --release` and rely on the package `main`/`types` paths — confirm the generated `index.js` + `weftcut-core.*.node` land beside `src-tauri/package.json`.)

- [ ] **Step 3: Ignore the build artifacts**

Append to `apps/desktop/.gitignore`:
```
# napi-rs addon build output (rebuilt locally / in CI)
src-tauri/*.node
src-tauri/index.js
src-tauri/index.d.ts
```

- [ ] **Step 4: Install + build the addon**

Run: `cd apps/desktop && npm install`
Run: `cd apps/desktop && npm run napi:build`
Expected: produces `src-tauri/weftcut-core.<platform>.node` + `src-tauri/index.js` + `src-tauri/index.d.ts`; `index.d.ts` declares `export class Backend { constructor(...); init(): Promise<void>; invoke(cmd: string, argsJson: string): Promise<string> }`.

- [ ] **Step 5: Node smoke (throwaway)**

Create a temp script and run it (do not commit):
```bash
cd apps/desktop && node -e "
const { Backend } = require('@weftcut/core');
const b = new Backend(process.cwd(), process.cwd()+'/Cache', (err, msg) => console.log('EVT', msg));
b.init().then(() => b.invoke('ping','{}')).then(r => { console.log('PING', r); process.exit(r === JSON.stringify('pong') ? 0 : 1); });
"
```
Expected: prints `PING "pong"` and exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/package.json apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/.gitignore
git commit -m "migrate(s2): @weftcut/core napi build pipeline + node ping smoke"
```

---

## Task 3: `commands/` module + `project_summary` + `project:changed` bridge

Bring the command module online with the read path and the core event bridge.

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/mod.rs`, `src/commands/query.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (re-enable `mod commands;`), `src/napi_backend.rs` (fields, init bridge, dispatch arm)
- Test: a `#[cfg(test)]` module in `src/napi_backend.rs`

**Interfaces:**
- Consumes: `Backend` (Task 1), `ser()` (Task 1), the actor `ProjectHandle::subscribe()` → `broadcast::Receiver<state::ChangeEvent>` with fields `actor: state::Actor`, `op_id`, `summary`, `timestamp`, `affected`.
- Produces: `commands::dispatch_query(backend, cmd, args) -> Option<Result<String,String>>` (or arms folded into `Backend::dispatch`); `commands::query::project_summary(&Backend) -> Result<ProjectSummary, String>`; response structs (`ProjectSummary`, `CompositionSummary`, `LayerSummary`, …) moved into `commands/mod.rs`.

- [ ] **Step 1: Move the response structs into `commands/mod.rs`**

Create `src/commands/mod.rs`. Move from `commands_legacy.rs` (copy verbatim) all `#[derive(Serialize)]` response structs (`ProjectSummary`, `GroupSummary`, `MarkerSummary`, `TrackSummary`, `LayerSummary`, `LayerParamsView`, all `*View` types, `RoleMixView`, `HistoryView` re-use, etc.) and their `From`/builder impls. Add `pub mod query;`. Keep the `use` block these structs need (chrono, uuid, serde, the `state::*` types). Do NOT bring over `use tauri::State`.

- [ ] **Step 2: Re-sign `project_summary` into `commands/query.rs`**

The legacy signature is `pub async fn project_summary(handle: State<'_, ProjectHandle>) -> Result<ProjectSummary, ()>`. Re-sign:
```rust
use crate::commands::ProjectSummary;
use crate::napi_backend::Backend;

pub async fn project_summary(backend: &Backend) -> Result<ProjectSummary, String> {
    let handle = backend.project()?;          // &ProjectHandle
    let snap = handle.snapshot().await;        // same body as legacy, reading `snap`
    // ... copy the legacy body that builds ProjectSummary from the snapshot ...
    Ok(summary)
}
```
Make `Backend::project()` and `Backend::ser` visible to `commands` (mark `pub(crate)`). Map the legacy `Result<_, ()>` to `Result<_, String>` (the body never actually errors; just change the return type).

- [ ] **Step 3: Add fields + the bridge to `Backend`**

In `napi_backend.rs`, add the stores/slots needed now and through Task 7 (construct the ones available at boot in `new`; build the actor-dependent ones in `init`):
```rust
use crate::app_settings::AppSettingsStore;
use crate::recents::RecentsStore;
use crate::keybindings::KeybindingsStore;
use crate::cache::CacheLayout;
use crate::workspace::WorkspaceSlot;
use crate::agent_session::AgentSessionSlot;
use crate::logs::LogBusSlot;
use crate::io::autosave::AutosaveController;

pub struct Backend {
    pub(crate) events: Arc<dyn EventSink>,
    project: OnceLock<ProjectHandle>,
    autosave: OnceLock<AutosaveController>,
    pub(crate) recents: RecentsStore,
    pub(crate) keybindings: KeybindingsStore,
    pub(crate) app_settings: AppSettingsStore,
    pub(crate) cache: CacheLayout,
    pub(crate) workspace: WorkspaceSlot,
    pub(crate) agent_session: AgentSessionSlot,
    pub(crate) log_slot: LogBusSlot,
    pub(crate) config_dir: String,
    pub(crate) cache_dir: String,
}
```
In `new`, build the config-dir-rooted stores exactly as `lib.rs` did (`RecentsStore::new(config_dir)`, `KeybindingsStore::new(config_dir)`, `AppSettingsStore::new(config_dir)`, `CacheLayout::new(cache_dir)` + `ensure_dirs()`, `WorkspaceSlot::new()`, `AgentSessionSlot::new()`, `LogBusSlot::new()`), and install the tracing subscriber once (guard with `std::sync::Once`) using `logs::LogBusLayer::new(log_slot.clone())` as `lib.rs::run` did. In `init`, after spawning the actor, wire the bridge (adapted verbatim from `lib.rs` lines ~437-495, `app_handle.emit` → `self.events.emit`, `tauri::async_runtime::spawn` → `tokio::spawn`):
```rust
let bridge_handle = handle.clone();
let events = self.events.clone();
let log_slot = self.log_slot.clone();
tokio::spawn(async move {
    use tokio::sync::broadcast::error::RecvError;
    let mut rx = bridge_handle.subscribe();
    loop {
        match rx.recv().await {
            Ok(event) => {
                let (actor_kind, client) = match &event.actor {
                    state::Actor::User => ("user", None),
                    state::Actor::Agent { client } => ("agent", Some(client.clone())),
                };
                events.emit("project:changed", serde_json::json!({
                    "op_id": event.op_id.to_string(),
                    "actor_kind": actor_kind,
                    "client": client,
                    "summary": event.summary,
                    "timestamp": event.timestamp.to_rfc3339(),
                    "affected_count": event.affected.len(),
                }));
                let source = match &event.actor {
                    state::Actor::User => logs::LogSource::User,
                    state::Actor::Agent { client } => logs::LogSource::Agent { client: client.clone() },
                };
                log_slot.emit(logs::LogEntryInput {
                    level: logs::LogLevel::Info,
                    category: logs::LogCategory::Project,
                    source,
                    message: event.summary.clone(),
                    op_id: Some(event.op_id),
                    ..Default::default()
                });
            }
            Err(RecvError::Lagged(n)) => { events.emit("project:changed", serde_json::json!({ "lagged": n })); }
            Err(RecvError::Closed) => break,
        }
    }
});
let autosave = AutosaveController::spawn(handle.clone(), self.workspace.clone());
let _ = self.autosave.set(autosave);
```
Add a plain `Backend::new_for_test(events: Arc<dyn EventSink>) -> Self` (config/cache dirs = a tempdir) so tests can construct without napi; have it call the same store setup. Re-enable `mod commands;` in `lib.rs`.

- [ ] **Step 4: Add the dispatch arm**

In `Backend::dispatch`, before the fallthrough:
```rust
"project_summary" => crate::napi_backend::ser(crate::commands::query::project_summary(self).await),
```

- [ ] **Step 5: Write the failing test**

In `napi_backend.rs` add:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::VecEventSink;

    #[tokio::test]
    async fn project_summary_on_blank_project() {
        let sink = VecEventSink::new();
        let b = Backend::new_for_test(Arc::new(sink.clone()));
        b.init().await.unwrap();
        let json = b.dispatch("project_summary", "{}").await.unwrap();
        assert!(json.contains("\"track_count\""));
    }
}
```

- [ ] **Step 6: Run the test**

Run: `cd apps/desktop/src-tauri && cargo test --lib project_summary_on_blank_project`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/commands/query.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s2): commands/ module + project_summary + project:changed bridge"
```

---

## Task 4: `commands/mutations.rs` — layer/track/composition mutations

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/mutations.rs`
- Modify: `src/commands/mod.rs` (`pub mod mutations;` + `*Args` structs), `src/napi_backend.rs` (dispatch arms)
- Test: extend the `napi_backend.rs` test module

**Interfaces:**
- Consumes: `Backend::project()`, `ser()`.
- Produces: one re-signed fn per command + a camelCase `*Args` struct per command that has parameters.

**Re-sign recipe (applies to every command in Tasks 4-7):**
1. Copy the body verbatim from `commands_legacy.rs`.
2. Signature: drop every `_: State<'_, T>` param; replace the first `handle: State<'_, ProjectHandle>` with `backend: &Backend` and read `let handle = backend.project()?;` at the top. Other managed state (`State<'_, RecentsStore>` etc.) → `&backend.recents` etc.
3. Any `app: AppHandle` + `app.emit(name, payload)` → `backend.events.emit(name, serde_json::to_value(payload)?)`.
4. Keep the typed value params; they arrive via the `*Args` struct.
5. Normalize the error type to `Result<T, String>`.

**Worked example — `add_media_layer`:**

In `commands/mod.rs`:
```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMediaLayerArgs {
    pub track_id: String,
    pub media_id: String,
    pub t_start_us: crate::state::TimeUs,
}
```
In `commands/mutations.rs`:
```rust
use crate::napi_backend::Backend;
use crate::state::{self, LayerParams, MediaKind, TimeUs, animated::Animated};

pub async fn add_media_layer(backend: &Backend, track_id: String, media_id: String, t_start_us: TimeUs) -> Result<String, String> {
    let handle = backend.project()?;
    // ... legacy body verbatim from here (it already uses `handle`) ...
}
```
In `napi_backend.rs` dispatch:
```rust
"add_media_layer" => {
    let a: crate::commands::AddMediaLayerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
    ser(crate::commands::mutations::add_media_layer(self, a.track_id, a.media_id, a.t_start_us).await)
}
```

- [ ] **Step 1: Re-sign these commands into `commands/mutations.rs`** (with `*Args` structs in `mod.rs` for any with params): `add_track`, `separate_audio_to_new_track`, `add_demo_color_layer`, `add_color_layer`, `add_media_layer`, `add_text_layer`, `add_demo_text_layer`, `add_subtitles_layer`, `update_layer`, `update_layer_params`, `update_layer_param_track`, `update_layer_param_tracks`, `move_layer`, `trim_layer`, `split_layer_grouped`, `groups_create`, `groups_dissolve`, `duplicate_layer`, `delete_layer`, `set_composition`, `fit_composition_to_layers`, `add_marker`, `update_track_flags`, `set_role_gain`, `update_role_flags`. Match each `*Args` struct's fields to the legacy snake_case param names; the camelCase keys come from the renderer (verify against `apps/desktop/src/ipc/index.ts` call sites).

- [ ] **Step 2: Add `pub mod mutations;` to `commands/mod.rs` and all dispatch arms to `napi_backend.rs`.**

- [ ] **Step 3: Write the failing test**

```rust
#[tokio::test]
async fn add_track_then_summary_grows_and_emits() {
    let sink = VecEventSink::new();
    let b = Backend::new_for_test(Arc::new(sink.clone()));
    b.init().await.unwrap();
    let track_id_json = b.dispatch("add_track", "{}").await.unwrap();
    assert!(!track_id_json.is_empty());
    // small delay for the broadcast bridge task to run
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(sink.names().iter().any(|n| n == "project:changed"));
    let summary = b.dispatch("project_summary", "{}").await.unwrap();
    assert!(summary.contains("\"track_count\":1") || summary.contains("\"track_count\": 1"));
}
```

- [ ] **Step 4: Run it**

Run: `cd apps/desktop/src-tauri && cargo test --lib add_track_then_summary_grows_and_emits`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/mutations.rs apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s2): mutation commands + dispatch + round-trip test"
```

---

## Task 5: `commands/history.rs` — undo/redo/restore

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/history.rs`
- Modify: `src/commands/mod.rs`, `src/napi_backend.rs`
- Test: extend the test module

- [ ] **Step 1: Re-sign into `commands/history.rs`** (recipe from Task 4): `project_undo`, `project_redo`, `project_restore_checkpoint` (+ `RestoreCheckpointArgs`), and the debug-only `debug_lock_history`, `debug_unlock_history`, `debug_simulate_agent_session` — gate the three debug fns + their dispatch arms with `#[cfg(debug_assertions)]`.

- [ ] **Step 2: Add `pub mod history;` + dispatch arms.**

- [ ] **Step 3: Write the failing test**

```rust
#[tokio::test]
async fn undo_after_add_track_restores_empty() {
    let sink = VecEventSink::new();
    let b = Backend::new_for_test(Arc::new(sink));
    b.init().await.unwrap();
    b.dispatch("add_track", "{}").await.unwrap();
    b.dispatch("project_undo", "{}").await.unwrap();
    let summary = b.dispatch("project_summary", "{}").await.unwrap();
    assert!(summary.contains("\"track_count\":0") || summary.contains("\"track_count\": 0"));
}
```

- [ ] **Step 4: Run it.** `cargo test --lib undo_after_add_track_restores_empty` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/history.rs apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s2): history commands (undo/redo/restore) + test"
```

---

## Task 6: `commands/persistence.rs` — save/open/new workspace

The heaviest group: these install the LogBus, set the cache workspace, push recents, and reset the agent session. Verify `log:entry` fires after a workspace is open.

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/persistence.rs`
- Modify: `src/commands/mod.rs`, `src/napi_backend.rs`
- Test: extend the test module

- [ ] **Step 1: Re-sign into `commands/persistence.rs`** (recipe from Task 4): `project_save`, `project_save_as` (+ `PathArgs { path: String }`), `project_open` (+ `PathArgs`), `project_new_workspace` (+ its args struct). For each side effect the legacy body performed via managed state, use the `Backend` fields: `LogBus::spawn(&workspace_path, backend.events.clone())` then `backend.log_slot.install(bus)`; `backend.cache.set_workspace(...)`; `backend.recents` push; `backend.workspace.set(...)`; reset `backend.agent_session` (call `agent_session::end_and_emit(&*backend.events, &backend.agent_session)`). Drop the deleted `allow_workspace_fs` call entirely.

- [ ] **Step 2: Add `pub mod persistence;` + dispatch arms.**

- [ ] **Step 3: Write the failing test**

```rust
#[tokio::test]
async fn save_as_then_open_round_trips_and_logs() {
    let dir = std::env::temp_dir().join(format!("weftcut-s2-{}", std::process::id()));
    let proj = dir.join("proj.vproj");
    let sink = VecEventSink::new();
    let b = Backend::new_for_test(Arc::new(sink.clone()));
    b.init().await.unwrap();
    b.dispatch("add_track", "{}").await.unwrap();
    b.dispatch("project_save_as", &format!("{{\"path\":{:?}}}", proj.to_string_lossy())).await.unwrap();
    // a fresh backend opens it
    let b2 = Backend::new_for_test(Arc::new(VecEventSink::new()));
    b2.init().await.unwrap();
    b2.dispatch("project_open", &format!("{{\"path\":{:?}}}", proj.to_string_lossy())).await.unwrap();
    let summary = b2.dispatch("project_summary", "{}").await.unwrap();
    assert!(summary.contains("\"track_count\":1") || summary.contains("\"track_count\": 1"));
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 4: Run it.** `cargo test --lib save_as_then_open_round_trips_and_logs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/persistence.rs apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s2): persistence commands (save/open/new) + LogBus + round-trip test"
```

---

## Task 7: `commands/prefs.rs` — settings/recents/keybindings/logs/agent; delete legacy

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/prefs.rs`
- Modify: `src/commands/mod.rs`, `src/napi_backend.rs`
- Delete: `apps/desktop/src-tauri/src/commands_legacy.rs`
- Test: extend the test module

- [ ] **Step 1: Re-sign into `commands/prefs.rs`** (recipe from Task 4): `ping` (move from the inline dispatch arm), `get_project_settings`, `update_project_settings`, `app_settings_get`, `app_settings_set`, `view_state_get`, `view_state_set`, `export_settings_get`, `export_settings_set`, all `recents_*`, all `keybindings_*`, `workspace_dir`, `agent_session_get`, `agent_session_end`, `log_list`, `log_clear`, `log_emit`, `log_dir_path`. For `app_settings_set`, keep the `app_settings:changed` emit: `backend.events.emit("app_settings:changed", serde_json::to_value(&after)?)`. For `agent_session_end`, emit `agent_session:changed` via `agent_session::end_and_emit`. `export_settings_*` use `export_settings_store` — if that module was gated in Task 1 Step 4, ungate it now (it is a plain JSON store with no ffmpeg dependency).

- [ ] **Step 2: Add `pub mod prefs;` + all dispatch arms; remove the inline `"ping"` arm (now in prefs).**

- [ ] **Step 3: Delete the legacy file**

```bash
git rm apps/desktop/src-tauri/src/commands_legacy.rs
```
(The gated command bodies remain recoverable from git history for S3-S5.)

- [ ] **Step 4: Write the failing test**

```rust
#[tokio::test]
async fn app_settings_set_emits_changed() {
    let sink = VecEventSink::new();
    let b = Backend::new_for_test(Arc::new(sink.clone()));
    b.init().await.unwrap();
    let cur = b.dispatch("app_settings_get", "{}").await.unwrap();
    assert!(!cur.is_empty());
    // flip one field; use the real AppSettings shape from app_settings.rs
    b.dispatch("app_settings_set", "{\"settings\":{}}").await.ok(); // adjust args to the real signature
    assert!(sink.names().iter().any(|n| n == "app_settings:changed"));
}
```
Adjust the `app_settings_set` args object to match the legacy command's real parameter (inspect `commands_legacy.rs` before deleting it, or `app_settings.rs`). The assertion that matters is the `app_settings:changed` emit.

- [ ] **Step 5: Run the full suite.** `cd apps/desktop/src-tauri && cargo test --lib` → ALL PASS. Then `cargo build --lib` clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/prefs.rs apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/napi_backend.rs
git rm apps/desktop/src-tauri/src/commands_legacy.rs
git commit -m "migrate(s2): prefs/settings/recents/keybindings/logs commands; drop legacy command file"
```

---

## Task 8: Electron main — construct Backend + bridges

**Files:**
- Modify: `apps/desktop/electron/main/index.ts`, `apps/desktop/electron.vite.config.ts`

**Interfaces:**
- Consumes: `@weftcut/core` `{ Backend }`.
- Produces: `ipcMain.handle('backend:invoke')`, `window:*`, `path:documentDir`; events forwarded to `webContents.send('evt:'+name, payload)`.

- [ ] **Step 1: Mark the addon external in the main build**

In `electron.vite.config.ts`, in the `main` section add:
```ts
main: {
  build: {
    outDir: 'out/main',
    lib: { entry: 'electron/main/index.ts' },
    rollupOptions: { external: ['@weftcut/core'] },
  },
},
```

- [ ] **Step 2: Construct + bridge in `electron/main/index.ts`**

Add near the top:
```ts
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)
const { Backend } = require_('@weftcut/core') as typeof import('@weftcut/core')

let backend: import('@weftcut/core').Backend | null = null
let mainWindow: BrowserWindow | null = null
```
After `app.whenReady()` and before creating the window, construct + init the backend with an event callback that forwards to the renderer:
```ts
backend = new Backend(
  app.getPath('userData'),
  path.join(app.getPath('userData'), 'Cache'),
  (_err: Error | null, msg: string) => {
    if (!msg) return
    const { event, payload } = JSON.parse(msg)
    mainWindow?.webContents.send('evt:' + event, payload)
  },
)
await backend.init()

ipcMain.handle('backend:invoke', async (_e, { channel, args }) => {
  const json = await backend!.invoke(channel, JSON.stringify(args ?? {}))
  return JSON.parse(json)
})

ipcMain.handle('window:minimize', () => mainWindow?.minimize())
ipcMain.handle('window:toggleMaximize', () => mainWindow?.isMaximized() ? mainWindow?.unmaximize() : mainWindow?.maximize())
ipcMain.handle('window:close', () => mainWindow?.close())
ipcMain.handle('window:isMaximized', () => !!mainWindow?.isMaximized())
ipcMain.handle('window:setTitle', (_e, title: string) => mainWindow?.setTitle(title))
ipcMain.handle('path:documentDir', () => app.getPath('documents'))
```
Assign `mainWindow = win` inside `createWindow()` (replace the local `const win` returns as needed). Keep `import { app, BrowserWindow, ipcMain } from 'electron'`.

- [ ] **Step 3: Build + launch**

Run: `cd apps/desktop && npm run napi:build && npm run electron:dev`
Expected: app launches; DevTools console shows real data (the startup screen reads `recents_list`, which now returns a real (likely empty) list instead of the S1 stub rejection). No white screen.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/main/index.ts apps/desktop/electron.vite.config.ts
git commit -m "migrate(s2): electron main constructs Backend + invoke/window/event bridges"
```

---

## Task 9: Preload real invoke + compat shims

**Files:**
- Modify: `apps/desktop/electron/preload/index.ts`, `apps/desktop/src/electron-compat/tauri-window.ts`, `apps/desktop/src/electron-compat/tauri-path.ts`

- [ ] **Step 1: Real `invoke` in the preload**

Replace the S1 stub `invoke` with:
```ts
invoke(channel: string, args?: unknown): Promise<unknown> {
  return ipcRenderer.invoke('backend:invoke', { channel, args })
},
```
Leave `on`/`off` as wired in S1.

- [ ] **Step 2: Real window controls in `tauri-window.ts`**

Point the control methods at the `window:*` handlers via `window.api.invoke` (they currently call `window:${action}` per the S1 shim — confirm the action names match the main handlers: `minimize`, `toggleMaximize`, `close`, `isMaximized`, `setTitle`). Map any extra surface S1 stubbed (`isFocused`/`onResized`/`setProgressBar`/`onCloseRequested`/`destroy`) to safe no-ops or `window:*` handlers; for S2 a resolved no-op is acceptable where the renderer only awaits them.

- [ ] **Step 3: Real `documentDir` in `tauri-path.ts`**

```ts
export async function documentDir(): Promise<string> {
  return (await window.api.invoke('path:documentDir')) as string
}
```

- [ ] **Step 4: Manual boot check**

Run: `cd apps/desktop && npm run electron:dev`
Expected: the window controls work; the startup screen renders; creating/opening a project drives the UI. Confirm in DevTools that `project:changed` events arrive (Network/console log a value when you add a track via any UI affordance).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/preload/index.ts apps/desktop/src/electron-compat/tauri-window.ts apps/desktop/src/electron-compat/tauri-path.ts
git commit -m "migrate(s2): preload real invoke + window/path compat shims"
```

---

## Task 10: Playwright-for-Electron smoke (S2 exit gate)

**Files:**
- Create: `apps/desktop/e2e/electron/s2-smoke.spec.ts`, `apps/desktop/playwright.config.ts`
- Modify: `apps/desktop/package.json` (devDeps + `e2e:electron` script)

**Interfaces:**
- Consumes: the built Electron app (`out/main/index.js` + the addon).

- [ ] **Step 1: Add Playwright**

Add to `apps/desktop` devDependencies: `"@playwright/test": "^1.48.0"`. Add script: `"e2e:electron": "playwright test -c playwright.config.ts"`. Run `npm install`.

- [ ] **Step 2: `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: 'e2e/electron',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
})
```

- [ ] **Step 3: Write the smoke**

```ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'

test('boots, creates a project, add_track round-trips through the bridge', async () => {
  const app = await electron.launch({ args: [path.resolve('out/main/index.js')] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // The renderer exposes window.api; invoke through it (renderer context).
  const summary0 = await page.evaluate(() => (window as any).api.invoke('project_summary', {}))
  expect(summary0).toMatchObject({ track_count: 0 })

  const tid = await page.evaluate(() => (window as any).api.invoke('add_track', {}))
  expect(typeof tid).toBe('string')

  const summary1 = await page.evaluate(() => (window as any).api.invoke('project_summary', {}))
  expect(summary1.track_count).toBe(1)

  await app.close()
})
```

- [ ] **Step 4: Build + run the gate**

Run: `cd apps/desktop && npm run napi:build && npm run electron:build && npm run e2e:electron`
Expected: 1 passed. (If `electron:build` isn't sufficient to produce a launchable `out/main/index.js` without the renderer, the test may need the dev server; prefer the built artifacts — adjust the launch path to whatever `electron-vite build` emits as the main entry.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/electron/s2-smoke.spec.ts apps/desktop/playwright.config.ts apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "migrate(s2): playwright-for-electron S2 boot+mutation smoke gate"
```

---

## Task 11: Parity spot-check + S2 acceptance

**Files:**
- Create: `apps/desktop/electron/S2-NOTES.md`
- Modify: `.git/sdd/progress.md` (ledger)

- [ ] **Step 1: Parity spot-check vs Tauri**

Open a committed fixture `.vproj` under both shells and diff `project_summary` JSON. Under Electron: launch and `window.api.invoke('project_open', { path })` then `project_summary`. Under Tauri: the previous `tauri dev` build (on a stashed/worktree checkout if needed) calling the same. Record the diff (expect only cosmetic/ordering differences). If a fixture `.vproj` doesn't exist, create the smallest one via `project_save_as` under the Tauri build first, then open it under Electron.

- [ ] **Step 2: Write `electron/S2-NOTES.md`**

Record: the four in-process tests pass (`cargo test --lib`), the Playwright smoke passes, the parity diff result, and any deviations (e.g., ungated `export_settings_store`, any module that needed extra gating, the napi-cli flag adjustments). Note which commands are gated and that their bodies live in git history for S3-S5.

- [ ] **Step 3: Update the ledger**

Append to `.git/sdd/progress.md` under "Migration execution": the S2 commit range, the GO/exit-criteria status, and "Next: S3 (media + jobs) — needs its own JIT plan; un-gate `jobs`/`export`/`ffmpeg`, decouple their AppHandle emits to EventSink, decide videosink transport, port media-conformance e2e to Playwright-for-Electron."

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/S2-NOTES.md
git commit -m "migrate(s2): S2 acceptance notes + parity spot-check"
```

---

## Self-Review

**Spec coverage:**
- Crate retarget in place → Task 1. ✓
- napi cdylib + `@weftcut/core` + build wiring → Tasks 1-2. ✓
- EventSink trait + TSFN bridge → Tasks 1, 3 (project), 6 (log), 7 (app_settings/agent). ✓
- Single `invoke` dispatch + camelCase Args → Tasks 1, 3-7. ✓
- In-scope command inventory → Tasks 3 (query), 4 (mutations), 5 (history), 6 (persistence), 7 (prefs). ✓
- Gated subsystems off + graceful error contract → Task 1 (features), dispatch fallthrough. ✓
- Paths from Electron → Task 8 (`app.getPath`). ✓
- Electron main/preload/shims → Tasks 8-9. ✓
- Rust unit tests on the addon build → Tasks 3-7 (`cargo test --lib`). ✓
- Playwright-for-Electron smoke → Task 10. ✓
- Parity spot-check + exit criteria → Task 11. ✓

**Placeholder scan:** The mechanical re-signing tasks reference "copy the legacy body verbatim" + a worked example + an explicit command list per task — this is a transformation of existing, in-repo code (`commands_legacy.rs`), not an unwritten body; the novel code (Cargo, build, lib, events, Backend, bridge, dispatch, electron main/preload, playwright) is given in full. The two flagged uncertainties (napi-cli flag spelling in Task 2 Step 2; `electron-vite build` main entry path in Task 10 Step 4) include explicit fallbacks rather than TODOs.

**Type consistency:** `Backend::project() -> Result<&ProjectHandle, String>`, `ser<T: Serialize>(Result<T,String>) -> Result<String,String>`, `EventSink::emit(&str, Value)`, `dispatch(&str, &str) -> Result<String,String>`, `*Args` structs with `#[serde(rename_all="camelCase")]` — used consistently across Tasks 1, 3-7. The TSFN type defers to the PoC's proven parameterization to avoid a guessed signature.
