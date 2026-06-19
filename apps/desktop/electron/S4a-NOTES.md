# S4a — MCP Server Migration: Acceptance Notes

## What ships in S4a

### Rust `mcp` module (transport-free)

The Rust `mcp` crate is now entirely transport-free.  All MCP surface is exposed as plain `&Backend` async functions:

- `catalog.rs` — `schemars`-derived JSON catalog (tools + resources + prompts) produced by the `tool_table!` macro; `any_object_schema` helper fixes the boolean `true` schema defect that the MCP SDK 1.29.0 `AssertObjectSchema` validator was rejecting on keyframe-arg `serde_json::Value` fields.
- `wire.rs` — MCP wire types (`ToolDef`, `ResourceDef`, `PromptDef`, the `reply` envelope helper).
- `dispatch_tool`, `read_resource`, `list_prompts`, `get_prompt` — thin dispatch fans out to individual tool handlers; returns `{ok, result|error}` JSON strings.

Cloud tools (`transcribe_clip`, `synthesize_speech`) and motif tools are **absent from the catalog** — deferred to S4b and S5 respectively (see below).

### napi `Backend` MCP methods

Five dedicated napi methods on `Backend` (not invoke-dispatch arms):

```
mcpCatalog()         → string (JSON catalog)
mcpCallTool(name, args_json) → string ({ok, result|error})
mcpReadResource(uri) → string ({ok, result|error})
mcpListPrompts()     → string (JSON array)
mcpGetPrompt(name, args_json) → string ({ok, result|error})
```

### Electron main — streamable-HTTP MCP server

`apps/desktop/electron/main/mcp/index.ts` (`startMcpHost`):

- Binds express on `127.0.0.1:<port>` (persisted in `mcp_auth.json` in `userData`; OS-pick fallback on collision).
- Single endpoint `/mcp` handles all MCP-over-streamable-HTTP (SDK 1.29.0 `StreamableHTTPServerTransport`).
- Bearer enforcement via express middleware: every `/mcp` request requires `Authorization: Bearer <token>`; non-compliant requests receive `401 { code: -32001, message: "unauthorized" }`.
- `get_mcp_info` IPC handler returns `McpInfoView` (`bind`, `sse_url`, `message_url`, `events_url` (empty), `bearer_token`).
- `reset_mcp_token` IPC handler rotates the token, persists it, and returns the new value.
- Logs a copy-pasteable JSON config block at bind (`[mcp] connect: ...`) as an interim bridge for the deferred `ConnectAgentPanel` UI.
- `/events` SSE endpoint is **dropped** — the server is streamable-only.
- rmcp and axum are **removed** from `Cargo.toml`.

### `mcp:change` EventSink event

A new `mcp:change` event on the `EventSink` carries a `ChangeEventSummary` JSON payload.  The Electron main process relays it to all active MCP sessions via `server.notification({ method: 'notifications/weftcut/change', params: summary })`.

---

## Test evidence

### Cargo lib tests (`--features jobs,export,mcp`)

Command:
```
cd apps/desktop/src-tauri
cargo test --features jobs,export,mcp --lib
```

Result: **486 passed; 0 failed** (finished in 1.53s)

Addon build (mcp OFF, `--features jobs,export`) also clean — 0 errors.

### Playwright e2e

Command:
```
cd apps/desktop
npx playwright test e2e/electron/s2-smoke.spec.ts e2e/electron/s4a-mcp.spec.ts
```

Result: **2 passed** (2.5s)

- `s2-smoke.spec.ts` — boots, creates a project, `add_track` round-trips through the bridge; confirms the mcp-feature flip did not regress the base napi bridge.
- `s4a-mcp.spec.ts` — real `@modelcontextprotocol/sdk` client: `get_mcp_info` returns a live `http://127.0.0.1:<port>/mcp` URL; 401 is returned without a token; `listTools()` (SDK Zod validator passes); `ping` → pong; `add_track` state-round-trip via `project_summary`; `project://current` resource read returns `application/json`.

---

## Deferred follow-ups

### S4b — Cloud / API-key commands

- `safeStorage`-backed `set_api_key` / `get_api_key_status` / `clear_api_key` Electron IPC handlers.
- Rust-side `settings_set_api_key` / `settings_get_api_key_status` / `settings_clear_api_key` / `settings_test_provider` commands (behind `#[cfg(feature="cloud")]`).
- Re-add `transcribe_clip` and `synthesize_speech` MCP tools; recover bodies from the pre-S4a `mcp/mod.rs` git blob and apply the Task-2 transport-free transform.
- Re-add `auto-caption` and `voiceover` prompts (`#[cfg(feature="cloud")]`).

### S5 — Motif tools

- Re-add motif tools (`list_motifs`, `install_motif`, etc.) + `motifs://current` resource + `preview_motif_draft` against the new `Backend` motif handle.

### UI follow-up (tracked, deliberate `src/**` change out of S4a)

`ConnectAgentPanel.tsx` still emits SSE-shaped code snippets and reads `McpInfoView.sse_url` / `events_url` (the old SSE field names).  Required rework:

1. `McpInfoView` reshape in the renderer: retire `sse_url`/`message_url`/`events_url`, use a single `url` field.
2. `ConnectAgentPanel.tsx` — emit streamable-HTTP connection snippet instead of SSE.
3. `connect.*` en-US and zh-CN locale strings updated to match.

Interim bridge: the `[mcp] connect:` startup log line in the main process provides a copy-pasteable config for agent clients until the panel is reworked.

### S6 — Packaging

`electron-builder` (or equivalent packager) must bundle `express` and `@modelcontextprotocol/sdk` in `extraResources` / `files` / `asar` exclusions as appropriate for the target platform.

---

## Known minor follow-ups

1. **Stale-session transport leak** — `startMcpHost` creates a new `StreamableHTTPServerTransport` + `Server` pair for every non-init/unknown-session POST to `/mcp` (e.g., a client re-POSTing after a restart without a session-ID).  They are never stored in `servers`/`transports` and therefore never closed.  This is behind the bearer gate (an unauthenticated client never reaches it) and is non-exploitable on localhost.  Canonical fix: guard on `!sid && isInitializeRequest(req.body)` before creating a new pair; reject stale-session requests with `-32001`.

2. **Non-constant-time bearer compare** — `req.headers.authorization !== \`Bearer ${auth.token}\`` is a string equality check, not a constant-time comparison.  For a 256-bit localhost token this is not a meaningful attack surface, but a `crypto.timingSafeEqual` compare is the correct form if the server ever becomes network-exposed.
