# Media-loading gate — Design

## Problem

Imported media appears in the Media Pool as soon as `import_media` returns (probe + hash run synchronously, ~10–100 ms), but the file copy into `<workspace>/Media/` happens asynchronously on a background FIFO worker. During the copy window the card visually shows a "Copying…" badge and slightly dims (opacity 0.85), and `draggable` is set to false at the source — but the only thing actually blocking operations is the `draggable` attribute itself. The disabled state is too subtle for users to read, the predicate is open-coded inside `MediaPool`, and the timeline's drop handler does not re-check status when a drop lands. As more entry points are added (right-click menu, keyboard shortcuts, MCP-triggered handlers), each new operation has to remember to re-implement the gate.

## Goal

While a media item is still copying into the workspace, no user-initiated operation on that item should succeed — except cancelling the import. Make the "not ready" state visually unmistakable, and centralise the predicate so future operations cannot bypass it.

## Definition of "loading"

A media item is *loading* iff its `media_id` is in the frontend `importingMediaIds` Set — i.e. its `ImportEntry.status.kind` is `Pending` or `Copying`. Once the entry transitions to `Completed`, `Failed`, or `Cancelled`, the media is *ready* from this feature's perspective.

Out of scope:
- Probe stage (synchronous; the item is not in the pool yet).
- Derivative jobs (proxy, thumbnail sprite, waveform). Layers reference `media_id`, not paths; the renderer falls back to the source path when a proxy is missing. Blocking on derivatives would make large imports unusable.

## Architecture

Three small changes, all on the frontend:

### 1. Centralised predicate

Introduce a single helper used by every consumer that decides whether the user may act on a pool item:

```ts
// apps/desktop/src/panels/mediaReadiness.ts
export function isMediaInteractive(
  media: MediaSummary,
  importingIds: ReadonlySet<string>,
): boolean {
  return media.available && !importingIds.has(media.id);
}
```

`MediaPool` replaces its inline `interactive` calculation with this. Any future handler (context menu, double-click, keyboard, MCP-triggered UI action) imports the same helper. The predicate stays UI-side; backend MCP tool rejection is a separate decision.

### 2. Visual + accessibility hardening in `MediaPool`

In `App.tsx` MediaPool body (around `App.tsx:1348`):
- Add `aria-disabled={!interactive}` to the `<li>`.
- Title attribute already swaps between drag-hint, missing-hint, and importing tooltip — keep.
- `draggable={interactive}` stays.

In `styles.css` `.media-item.is-importing` (currently at `styles.css:3350`):
- Increase the dim from `opacity: 0.85` to `opacity: 0.55` so the card reads clearly as inactive.
- Add `cursor: not-allowed`.
- The cancel-import button overlay keeps `cursor: pointer` and `pointer-events: auto` (already absolute-positioned over the thumb; just confirm it is not affected by the parent cursor).

The visual treatment for `.is-missing` is left unchanged.

### 3. Drop-side defensive check

In `Timeline.tsx onMediaDrop` (`Timeline.tsx:765`), before calling `addMediaLayer`:
- Look up the media in the most recent project summary by `payload.mediaId`.
- If the media is missing from the summary, or its id is in `importingMediaIds`, or `available` is false:
  - No-op (do not call `addMediaLayer`, do not call `onMutated`).
  - Emit a warn-level entry via the existing `LogBus` / status-log path so the rejection is visible in the status bar and console.

This requires plumbing `importingMediaIds` (or a `isMediaInteractive` callback closed over it) into `Timeline`. The MediaPool already receives the Set; the same value can be lifted in `App.tsx` and passed down to `<Timeline />` as a prop (or as a callback `canAcceptMediaDrop(mediaId)`).

Rationale: the source-side `draggable=false` already prevents normal drag initiation. The drop-side check is defence-in-depth for two cases — (a) the status flipping mid-drag once we add more dynamic import flows, and (b) future non-drag entry points that route through the same drop pathway.

## Data flow

```
import_media (Rust)          import:queue event          App.tsx
  │ probe sync                       │                       │
  ├─ insert MediaItem ───────────────┘                       │
  │                                                          │
  └─ queue copy ──────► worker copy ──► import:complete ─────┤
                                                             │
                                  importingMediaIds (Set) ◄──┤
                                                             │
                       ┌─────────────────────────────────────┤
                       ▼                                     ▼
                   <MediaPool                            <Timeline
                    importing= …>                         importing= …>
                       │                                     │
              interactive = isMediaInteractive(…)   onMediaDrop pre-check
                       │                                     │
              draggable, aria-disabled,             reject + LogBus warn
              cursor: not-allowed via CSS           when not interactive
```

## Error handling

- Drop rejection: warn-level log via the existing log/status-log infrastructure. No modal, no toast. The status bar surfaces it briefly; the console keeps the full record. Wording: `media drop rejected: <media_id> is still importing` (or `is missing`).
- Cancel-import button on a loading card continues to be the only interactive affordance and is unchanged.

## Testing

- Manual: import a large file (≥200 MB so the copy phase is visible). While "Copying…" badge is showing, verify:
  - Card opacity is clearly dim and `cursor: not-allowed` shows on hover.
  - The card cannot be dragged (browser refuses to initiate the drag).
  - The cancel-import button overlay is still clickable and cancels the import.
  - Once the badge disappears, the card returns to full opacity and is draggable.
- Drop-side defence: temporarily mark a media as importing via devtools and attempt a drag; the drop must be rejected and a warn line must appear in the status log.
- Regression: a fully-imported media drags onto the timeline as before; status-log shows no warn lines.

## Out of scope (deferred)

- MCP tool rejection — `add_video_layer`, `update_layer`, etc. accepting an importing `media_id` is not blocked here. If an external agent races the import, the current behaviour (silently succeeds, layer references the source path until copy finishes the path swap) is unchanged. Revisit if external agents actually trigger this.
- Blocking on derivative jobs — proxy, thumbnail sprite, waveform. The renderer tolerates their absence.
- Visual treatment for the post-import "derivatives still running" state.
