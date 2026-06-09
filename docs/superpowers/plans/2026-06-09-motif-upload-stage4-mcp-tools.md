# Motif Upload Stage 4 — MCP Authoring Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the user-Motif authoring lifecycle to external MCP agents — make the existing `list_motifs`/`motifs://current`/`add_motif` user-Motif-aware, and add `get_motif_source`, `write_motif_draft {from?}`, `preview_motif_draft`, `install_motif`, `delete_motif` — each reusing the same core logic the human UI calls, so the two surfaces can't drift.

**Architecture:** The MCP `WeftCutServer` holds `app: AppHandle`, so tools reach Tauri-managed state via `self.app.state::<UserMotifStore>()` / `…::<ProjectHandle>` / `…::<MotifRuntime>` / `…::<MotifCapture>`. The lifecycle Tauri commands' bodies are factored into plain `…_core(...) -> Result<_, String>` functions (no `AppHandle`/no `emit`) that BOTH the command and the MCP tool call; the command wrapper keeps the `emit_motifs_changed`, and the MCP tool emits via `self.app`. `preview_motif_draft` reuses the `motif_capture_frame` capture core (factored the same way) and returns a base64 PNG; it works when the app's webview has registered the runtime, else returns a clear error.

**Tech Stack:** Rust (rmcp 0.1.x `#[tool]` methods, Tauri `Manager::state`, the existing motif store/catalog/capture), cargo test, real-WebView2/MCP-bridge e2e.

**Locked decisions (confirmed with the user 2026-06-09):**
- `write_motif_draft {from?, manifest, html}`: `from` = the optional **Update target** — when present, the draft records a `target` sidecar (= that id) so a later `install_motif {mode:"update"}` republishes over it; omitted → from-scratch (install-new only).
- `preview_motif_draft` is **in scope** (the agent's see-and-self-correct loop); it reuses the capture host and returns a clear error when the runtime isn't registered (headless), rather than hanging.
- **Defer "validation warnings"** — `validate_manifest` rejects hard; soft warnings are YAGNI.
- After this, Plan-4 remaining = Stage 5 (cross-project signal).

---

## Context an implementer needs

- **MCP server** (`apps/desktop/src-tauri/src/mcp/mod.rs`): `pub struct WeftCutServer { project: ProjectHandle, cache: CacheLayout, app: AppHandle }`. Tools live in the `#[tool(tool_box)] impl WeftCutServer` block as `#[tool(description="…")] async fn name(&self, #[tool(aggr)] args: NameArgs) -> Result<CallToolResult, McpError>`. Args structs: `#[derive(Debug, Deserialize, JsonSchema)] pub struct NameArgs { … }`. Result helpers (defined at mod.rs ~2146): `ok_text(s: impl Into<String>) -> CallToolResult` (wrap `Ok(ok_text(x))`), `ok_void() -> CallToolResult` (`Ok(ok_void())`), `ok_json<T: Serialize>(&v) -> Result<CallToolResult, McpError>` (return directly). Errors: `McpError::invalid_params(format!("…"), None)` and `McpError::internal_error(format!("…"), None)`. Map a `String` error to `McpError` with e.g. `.map_err(|e| McpError::internal_error(e, None))`.
- **The existing motif MCP surface (builtins-only — the gap to fix):** `list_motifs` tool (mod.rs:1163) returns `ok_json(&templates_payload())`; `templates_payload()` (mod.rs:2179) = `catalog::catalog()` (built-ins). `motifs://current` resource (mod.rs:2662) uses the same. `add_motif` tool (mod.rs:1175) resolves only `catalog::builtins()`. None see user Motifs.
- **State managed in `lib.rs`:** `UserMotifStore`, `ProjectHandle`, `MotifRuntime`, `MotifCapture` are all `.manage()`d — reachable via `self.app.state::<T>()` (returns `tauri::State<'_, T>`, deref to `&T`).
- **The Tauri lifecycle commands to factor** (`apps/desktop/src-tauri/src/motifs/authoring_commands.rs`):
  - `install_motif(app, store, handle, args: InstallArgs{draft_id, mode: InstallMode})` — validates the draft, `install_draft` (move + version bump), and for `Update{target_id}` snapshots + `build_rebind_updates` + `handle.rebind_motif`. Ends with `emit_motifs_changed`.
  - `write_motif_draft(app, store, args: WriteDraftArgs{manifest, html})` — `validate_manifest` + mint a final-ready id (`assign_unique_id` over published+drafts) + `compose_motif_html` + `store.write_draft` + emit.
  - `create_edit_draft_core(store, builtins, source_id) -> Result<String,String>` (pure) + `import_motif_from_source(store, source)` (pure) already exist as reuse models.
  - `get_motif_source(store, id) -> Result<MotifSource{manifest, html}, String>` (already a command; its body resolves builtins-then-store).
  - `delete_motif(app, store, id)` — rejects `BUILTIN_IDS`, `store.delete_user_motif`, emit.
  - `emit_motifs_changed(&AppHandle)` + `MOTIFS_CHANGED_EVENT`.
- **The capture command to factor** (`apps/desktop/src-tauri/src/motifs/commands.rs`): `motif_capture_frame(app, state: State<MotifRuntime>, capture: State<MotifCapture>, store: State<UserMotifStore>, motif_id, t_sec, props_json, width, height, settle_rafs) -> Result<String /*base64 PNG*/, String>`. It reads `state.get()` (the registered runtime; errors if absent), `ensure_host`, ready-probe, renders + CDP-screenshots, returns base64. The whole body is the capture core.
- **The user-aware list helper** (`apps/desktop/src-tauri/src/commands.rs`): `pub(crate) fn list_motifs_inner(store: &UserMotifStore) -> Vec<serde_json::Value>` (added in 3b-3a) — builtins + installed + drafts, with `status`/`content_hash`/`target_id`. Reuse it for the MCP list + resource. `add_motif` (Tauri command) resolves `builtins().find(...).or_else(|| store.get_motif(...))` — mirror that resolution in the MCP `add_motif`.
- **Toolchain:** Rust from `apps/desktop/src-tauri` (`cargo test -p weftcut <filter>`, `cargo build -p weftcut`). Edit Rust via Edit/Write tools (cp1252). PowerShell for cargo/git. rmcp is pinned 0.1.x (do NOT bump). The MCP server compiles behind a feature/build — `cargo build -p weftcut` exercises it.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src-tauri/src/motifs/authoring_commands.rs` | lifecycle commands | factor `install_motif_core`, `write_motif_draft_core`; keep commands as thin wrappers |
| `src-tauri/src/motifs/commands.rs` | capture command | factor `capture_motif_frame_b64` core |
| `src-tauri/src/mcp/mod.rs` | MCP tools | user-aware `list_motifs`/`motifs://current`/`add_motif`; 5 new lifecycle tools + arg structs |

---

### Task 1: Factor `install_motif_core` + `write_motif_draft_core` (Rust, no behavior change)

**Files:** Modify `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`

- [ ] **Step 1: Extract the cores** — pull the bodies of `write_motif_draft` and `install_motif` (everything EXCEPT the `app`/`emit_motifs_changed`) into plain functions, and make the commands call them:

```rust
/// Core of `write_motif_draft`: validate + mint a final-ready id + compose +
/// write the draft. When `from` is Some, record it as the draft's Update target
/// (a later install can Update over it). Returns the draft id. No emit.
pub fn write_motif_draft_core(
    store: &UserMotifStore,
    manifest: Manifest,
    html: &str,
    from: Option<&str>,
) -> Result<String, String> {
    validate_manifest(&manifest).map_err(|e| e.to_string())?;
    let taken: Vec<String> = store.published_ids().into_iter()
        .chain(store.list_draft_ids()).collect();
    let draft_id = assign_unique_id(&manifest.name, &taken);
    let mut manifest = manifest;
    manifest.id = draft_id.clone();
    manifest.version = 1;
    let composed = compose_motif_html(&manifest, html);
    store.write_draft(&draft_id, &composed).map_err(|e| e.to_string())?;
    if let Some(target) = from {
        store.write_draft_target(&draft_id, target).map_err(|e| e.to_string())?;
    }
    Ok(draft_id)
}

/// Core of `install_motif`: validate, install_draft (move + bump), and for Update
/// rebind+migrate current-project layers. Returns the published id. No emit.
pub async fn install_motif_core(
    store: &UserMotifStore,
    handle: &crate::state::ProjectHandle,
    args: &InstallArgs,
) -> Result<String, String> {
    // … the EXISTING body of `install_motif`, verbatim, minus the final
    // `emit_motifs_changed(&app)` — return the `final_id` instead of `Ok(final_id)`
    // after emit. (Move the whole match/validate/install_draft/rebind block here.)
}
```

Then the commands become thin wrappers:

```rust
#[tauri::command]
pub async fn write_motif_draft(app: AppHandle, store: State<'_, UserMotifStore>, args: WriteDraftArgs) -> Result<String, String> {
    let id = write_motif_draft_core(&store, args.manifest, &args.html, None)?;
    emit_motifs_changed(&app);
    Ok(id)
}

#[tauri::command]
pub async fn install_motif(app: AppHandle, store: State<'_, UserMotifStore>, handle: State<'_, crate::state::ProjectHandle>, args: InstallArgs) -> Result<String, String> {
    let id = install_motif_core(&store, &handle, &args).await?;
    emit_motifs_changed(&app);
    Ok(id)
}
```

(NOTE: `write_motif_draft` previously took no `from`; keep its command signature unchanged — it passes `None`. The `from` path is exercised only by the MCP tool in Task 4. `install_motif_core` takes `&InstallArgs` so the existing `InstallMode` enum is reused; confirm `InstallArgs`/`InstallMode` are `pub`.)

- [ ] **Step 2: Verify no behavior change** — the existing `authoring_commands` tests (install-new/update, write-draft) must still pass unchanged: `cargo test -p weftcut authoring_commands`. If any test called the command directly with State, it still works (the command is unchanged externally). Add no new test here (pure refactor; Task 4/5 add MCP coverage).

- [ ] **Step 3: Build** — `cargo build -p weftcut` → clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring_commands.rs
git commit -m "refactor(motifs): factor write_motif_draft_core + install_motif_core (reuse from MCP)"
```

---

### Task 2: Factor `capture_motif_frame_b64` core (Rust, no behavior change)

**Files:** Modify `apps/desktop/src-tauri/src/motifs/commands.rs`

- [ ] **Step 1: Extract the core** — move the body of `motif_capture_frame` into a function taking plain references (so the MCP tool can call it with `self.app.state()` derefs):

```rust
/// Capture one Motif frame as a base64 PNG. The whole render+CDP-screenshot path,
/// callable from both the Tauri command and the MCP `preview_motif_draft` tool.
/// Errors (as String) if the runtime isn't registered (no live webview) — the
/// caller surfaces it rather than hanging.
pub async fn capture_motif_frame_b64(
    app: &AppHandle,
    runtime: &MotifRuntime,
    capture: &MotifCapture,
    store: &super::store::UserMotifStore,
    motif_id: &str,
    t_sec: f64,
    props_json: &str,
    width: u32,
    height: u32,
    settle_rafs: Option<u32>,
) -> Result<String, String> {
    // … the EXISTING body of `motif_capture_frame`, verbatim, with `state`/`capture`/
    // `store` replaced by the `&`-params and `motif_id`/`props_json` as `&str`.
}

#[tauri::command]
pub async fn motif_capture_frame(
    app: AppHandle,
    state: State<'_, MotifRuntime>,
    capture: State<'_, MotifCapture>,
    store: State<'_, super::store::UserMotifStore>,
    motif_id: String,
    t_sec: f64,
    props_json: String,
    width: u32,
    height: u32,
    settle_rafs: Option<u32>,
) -> Result<String, String> {
    capture_motif_frame_b64(&app, &state, &capture, &store, &motif_id, t_sec, &props_json, width, height, settle_rafs).await
}
```

(Confirm the exact `MotifRuntime`/`MotifCapture` type paths from the current command signature; the core takes `&` of each. The `capture.0.lock().await` etc. work the same with `&MotifCapture`.)

- [ ] **Step 2: Build + existing capture path intact** — `cargo build -p weftcut` → clean. (The capture path is e2e-validated later; here the gate is a clean build proving the signature/types line up.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/commands.rs
git commit -m "refactor(motifs): factor capture_motif_frame_b64 core (reuse from MCP preview)"
```

---

### Task 3: Make the MCP `list_motifs` + `motifs://current` user-aware (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/mcp/mod.rs`

- [ ] **Step 1: Implement** — change `templates_payload()` callers (or the `list_motifs` tool + the `URI_MOTIFS` resource arm) to use the store-backed list. Add a helper on the server (it has `self.app`):

```rust
fn motifs_payload(&self) -> Vec<serde_json::Value> {
    let store = self.app.state::<crate::motifs::store::UserMotifStore>();
    crate::commands::list_motifs_inner(&store)
}
```

In the `list_motifs` tool: `ok_json(&self.motifs_payload())`. In `read_resource`'s `URI_MOTIFS` arm: `serde_json::to_value(self.motifs_payload()).map_err(serialize_err)?`. Update the tool's `#[tool(description=…)]` to drop the "fixed per build / built-ins only" caveat and say it now includes installed + draft user motifs with a `status` field. (Keep `templates_payload()` if other call sites still need the builtins-only form; otherwise remove it.)

- [ ] **Step 2: Build** — `cargo build -p weftcut` → clean. (`list_motifs_inner` is `pub(crate)` — reachable from `crate::commands`.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): list_motifs + motifs://current include user motifs + status"
```

---

### Task 4: Make the MCP `add_motif` resolve user motifs (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/mcp/mod.rs`

- [ ] **Step 1: Implement** — in the `add_motif` tool, replace the builtins-only resolution with builtins-then-store:

```rust
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        let motif = catalog::builtins()
            .into_iter()
            .find(|t| t.id() == args.motif_id)
            .or_else(|| store.get_motif(&args.motif_id))
            .ok_or_else(|| McpError::invalid_params(
                format!("unknown motif_id '{}' — call list_motifs for the catalog", args.motif_id),
                None,
            ))?;
```

(The rest of the tool — canonicalize, t_end resolution, track, add_layer — is unchanged. `store.get_motif` returns the published-then-draft `Motif`, so agents can place drafts + installed motifs.)

- [ ] **Step 2: Build** — `cargo build -p weftcut` → clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): add_motif resolves user motifs (place drafts + installed)"
```

---

### Task 5: MCP `get_motif_source` + `delete_motif` tools (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/mcp/mod.rs`

- [ ] **Step 1: Add the arg struct + tools** in the `#[tool(tool_box)] impl` block:

```rust
    #[tool(description = "Read a Motif's source { manifest, html } — any built-in, installed, or draft. \
                          Read before editing to seed your changes. `id` from `list_motifs`.")]
    async fn get_motif_source(&self, #[tool(aggr)] args: MotifIdArgs) -> Result<CallToolResult, McpError> {
        // built-in first, then the user store (published-then-draft).
        if let Some(m) = catalog::builtins().into_iter().find(|m| m.id() == args.id) {
            return ok_json(&serde_json::json!({ "manifest": m.manifest, "html": m.html }));
        }
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        let m = store.get_motif(&args.id)
            .ok_or_else(|| McpError::invalid_params(format!("unknown motif id '{}'", args.id), None))?;
        ok_json(&serde_json::json!({ "manifest": m.manifest, "html": m.html }))
    }

    #[tool(description = "Delete an installed or draft user Motif by id. Built-ins are rejected. \
                          Placed layers referencing it degrade to an error placeholder.")]
    async fn delete_motif(&self, #[tool(aggr)] args: MotifIdArgs) -> Result<CallToolResult, McpError> {
        if catalog::BUILTIN_IDS.contains(&args.id.as_str()) {
            return Err(McpError::invalid_params(format!("cannot delete the built-in Motif '{}'", args.id), None));
        }
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        store.delete_user_motif(&args.id).map_err(|e| McpError::internal_error(e.to_string(), None))?;
        crate::motifs::authoring_commands::emit_motifs_changed_via(&self.app); // see note
        Ok(ok_void())
    }
```

Add the shared arg struct (in the args-structs section):

```rust
#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotifIdArgs {
    /// The Motif id (from `list_motifs`).
    pub id: String,
}
```

> NOTE on emit: `emit_motifs_changed` in `authoring_commands.rs` is private + takes `&AppHandle`. Make it `pub` (rename optional) so the MCP tools can call it — `pub fn emit_motifs_changed(app: &AppHandle)`. Then the MCP tools call `crate::motifs::authoring_commands::emit_motifs_changed(&self.app)` after a mutating op (so the human UI's picker/catalog refresh when an agent changes things — the UI-actor-bridge principle). Apply this to delete/write/install MCP tools.

- [ ] **Step 2: Build** — `cargo build -p weftcut` → clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/mod.rs apps/desktop/src-tauri/src/motifs/authoring_commands.rs
git commit -m "feat(mcp): get_motif_source + delete_motif tools"
```

---

### Task 6: MCP `write_motif_draft` + `install_motif` tools (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/mcp/mod.rs`

- [ ] **Step 1: Add arg structs + tools:**

```rust
#[derive(Debug, Deserialize, JsonSchema)]
pub struct WriteMotifDraftArgs {
    /// Optional id of an existing Motif this draft will UPDATE on install (records
    /// it as the draft's target). Omit for a brand-new Motif (installs as new).
    pub from: Option<String>,
    /// The manifest (id/version are ignored + app-assigned). Must satisfy the
    /// Manifest schema; see a built-in via `get_motif_source` for the shape.
    pub manifest: crate::motifs::catalog::Manifest,
    /// The HTML body (the manifest island is injected by the app; a `<script>
    /// motif.define({...})</script>` drives the render).
    pub html: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct InstallMotifArgs {
    pub draft_id: String,
    /// "new" (publish under the draft's own id) or "update" (republish over the
    /// draft's recorded target — fails if the draft has no target).
    pub mode: String,
}
```

```rust
    #[tool(description = "Write a Motif draft from { manifest, html }. Returns the draft id. The draft is \
                          placeable immediately (via add_motif) for preview and editable via write again. \
                          `from` (optional) records an existing Motif as the Update target. Author the \
                          manifest's props_schema to expose tweakable controls; id/version are app-assigned.")]
    async fn write_motif_draft(&self, #[tool(aggr)] args: WriteMotifDraftArgs) -> Result<CallToolResult, McpError> {
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        let id = crate::motifs::authoring_commands::write_motif_draft_core(
            &store, args.manifest, &args.html, args.from.as_deref(),
        ).map_err(|e| McpError::invalid_params(e, None))?;
        crate::motifs::authoring_commands::emit_motifs_changed(&self.app);
        Ok(ok_text(id))
    }

    #[tool(description = "Install a draft: mode 'new' publishes under the draft's own id; 'update' republishes \
                          over the draft's recorded target (bumps its version; all placements re-render). \
                          Returns the published id.")]
    async fn install_motif(&self, #[tool(aggr)] args: InstallMotifArgs) -> Result<CallToolResult, McpError> {
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        let mode = match args.mode.as_str() {
            "new" => crate::motifs::authoring_commands::InstallMode::New,
            "update" => {
                let target = store.read_draft_target(&args.draft_id).ok_or_else(|| McpError::invalid_params(
                    format!("draft '{}' has no Update target — use mode 'new' or write it with `from`", args.draft_id), None))?;
                crate::motifs::authoring_commands::InstallMode::Update { target_id: target }
            }
            other => return Err(McpError::invalid_params(format!("mode must be 'new' or 'update', got '{other}'"), None)),
        };
        let install_args = crate::motifs::authoring_commands::InstallArgs { draft_id: args.draft_id, mode };
        let published = crate::motifs::authoring_commands::install_motif_core(
            &store, &self.project, &install_args,
        ).await.map_err(|e| McpError::internal_error(e, None))?;
        crate::motifs::authoring_commands::emit_motifs_changed(&self.app);
        Ok(ok_text(published))
    }
```

(`self.project` is the `ProjectHandle` field — confirm the field name. `InstallArgs`/`InstallMode` must be `pub`. The MCP `install_motif` resolves the target from the sidecar so the agent only passes `"update"` — the target is the one recorded at `write` time via `from`.)

- [ ] **Step 2: Build** — `cargo build -p weftcut` → clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): write_motif_draft {from} + install_motif tools"
```

---

### Task 7: MCP `preview_motif_draft` tool (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/mcp/mod.rs`

- [ ] **Step 1: Add arg struct + tool:**

```rust
#[derive(Debug, Deserialize, JsonSchema)]
pub struct PreviewMotifDraftArgs {
    /// Motif id (draft / installed / built-in).
    pub id: String,
    /// Content time in seconds to render (e.g. 0 = first frame).
    pub t_sec: f64,
    /// Optional render width/height (default = the motif's manifest size).
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Optional props (JSON object) to render with; defaults to the manifest defaults.
    pub props: Option<serde_json::Value>,
}
```

```rust
    #[tool(description = "Render one frame of a Motif (draft/installed/built-in) and return it as a base64 PNG \
                          so you can SEE your output and self-correct. Requires the app's preview to be live; \
                          returns an error if the render runtime isn't ready.")]
    async fn preview_motif_draft(&self, #[tool(aggr)] args: PreviewMotifDraftArgs) -> Result<CallToolResult, McpError> {
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        // Resolve the motif for its default size + props canonicalization.
        let motif = catalog::builtins().into_iter().find(|m| m.id() == args.id)
            .or_else(|| store.get_motif(&args.id))
            .ok_or_else(|| McpError::invalid_params(format!("unknown motif id '{}'", args.id), None))?;
        let (dw, dh) = motif.size();
        let width = args.width.unwrap_or(dw);
        let height = args.height.unwrap_or(dh);
        let provided = args.props.unwrap_or_else(|| serde_json::Value::Object(Default::default()));
        let props_json = motif.canonicalize_props(&provided)
            .map_err(|e| McpError::invalid_params(format!("invalid props: {e}"), None))?;
        let runtime = self.app.state::<crate::motifs::MotifRuntime>();
        let capture = self.app.state::<crate::motifs::MotifCapture>();
        let b64 = crate::motifs::commands::capture_motif_frame_b64(
            &self.app, &runtime, &capture, &store, &args.id, args.t_sec, &props_json, width, height,
            motif.manifest.settle_rafs,
        ).await.map_err(|e| McpError::internal_error(e, None))?;
        ok_json(&serde_json::json!({ "png_base64": b64, "width": width, "height": height }))
    }
```

(Confirm the `MotifRuntime`/`MotifCapture` type paths + that `Motif::canonicalize_props` returns the canonical JSON string + `manifest.settle_rafs` exists. If rmcp 0.1.x exposes `Content::image(base64, "image/png")`, prefer returning that as the content block instead of JSON base64 — gives the agent a real image; otherwise the base64-in-JSON is the safe form.)

- [ ] **Step 2: Build** — `cargo build -p weftcut` → clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): preview_motif_draft tool (base64 PNG of a frame)"
```

---

### Task 8: e2e + final review + finish

- [ ] **Step 1: Real-WebView2 / MCP verification.** Rebuild `tauri dev`. The MCP tools are reachable in-process; drive them via the dev MCP bridge or by invoking the underlying cores through the tauri-mcp-server (`webview_execute_js` calling the Tauri commands is the human path; for the MCP path, exercise the tool functions). Minimum checks:
  1. `list_motifs` (MCP) now returns user motifs with `status` (write a draft first, confirm it appears).
  2. `write_motif_draft {manifest, html}` → draft id; `add_motif` that draft → places + renders.
  3. `write_motif_draft {from: <installed>, …}` → the draft records the target; `install_motif {mode:"update"}` republishes over it (version bumps); `install_motif {mode:"new"}` on a no-`from` draft publishes under its own id.
  4. `preview_motif_draft {id, t_sec}` → returns a base64 PNG (decode + confirm non-empty / expected color); confirms the agent see-loop works against the live webview.
  5. `delete_motif` → gone; built-in rejected.
  6. Clean up test motifs.
  Record outcomes.

- [ ] **Step 2: Final review** — run `cargo test -p weftcut` (all pass, incl. the unchanged authoring_commands tests proving the refactor is behavior-preserving) + `cargo build -p weftcut` (the MCP server compiles). Dispatch a whole-branch review focused on: the two factorings being behavior-preserving (commands are thin wrappers), the MCP tools reaching state correctly + emitting `motifs:changed`, no rmcp 0.1.x signature mistakes, and `add_motif`/`list_motifs` now user-aware.

- [ ] **Step 3:** Use **superpowers:finishing-a-development-branch**.

---

## Self-Review

**1. Spec coverage (§9):** `list_motifs` extend → Task 3; `get_motif_source` → Task 5; `write_motif_draft {from}` → Task 6 (+core Task 1); `preview_motif_draft` → Task 7 (+core Task 2); `install_motif` → Task 6; `delete_motif` → Task 5; `add_motif` user-aware → Task 4; `motifs://current` mirrors → Task 3. "Validation warnings" deferred (stated). ✓

**2. Placeholder scan:** The two core factorings (Tasks 1–2) say "the EXISTING body of X, verbatim, minus app/emit" — that's an extraction instruction against concrete existing code, not a vague gap; the signatures + behavior are fully given. All MCP tool bodies are concrete (mirroring the seen `add_motif` pattern + the confirmed `ok_*` helpers). ✓

**3. Type consistency:** `write_motif_draft_core(store, manifest, html, from)` / `install_motif_core(store, handle, &InstallArgs)` / `capture_motif_frame_b64(app, runtime, capture, store, id, t_sec, props_json, w, h, settle)` — signatures match their call sites in Tasks 4–7. `MotifIdArgs` reused by get_motif_source + delete_motif. `emit_motifs_changed` made `pub` (Task 5 note) and called by write/install/delete MCP tools. `InstallArgs`/`InstallMode` reused (must be `pub`). ✓

**4. Soft spots for the implementer:**
- Tasks 1–2: confirm `InstallArgs`/`InstallMode`/`MotifRuntime`/`MotifCapture` visibility + exact type paths; the cores are pure extractions — the existing tests are the behavior-preservation gate.
- Task 5 note: make `emit_motifs_changed` `pub`.
- Task 6: confirm the `ProjectHandle` field name on `WeftCutServer` (`self.project`).
- Task 7: prefer `Content::image` if rmcp 0.1.x has it; else base64-in-JSON.
- rmcp is pinned 0.1.x — match the existing tool/arg macro shapes exactly; `cargo build` is the gate that catches macro/signature errors.
