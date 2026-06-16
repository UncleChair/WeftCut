# Timeline seek + selection UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the time ruler the sole playhead-scrub surface, decouple seeking from clip selection (so a seek never deselects a clip), and remove the redundant selection/deselection handlers.

**Architecture:** Today both the deselect (`onClick`) and the seek (`onPointerDown`) handlers sit on the same timeline-root `<div>`, and the ruler's clicks bubble into both — so every seek gesture also clears the selection, and the playhead jumps on a click anywhere in the track body. The fix moves the seek gesture onto the ruler (which swallows its own `click`), leaving the root's `onClick` as a single clean background-deselect catch-all. Layer blocks already `stopPropagation` on click, so clip selection survives. No backend/Rust changes.

**Tech Stack:** React + TypeScript, Tauri 2 / WebView2 frontend (`apps/desktop`). Tests: Vitest + `@testing-library/react` in jsdom. Spec: `docs/superpowers/specs/2026-06-16-timeline-seek-selection-ux-design.md`.

**Run all commands from `apps/desktop/`.**

---

## File Structure

- `apps/desktop/src/timeline/Timeline.tsx` — owns the root div, `seekFromClientX`, and the scrub callback. Remove root `onPointerDown`; rename the scrub handler to `beginRulerScrub(clientX)`; pass it to the ruler. Keep root `onClick` as the lone background-deselect.
- `apps/desktop/src/timeline/TimelineRuler.tsx` — gains an `onScrub` prop, a pointerdown that begins a scrub, a click-stopper so scrubbing never reaches the root deselect, a cursor affordance, and a `data-testid` for tests.
- `apps/desktop/src/timeline/LayerBlock.tsx` — strip the redundant selection from `onClick` down to a propagation-stopper (the stop is load-bearing).
- `apps/desktop/src/timeline/TrackLane.tsx` — gains a `data-testid`; loses its now-redundant lane-background `onSelect(null)` handler and the `onSelect` prop.
- `apps/desktop/src/timeline/Timeline.interaction.test.tsx` — **new** RTL test asserting the three invariants.

---

## Task 1: Add `data-testid` hooks for interaction targeting

Pure scaffolding — no behavior change. Lets the test (and any future e2e) target the ruler and lane reliably, and keeps Task 2's RED a clean *behavioral* failure rather than a missing-element error.

**Files:**
- Modify: `apps/desktop/src/timeline/TimelineRuler.tsx` (the outer container `<div>`, currently lines 117-120)
- Modify: `apps/desktop/src/timeline/TrackLane.tsx` (the lane `<div>`, currently lines 190-212)

- [ ] **Step 1: Add `data-testid` to the ruler container**

In `TimelineRuler.tsx`, find the outer container div:

```tsx
    <div
      className="relative h-5 flex-none select-none overflow-hidden border-b border-border-soft bg-card text-[10px] text-muted-foreground"
      style={{ width: widthPx }}
    >
```

Replace it with (adds `data-testid` only):

```tsx
    <div
      data-testid="timeline-ruler"
      className="relative h-5 flex-none select-none overflow-hidden border-b border-border-soft bg-card text-[10px] text-muted-foreground"
      style={{ width: widthPx }}
    >
```

- [ ] **Step 2: Add `data-testid` to the track lane**

In `TrackLane.tsx`, find the lane container div opening (the `return (` block, currently line 191):

```tsx
    <div
      className={[
        "relative border-b border-border-soft bg-background",
```

Replace with (adds `data-testid` only):

```tsx
    <div
      data-testid="track-lane"
      className={[
        "relative border-b border-border-soft bg-background",
```

- [ ] **Step 3: Verify the app still type-checks and builds**

Run: `npx tsc -b`
Expected: PASS (no errors). `data-testid` is a valid DOM attribute; this is a no-op for behavior.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/timeline/TimelineRuler.tsx apps/desktop/src/timeline/TrackLane.tsx
git commit -m "timeline: add data-testid hooks to ruler and lane

Scaffolding for the seek/selection interaction tests (and future e2e).
No behavior change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Ruler-only seek + decoupled selection (TDD core)

Write the failing interaction test, watch it fail behaviorally, then move the seek gesture onto the ruler and remove the root's seek handler.

**Files:**
- Create: `apps/desktop/src/timeline/Timeline.interaction.test.tsx`
- Modify: `apps/desktop/src/timeline/Timeline.tsx` (handler at 517-531; root div at 538-545; ruler usage at 572-578)
- Modify: `apps/desktop/src/timeline/TimelineRuler.tsx` (props 32-44; container div from Task 1)

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/timeline/Timeline.interaction.test.tsx` with this exact content:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import "../i18n"; // initialize i18next so t(key) resolves in chrome
import type { LayerSummary, TrackSummary } from "../ipc";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { Timeline } from "./Timeline";

// jsdom 25 does not implement PointerEvent; alias it to MouseEvent so
// fireEvent.pointerDown carries a usable .button / .clientX (same shim the
// KeyframeCurveGraph test uses).
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

// useTimelineView loads/saves view.json over Tauri IPC on mount. There is no
// Tauri runtime under jsdom, so stub just those two calls; keep every other
// ipc export real (types, helpers).
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    viewStateGet: vi
      .fn()
      .mockResolvedValue({ timeline_px_per_sec: 50, track_heights: {}, expanded_tracks: [] }),
    viewStateSet: vi.fn().mockResolvedValue(undefined),
  };
});

const layer: LayerSummary = {
  id: "layer-1",
  label: "Clip A",
  t_start_us: 0,
  t_end_us: 2_000_000,
  kind: "Subtitles",
  color_hint: "#4488cc",
  enabled: true,
  locked: false,
  params: { kind: "Subtitles", source_kind: "InlineSrt", source_value: "" },
};

const track: TrackSummary = {
  id: "track-1",
  kind: "Subtitle",
  label: "S1",
  enabled: true,
  locked: false,
  muted: false,
  solo: false,
  role: "a-roll",
  transient: false,
  layers: [layer],
};

function renderTimeline(overrides: {
  selectedLayerId?: string | null;
  onSeek?: () => void;
  onSelect?: (id: string | null) => void;
}) {
  const onSeek = overrides.onSeek ?? vi.fn();
  const onSelect = overrides.onSelect ?? vi.fn();
  return render(
    <Timeline
      tracks={[track]}
      groups={[]}
      durationUs={5_000_000}
      currentTimeUs={0}
      selectedLayerId={overrides.selectedLayerId ?? null}
      keybindings={{}}
      fpsNum={30}
      fpsDen={1}
      bladeMode={false}
      media={[]}
      importing={new Set()}
      proxyState={new Map()}
      previewDecodable={new Set()}
      onExitBlade={vi.fn()}
      onSelect={onSelect}
      onSeek={onSeek}
      onMutated={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("Timeline seek/selection coupling", () => {
  beforeEach(() => {
    // Show-All so the role-stamped track always renders regardless of the
    // default AB-roll filter.
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "ShowAll" },
    }));
  });
  afterEach(cleanup);

  it("clicking the ruler seeks AND keeps the selected clip selected", () => {
    const onSeek = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek, onSelect });
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;
    fireEvent.pointerDown(ruler, { button: 0, clientX: 200 });
    fireEvent.pointerUp(window, { clientX: 200 });
    fireEvent.click(ruler);
    expect(onSeek).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalledWith(null);
  });

  it("clicking empty lane background deselects and does NOT seek", () => {
    const onSeek = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek, onSelect });
    const lane = container.querySelector('[data-testid="track-lane"]')!;
    fireEvent.pointerDown(lane, { button: 0, clientX: 200 });
    fireEvent.pointerUp(window, { clientX: 200 });
    fireEvent.click(lane);
    expect(onSeek).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("clicking a clip selects it without seeking", () => {
    const onSeek = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: null, onSeek, onSelect });
    const block = container.querySelector(".timeline-layer")!;
    fireEvent.pointerDown(block, { button: 0, clientX: 50 });
    fireEvent.pointerUp(window, { clientX: 50 });
    fireEvent.click(block);
    expect(onSelect).toHaveBeenCalledWith(layer.id);
    expect(onSeek).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalledWith(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (RED)**

Run: `npx vitest run src/timeline/Timeline.interaction.test.tsx`
Expected: FAIL. With the current (unfixed) code the root `<div>` seeks on every pointerdown and deselects on every click, so:
- "clicking the ruler … keeps the selected clip selected" FAILS — `onSelect` *was* called with `null` (the ruler click bubbles to the root deselect).
- "clicking empty lane background … does NOT seek" FAILS — `onSeek` *was* called (the lane pointerdown bubbles to the root seek).
- "clicking a clip …" PASSES (the layer block already stops propagation).

- [ ] **Step 3: Convert the root seek handler to a ruler-scrub callback**

In `Timeline.tsx`, find `onCanvasPointerDown` (currently lines 513-531):

```tsx
  // Click/drag on empty canvas (lane background, gap below tracks) to seek.
  // Layer / trim-handle / resize-handle pointerdown stops propagation, so
  // this never fires when interacting with an existing control. In blade
  // mode the user is hunting for a layer to cut, not asking to scrub.
  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (bladeMode) return;
      seekFromClientX(e.clientX);
      const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [seekFromClientX, bladeMode],
  );
```

Replace it with:

```tsx
  // Ruler-only seek: the time ruler is the SOLE surface that moves the
  // playhead. Begins a drag-scrub from the ruler's pointerdown. Decoupled
  // from selection — seeking never clears the selected clip. See
  // docs/superpowers/specs/2026-06-16-timeline-seek-selection-ux-design.md.
  const beginRulerScrub = useCallback(
    (clientX: number) => {
      seekFromClientX(clientX);
      const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [seekFromClientX],
  );
```

(The `bladeMode` guard is intentionally dropped — the ruler scrubs even in blade mode, per the approved design. `bladeMode` is still used elsewhere in this component, so no unused-variable warning.)

- [ ] **Step 4: Remove the seek handler from the root div, keep the deselect**

In `Timeline.tsx`, find the root div (currently lines 538-545):

```tsx
    <div
      ref={rootRef}
      className={`relative min-h-0 w-full flex-1 overflow-auto bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
        drag ? "cursor-grabbing select-none" : ""
      } ${heightDrag ? "cursor-ns-resize select-none" : ""} ${bladeMode ? "timeline-root-blade" : ""}`}
      onClick={() => onSelect(null)}
      onPointerDown={onCanvasPointerDown}
    >
```

Replace with (drop the `onPointerDown` line; `onClick` is now the lone background-deselect):

```tsx
    <div
      ref={rootRef}
      className={`relative min-h-0 w-full flex-1 overflow-auto bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
        drag ? "cursor-grabbing select-none" : ""
      } ${heightDrag ? "cursor-ns-resize select-none" : ""} ${bladeMode ? "timeline-root-blade" : ""}`}
      onClick={() => onSelect(null)}
    >
```

- [ ] **Step 5: Pass the scrub callback to the ruler**

In `Timeline.tsx`, find the `<TimelineRuler …/>` usage (currently lines 572-578):

```tsx
          <TimelineRuler
            pxPerSec={pxPerSec}
            totalSec={totalSec}
            widthPx={Math.max(widthPx, 200)}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
          />
```

Replace with:

```tsx
          <TimelineRuler
            pxPerSec={pxPerSec}
            totalSec={totalSec}
            widthPx={Math.max(widthPx, 200)}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
            onScrub={beginRulerScrub}
          />
```

- [ ] **Step 6: Make the ruler interactive**

In `TimelineRuler.tsx`, find the props destructure + type (currently lines 32-44):

```tsx
export function TimelineRuler({
  pxPerSec,
  totalSec,
  widthPx,
  fpsNum,
  fpsDen,
}: {
  pxPerSec: number;
  totalSec: number;
  widthPx: number;
  fpsNum: number;
  fpsDen: number;
}) {
```

Replace with (add the `onScrub` prop):

```tsx
export function TimelineRuler({
  pxPerSec,
  totalSec,
  widthPx,
  fpsNum,
  fpsDen,
  onScrub,
}: {
  pxPerSec: number;
  totalSec: number;
  widthPx: number;
  fpsNum: number;
  fpsDen: number;
  /// Begin a playhead scrub at the given client X. The ruler is the sole
  /// scrub surface (ruler-only seek); Timeline.tsx installs the drag-scrub
  /// loop via this callback.
  onScrub: (clientX: number) => void;
}) {
```

Then find the container div (it now carries `data-testid="timeline-ruler"` from Task 1):

```tsx
    <div
      data-testid="timeline-ruler"
      className="relative h-5 flex-none select-none overflow-hidden border-b border-border-soft bg-card text-[10px] text-muted-foreground"
      style={{ width: widthPx }}
    >
```

Replace with (add cursor affordance + pointerdown scrub + click-stopper):

```tsx
    <div
      data-testid="timeline-ruler"
      className="relative h-5 flex-none cursor-ew-resize select-none overflow-hidden border-b border-border-soft bg-card text-[10px] text-muted-foreground"
      style={{ width: widthPx }}
      onPointerDown={(e) => {
        if (e.button === 0) onScrub(e.clientX);
      }}
      onClick={(e) => e.stopPropagation()}
    >
```

(The `onClick` stopper is what keeps a scrub gesture's trailing `click` from bubbling to the root's `onSelect(null)`. The tick children are already `pointer-events-none`, so the container always receives the pointer.)

- [ ] **Step 7: Run the test to verify it passes (GREEN)**

Run: `npx vitest run src/timeline/Timeline.interaction.test.tsx`
Expected: PASS (3/3). Ruler click now seeks via `onScrub` and stops its own click; lane pointerdown no longer reaches a seek handler; clip click is unchanged.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/timeline/Timeline.tsx apps/desktop/src/timeline/TimelineRuler.tsx apps/desktop/src/timeline/Timeline.interaction.test.tsx
git commit -m "timeline: ruler-only seek, decouple seek from selection

Move the playhead-scrub gesture onto the time ruler and remove it from the
timeline-root div. The root's onClick stays as the lone background-deselect;
the ruler stops its own click so scrubbing no longer clears clip selection.
Fixes: seeking deselected the current clip; playhead jumped on any
track-body click. RTL test covers the three invariants.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Remove the redundant selection/deselection handlers

The layer-block `onClick` re-selects after pointerdown already did, and the lane has its own deselect that the root catch-all now covers. Both are dead weight; removing them keeps a single, clear path for each action. The interaction test must stay green throughout.

**Files:**
- Modify: `apps/desktop/src/timeline/LayerBlock.tsx` (`onClick`, currently lines 423-435)
- Modify: `apps/desktop/src/timeline/TrackLane.tsx` (interface `onSelect` ~line 67; destructure ~line 37; lane `onClick` ~lines 206-208)
- Modify: `apps/desktop/src/timeline/Timeline.tsx` (the `<TrackLane … onSelect={onSelect} …/>` prop, currently line 608)

- [ ] **Step 1: Reduce the layer-block `onClick` to a propagation-stopper**

In `LayerBlock.tsx`, find the `onClick` (currently lines 423-435):

```tsx
      onClick={(e) => {
        e.stopPropagation();
        // In blade mode the pointerdown already handled the cut; the
        // synthesised click that follows should not flip the selection.
        if (bladeMode) return;
        // Spec §3: locked layers are unselectable (per-layer or track lock).
        if (layer.locked || trackLocked) return;
        onSelectFromClick(layer.id, {
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
        });
      }}
```

Replace with:

```tsx
      onClick={(e) => {
        // Selection happens on pointerdown (onLayerPointerDown, which also
        // arms the drag). This handler exists only to stop the click from
        // bubbling to the timeline-root background-deselect — without it,
        // selecting a clip would immediately clear the selection. Ruler-only
        // seek decoupling: see
        // docs/superpowers/specs/2026-06-16-timeline-seek-selection-ux-design.md.
        e.stopPropagation();
      }}
```

(The old blade/locked guards only gated the now-removed `onSelectFromClick` call. Locked layers never reach a select via pointerdown either, so behavior is unchanged: clicking a locked layer is a no-op, and the unconditional `stopPropagation` matches the old code.)

- [ ] **Step 2: Remove the redundant lane deselect (handler + prop)**

In `TrackLane.tsx`, find the lane `onClick` (currently lines 206-208):

```tsx
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
```

Delete that entire `onClick={…}` attribute from the lane div. (The timeline-root `onClick` now deselects on any background click that bubbles up — lane backgrounds included — so this is redundant.)

Then remove the now-unused `onSelect` prop. In the props **interface** (currently ~line 67):

```tsx
  onSelect: (id: string | null) => void;
```

Delete that line. In the **destructure** at the top of the component (currently ~line 37, between `bladeMode`/`onBladeSplit` and `onSelectFromClick`):

```tsx
  onSelect,
```

Delete that line.

- [ ] **Step 3: Drop the `onSelect` prop from the `<TrackLane>` call site**

In `Timeline.tsx`, find the `<TrackLane>` usage and remove the `onSelect={onSelect}` line (currently line 608, between `onBladeSplit={splitFromClientX}` and `onSelectFromClick={selectFromClick}`):

```tsx
                onSelect={onSelect}
```

Delete that single line. (`onSelectFromClick={selectFromClick}` stays — that's how layer clicks select. The Timeline's own `onSelect` prop is still used by the root `onClick`.)

- [ ] **Step 4: Run the interaction test — must stay GREEN**

Run: `npx vitest run src/timeline/Timeline.interaction.test.tsx`
Expected: PASS (3/3). Deselect now flows solely through the root `onClick`; selection still happens on layer pointerdown.

- [ ] **Step 5: Type-check and run the full unit suite**

Run: `npx tsc -b`
Expected: PASS — no unused-variable errors from the removed `onSelect` prop/handler.

Run: `npm test`
Expected: PASS — the whole Vitest suite is green (the new test included, nothing else regressed).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/timeline/LayerBlock.tsx apps/desktop/src/timeline/TrackLane.tsx apps/desktop/src/timeline/Timeline.tsx
git commit -m "timeline: remove redundant select/deselect handlers

Layer-block onClick no longer re-selects (pointerdown already did); it only
stops propagation so a clip click can't bubble to the root deselect. Drop
the lane's own onSelect(null) handler and its now-unused onSelect prop — the
timeline-root onClick is the single background-deselect path.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Ruler-only seek (spec Change 1) → Task 2 Steps 3-6.
- Decouple deselect, keep root `onClick` (spec Change 2) → Task 2 Step 4.
- Remove redundant layer selection (spec Change 3) → Task 3 Step 1.
- Remove duplicate lane deselect (spec Change 4) → Task 3 Steps 2-3.
- Ruler scrubs in blade mode (spec minor choice) → Task 2 Step 3 (blade guard dropped).
- Playhead knob stays non-draggable (spec minor choice) → no task, intentionally untouched.
- Tests for the three invariants (spec Testing) → Task 2 Step 1.
- Marquee select / draggable knob / keyboard transport → spec "Out of scope"; correctly no tasks.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows full before/after; every command shows expected output.

**Type consistency:** `beginRulerScrub(clientX: number)` defined in Task 2 Step 3 matches the `onScrub: (clientX: number) => void` prop added in Step 6 and the `onScrub={beginRulerScrub}` wiring in Step 5. `TrackLane` `onSelect` is removed from the interface, the destructure, and the call site together (Task 3 Steps 2-3), so no dangling reference remains. The test's `Timeline` props match `TimelineProps` in `Timeline.tsx`; fixture `LayerSummary`/`TrackSummary` shapes match `apps/desktop/src/ipc/index.ts`.

**Notes for the implementer:**
- Line numbers are "currently …" anchors from the pre-change files; match on the shown code, not the numbers.
- jsdom has no `PointerEvent`; the test's top-of-file shim (aliasing it to `MouseEvent`) is required — do not remove it.
- An optional real-WebView2 wdio e2e for pointer-true scrub is out of scope here; the RTL test covers the handler decoupling that regressed.
