# S5 — Motif capture on Electron — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the full Motif subsystem online under Electron — place/preview a Motif deterministically, export with Motifs, and the complete authoring + cross-project lifecycle — by inverting the capture driver from Rust (WebView2 CDP) to the JS main process (`webContents.debugger` CDP) while keeping the Motif brain in Rust behind napi.

**Architecture:** The Rust "brain" (catalog / store / authoring / staleness / watcher / built-in bytes) is un-gated under a `motifs` cargo feature and exposed via the existing `napi_backend.rs` dispatcher + two dedicated `#[napi]` methods. The WebView2-specific capture path (`cdp.rs` / `host.rs` / `commands.rs`) is deleted and re-expressed in JS main (`electron/main/motif/`): a `motif:` `protocol.handle` (bytes from Rust) + an offscreen-`BrowserWindow` + `webContents.debugger` capture orchestrator. `motif_register_runtime` + `motif_capture_frame` are intercepted in `backend:invoke` (the S4b key pattern); every other `motif_*` channel falls through to the Rust dispatcher.

**Tech Stack:** napi-rs v3, Electron 40+ (`webContents.debugger`, `protocol.handle`, offscreen `BrowserWindow`), `@modelcontextprotocol/sdk`, Playwright-for-Electron, `notify` 8 (Rust file watch).

**Spec:** `docs/superpowers/specs/2026-06-18-electron-napi-s5-motif-capture-design.md`

## Global Constraints

- **Branch:** `migration/electron-napi`. Never commit to `main`. Stage by explicit path (parallel sessions edit this checkout). The shell cwd may be `apps/desktop`; run git with `git -C "C:/Users/iClass/Desktop/learning/videtor" …` and verify paths.
- **`src/**` is FROZEN** — no edits to renderer business logic. Only `apps/desktop/electron/**`, `apps/desktop/src/electron-compat/**`, `apps/desktop/src-tauri/**` (the napi crate), configs, and `apps/desktop/e2e/**` are editable. The renderer keeps calling `motif_capture_frame` / `motif_register_runtime` / the brain commands verbatim through the `@tauri-apps/*` → `electron-compat` shims.
- **Build feature set:** `--features jobs,export,mcp,cloud,motifs`. Every Rust build/test command in this plan uses this set. Task 1 updates the `napi:build` npm script.
- **napi cfg-on-method linker trap (S4a):** any `#[cfg(feature="motifs")]` `#[napi]` method goes in a SEPARATE `#[cfg(feature="motifs")] #[napi] impl Backend { … }` block — never inline in an existing `#[napi] impl`.
- **Capture init order (PoC + master plan):** `loadURL('about:blank')` → `debugger.attach('1.3')` → `Page.enable` → `Runtime.enable` → `Page.addScriptToEvaluateOnNewDocument` → navigate to `motif://…`. CDP enable hangs on a fresh offscreen window otherwise.
- **Host-page cache:** the `?v=<content_hash>` URL cache-buster is mandatory — the host reuses the loaded page on id match unless the `v` query changes (see `reference-motif-capture-host-page-cache`).
- **Determinism:** debugger-only capture (`Page.captureScreenshot`); NO paint/`nativeImage` fallback. Assert byte-determinism for same-run re-capture; perceptual parity vs Tauri goldens.
- **Dispatcher contract:** the renderer's `invoke(cmd, argsObj)` reaches Rust as `backend.invoke(channel, JSON.stringify(argsObj))`; arms deserialize `args` into `*Args` structs. Top-level renderer arg names are camelCase (`#[serde(rename_all="camelCase")]`); nested structs (`WriteDraftArgs`, `InstallArgs`) are serde-direct snake_case.
- **Event bridge (S2, reused):** `self.events.emit("<name>", payload)` → main `onEvent` → `webContents.send('evt:<name>')`. `motifs:changed` rides this with zero TS change.
- **Parallel-session git:** re-check `git status` before each commit; stage only this task's explicit paths.

## File Structure

**Rust (`apps/desktop/src-tauri/src/`)**
- `motifs/cdp.rs`, `motifs/host.rs`, `motifs/commands.rs` — **DELETE** (WebView2/Tauri capture path).
- `motifs/mod.rs` — strip `MotifRuntime`/`MotifCapture`/`CaptureState`/`should_*`/`motif_register_runtime` + `use tauri`; relocate `resolve_capture_duration` here.
- `motifs/builtin.rs` — strip `handle_request`/`csp`/`parse_path`/`not_found` + `use tauri`; keep `lookup`/`resolve_bytes`/`content_type_for`/`SCHEME*`.
- `motifs/authoring_commands.rs` — strip the `#[tauri::command]` wrappers + `emit_motifs_changed`; keep cores + add `get_motif_source_core`/`delete_motif_core`.
- `motifs/staleness.rs` — strip the two `#[tauri::command]` wrappers; keep the pure cores.
- `motifs/{authoring,store,watcher,catalog}.rs` — un-gate unchanged (watcher's emit becomes a closure).
- `commands/motifs.rs` — **CREATE**: `&Backend` async fns for all 9 renderer brain commands + the 2 staleness commands (calls cores + emits).
- `napi_backend.rs` — add `motif_store` + `motif_watcher` fields; the 11 `#[cfg(feature="motifs")]` dispatch arms; the watcher spawn in `init`; a separate `#[cfg(feature="motifs")] #[napi] impl` with `motif_resolve_file` + `motif_ctx_duration_s`.
- `mcp/catalog.rs`, `mcp/tools.rs`, `mcp/resources.rs` — re-add the motif tools + `motifs://current` resource.
- `Cargo.toml` — drop the `webview2-com`/`windows` cfg(windows) deps (only `cdp.rs` used them).

**JS (`apps/desktop/electron/main/`)**
- `motif/protocol.ts` — **CREATE**: `registerMotifSchemePrivileged()` + `registerMotifProtocol(backend)`.
- `motif/capture.ts` — **CREATE**: the offscreen capture orchestrator + `setRuntimeSource()` + `captureMotifFrameB64()`.
- `index.ts` — register the `motif` scheme; call `registerMotifProtocol`; intercept `motif_register_runtime` + `motif_capture_frame` in `backend:invoke`.
- `mcp/server.ts` — special-case `preview_motif_draft` in `CallToolRequestSchema`.

**Tests (`apps/desktop/e2e/electron/`)**
- `s5-motif-protocol.spec.ts`, `s5-motif-capture.spec.ts`, `s5-motif-preview.spec.ts`, `s5-motif-export.spec.ts`, `s5-motif-lifecycle.spec.ts`, `s5-mcp-motif.spec.ts`.

---

## Task 1: Rust — strip Tauri from the Motif brain so `--features motifs` compiles

Deletes the WebView2 capture path and de-Tauri's the brain modules, leaving the unit-tested cores. No dispatch arms yet — this task's deliverable is "the `motifs` feature builds Tauri-free and the brain unit tests pass."

**Files:**
- Delete: `apps/desktop/src-tauri/src/motifs/cdp.rs`, `motifs/host.rs`, `motifs/commands.rs`
- Modify: `motifs/mod.rs`, `motifs/builtin.rs`, `motifs/authoring_commands.rs`, `motifs/staleness.rs`, `src-tauri/Cargo.toml`, `apps/desktop/package.json`
- (No new test file; the existing in-module `#[cfg(test)]` tests are the gate.)

**Interfaces:**
- Produces (consumed by later tasks):
  - `motifs::resolve_capture_duration(motif_id: &str, builtins: &[catalog::Motif], get_user_manifests: impl FnOnce() -> Vec<catalog::Manifest>, props: &serde_json::Value) -> f64` (relocated into `mod.rs`)
  - `motifs::builtin::{resolve_bytes(store: Option<&store::UserMotifStore>, id: &str, rest: &str) -> Option<Vec<u8>>, content_type_for(rel: &str) -> &'static str}`
  - `motifs::authoring_commands::{get_motif_source_core(store, id) -> Result<MotifSource,String>, delete_motif_core(store, id) -> Result<(),String>, write_motif_draft_core, amend_draft_html, create_edit_draft_core, import_motif_from_source, install_motif_core, build_rebind_updates, MotifSource, WriteDraftArgs, InstallArgs, MOTIFS_CHANGED_EVENT}`
  - `motifs::staleness::{build_staleness_report, build_ack_entries, current_versions, MotifStaleEntry}`
  - `motifs::watcher::{spawn, MotifWatcher}`

- [ ] **Step 1: Update the build feature set**

In `apps/desktop/package.json`, find the `napi:build` script and add `motifs` to its `--features` list so it reads `--features jobs,export,mcp,cloud,motifs`. (Search for `napi:build`; the prior list is `jobs,export,mcp,cloud`.)

- [ ] **Step 2: Delete the WebView2 capture path**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" rm \
  apps/desktop/src-tauri/src/motifs/cdp.rs \
  apps/desktop/src-tauri/src/motifs/host.rs \
  apps/desktop/src-tauri/src/motifs/commands.rs
```

- [ ] **Step 3: Rewrite `motifs/mod.rs` (Tauri-free; relocate `resolve_capture_duration`)**

Replace the whole file with the module wiring minus the capture-state machinery. Keep the doc comment trimmed to the new architecture.

```rust
//! Motifs: web pages captured to deterministic video frames.
//!
//! A Motif is a `manifest.json`-island + `index.html` (+ `assets/`) bundle. The
//! brain — catalog, on-disk user store, authoring lifecycle, cross-project
//! staleness, and the file watcher — lives here and is exposed via napi. The
//! capture *driver* lives in the Electron main process (`electron/main/motif/`):
//! an offscreen `BrowserWindow` + `webContents.debugger` CDP renders + screenshots
//! a Motif, with bytes served by `motif_resolve_file` over `protocol.handle`.

pub mod authoring;
pub mod authoring_commands;
pub mod builtin;
pub mod catalog;
pub mod staleness;
pub mod store;
pub mod watcher;

/// Resolve the capture `ctx.duration` (seconds) for `motif_id`: search the
/// built-ins, then (lazily — only if not a built-in) the user manifests, then
/// fall back to 5.0. `get_user_manifests` is only invoked when `motif_id` is
/// not a built-in, so built-in captures never touch the disk. Pure (modulo the
/// caller's closure) so it stays unit-testable. (Relocated from the deleted
/// `commands.rs`; backs the `motif_ctx_duration_s` napi method.)
pub fn resolve_capture_duration(
    motif_id: &str,
    builtins: &[catalog::Motif],
    get_user_manifests: impl FnOnce() -> Vec<catalog::Manifest>,
    props: &serde_json::Value,
) -> f64 {
    if let Some(m) = builtins.iter().find(|m| m.id() == motif_id) {
        return catalog::motif_ctx_duration_s(&m.manifest, props);
    }
    for m in get_user_manifests() {
        if m.id == motif_id {
            return catalog::motif_ctx_duration_s(&m, props);
        }
    }
    5.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::motifs::catalog::{builtin_countdown, Manifest};

    #[test]
    fn duration_uses_builtin_then_user_then_default() {
        let builtins = catalog::builtins();
        let props = serde_json::json!({ "seconds": 7 });
        let d = resolve_capture_duration("countdown", &builtins, Vec::new, &props);
        assert!((d - 7.0).abs() < 1e-9);
        let d_no_walk = resolve_capture_duration(
            "countdown",
            &builtins,
            || panic!("built-in capture must not walk the user-motif store"),
            &props,
        );
        assert!((d_no_walk - 7.0).abs() < 1e-9);
        let mut user: Manifest = builtin_countdown().manifest;
        user.id = "user-x".into();
        user.max_duration_prop = None;
        user.max_duration_s = None;
        user.content_duration_s = Some(2.5);
        let d2 = resolve_capture_duration("user-x", &builtins, move || vec![user], &serde_json::json!({}));
        assert!((d2 - 2.5).abs() < 1e-9);
        let d3 = resolve_capture_duration("ghost", &builtins, Vec::new, &serde_json::json!({}));
        assert!((d3 - 5.0).abs() < 1e-9);
    }
}
```

- [ ] **Step 4: De-Tauri `motifs/builtin.rs`**

Remove `use tauri::http::{header, Request, Response};`, `use tauri::Manager;`, `use tauri::UriSchemeContext;`. Delete the functions `csp`, `parse_path`, `not_found`, `handle_request`, and their `#[cfg(test)]` tests (`parses_id_and_default_index`, `parses_nested_asset`, `rejects_empty_id`, `csp_blocks_network_and_allows_inline`). **Keep** `BuiltinFile`/`BuiltinMotif`/`BUILTINS`/`COUNTDOWN`/`LOWER_THIRD`, `lookup`, `content_type_for`, `resolve_bytes`, `SCHEME`, `SCHEME_ORIGIN`, and the tests `looks_up_embedded_countdown_index`, `serves_lower_third_font_asset`, `looks_up_embedded_lower_third_index`, `unknown_file_is_none`, `content_types`, `resolve_prefers_builtin_then_store`. The file's leading doc comment that describes the Tauri scheme remapping can be trimmed to describe only the embedded-bytes registry + `resolve_bytes`.

- [ ] **Step 5: De-Tauri `motifs/authoring_commands.rs`**

Remove `use tauri::{AppHandle, Emitter, State};`. Delete `emit_motifs_changed`. Delete the seven `#[tauri::command]` async wrappers (`get_motif_source`, `write_motif_draft`, `amend_motif_draft`, `create_edit_draft`, `import_motif`, `install_motif`, `delete_motif`). Keep `MOTIFS_CHANGED_EVENT`, `MotifSource`, `WriteDraftArgs`, `InstallMode`, `InstallArgs`, and all the `*_core`/pure fns (`write_motif_draft_core`, `amend_draft_html`, `create_edit_draft_core`, `import_motif_from_source`, `install_motif_core`, `build_rebind_updates`). Add two extracted cores (the logic the deleted wrappers held):

```rust
/// Read any built-in or user Motif's source (for the "edit" seed). Core of the
/// former `get_motif_source` command; no `State` so the dispatch arm + tests can call it.
pub fn get_motif_source_core(store: &UserMotifStore, id: &str) -> Result<MotifSource, String> {
    if let Some(m) = builtins().into_iter().find(|m| m.id() == id) {
        return Ok(MotifSource { manifest: m.manifest, html: m.html });
    }
    if let Some(m) = store.get_motif(id) {
        return Ok(MotifSource { manifest: m.manifest, html: m.html });
    }
    Err(format!("unknown motif id '{id}'"))
}

/// Delete a published user Motif (built-ins rejected). Core of the former
/// `delete_motif` command; no `State`/no emit.
pub fn delete_motif_core(store: &UserMotifStore, id: &str) -> Result<(), String> {
    if BUILTIN_IDS.contains(&id) {
        return Err(format!("cannot delete the built-in Motif '{id}'"));
    }
    store.delete_user_motif(id).map_err(|e| e.to_string())
}
```

(`get_motif_source_core` needs `use super::catalog::builtins;` — extend the existing `use super::catalog::{…}` import. `delete_motif_core` already has `BUILTIN_IDS` in scope.) Keep all the existing `#[cfg(test)]` tests (they call the cores).

- [ ] **Step 6: De-Tauri `motifs/staleness.rs`**

Remove `use tauri::{AppHandle, State};`. Delete the two `#[tauri::command]` async wrappers (`motif_staleness_report`, `acknowledge_motif_staleness`) — their `&Backend` re-expressions land in Task 5. Keep `MotifStaleEntry`, `current_versions`, `build_staleness_report`, `build_ack_entries`, and all `#[cfg(test)]` tests. Remove the now-unused imports the deleted wrappers needed (`ProjectHandle`, `Actor`, `LayerParams` if unused by the cores — verify with the compiler; `LayerId`/`MotifRebindEntry`/`HashMap`/`BTreeMap`/`Serialize` stay).

- [ ] **Step 7: Drop the WebView2-only deps**

In `apps/desktop/src-tauri/Cargo.toml`, delete the `[target.'cfg(windows)'.dependencies]` block (the `webview2-com = "0.38"` + `windows = { version = "0.61", … }` entries and their leading comment) — only the deleted `cdp.rs` used them. (`notify = "8"` stays.)

- [ ] **Step 8: Build + run the brain unit tests**

Run: `git -C "C:/Users/iClass/Desktop/learning/videtor" -c core.hooksPath=/dev/null status` to confirm only intended paths changed, then:
Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export,mcp,cloud,motifs motifs::`
Expected: PASS — the catalog/authoring/store/staleness/watcher/builtin tests run green; no `tauri`/`webview2-com` references remain.
Run: `cargo build --lib --features jobs,export,mcp,cloud,motifs`
Expected: clean build (warnings about not-yet-used cores are acceptable until Task 3).

- [ ] **Step 9: Commit**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" add apps/desktop/src-tauri apps/desktop/package.json
git -C "C:/Users/iClass/Desktop/learning/videtor" commit -m "migrate(s5): un-gate Motif brain, delete WebView2 capture path"
```

---

## Task 2: Rust — `motif_store` field + the two dedicated napi methods

Adds the Motif store to `Backend` and the two methods main calls directly (file serving + capture duration). Not renderer-`invoke` arms.

**Files:**
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs`

**Interfaces:**
- Consumes: `motifs::builtin::{resolve_bytes, content_type_for}`, `motifs::resolve_capture_duration`, `motifs::catalog::builtins`, `motifs::store::UserMotifStore` (Task 1).
- Produces (consumed by Tasks 3–8 + JS): `Backend.motif_store: UserMotifStore` (field, `#[cfg(feature="motifs")]`, rooted at `<config_dir>/motifs/`); napi methods `Backend.motifResolveFile(id, rest) -> Option<MotifFile{ bytes: Buffer, contentType: String }>` and `Backend.motifCtxDurationS(id, propsJson) -> f64`.

- [ ] **Step 1: Add the `motif_store` field + construct it**

In the `Backend` struct (after `cloud_keys`), add:
```rust
    #[cfg(feature = "motifs")]
    pub(crate) motif_store: crate::motifs::store::UserMotifStore,
    #[cfg(feature = "motifs")]
    pub(crate) motif_watcher: OnceLock<crate::motifs::watcher::MotifWatcher>,
```
In `build_backend`, before the final `Backend { … }`:
```rust
    #[cfg(feature = "motifs")]
    let motif_store = crate::motifs::store::UserMotifStore::new(config_path.join("motifs"));
```
and in the struct literal add:
```rust
        #[cfg(feature = "motifs")]
        motif_store,
        #[cfg(feature = "motifs")]
        motif_watcher: OnceLock::new(),
```
(`config_path` is the `PathBuf` already built at the top of `build_backend`; it is `.clone()`d into the other stores, so clone it here too: `config_path.clone().join("motifs")` if a later use needs it — check the existing moves and clone consistently.)

- [ ] **Step 2: Write the failing test for `motif_ctx_duration_s` logic**

The napi methods return `Buffer`/`f64` and are awkward to unit-test directly, but their cores are already tested (Task 1 `resolve_capture_duration`, `resolve_bytes`). Add a thin test asserting the store wiring resolves a built-in file. In the `#[cfg(test)] mod tests` of `napi_backend.rs`:
```rust
    #[cfg(feature = "motifs")]
    #[test]
    fn motif_store_resolves_builtin_bytes() {
        let b = Backend::new_for_test();
        let bytes = crate::motifs::builtin::resolve_bytes(Some(&b.motif_store), "countdown", "index.html")
            .expect("countdown index resolves");
        assert!(std::str::from_utf8(&bytes).unwrap().contains("motif.define"));
    }
```
(Use the existing `new_for_test` helper — confirm its name in the file's tests; S4b tests use it.)

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export,mcp,cloud,motifs motif_store_resolves_builtin_bytes`
Expected: FAIL to compile (`motif_store` field not found) — until Step 1 is in place; if Step 1 is in, it should PASS, which is fine (it pins the wiring).

- [ ] **Step 4: Add the dedicated napi impl block**

Append a SEPARATE impl block (linker-trap workaround) near the other cfg-gated napi methods:
```rust
/// A `motif:` file resolved for the Electron `protocol.handle('motif')` handler.
#[cfg(feature = "motifs")]
#[napi(object)]
pub struct MotifFile {
    pub bytes: napi::bindgen_prelude::Buffer,
    pub content_type: String,
}

#[cfg(feature = "motifs")]
#[napi]
impl Backend {
    /// Resolve a `motif://<id>/<rest>` file to bytes + content-type for the main
    /// process's `protocol.handle`. Built-ins first, then the on-disk user store.
    /// `None` → main returns 404.
    #[napi]
    pub fn motif_resolve_file(&self, id: String, rest: String) -> Option<MotifFile> {
        let bytes = crate::motifs::builtin::resolve_bytes(Some(&self.motif_store), &id, &rest)?;
        Some(MotifFile {
            content_type: crate::motifs::builtin::content_type_for(&rest).to_string(),
            bytes: bytes.into(),
        })
    }

    /// Resolve the capture `ctx.duration` (seconds) for a Motif + instance props.
    /// Backs the JS capture orchestrator's `meta.duration` (the frozen renderer
    /// shim can't pass it). Built-ins resolve without touching disk.
    #[napi]
    pub fn motif_ctx_duration_s(&self, id: String, props_json: String) -> f64 {
        let props: serde_json::Value =
            serde_json::from_str(&props_json).unwrap_or(serde_json::Value::Null);
        crate::motifs::resolve_capture_duration(
            &id,
            &crate::motifs::catalog::builtins(),
            || {
                self.motif_store
                    .get_motif(&id)
                    .into_iter()
                    .map(|m| m.manifest)
                    .collect()
            },
            &props,
        )
    }
}
```

- [ ] **Step 5: Build + test**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export,mcp,cloud,motifs napi_backend` and `cargo build --lib --features jobs,export,mcp,cloud,motifs`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" add apps/desktop/src-tauri/src/napi_backend.rs
git -C "C:/Users/iClass/Desktop/learning/videtor" commit -m "migrate(s5): Backend motif_store + motif_resolve_file/motif_ctx_duration_s napi methods"
```

---

## Task 3: Rust — `add_motif` + `list_motifs` dispatch arms (place/list a Motif)

Recovers the two state commands from the pre-S2 monolith and wires them as `&Backend` dispatch arms.

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/motifs.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs` (add `#[cfg(feature="motifs")] pub mod motifs;`), `napi_backend.rs`

**Interfaces:**
- Consumes: `Backend.project()` (the `OnceLock<ProjectHandle>` accessor used by other arms), `Backend.motif_store`, `motifs::authoring_commands::MotifSource`, `motifs::catalog`.
- Produces: `commands::motifs::{list_motifs(&Backend) -> Result<Vec<MotifSummary>,String>, add_motif(&Backend, AddMotifArgs) -> Result<String,String>}`; dispatcher arms `"list_motifs"`, `"add_motif"`.

- [ ] **Step 1: Recover `list_motifs_inner` + `add_motif` source**

Read the blob for the verbatim bodies (the source of truth — do not paraphrase):
```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" show 4a0dda90:apps/desktop/src-tauri/src/commands.rs | sed -n '2120,2280p'
```
Note `list_motifs_inner(store: &UserMotifStore) -> Vec<MotifSummary>` (~line 2141) and the `add_motif` Tauri command (~line 2212) with its `State<ProjectHandle>` / `State<UserMotifStore>` / args. Also recover the `MotifSummary` struct definition (search the same blob: `struct MotifSummary`).

- [ ] **Step 2: Create `commands/motifs.rs`**

Port verbatim, applying the documented transform: `state: State<'_, UserMotifStore>` → `&b.motif_store`; `handle: State<'_, ProjectHandle>` → `b.project()`; the command becomes a `pub async fn name(b: &Backend, …)`. Keep `list_motifs_inner` + `MotifSummary` here (or in `motifs::catalog` if the blob had them there — match the blob). Header:

```rust
//! State commands for placing + listing Motifs (`add_motif` / `list_motifs`),
//! recovered from the pre-S2 monolith and adapted to `&Backend`. The lifecycle
//! authoring commands live in `commands::motif_authoring`; both reuse the
//! `motifs::` cores so the MCP + renderer surfaces can't drift.

use crate::napi_backend::Backend;
use crate::motifs::store::UserMotifStore;
// … (recovered imports: MotifSummary, catalog, state ids/params, serde) …
```

Define the args struct matching the renderer's camelCase top-level args (`{ motifId, tStartUs, tEndUs?, trackId?, props? }`):
```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMotifArgs {
    pub motif_id: String,
    pub t_start_us: i64,
    pub t_end_us: Option<i64>,
    pub track_id: Option<String>,
    pub props: Option<serde_json::Value>,
}
```
(Confirm the numeric types against the recovered `add_motif` signature — match them exactly.) Then `list_motifs(b: &Backend)` returns `Ok(list_motifs_inner(&b.motif_store))` and `add_motif(b: &Backend, a: AddMotifArgs)` runs the recovered body against `b.project()` + `&b.motif_store`.

- [ ] **Step 3: Register the module**

In `commands/mod.rs`, add `#[cfg(feature = "motifs")] pub mod motifs;`.

- [ ] **Step 4: Add the dispatcher arms**

In `napi_backend.rs`'s `match cmd` (before the `other =>` fallthrough):
```rust
            #[cfg(feature = "motifs")]
            "list_motifs" => ser(crate::commands::motifs::list_motifs(self).await),
            #[cfg(feature = "motifs")]
            "add_motif" => {
                let a: crate::commands::motifs::AddMotifArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motifs::add_motif(self, a).await)
            }
```

- [ ] **Step 5: Write a dispatcher test**

In `napi_backend.rs` tests:
```rust
    #[cfg(feature = "motifs")]
    #[tokio::test]
    async fn list_motifs_arm_returns_builtins() {
        let b = Backend::new_for_test();
        b.init().await.unwrap();
        let json = b.invoke("list_motifs", "{}").await.unwrap();
        assert!(json.contains("countdown"));
        assert!(json.contains("lower-third"));
    }

    #[cfg(feature = "motifs")]
    #[tokio::test]
    async fn add_motif_arm_places_a_layer() {
        let b = Backend::new_for_test();
        b.init().await.unwrap();
        let out = b
            .invoke("add_motif", r#"{"motifId":"countdown","tStartUs":0}"#)
            .await
            .unwrap();
        assert!(!out.is_empty()); // returns the new layer id
    }
```

- [ ] **Step 6: Run + verify**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export,mcp,cloud,motifs list_motifs_arm_returns_builtins add_motif_arm_places_a_layer`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" add apps/desktop/src-tauri/src/commands apps/desktop/src-tauri/src/napi_backend.rs
git -C "C:/Users/iClass/Desktop/learning/videtor" commit -m "migrate(s5): add_motif + list_motifs dispatch arms (place/list)"
```

---

## Task 4: Rust — authoring lifecycle dispatch arms

Wires the seven authoring commands as `&Backend` arms calling the Task-1 cores + emitting `motifs:changed`.

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/motif_authoring.rs`
- Modify: `commands/mod.rs`, `napi_backend.rs`

**Interfaces:**
- Consumes: `motifs::authoring_commands::{get_motif_source_core, delete_motif_core, write_motif_draft_core, amend_draft_html, create_edit_draft_core, import_motif_from_source, install_motif_core, MotifSource, WriteDraftArgs, InstallArgs, MOTIFS_CHANGED_EVENT}`, `motifs::catalog::builtins`, `Backend.{motif_store, project(), events}`.
- Produces: dispatcher arms `get_motif_source`, `write_motif_draft`, `amend_motif_draft`, `create_edit_draft`, `import_motif`, `install_motif`, `delete_motif`.

- [ ] **Step 1: Create `commands/motif_authoring.rs`**

Each fn calls the core, then (for mutators) `b.events.emit(MOTIFS_CHANGED_EVENT, serde_json::json!({}))`.
```rust
//! `&Backend` authoring-lifecycle commands. Thin wrappers over the
//! `motifs::authoring_commands` cores + a `motifs:changed` emit, so the human
//! (renderer) surface and the MCP tools share one implementation.

use crate::napi_backend::Backend;
use crate::motifs::authoring_commands as ac;
use crate::motifs::catalog::builtins;

fn emit_changed(b: &Backend) {
    b.events.emit(ac::MOTIFS_CHANGED_EVENT, serde_json::json!({}));
}

pub async fn get_motif_source(b: &Backend, id: String) -> Result<ac::MotifSource, String> {
    ac::get_motif_source_core(&b.motif_store, &id)
}

pub async fn write_motif_draft(b: &Backend, args: ac::WriteDraftArgs) -> Result<String, String> {
    let id = ac::write_motif_draft_core(&b.motif_store, args.manifest, &args.html, None)?;
    emit_changed(b);
    Ok(id)
}

pub async fn amend_motif_draft(b: &Backend, draft_id: String, source: String) -> Result<(), String> {
    ac::amend_draft_html(&b.motif_store, &draft_id, &source)?;
    emit_changed(b);
    Ok(())
}

pub async fn create_edit_draft(b: &Backend, source_id: String) -> Result<String, String> {
    let id = ac::create_edit_draft_core(&b.motif_store, &builtins(), &source_id)?;
    emit_changed(b);
    Ok(id)
}

pub async fn import_motif(b: &Backend, path: String) -> Result<String, String> {
    let source = std::fs::read_to_string(&path).map_err(|e| format!("read '{path}': {e}"))?;
    let id = ac::import_motif_from_source(&b.motif_store, &source)?;
    emit_changed(b);
    Ok(id)
}

pub async fn install_motif(b: &Backend, args: ac::InstallArgs) -> Result<String, String> {
    let id = ac::install_motif_core(&b.motif_store, b.project(), &args).await?;
    emit_changed(b);
    Ok(id)
}

pub async fn delete_motif(b: &Backend, id: String) -> Result<(), String> {
    ac::delete_motif_core(&b.motif_store, &id)?;
    emit_changed(b);
    Ok(())
}
```
(Confirm `b.project()` returns `&ProjectHandle` matching `install_motif_core`'s `handle: &ProjectHandle` — match the existing accessor used by `commands::export`/`media`. `b.events` is `Arc<dyn EventSink>`; `.emit(name, value)` is the S2 signature.)

- [ ] **Step 2: Register the module**

In `commands/mod.rs`: `#[cfg(feature = "motifs")] pub mod motif_authoring;`.

- [ ] **Step 3: Add the dispatcher arms**

In `napi_backend.rs` `match cmd`:
```rust
            #[cfg(feature = "motifs")]
            "get_motif_source" => {
                #[derive(serde::Deserialize)] struct A { id: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::get_motif_source(self, a.id).await)
            }
            #[cfg(feature = "motifs")]
            "write_motif_draft" => {
                #[derive(serde::Deserialize)] struct A { args: crate::motifs::authoring_commands::WriteDraftArgs }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::write_motif_draft(self, a.args).await)
            }
            #[cfg(feature = "motifs")]
            "amend_motif_draft" => {
                #[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")] struct A { draft_id: String, source: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::amend_motif_draft(self, a.draft_id, a.source).await)
            }
            #[cfg(feature = "motifs")]
            "create_edit_draft" => {
                #[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")] struct A { source_id: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::create_edit_draft(self, a.source_id).await)
            }
            #[cfg(feature = "motifs")]
            "import_motif" => {
                #[derive(serde::Deserialize)] struct A { path: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::import_motif(self, a.path).await)
            }
            #[cfg(feature = "motifs")]
            "install_motif" => {
                #[derive(serde::Deserialize)] struct A { args: crate::motifs::authoring_commands::InstallArgs }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::install_motif(self, a.args).await)
            }
            #[cfg(feature = "motifs")]
            "delete_motif" => {
                #[derive(serde::Deserialize)] struct A { id: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::delete_motif(self, a.id).await)
            }
```
(The renderer arg shapes are: `get_motif_source {id}`, `write_motif_draft { args:{manifest,html} }`, `amend_motif_draft {draftId,source}`, `create_edit_draft {sourceId}`, `import_motif {path}`, `install_motif { args:{draft_id,mode} }`, `delete_motif {id}` — matched above.)

- [ ] **Step 4: Write a dispatcher test**

```rust
    #[cfg(feature = "motifs")]
    #[tokio::test]
    async fn write_draft_arm_returns_id_and_emits_changed() {
        let sink = std::sync::Arc::new(crate::events::VecEventSink::default());
        let b = Backend::new_for_test_with_sink(sink.clone());
        b.init().await.unwrap();
        let manifest = r#"{"id":"x","name":"My Draft","version":1,"size":[200,80],"default_duration_s":2,"props_schema":{}}"#;
        let body = r#"<head></head><body><script>motif.define({setup(){}})</script></body>"#;
        let arg = format!(r#"{{"args":{{"manifest":{manifest},"html":{}}}}}"#, serde_json::to_string(body).unwrap());
        let id = b.invoke("write_motif_draft", &arg).await.unwrap();
        assert!(!id.is_empty());
        assert!(sink.names().iter().any(|n| n == "motifs:changed"));
    }
```
(Use the sink-injecting test constructor the S2/S4b tests use — confirm its name, e.g. `new_for_test_with_sink`; `VecEventSink::names()` exists per S4b tests.)

- [ ] **Step 5: Run + verify**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export,mcp,cloud,motifs write_draft_arm_returns_id_and_emits_changed`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" add apps/desktop/src-tauri/src/commands apps/desktop/src-tauri/src/napi_backend.rs
git -C "C:/Users/iClass/Desktop/learning/videtor" commit -m "migrate(s5): authoring-lifecycle dispatch arms (draft/install/delete/import)"
```

---

## Task 5: Rust — staleness arms + the file watcher in `init`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/motif_authoring.rs` (or a new `commands/motif_staleness.rs`), `napi_backend.rs`

**Interfaces:**
- Consumes: `motifs::staleness::{current_versions, build_staleness_report, build_ack_entries, MotifStaleEntry}`, `motifs::watcher::spawn`, `Backend.{motif_store, project(), events, log_slot, motif_watcher}`.
- Produces: dispatcher arms `motif_staleness_report`, `acknowledge_motif_staleness`; the watcher spawned in `Backend::init`.

- [ ] **Step 1: Add the staleness `&Backend` fns**

Append to `commands/motif_authoring.rs` (re-expressing the deleted Tauri command bodies against `&Backend`; the snapshot-extraction + log live here):
```rust
use crate::motifs::staleness as st;
use crate::state::{Actor, LayerParams};
use crate::state::ids::LayerId;

pub async fn motif_staleness_report(b: &Backend) -> Result<Vec<st::MotifStaleEntry>, String> {
    let current = st::current_versions(&b.motif_store);
    let snap = b.project().snapshot().await;
    let layers: Vec<(String, u32)> = snap.tracks.iter().flat_map(|t| t.layers.iter())
        .filter_map(|l| match &l.params {
            LayerParams::Motif(p) => Some((p.motif_id.clone(), p.motif_version)),
            _ => None,
        }).collect();
    let report = st::build_staleness_report(&layers, &current);
    if !report.is_empty() {
        let summary = report.iter()
            .map(|e| format!("{} v{}→v{} ({} layer(s))", e.motif_id, e.placed_version, e.current_version, e.layer_count))
            .collect::<Vec<_>>().join(", ");
        b.log_slot.emit(crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Warn,
            category: crate::logs::LogCategory::Project,
            source: crate::logs::LogSource::System,
            message: format!("Motifs changed since placement: {summary}"),
            ..Default::default()
        });
    }
    Ok(report)
}

pub async fn acknowledge_motif_staleness(b: &Backend) -> Result<usize, String> {
    let current = st::current_versions(&b.motif_store);
    let snap = b.project().snapshot().await;
    let layers: Vec<(LayerId, String, u32, imbl::HashMap<String, serde_json::Value>)> = snap.tracks.iter()
        .flat_map(|t| t.layers.iter())
        .filter_map(|l| match &l.params {
            LayerParams::Motif(p) => Some((l.id, p.motif_id.clone(), p.motif_version, p.props.clone())),
            _ => None,
        }).collect();
    let updates = st::build_ack_entries(&layers, &current);
    if updates.is_empty() { return Ok(0); }
    let n = updates.len();
    b.project().rebind_motif(Actor::User, updates).await.map_err(|e| e.to_string())?;
    Ok(n)
}
```
(Match `b.log_slot.emit(...)` to the S3a logging pattern — `log_slot.emit(LogEntryInput{..})`; confirm the field path. The Tauri original used `logs::emit_via_app`; the napi equivalent is `b.log_slot.emit`.)

- [ ] **Step 2: Add the two dispatcher arms**

```rust
            #[cfg(feature = "motifs")]
            "motif_staleness_report" => ser(crate::commands::motif_authoring::motif_staleness_report(self).await),
            #[cfg(feature = "motifs")]
            "acknowledge_motif_staleness" => ser(crate::commands::motif_authoring::acknowledge_motif_staleness(self).await),
```

- [ ] **Step 3: Spawn the watcher in `init`**

In `Backend::init`, after the autosave block, add:
```rust
        // S5: watch <config_dir>/motifs/ so external edits + agent writes resync
        // the renderer catalog (motifs:changed → syncCatalog → ?v= host buster).
        #[cfg(feature = "motifs")]
        {
            let events = self.events.clone();
            let root = std::path::PathBuf::from(&self.config_dir).join("motifs");
            match crate::motifs::watcher::spawn(root, move || {
                events.emit("motifs:changed", serde_json::json!({}));
            }) {
                Ok(w) => { let _ = self.motif_watcher.set(w); }
                Err(e) => tracing::warn!("motif watcher failed to start: {e:#}"),
            }
        }
```

- [ ] **Step 4: Write a dispatcher test**

```rust
    #[cfg(feature = "motifs")]
    #[tokio::test]
    async fn staleness_report_arm_is_empty_on_blank_project() {
        let b = Backend::new_for_test();
        b.init().await.unwrap();
        let json = b.invoke("motif_staleness_report", "{}").await.unwrap();
        assert_eq!(json, "[]"); // no motif layers placed → empty report
    }
```

- [ ] **Step 5: Run + verify (full motif suite + build)**

Run: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export,mcp,cloud,motifs`
Expected: PASS (the whole crate, incl. the watcher + staleness unit tests + new arms).

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" add apps/desktop/src-tauri/src/commands apps/desktop/src-tauri/src/napi_backend.rs
git -C "C:/Users/iClass/Desktop/learning/videtor" commit -m "migrate(s5): staleness arms + notify file-watcher in Backend::init"
```

---

## Task 6: JS main — the `motif:` protocol

**Files:**
- Create: `apps/desktop/electron/main/motif/protocol.ts`
- Modify: `apps/desktop/electron/main/index.ts`
- Create: `apps/desktop/e2e/electron/s5-motif-protocol.spec.ts`

**Interfaces:**
- Consumes: `Backend.motifResolveFile(id, rest)` (Task 2).
- Produces: `registerMotifSchemePrivileged()`, `registerMotifProtocol(backend)`.

- [ ] **Step 1: Create `electron/main/motif/protocol.ts`**

```ts
import { protocol } from 'electron'

type Backend = import('@weftcut/core').Backend

/// CSP served with every Motif document — identical to the Tauri `builtin::csp()`.
/// `default-src 'none'` denies network (no connect-src); inline script/style for
/// self-contained Motifs; data: + motif: images/fonts.
const MOTIF_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: motif:; font-src data: motif:"

/// Must run before app.whenReady. `standard:true` gives motif://<id>/… real
/// origin semantics (same-origin assets + CSP); `secure:true` lets it host fonts.
export function registerMotifSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'motif', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

/// Serve motif://<id>/<rest> from the Rust brain (built-ins + user store). The
/// `?v=<content_hash>` query is ignored by resolution (it only busts the host
/// page cache). No caching headers — the host reloads each id on navigate.
export function registerMotifProtocol(backend: Backend): void {
  protocol.handle('motif', async (request) => {
    const url = new URL(request.url) // motif://<id>/<rest>
    const id = url.hostname
    const rest = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const file = backend.motifResolveFile(id, rest)
    if (!file) return new Response('not found: ' + id + '/' + rest, { status: 404 })
    return new Response(Buffer.from(file.bytes), {
      status: 200,
      headers: { 'Content-Type': file.contentType, 'Content-Security-Policy': MOTIF_CSP },
    })
  })
}
```
(Note: with `standard:true`, `motif://countdown/index.html` parses with `hostname === 'countdown'` and `pathname === '/index.html'` — the id is the host, not the first path segment. This matches the PoC's `motif://lower-third/index.html`.)

- [ ] **Step 2: Wire into `index.ts`**

Extend the existing `protocol.registerSchemesAsPrivileged([...])` call at the top to also register `motif`, OR call `registerMotifSchemePrivileged()` right after it (both run before `app.whenReady`). Add the import:
```ts
import { registerMotifSchemePrivileged, registerMotifProtocol } from './motif/protocol.js'
```
at top-of-module: `registerMotifSchemePrivileged()`. Inside `app.whenReady().then(async () => { … })`, after `await backend.init()` and near the `protocol.handle('weftcut-media', …)` registration, add:
```ts
  registerMotifProtocol(backend!)
```

- [ ] **Step 3: Write the failing Playwright test**

`apps/desktop/e2e/electron/s5-motif-protocol.spec.ts`:
```ts
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { MAIN } from './helpers/driver'

test('motif: protocol serves built-ins via the Rust brain; 404s unknown', async () => {
  const app = await electron.launch({ args: [MAIN] })
  // Run in MAIN where net.fetch + the motif scheme are available.
  const res = await app.evaluate(async ({ net }) => {
    const ok = await net.fetch('motif://countdown/index.html')
    const body = await ok.text()
    const miss = await net.fetch('motif://nope/index.html')
    return { okStatus: ok.status, hasDefine: body.includes('motif.define'), missStatus: miss.status }
  })
  expect(res.okStatus).toBe(200)
  expect(res.hasDefine).toBe(true)
  expect(res.missStatus).toBe(404)
  await app.close()
})
```

- [ ] **Step 4: Build + run**

Run: `cd apps/desktop && $env:VITE_WEFTCUT_E2E='1'; npm run electron:build` (rebuilds the napi addon with the `motifs` feature via `napi:build` + the electron bundle).
Run the single spec directly (npm/npx drop `--spec` on Windows — call the runner):
Run: `cd apps/desktop && npx playwright test e2e/electron/s5-motif-protocol.spec.ts`
Expected: PASS (200 + `motif.define` present; 404 on unknown).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" add apps/desktop/electron/main/motif/protocol.ts apps/desktop/electron/main/index.ts apps/desktop/e2e/electron/s5-motif-protocol.spec.ts
git -C "C:/Users/iClass/Desktop/learning/videtor" commit -m "migrate(s5): motif: protocol.handle (bytes from Rust) + scheme registration"
```

---

## Task 7: JS main — the capture orchestrator + `backend:invoke` interception

The core inversion: offscreen `BrowserWindow` + `webContents.debugger` CDP, ported from the PoC `capture.ts` + the Tauri `capture_motif_frame_b64` semantics.

**Files:**
- Create: `apps/desktop/electron/main/motif/capture.ts`
- Modify: `apps/desktop/electron/main/index.ts`
- Create: `apps/desktop/e2e/electron/s5-motif-capture.spec.ts`

**Interfaces:**
- Consumes: `Backend.motifCtxDurationS(id, propsJson)` (Task 2); the `motif:` protocol (Task 6).
- Produces: `setRuntimeSource(src: string)`, `captureMotifFrameB64(backend, args) -> Promise<string>` where `args = { motifId, tSec, propsJson, width, height, settleRafs, contentHash }`.

- [ ] **Step 1: Create `electron/main/motif/capture.ts`**

```ts
import { BrowserWindow } from 'electron'

type Backend = import('@weftcut/core').Backend

interface CaptureArgs {
  motifId: string
  tSec: number
  propsJson: string
  width: number
  height: number
  settleRafs: number | null
  contentHash: string
}

const CAPTURE_TIMEOUT_MS = 5000
const READY_ATTEMPTS = 30
const READY_POLL_MS = 100

let runtimeSource: string | null = null
/// The renderer registers the clock-takeover runtime once at boot
/// (`motif_register_runtime`); main injects it via addScriptToEvaluateOnNewDocument.
export function setRuntimeSource(src: string): void {
  runtimeSource = src
}

interface Host {
  win: BrowserWindow
  send: (method: string, params?: object) => Promise<any>
  loadedId: string | null
  loadedV: string | null
  readyFor: string | null
  lastSize: { w: number; h: number } | null
}
let host: Host | null = null

// Serialize ALL captures (on-demand sprite / prewarmer / baker / MCP) on the one
// host — single-threaded but await-interleaved — replacing the Rust tokio::Mutex.
let chain: Promise<unknown> = Promise.resolve()

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`motif capture timed out after ${ms}ms: ${label}`)), ms)),
  ])
}

async function buildHost(): Promise<Host> {
  if (!runtimeSource) throw new Error('motif runtime not registered yet (call motif_register_runtime)')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  })
  await withTimeout(win.loadURL('about:blank'), CAPTURE_TIMEOUT_MS, 'about:blank')
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const send = (method: string, params: object = {}) => dbg.sendCommand(method, params)
  await withTimeout(send('Page.enable'), CAPTURE_TIMEOUT_MS, 'Page.enable')
  await withTimeout(send('Runtime.enable'), CAPTURE_TIMEOUT_MS, 'Runtime.enable')
  await withTimeout(send('Page.addScriptToEvaluateOnNewDocument', { source: runtimeSource }), CAPTURE_TIMEOUT_MS, 'addScript')
  return { win, send, loadedId: null, loadedV: null, readyFor: null, lastSize: null }
}

function teardownHost(): void {
  if (host) {
    try { host.win.webContents.debugger.detach() } catch { /* already gone */ }
    try { host.win.destroy() } catch { /* already gone */ }
    host = null
  }
}

async function ensureHost(motifId: string, contentHash: string): Promise<Host> {
  if (!host) host = await buildHost()
  // Reuse only when BOTH id and content version match (the ?v= cache-buster).
  if (host.loadedId === motifId && host.loadedV === contentHash) return host
  const url = `motif://${motifId}/index.html?v=${encodeURIComponent(contentHash)}`
  await withTimeout(host.win.loadURL(url), CAPTURE_TIMEOUT_MS * 2, 'loadURL motif')
  host.loadedId = motifId
  host.loadedV = contentHash
  host.readyFor = null // re-probe; navigation re-runs addScriptToEvaluateOnNewDocument
  host.lastSize = null // re-apply setDeviceMetricsOverride for the new page
  return host
}

async function waitReady(h: Host, motifId: string): Promise<void> {
  if (h.readyFor === motifId) return
  // Throw-until-ready: a false boolean would resolve to ready falsely. The
  // pathname guard closes the navigate→stale-page race.
  const probe =
    `(typeof window.__motifRender==='function' && document.readyState==='complete'` +
    ` && location.pathname.indexOf('/')===0)`
  for (let i = 0; i < READY_ATTEMPTS; i++) {
    const r = await h.send('Runtime.evaluate', { expression: probe, returnByValue: true })
    if (r?.result?.value === true) { h.readyFor = motifId; return }
    await delay(READY_POLL_MS)
  }
  throw new Error(`motif '${motifId}' never became ready (window.__motifRender undefined)`)
}

async function doCapture(backend: Backend, a: CaptureArgs): Promise<string> {
  let h: Host
  try {
    h = await ensureHost(a.motifId, a.contentHash)
    await waitReady(h, a.motifId)
  } catch (e) {
    teardownHost()
    throw e
  }
  const duration = backend.motifCtxDurationS(a.motifId, a.propsJson)
  const props = JSON.parse(a.propsJson)
  const meta = { duration, width: a.width, height: a.height, fps: 30, settleRafs: a.settleRafs }
  const expr = `window.__motifRender(${JSON.stringify(a.tSec)}, ${JSON.stringify(props)}, ${JSON.stringify(meta)})`
  try {
    const ev = await withTimeout(
      h.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      CAPTURE_TIMEOUT_MS, '__motifRender',
    )
    if (ev?.exceptionDetails) throw new Error('__motifRender threw: ' + JSON.stringify(ev.exceptionDetails))
    if (h.lastSize?.w !== a.width || h.lastSize?.h !== a.height) {
      await h.send('Emulation.setDeviceMetricsOverride', { width: a.width, height: a.height, deviceScaleFactor: 1, mobile: false })
      await h.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
      h.lastSize = { w: a.width, h: a.height }
    }
    const shot = await withTimeout(h.send('Page.captureScreenshot', { format: 'png' }), CAPTURE_TIMEOUT_MS, 'captureScreenshot')
    if (!shot?.data) throw new Error('captureScreenshot returned no data')
    return shot.data as string // base64 PNG, no data: prefix
  } catch (e) {
    teardownHost() // wedged host: rebuild on next call
    throw e
  }
}

export function captureMotifFrameB64(backend: Backend, a: CaptureArgs): Promise<string> {
  const run = chain.then(() => doCapture(backend, a))
  // Keep the chain alive even if this capture rejects.
  chain = run.then(() => undefined, () => undefined)
  return run
}
```

- [ ] **Step 2: Intercept in `index.ts`**

Add the import:
```ts
import { setRuntimeSource, captureMotifFrameB64 } from './motif/capture.js'
```
In the `ipcMain.handle('backend:invoke', …)` body, before the `const json = await backend!.invoke(...)` fall-through (alongside the `settings_set_api_key` interception):
```ts
    if (channel === 'motif_register_runtime') {
      setRuntimeSource((args as { source: string }).source)
      return null
    }
    if (channel === 'motif_capture_frame') {
      const a = args as {
        motifId: string; tSec: number; propsJson: string
        width: number; height: number; settleRafs: number | null; contentHash: string
      }
      return await captureMotifFrameB64(backend!, a)
    }
```

- [ ] **Step 3: Write the failing Playwright test**

`apps/desktop/e2e/electron/s5-motif-capture.spec.ts`:
```ts
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

test('motif_capture_frame: deterministic transparent PNG via offscreen CDP', async () => {
  const { app, page } = await launchApp()
  // The renderer registered the runtime at boot (main.tsx). Capture countdown twice
  // at the same t — same input must yield byte-identical base64 (PoC determinism).
  const cap = (t: number) =>
    page.evaluate(
      (tSec) =>
        (window as any).api.invoke('motif_capture_frame', {
          motifId: 'countdown', tSec, propsJson: JSON.stringify({ seconds: 5, accent: '#ff4d4d' }),
          width: 480, height: 480, settleRafs: 1, contentHash: '',
        }) as Promise<string>,
      t,
    )
  const a = await cap(1.0)
  const b = await cap(1.0)
  expect(a.length).toBeGreaterThan(1000) // a real PNG, not empty
  expect(a).toBe(b)                       // same input → identical
  const c = await cap(2.0)
  expect(c).not.toBe(a)                   // different t → different frame (it animates)
  await app.close()
})
```

- [ ] **Step 4: Build + run**

Run: `cd apps/desktop && $env:VITE_WEFTCUT_E2E='1'; npm run electron:build`
Run: `cd apps/desktop && npx playwright test e2e/electron/s5-motif-capture.spec.ts`
Expected: PASS — base64 non-empty, identical for same `t`, different for different `t`.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" add apps/desktop/electron/main/motif/capture.ts apps/desktop/electron/main/index.ts apps/desktop/e2e/electron/s5-motif-capture.spec.ts
git -C "C:/Users/iClass/Desktop/learning/videtor" commit -m "migrate(s5): offscreen CDP capture orchestrator + register/capture interception"
```

---

## Task 8: MCP motif tools (Rust brain tools + JS `preview_motif_draft`)

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/catalog.rs`, `mcp/tools.rs`, `mcp/resources.rs`
- Modify: `apps/desktop/electron/main/mcp/server.ts`
- Create: `apps/desktop/e2e/electron/s5-mcp-motif.spec.ts`

**Interfaces:**
- Consumes: `commands::motifs::{list_motifs, add_motif}`, `commands::motif_authoring::{get_motif_source, write_motif_draft, install_motif, delete_motif}`, the JS `captureMotifFrameB64` (Task 7).
- Produces: MCP tools `list_motifs`, `add_motif`, `get_motif_source`, `write_motif_draft`, `install_motif`, `delete_motif`, `preview_motif_draft`; the `motifs://current` resource.

- [ ] **Step 1: Recover the pre-S4a motif tool descriptions/schemas**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" show 97e3c7f2:apps/desktop/src-tauri/src/mcp/mod.rs | sed -n '160,200p;1340,1520p'
```
These are the rmcp `#[tool]` bodies + descriptions (`list_motifs`/`add_motif`/`get_motif_source`/`write_motif_draft`/`preview_motif_draft`/`install_motif`/`delete_motif`) + `motifs_payload()` (= `list_motifs_inner` with `html` stripped). Transform to the transport-free `tools.rs` + `tool_table!` shape (the S4a pattern): each tool is a `pub(crate) async fn name(b: &Backend, args: …) -> wire::Reply` (or the established `tools.rs` signature — match an existing tool like the audio ones), registered as a `tool_table!` row in `catalog.rs` with its `schemars` arg type.

- [ ] **Step 2: Add the brain tool rows to `tool_table!`**

In `catalog.rs`'s `tool_table! { … }`, add rows (gated `#[cfg(feature="motifs")]` if the macro supports per-row cfg; else gate the whole motif group) for `list_motifs`, `add_motif`, `get_motif_source`, `write_motif_draft`, `install_motif`, `delete_motif` — each calling the corresponding `commands::motifs`/`commands::motif_authoring` fn so the MCP + renderer surfaces share one core. Add a `preview_motif_draft` row whose dispatch body returns a clear `wire::err`/`McpError` "preview_motif_draft is handled by the host (JS capture)" — its schema is what matters (the JS server intercepts the call before dispatch).

- [ ] **Step 3: Add the `motifs://current` resource**

In `resources.rs`, add a `motifs://current` reader returning `motifs_payload()` (= `list_motifs_inner(&b.motif_store)` with each entry's `html` field stripped — manifest-only for agents). Register it in the catalog's resource list.

- [ ] **Step 4: Special-case `preview_motif_draft` in the JS MCP server**

In `electron/main/mcp/server.ts`, the server needs the backend + the capture fn. Change `buildMcpServer(backend)` to also accept a capture callback, OR import `captureMotifFrameB64` directly. In the `CallToolRequestSchema` handler:
```ts
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'preview_motif_draft') {
      const a = (req.params.arguments ?? {}) as {
        draft_id?: string; motif_id?: string; t_sec?: number; props?: unknown
        width?: number; height?: number
      }
      const id = a.draft_id ?? a.motif_id ?? ''
      const b64 = await captureMotifFrameB64(backend, {
        motifId: id, tSec: a.t_sec ?? 0, propsJson: JSON.stringify(a.props ?? {}),
        width: a.width ?? 480, height: a.height ?? 480, settleRafs: null, contentHash: '',
      })
      return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] } as unknown as ServerResult
    }
    return unwrap(
      await backend.mcpCallTool(req.params.name, JSON.stringify(req.params.arguments ?? {})),
    ) as ServerResult
  })
```
Add `import { captureMotifFrameB64 } from '../motif/capture.js'`. (Confirm `preview_motif_draft`'s arg shape against the recovered Step-1 schema; adapt the field names if the original used different keys.)

- [ ] **Step 5: Write the failing Playwright test**

`apps/desktop/e2e/electron/s5-mcp-motif.spec.ts` — extend the `s4a-mcp` pattern (a real SDK client over the bound port + bearer). Assert `listTools()` includes `list_motifs` + `add_motif` + `preview_motif_draft`; `callTool('add_motif', { motifId:'countdown', tStartUs:0 })` returns a layer id; `callTool('preview_motif_draft', { motif_id:'countdown', t_sec:0 })` returns image content. (Copy the client bootstrap — port/token from `get_mcp_info` — from `s4a-mcp.spec.ts`.)

- [ ] **Step 6: Build + run**

Run: `cd apps/desktop && $env:VITE_WEFTCUT_E2E='1'; npm run electron:build`
Run: `cd apps/desktop && npx playwright test e2e/electron/s5-mcp-motif.spec.ts`
Expected: PASS.
Also run the Rust MCP catalog guards: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export,mcp,cloud,motifs mcp`
Expected: PASS (incl. the `mcp_catalog_property_schemas_are_objects` guard).

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" add apps/desktop/src-tauri/src/mcp apps/desktop/electron/main/mcp/server.ts apps/desktop/e2e/electron/s5-mcp-motif.spec.ts
git -C "C:/Users/iClass/Desktop/learning/videtor" commit -m "migrate(s5): MCP motif tools (Rust brain) + preview_motif_draft via JS capture"
```

---

## Task 9: e2e gates (preview / export / lifecycle) + acceptance notes

**Files:**
- Create: `apps/desktop/e2e/electron/s5-motif-preview.spec.ts`, `s5-motif-export.spec.ts`, `s5-motif-lifecycle.spec.ts`
- Create: `apps/desktop/electron/S5-NOTES.md`
- Reference (do not edit): `apps/desktop/e2e/specs/motif/*.e2e.js` (the wdio originals to mirror), `e2e/electron/helpers/driver.ts`.

**Interfaces:**
- Consumes: the full S5 surface (Tasks 1–8) + the `__weftcutTest` hooks (`newProjectAndEnter`, `addMotifLayer`/`motifAddCountdown`, `weftcutSeekUs`, `weftcutSampleComposite`, `driveExport`, `motifReopenProject`) — confirm the exact hook names in `src/testhook/e2eHook.ts`.

- [ ] **Step 1: `s5-motif-preview.spec.ts` — place + live capture into Pixi**

Mirror the wdio `motif_live_preview.e2e.js`: `newProject` → add a `countdown` motif layer via the hook → `weftcutSeekUs` to a content frame → `weftcutSampleComposite` and assert a non-trivial accent-pixel count on the live Pixi canvas (the CDP producer fed a frame). Poll-with-try/catch around `weftcutSeekUs` (it throws until PixiPreview registers its bridge — the documented e2e gotcha).

- [ ] **Step 2: Run it**

Run: `cd apps/desktop && $env:VITE_WEFTCUT_E2E='1'; npm run electron:build && npx playwright test e2e/electron/s5-motif-preview.spec.ts`
Expected: PASS (accent pixels > 0 on the canvas).

- [ ] **Step 3: `s5-motif-export.spec.ts` — export-with-Motif**

Mirror `template_export`/`motif`-era export: `newProject` → add a `countdown` layer spanning a few frames → `driveExport` (H.264) → assert phases reach `complete` and a self-SSIM between two exported frames shows the Motif animates (differ:true), proving the export bake ran the CDP producer. Reuse the `driveExport` helper + the `media_conformance` analyzer if the wdio export spec did.

- [ ] **Step 4: Run it**

Run: `cd apps/desktop && npx playwright test e2e/electron/s5-motif-export.spec.ts`
Expected: PASS (export completes; frames differ).

- [ ] **Step 5: `s5-motif-lifecycle.spec.ts` — authoring + staleness + filewatch**

Mirror `motif_filewatch.e2e.js` + `motif_staleness.e2e.js`: (a) write a draft (`write_motif_draft`) → install new → `list_motifs` shows it installed → delete; (b) place a layer at v1 → write the motif dir on disk at v2 (Node `fs` into `%APPDATA%\<appId>\motifs\`) → `motif_staleness_report` returns the v1→v2 row → `acknowledge_motif_staleness` returns the count; (c) external rewrite hot-reloads (watcher → `motifs:changed`). Use `motifReopenProject` if the staleness path needs a reopen.

- [ ] **Step 6: Run it**

Run: `cd apps/desktop && npx playwright test e2e/electron/s5-motif-lifecycle.spec.ts`
Expected: PASS.

- [ ] **Step 7: Full suite + acceptance notes**

Run the whole Electron e2e suite to confirm no regression:
Run: `cd apps/desktop && npx playwright test e2e/electron`
Expected: all S2+S3+S4+S5 specs PASS.
Run the full Rust suite: `cd apps/desktop/src-tauri && cargo test --lib --features jobs,export,mcp,cloud,motifs`
Expected: PASS.
Write `apps/desktop/electron/S5-NOTES.md` recording: the capture inversion, the deleted Rust modules, the new napi methods, the build feature, test counts (Rust + Playwright), and any deferred follow-ups (e.g. cross-platform offscreen CDP → S6; the `ConnectAgentPanel` UI-gap still pending).

- [ ] **Step 8: Commit**

```bash
git -C "C:/Users/iClass/Desktop/learning/videtor" add apps/desktop/e2e/electron apps/desktop/electron/S5-NOTES.md
git -C "C:/Users/iClass/Desktop/learning/videtor" commit -m "migrate(s5): motif e2e gates (preview/export/lifecycle) + acceptance notes"
```

---

## Self-Review

**Spec coverage:**
- Architectural inversion (Rust→JS capture) → Tasks 1 (delete), 6 (protocol), 7 (capture). ✓
- Renderer frozen surface (11 brain commands + register + capture) → Tasks 3/4/5 (arms), 7 (intercept register + capture). ✓
- Two napi methods (`motif_resolve_file`, `motif_ctx_duration_s`) → Task 2. ✓
- Watcher stays Rust, emits `motifs:changed` → Task 5. ✓
- `motif:` protocol + scheme privileges + CSP → Task 6. ✓
- Capture: about:blank-first, ready-probe, `?v=` buster, CaptureState, serialization mutex, debugger-only, wedge recovery → Task 7. ✓
- MCP brain tools + `preview_motif_draft` JS split + `motifs://current` → Task 8. ✓
- Testing (Rust unit un-gated + Playwright preview/export/lifecycle/protocol/capture/MCP) → Tasks 1–9. ✓
- Build feature `motifs` → Task 1 (script) + every Rust command. ✓
- Exit criteria (place/preview/export/authoring/staleness/MCP) → Tasks 7/9/8. ✓

**Placeholder scan:** Recovered-from-blob bodies (`list_motifs_inner`/`add_motif` in Task 3, MCP tool descriptions in Task 8) are referenced by exact blob+line, with the transform rule and the produced signatures stated — the established S4a/S4b precedent, not a placeholder. All new code (napi methods, protocol, capture orchestrator, dispatch arms, args structs, JS interception, MCP JS split) is inlined complete. ✓

**Type consistency:** `captureMotifFrameB64(backend, {motifId,tSec,propsJson,width,height,settleRafs,contentHash})` — same shape in Task 7 (def + intercept) and Task 8 (MCP call). `motifResolveFile(id,rest)->MotifFile{bytes,contentType}` consistent Task 2↔6. `MOTIFS_CHANGED_EVENT`/`motifs:changed` consistent across arms + watcher + bridge. `motif_store`/`motif_watcher` fields defined Task 2, used Tasks 3–5. ✓

**Open verification points for the implementer (flagged, not placeholders):** confirm against current code — the `Backend.project()` accessor name + return type; `new_for_test`/`new_for_test_with_sink`/`VecEventSink::names()` test helpers; `b.log_slot.emit` field path; the recovered `add_motif`/`MotifSummary` exact types; `tool_table!` per-row cfg support; the `__weftcutTest` hook names. These are confirm-then-match, with the expected shape stated.
