# Undo-Stack Scope

What records into the editing undo stack and what doesn't. Tightens the
boundary so non-editing operations (project load, media library, canvas
setup) stop polluting the history that Ctrl-Z walks.

This document is implemented in the actor/history layer (TypeScript, `src/main/state/`).

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
| `update_track_flags` (eye/M/S/lock toggles) | no — unrecorded; patched into every history snapshot; undo never flips a track control |
| `add_layer`, `update_layer`, `update_layer_params`, `move_layer`, `duplicate_layer`, `split_layer`, `delete_layer` | yes |
| `add_marker`, `update_marker`, `remove_marker` | yes |
| `add_transition`, `remove_transition` | yes |
| `add_media_item` | no |
| `set_media_workspace_paths`, `set_media_derivatives` | no |
| `remove_media`, no references / `force=false` | no — mirror import |
| `remove_media`, `force=true` cascade-delete | yes (layers actually got deleted) |
| `set_composition` canvas-only fields (`width`/`height`/`sample_rate`/`channels`/`color_space`/`background`) | no — setup, not editing |
| `set_composition` patch containing `duration_us` | yes (also sets `duration_pinned = true`) |
| `set_composition` patch changing `fps` | yes — re-snaps every layer's `t_start_us`/`t_end_us` to the new grid |
| `set_composition` mixed patch (canvas + duration, no fps change) | **split internally**: canvas part patched everywhere; duration delta recorded as one entry |
| `fit_composition_to_layers` | yes (clears `duration_pinned`; the duration shrink rides the same entry) |
| Passive duration shrink on layer delete / inward trim (unpinned) | **no separate entry** — rides the layer-edit commit that triggered it |
| `replace_state` (open / new project) | **no** — resets `History` to a fresh one-entry stack and clears checkpoints |
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
recorded. An `fps` change is treated as editing because it re-snaps
layer geometry across the timeline.

`replace_state` is a wholesale swap. The previous project's history is
incoherent against the new project's `project_id`, so the stack and
checkpoints are reset rather than carried forward.

## MCP vs user

Both surfaces continue to write into the same `History`. Entries carry
an `Actor::User` / `Actor::Agent { client }` tag so the history panel
can distinguish them, but Ctrl-Z walks back across both because state
coherence requires it: selective undo on a shared mutable state graph
is the "history as DAG" problem and out of scope.

While the agent holds `lock_history(reason)`, every revert path
(`undo`, `redo`, `restore_checkpoint`) rejects with
`HistoryLocked`. The lock is ephemeral — released on workspace swap
(`History::reset`) and via `unlock_history`. It does not affect what
gets recorded; it only blocks the user from reverting mid-batch.

Deferred: transaction bracketing — MCP tools `begin_transaction(label)`
/ `commit_transaction()` to collapse a batch of agent calls into a
single undoable entry. Non-breaking addition; revisit when agent
automation becomes heavy enough that stack-flooding hurts UX.

## Implementation

| Concern | Location |
|---|---|
| History stack, `reset`, out-of-band pool/canvas patching | `apps/desktop/native/src/state/history.rs` |
| Per-op record vs `broadcast_unrecorded` routing | `apps/desktop/native/src/state/actor.rs` — `do_*` handlers |
| `replace_state` → `history.reset` + unrecorded broadcast | `do_replace_state` |
| No-ref `remove_media` → `replace_media_pool_everywhere` | `do_remove_media` |
| Canvas/duration/fps split on `set_composition` | `do_set_composition` |
| MCP `undo` tool description (out-of-stack exclusions) | `apps/desktop/native/src/mcp/mod.rs` |
| Open / new project call paths | `apps/desktop/native/src/commands/` |

Tests in `actor.rs`: `replace_state_resets_history_to_fresh_stack`,
`replace_state_does_not_touch_modified_at`,
`remove_media_with_no_references_does_not_record`,
`set_composition_canvas_only_does_not_record`,
`set_composition_mixed_patch_splits`.
