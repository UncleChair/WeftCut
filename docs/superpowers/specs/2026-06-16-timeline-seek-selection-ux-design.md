# Timeline seek + selection UX — design

## Problem

The timeline's click behavior diverges from standard NLE conventions in two
user-reported ways:

1. **The playhead jumps on a click anywhere in the track body**, not just a
   dedicated scrub zone.
2. **Clip focus/blur (selection) behaves oddly** — most concretely, moving the
   playhead clears the current clip selection.

### Root cause

Both the deselect and the seek gestures live on the **same root `<div>`** in
`Timeline.tsx`:

```
onClick={() => onSelect(null)}        // Timeline.tsx — deselect
onPointerDown={onCanvasPointerDown}   // Timeline.tsx — seek + drag-scrub
```

`onCanvasPointerDown` seeks immediately on pointerdown anywhere that does not
`stopPropagation` (empty lanes, gaps, below-tracks area, **and the ruler**,
whose clicks bubble up to it). Because seek and deselect share this surface:

- Every seek gesture — including clicking the ruler to move the playhead — fires
  the root `onClick` afterward and **deselects the current clip**. This is the
  "strange blur." In Premiere / Resolve / FCP, moving the playhead never touches
  clip selection.
- The playhead seeks across the whole track body, not a confined scrub zone.

Secondary issues found in the same audit:

- **Redundant double-selection:** a layer click runs `onSelectFromClick` twice —
  once on `pointerdown` (needed to arm the drag) and again on the `click` event.
- **Two overlapping deselect paths:** the root `onClick` deselects on any bubbled
  click, and `TrackLane` *also* deselects on bare-lane clicks.

## Decisions

- **Seek model: ruler only.** Only the time-ruler strip moves the playhead.
  Track-body clicks select/deselect; they never scrub. (Premiere/Resolve/FCP
  convention.)
- **Marquee (rubber-band) multi-select: out of scope** for this round; tracked as
  a follow-up. Freeing the empty-lane drag gesture (it no longer scrubs) is what
  makes marquee select possible later.

## Design

**Principle:** the time ruler is the sole scrub surface; a seek never changes
clip selection.

**Key insight:** move seek onto the ruler and have the ruler swallow its own
`click`, and the root's existing `onClick` becomes a clean background-deselect
catch-all. This is minimal and naturally covers the empty area *below* the last
track that per-element handlers would miss.

### Change 1 — Move seek to the ruler (`Timeline.tsx`, `TimelineRuler.tsx`)

- Remove `onPointerDown={onCanvasPointerDown}` from the root `<div>`.
- Rename `onCanvasPointerDown` → `beginRulerScrub(clientX: number)`; body is
  unchanged (`seekFromClientX(clientX)` + install the `window` pointermove/up
  drag-scrub loop). The px→time math and `canvasRef` stay in `Timeline.tsx` so the
  ruler stays presentational.
- Pass it down: `<TimelineRuler onScrub={beginRulerScrub} … />`.
- `TimelineRuler` container gains:
  - `onPointerDown={(e) => { if (e.button === 0) onScrub(e.clientX); }}`
  - `onClick={(e) => e.stopPropagation()}` — so a scrub gesture's trailing
    `click` never bubbles to the root deselect.
  - a `cursor: ew-resize` affordance so users discover the strip scrubs.
- The ruler's tick `<div>`s remain `pointer-events-none`; only the container
  handles the pointer.

### Change 2 — Decouple deselect (`Timeline.tsx`)

- **Keep** the root `onClick={() => onSelect(null)}`. It is now purely a
  background-deselect catch-all: seek no longer lives on the root, and both the
  ruler (Change 1) and layer blocks (already) stop `click` propagation.
- Net behavior:
  - Ruler click/drag → seek; **selection survives**.
  - Empty-lane / below-tracks click → deselect; **no seek**.
  - Clip click → select; **no seek**.

### Change 3 — Remove redundant layer selection (`LayerBlock.tsx`)

- The layer `onClick` currently re-runs `onSelectFromClick` after `pointerdown`
  already selected. Strip `onClick` down to just `e.stopPropagation()` — which is
  load-bearing (it keeps a clip click from bubbling to the root deselect).
- Nothing is lost: the locked-layer and blade-mode guards already live on
  `onLayerPointerDown`, so selection on pointerdown already short-circuits in
  exactly the same cases.

### Change 4 — Remove the duplicate lane deselect (`TrackLane.tsx`)

- The lane's own `onClick` (`if (e.target === e.currentTarget) onSelect(null)`)
  is now redundant with the root catch-all (bare-lane clicks bubble up). Remove
  it. Resolves the two-overlapping-deselect-paths issue.

### Minor behavior choices (approved)

- **Ruler scrubs even in blade mode.** Today blade mode disables all canvas
  seeking. With seek on the ruler, the ruler keeps scrubbing in blade mode; blade
  only governs clip clicks.
- **Playhead knob stays non-draggable** this round. Drag-the-knob-to-scrub is a
  follow-up.

## Testing

No existing unit/e2e asserts the canvas/ruler click-seek or background-deselect
DOM behavior. (The keyframe-diamond click-seek e2e is independent — it routes
through `transportSeek`, not the canvas — and `layers.e2e.js` is render-only.)
Collision risk is low; new coverage is additive.

New `src/timeline/Timeline.interaction.test.tsx` (RTL/vitest) asserting three
invariants:

1. **Ruler click seeks AND keeps the selected clip selected** — start with a clip
   selected, fire pointerdown on the ruler, assert `onSeek` fired and the clip's
   selected chrome persists (`onSelect(null)` was not called).
2. **Empty-lane click deselects and does NOT seek** — fire a click on bare lane
   background; assert `onSelect(null)` fired and `onSeek` did not.
3. **Clip click selects without seeking** — fire pointerdown/click on a layer;
   assert `onSelectFromClick`/`onSelect` fired and `onSeek` did not.

The drag-scrub loop's `window` pointermove/up listeners work under jsdom. A small
wdio e2e for real-pointer scrub is optional; the RTL test covers the handler
decoupling that actually regressed.

## Files

- `apps/desktop/src/timeline/Timeline.tsx` — remove root `onPointerDown`; rename
  handler to `beginRulerScrub`; pass to ruler; keep root `onClick` deselect.
- `apps/desktop/src/timeline/TimelineRuler.tsx` — `onScrub` prop; pointerdown +
  click-stop + cursor affordance.
- `apps/desktop/src/timeline/LayerBlock.tsx` — strip redundant selection from
  `onClick`, keep `stopPropagation`.
- `apps/desktop/src/timeline/TrackLane.tsx` — remove redundant lane `onClick`
  deselect.
- `apps/desktop/src/timeline/Timeline.interaction.test.tsx` — new RTL test.

No backend/Rust changes.

## Out of scope (follow-ups)

- Marquee / rubber-band multi-select by dragging in empty track space.
- Draggable playhead knob.
- Keyboard transport niceties (Home/End, arrow-key frame stepping) — unrelated.
