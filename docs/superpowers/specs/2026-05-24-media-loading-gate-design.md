# Media-loading gate — Design

## Problem

Imported media appears in the Media Pool as soon as `import_media` returns (probe + hash run synchronously, ~10–100 ms), but several stages then run in the background:

1. **Workspace copy** — the source file is copied into `<workspace>/Media/` via a FIFO worker.
2. **Proxy generation** — `jobs/proxy.rs` transcodes the source to a 540p H.264+AAC proxy. The preview/export pipeline uses this proxy via `playbackPathFor` (source path is the fallback).
3. **Thumbnails & waveform** — sprite for timeline preview, peaks for silence detection and waveform strip.

Today the only gate on user operations is the source-side `draggable` attribute on a media card, and it only tracks stage 1 (workspace copy). For a large 4K source file, dragging onto the timeline immediately after copy completes places a clip whose playback path falls back to the original 4K source — WebCodecs decoding stalls or stutters at that resolution, so the placed clip is effectively unusable until the proxy lands. The card looks "done", but isn't.

Additionally, the disabled state is visually subtle (`opacity: 0.85`, no `cursor: not-allowed`, no `aria-disabled`), and the readiness predicate is open-coded inside `MediaPool`. As more entry points are added (right-click menu, keyboard shortcuts, MCP-triggered UI handlers), each one would have to re-implement the gate.

## Goal

A media item must not be operable in the UI until its `media_id` is *actually* usable on the timeline. For video this means the proxy must be available; for other kinds, the workspace copy is sufficient. Make the not-ready state visually unmistakable, and centralise the predicate so future operations cannot bypass it. Proxy generation failures should surface clearly rather than silently degrade to a stuttering fallback.

## Definition of "ready"

| Kind | Ready when |
|---|---|
| Video | workspace copy is done **and** the proxy is ready (`media.proxy_path` non-null, or a `media:job_complete kind=proxy` event has fired for this `media_id`) |
| Audio | workspace copy is done |
| Image | workspace copy is done |
| Subtitle | workspace copy is done |

A video whose proxy job errors out (`media:job_error kind=proxy`) does **not** become ready. The card shows a clear failed state instead of silently falling back to source-path playback. Retry / re-import is left for the user; the UI surfaces the failure rather than masking it.

Thumbnails and waveform never gate readiness — they are timeline decorations and an offline-analysis input, not a precondition for previewing the clip.

## Architecture

All changes are on the frontend.

### 1. Per-video proxy state tracker

A new piece of frontend state (in `App.tsx`, sibling to `importQueue`) tracks proxy progress for each video media:

```ts
type ProxyState = "pending" | "ready" | "failed";
const [proxyState, setProxyState] = useState<Map<string, ProxyState>>(new Map());
```

Wiring:
- On `media:job_started` with `kind === "proxy"`: set `proxyState[media_id] = "pending"`.
- On `media:job_complete` with `kind === "proxy"`: set `proxyState[media_id] = "ready"` (the next `summary.media[*].proxy_path` will also reflect this; the explicit state is for fast UI reaction before the next `project:changed` refresh).
- On `media:job_error` with `kind === "proxy"`: set `proxyState[media_id] = "failed"`.
- Derived for any video already in the latest summary: if `proxy_path` is non-null, treat as `"ready"` regardless of map entry (covers the boot path where a previously-imported project has proxies on disk).

Project-load boot path: for videos with `proxy_path === null` that we have no event for yet, treat them as `"pending"` until an event arrives. This matches the user's expectation that "I just opened the project and the proxy job is re-running on a video that lost its proxy file".

### 2. Centralised predicate

A single helper used by every consumer that decides whether the user may act on a pool item:

```ts
// apps/desktop/src/panels/mediaReadiness.ts
export type MediaReadiness =
  | { ready: true }
  | { ready: false; reason: "importing" | "missing" | "proxy_pending" | "proxy_failed" };

export function mediaReadiness(
  media: MediaSummary,
  importingIds: ReadonlySet<string>,
  proxyState: ReadonlyMap<string, ProxyState>,
): MediaReadiness {
  if (importingIds.has(media.id)) return { ready: false, reason: "importing" };
  if (!media.available) return { ready: false, reason: "missing" };
  if (media.kind === "Video") {
    if (media.proxy_path) return { ready: true };
    const s = proxyState.get(media.id) ?? "pending";
    if (s === "ready") return { ready: true };
    if (s === "failed") return { ready: false, reason: "proxy_failed" };
    return { ready: false, reason: "proxy_pending" };
  }
  return { ready: true };
}
```

`MediaPool` replaces its inline `interactive` calculation with this. Any future handler (context menu, double-click, keyboard, MCP-triggered UI action) imports the same helper.

### 3. MediaPool visual + accessibility hardening

In `App.tsx` MediaPool body (around `App.tsx:1348`):
- Compute `readiness = mediaReadiness(m, importing, proxyState)`.
- `draggable={readiness.ready}`.
- `aria-disabled={!readiness.ready}`.
- `className` adds a reason-specific modifier: `is-importing` (existing), `is-missing` (existing), new `is-proxy-pending`, new `is-proxy-failed`.
- Badge text in the existing cancel-button overlay covers `importing` / `proxy_pending` (showing a label like "Preparing preview…" with no cancel action for the proxy case, or reuse the cancel overlay design with a different label and no click handler). Drop the cancel button for non-importing not-ready states.
- For `proxy_failed`: show a distinct red/warn badge with the file name still visible; tooltip carries the error class.

In `styles.css` (after the existing `.media-item.is-importing` block at `styles.css:3350`):
- Bump dim to `opacity: 0.55` for all not-ready states so the card reads clearly as inactive.
- Add `cursor: not-allowed` on `.media-item:not(.is-ready):hover` (or equivalent — define a single not-ready selector).
- `.media-item.is-proxy-failed` gets a warn-coloured border / badge.
- The cancel-import button (when present) keeps `cursor: pointer` and `pointer-events: auto`.

### 4. Drop-side defensive check

In `Timeline.tsx onMediaDrop` (`Timeline.tsx:765`), before calling `addMediaLayer`:
- Look up the media in the most recent project summary by `payload.mediaId`.
- Compute readiness with the same `mediaReadiness` helper, with `proxyState` plumbed in from `App.tsx`.
- If not ready: no-op (no `addMediaLayer`, no `onMutated`), emit a warn-level entry via the existing LogBus / status-log path. Message: `media drop rejected: <media_id> (<reason>)`.

Source-side `draggable=false` already blocks drag initiation; this drop-side check is defence-in-depth for status flipping mid-drag and for future non-drag drop pathways (e.g. paste, MCP-triggered drop).

## Data flow

```
import_media (Rust)
  │ probe sync
  ├─ insert MediaItem ─────────────► import:queue event ──► importingMediaIds
  │
  └─ queue copy → worker copy → import:complete event
                                    │
                                    └─► proxy job → media:job_started kind=proxy
                                                    │
                                                    └─► media:job_complete kind=proxy
                                                        │
                                                        └─► proxyState["mediaId"] = ready
                                                            (or "failed" on error)
        ┌────────────────────────────────────────────────────────────────────────┐
        ▼                                                                        ▼
   <MediaPool>                                                            <Timeline>
   mediaReadiness(m, importing, proxyState)                              same helper at drop time
        │
        ├─ ready=true   → draggable, cursor: grab
        └─ ready=false  → draggable=false, aria-disabled,
                          cursor: not-allowed, reason-specific badge
```

## Error handling

- **Drop rejection** (defence-in-depth path): warn-level entry through the existing LogBus / status-log infrastructure. No modal, no toast. Wording: `media drop rejected: <media_id> is <reason>`.
- **Proxy failure**: the card stays in `is-proxy-failed` state until the user re-imports or otherwise retries. No automatic retry in this design. The error detail is available via the tooltip and the existing `media:job_error` log line.
- **Cancel-import button** on an `is-importing` card continues to be the only interactive affordance on a not-ready card. For `is-proxy-pending` and `is-proxy-failed`, the whole card is inert (no cancel — cancelling a proxy job is not currently exposed).

## Testing

Manual scenarios:
- **Large video import (≥1 GB, 4K)**: card cycles `is-importing` → `is-proxy-pending` → ready. Drag is blocked through both not-ready phases; opacity and `cursor: not-allowed` are obvious. Drop attempted via devtools (manually setting `draggable=true`) is rejected with a status-bar warn.
- **Small video import**: `is-importing` is brief, `is-proxy-pending` is brief, transition to ready feels seamless.
- **Audio import**: gate clears as soon as copy completes (no proxy step).
- **Image / subtitle**: same as audio.
- **Project reopen with proxies on disk**: video cards are ready immediately (driven by `media.proxy_path` from summary).
- **Project reopen after losing proxy files**: cards re-enter `is-proxy-pending` until the re-enqueued proxy job completes.
- **Proxy job error** (simulate via fault injection or a known-bad file): card lands in `is-proxy-failed` with the warn badge; drag is blocked; status-log carries the error.

Regression:
- A fully-ready media drags onto the timeline as before; status-log shows no warn lines.
- The existing "Copying…" cancel-import overlay still cancels imports.

## Out of scope (deferred)

- **Manual proxy retry / regenerate** from the UI. The current path is re-import. Add later if the failure rate justifies it.
- **MCP tool rejection** — `add_video_layer`, `update_layer`, etc. accepting a not-ready `media_id` is unchanged. External agents racing the import is rare; revisit if it shows up.
- **Thumbnail / waveform gating** — these are decorations, not preconditions for usability.
- **Proxy-job cancellation** UX. Currently no way to cancel an in-flight proxy job; not part of this gate.
