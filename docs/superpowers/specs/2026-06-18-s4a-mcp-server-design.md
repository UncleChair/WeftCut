# S4a — MCP server on the TS SDK over Rust tool bodies (design)

Date: 2026-06-18
Stage: S4a (the MCP half of S4; safeStorage is S4b)
Branch: `migration/electron-napi`

## Context

S4 of the Tauri→Electron+napi migration replaces two Node-forced subsystems:
**(1)** the Rust `rmcp` MCP server → the TypeScript `@modelcontextprotocol/sdk`,
and **(2)** OS-keyring API-key storage → Electron `safeStorage`. This spec covers
**only S4a — the MCP server**. The key-storage rewrite (`safeStorage`, the
`settings_*` key commands, and making the cloud tools functional) is split into a
separate **S4b** plan to keep each increment tight and independently shippable.

The master plan (`docs/superpowers/plans/2026-06-17-electron-napi-migration.md`)
and design (`…/specs/2026-06-17-electron-napi-migration-design.md`) frame S4 as
"re-expose the tool surface against `Backend`; verify external client compat
(R7)." This spec settles the *how* those left open.

### Current state being replaced

- `apps/desktop/src-tauri/src/mcp/mod.rs` (~4261 lines): ~60 `#[tool]` methods on
  `WeftCutServer` (holds `ProjectHandle` + `CacheLayout` + Tauri `AppHandle`),
  the `ServerHandler` impl (13 resources, 3 prompts), `serve()` binding rmcp
  0.1.x `SseServer` on `127.0.0.1:<auto-port>`, and a bearer token persisted to
  `mcp_auth.json` but **never enforced** (rmcp 0.1.x exposes no middleware hook).
- `mcp/events.rs`: a *separate* axum `/events` SSE server emitting
  `ChangeEventSummary` (snapshot-free change feed; agents re-fetch after each).
- `mcp/keyframes.rs`, `mcp/prompts.rs`: keyframe helpers + prompt catalog.
- The napi `Backend` (`src-tauri/src/napi_backend.rs`) holds the same `Arc` graph
  (`project: OnceLock<ProjectHandle>`, `cache`, `events: Arc<dyn EventSink>`,
  `log_slot`, `agent_session`, and under `jobs`: `import_queue`/`audio_meter`),
  dispatches renderer commands via a `match cmd` returning `Result<String,String>`
  (unknown cmd → `"unavailable: '…' is wired in a later stage (S3/S4/S5)"`), and
  in `init()` bridges actor `ChangeEvent`s to a **thin** `project:changed`
  EventSink event (`{op_id, actor_kind, client, summary, timestamp, affected_count}`).
- Renderer contracts (UNCHANGED — `src/**` is out of scope) the backend must keep:
  `get_mcp_info → McpInfoView {bind, sse_url, message_url, events_url, bearer_token}`,
  `reset_mcp_token → string`. The cloud-key contracts
  (`settings_get_api_key_status`, `settings_set_api_key`, `settings_clear_api_key`,
  `settings_test_provider`) belong to **S4b**.

## Decisions (locked during brainstorming)

1. **Thin TS over Rust bodies.** Tool/resource/prompt logic stays in Rust; the TS
   SDK server does only protocol/transport/auth/dispatch.
2. **Rust emits the catalog; TS serves it verbatim.** Names, descriptions, and
   JSON input-schemas come from Rust (`schemars` on the existing `JsonSchema` arg
   structs) — single source of truth, zero cross-language drift.
3. **Streamable HTTP only**, with the **bearer token enforced** (the TS layer owns
   its HTTP middleware, unlike rmcp 0.1.x). Retires the rmcp-0.1.x SSE-only pin.
4. **Change feed via in-protocol MCP notifications** over the streamable session
   (carrying the full `ChangeEventSummary`). The separate `/events` axum server is
   **deleted**.
5. **`ConnectAgentPanel` fix is deferred** (tracked follow-up). It hardcodes SSE
   snippets/fields and reads `McpInfoView.sse_url`/`events_url`; under streamable-
   only those snippets are stale. Interim bridge: the server **logs a correct
   streamable connect-snippet at bind**, so a user/test can copy URL+token from
   logs until the panel is reworked. `get_mcp_info` still returns all `McpInfoView`
   keys (populated sensibly) so the unchanged panel renders without crashing.
6. **In-place refactor** of `src/mcp/` (tool bodies become functions over
   `&Backend`, matching the `commands::mutations::*(&Backend)` pattern) — not a new
   `mcp_core/` dir.
7. **`mcp:change` is a NEW EventSink event** (not an enrichment of `project:changed`)
   so the renderer payload stays stable.

## Architecture

Three units + one new event.

```
external agent ──POST /mcp (Bearer)──▶ Electron main (Node)
                                        ├─ MCP host: SDK low-level Server
                                        │   + StreamableHTTPServerTransport
                                        │   + bearer middleware
                                        │   + owns port/token (mcp_auth.json)
                                        │   + answers get_mcp_info/reset_mcp_token
                                        ▼ (napi, in-process)
                                       Backend MCP methods  (#[cfg(feature="mcp")])
                                        ├─ mcpCatalog / mcpCallTool
                                        ├─ mcpReadResource
                                        └─ mcpListPrompts / mcpGetPrompt
                                        ▼
                                       Rust mcp core (transport-free)
                                        ├─ tools::*(&Backend, args) -> ToolResult
                                        ├─ resources::read(&Backend, uri)
                                        ├─ prompts::{list,get}
                                        ├─ keyframes::*
                                        └─ catalog()  (schemars + description table)
                                        ▼
                                       ProjectHandle actor / CacheLayout / cloud…

actor ChangeEvent ─▶ Backend.init bridge ─#[cfg(mcp)]▶ EventSink "mcp:change"
                                                        ▶ main ▶ MCP notification ▶ session
```

### Unit 1 — Rust `mcp` core (transport-free), `src-tauri/src/mcp/`

**Delete** the rmcp transport layer: `serve()`, `SseServer` use, the
`#[tool(tool_box)]`/`ServerHandler` machinery, `McpInfo`/`McpInfoCell`, and
`events.rs` (the `/events` axum server). **Keep + de-Tauri-fy** everything else.

- Each `#[tool]` method → a plain function `tools::<name>(backend: &Backend, args:
  <Args>) -> Result<ToolResult, McpToolError>`. The `#[tool(aggr)] Args` structs
  (already `Deserialize + JsonSchema`) are retained verbatim.
- Tauri couplings rewritten to Backend-held handles:
  - `self.project` → `backend.project()?`
  - `self.cache` → `backend.cache`
  - `crate::logs::emit_via_app(&self.app, …)` → `backend.log_slot.emit(…)` (or
    via `backend.events` where appropriate)
  - `self.app.try_state::<AgentSessionSlot>()` → `backend.agent_session`
  - `jobs::enqueue_for_media(self.app.clone(), …)` (in `synthesize_speech`) →
    the napi job-enqueue path used by `commands::media` (under `jobs`)
  - `agent_actor()` retained unchanged (MCP mutations stamp `Actor::Agent`).
- `catalog.rs` (new): builds `McpCatalog { tools: Vec<ToolDef>, resources:
  Vec<ResourceDef>, prompts: Vec<PromptDef> }`. `ToolDef { name, description,
  input_schema: serde_json::Value }`; `input_schema` via `schemars::schema_for!`
  on each Args struct; `description` in a data table (moved out of the old
  `#[tool(description=…)]` attrs). **Every catalog entry is `#[cfg]`-gated to match
  its tool**, so the advertised surface always equals the compiled tool set.
- `resources.rs`: the resource readers (JSON slices for `project://*`; base64
  `BlobResourceContents`-shaped JSON for `media://{id}/thumbnail|frame|waveform`).
- `prompts.rs`, `keyframes.rs`: moved near-verbatim (prompts are static recipe
  text; keyframes already delegate to `keyframes::*` helpers).
- Errors: a transport-agnostic `McpToolError { code: McpErrorCode, message: String }`
  where `McpErrorCode ∈ {InvalidParams, InvalidRequest, NotFound, Internal}`,
  replacing rmcp's `McpError`. Existing structured messages (overlap options,
  "waveform not ready", subtitle-format errors) pass through unchanged. The old
  `ok_text/ok_json/ok_void` helpers become constructors of a `ToolResult` whose
  JSON serialization matches the MCP `CallToolResult` wire shape (a `content`
  array of `{type:"text"|"image", …}`), so TS forwards it verbatim.

**S4a surface (everything not gated behind `cloud` or `motifs`):**
- ping; `begin_agent_session`
- tracks: `add_track`, `remove_track`, `move_track`
- layers: `add_color_layer`, `add_video_layer`, `apply_subtitles`, `update_layer`,
  `update_layer_params`, `move_layer`, `split_layer`, `delete_layer`, `trim_layer`,
  `duplicate_layer`
- groups: `groups_list`, `groups_get`, `groups_create`, `groups_dissolve`,
  `groups_add_members`, `groups_remove_members`, `groups_rename`
- keyframes (8): `get_param_track`, `set_keyframe`, `remove_keyframe`,
  `retime_keyframe`, `set_keyframe_easing`, `smooth_keyframes`, `clear_keyframes`,
  `set_param_track`
- composition: `set_composition`, `fit_composition_to_layers`
- markers: `add_marker`, `update_marker`, `remove_marker`
- media: `import_media`, `remove_media`
- analysis: `detect_silences` (needs only `jobs`; reads the waveform peaks file)
- workflow/history: `undo`, `redo`, `lock_history`, `unlock_history`,
  `checkpoint`, `list_checkpoints`, `restore_checkpoint`, `dry_run`
- audio roles: `set_role_gain`, `set_role_flags`
- resources (12): `project://current|composition|media|tracks|markers|history|compiled`,
  `composition://meter`, `project://layers/{id}`,
  `media://{id}/thumbnail|frame/{t_us}|waveform`
- prompts (1): `cut-silences`

**Deferred (auto-appear when the feature turns on):**
- `cloud` (→ S4b): `transcribe_clip`, `synthesize_speech`; prompts `auto-caption`,
  `voiceover`.
- `motifs` (→ S5): `list_motifs`, `get_motif_source`, `write_motif_draft`,
  `preview_motif_draft`, `install_motif`, `delete_motif`, `add_motif`; resource
  `motifs://current`.

### Unit 2 — napi `Backend` MCP surface (`#[cfg(feature="mcp")]`)

Dedicated `#[napi]` methods — **not** arms of the renderer `invoke` dispatch — so
the renderer cannot reach the agent-actor-stamped tool surface:
- `async mcp_catalog() -> napi::Result<String>` (catalog JSON)
- `async mcp_call_tool(name: String, args_json: String) -> napi::Result<String>`
- `async mcp_read_resource(uri: String) -> napi::Result<String>`
- `async mcp_list_prompts() -> napi::Result<String>`
- `async mcp_get_prompt(name: String, args_json: String) -> napi::Result<String>`

These run on napi's tokio runtime. `mcp_call_tool` matches `name` → the
`tools::*` functions; serialization mirrors the existing `ser()` JSON-string
contract. `McpToolError` serializes to a JSON envelope the TS layer maps to a
JSON-RPC error.

### Unit 3 — Electron main MCP host (`apps/desktop/electron/main/mcp/`)

- `transport.ts`: a localhost HTTP host (`node:http` or express — plan decides)
  on `127.0.0.1:<port>` running the SDK low-level `Server` + a
  `StreamableHTTPServerTransport` in **stateful** mode (session id), required for
  server→client notifications.
- `auth.ts`: token generation + `mcp_auth.json` persistence (in Electron
  `app.getPath('userData')`), port reuse with OS-picked fallback on collision —
  **owned by main now** (the server lives in Node). Bearer middleware validates
  `Authorization: Bearer <token>` before the transport handles a request; 401 on
  miss/mismatch. Localhost binding kept as defense-in-depth.
- `server.ts`: registers SDK request handlers — `ListTools→mcpCatalog().tools`,
  `CallTool→mcpCallTool`, `ListResources/ReadResource`, `ListPrompts/GetPrompt` —
  each forwarding to the Backend napi methods.
- IPC: `get_mcp_info` / `reset_mcp_token` are answered **here** (main owns port +
  token). `get_mcp_info` returns the full `McpInfoView` shape; with streamable-
  only, `message_url` = the `/mcp` endpoint, `sse_url` = same endpoint (so the
  deferred-but-rendered panel shows a real URL), `events_url = ""`.
- change relay: subscribes to the `mcp:change` EventSink stream and pushes an MCP
  notification (carrying `ChangeEventSummary`) to connected sessions.
- On bind, **log a ready-to-paste streamable connect-snippet** (URL + bearer) —
  the interim bridge for the deferred panel.

### New event — `mcp:change`

In `Backend::init`'s actor→event bridge, additionally emit (`#[cfg(feature="mcp")]`)
a `mcp:change` EventSink event carrying the full `ChangeEventSummary`
(`{op_id, actor, timestamp, summary, affected, diff_hint}` — the type moves from
the deleted `events.rs` into the mcp core). The existing `project:changed` payload
is untouched; the renderer ignores `mcp:change`.

## Data flow

**Tool call:** agent → `POST /mcp` (Bearer) → main transport → SDK `CallTool` →
`backend.mcpCallTool("add_video_layer", argsJson)` (napi/tokio) →
`mcp::tools::add_video_layer(&backend, args)` → `ProjectHandle` mutation (stamped
`agent_actor()`) → `CallToolResult` JSON → HTTP response.

**Change notification:** actor broadcast → Backend bridge → `mcp:change`
(EventSink/TSFN) → main → MCP notification → session SSE stream → agent re-reads
`project://current`.

## Error handling

- `McpToolError.code` → JSON-RPC error code in TS (`InvalidParams`→-32602, etc.)
  or `CallToolResult.isError` content where the SDK prefers it.
- Bearer failure → HTTP 401 (before the transport).
- mcp feature off / Backend uninitialized → a clear error string.
- Structured command-error payloads (overlap options, validation hints) preserved.

## Testing / parity oracle (4 layers)

1. **Ported Rust unit tests** move with the core; `cargo test --lib` stays green —
   the strongest "logic intact" evidence (the tool bodies are unchanged but for
   the handle swaps).
2. **New Rust tests:** `catalog()` emits schema-valid JSON for every tool; a
   `mcp_call_tool` dispatch smoke (`add_track` → project mutated) via `Backend`.
3. **e2e (Playwright/node):** boot the built Electron app, read `get_mcp_info`,
   connect a real MCP client over streamable HTTP with the bearer, assert
   `ping`→"pong", `add_track` then `project_summary` count grows (mirrors the S2
   smoke), read `project://current`, and assert **401 without the token**. This is
   the **R7 external-client-compat gate**.
4. **Interim discoverability:** the bind-time logged snippet lets the e2e (and a
   user) obtain URL+token while the panel is deferred.

## Dependencies & build

- Enable the `mcp` Cargo feature in the napi build.
- **Drop `rmcp` and `axum`** (axum was only the `/events` server). `schemars` is
  already a dependency.
- Add `@modelcontextprotocol/sdk` (and express, if chosen) to `apps/desktop`.

## Scope boundaries

**In S4a:** Units 1–3, the `mcp:change` event, the non-`cloud`/non-`motifs` tool
surface, `get_mcp_info`/`reset_mcp_token` (main-owned), the e2e gate.

**Out of S4a (deferred):**
- **S4b:** `safeStorage` key storage (Node owns encrypt/persist; decrypted key →
  a Rust in-memory cell read by `pick_transcriber`/`pick_synthesizer`; `keyring`
  crate dropped); `settings_get_api_key_status`/`settings_set_api_key`/
  `settings_clear_api_key`/`settings_test_provider`; turning on `cloud` so
  `transcribe_clip`/`synthesize_speech` + the cloud prompts become functional.
- **S5:** the motif tool group + `motifs://current` + `preview_motif_draft` (needs
  the motif store + capture runtime).
- **Tracked follow-up:** rework `ConnectAgentPanel.tsx` (streamable snippet/fields),
  reshape `McpInfoView`, and update `connect.*` locale strings (en-US + zh-CN) —
  a renderer change, hence out of the migration's no-`src/**`-edits rule until
  consciously taken.

## Risks

- **R7 (client compat after transport change):** streamable-HTTP-only is a
  deliberate bet that the user's clients support it; the e2e proves a real client
  connects + calls a tool. (Mitigated by the SDK's spec-current transport.)
- **De-Tauri-fication misses a handle:** each `self.app.*` call site must map to a
  Backend handle; the ported unit tests + a full `cargo build --features mcp`
  catch gaps.
- **Deferred panel** ships a stale in-app connection snippet; mitigated by the
  logged snippet and the tracked follow-up. Honest, not hidden.

## Open questions for the implementation plan

- `node:http` vs express for the host (lean toward minimal).
- Exact `ToolResult`/`McpToolError` JSON envelope vs the SDK's expected
  `CallToolResult` shape (confirm against the installed SDK version at scaffold).
- Whether `mcp_call_tool` dispatch is a hand-written `match` or a registry table
  shared with `catalog()` (prefer one table feeding both to avoid name drift).
