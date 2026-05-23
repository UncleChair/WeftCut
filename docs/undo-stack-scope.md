# Undo-Stack Scope

What records into the editing undo stack and what doesn't. Tightens the
boundary so non-editing operations (project load, media library, canvas
setup) stop polluting the history that Ctrl-Z walks.

This document is the canonical design. Settled in a grilling session on
2026-05-14.

---

## Recording rule

A state mutation records a `HistoryEntry` iff it changes the timeline
structure of the currently-loaded project — layers, tracks, markers,
transitions, composition `duration_us`, or layers cascade-deleted from a
media removal. Everything else broadcasts a non-recorded `ChangeEvent`
through `broadcast_unrecorded`.

## Per-operation classification

| Op | Recorded? |
|---|---|
| `add_track`, `delete_track`, `move_track` | yes |
| `add_layer`, `update_layer`, `update_layer_params`, `move_layer`, `duplicate_layer`, `split_layer`, `delete_layer` | yes |
| `add_marker`, `update_marker`, `remove_marker` | yes |
| `add_transition`, `remove_transition` | yes |
| `add_media_item` | no (already excluded) |
| `set_media_workspace_paths`, `set_media_derivatives` | no (already excluded) |
| `remove_media`, no references / `force=false` | **no** (new) — mirror import |
| `remove_media`, `force=true` cascade-delete | yes (layers actually got deleted) |
| `set_composition` canvas-only fields (`width`/`height`/`fps`/`sample_rate`/`channels`/`color_space`/`background`) | **no** (new) — setup, not editing |
| `set_composition` patch containing `duration_us` | yes (also sets `duration_pinned = true`) |
| `set_composition` mixed patch | **split internally**: canvas part patched everywhere; duration delta recorded as one entry |
| `fit_composition_to_layers` | yes (clears `duration_pinned`; the duration shrink rides the same entry) |
| Passive duration shrink on layer delete / inward trim (unpinned) | **no separate entry** — rides the layer-edit commit that triggered it |
| `replace_state` (open / new project) | **no** (new) — resets `History` to a fresh one-entry stack and clears checkpoints |
| `undo`, `redo` | cursor-only, no new entry |
| `restore_checkpoint` | yes (deliberate user/agent action) |

## Why the snags

`add_media_item` excludes cleanly because imports are additive — no
existing reference in any older snapshot can break, so
`replace_media_pool_everywhere` keeps every snapshot valid.

`remove_media` doesn't have that property: removing media that's
referenced would break older snapshots' validation. Hence the split —
the no-reference branch behaves like an import; the cascade branch stays
recorded because deleting layers is a real edit.

`set_composition` has the same shape. Canvas-only fields can be patched
into every snapshot without invalidating layer references. A
`duration_us` shrink can put older snapshots in an inconsistent state
(layers extending past the new duration), so duration changes stay
recorded.

`replace_state` is a wholesale swap. The previous project's history is
incoherent against the new project's `project_id`, so the stack and
checkpoints are reset rather than carried forward.

## MCP vs user

Both surfaces continue to write into the same `History`. Entries carry
an `Actor::User` / `Actor::Agent { client }` tag (state/actor.rs:35) so
the history panel can distinguish them, but Ctrl-Z walks back across
both because state coherence requires it: selective undo on a shared
mutable state graph is the "history as DAG" problem and out of scope.

Deferred: transaction bracketing — MCP tools `begin_transaction(label)`
/ `commit_transaction()` to collapse a batch of agent calls into a
single undoable entry. Non-breaking addition; revisit when agent
automation becomes heavy enough that stack-flooding hurts UX.

## Code touch points

- `state/history.rs`
  - Add `History::reset(initial: Arc<Project>, actor: Actor)` — replace
    the deque with a single seed entry, clear `checkpoints`.
  - Add `History::replace_composition_everywhere(c: Composition)` —
    mirror `replace_media_pool_everywhere` for the canvas-only fields.

- `state/actor.rs`
  - `do_replace_state` (line ~1959) — call `history.reset(...)` +
    `broadcast_unrecorded`; drop the `modified_at = Utc::now()` line.
    Callers that need `modified_at` bumped do it themselves.
  - `do_remove_media` (line ~1837) — when `referencing.is_empty()`, go
    through the media-pool-everywhere path (no commit). Cascade branch
    unchanged.
  - `do_set_composition` (line ~1556) — split the patch:
    canvas-only fields applied via `replace_composition_everywhere`;
    if `duration_us` is set, a separate `commit` records just the
    duration change. Mixed patches do both, in that order.

- `commands.rs`
  - `project_new_workspace` (line ~849) — verify the call path sets
    `modified_at` via `Project::new_blank` (or wherever appropriate)
    now that `replace_state` no longer does.
  - `open_project` (line ~836) — no change beyond verifying it still
    works without the `modified_at` bump.

- `mcp/mod.rs`
  - Tool description for `undo` (line ~1000) — extend the
    "media imports sit OUTSIDE the undo stack" note to cover the new
    exclusions: project switch, no-ref media removal, canvas-setup
    composition fields.

- Tests
  - `replace_state_swaps_project_in_one_commit` (actor.rs:3120) — flip
    to assert that `replace_state` resets history to a single entry.
  - Add coverage for `remove_media` no-ref skip, `set_composition`
    canvas-only skip, `set_composition` mixed-patch split.
