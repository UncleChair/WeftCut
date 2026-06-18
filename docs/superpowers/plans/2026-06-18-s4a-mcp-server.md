# S4a — MCP server (TS SDK over Rust tool bodies) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Rust `rmcp` MCP server with a TypeScript `@modelcontextprotocol/sdk` streamable-HTTP server hosted in the Electron main process, keeping all tool/resource/prompt logic in Rust behind the napi `Backend`.

**Architecture:** The Rust `src/mcp/` module loses its rmcp transport and becomes a transport-free core: tool bodies are functions over `&Backend`, returning transport-agnostic wire types; a `catalog()` emits the tool/resource/prompt definitions (schemas via `schemars`). The napi `Backend` exposes `mcp_*` methods. The Electron main hosts the SDK server (streamable HTTP, bearer-enforced), owns the port + token, answers `get_mcp_info`/`reset_mcp_token`, and relays a new `mcp:change` event as MCP notifications.

**Tech Stack:** Rust (napi-rs v3, `serde`, `schemars`), TypeScript (`@modelcontextprotocol/sdk`, Electron 42), Playwright-for-Electron.

## Global Constraints

- **Branch:** `migration/electron-napi`. Never commit to `main`. Stage by explicit path (parallel sessions edit this checkout); re-check `git status` before each commit.
- **No `src/**` (renderer business-logic) edits.** `electron/**` (main + preload) and `e2e/**` and `src-tauri/**` (Rust) ARE editable. The `ConnectAgentPanel.tsx` / `McpInfoView` / `connect.*` locale fix is a **deferred follow-up**, NOT part of S4a.
- **Renderer contracts preserved verbatim:** `get_mcp_info → McpInfoView {bind, sse_url, message_url, events_url, bearer_token}` and `reset_mcp_token → string`. These are answered by the Electron **main** process (the server lives in Node now).
- **Spec:** `docs/superpowers/specs/2026-06-18-s4a-mcp-server-design.md`. Streamable-HTTP only; bearer **enforced**; change feed via in-protocol MCP notifications (no separate `/events`); cloud + motif tools deferred (S4b/S5).
- **napi addon package name:** `@weftcut/core` (`src-tauri/`); built via `npm run napi:build`. The addon outputs `src-tauri/index.js` + `index.d.ts` + `index.<triple>.node`.
- **Feature gating:** the `mcp` Cargo feature is OFF in today's addon build (`napi:build … --features jobs,export`), and `mcp/mod.rs` is currently **uncompilable** — it still imports `tauri` (removed in S2) and `crate::jobs`/`crate::cloud`. So there is no green `--features mcp` baseline before Task 2; Task 2 is the first commit where mcp compiles again. The S4a-active MCP surface calls `crate::jobs`/`crate::commands::media` (import_media, detect_silences, audio-meter, media resources), so **all mcp build/test commands use `--features jobs,export,mcp`** (the canonical addon set + mcp), NOT bare `--features mcp`. The addon build `--features jobs,export` (mcp OFF) must stay green at every commit.
- **PowerShell note (Windows):** the project's shell is PowerShell; run e2e single-specs as `npx playwright test e2e/electron/<spec>.spec.ts` (Playwright honors the path arg, unlike the wdio `--spec` gotcha).

---

### Task 1: Transport-agnostic MCP wire types

**Files:**
- Create: `apps/desktop/src-tauri/src/mcp/wire.rs`
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs` (add `mod wire; pub(crate) use wire::*;` near the top, after the existing `mod` declarations)
- Test: inline `#[cfg(test)] mod tests` in `wire.rs`

**Interfaces:**
- Produces (consumed by Tasks 2–3):
  - `McpToolError { code: McpErrorCode, message: String, data: Option<Value> }` with constructors `invalid_params/invalid_request/internal_error/resource_not_found(msg, Option<Value>)`; implements `Display + std::error::Error`.
  - `McpErrorCode { InvalidParams, InvalidRequest, NotFound, Internal }`.
  - `ToolResult { content: Vec<ContentBlock>, is_error: bool }` with `text(s)`, `json(&T)->Result<Self,McpToolError>`, `empty()`.
  - `ContentBlock::{ Text{text}, Image{data, mime_type} }`.
  - `ResourceResult { contents: Vec<ResourceContent> }`; `ResourceContent::{ Text{uri,mime_type,text}, Blob{uri,mime_type,blob} }`.
  - `ToolDef { name, description, input_schema: Value }`, `ResourceDef { uri, name, description, mime_type }`, `PromptArgDef { name, description: Option<String>, required: bool }`, `PromptDef { name, description: Option<String>, arguments: Vec<PromptArgDef> }`, `McpCatalog { tools, resources, prompts }`.
  - `PromptResult { description: Option<String>, messages: Vec<PromptMessage> }`, `PromptMessage { role: PromptRole, content: ContentBlock }`, `PromptRole::{ User, Assistant }`.
  - `reply<T: Serialize>(Result<T, McpToolError>) -> String` (the napi envelope `{"ok":true,"result":…}` / `{"ok":false,"error":…}`).

- [ ] **Step 1: Write `wire.rs` with the failing serde-shape tests**

```rust
//! Transport-agnostic MCP wire types. Serialize to the exact JSON shapes the
//! `@modelcontextprotocol/sdk` low-level Server expects, so the TS layer can
//! forward Rust output verbatim (no re-shaping). Replaces rmcp's model types.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpErrorCode {
    InvalidParams,
    InvalidRequest,
    NotFound,
    Internal,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpToolError {
    pub code: McpErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl McpToolError {
    pub fn invalid_params(msg: impl Into<String>, data: Option<Value>) -> Self {
        Self { code: McpErrorCode::InvalidParams, message: msg.into(), data }
    }
    pub fn invalid_request(msg: impl Into<String>, data: Option<Value>) -> Self {
        Self { code: McpErrorCode::InvalidRequest, message: msg.into(), data }
    }
    pub fn internal_error(msg: impl Into<String>, data: Option<Value>) -> Self {
        Self { code: McpErrorCode::Internal, message: msg.into(), data }
    }
    pub fn resource_not_found(msg: impl Into<String>, data: Option<Value>) -> Self {
        Self { code: McpErrorCode::NotFound, message: msg.into(), data }
    }
}

impl std::fmt::Display for McpToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for McpToolError {}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContentBlock {
    Text { text: String },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolResult {
    pub content: Vec<ContentBlock>,
    #[serde(rename = "isError", skip_serializing_if = "is_false")]
    pub is_error: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl ToolResult {
    pub fn text(s: impl Into<String>) -> Self {
        Self { content: vec![ContentBlock::Text { text: s.into() }], is_error: false }
    }
    pub fn json<T: Serialize>(v: &T) -> Result<Self, McpToolError> {
        let s = serde_json::to_string(v)
            .map_err(|e| McpToolError::internal_error(format!("serialize result: {e}"), None))?;
        Ok(Self::text(s))
    }
    pub fn empty() -> Self {
        Self { content: vec![], is_error: false }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ResourceContent {
    Text {
        uri: String,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        text: String,
    },
    Blob {
        uri: String,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        blob: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceResult {
    pub contents: Vec<ResourceContent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceDef {
    pub uri: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptArgDef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptDef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub arguments: Vec<PromptArgDef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpCatalog {
    pub tools: Vec<ToolDef>,
    pub resources: Vec<ResourceDef>,
    pub prompts: Vec<PromptDef>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptMessage {
    pub role: PromptRole,
    pub content: ContentBlock,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub messages: Vec<PromptMessage>,
}

/// The napi-method envelope: a uniform `{ok, result|error}` JSON so the napi
/// boundary is infallible (always `Ok(String)`); the TS side throws an SDK
/// error when `ok` is false.
pub fn reply<T: Serialize>(r: Result<T, McpToolError>) -> String {
    match r {
        Ok(v) => serde_json::json!({ "ok": true, "result": v }).to_string(),
        Err(e) => serde_json::json!({ "ok": false, "error": e }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_result_text_shape() {
        let v = serde_json::to_value(ToolResult::text("pong")).unwrap();
        assert_eq!(v, serde_json::json!({ "content": [{ "type": "text", "text": "pong" }] }));
    }

    #[test]
    fn tool_result_json_is_text_block_with_serialized_json() {
        let r = ToolResult::json(&serde_json::json!({ "a": 1 })).unwrap();
        let v = serde_json::to_value(r).unwrap();
        assert_eq!(v["content"][0]["type"], "text");
        // JSON results travel as a text block whose text is the serialized JSON.
        assert_eq!(v["content"][0]["text"], "{\"a\":1}");
    }

    #[test]
    fn blob_resource_shape() {
        let rr = ResourceResult {
            contents: vec![ResourceContent::Blob {
                uri: "media://x/thumbnail".into(),
                mime_type: Some("image/jpeg".into()),
                blob: "QUJD".into(),
            }],
        };
        let v = serde_json::to_value(rr).unwrap();
        assert_eq!(
            v["contents"][0],
            serde_json::json!({ "uri": "media://x/thumbnail", "mimeType": "image/jpeg", "blob": "QUJD" })
        );
    }

    #[test]
    fn error_reply_envelope() {
        let s = reply::<ToolResult>(Err(McpToolError::invalid_params("bad", None)));
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "invalid_params");
        assert_eq!(v["error"]["message"], "bad");
    }

    #[test]
    fn prompt_message_shape() {
        let m = PromptMessage { role: PromptRole::User, content: ContentBlock::Text { text: "hi".into() } };
        let v = serde_json::to_value(m).unwrap();
        assert_eq!(v, serde_json::json!({ "role": "user", "content": { "type": "text", "text": "hi" } }));
    }
}
```

- [ ] **Step 2: Wire the module into `mcp/mod.rs`**

Add near the top of `mcp/mod.rs`, alongside the existing `mod events; mod keyframes; mod prompts;` (Task 2 will rework those lines; for now just add):
```rust
mod wire;
pub(crate) use wire::*;
```

- [ ] **Step 3: Run the tests (must compile the mcp module under its feature)**

Run: `cd apps/desktop/src-tauri && cargo test --features mcp wire:: -- --nocapture`
Expected: the 5 `wire::tests::*` PASS. (If the broader `mcp` module fails to compile because Task 2 hasn't run yet, scope the build with `cargo test --features mcp --lib wire` — but the wire module itself is self-contained and must pass.)

> Note: `mcp/mod.rs` today still uses rmcp and references `events`/etc.; it already compiles under `--features mcp`. Adding `wire` is purely additive, so the module still compiles. If a name clash on `Content`/`Error` arises, fully-qualify in `wire.rs` (it imports nothing from rmcp).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/wire.rs apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "migrate(s4a): transport-agnostic MCP wire types"
```

---

### Task 2: Convert the MCP core off rmcp (the central refactor)

This is the large, atomic task: remove rmcp/axum, turn tool methods into `&Backend` functions returning `wire` types, port resources/prompts/keyframes, add the catalog+dispatch table, and delete the transport + the cloud/motif tools (re-added in S4b/S5 from git). The deliverable is a green `cargo build/test --features mcp` AND a green default `cargo build` (addon features).

**Files:**
- Modify (heavily): `apps/desktop/src-tauri/src/mcp/mod.rs`
- Modify: `apps/desktop/src-tauri/src/mcp/keyframes.rs`, `apps/desktop/src-tauri/src/mcp/prompts.rs`
- Create: `apps/desktop/src-tauri/src/mcp/tools.rs` (the `&Backend` tool functions), `apps/desktop/src-tauri/src/mcp/resources.rs` (resource readers), `apps/desktop/src-tauri/src/mcp/catalog.rs` (the `tool_table!` macro + `catalog()`)
- Delete: `apps/desktop/src-tauri/src/mcp/events.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (module decl), `apps/desktop/src-tauri/Cargo.toml` (drop `rmcp`, `axum`; the `ChangeEventSummary` types move into `mcp`)

**Interfaces:**
- Consumes: `wire::*` (Task 1); `Backend` fields (`project()`, `cache`, `events`, `log_slot`, `agent_session`, and under `jobs`: `import_queue`, `audio_meter`).
- Produces (consumed by Task 3):
  - `pub(crate) async fn dispatch_tool(b: &Backend, name: &str, args_json: &str) -> Result<ToolResult, McpToolError>`
  - `pub(crate) async fn read_resource(b: &Backend, uri: &str) -> Result<ResourceResult, McpToolError>`
  - `pub(crate) fn tool_catalog() -> Vec<ToolDef>`, `pub(crate) fn resource_catalog() -> Vec<ResourceDef>`, `pub(crate) fn prompt_catalog() -> Vec<PromptDef>`, `pub(crate) fn catalog() -> McpCatalog`
  - `pub(crate) fn list_prompts() -> Vec<PromptDef>` (== `prompt_catalog()`), `pub(crate) fn get_prompt(name: &str, args: &Value) -> Result<PromptResult, McpToolError>`
  - `pub(crate) struct ChangeEventSummary` (moved from `events.rs`) with `From<&ChangeEvent>` (used by Task 3's `mcp:change`).

**The transform rules (apply mechanically; tool/resource BODIES are otherwise byte-identical to the pre-S4a `mcp/mod.rs`):**

| rmcp / Tauri form | new form |
|---|---|
| `async fn <name>(&self, #[tool(aggr)] args: A) -> Result<CallToolResult, McpError>` | `pub(super) async fn <name>(b: &Backend, args: A) -> Result<ToolResult, McpToolError>` (in `tools.rs`) |
| `async fn <name>(&self) -> Result<CallToolResult, McpError>` (no args) | `pub(super) async fn <name>(b: &Backend, _args: EmptyArgs) -> Result<ToolResult, McpToolError>` |
| `self.project` | `b.project()?` |
| `self.cache` | `&b.cache` |
| `self.app.state::<crate::commands::media::AudioMeterState>()` / audio meter | `&b.audio_meter` (under `#[cfg(feature="jobs")]`) |
| `self.app.try_state::<crate::agent_session::AgentSessionSlot>()` → slot | `&b.agent_session` |
| `crate::agent_session::begin_and_emit(&self.app, slot.inner(), s)` | `crate::agent_session::begin_and_emit_sink(b.events.as_ref(), &b.agent_session, s)` — see Step 4 note (a thin EventSink-based twin; if one already exists for the napi command path, reuse it) |
| `crate::logs::emit_via_app(&self.app, e)` | `b.log_slot.emit(e)` |
| `jobs::enqueue_for_media(self.app.clone(), self.cache.clone(), self.project.clone(), m)` | the napi enqueue used by `crate::commands::media` (grep `enqueue_for_media` in `commands/media.rs` for the `&Backend` call form) — N/A in S4a (only `synthesize_speech` used it; that tool is deferred) |
| `ok_text(x)` | `Ok(ToolResult::text(x))` |
| `ok_json(&v)` | `ToolResult::json(&v)` (already returns `Result`) |
| `Ok(ok_void())` | `Ok(ToolResult::empty())` |
| `McpError::invalid_params(m, d)` etc. | `McpToolError::invalid_params(m, d)` etc. (constructors match 1:1) |
| `map_command_error` / `map_cloud_error` / `parse_uuid` / `parse_layer_edge` / `agent_actor` / `sniff_subtitle_format` / `detect_silences_in_peaks` | keep verbatim in `tools.rs` (or a `tools/util.rs`), only swapping `McpError`→`McpToolError` in their signatures |

- [ ] **Step 1: Add `EmptyArgs` + move `ChangeEventSummary` types**

In `mcp/mod.rs` (or a small `mcp/types.rs`), add:
```rust
#[derive(Debug, Clone, serde::Deserialize, schemars::JsonSchema, Default)]
pub(crate) struct EmptyArgs {}
```
Move `ChangeEventSummary`, `EntityRef`-using projection, and the `From<&ChangeEvent>` impl out of the to-be-deleted `events.rs` into `mcp/mod.rs` (the `EventsInfo` struct and the axum `serve`/SSE handler are DELETED, not moved). Keep only:
```rust
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChangeEventSummary {
    pub op_id: crate::state::OpId,
    pub actor: crate::state::Actor,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub summary: String,
    pub affected: Vec<crate::state::actor::EntityRef>,
    pub diff_hint: crate::state::actor::DiffHint,
}
impl From<&crate::state::actor::ChangeEvent> for ChangeEventSummary {
    fn from(e: &crate::state::actor::ChangeEvent) -> Self {
        Self { op_id: e.op_id, actor: e.actor.clone(), timestamp: e.timestamp,
                summary: e.summary.clone(), affected: e.affected.clone(), diff_hint: e.diff_hint }
    }
}
```
(Confirm the exact paths for `OpId`/`EntityRef`/`DiffHint`/`ChangeEvent` — they live in `state/actor.rs` per the map; re-export through `crate::state` if that's the existing convention.)

- [ ] **Step 2: Create `tools.rs` — move every S4a-active tool body**

Move these tool functions (verbatim bodies, transform table applied) into `tools.rs` as `pub(super) async fn <name>(b: &Backend, args: <Args>) -> Result<ToolResult, McpToolError>`. Keep each tool's `#[tool(aggr)]` Args struct (drop the attribute; keep `#[derive(Deserialize, JsonSchema)]`) — move the structs into `tools.rs` too:

`ping, begin_agent_session, add_track, remove_track, move_track, add_color_layer, add_video_layer, apply_subtitles, update_layer, update_layer_params, move_layer, split_layer, delete_layer, trim_layer, duplicate_layer, groups_list, groups_get, groups_create, groups_dissolve, groups_add_members, groups_remove_members, groups_rename, set_composition, fit_composition_to_layers, add_marker, update_marker, remove_marker, import_media, remove_media, detect_silences, undo, redo, lock_history, unlock_history, checkpoint, list_checkpoints, restore_checkpoint, dry_run, set_role_gain, set_role_flags`

The 8 keyframe tools (`get_param_track, set_keyframe, remove_keyframe, retime_keyframe, set_keyframe_easing, smooth_keyframes, clear_keyframes, set_param_track`) stay thin wrappers delegating to `keyframes::*` (Step 5).

Also move the shared helpers (`agent_actor, parse_uuid, parse_layer_edge, sniff_subtitle_format, detect_silences_in_peaks, push_if_long_enough, map_command_error, ensure_audio_track, ensure_subtitle_track`, the `SubFormat` enum, the arg/result structs like `SplitLayerResult`, `GroupView`, `SynthesizeSpeechResult` (drop the last — synth deferred)) into `tools.rs`, swapping `McpError`→`McpToolError`.

**Worked example (`ping` + `add_track`) — the pattern for all:**
```rust
// tools.rs
use serde_json::Value;
use crate::napi_backend::Backend;
use crate::state::Actor;
use super::wire::{McpToolError, ToolResult};
use super::EmptyArgs;

pub(super) fn agent_actor() -> Actor {
    Actor::Agent { client: "mcp".to_string() }
}

pub(super) async fn ping(_b: &Backend, _args: EmptyArgs) -> Result<ToolResult, McpToolError> {
    Ok(ToolResult::text("pong"))
}

#[derive(Debug, Clone, serde::Deserialize, schemars::JsonSchema)]
pub(super) struct AddTrackArgs {
    pub label: Option<String>,
}

pub(super) async fn add_track(b: &Backend, args: AddTrackArgs) -> Result<ToolResult, McpToolError> {
    let id = b.project()?
        .add_track(agent_actor(), args.label)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::text(id.to_string()))
}
```
(Every other tool follows identically — copy its pre-S4a body, apply the transform table. `map_command_error` keeps its exact match on `CommandError::ValidationFailed(LayerOverlap{..})` from the pre-S4a source.)

- [ ] **Step 3: Create `resources.rs` — port the 12 resource readers**

Move `read_resource`'s dispatch + `read_media_resource`, `serve_thumbnail`, `serve_frame`, `serve_waveform`, `blob_response`, and `STATIC_RESOURCES` into `resources.rs`. Drop the `motifs://current` arm + its `STATIC_RESOURCES` entry (deferred to S5). Convert:
- the rmcp `ReadResourceResult { contents: vec![ResourceContents::TextResourceContents{..}] }` → `ResourceResult { contents: vec![ResourceContent::Text{ uri, mime_type: Some(APP_JSON.into()), text }] }`.
- `blob_response` → returns `ResourceResult { contents: vec![ResourceContent::Blob{ uri, mime_type: Some(mime), blob }] }`.
- `read_resource(&self, uri)` → `pub(super) async fn read_resource(b: &Backend, uri: &str) -> Result<ResourceResult, McpToolError>`; `self.project`→`b.project()?`, `self.cache`→`&b.cache`, audio-meter access → `&b.audio_meter` (`#[cfg(feature="jobs")]`).

Each JSON resource (e.g. `project://current`) becomes:
```rust
fn json_resource(uri: &str, v: &impl serde::Serialize) -> Result<ResourceResult, McpToolError> {
    let text = serde_json::to_string(v)
        .map_err(|e| McpToolError::internal_error(format!("serialize {uri}: {e}"), None))?;
    Ok(ResourceResult { contents: vec![ResourceContent::Text {
        uri: uri.to_string(), mime_type: Some(APP_JSON.to_string()), text,
    }] })
}
```

- [ ] **Step 4: Port `keyframes.rs` and `prompts.rs` to the new types**

`keyframes.rs`: change `use rmcp::Error as McpError;` → `use super::wire::McpToolError as McpError;` (alias keeps the body unchanged) — the file's functions already return `Result<_, KfError>` and `kf_error_to_mcp` returns `McpError`; only the alias target changes. Confirm `super::map_command_error` is now in `tools.rs` and re-pathed (`super::tools::map_command_error`).

`prompts.rs`: replace the rmcp imports (`GetPromptResult, Prompt, PromptArgument, PromptMessage, PromptMessageRole, McpError`) with `super::wire::{PromptDef, PromptArgDef, PromptResult, PromptMessage, PromptRole, ContentBlock, McpToolError}`. Rewrite `catalog() -> Vec<PromptDef>` and `expand(name, args) -> Result<PromptResult, McpToolError>`. **Port only the `cut-silences` prompt**; drop `auto-caption` and `voiceover` (they reference the deferred cloud tools — re-added in S4b). Example:
```rust
pub(super) fn catalog() -> Vec<PromptDef> {
    vec![PromptDef {
        name: "cut-silences".into(),
        description: Some("Detect and remove silent regions in a clip.".into()),
        arguments: vec![
            PromptArgDef { name: "layer_id".into(), description: Some("Layer to trim".into()), required: true },
            PromptArgDef { name: "threshold_amp".into(), description: Some("Silence amplitude threshold (default 0.02)".into()), required: false },
            PromptArgDef { name: "min_silence_us".into(), description: Some("Min silence length µs (default 500000)".into()), required: false },
        ],
    }]
}
pub(super) fn expand(name: &str, args: Option<&serde_json::Map<String, Value>>) -> Result<PromptResult, McpToolError> {
    match name {
        "cut-silences" => Ok(expand_cut_silences(args)), // body ported verbatim, building PromptMessage{role:User, content:ContentBlock::Text{..}}
        other => Err(McpToolError::invalid_params(format!("unknown prompt '{other}'"), None)),
    }
}
```

> Note on `begin_and_emit_sink`: the pre-S4a `begin_agent_session` calls `crate::agent_session::begin_and_emit(&self.app, slot, s)` which emits via Tauri. Add (or reuse, if the napi command path already has one) an EventSink-based twin `begin_and_emit_sink(events: &dyn EventSink, slot: &AgentSessionSlot, s: AgentSession) -> Option<AgentSession>` in `agent_session.rs` that emits `agent_session:changed` through the sink. Grep `agent_session` in `commands/` first — S2 wired `agent_session_get/end`, so the sink-emit helper likely already exists; reuse it.

- [ ] **Step 5: Create `catalog.rs` with the `tool_table!` macro (single source for catalog + dispatch)**

```rust
//! One declarative table feeds BOTH `tool_catalog()` (the advertised schemas)
//! and `dispatch_tool()` (the name→handler match), so a tool can never appear
//! in one without the other.
use serde_json::Value;
use crate::napi_backend::Backend;
use super::wire::{McpToolError, ToolDef, ToolResult, ResourceDef, PromptDef, McpCatalog};
use super::{tools, resources, prompts};

macro_rules! tool_table {
    ( $( $name:literal => ($desc:expr, $args:ty, $handler:path) ),* $(,)? ) => {
        pub(crate) fn tool_catalog() -> Vec<ToolDef> {
            vec![ $(
                ToolDef {
                    name: $name.to_string(),
                    description: $desc.to_string(),
                    input_schema: serde_json::to_value(schemars::schema_for!($args))
                        .expect("schema serializes"),
                }
            ),* ]
        }
        pub(crate) async fn dispatch_tool(b: &Backend, name: &str, args_json: &str)
            -> Result<ToolResult, McpToolError>
        {
            match name {
                $( $name => {
                    let a: $args = serde_json::from_str(args_json)
                        .map_err(|e| McpToolError::invalid_params(
                            format!("invalid args for {}: {e}", $name), None))?;
                    $handler(b, a).await
                } )*
                other => Err(McpToolError::resource_not_found(
                    format!("unknown tool '{other}'"), None)),
            }
        }
    };
}

tool_table! {
    "ping" => ("Liveness check; returns 'pong'.", super::EmptyArgs, tools::ping),
    "add_track" => ("Add a kind-agnostic track. Returns the new track id.", tools::AddTrackArgs, tools::add_track),
    // … one line per S4a-active tool, description copied from the pre-S4a #[tool(description=…)] …
}

pub(crate) fn resource_catalog() -> Vec<ResourceDef> { resources::static_resources() }
pub(crate) fn prompt_catalog() -> Vec<PromptDef> { prompts::catalog() }
pub(crate) fn catalog() -> McpCatalog {
    McpCatalog { tools: tool_catalog(), resources: resource_catalog(), prompts: prompt_catalog() }
}
```
Fill the `tool_table!` with **every** S4a-active tool (the list from Step 2), each description copied verbatim from its old `#[tool(description = …)]` attribute. Tools with no args use `super::EmptyArgs`.

- [ ] **Step 6: Rewrite `mcp/mod.rs` to the new module shape + delete the transport**

`mcp/mod.rs` becomes a thin module root:
```rust
//! MCP tool surface (transport-free). The HTTP/streamable server lives in the
//! Electron main process; this module exposes tools/resources/prompts + a
//! catalog the napi Backend bridges. Design: docs/superpowers/specs/2026-06-18-s4a-mcp-server-design.md
mod wire;
mod tools;
mod resources;
mod prompts;
mod keyframes;
mod catalog;
pub(crate) use wire::*;
pub(crate) use catalog::{catalog, dispatch_tool, tool_catalog, resource_catalog, prompt_catalog};
pub(crate) use resources::read_resource;
pub(crate) use prompts::{catalog as list_prompts, expand as get_prompt};
// ChangeEventSummary + EmptyArgs defined here (Step 1).
```
**Delete** from the crate: `serve`, `regenerate_token(_at)`, `McpAuth`, `auth_file_path`, `load_auth`, `save_auth`, `random_token`, `pick_free_port`, `McpInfo`, `McpInfoCell`, `WeftCutServer`, the `#[tool(tool_box)]`/`ServerHandler` impls, `get_info`, `list_resources`/`list_prompts`/`get_prompt` trait methods, and **delete the file `mcp/events.rs`** entirely. Delete the **cloud tools** (`transcribe_clip`, `synthesize_speech`, `transcribe_clip_inner`, `map_cloud_error`, `resolve_clip_audio_source`, `write_voiceover_atomic`, `ResolvedAudioSource`, `TranscribeClipArgs`, `SynthesizeSpeechArgs`, `SynthesizeSpeechResult`) and the **motif tools** (`list_motifs`, `get_motif_source`, `write_motif_draft`, `preview_motif_draft`, `install_motif`, `delete_motif`, `add_motif`, `motifs_payload`, their Args structs). These are recoverable from git for S4b/S5.

- [ ] **Step 7: Fix `lib.rs` + `Cargo.toml`**

`lib.rs`: keep `#[cfg(feature = "mcp")] mod mcp;`. Remove any reference to the deleted `mcp::serve`/`McpInfoCell`/`mcp::events` (the map found none outside the module, but grep `mcp::` across `src/` to be sure).
`Cargo.toml`: delete the `rmcp = …` line and the `axum = "0.8"` line. Check whether `tokio-stream`/`futures` are now unused (grep across `src/` excluding the deleted code) — remove only if unused; keep otherwise. Keep `schemars`, `base64`.

- [ ] **Step 8: Build both feature sets + run the ported tests**

Run:
```
cd apps/desktop/src-tauri
cargo build --features jobs,export          # addon build (mcp OFF) — must stay green
cargo build --features jobs,export,mcp      # new mcp code — first mcp compile since S2
cargo test  --features jobs,export,mcp --lib   # ported mcp tests + wire::tests
```
Expected: all green. The pre-S4a `#[cfg(test)]` tests that lived in `mcp/mod.rs` move with their functions (into `tools.rs`/`resources.rs`); adjust their call sites to the new free-fn signatures (e.g. `WeftCutServer::new(...).add_track(...)` → build a `Backend::new_for_test` and call `tools::add_track(&b, args)`). If a test depended on a deleted cloud/motif tool, delete that test (its tool moved to S4b/S5).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/agent_session.rs
git rm apps/desktop/src-tauri/src/mcp/events.rs
git commit -m "migrate(s4a): MCP core off rmcp (tools as &Backend fns, catalog macro, drop transport)"
```

---

### Task 3: napi `Backend` MCP methods + `mcp:change` bridge

**Files:**
- Modify: `apps/desktop/src-tauri/src/napi_backend.rs`
- Test: inline `#[cfg(test)]` in `napi_backend.rs`

**Interfaces:**
- Consumes: `crate::mcp::{catalog, dispatch_tool, read_resource, list_prompts, get_prompt, reply, ChangeEventSummary}`.
- Produces (consumed by Task 5, visible in `index.d.ts`):
  - `Backend.mcpCatalog(): Promise<string>` — the `McpCatalog` JSON (infallible).
  - `Backend.mcpCallTool(name: string, argsJson: string): Promise<string>` — the `{ok,result|error}` envelope.
  - `Backend.mcpReadResource(uri: string): Promise<string>` — envelope.
  - `Backend.mcpListPrompts(): Promise<string>` — `PromptDef[]` JSON (infallible).
  - `Backend.mcpGetPrompt(name: string, argsJson: string): Promise<string>` — envelope.
  - New EventSink event `"mcp:change"` carrying `ChangeEventSummary` JSON.

- [ ] **Step 1: Add the napi methods (gated `#[cfg(feature="mcp")]`)**

In the `#[napi] impl Backend` block (after `invoke`):
```rust
#[cfg(feature = "mcp")]
#[napi]
pub async fn mcp_catalog(&self) -> napi::Result<String> {
    Ok(serde_json::to_string(&crate::mcp::catalog()).unwrap())
}

#[cfg(feature = "mcp")]
#[napi]
pub async fn mcp_call_tool(&self, name: String, args_json: String) -> napi::Result<String> {
    Ok(crate::mcp::reply(crate::mcp::dispatch_tool(self, &name, &args_json).await))
}

#[cfg(feature = "mcp")]
#[napi]
pub async fn mcp_read_resource(&self, uri: String) -> napi::Result<String> {
    Ok(crate::mcp::reply(crate::mcp::read_resource(self, &uri).await))
}

#[cfg(feature = "mcp")]
#[napi]
pub async fn mcp_list_prompts(&self) -> napi::Result<String> {
    Ok(serde_json::to_string(&crate::mcp::list_prompts()).unwrap())
}

#[cfg(feature = "mcp")]
#[napi]
pub async fn mcp_get_prompt(&self, name: String, args_json: String) -> napi::Result<String> {
    let args: serde_json::Value = serde_json::from_str(&args_json).unwrap_or(serde_json::json!({}));
    let obj = args.as_object().cloned().unwrap_or_default();
    Ok(crate::mcp::reply(crate::mcp::get_prompt(&name, &serde_json::Value::Object(obj.clone()).as_object().cloned().unwrap()).map(|p| p)))
}
```
(If `get_prompt`'s signature wants `Option<&Map>`, adapt the last method to pass `args.as_object()`.)

- [ ] **Step 2: Emit `mcp:change` in the actor→event bridge**

In `init()`'s `tokio::spawn` loop, inside the `Ok(event) =>` arm (after the existing `events.emit("project:changed", …)`), add:
```rust
#[cfg(feature = "mcp")]
{
    let summary = crate::mcp::ChangeEventSummary::from(&event);
    if let Ok(v) = serde_json::to_value(&summary) {
        events.emit("mcp:change", v);
    }
}
```

- [ ] **Step 3: Write the dispatch + catalog smoke tests**

Add to `napi_backend.rs` tests (gated `#[cfg(all(test, feature = "mcp"))]`):
```rust
#[cfg(feature = "mcp")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_catalog_lists_ping_and_add_track() {
    let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
    b.init().await.unwrap();
    let cat = b.mcp_catalog().await.unwrap();
    assert!(cat.contains("\"ping\""));
    assert!(cat.contains("\"add_track\""));
    // every tool advertises an object inputSchema
    let v: serde_json::Value = serde_json::from_str(&cat).unwrap();
    for t in v["tools"].as_array().unwrap() {
        assert!(t["inputSchema"].is_object(), "tool {} has no inputSchema", t["name"]);
    }
}

#[cfg(feature = "mcp")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_call_tool_add_track_grows_summary() {
    let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
    b.init().await.unwrap();
    let before: serde_json::Value =
        serde_json::from_str(&b.dispatch("project_summary", "{}").await.unwrap()).unwrap();
    let baseline = before["track_count"].as_u64().unwrap();
    let reply: serde_json::Value =
        serde_json::from_str(&b.mcp_call_tool("add_track".into(), "{}".into()).await.unwrap()).unwrap();
    assert_eq!(reply["ok"], true, "got {reply}");
    let after: serde_json::Value =
        serde_json::from_str(&b.dispatch("project_summary", "{}").await.unwrap()).unwrap();
    assert_eq!(after["track_count"].as_u64().unwrap(), baseline + 1);
}

#[cfg(feature = "mcp")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_call_tool_unknown_is_not_found() {
    let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
    b.init().await.unwrap();
    let reply: serde_json::Value =
        serde_json::from_str(&b.mcp_call_tool("no_such_tool".into(), "{}".into()).await.unwrap()).unwrap();
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"]["code"], "not_found");
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/desktop/src-tauri && cargo test --features jobs,export,mcp --lib mcp_`
Expected: the 3 `mcp_*` tests PASS (plus `wire::tests`). Also re-run `cargo build --features jobs,export` to confirm the `#[cfg(feature="mcp")]` gates keep the addon build (mcp OFF) green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/napi_backend.rs
git commit -m "migrate(s4a): Backend mcp_* napi methods + mcp:change bridge"
```

---

### Task 4: Build the addon with `mcp` + confirm the generated surface

**Files:**
- Modify: `apps/desktop/package.json` (the `napi:build` script's feature list)

**Interfaces:**
- Produces: `src-tauri/index.d.ts` declaring `mcpCatalog/mcpCallTool/mcpReadResource/mcpListPrompts/mcpGetPrompt`; the rebuilt `.node` addon used by the Electron main.

- [ ] **Step 1: Add `mcp` to the napi build features**

Change the `napi:build` script in `apps/desktop/package.json`:
```json
"napi:build": "napi build --platform --release --manifest-path src-tauri/Cargo.toml --output-dir src-tauri --features jobs,export,mcp",
```

- [ ] **Step 2: Rebuild the addon**

Run (PowerShell): `cd apps/desktop; npm run napi:build`
Expected: builds successfully; `src-tauri/index.win32-x64-msvc.node` + `index.js` + `index.d.ts` regenerate.

- [ ] **Step 3: Verify the generated TypeScript surface**

Run: `cd apps/desktop && rg "mcpCallTool|mcpCatalog|mcpReadResource|mcpListPrompts|mcpGetPrompt" src-tauri/index.d.ts`
Expected: all five method signatures present on `Backend`, each `(…): Promise<string>`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src-tauri/index.d.ts apps/desktop/src-tauri/index.js
git commit -m "migrate(s4a): enable mcp feature in addon build; regen napi surface"
```
(The `.node` binary is git-ignored if the repo ignores native artifacts — check `git status`; only stage what's tracked.)

---

### Task 5: Electron main MCP host (streamable HTTP + bearer + info handlers)

**Files:**
- Create: `apps/desktop/electron/main/mcp/auth.ts`, `apps/desktop/electron/main/mcp/server.ts`, `apps/desktop/electron/main/mcp/index.ts`
- Modify: `apps/desktop/electron/main/index.ts` (start host, info IPC, `mcp:change` tap)
- Modify: `apps/desktop/electron/preload/index.ts` (route `get_mcp_info`/`reset_mcp_token` to direct ipcMain)
- Modify: `apps/desktop/package.json` (+ `@modelcontextprotocol/sdk`, `express`)
- Modify: `apps/desktop/electron.vite.config.ts` (externalize `express` + sdk if needed for the main bundle)

**Interfaces:**
- Consumes: `Backend.mcp*` (Task 4); the `onEvent` `{event, payload}` stream (for `mcp:change`).
- Produces: a running `127.0.0.1:<port>/mcp` streamable server (bearer-enforced); IPC `get_mcp_info`→`McpInfoView`, `reset_mcp_token`→string; a startup log line with the connect snippet.

- [ ] **Step 0: Install the SDK and confirm its server API against the installed version**

Run (PowerShell): `cd apps/desktop; npm install @modelcontextprotocol/sdk express; npm install -D @types/express`
Then read the installed SDK's exports for the streamable server + low-level Server: `rg -l "StreamableHTTPServerTransport" node_modules/@modelcontextprotocol/sdk/dist` and skim its `.d.ts`. The code below targets the canonical API (`Server` from `…/server/index.js`, `StreamableHTTPServerTransport` from `…/server/streamableHttp.js`, request-schema constants from `…/types.js`). **If the installed version's signatures differ, adapt the snippets** — the architecture (one Express app, bearer middleware, transport per session, handlers forwarding to `backend.mcp*`) is the load-bearing part.

- [ ] **Step 1: `auth.ts` — token + port persistence (main owns it)**

```ts
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const AUTH_FILE = () => path.join(app.getPath('userData'), 'mcp_auth.json')

export interface McpAuth { token: string; port: number }

export function loadOrInitAuth(): McpAuth {
  try {
    const raw = fs.readFileSync(AUTH_FILE(), 'utf8')
    const a = JSON.parse(raw) as McpAuth
    if (a.token && typeof a.port === 'number') return a
  } catch { /* fall through to fresh */ }
  return { token: randomBytes(32).toString('hex'), port: 0 } // 0 → OS-pick at listen
}

export function saveAuth(a: McpAuth): void {
  try { fs.writeFileSync(AUTH_FILE(), JSON.stringify(a), 'utf8') } catch { /* best-effort */ }
}

export function rotateToken(a: McpAuth): McpAuth {
  const next = { ...a, token: randomBytes(32).toString('hex') }
  saveAuth(next)
  return next
}
```

- [ ] **Step 2: `server.ts` — the SDK Server wired to the Backend**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

type Backend = import('@weftcut/core').Backend

interface Envelope { ok: boolean; result?: unknown; error?: { code: string; message: string; data?: unknown } }

const CODE_MAP: Record<string, number> = {
  invalid_params: -32602, invalid_request: -32600, not_found: -32601, internal: -32603,
}

function unwrap(json: string): unknown {
  const env = JSON.parse(json) as Envelope
  if (env.ok) return env.result
  const err = env.error!
  // The SDK turns a thrown McpError into the JSON-RPC error response.
  const e = new Error(err.message) as Error & { code?: number; data?: unknown }
  e.code = CODE_MAP[err.code] ?? -32603
  e.data = err.data
  throw e
}

export function buildMcpServer(backend: Backend): Server {
  const server = new Server(
    { name: 'weftcut', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cat = JSON.parse(await backend.mcpCatalog()) as { tools: unknown[] }
    return { tools: cat.tools }
  })
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return unwrap(await backend.mcpCallTool(req.params.name, JSON.stringify(req.params.arguments ?? {}))) as object
  })
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const cat = JSON.parse(await backend.mcpCatalog()) as { resources: unknown[] }
    return { resources: cat.resources }
  })
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    return unwrap(await backend.mcpReadResource(req.params.uri)) as object
  })
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: JSON.parse(await backend.mcpListPrompts()) }
  })
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    return unwrap(await backend.mcpGetPrompt(req.params.name, JSON.stringify(req.params.arguments ?? {}))) as object
  })

  return server
}
```

- [ ] **Step 3: `index.ts` — host lifecycle (transport, bearer, notifications, info)**

```ts
import express from 'express'
import type { Server as HttpServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { buildMcpServer } from './server.js'
import { loadOrInitAuth, saveAuth, rotateToken, type McpAuth } from './auth.js'

type Backend = import('@weftcut/core').Backend

export interface McpHost {
  getInfo(): { bind: string; sse_url: string; message_url: string; events_url: string; bearer_token: string }
  resetToken(): string
  notifyChange(summary: unknown): void
  close(): Promise<void>
}

export async function startMcpHost(backend: Backend): Promise<McpHost> {
  let auth: McpAuth = loadOrInitAuth()
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const servers = new Set<Server>()

  const appExpress = express()
  appExpress.use(express.json({ limit: '50mb' }))

  // Bearer enforcement (we own the middleware now — unlike rmcp 0.1.x).
  appExpress.use('/mcp', (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${auth.token}`) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null })
      return
    }
    next()
  })

  appExpress.all('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    let transport = sid ? transports.get(sid) : undefined
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport!),
      })
      transport.onclose = () => { if (transport!.sessionId) transports.delete(transport!.sessionId) }
      const server = buildMcpServer(backend)
      servers.add(server)
      await server.connect(transport)
    }
    await transport.handleRequest(req, res, req.body)
  })

  // Bind, with OS-pick fallback on collision.
  const http: HttpServer = await new Promise((resolve, reject) => {
    const s = appExpress.listen(auth.port, '127.0.0.1', () => resolve(s))
    s.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') { appExpress.listen(0, '127.0.0.1', function (this: HttpServer) { resolve(this) }) }
      else reject(e)
    })
  })
  const port = (http.address() as { port: number }).port
  if (port !== auth.port) { auth = { ...auth, port }; saveAuth(auth) }
  else { saveAuth(auth) }

  const url = `http://127.0.0.1:${port}/mcp`
  // Interim bridge for the deferred ConnectAgentPanel: a copy-pasteable config.
  console.log(`[mcp] listening ${url}\n[mcp] connect: ${JSON.stringify({
    mcpServers: { weftcut: { url, headers: { Authorization: `Bearer ${auth.token}` } } },
  })}`)

  return {
    getInfo() {
      return { bind: `127.0.0.1:${port}`, sse_url: url, message_url: url, events_url: '', bearer_token: auth.token }
    },
    resetToken() { auth = rotateToken(auth); return auth.token },
    notifyChange(summary) {
      for (const server of servers) {
        server.notification({ method: 'notifications/weftcut/change', params: summary as Record<string, unknown> })
          .catch(() => { /* session may have closed */ })
      }
    },
    async close() { for (const t of transports.values()) await t.close().catch(() => {}); http.close() },
  }
}
```

- [ ] **Step 4: Wire into `electron/main/index.ts`**

After `await backend.init()`, add:
```ts
const { startMcpHost } = await import('./mcp/index.js')
const mcpHost = await startMcpHost(backend)
ipcMain.handle('get_mcp_info', () => mcpHost.getInfo())
ipcMain.handle('reset_mcp_token', () => mcpHost.resetToken())
```
In the `onEvent` callback, after the existing `webContents.send`, tap `mcp:change`:
```ts
backend = new Backend(
  app.getPath('userData'),
  path.join(app.getPath('userData'), 'Cache'),
  (_err, msg) => {
    if (!msg) return
    const { event, payload } = JSON.parse(msg)
    if (event === 'mcp:change') { mcpHostRef?.notifyChange(payload); return }
    mainWindow?.webContents.send('evt:' + event, payload)
  },
)
```
(Hold `mcpHost` in a module-scoped `let mcpHostRef` set right after `startMcpHost`, since the `onEvent` closure is created before the host exists. `mcp:change` is consumed here, not forwarded to the renderer.)

- [ ] **Step 5: Preload — route the two info channels to direct ipcMain**

In `electron/preload/index.ts`, extend the direct-route branch:
```ts
if (
  channel.startsWith('window:') || channel.startsWith('path:') ||
  channel.startsWith('dialog:') || channel.startsWith('fs:') ||
  channel === 'get_mcp_info' || channel === 'reset_mcp_token'
) {
  return ipcRenderer.invoke(channel, args)
}
```

- [ ] **Step 6: externalize deps in the main bundle (if needed)**

In `electron.vite.config.ts`, ensure the main build doesn't try to bundle native/express oddly:
```ts
main: { build: { outDir: 'out/main', lib: { entry: 'electron/main/index.ts' },
  rollupOptions: { external: ['@weftcut/core', 'express', '@modelcontextprotocol/sdk'] } } },
```
(`@modelcontextprotocol/sdk` ships ESM with subpath `.js` imports; keeping it external + letting Node resolve it from `node_modules` avoids bundler subpath issues. Confirm electron-vite copies node_modules for the packaged app later in S6; for dev/e2e the unpacked `node_modules` is present.)

- [ ] **Step 7: Build + manual boot check**

Run (PowerShell):
```
cd apps/desktop
$env:VITE_WEFTCUT_E2E='1'; npm run electron:build
npx electron out/main/index.js
```
Expected: the app window opens; stdout shows `[mcp] listening http://127.0.0.1:<port>/mcp` + the `[mcp] connect:` snippet. Close the app.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/electron/main/mcp apps/desktop/electron/main/index.ts apps/desktop/electron/preload/index.ts apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/electron.vite.config.ts
git commit -m "migrate(s4a): Electron main MCP host (streamable HTTP + bearer + info IPC + mcp:change relay)"
```

---

### Task 6: e2e gate — real MCP client over streamable HTTP

**Files:**
- Create: `apps/desktop/e2e/electron/s4a-mcp.spec.ts`

**Interfaces:**
- Consumes: the built app (Task 5), the SDK `Client` + `StreamableHTTPClientTransport`, the driver helper `launchApp` (`e2e/electron/helpers/driver.ts`).

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

interface Info { sse_url: string; bearer_token: string }

async function connect(url: string, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  })
  const client = new Client({ name: 'e2e', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

test('S4a: external MCP client connects, calls tools, and bearer is enforced', async () => {
  const { app, page } = await launchApp()

  // Discover the live server URL + token from the main process (panel is deferred).
  const info = (await page.evaluate(() => (window as any).api.invoke('get_mcp_info', {}))) as Info
  expect(info.sse_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  expect(info.bearer_token).toHaveLength(64)

  // 401 without the token.
  await expect(connect(info.sse_url)).rejects.toThrow()

  // With the token: ping + add_track parity + resource read.
  const client = await connect(info.sse_url, info.bearer_token)

  const tools = await client.listTools()
  expect(tools.tools.map((t) => t.name)).toContain('add_track')

  const pong = await client.callTool({ name: 'ping', arguments: {} })
  expect(JSON.stringify(pong.content)).toContain('pong')

  const before = (await page.evaluate(() => (window as any).api.invoke('project_summary', {}))) as { track_count: number }
  await client.callTool({ name: 'add_track', arguments: {} })
  const after = (await page.evaluate(() => (window as any).api.invoke('project_summary', {}))) as { track_count: number }
  expect(after.track_count).toBe(before.track_count + 1)

  const proj = await client.readResource({ uri: 'project://current' })
  expect(proj.contents[0].mimeType).toBe('application/json')

  await client.close()
  await app.close()
})
```

- [ ] **Step 2: Build the app for e2e (if not already from Task 5)**

Run (PowerShell): `cd apps/desktop; $env:VITE_WEFTCUT_E2E='1'; npm run napi:build; npm run electron:build`
Expected: addon (with `mcp`) + renderer/main build succeed.

- [ ] **Step 3: Run the spec**

Run: `cd apps/desktop && npx playwright test e2e/electron/s4a-mcp.spec.ts`
Expected: 1 passed. (The 401 assertion: a connect without the header rejects during `client.connect`.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/electron/s4a-mcp.spec.ts
git commit -m "migrate(s4a): e2e gate — external MCP client (ping/add_track/resource/401)"
```

---

### Task 7: S4a acceptance notes + final verification

**Files:**
- Create: `apps/desktop/electron/S4a-NOTES.md`

- [ ] **Step 1: Full verification sweep**

Run (PowerShell):
```
cd apps/desktop/src-tauri; cargo build --features jobs,export; cargo test --features jobs,export,mcp --lib
cd ..; npx playwright test e2e/electron/s2-smoke.spec.ts e2e/electron/s4a-mcp.spec.ts
```
Expected: addon build (mcp OFF) green; `--features jobs,export,mcp` tests green; both specs pass (s2-smoke proves the addon-feature flip didn't regress the base bridge).

- [ ] **Step 2: Write `S4a-NOTES.md`**

Record: what works (streamable MCP server, bearer enforced, the ported tool/resource/prompt surface, `mcp:change` notifications, `get_mcp_info`/`reset_mcp_token` from main); the test evidence (cargo counts + the two specs); and the **deferred follow-ups** explicitly:
- **S4b:** `safeStorage` keys + `settings_*` commands + re-add `transcribe_clip`/`synthesize_speech` + `auto-caption`/`voiceover` prompts (`#[cfg(feature="cloud")]`; recover bodies from the pre-S4a `mcp/mod.rs` git blob, apply the Task-2 transform).
- **S5:** re-add the motif tools + `motifs://current` + `preview_motif_draft` against the new Backend motif handle.
- **Tracked UI follow-up:** `ConnectAgentPanel.tsx` still emits SSE-shaped snippets + a stale `events_url`; rework it (+ `McpInfoView` reshape + `connect.*` locales) to streamable — a `src/**` change, deliberately out of S4a. Interim: the `[mcp] connect:` startup log line.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/electron/S4a-NOTES.md
git commit -m "migrate(s4a): acceptance notes + deferred follow-ups (S4b/S5/panel)"
```

---

## Self-Review

**Spec coverage:**
- Unit 1 (Rust core, in-place, `&Backend` fns, schemars catalog) → Tasks 1, 2. ✓
- Unit 2 (napi `Backend` MCP methods, dedicated not invoke-arms) → Task 3. ✓
- Unit 3 (Electron main host: streamable HTTP, bearer enforced, owns port/token, `get_mcp_info`/`reset_mcp_token`) → Task 5. ✓
- New `mcp:change` event (full `ChangeEventSummary`, dedicated event) → Tasks 2 (types) + 3 (emit) + 5 (relay). ✓
- Catalog feature-gated; cloud/motif deferred; `detect_silences` in S4a → Task 2 (delete cloud/motif, keep detect_silences). ✓
- Streamable-only, bearer enforced, `/events` dropped → Task 5. ✓
- Drop rmcp/axum → Task 2 Step 7. ✓
- Parity oracle: ported Rust tests (Task 2 Step 8), catalog/dispatch tests (Task 3), e2e w/ 401 (Task 6). ✓
- Deferred panel + logged snippet bridge → Task 5 Step 3, Task 7. ✓

**Placeholder scan:** No "TBD"/"add error handling"-style gaps. Task 2 uses an explicit transform table + worked examples + exact delete/keep lists for a verbatim move (not a placeholder — the source bodies exist in `mcp/mod.rs`; re-quoting 4000 unchanged lines is neither possible nor useful). The SDK-version verification (Task 5 Step 0) is a real step, not a deferral.

**Type consistency:** `dispatch_tool`/`read_resource`/`catalog`/`list_prompts`/`get_prompt` names match across Tasks 2→3; `mcpCallTool`/`mcpCatalog`/`mcpReadResource`/`mcpListPrompts`/`mcpGetPrompt` match Tasks 3→4→5; the `{ok,result|error}` envelope (`reply`, Task 1) is produced in Task 3 and consumed by `unwrap` (Task 5); `McpInfoView` fields (`bind/sse_url/message_url/events_url/bearer_token`) match `getInfo()` (Task 5) and the renderer contract.

**Open items intentionally left to execution:** SDK API surface confirmation (Task 5 Step 0), `node:http` vs express (chose express for routing+middleware simplicity), `begin_and_emit_sink` reuse-vs-add (Task 2 Step 4 note).
