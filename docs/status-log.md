# Status / Log System

A persistent status bar + expandable inline console that records shortcut
results, wait operations, MCP agent activity, and system errors. Lives at
the bottom of the editor view. It replaced `ActivityPanel` and the
menu-bar error span, and is designed to scale forward into a future
"full agent mode".

---

## System shape

- Persistent ~28 px status strip pinned to the bottom of the editor view.
- Expandable inline overlay console that **lifts** over the editor
  (drag-resize handle on top + slight dim of underlying content). Does
  not push the editor up.
- Replaced `ActivityPanel` and the menu bar's inline error span. The
  status bar's `derivatives-pill` is the permanent liveness signal for
  background derivative jobs — the once-planned aggregate-row replacement
  was retired. Liveness stays on the pill; job *failures* land as
  `Job`/`Error` rows (see § Producers).
- Coexists with: `ExportPanel` (detailed progress UI), `QueuePanel`
  (editable export queue).

## Backend

A `LogBus` actor (`native/src/logs/bus.rs`) owns the system.

- Ring buffer: in-memory `VecDeque<LogEntry>` capped at **1000 entries**.
- Broadcast: `tokio::sync::broadcast` channel; the Electron bridge
  forwards each entry as an IPC event (`log:entry`).
- Persistence: bounded `tokio::mpsc` channel feeds a dedicated writer
  task that appends to `<workspace>/Logs/session-<YYYYMMDD-HHMMSS>.jsonl`.
  Channel saturation emits a single `log_persist_lagged` error and
  drops; producers never block.
- Rotation: keep the most recent **20 session files**; delete the rest
  on workspace open. A single session rolls to `…-part2.jsonl` when it
  exceeds ~50 MB.
- Flush: line-buffered; explicit flush on app shutdown / workspace
  close.

### Lifecycle

- **Pre-workspace: strict refuse.** Neither the ring buffer nor the
  JSONL writer exist before a workspace is opened. Startup-screen
  errors are visible only via `tracing` stderr. The `LogBus` is built
  by the workspace-open path and torn down by the workspace-close
  path, mirroring the rest of the workspace-scoped state.

### Backend surface

Commands:
- `log_list() -> Vec<LogEntry>` — seeds the frontend mirror on mount.
- `log_clear() -> ()` — clears the in-memory ring (does not truncate
  the JSONL file).
- `log_emit(entry: LogEntryInput) -> ()` — frontend-originated entries
  (shortcut results, UI errors).

Events:
- `log:entry` — payload is a single `LogEntry`. One event per append.

## Entry schema

```rust
struct LogEntry {
    id: Ulid,                     // monotonic, sortable, unique
    ts: DateTime<Utc>,            // ISO 8601 on the wire
    level: Level,                 // Trace | Debug | Info | Warn | Error
    category: Category,           // Shortcut | Mcp | Job | Export |
                                  // Import | Project | System | Agent |
                                  // Other(String)
    source: Source,               // User | Agent { client: String } |
                                  // System
    message: String,              // English; canonical
    i18n_key: Option<String>,     // optional translation key
    i18n_args: Option<Value>,     // optional translation args
    op_id: Option<Ulid>,          // groups state changes for one op
    op_state: Option<OpState>,    // Started | Progress(f32) | Ok | Err
    details: Option<Value>,       // free-form, redacted, ≤4 KB
}
```

Notes:
- `Category` is a fixed enum with an `Other(String)` escape hatch.
- `details` is passed through a redactor that strips
  `Authorization: Bearer …`, `api[_-]?key[=:]…`, and `x-api-key: …`
  before broadcast and persistence.
- `details` > 4 KB is truncated with `{ "truncated": true }` appended.
- Long-running ops emit **one entry per state change**, all sharing
  one `op_id`. The UI collapses these into a single row.

## Producers

| Producer | Category | Level | Notes |
|---|---|---|---|
| Shortcuts | `Shortcut` | `Info` on success, `Error` on failure | Start logged only when handler is async AND runs > 250 ms. No-ops (e.g. `deleteSelected` with nothing selected, `NothingToUndo` refusals) at `Debug`. Failures render as refusal lines (see § Refusals). |
| Direct commits (inspector fields, drag commits, timeline context menus) | `Project` | `Error` (`Debug` for no-op refusals) | One entry per refused mutation via `renderer/errors/tryMutate.ts`; `details` carries the structured `CommandError`. Components with their own inline error slot (media-removal dialog, effects section, project settings) keep it and render the same refusal copy there instead. |
| Import | `Import` | `Info`/`Error` | Started → Progress (byte copy) → Ok/Err. Grouped by `op_id`. |
| Export | `Export` | `Info`/`Error` | Started → Progress(%) → Ok/Err. Existing backend events stay; `LogBus` is an additional sink. |
| Derivative jobs (proxy, quick proxy, thumbnails, waveform, conform) | `Job` | `Error` only | One row per failed job — `<Kind> job failed for <name>: <error>`, `source = System` (`jobs::emit_job_error`). No Started/Ok rows by design: liveness is the status-bar pill, and per-job Info rows would flood the console on bulk imports. |
| Long-running MCP compute (transcribe_clip, synthesize_speech, detect_silences, describe_clip) | `Mcp` | `Info`/`Error` | No producer of their own: the generic MCP-tool decorator below covers them like any other tool. Their compute is what usually crosses the 250 ms threshold, so they are the ops that actually get a `Started` row — and crossing it is what lifts a read-route tool to `Info`. |
| Preview rebuild | `Job` | `Debug` | Fires on every commit — hidden by default. |
| MCP tool calls (and `tools/list`, `resources/*`, `prompts/*`) | `Mcp` | `Info` mutations, `Debug` quick reads, `Error` on failure | One `withLog` decorator on each of `buildMcpServer`'s six request handlers, so a newly added tool is logged with nothing to remember; the level is derived from `routeMcpTool`, never a per-tool list. Settling inside 250 ms → one entry, no `op_id`; still running at 250 ms → `Started` then `Ok`/`Err` under one `op_id` (the three-state shape Shortcuts use). An op slow enough to need a `Started` logs at `Info` whatever its route — the threshold is the test of whether the user is waiting on it. An op that crosses a workspace switch drops its `op_id`: `install` replaces the bus, so the pair cannot span it. `details` carries `{ tool, args, duration_ms, client_info }` plus `error` on failure; strings over 512 bytes are elided to `{ omitted, bytes, sha256_8 }` in TS, before the payload reaches the 4 KB cap that would otherwise discard the whole object. No return value. `source = Agent { client: "mcp" }` means "arrived over the MCP transport"; the real client identity is `details.client_info`. |
| MCP server lifecycle | `Mcp` | `Info` | `source = System`. Connect/disconnect/bind events. |
| Project mutations | `Project` | `Info` | `source = User` or `Agent { client }` depending on origin. Replaces `ActivityPanel`'s feed. |
| Load-time media relink | `Project` | `Info` healed / `Warn` missing | `source = System`. `details.kind = "Relink"`. Emitted after the workspace commit, never during the heal — the commit rotates the per-workspace bus. |
| Load-time grid repair | `Project` | `Warn` | `source = System`. `details.kind = "GridRepair"` with one row per moved field. `Warn` because the repair rewrites the user's timeline. Same post-commit timing rule as relink. |
| System errors | `System` | `Error` | Via a `tracing-subscriber` `Layer` scoped to our crate's spans only. |

## Frontend

- State: Zustand store, seeded by `log_list` on mount + `log:entry`
  subscription. Capped at 1000 entries (mirrors backend).
- Selectors:
  - Bar: `{ latest, errorCount, runningCount }`.
  - Console: filtered, virtualized slice based on chip + search state.

### Bar (collapsed)

```
[●] 14:32  Added 3 layers to track v1 · agent     [⚠2] [↻1] [Logs ▾]
```

- Severity dot + time + truncated latest message + source pill (left).
- Error badge (red, count) + running badge (spinner + count) + explicit
  `Logs ▾` toggle (right).
- Auto-updates on `Info+`. When an `Error` lands the line **sticks for
  10 s** before being overwritten.
- Error badge pulses for ~1.5 s when the count increments, then settles.

### Console (expanded overlay)

Layout: toolbar → virtualized entry list → footer.

Toolbar:
- Level chips: `Info+` (default) · `Warn+` · `Errors only` · `All`.
- Category chips: `Shortcut` · `MCP` · `Job` · `Export` · `Import` ·
  `Project` · `Agent` · `System`.
- Source chips: `User` · `Agent` · `System`.
- Free-text search (matches `message` + `details` + translated
  rendering).
- `Clear` (in-memory ring only) · `Copy` (filtered view as text) ·
  `Open log folder` (reveals `<workspace>/Logs/` in OS file manager) ·
  pause-autoscroll toggle.

Entries:
- Row shape: `[time] [level dot] [category pill] [source pill] message [⋯]`.
- `⋯` discloses `details` as pretty JSON + the `op_id`.
- Ops with multiple state changes collapse to one row with a `(N)`
  counter; clicking expands the inline state-change timeline.
- Progress ops show an inline mini progress bar.

Current system status:
- Startup capability notices (for example, an unavailable optional decode
  component or OS keyring) are mirrored into the `System` log once the
  workspace log bus is ready.
- Log history renders those events as ordinary, non-interactive rows, including
  when the user filters the console to the `System` category.
- The notice list remains the source of truth for unresolved state. The
  status-bar `System N` entry opens a dedicated status panel containing the
  interactive recovery cards and links to the relevant settings category.
- `Clear` removes historical rows only. It does not change the dedicated
  status panel; recovery removes the current state and may emit a recovery
  event.

Footer:
- `showing N / M` (filtered / total).
- JSONL session file path with copy button.

Defaults: level `Info+`, ops collapsed.

### Shortcuts

- `toggleLog`: `Ctrl+\`` — expand / collapse the overlay. Acknowledges
  any 10-s-sticky error in the bar.
- `focusLogSearch`: `Ctrl+Shift+\`` — expand and focus the search box.
- `Esc` collapses the overlay when focused. In the search box, first
  `Esc` clears the query; second `Esc` collapses.

### Refusals

A refused mutation crosses IPC as `Error(JSON.stringify(CommandError))`
(the actor serializes the structure into `message` because Electron's
`invoke` drops custom Error props). The renderer parses it back
(`renderer/errors/parseCommandError.ts`) and renders it through a
type-locked copy map (`renderer/errors/formatCommandError.ts` — a
`Record` over the full error union, so adding a variant without filing
its tier fails to compile). Three tiers:

- **suppress** — no-op refusals (`NothingToUndo`/`NothingToRedo`) log at
  `Debug`; a native NLE does nothing on an empty undo.
- **generic** — plumbing / not user-reachable variants; the code is
  humanized mechanically, English only.
- **curated** — refusals a user can hit from the editor surface
  (`LayerOverlap`, `TrackLocked`, `FpsLockedByContent`, …): hand-written
  copy under the `errors.*` keys (en-US + zh-CN), uuids resolved to the
  display names the timeline shows (fallback: short id, never a raw
  uuid).

The copy map carries an unused `actions?` slot per variant: if real
usage shows the status line gets missed, remedy buttons can be added as
map entries on a richer surface without re-architecting (a toast layer
was explicitly declined for v1 — prevention and the status bar are the
NLE-convention answer).

### i18n

- Producers emit canonical English `message`. Selected high-frequency
  producers (shortcut names, MCP tool names, export/import status
  verbs, project mutation summaries, curated refusal lines) additionally
  emit `i18n_key` + `i18n_args`. Plumbing errors and `tracing`-bridged
  messages stay raw English.
- Frontend prefers `i18n_key` if present; falls back to `message`
  (`renderer/logs/renderMessage.ts`, used by the bar, the console rows,
  and the search haystack).
- UI chrome (chips, buttons, level labels) is translated.
- Untranslated entries in zh-CN render verbatim (no `[en]` tag).
- Search matches raw English + translated rendering.

### Accessibility

- A visually-hidden `aria-live="polite"` region announces **errors
  only**, as `"Error: <message>"`. Info/warn entries update the
  visible bar but do not announce.
- Expanded console has `role="log"`.

## Forward-compat for full agent mode

Bets baked into v1:
- `source.Agent { client }` and `op_id` grouping in the schema.
- Backend-owned `LogBus` with broadcast — a future agent-mode UI
  subscribes to the same stream without re-plumbing.
- `details` carries MCP tool args, with large values elided; this is
  the transcript. Return values are omitted — a mutation's is an id or
  an ack, and a read's is the project view, replayable at `Debug`.

Deferred until agent-mode lands:
- Chat-bubble transcript view, suggestion accept/reject UI, per-agent
  session grouping, an `agent.message` MCP endpoint for free-form
  narration.

## Deferred

Nothing open. Two once-planned items were retired rather than shipped,
with their reasons: the derivatives-pill aggregate row (the status-bar
pill already owns liveness, and job failures land as `Job`/`Error`
rows) and console virtualization (the ring caps at 1000 entries —
`LogConsole.tsx` marks the react-window spot should that ever grow).
