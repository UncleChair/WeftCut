# Media-loading gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block all UI operations on a media item until it is genuinely usable — workspace copy done, and for video the 540p proxy also ready — and make the not-ready state visually unmistakable.

**Architecture:** Frontend-only change. A new session-scoped `proxyState: Map<mediaId, "pending"|"ready"|"failed">` in `App.tsx` is driven by the existing `media:job_*` Tauri events, filtered to `kind === "proxy"`. A centralised pure helper `mediaReadiness(media, importingIds, proxyState)` returns a `{ ready, reason }` result. The Media Pool card consumes it for `draggable` / class / `aria-disabled`, and the Timeline drop handler consumes it as defence-in-depth before calling `addMediaLayer`. CSS gets reason-specific modifier classes and a deeper dim.

**Tech Stack:** TypeScript, React 19, Vite, vitest, Tauri 2. Backend stays untouched. Tests run with `npm test` from `apps/desktop`.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `apps/desktop/src/panels/mediaReadiness.ts` | Create | Pure `mediaReadiness(...)` helper + exported `ProxyState` / `MediaReadiness` types. No React. |
| `apps/desktop/src/panels/mediaReadiness.test.ts` | Create | vitest unit tests for the helper. |
| `apps/desktop/src/App.tsx` | Modify | Add `proxyState` map state + event listener; pass `proxyState` into `<MediaPool>` and `<Timeline>`; replace inline `interactive` calc in MediaPool with the helper. |
| `apps/desktop/src/timeline/Timeline.tsx` | Modify | Accept `proxyState` + `importing` props; defensive readiness check inside `onMediaDrop` before `addMediaLayer`. |
| `apps/desktop/src/styles.css` | Modify | Replace `.media-item.is-importing` rule, add `.media-item.is-proxy-pending`, `.media-item.is-proxy-failed`, ensure `cursor: not-allowed` on not-ready cards, keep cancel button interactive. |
| `apps/desktop/src/i18n/locales/en-US.ts` | Modify | New strings: `media_pool.proxy_pending`, `media_pool.proxy_failed`, `media_pool.proxy_pending_hint`, `media_pool.proxy_failed_hint`. |
| `apps/desktop/src/i18n/locales/zh-CN.ts` | Modify | Same keys translated. |

---

## Task 1: `mediaReadiness` pure helper (TDD)

**Files:**
- Create: `apps/desktop/src/panels/mediaReadiness.ts`
- Test: `apps/desktop/src/panels/mediaReadiness.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/panels/mediaReadiness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MediaSummary } from "../ipc";
import { mediaReadiness, type ProxyState } from "./mediaReadiness";

const baseVideo = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  id: "m1",
  label: "clip.mp4",
  path: "C:/m/clip.mp4",
  kind: "Video",
  duration_us: 5_000_000,
  width: 1920,
  height: 1080,
  size_bytes: 10_000_000,
  available: true,
  proxy_path: null,
  ...over,
});

const baseAudio = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  ...baseVideo({ kind: "Audio", width: null, height: null, proxy_path: null }),
  ...over,
});

const emptyImporting = new Set<string>();
const emptyProxyState = new Map<string, ProxyState>();

describe("mediaReadiness", () => {
  it("video is ready when proxy_path is set", () => {
    const r = mediaReadiness(
      baseVideo({ proxy_path: "C:/m/clip.proxy.mp4" }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });

  it("video is ready when proxy state map says ready, even without proxy_path", () => {
    const r = mediaReadiness(
      baseVideo(),
      emptyImporting,
      new Map([["m1", "ready"]]),
    );
    expect(r).toEqual({ ready: true });
  });

  it("video falls back to proxy_pending when no path and no map entry", () => {
    const r = mediaReadiness(baseVideo(), emptyImporting, emptyProxyState);
    expect(r).toEqual({ ready: false, reason: "proxy_pending" });
  });

  it("video is proxy_pending when explicitly pending in map", () => {
    const r = mediaReadiness(
      baseVideo(),
      emptyImporting,
      new Map([["m1", "pending"]]),
    );
    expect(r).toEqual({ ready: false, reason: "proxy_pending" });
  });

  it("video is proxy_failed when map says failed", () => {
    const r = mediaReadiness(
      baseVideo(),
      emptyImporting,
      new Map([["m1", "failed"]]),
    );
    expect(r).toEqual({ ready: false, reason: "proxy_failed" });
  });

  it("importing takes precedence over proxy state", () => {
    const r = mediaReadiness(
      baseVideo({ proxy_path: "C:/m/clip.proxy.mp4" }),
      new Set(["m1"]),
      new Map([["m1", "ready"]]),
    );
    expect(r).toEqual({ ready: false, reason: "importing" });
  });

  it("missing takes precedence over proxy state but not importing", () => {
    const r = mediaReadiness(
      baseVideo({ available: false }),
      emptyImporting,
      new Map([["m1", "ready"]]),
    );
    expect(r).toEqual({ ready: false, reason: "missing" });
  });

  it("importing beats missing", () => {
    const r = mediaReadiness(
      baseVideo({ available: false }),
      new Set(["m1"]),
      emptyProxyState,
    );
    expect(r).toEqual({ ready: false, reason: "importing" });
  });

  it("audio is ready once copy is done (no proxy needed)", () => {
    const r = mediaReadiness(baseAudio(), emptyImporting, emptyProxyState);
    expect(r).toEqual({ ready: true });
  });

  it("audio respects importing", () => {
    const r = mediaReadiness(
      baseAudio(),
      new Set(["m1"]),
      emptyProxyState,
    );
    expect(r).toEqual({ ready: false, reason: "importing" });
  });

  it("image is ready once copy is done", () => {
    const r = mediaReadiness(
      baseVideo({ kind: "Image", duration_us: null }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });

  it("subtitle is ready once copy is done", () => {
    const r = mediaReadiness(
      baseVideo({ kind: "Subtitle", duration_us: null }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `apps/desktop`:
```
npm test -- mediaReadiness
```
Expected: FAIL — module `./mediaReadiness` does not exist.

- [ ] **Step 3: Implement the helper**

Create `apps/desktop/src/panels/mediaReadiness.ts`:

```ts
import type { MediaSummary } from "../ipc";

/// Per-video proxy lifecycle, session-scoped. Driven by `media:job_*`
/// events filtered to `kind === "proxy"`. The map only carries entries
/// for media we've observed at least one event for; other videos derive
/// their state from `MediaSummary.proxy_path` (non-null → ready) or
/// default to "pending" if the path is null and no event has arrived.
export type ProxyState = "pending" | "ready" | "failed";

export type MediaReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: "importing" | "missing" | "proxy_pending" | "proxy_failed";
    };

/// Single source of truth for "may the user act on this media?" Used by
/// the Media Pool card (drag source) and by the Timeline drop handler
/// (defence in depth). Precedence: importing > missing > kind-specific
/// derivative checks > ready.
export function mediaReadiness(
  media: MediaSummary,
  importingIds: ReadonlySet<string>,
  proxyState: ReadonlyMap<string, ProxyState>,
): MediaReadiness {
  if (importingIds.has(media.id)) {
    return { ready: false, reason: "importing" };
  }
  if (!media.available) {
    return { ready: false, reason: "missing" };
  }
  if (media.kind === "Video") {
    if (media.proxy_path) return { ready: true };
    const s = proxyState.get(media.id);
    if (s === "ready") return { ready: true };
    if (s === "failed") return { ready: false, reason: "proxy_failed" };
    return { ready: false, reason: "proxy_pending" };
  }
  return { ready: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```
npm test -- mediaReadiness
```
Expected: 12 passing.

- [ ] **Step 5: Commit**

```
git add apps/desktop/src/panels/mediaReadiness.ts apps/desktop/src/panels/mediaReadiness.test.ts
git commit -m "media: add mediaReadiness helper for per-kind ready predicate"
```

---

## Task 2: Proxy-state listener in `App.tsx`

**Files:**
- Modify: `apps/desktop/src/App.tsx` (around the existing import-queue listener at `App.tsx:370-388` and state declarations near `App.tsx:135-149`)

- [ ] **Step 1: Add `proxyState` state and reducer helpers next to `importQueue`**

Locate the line:
```ts
const [importQueue, setImportQueue] = useState<ImportEntry[]>([]);
```
in `App.tsx` (around line 135). Immediately below the `importingMediaIds` `useMemo` block (after line 149), add:

```ts
  // Per-video proxy lifecycle for the current session. Filled by the
  // `media:job_*` listener below (kind === "proxy") and consulted by
  // `mediaReadiness` to decide whether a video clip is usable on the
  // timeline. Cleared keys are not removed — the latest event wins.
  const [proxyState, setProxyState] = useState<Map<string, ProxyState>>(
    () => new Map(),
  );
```

Add the corresponding import next to existing imports from `./panels/...` (or add a new import line near the other `./panels` imports in App.tsx):

```ts
import type { ProxyState } from "./panels/mediaReadiness";
import { mediaReadiness } from "./panels/mediaReadiness";
```

- [ ] **Step 2: Add the `media:job_*` listener effect**

Just below the import-queue listener `useEffect` (which ends around `App.tsx:388`), add a new effect:

```ts
  // Per-media derivative-job tracking — `kind === "proxy"` only. We do
  // NOT gate the UI on thumbnails / waveform; those are decorations.
  // The listener owns transitions started → pending, complete → ready,
  // error → failed. `MediaSummary.proxy_path` from the next summary
  // refresh is the durable source of truth; this map is the fast,
  // session-scoped reflection so the UI flips the moment the event
  // fires instead of waiting on the project:changed round-trip.
  useEffect(() => {
    let unlisteners: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      const set = (id: string, s: ProxyState) =>
        setProxyState((prev) => {
          const next = new Map(prev);
          next.set(id, s);
          return next;
        });
      const onStarted = await listen<MediaJobEvent>(
        MEDIA_JOB_EVENTS.started,
        (e) => {
          if (e.payload.kind === "proxy") set(e.payload.media_id, "pending");
        },
      );
      const onComplete = await listen<MediaJobEvent>(
        MEDIA_JOB_EVENTS.complete,
        (e) => {
          if (e.payload.kind === "proxy") set(e.payload.media_id, "ready");
        },
      );
      const onError = await listen<MediaJobEvent>(
        MEDIA_JOB_EVENTS.error,
        (e) => {
          if (e.payload.kind === "proxy") set(e.payload.media_id, "failed");
        },
      );
      if (cancelled) {
        onStarted();
        onComplete();
        onError();
        return;
      }
      unlisteners = [onStarted, onComplete, onError];
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);
```

Make sure these are imported at the top of `App.tsx` (they should already be, but verify):
```ts
import {
  /* ...existing... */
  MEDIA_JOB_EVENTS,
  type MediaJobEvent,
} from "./ipc";
```

If `MEDIA_JOB_EVENTS` or `MediaJobEvent` is not already imported in `App.tsx`, add it to the existing `from "./ipc"` import block.

- [ ] **Step 3: Typecheck**

Run from `apps/desktop`:
```
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```
git add apps/desktop/src/App.tsx
git commit -m "media: track per-video proxy state from media:job_* events"
```

---

## Task 3: Wire `mediaReadiness` into `MediaPool`

**Files:**
- Modify: `apps/desktop/src/App.tsx` `MediaPool` component body (around `App.tsx:1339-1430`) and the call site around `App.tsx:1038-1044`.

- [ ] **Step 1: Extend `MediaPool` props to accept `proxyState`**

Find the `MediaPool` function declaration in `App.tsx`. Its current signature looks roughly like:

```tsx
function MediaPool({
  media,
  importing,
  onCancelImport,
}: {
  media: MediaSummary[];
  importing: ReadonlySet<string>;
  onCancelImport: (id: string) => Promise<void>;
}) {
```

Change it to:

```tsx
function MediaPool({
  media,
  importing,
  proxyState,
  onCancelImport,
}: {
  media: MediaSummary[];
  importing: ReadonlySet<string>;
  proxyState: ReadonlyMap<string, ProxyState>;
  onCancelImport: (id: string) => Promise<void>;
}) {
```

- [ ] **Step 2: Replace the inline `interactive` calc with `mediaReadiness`**

Inside the `filtered.map((m) => { ... })` body (currently around `App.tsx:1340-1346`), replace:

```ts
const isImporting = importing.has(m.id);
const isMissing = !m.available && !isImporting;
const interactive = !isImporting && !isMissing;
```

with:

```ts
const readiness = mediaReadiness(m, importing, proxyState);
const interactive = readiness.ready;
const reason = readiness.ready ? null : readiness.reason;
```

- [ ] **Step 3: Rewrite the `<li>` className and tooltip**

Replace the `<li>` element's `className` and `title` attributes (around `App.tsx:1350-1369`) with:

```tsx
<li
  key={m.id}
  className={[
    "media-item",
    reason === "importing" ? "is-importing" : "",
    reason === "missing" ? "is-missing" : "",
    reason === "proxy_pending" ? "is-proxy-pending" : "",
    reason === "proxy_failed" ? "is-proxy-failed" : "",
  ]
    .filter(Boolean)
    .join(" ")}
  draggable={interactive}
  aria-disabled={!interactive}
  onDragStart={(e) => {
    e.dataTransfer.setData(
      "application/x-weftcut-media",
      JSON.stringify({ mediaId: m.id, kind: m.kind }),
    );
    e.dataTransfer.effectAllowed = "copy";
  }}
  title={
    interactive
      ? t("media_pool.drag_hint", {
          defaultValue: "Drag onto a track to add",
        })
      : reason === "missing"
        ? t("media_pool.missing_hint", { path: m.path })
        : reason === "proxy_pending"
          ? t("media_pool.proxy_pending_hint", {
              defaultValue: "Preview is being prepared…",
            })
          : reason === "proxy_failed"
            ? t("media_pool.proxy_failed_hint", {
                defaultValue:
                  "Preview could not be prepared. Re-import to retry.",
              })
            : t("media_pool.importing")
  }
>
```

- [ ] **Step 4: Add badges for `proxy_pending` and `proxy_failed`**

Inside `.media-item-thumb`, immediately after the existing `{isImporting && (<button …/>)}` cancel button block (around `App.tsx:1402-1413`), add:

```tsx
                {reason === "proxy_pending" && (
                  <span
                    className="media-proxy-pending-badge"
                    title={t("media_pool.proxy_pending_hint", {
                      defaultValue: "Preview is being prepared…",
                    })}
                  >
                    {t("media_pool.proxy_pending", {
                      defaultValue: "Preparing…",
                    })}
                  </span>
                )}
                {reason === "proxy_failed" && (
                  <span
                    className="media-proxy-failed-badge"
                    title={t("media_pool.proxy_failed_hint", {
                      defaultValue:
                        "Preview could not be prepared. Re-import to retry.",
                    })}
                  >
                    {t("media_pool.proxy_failed", {
                      defaultValue: "Preview failed",
                    })}
                  </span>
                )}
```

Also keep the existing `{isImporting && (<button …/>)}` and `{isMissing && (<span …/>)}` blocks — they are now driven by `reason === "importing"` / `reason === "missing"`. Change:

```tsx
{isImporting && (
```
to:
```tsx
{reason === "importing" && (
```

and:
```tsx
{isMissing && (
```
to:
```tsx
{reason === "missing" && (
```

- [ ] **Step 5: Wire `proxyState` through the call site**

At the `<MediaPool …>` call site in `App.tsx` (around line 1038), change:

```tsx
<MediaPool
  media={summary?.media ?? []}
  importing={importingMediaIds}
  onCancelImport={async (id) => {
    await importCancel(id).catch(() => false);
  }}
/>
```

to:

```tsx
<MediaPool
  media={summary?.media ?? []}
  importing={importingMediaIds}
  proxyState={proxyState}
  onCancelImport={async (id) => {
    await importCancel(id).catch(() => false);
  }}
/>
```

- [ ] **Step 6: Typecheck**

Run from `apps/desktop`:
```
npm run typecheck
```
Expected: no errors.

- [ ] **Step 7: Commit**

```
git add apps/desktop/src/App.tsx
git commit -m "media: gate MediaPool card on per-kind readiness via helper"
```

---

## Task 4: CSS for the not-ready states

**Files:**
- Modify: `apps/desktop/src/styles.css` (around `styles.css:3345-3395`)

- [ ] **Step 1: Replace the existing `.media-item.is-importing` block with the unified not-ready treatment**

Find the block starting at `styles.css:3350`:

```css
.media-item.is-importing {
  opacity: 0.85;
}

.media-item.is-missing {
  opacity: 0.7;
}
```

Replace with:

```css
/* Shared not-ready treatment — the card is visually inert and the
 * pointer reads as not-allowed. The cancel-import button overlay
 * re-enables its own cursor + pointer-events below. */
.media-item.is-importing,
.media-item.is-missing,
.media-item.is-proxy-pending,
.media-item.is-proxy-failed {
  opacity: 0.55;
  cursor: not-allowed;
}

.media-item.is-proxy-failed {
  /* Failed state needs to stand out from the merely-pending one. */
  outline: 1px solid rgba(248, 113, 113, 0.6);
  outline-offset: -1px;
}
```

- [ ] **Step 2: Add the two new badge styles**

Immediately after the existing `.media-missing-badge { … }` block (around `styles.css:3381-3395`), add:

```css
.media-proxy-pending-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(250, 204, 21, 0.85);
  border: 1px solid rgba(250, 204, 21, 0.9);
  color: #0a0c10;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: not-allowed;
  z-index: 2;
}

.media-proxy-failed-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(248, 113, 113, 0.9);
  border: 1px solid rgba(248, 113, 113, 1);
  color: #0a0c10;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  cursor: help;
  z-index: 2;
}
```

- [ ] **Step 3: Ensure the cancel button still feels clickable**

Find the existing `.media-import-cancel` rule (`styles.css:3361`). Append `pointer-events: auto;` after the existing `z-index: 2;` line so the parent `cursor: not-allowed` is overridden cleanly:

```css
.media-import-cancel {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(96, 165, 250, 0.85);
  border: 1px solid rgba(96, 165, 250, 0.9);
  color: #0a0c10;
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  z-index: 2;
  pointer-events: auto;
}
```

- [ ] **Step 4: Commit**

```
git add apps/desktop/src/styles.css
git commit -m "media: clear not-allowed cursor + dim + badges for not-ready cards"
```

---

## Task 5: Locale strings

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Locate the existing `media_pool` block**

In both locale files, find the `media_pool` section (search for `"media_pool"` or `media_pool:`). It already contains keys like `drag_hint`, `importing`, `importing_cancel_hint`, `missing`, `missing_hint`.

- [ ] **Step 2: Add four new keys to `en-US.ts`**

Inside `media_pool: { … }` in `apps/desktop/src/i18n/locales/en-US.ts`, add these four entries (alphabetised among the existing keys is fine, or appended — match the file's existing ordering convention):

```ts
proxy_pending: "Preparing…",
proxy_pending_hint: "Preview is being prepared…",
proxy_failed: "Preview failed",
proxy_failed_hint: "Preview could not be prepared. Re-import to retry.",
```

- [ ] **Step 3: Add the same four keys to `zh-CN.ts`**

In `apps/desktop/src/i18n/locales/zh-CN.ts`:

```ts
proxy_pending: "准备中…",
proxy_pending_hint: "正在生成预览代理…",
proxy_failed: "预览准备失败",
proxy_failed_hint: "预览代理生成失败，请重新导入素材。",
```

- [ ] **Step 4: Typecheck**

```
npm run typecheck
```
Expected: no errors. If either locale file is typed against the other (one is the source of truth), the typecheck would catch a missing key — add it to whichever file is missing.

- [ ] **Step 5: Commit**

```
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "i18n: add proxy_pending / proxy_failed strings"
```

---

## Task 6: Defensive drop-side check in `Timeline.tsx`

**Files:**
- Modify: `apps/desktop/src/timeline/Timeline.tsx` (props ~line 191, `onMediaDrop` at line 765, call site in `App.tsx` ~line 1010-1035)

- [ ] **Step 1: Extend `Timeline` props**

Find the `Timeline` component's props interface near `Timeline.tsx:180-200`. Add two new optional-then-required props:

```ts
  importing: ReadonlySet<string>;
  proxyState: ReadonlyMap<string, ProxyState>;
  media: MediaSummary[];
```

Make sure the imports near the top of `Timeline.tsx` include:

```ts
import { mediaReadiness, type ProxyState } from "../panels/mediaReadiness";
import type { MediaSummary } from "../ipc";
```

Destructure them in the function signature alongside the existing props (e.g. add `importing, proxyState, media,` to the destructuring object).

- [ ] **Step 2: Add the drop-side readiness check inside `onMediaDrop`**

Replace the body of `onMediaDrop` (currently at `Timeline.tsx:765-791`) so the first thing it does after the track-accepts check is look up the media and bail on not-ready:

```ts
  const onMediaDrop = useCallback(
    async (
      track: TrackSummary,
      payload: MediaDragPayload,
      e: React.DragEvent<HTMLDivElement>,
    ) => {
      if (
        !trackAcceptsMedia(track.kind, payload.kind) &&
        !trackAcceptsMediaForAutoRoute(track.kind, payload.kind)
      ) {
        console.warn(
          `track ${track.kind} doesn't accept media of kind ${payload.kind}`,
        );
        return;
      }
      const m = media.find((mm) => mm.id === payload.mediaId);
      if (!m) {
        console.warn(
          `media drop rejected: ${payload.mediaId} not found in current summary`,
        );
        return;
      }
      const readiness = mediaReadiness(m, importing, proxyState);
      if (!readiness.ready) {
        console.warn(
          `media drop rejected: ${payload.mediaId} is ${readiness.reason}`,
        );
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const tStartUs = Math.max(0, Math.round((x / pxPerSec) * 1_000_000));
      try {
        await addMediaLayer(track.id, payload.mediaId, tStartUs);
        await onMutated();
      } catch (err) {
        console.error("media drop failed:", err);
      }
    },
    [importing, media, onMutated, proxyState, pxPerSec],
  );
```

Note the dependency array: `[importing, media, onMutated, proxyState, pxPerSec]` — match the new closure captures or React will warn.

- [ ] **Step 3: Pass the new props from the `<Timeline …>` call site in `App.tsx`**

Find the `<Timeline …>` render in `App.tsx` (search for `<Timeline`). Add three new props to the existing list:

```tsx
            importing={importingMediaIds}
            proxyState={proxyState}
            media={summary?.media ?? []}
```

- [ ] **Step 4: Typecheck**

```
npm run typecheck
```
Expected: no errors.

- [ ] **Step 5: Commit**

```
git add apps/desktop/src/timeline/Timeline.tsx apps/desktop/src/App.tsx
git commit -m "timeline: reject drop of not-ready media as defence in depth"
```

---

## Task 7: Manual verification

The behaviour is visual and event-driven; the existing automated tests cover the pure helper. This task is a manual smoke pass to confirm the wiring.

- [ ] **Step 1: Launch the app**

From `apps/desktop`:
```
npm run tauri:dev
```

- [ ] **Step 2: Large-video happy path**

1. Drag a ≥1 GB / ≥4K video file into the Media Pool.
2. Observe: card appears immediately with a "Copying…" cancel-import overlay; opacity is clearly dim (~0.55) and the cursor reads `not-allowed` on hover. Drag is refused (browser shows the no-entry cursor when you try).
3. Wait for the copy badge to disappear. The card should immediately switch to a yellow "Preparing…" badge and stay dim/not-draggable.
4. Wait for the proxy job to finish. The yellow badge disappears, opacity returns to full, drag works, the card drags onto the timeline.

- [ ] **Step 3: Audio / image / subtitle happy path**

1. Import a small .mp3 or .png.
2. The card shows "Copying…" briefly then becomes immediately interactive — no "Preparing…" badge (audio/image/subtitle do not gate on proxy).

- [ ] **Step 4: Proxy-failure path**

Easiest reproduction: import a known-bad / corrupted video file. Otherwise, temporarily edit `apps/desktop/src-tauri/src/jobs/proxy.rs` to return an error unconditionally, rebuild, and import any video; revert when done.

1. Card cycles `Copying… → Preparing…` then lands in the red "Preview failed" state with a red outline.
2. Hovering shows the "Re-import to retry" tooltip; the card is not draggable.

- [ ] **Step 5: Drop-side defence**

In the running app's DevTools console:
1. Find a not-ready video card via `document.querySelector('.media-item.is-proxy-pending')`.
2. Force its `draggable` attribute to `true` and drag it onto the timeline.
3. Expect: no layer is added and the DevTools console shows `media drop rejected: <id> is proxy_pending`.

- [ ] **Step 6: Project reopen**

1. Quit the app.
2. Reopen. Observe: previously-imported videos with proxies on disk land in the pool already-ready (no "Preparing…" flash). Videos whose proxies are missing show "Preparing…" until the re-enqueued proxy job completes.

- [ ] **Step 7: Run the full test suite**

```
npm test
npm run typecheck
```
Expected: all passing, no type errors.

- [ ] **Step 8: Commit (if any small fixes landed during manual pass)**

```
git status
# if there are changes:
git add -p
git commit -m "media: post-manual-verification fixes"
```

---

## Self-Review

**Spec coverage (rechecked against `docs/superpowers/specs/2026-05-24-media-loading-gate-design.md`):**

- Per-kind readiness table → Task 1 (`mediaReadiness` body) ✓
- Per-video proxy state tracker driven by `media:job_*` filtered to `proxy` → Task 2 ✓
- Centralised predicate `mediaReadiness` returning `{ready, reason}` → Task 1 ✓
- MediaPool: `draggable`, `aria-disabled`, reason-specific class, reason-specific badge → Task 3 ✓
- CSS: bumped dim, `cursor: not-allowed`, new badge styles, cancel button stays interactive → Task 4 ✓
- Drop-side defensive check in `onMediaDrop` with `console.warn` → Task 6 ✓ (spec called this "LogBus warn" but the existing frontend convention — including the sibling `console.warn` for track-kind rejection at `Timeline.tsx:775` — is `console.warn`; using the same pattern.)
- Proxy-failure path: card stays not-draggable, distinct visual state, tooltip points at re-import → Task 3 + Task 4 + Task 5 ✓
- Project-reopen boot path: video with `proxy_path` non-null is ready; null → derived "pending" until event arrives → covered by `mediaReadiness` default branch + Task 7 step 6 verification ✓

**Out-of-scope items from the spec are correctly omitted:**
- No manual proxy retry UI
- No MCP tool rejection
- No thumbnail / waveform gating
- No proxy-job cancellation

**Placeholder scan:** no TBD / TODO / "handle edge cases" / "similar to Task N". Every code step shows the actual code.

**Type consistency:** `ProxyState` and `MediaReadiness` are defined in Task 1 and used unchanged in Tasks 2, 3, 6. `mediaReadiness(media, importing, proxyState)` signature is identical at every call site. The locale keys `proxy_pending`, `proxy_pending_hint`, `proxy_failed`, `proxy_failed_hint` are spelled identically in Tasks 3 and 5.
