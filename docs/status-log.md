# Status / Log System

A persistent status bar + expandable inline console that records shortcut
results, wait operations, MCP agent activity, and system errors. Lives at
the bottom of the editor view. Designed to subsume `ActivityPanel`, the
menu-bar error span, and the derivatives pill, and to scale forward into
a future "full agent mode".

This document is the canonical design. It was settled in a grilling
session on 2026-05-14; sections map 1:1 to the questions resolved there.

---

## System shape

- Persistent ~28 px status strip pinned to the bottom of the editor view.
- Expandable inline overlay console that **lifts** over the editor
  (drag-resize handle on top + slight dim of underlying content). Does
  not push the editor up.
- Replaces: `ActivityPanel`, inline `<span className="error">` in the
  menu bar, the `derivatives-pill` in the project bar.
- Coexists with: `ExportPanel` (detailed progress UI), `QueuePanel`
  (editable export queue).

## Backend

A new `LogBus` actor owns the system.

- Ring buffer: in-memory `VecDeque<LogEntry>` capped at **1000 entries**.
- Broadcast: `tokio::sync::broadcast` channel; the Tauri bridge
  forwards each entry as a Tauri event (`log:entry`).
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

### Tauri surface

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
| Shortcuts | `Shortcut` | `Info` on success, `Error` on failure | Start logged only when handler is async AND runs > 250 ms. No-ops (e.g. `deleteSelected` with nothing selected) at `Debug`. |
| Import | `Import` | `Info`/`Error` | Started → Progress (byte copy) → Ok/Err. Grouped by `op_id`. |
| Export | `Export` | `Info`/`Error` | Started → Progress(%) → Ok/Err. Existing Tauri events stay; `LogBus` is an additional sink. |
| Derivative jobs (proxy, thumbnails, waveform) | `Job` | `Info`/`Error` | Started → Ok/Err. Progress omitted for thumbnails. |
| Cloud calls (transcribe, TTS) | `Job` | `Info`/`Error` | Started → Progress (provider events) → Ok/Err. |
| Preview rebuild | `Job` | `Debug` | Fires on every commit — hidden by default. |
| MCP tool calls | `Mcp` | `Info`/`Error` | Two entries (Started + Ok/Err) sharing `op_id`. `details` carries args / return / error. Mutating tools' `project:changed` entry folds into the same `op_id`. |
| MCP server lifecycle | `Mcp` | `Info` | `source = System`. Connect/disconnect/bind events. |
| Project mutations | `Project` | `Info` | `source = User` or `Agent { client }` depending on origin. Replaces `ActivityPanel`'s feed. |
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

### i18n

- Producers emit canonical English `message`. Selected high-frequency
  producers (shortcut names, MCP tool names, export/import status
  verbs, project mutation summaries) additionally emit `i18n_key` +
  `i18n_args`. Plumbing errors and `tracing`-bridged messages stay
  raw English.
- Frontend prefers `i18n_key` if present; falls back to `message`.
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
- `details` carries MCP tool args + return values; this is the
  transcript.

Deferred until agent-mode lands:
- Chat-bubble transcript view, suggestion accept/reject UI, per-agent
  session grouping, an `agent.message` MCP endpoint for free-form
  narration.

## Phasing

1. **`LogBus` core.** Ring buffer + JSONL writer + Tauri commands +
   `log:entry` event + tracing-subscriber bridge + project-mutation
   producer + minimal status bar (latest + error count, no expanded
   console).
2. **Expanded console.** Filters, search, list with op-grouping,
   footer, shortcut bindings. `ActivityPanel` still ships in parallel.
3. **Remaining producers.** Shortcuts, MCP `transcribe_clip` started/
   ok/err with `op_id` grouping, MCP server lifecycle, export
   started/ok/err, import started/ok/err, redactor.
4. **Deletions.** `ActivityPanel` (file + menu entry + i18n),
   menu-bar error span. Routed UI errors to the bus.

### Deferred from Phase 4

* **Derivatives pill.** The design called for deleting it, replaced by
  a "Generating derivatives (N)" *aggregate* row in the bar. Without
  the aggregate-row UI in place (current bar shows a generic running-
  ops counter, not a per-category breakdown), removing the pill would
  be a downgrade — users would lose the specific signal. Land the
  aggregate-row UI first, then delete the pill.
* **Full MCP tool-call transcript.** Phase 3 wired `transcribe_clip`
  as the canonical example; the rest of the tool surface produces log
  entries only via the project-mutation feed (which already covers
  every state-changing tool). Add tool-level Started/Ok wraps for the
  remaining cloud/long-running tools (`synthesize_speech`,
  `detect_silences`) as a polish.
* **Derivative-job producers** (thumbnails / proxy / waveform). Same
  shape as import; deferred together with the pill deletion.
* **True virtualization.** The console renders all 1000 entries
  directly. Modern Chromium handles this fine; switch to `react-window`
  if profiling shows a real cost.
* **Drag-to-resize handle.** The console height is fixed at 40vh; the
  CSS cursor is set but no pointer-drag handler is wired. Add when the
  UX complaint actually surfaces.

Each phase delivers visible value; the consolidation is last so we
never break working UI before its replacement is solid.
