# Timeline Content Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the first pass of content-aware timeline clips from `docs/timeline-content-preview.md`.

**Architecture:** Keep `LayerBlock` responsible for geometry, hit testing, selection, dragging, labels, and chrome. Delegate clip-body rendering to focused renderer components that request thumbnail and waveform resources progressively, with backend thumbnail manifests exposed through the existing single-media forwarding path.

**Tech Stack:** Electron renderer, React 19, Vitest/jsdom, TypeScript, Rust native commands behind the `jobs` feature.

---

## Starting State

The worktree already contains uncommitted implementation for the main backend and renderer path:

- `apps/desktop/native/src/commands/media.rs` adds `get_media_thumbnails`.
- `apps/desktop/native/src/napi_backend.rs`, `apps/desktop/src/main/state/router.ts`, and `apps/desktop/src/main/state/single-media-forward.ts` route the new command.
- `apps/desktop/src/renderer/ipc/index.ts` exposes `getMediaThumbnails`.
- `apps/desktop/src/renderer/timeline/TimelineVisualPreview.tsx`, `TimelineFilmstrip.tsx`, and `TimelineWaveform.tsx` provide first-pass preview components.
- `LayerBlock.tsx`, `geometry.ts`, and timeline tests are already partially updated.

Do not revert or rewrite those changes. Finish the missing resource visibility gate, add focused tests, then verify.

## File Structure

- Modify `apps/desktop/src/renderer/timeline/TimelineVisualPreview.tsx`: own width and viewport/near-viewport preview request gating.
- Create `apps/desktop/src/renderer/timeline/TimelineVisualPreview.test.tsx`: prove video preview requests are delayed until the block is visible/near-visible.
- Modify only if test output requires it:
  - `apps/desktop/src/renderer/timeline/TimelineFilmstrip.tsx`
  - `apps/desktop/src/renderer/timeline/TimelineWaveform.tsx`
  - `apps/desktop/src/renderer/timeline/LayerBlock.tsx`
  - backend routing files listed above

---

### Task 1: Add Visibility-Gated Preview Requests

**Files:**
- Modify: `apps/desktop/src/renderer/timeline/TimelineVisualPreview.tsx`
- Create: `apps/desktop/src/renderer/timeline/TimelineVisualPreview.test.tsx`

- [ ] **Step 1: Write the failing visibility-gating test**

Create `apps/desktop/src/renderer/timeline/TimelineVisualPreview.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerSummary } from "../ipc";
import { TimelineVisualPreview } from "./TimelineVisualPreview";

const mocks = vi.hoisted(() => ({
  getMediaThumbnails: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@/bridge/events", () => ({
  listen: mocks.listen,
}));

vi.mock("@/bridge/ipc", () => ({
  convertFileSrc: (path: string) => `weftcut-media://test/${path}`,
}));

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    getMediaThumbnails: mocks.getMediaThumbnails,
  };
});

const staticNum = (value: number) => ({ mode: "Static" as const, value });

const videoLayer: LayerSummary = {
  id: "video-1",
  label: "Video",
  t_start_us: 0,
  t_end_us: 2_000_000,
  kind: "VideoClip",
  color_hint: "#446688",
  enabled: true,
  locked: false,
  params: {
    kind: "VideoClip",
    media_id: "media-1",
    media_label: "media.mov",
    src_in_us: 0,
    src_out_us: 2_000_000,
    x: staticNum(0),
    y: staticNum(0),
    scale_x: staticNum(1),
    scale_y: staticNum(1),
    opacity: staticNum(1),
    speed: 1,
    flip_h: false,
    flip_v: false,
    fade_in_us: 0,
    fade_out_us: 0,
  },
  effects: [],
};

describe("TimelineVisualPreview", () => {
  let observerCallback: IntersectionObserverCallback | null = null;
  let observedElement: Element | null = null;
  let originalIntersectionObserver: typeof globalThis.IntersectionObserver | undefined;

  beforeEach(() => {
    mocks.getMediaThumbnails.mockReset();
    mocks.getMediaThumbnails.mockRejectedValue("not_ready");
    mocks.listen.mockClear();
    observerCallback = null;
    observedElement = null;
    originalIntersectionObserver = globalThis.IntersectionObserver;
    class FakeIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [];
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe(element: Element) {
        observedElement = element;
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as typeof globalThis.IntersectionObserver;
  });

  afterEach(() => {
    cleanup();
    globalThis.IntersectionObserver = originalIntersectionObserver;
  });

  it("does not request video thumbnails until the preview is near the viewport", async () => {
    render(
      <TimelineVisualPreview
        layer={videoLayer}
        layerWidthPx={160}
        layerHeightPx={32}
      />,
    );

    await waitFor(() => {
      expect(observedElement).not.toBeNull();
    });
    expect(mocks.getMediaThumbnails).not.toHaveBeenCalled();

    act(() => {
      observerCallback?.(
        [
          {
            isIntersecting: true,
            intersectionRatio: 1,
            target: observedElement,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });

    await waitFor(() => {
      expect(mocks.getMediaThumbnails).toHaveBeenCalledWith("media-1");
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm --workspace apps/desktop exec vitest run src/renderer/timeline/TimelineVisualPreview.test.tsx
```

Expected: FAIL because `TimelineVisualPreview` currently enables `TimelineFilmstrip` immediately.

- [ ] **Step 3: Implement viewport/near-viewport gating**

In `apps/desktop/src/renderer/timeline/TimelineVisualPreview.tsx`, update imports:

```tsx
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@/bridge/ipc";
import {
  LAYER_LABEL_MIN_PX,
  LAYER_PREVIEW_MIN_PX,
} from "./geometry";
```

Add this helper below `fallbackFill`:

```tsx
function usePreviewResourceGate(enabledByWidth: boolean) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [enabled, setEnabled] = useState(
    () => enabledByWidth && typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (!enabledByWidth) {
      setEnabled(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setEnabled(true);
      return;
    }
    const element = rootRef.current;
    if (!element) return;
    setEnabled(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some(
            (entry) => entry.isIntersecting || entry.intersectionRatio > 0,
          )
        ) {
          setEnabled(true);
        }
      },
      {
        root: null,
        rootMargin: "256px 512px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabledByWidth]);

  return { enabled, rootRef };
}
```

Inside `TimelineVisualPreview`, call the hook before the width return and pass `resourceEnabled` into media-backed previews:

```tsx
const canRenderPreview = layerWidthPx >= LAYER_PREVIEW_MIN_PX;
const { enabled: resourceEnabled, rootRef } =
  usePreviewResourceGate(canRenderPreview);
const imageMedia = useMediaById(
  layer.params.kind === "ImageOverlay" ? layer.params.media_id : null,
);
if (!canRenderPreview) return null;
```

Replace `enabled` on `TimelineFilmstrip` and `TimelineWaveform` with `enabled={resourceEnabled}`. Render image overlays only when the resource gate is open:

```tsx
case "ImageOverlay":
  return resourceEnabled && imageMedia?.available ? (
    <img
      className="h-full w-full object-cover"
      src={convertFileSrc(imageMedia.path)}
      alt=""
      draggable={false}
    />
  ) : (
    fallbackFill(layer.color_hint)
  );
```

Attach the ref to the returned root element:

```tsx
<div
  ref={rootRef}
  data-testid="timeline-visual-preview"
  className="pointer-events-none absolute inset-0 overflow-hidden"
  style={{ borderRadius: "inherit", backgroundColor: layer.color_hint }}
  aria-hidden="true"
>
```

- [ ] **Step 4: Run the new test to verify it passes**

Run:

```bash
npm --workspace apps/desktop exec vitest run src/renderer/timeline/TimelineVisualPreview.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/timeline/TimelineVisualPreview.tsx apps/desktop/src/renderer/timeline/TimelineVisualPreview.test.tsx
git commit -m "feat: gate timeline preview resource requests"
```

---

### Task 2: Verify Preview Components and Layer Integration

**Files:**
- Modify only if failures require it:
  - `apps/desktop/src/renderer/timeline/TimelineFilmstrip.tsx`
  - `apps/desktop/src/renderer/timeline/TimelineFilmstrip.test.ts`
  - `apps/desktop/src/renderer/timeline/TimelineWaveform.tsx`
  - `apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx`
  - `apps/desktop/src/renderer/timeline/LayerBlock.tsx`
  - `apps/desktop/src/renderer/timeline/Timeline.interaction.test.tsx`

- [ ] **Step 1: Run focused renderer timeline tests**

Run:

```bash
npm --workspace apps/desktop exec vitest run src/renderer/timeline/TimelineVisualPreview.test.tsx src/renderer/timeline/TimelineFilmstrip.test.ts src/renderer/timeline/TimelineWaveform.test.tsx src/renderer/timeline/Timeline.interaction.test.tsx
```

Expected: PASS. If a test fails because the new visibility gate keeps preview requests disabled in jsdom, update only the test setup or the gate fallback so browser behavior remains viewport-gated and jsdom tests stay deterministic.

- [ ] **Step 2: Confirm spec behaviors covered by tests**

Check the focused test output and existing assertions cover:

```text
- LayerBlock click/select behavior still does not seek.
- Preview overlay pointer events do not steal timeline selection.
- Clips narrower than 16 px render no preview and make no preview resource request.
- Filmstrip frame selection uses src_in_us/src_out_us.
- Waveform fallback renders when peaks are not ready.
- Video thumbnail requests wait for viewport/near-viewport visibility.
```

- [ ] **Step 3: Make minimal fixes if tests fail**

Only edit the specific file tied to a failing assertion. Do not restructure `LayerBlock`; it should continue delegating clip body rendering to `TimelineVisualPreview`.

- [ ] **Step 4: Re-run focused renderer timeline tests**

Run:

```bash
npm --workspace apps/desktop exec vitest run src/renderer/timeline/TimelineVisualPreview.test.tsx src/renderer/timeline/TimelineFilmstrip.test.ts src/renderer/timeline/TimelineWaveform.test.tsx src/renderer/timeline/Timeline.interaction.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/timeline/TimelineFilmstrip.tsx apps/desktop/src/renderer/timeline/TimelineFilmstrip.test.ts apps/desktop/src/renderer/timeline/TimelineWaveform.tsx apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx apps/desktop/src/renderer/timeline/LayerBlock.tsx apps/desktop/src/renderer/timeline/Timeline.interaction.test.tsx
git commit -m "test: cover timeline content previews"
```

If Step 3 made no changes, skip the commit and report that Task 2 was verification-only.

---

### Task 3: Verify Backend Manifest Routing and Whole Feature Type Safety

**Files:**
- Modify only if failures require it:
  - `apps/desktop/native/src/commands/media.rs`
  - `apps/desktop/native/src/napi_backend.rs`
  - `apps/desktop/src/main/state/router.ts`
  - `apps/desktop/src/main/state/router.test.ts`
  - `apps/desktop/src/main/state/single-media-forward.ts`
  - `apps/desktop/src/main/state/__tests__/single-media-forward.test.ts`
  - `apps/desktop/src/renderer/ipc/index.ts`

- [ ] **Step 1: Run focused main-process routing tests**

Run:

```bash
npm --workspace apps/desktop exec vitest run src/main/state/router.test.ts src/main/state/__tests__/single-media-forward.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused Rust thumbnail manifest tests**

Run:

```bash
cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs get_media_thumbnails
```

Expected: PASS, including:

```text
get_media_thumbnails_returns_existing_timeline_manifest
get_media_thumbnails_reports_not_ready_when_cache_absent
```

- [ ] **Step 3: Run TypeScript typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Make minimal fixes if verification fails**

Fix only the failing route, type, or serialization issue. Keep the `getMediaThumbnail(mediaId)` API unchanged and keep `getMediaThumbnails(mediaId)` compatible with future denser thumbnail caches.

- [ ] **Step 5: Re-run failed verification commands**

Re-run whichever commands from Steps 1-3 failed. Expected: PASS.

- [ ] **Step 6: Commit verification fixes**

```bash
git add apps/desktop/native/src/commands/media.rs apps/desktop/native/src/napi_backend.rs apps/desktop/src/main/state/router.ts apps/desktop/src/main/state/router.test.ts apps/desktop/src/main/state/single-media-forward.ts apps/desktop/src/main/state/__tests__/single-media-forward.test.ts apps/desktop/src/renderer/ipc/index.ts
git commit -m "feat: expose timeline thumbnail manifests"
```

If Step 4 made no changes and those files are already committed by prior work, skip the commit and report that Task 3 was verification-only.

---

## Self-Review

- Spec coverage: backend manifest API, progressive filmstrip/waveform/image/color/text/motif previews, width degradation, cache sharing, job-completion invalidation, and existing timeline interaction preservation are covered by existing code plus the tasks above.
- Marker scan: no deferred-work markers remain.
- Type consistency: renderer uses `TimelineThumbnailManifest.frames[].tUs`, matching Rust `t_us` serialized with `rename_all = "camelCase"`.
