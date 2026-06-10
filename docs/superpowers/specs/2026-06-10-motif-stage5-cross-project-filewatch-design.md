# Motif Stage 5 — cross-project staleness signal + user-Motif file watch

**Date:** 2026-06-10
**Status:** approved (brainstormed + design accepted in session)
**Parent:** `2026-06-08-motif-upload-authoring-design.md` — this closes out the two remaining
pieces of Plan 4: §7-B (on-open staleness detection) and the §6 external-editor watch that was
deferred out of Stage 3b-3. With this stage, Plan 4 is complete.

## 1. Goals

1. **File watch (hot reload).** An external editor saving a user Motif's `.html` on disk makes the
   in-app preview update automatically — no UI action, no restart. Applies to drafts **and**
   installed user Motifs alike.
2. **Cross-project staleness signal (§7-B).** Opening a project whose placed Motif layers carry a
   `motif_version` older (or otherwise different) than the catalog's current version surfaces a
   one-time summary notice: *"lower-third v1→v3 (3 layers)"*. Dismissing it acknowledges (bumps the
   seen-at markers) so the notice doesn't repeat next open.
3. **Caveat A.** The Update-in-place confirm message additionally states that other projects pick
   up the new look the next time they open.

Explicitly **not** in scope (decided during brainstorm):

- No "open in editor" / "reveal in folder" entry point — watch only. The user finds the file
  themselves.
- No per-layer stale badge in the timeline/property panel — the summary dialog + status log is the
  whole surface.
- No global `motif_id → usage` reverse index (per parent spec §7).

## 2. File watch

### Mechanism

Rust-side `notify` watcher (new dependency; **not** the `tauri-plugin-fs` `watch` feature — that
would require widening the webview's fs capability scope to app-data and adds TS lifecycle
management for zero benefit; it pulls in `notify` anyway).

- New `motifs/watcher.rs`. Spawned during app setup (lib.rs), after `UserMotifStore` is managed.
- Watches the **user-Motif root** (`<app_config_dir>/motifs/`) **recursively** — drafts and
  installed both. `create_dir_all` the root first (first boot has no user Motifs yet; the watcher
  must still attach).
- Events are **debounced ~400 ms** and coalesced; the debounced tick does exactly one thing:
  `emit_motifs_changed(&app)`.
- The watcher handle is kept alive in managed state so it isn't dropped; lifetime = app lifetime.

### What it deliberately does NOT do

- No per-file dispatch — `motifs:changed` triggers a full, idempotent resync; which file changed is
  irrelevant.
- No filtering of the app's own writes — `install`/`delete`/`amend` emit `motifs:changed`
  themselves and *also* trip the watcher; the debounce + idempotent resync absorb the duplicate.
- No new TS code. The existing chain does everything:
  `motifs:changed` → `syncUserMotifsFromBackend` → `setUserMotifs` → catalog notifier →
  `Compositor.refreshMotifs` / picker re-fetch; the recomputed `content_hash` changes the frame
  cache key and the `?v=<content_hash>` host-URL cache-buster forces the capture host to reload
  the edited page (the 3b-2 pipeline, reused verbatim).

### Known limitation (accepted)

A non-atomic external write can let one capture read a half-written file; the next debounced event
re-syncs and self-heals. Documented, not defended against.

## 3. Staleness report (§7-B)

### Compute — Rust, pull-based

New command **`motif_staleness_report`** (no args):

- Scan the actor snapshot for `LayerParams::Motif`.
- Resolve each `motif_id`'s **current** version from the catalog (built-ins + `UserMotifStore`).
- Report on **any inequality** (`placed != current` — covers downgrade/reinstall; message format
  is always `v{placed}→v{current}`).
- Skip: layers whose version equals current; layers whose `motif_id` isn't in the catalog (the
  existing "unknown Motif" handling owns that case). Draft layers need no special case — drafts are
  always version 1 and content-hash-keyed, so no mismatch arises.
- Group by `motif_id`: `[{ motif_id, name, placed_version (min across layers), current_version,
  layer_count }]`.
- When the report is non-empty, push one LogBus **warn** entry summarizing it (the command is
  called once per open by contract, so this doesn't spam).

Pull (UI asks after open) was chosen over push (emit during `project_open`) to avoid any
listener-installation ordering dependency, keep `project_new_workspace` untouched, and keep the
computation a plain testable function.

### Trigger

`StartupScreen`, after a successful `project_open` IPC call — the single open funnel. (New
projects are empty; no call.) A non-empty report is written to a small frontend store; the editor
root mounts **`MotifStaleDialog`**.

### Surface

`MotifStaleDialog`, modeled on `ImportProxyDialog` (same visual + interaction pattern):

- One line per entry: `{name} v{from}→v{to} ({count} layers)` (i18n, zh + en).
- A note clarifying the live/mutable semantics: these layers **already render** with the current
  version — the layer's `motif_version` is a seen-at marker, not a render pin (parent spec §8.1).
  The dialog informs; it does not offer to revert.
- Single button **"知道了 / Got it"** = acknowledge + close.

### Acknowledge (dismiss = ack)

New command **`acknowledge_motif_staleness`** (no args):

- **Recomputes** the mismatch set from the *current* snapshot (does not trust layer ids captured at
  open time — the user may have deleted/changed layers between open and dismiss).
- Builds `MotifRebindEntry { layer_id, motif_id (unchanged), motif_version = current, props
  (unchanged) }` for each mismatched layer and calls the existing `rebind_motif` actor command —
  **one undo entry**.
- Zero mismatches → close without touching the actor.
- Undoing the ack reverts the markers; the next open warns again. Honest by design.
- Not saved = not acknowledged: if the user dismisses but never saves, the next open warns again.

## 4. Caveat A + strings

- Append to `motif_update_confirm_one` / `motif_update_confirm_many` (zh + en):
  *"其他项目会在下次打开时切换到新版本。/ Other projects switch to the new version the next time
  they open."*
- New `motif_stale.*` i18n group: title, per-entry line template, live/mutable note, dismiss.

## 5. Edge cases

| Case | Behavior |
|---|---|
| Half-written file during external save | One bad capture possible; next debounce event self-heals (accepted) |
| `placed > current` (downgrade/reinstall) | Reported, same message shape |
| Draft layers | Never mismatch (always v1, hash-keyed) — no special case |
| Built-in version bump (future app update) | Same notice path, consistent behavior |
| Layers deleted between open and dismiss | Ack recomputes from current snapshot |
| Watcher root missing at boot | `create_dir_all` before attach |
| App's own disk writes | Duplicate `motifs:changed`, absorbed by debounce + idempotent resync |

## 6. Testing

- **Rust unit:** report computation (mix of builtin/user/unknown/equal/downgrade/multi-layer
  grouping); ack builds correct rebind entries (props untouched, version bumped); debounce
  coalescing logic.
- **TS (vitest):** dialog renders entries; store flow.
- **E2E (real WebView2):**
  - *Hot reload:* install + place a user Motif, sample canvas color; the e2e runner (Node) rewrites
    the installed `.html` on disk directly; assert the preview color changes with **no UI action**.
  - *Staleness:* project 1 places the Motif at v1 and saves → in project 2 (or post-switch), update
    the Motif to v2 via draft+install-update → reopen project 1 → dialog shows v1→v2 → dismiss →
    save → reopen → no dialog.

## 7. Implementation notes

- Branch `worktree-feat+motif-stage5-filewatch` (worktree off origin/main post-EOS-tail-merge).
- New dep: `notify` (debounce either via `notify-debouncer-mini` or a small hand-rolled
  coalescer — plan decides; the spec requirement is ~400 ms coalescing into one emit).
- `MotifView` does **not** need `motif_version` exposed to TS — both report and ack compute
  Rust-side.
