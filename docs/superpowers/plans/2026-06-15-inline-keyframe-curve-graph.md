# Inline Keyframe Curve Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the detached cubic-bezier popup with an on-timeline value-curve graph — each animated property drawn as its value over time on its keyframe sub-lane, with AE-style tangent handles editable in place.

**Architecture:** A new pure geometry module (`keyframe/curveGraph.ts`) maps the stored per-segment `Bezier{p1,p2}` (Model B, unchanged) into (time, value) pixel space and back. A new React component (`timeline/KeyframeCurveGraph.tsx`) renders the curve + keyframe dots + tangent handles and wires pointer editing. The expanded keyframe sub-lanes (`KeyframeLane`) host it: 24px read-only thumbnail by default, ~72px editable when the property is focused (reusing `focusStore`). Presets/Smooth move to a small `EasingMenu` popover; the abstract `EasingEditor`/`EasingCanvas`/`MotionPreview` are deleted. No data-model, engine, IPC, or export change.

**Tech Stack:** TypeScript, React 18, Zustand (`focusStore`/`selectionStore`), Base UI popover, SVG, Vitest + @testing-library/react (jsdom), WebdriverIO e2e (real WebView2).

**Conventions:** All `npx`/`npm` commands run from `apps/desktop/`. Typecheck = `npx tsc -b`. Unit test a file = `npx vitest run <path>`. Spec: `docs/superpowers/specs/2026-06-15-inline-keyframe-curve-graph-design.md`.

---

## File Structure

**Create:**
- `apps/desktop/src/keyframe/curveGraph.ts` — pure value↔pixel geometry (range, mappings, polylines, handle positions, drag→coeff). DOM-free, unit-tested.
- `apps/desktop/src/keyframe/curveGraph.test.ts` — its unit tests.
- `apps/desktop/src/timeline/KeyframeCurveGraph.tsx` — the SVG curve + dots + handles renderer and pointer wiring.
- `apps/desktop/src/timeline/KeyframeCurveGraph.test.tsx` — render/interaction smoke (RTL).
- `apps/desktop/src/timeline/EasingMenu.tsx` — small preset/Smooth popover (replaces `EasingEditor`).
- `apps/desktop/src/timeline/EasingMenu.test.tsx` — preset/Smooth wiring smoke (RTL).

**Modify:**
- `apps/desktop/src/keyframe/focusStore.ts` — add `useFocusedParamKeyForTrackLayers`.
- `apps/desktop/src/timeline/KeyframeLane.tsx` — focus-driven row height; render `KeyframeCurveGraph` instead of bare diamonds; open `EasingMenu` on right-click; export `KF_SUBLANE_EXPANDED_H`.
- `apps/desktop/src/timeline/LayerBlock.tsx` — swap in-clip right-click target from `EasingEditor` to `EasingMenu` (diamonds stay; no curve).
- `apps/desktop/src/i18n/locales/en-US.ts`, `apps/desktop/src/i18n/locales/zh-CN.ts` — remove the now-unused `keyframe.easing_title` key.
- `docs/render.md` (or the timeline doc section on keyframe authoring) — describe the on-lane value-curve editor; note popup retirement.

**Delete (Task 7, once unreferenced):**
- `apps/desktop/src/timeline/EasingEditor.tsx`
- `apps/desktop/src/timeline/EasingCanvas.tsx`
- `apps/desktop/src/timeline/MotionPreview.tsx`

---

## Task 1: curveGraph.ts — value range + value/time mappings

**Files:**
- Create: `apps/desktop/src/keyframe/curveGraph.ts`
- Test: `apps/desktop/src/keyframe/curveGraph.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/keyframe/curveGraph.test.ts
import { describe, expect, it } from "vitest";
import {
  computeValueRange, valueToY, yToValue, timeToXPx, xPxToTimeUs,
  type CurveGeom,
} from "./curveGraph";

const G: CurveGeom = { pxPerSec: 100, layerTStartUs: 0, height: 80, vmin: 0, vmax: 1 };

describe("value/time mappings", () => {
  it("timeToXPx maps absolute time at pxPerSec, layer-local offset added", () => {
    expect(timeToXPx(0, G)).toBe(0);
    expect(timeToXPx(1_000_000, G)).toBe(100); // 1s @100px/s
    expect(timeToXPx(0, { ...G, layerTStartUs: 2_000_000 })).toBe(200);
  });
  it("xPxToTimeUs inverts timeToXPx", () => {
    expect(xPxToTimeUs(100, G)).toBeCloseTo(1_000_000, 3);
    expect(xPxToTimeUs(0, { ...G, layerTStartUs: 2_000_000 })).toBeCloseTo(-2_000_000, 3);
  });
  it("valueToY is y-down (vmax at top=0, vmin at bottom=height) and round-trips", () => {
    expect(valueToY(1, G)).toBeCloseTo(0, 6);
    expect(valueToY(0, G)).toBeCloseTo(80, 6);
    expect(yToValue(valueToY(0.3, G), G)).toBeCloseTo(0.3, 6);
  });
  it("degenerate zero span returns mid-lane / vmin without NaN", () => {
    const flat = { ...G, vmin: 5, vmax: 5 };
    expect(valueToY(5, flat)).toBe(40);
    expect(yToValue(40, flat)).toBe(5);
  });
});

describe("computeValueRange", () => {
  it("pads min/max of keyframe values", () => {
    const r = computeValueRange([
      { t_us: 0, value: 0, interp: { kind: "Linear" } },
      { t_us: 1_000_000, value: 10, interp: { kind: "Linear" } },
    ]);
    expect(r.vmin).toBeCloseTo(-1, 6); // 0 - 10*0.1
    expect(r.vmax).toBeCloseTo(11, 6); // 10 + 10*0.1
  });
  it("includes overshoot from a curved segment (y>1)", () => {
    // p2 y = 1.5 overshoots past the end value → range must exceed [0,1]
    const r = computeValueRange([
      { t_us: 0, value: 0, interp: { kind: "Bezier", p1: [0.3, 0], p2: [0.7, 1.5] } },
      { t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
    ], 0);
    expect(r.vmax).toBeGreaterThan(1);
  });
  it("all-equal values yield a nominal band, not a zero span", () => {
    const r = computeValueRange([
      { t_us: 0, value: 3, interp: { kind: "Linear" } },
      { t_us: 1_000_000, value: 3, interp: { kind: "Linear" } },
    ]);
    expect(r.vmax).toBeGreaterThan(r.vmin);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframe/curveGraph.test.ts`
Expected: FAIL — `Cannot find module './curveGraph'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/keyframe/curveGraph.ts
// Pure value-graph geometry for the inline keyframe curve editor. Maps the
// stored per-segment cubic-bezier easing (Model B Bezier{p1,p2}) into the
// (time, value) pixel space of a timeline sub-lane, and back, for rendering
// and in-place tangent-handle editing. DOM-free — all geometry is explicit
// args so it unit-tests headless. UI-only (no Rust mirror).
import type { Interpolation, Keyframe } from "../ipc";
import { unitBezier } from "../render/animated";
import { interpToCoeffs } from "./curve";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface CurveGeom {
  /// zoom: timeline pixels per second.
  pxPerSec: number;
  /// layer start on the ruler (µs); keyframe t_us is layer-local.
  layerTStartUs: number;
  /// drawable lane height (px); curve fills [0, height], y-down.
  height: number;
  /// value-axis range mapped onto [0, height].
  vmin: number;
  vmax: number;
}

export interface Pt { x: number; y: number; }

/// Absolute ruler x (px) of a layer-local time. Same formula as
/// geometry.ts::keyframeAbsoluteX (inlined to keep this module DOM-free).
export function timeToXPx(tUsLocal: number, g: CurveGeom): number {
  return ((g.layerTStartUs + tUsLocal) / 1_000_000) * g.pxPerSec;
}

/// Inverse of timeToXPx → layer-local µs.
export function xPxToTimeUs(px: number, g: CurveGeom): number {
  return (px / g.pxPerSec) * 1_000_000 - g.layerTStartUs;
}

/// value → y px (higher value → smaller y).
export function valueToY(v: number, g: CurveGeom): number {
  const span = g.vmax - g.vmin;
  if (span <= 0) return g.height / 2;
  return ((g.vmax - v) / span) * g.height;
}

/// y px → value.
export function yToValue(py: number, g: CurveGeom): number {
  const span = g.vmax - g.vmin;
  if (span <= 0) return g.vmin;
  return g.vmax - (py / g.height) * span;
}

/// Min/max of the *rendered* value curve across all segments (samples eased
/// values so overshoot y∉[0,1] is included), padded so extremes aren't flush
/// to the lane edge. Degenerate all-equal → a nominal ± band.
export function computeValueRange(
  keys: Pick<Keyframe<number>, "t_us" | "value" | "interp">[],
  padFrac = 0.1,
  samplesPerSeg = 16,
): { vmin: number; vmax: number } {
  if (keys.length === 0) return { vmin: 0, vmax: 1 };
  let lo = Infinity;
  let hi = -Infinity;
  const note = (v: number) => {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  for (let i = 0; i < keys.length; i++) {
    note(keys[i]!.value);
    if (i < keys.length - 1) {
      const a = keys[i]!;
      const b = keys[i + 1]!;
      const dv = b.value - a.value;
      const curved = a.interp.kind !== "Hold" && a.interp.kind !== "Linear";
      if (curved && dv !== 0) {
        const [x1, y1, x2, y2] = interpToCoeffs(a.interp);
        for (let s = 1; s < samplesPerSeg; s++) {
          note(a.value + unitBezier(x1, y1, x2, y2, s / samplesPerSeg) * dv);
        }
      }
    }
  }
  if (!isFinite(lo) || !isFinite(hi)) return { vmin: 0, vmax: 1 };
  if (hi === lo) {
    const half = Math.max(1, Math.abs(hi) * 0.1);
    return { vmin: lo - half, vmax: hi + half };
  }
  const pad = (hi - lo) * padFrac;
  return { vmin: lo - pad, vmax: hi + pad };
}

// (clamp01 used by Task 2/3 additions)
void clamp01;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframe/curveGraph.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/keyframe/curveGraph.ts apps/desktop/src/keyframe/curveGraph.test.ts
git commit -m "feat(keyframe): value-graph value/time pixel mappings + range"
```

---

## Task 2: curveGraph.ts — segment polyline + tangent-handle positions

**Files:**
- Modify: `apps/desktop/src/keyframe/curveGraph.ts`
- Test: `apps/desktop/src/keyframe/curveGraph.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `curveGraph.test.ts`:

```ts
import { segmentPolyline, segmentHandles, type Seg } from "./curveGraph";

const SEG: Seg = { aTUs: 0, aVal: 0, bTUs: 1_000_000, bVal: 1 }; // 0→1 over 1s
const G2: CurveGeom = { pxPerSec: 100, layerTStartUs: 0, height: 100, vmin: 0, vmax: 1 };

describe("segmentPolyline", () => {
  it("Linear → two points corner to corner", () => {
    expect(segmentPolyline(SEG, { kind: "Linear" }, G2)).toEqual([
      { x: 0, y: 100 }, // t0 v0 → bottom-left
      { x: 100, y: 0 }, // t1 v1 → top-right
    ]);
  });
  it("Hold → flat then vertical step", () => {
    expect(segmentPolyline(SEG, { kind: "Hold" }, G2)).toEqual([
      { x: 0, y: 100 },   // start
      { x: 100, y: 100 }, // flat at start value
      { x: 100, y: 0 },   // step up at next key
    ]);
  });
  it("Bezier → sampled, endpoints anchored at the keyframes", () => {
    const pts = segmentPolyline(SEG, { kind: "Bezier", p1: [0.42, 0], p2: [0.58, 1] }, G2, 10);
    expect(pts.length).toBe(11);
    expect(pts[0]).toEqual({ x: 0, y: 100 });
    expect(pts[10]).toEqual({ x: 100, y: 0 });
    // midpoint x is the time midpoint; y is between the endpoints
    expect(pts[5]!.x).toBeCloseTo(50, 6);
    expect(pts[5]!.y).toBeGreaterThan(0);
    expect(pts[5]!.y).toBeLessThan(100);
  });
});

describe("segmentHandles", () => {
  it("returns null for Hold and Linear (no editable handles)", () => {
    expect(segmentHandles(SEG, { kind: "Hold" }, G2)).toBeNull();
    expect(segmentHandles(SEG, { kind: "Linear" }, G2)).toBeNull();
  });
  it("places p1/p2 control points in time/value px space", () => {
    const h = segmentHandles(SEG, { kind: "Bezier", p1: [0.25, 0.1], p2: [0.75, 0.9] }, G2)!;
    expect(h.p1.x).toBeCloseTo(25, 6);  // 0.25 of 100px width
    expect(h.p1.y).toBeCloseTo(90, 6);  // value 0.1 → y = (1-0.1)*100
    expect(h.p2.x).toBeCloseTo(75, 6);
    expect(h.p2.y).toBeCloseTo(10, 6);  // value 0.9 → y = (1-0.9)*100
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframe/curveGraph.test.ts`
Expected: FAIL — `segmentPolyline`/`segmentHandles`/`Seg` not exported.

- [ ] **Step 3: Add the implementation**

Append to `curveGraph.ts` (above the `void clamp01;` line, then delete that line):

```ts
export interface Seg {
  aTUs: number;
  aVal: number;
  bTUs: number;
  bVal: number;
}

/// Pixel polyline for one segment's value curve. Hold → flat then vertical
/// step; Linear → straight; curved → sampled through unitBezier.
export function segmentPolyline(
  seg: Seg,
  interp: Interpolation,
  g: CurveGeom,
  samples = 24,
): Pt[] {
  const xa = timeToXPx(seg.aTUs, g);
  const xb = timeToXPx(seg.bTUs, g);
  const ya = valueToY(seg.aVal, g);
  const yb = valueToY(seg.bVal, g);
  if (interp.kind === "Hold") return [{ x: xa, y: ya }, { x: xb, y: ya }, { x: xb, y: yb }];
  if (interp.kind === "Linear") return [{ x: xa, y: ya }, { x: xb, y: yb }];
  const [x1, y1, x2, y2] = interpToCoeffs(interp);
  const dv = seg.bVal - seg.aVal;
  const out: Pt[] = [];
  for (let s = 0; s <= samples; s++) {
    const u = s / samples;
    const v = seg.aVal + unitBezier(x1, y1, x2, y2, u) * dv;
    out.push({ x: xa + (xb - xa) * u, y: valueToY(v, g) });
  }
  return out;
}

/// Tangent-handle control points (px) for a segment, or null for Hold/Linear
/// (no editable handles — pick a curved preset to start easing).
export function segmentHandles(
  seg: Seg,
  interp: Interpolation,
  g: CurveGeom,
): { p1: Pt; p2: Pt } | null {
  if (interp.kind === "Hold" || interp.kind === "Linear") return null;
  const [x1, y1, x2, y2] = interpToCoeffs(interp);
  const xa = timeToXPx(seg.aTUs, g);
  const xb = timeToXPx(seg.bTUs, g);
  const dv = seg.bVal - seg.aVal;
  return {
    p1: { x: xa + (xb - xa) * x1, y: valueToY(seg.aVal + y1 * dv, g) },
    p2: { x: xa + (xb - xa) * x2, y: valueToY(seg.aVal + y2 * dv, g) },
  };
}
```

(Remove the temporary `void clamp01;` line — `clamp01` is used by Task 3.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframe/curveGraph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/keyframe/curveGraph.ts apps/desktop/src/keyframe/curveGraph.test.ts
git commit -m "feat(keyframe): segment polyline + tangent-handle positions"
```

---

## Task 3: curveGraph.ts — handle drag → coefficients

**Files:**
- Modify: `apps/desktop/src/keyframe/curveGraph.ts`
- Test: `apps/desktop/src/keyframe/curveGraph.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `curveGraph.test.ts`:

```ts
import { handleDragToCoeff } from "./curveGraph";

describe("handleDragToCoeff", () => {
  const seg: Seg = { aTUs: 0, aVal: 0, bTUs: 1_000_000, bVal: 1 };
  const g: CurveGeom = { pxPerSec: 100, layerTStartUs: 0, height: 100, vmin: 0, vmax: 1 };
  const cur: [number, number, number, number] = [0.42, 0, 0.58, 1];

  it("maps pointer px to p1 coeff (x in segment-progress, y in value)", () => {
    // pointer at x=25px (=0.25 of the 100px wide segment), y=80px (=value 0.2)
    const next = handleDragToCoeff("p1", 25, 80, seg, g, cur);
    expect(next[0]).toBeCloseTo(0.25, 6);
    expect(next[1]).toBeCloseTo(0.2, 6);
    expect([next[2], next[3]]).toEqual([0.58, 1]); // p2 untouched
  });
  it("clamps x into [0,1] (keeps time monotone) but leaves y free (overshoot)", () => {
    const next = handleDragToCoeff("p2", 150, -20, seg, g, cur); // x past end, y above top
    expect(next[2]).toBe(1);             // clamped
    expect(next[3]).toBeCloseTo(1.2, 6); // value 1.2 → overshoot allowed
  });
  it("flat segment (Δv==0) locks y to the current coeff, x still moves", () => {
    const flatSeg: Seg = { aTUs: 0, aVal: 5, bTUs: 1_000_000, bVal: 5 };
    const next = handleDragToCoeff("p1", 50, 10, flatSeg, { ...g, vmin: 4, vmax: 6 }, cur);
    expect(next[0]).toBeCloseTo(0.5, 6); // x moved
    expect(next[1]).toBe(cur[1]);        // y unchanged (0)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframe/curveGraph.test.ts`
Expected: FAIL — `handleDragToCoeff` not exported.

- [ ] **Step 3: Add the implementation**

Append to `curveGraph.ts`:

```ts
/// New full coeffs after dragging one control point to (pointerXPx, pointerYPx).
/// `x` clamps to [0,1] (time stays monotone → bezier solver single-valued);
/// `y` is free (overshoot allowed). On a flat segment (Δv==0) the y cannot be
/// inferred from value, so keep the dragged point's current y.
export function handleDragToCoeff(
  which: "p1" | "p2",
  pointerXPx: number,
  pointerYPx: number,
  seg: Seg,
  g: CurveGeom,
  current: [number, number, number, number],
): [number, number, number, number] {
  const dt = seg.bTUs - seg.aTUs;
  const dv = seg.bVal - seg.aVal;
  const tLocal = xPxToTimeUs(pointerXPx, g);
  const cx = dt === 0
    ? (which === "p1" ? current[0] : current[2])
    : clamp01((tLocal - seg.aTUs) / dt);
  const curY = which === "p1" ? current[1] : current[3];
  const cy = dv === 0 ? curY : (yToValue(pointerYPx, g) - seg.aVal) / dv;
  return which === "p1"
    ? [cx, cy, current[2], current[3]]
    : [current[0], current[1], cx, cy];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframe/curveGraph.test.ts`
Expected: PASS (all Task 1-3 cases).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b`
Expected: no errors.

```bash
git add apps/desktop/src/keyframe/curveGraph.ts apps/desktop/src/keyframe/curveGraph.test.ts
git commit -m "feat(keyframe): handle-drag pixel→coefficient mapping"
```

---

## Task 4: KeyframeCurveGraph component (render + pointer wiring)

**Files:**
- Create: `apps/desktop/src/timeline/KeyframeCurveGraph.tsx`
- Test: `apps/desktop/src/timeline/KeyframeCurveGraph.test.tsx`

**Contract preserved for e2e:** each keyframe renders an HTML `<span>` with class `kf-diamond kf-sublane-diamond` (+ ` is-selected` when selected), `data-kf-id`, inline `left`/`top`, a left-button pointerdown that selects+seeks (and retimes on drag), and a contextmenu that opens the menu. (The existing `keyframe_authoring.e2e.js` sub-lane test depends on this.)

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/timeline/KeyframeCurveGraph.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import type { AnimTrack } from "../ipc";
import { KeyframeCurveGraph } from "./KeyframeCurveGraph";

afterEach(cleanup);

const track: Extract<AnimTrack<number>, { mode: "Keyframed" }> = {
  mode: "Keyframed",
  value: [
    { id: "k0", t_us: 0, value: 0, interp: { kind: "Bezier", p1: [0.42, 0], p2: [0.58, 1] } },
    { id: "k1", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
  ],
};

function renderGraph(over: Partial<React.ComponentProps<typeof KeyframeCurveGraph>> = {}) {
  return render(
    <KeyframeCurveGraph
      track={track}
      layerTStartUs={0}
      clipDurationUs={1_000_000}
      pxPerSec={100}
      height={72}
      editable={true}
      selectedKfId={null}
      onSelectSeek={vi.fn()}
      onRetime={vi.fn()}
      onSetInterp={vi.fn()}
      onOpenMenu={vi.fn()}
      {...over}
    />,
  );
}

describe("KeyframeCurveGraph", () => {
  it("renders one dot per keyframe with the e2e contract class + data-kf-id", () => {
    const { container } = renderGraph();
    const dots = container.querySelectorAll(".kf-sublane-diamond");
    expect(dots.length).toBe(2);
    expect(dots[0]!.getAttribute("data-kf-id")).toBe("k0");
  });
  it("renders a curve polyline", () => {
    const { container } = renderGraph();
    expect(container.querySelectorAll("polyline").length).toBeGreaterThanOrEqual(1);
  });
  it("shows tangent handles only when editable", () => {
    expect(renderGraph({ editable: true }).container.querySelectorAll('[data-testid="kf-handle"]').length)
      .toBeGreaterThan(0);
    cleanup();
    expect(renderGraph({ editable: false }).container.querySelectorAll('[data-testid="kf-handle"]').length)
      .toBe(0);
  });
  it("right-click on a dot opens the menu", () => {
    const onOpenMenu = vi.fn();
    const { container } = renderGraph({ onOpenMenu });
    fireEvent.contextMenu(container.querySelector('.kf-sublane-diamond[data-kf-id="k0"]')!);
    expect(onOpenMenu).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), "k0");
  });
  it("marks the selected keyframe", () => {
    const { container } = renderGraph({ selectedKfId: "k1" });
    expect(container.querySelector('.kf-sublane-diamond[data-kf-id="k1"]')!.className)
      .toContain("is-selected");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/timeline/KeyframeCurveGraph.test.tsx`
Expected: FAIL — `Cannot find module './KeyframeCurveGraph'`.

- [ ] **Step 3: Write the implementation**

```tsx
// apps/desktop/src/timeline/KeyframeCurveGraph.tsx
// On-lane value-curve renderer + in-place tangent-handle editor for one
// keyframed property of one layer. Curve + handles live in an SVG overlay
// (absolute, ruler-px coordinates); keyframe dots are HTML spans on top so
// they keep the `.kf-sublane-diamond` contract the e2e suite asserts.
import { useMemo, useRef } from "react";
import type { AnimTrack, Interpolation } from "../ipc";
import { interpToCoeffs } from "../keyframe/curve";
import {
  computeValueRange, segmentPolyline, segmentHandles, handleDragToCoeff,
  valueToY, timeToXPx, type CurveGeom, type Seg,
} from "../keyframe/curveGraph";

type KeyframedTrack = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

export function KeyframeCurveGraph({
  track,
  layerTStartUs,
  clipDurationUs,
  pxPerSec,
  height,
  editable,
  selectedKfId,
  onSelectSeek,
  onRetime,
  onSetInterp,
  onOpenMenu,
}: {
  track: KeyframedTrack;
  layerTStartUs: number;
  clipDurationUs: number;
  pxPerSec: number;
  height: number;
  editable: boolean;
  selectedKfId: string | null;
  /// click a dot (no drag): select it + seek the transport to its time.
  onSelectSeek: (kfId: string) => void;
  /// drag a dot horizontally: retime to a new layer-local µs (caller commits).
  onRetime: (kfId: string, newTUsLocal: number) => void;
  /// drag a handle: set the owning segment-key's interp.
  onSetInterp: (kfId: string, interp: Interpolation) => void;
  /// right-click a dot or the curve: open the preset/Smooth menu.
  onOpenMenu: (clientX: number, clientY: number, kfId: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const keys = track.value;

  const geom: CurveGeom = useMemo(() => {
    const { vmin, vmax } = computeValueRange(keys);
    return { pxPerSec, layerTStartUs, height, vmin, vmax };
  }, [keys, pxPerSec, layerTStartUs, height]);

  // Segments: each owns keys[i].interp (p1 near keys[i], p2 near keys[i+1]).
  const segments = useMemo(() => {
    const out: { owner: string; seg: Seg; interp: Interpolation }[] = [];
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i]!;
      const b = keys[i + 1]!;
      out.push({
        owner: a.id,
        seg: { aTUs: a.t_us, aVal: a.value, bTUs: b.t_us, bVal: b.value },
        interp: a.interp,
      });
    }
    return out;
  }, [keys]);

  function svgPoint(e: PointerEvent | React.PointerEvent): { x: number; y: number } {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function dragHandle(owner: string, which: "p1" | "p2", seg: Seg, e: React.PointerEvent) {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    const current = interpToCoeffs(
      keys.find((k) => k.id === owner)!.interp,
    ) as [number, number, number, number];
    const move = (me: PointerEvent) => {
      const p = svgPoint(me);
      const [c0, c1, c2, c3] = handleDragToCoeff(which, p.x, p.y, seg, geom, current);
      onSetInterp(owner, { kind: "Bezier", p1: [c0, c1], p2: [c2, c3] });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      teardownRef.current = null;
    };
    teardownRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function dragDot(kfId: string, startTUs: number, e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelectSeek(kfId);
    const startClientX = e.clientX;
    let nextTUs: number | null = null;
    const move = (me: PointerEvent) => {
      const dxUs = ((me.clientX - startClientX) / pxPerSec) * 1_000_000;
      nextTUs = Math.max(0, Math.min(clipDurationUs, startTUs + dxUs));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      teardownRef.current = null;
      if (nextTUs != null && nextTUs !== startTUs) onRetime(kfId, nextTUs);
    };
    teardownRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <>
      <svg
        ref={svgRef}
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        data-testid="kf-curve-graph"
      >
        {segments.map(({ owner, seg, interp }) => {
          const pts = segmentPolyline(seg, interp, geom).map((p) => `${p.x},${p.y}`).join(" ");
          const handles = editable ? segmentHandles(seg, interp, geom) : null;
          return (
            <g key={owner}>
              <polyline
                points={pts}
                fill="none"
                stroke="var(--ring, #9a9aff)"
                strokeWidth={editable ? 2 : 1}
                opacity={editable ? 1 : 0.5}
              />
              {handles && (["p1", "p2"] as const).map((which) => {
                const at = which === "p1" ? handles.p1 : handles.p2;
                const anchor = which === "p1"
                  ? { x: timeToXPx(seg.aTUs, geom), y: valueToY(seg.aVal, geom) }
                  : { x: timeToXPx(seg.bTUs, geom), y: valueToY(seg.bVal, geom) };
                return (
                  <g key={which}>
                    <line x1={anchor.x} y1={anchor.y} x2={at.x} y2={at.y}
                      stroke="var(--ring, #6b6bff)" strokeWidth={1} opacity={0.7} />
                    <circle
                      cx={at.x} cy={at.y} r={5}
                      fill="var(--ring, #6b6bff)"
                      className="pointer-events-auto cursor-grab"
                      data-testid="kf-handle"
                      onPointerDown={(e) => dragHandle(owner, which, seg, e)}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {keys.map((k) => (
        <span
          key={k.id}
          className={`kf-diamond kf-sublane-diamond${selectedKfId === k.id ? " is-selected" : ""}`}
          style={{ left: timeToXPx(k.t_us, geom), top: valueToY(k.value, geom) }}
          data-kf-id={k.id}
          onPointerDown={(e) => dragDot(k.id, k.t_us, e)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onSelectSeek(k.id);
            onOpenMenu(e.clientX, e.clientY, k.id);
          }}
        />
      ))}
    </>
  );
}
```

> Note: `useRef`'s teardown on unmount mirrors `EasingCanvas`'s pattern. Add this effect if not already present via the import set — include at top of component body:
> ```tsx
> import { useEffect } from "react";
> useEffect(() => () => teardownRef.current?.(), []);
> ```
> (Add `useEffect` to the React import and place the effect right after the refs.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/timeline/KeyframeCurveGraph.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b`
Expected: no errors.

```bash
git add apps/desktop/src/timeline/KeyframeCurveGraph.tsx apps/desktop/src/timeline/KeyframeCurveGraph.test.tsx
git commit -m "feat(timeline): KeyframeCurveGraph value-curve renderer + handle editing"
```

---

## Task 5: EasingMenu (preset + Smooth popover)

**Files:**
- Create: `apps/desktop/src/timeline/EasingMenu.tsx`
- Test: `apps/desktop/src/timeline/EasingMenu.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/src/timeline/EasingMenu.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { AnimTrack } from "../ipc";
import { EasingMenu } from "./EasingMenu";

afterEach(cleanup);

const track: AnimTrack<number> = {
  mode: "Keyframed",
  value: [
    { id: "k0", t_us: 0, value: 0, interp: { kind: "Linear" } },
    { id: "k1", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
  ],
};

describe("EasingMenu", () => {
  it("clicking a preset commits that interp on the keyframe and closes", () => {
    const onCommit = vi.fn();
    const onClose = vi.fn();
    render(<EasingMenu x={10} y={10} track={track} kfId="k0" onCommit={onCommit} onClose={onClose} />);
    fireEvent.click(screen.getByText("Ease In-Out"));
    const next = onCommit.mock.calls[0]![0] as AnimTrack<number>;
    const k0 = (next as Extract<AnimTrack<number>, { mode: "Keyframed" }>).value.find((k) => k.id === "k0")!;
    expect(k0.interp.kind).toBe("Bezier");
    expect(onClose).toHaveBeenCalled();
  });
  it("Smooth is disabled on a Hold keyframe", () => {
    const hold: AnimTrack<number> = {
      mode: "Keyframed",
      value: [{ id: "k0", t_us: 0, value: 0, interp: { kind: "Hold" } },
              { id: "k1", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } }],
    };
    render(<EasingMenu x={0} y={0} track={hold} kfId="k0" onCommit={() => {}} onClose={() => {}} />);
    expect((screen.getByTestId("easing-smooth") as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/timeline/EasingMenu.test.tsx`
Expected: FAIL — `Cannot find module './EasingMenu'`.

- [ ] **Step 3: Write the implementation**

```tsx
// apps/desktop/src/timeline/EasingMenu.tsx
// Small preset/Smooth popover anchored at a click point. Replaces the abstract
// EasingEditor unit-square popup: curve editing now happens in-place on the
// timeline (KeyframeCurveGraph); this menu only applies named presets / Smooth.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { AnimTrack } from "../ipc";
import { PRESETS } from "../keyframe/curve";
import { setKeyframeInterp, smoothKeyframe } from "../keyframe/edits";

const CHIP_STYLE: React.CSSProperties = {
  fontSize: "11px",
  padding: "2px 8px",
  borderRadius: "4px",
  border: "1px solid var(--border, #3f3f46)",
  background: "var(--secondary, #27272a)",
  color: "var(--foreground, #fafafa)",
  cursor: "pointer",
};

export function EasingMenu({
  x, y, track, kfId, onCommit, onClose,
}: {
  x: number;
  y: number;
  track: AnimTrack<number>;
  kfId: string;
  onCommit: (next: AnimTrack<number>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const current =
    track.mode === "Keyframed"
      ? (track.value.find((k) => k.id === kfId)?.interp ?? { kind: "Linear" as const })
      : { kind: "Linear" as const };
  const isHold = current.kind === "Hold";

  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        ({ x, y, top: y, left: x, right: x, bottom: y, width: 0, height: 0 }) as DOMRect,
    }),
    [x, y],
  );

  return (
    <PopoverPrimitive.Root open modal={false} onOpenChange={(o) => { if (!o) onClose(); }}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4} className="z-50">
          <PopoverPrimitive.Popup
            className="menu-list"
            style={{ padding: "6px", display: "flex", flexWrap: "wrap", gap: "4px", width: "168px" }}
          >
            {PRESETS.map((p) => (
              <button
                key={p.id}
                style={CHIP_STYLE}
                onClick={() => { onCommit(setKeyframeInterp(track, kfId, p.interp)); onClose(); }}
              >
                {t(p.labelKey)}
              </button>
            ))}
            <button
              style={{ ...CHIP_STYLE, cursor: isHold ? "not-allowed" : "pointer", opacity: isHold ? 0.4 : 1 }}
              disabled={isHold}
              data-testid="easing-smooth"
              onClick={() => { onCommit(smoothKeyframe(track, kfId)); onClose(); }}
            >
              {t("keyframe.smooth")}
            </button>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/timeline/EasingMenu.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b`
Expected: no errors.

```bash
git add apps/desktop/src/timeline/EasingMenu.tsx apps/desktop/src/timeline/EasingMenu.test.tsx
git commit -m "feat(timeline): EasingMenu preset/Smooth popover"
```

---

## Task 6: focus-driven sub-lanes — render the graph in KeyframeLane

**Files:**
- Modify: `apps/desktop/src/keyframe/focusStore.ts`
- Modify: `apps/desktop/src/timeline/KeyframeLane.tsx`
- Test: `apps/desktop/src/keyframe/focusStore.test.ts` (create)

- [ ] **Step 1: Add the focus-selector test**

```ts
// apps/desktop/src/keyframe/focusStore.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  setKeyframeFocus, clearKeyframeFocus, useFocusedParamKeyForTrackLayers,
} from "./focusStore";

beforeEach(() => clearKeyframeFocus());

describe("useFocusedParamKeyForTrackLayers", () => {
  it("returns the focused paramKey when the focused layer is in the set", () => {
    setKeyframeFocus("L1", "opacity");
    const { result } = renderHook(() => useFocusedParamKeyForTrackLayers(new Set(["L1", "L2"])));
    expect(result.current).toBe("opacity");
  });
  it("returns null when the focused layer is NOT in the set", () => {
    setKeyframeFocus("LX", "opacity");
    const { result } = renderHook(() => useFocusedParamKeyForTrackLayers(new Set(["L1"])));
    expect(result.current).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframe/focusStore.test.ts`
Expected: FAIL — `useFocusedParamKeyForTrackLayers` not exported.

- [ ] **Step 3: Add the selector to focusStore.ts**

Append to `apps/desktop/src/keyframe/focusStore.ts`:

```ts
/// The focused paramKey IF the focused layer belongs to `layerIds`, else null.
/// Atomic primitive return (string|null) — safe under useSyncExternalStore
/// (per the zustand composite-selector rule). `layerIds` must be a stable Set.
export function useFocusedParamKeyForTrackLayers(layerIds: Set<string>): string | null {
  return useKeyframeFocusStore((s) => (s.layerId && layerIds.has(s.layerId) ? s.paramKey : null));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframe/focusStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire KeyframeLane to render the curve graph**

In `apps/desktop/src/timeline/KeyframeLane.tsx`:

(a) Update imports — replace the `EasingEditor` import and add the new ones:

```tsx
import { setKeyframeFocus, useFocusedParamKeyForTrackLayers } from "../keyframe/focusStore";
import { setKeyframeInterp } from "../keyframe/edits";
import { KeyframeCurveGraph } from "./KeyframeCurveGraph";
import { EasingMenu } from "./EasingMenu";
```

(keep existing imports of `retimeKeyframe, removeKeyframe`, `selectKeyframe`, `transportSeek`, etc.; remove the `import { EasingEditor } from "./EasingEditor";` line.)

(b) Add the expanded-height constant next to `KF_SUBLANE_H`:

```tsx
export const KF_SUBLANE_H = 24;
export const KF_SUBLANE_EXPANDED_H = 72;
```

(c) In `KeyframeLaneHeaders`, size each header row to match the body:

```tsx
export function KeyframeLaneHeaders({ track }: { track: TrackSummary }) {
  const { t } = useTranslation();
  const props = trackKeyframeProperties(track);
  const layerIds = useMemo(() => new Set(track.layers.map((l) => l.id)), [track.layers]);
  const focusedParamKey = useFocusedParamKeyForTrackLayers(layerIds);
  return (
    <>
      {props.map((d) => (
        <div
          key={d.paramKey}
          className="flex items-center justify-end border-b border-border-soft px-1.5 text-[10px] text-muted-foreground/80"
          style={{ height: d.paramKey === focusedParamKey ? KF_SUBLANE_EXPANDED_H : KF_SUBLANE_H }}
        >
          {t(d.labelKey, { defaultValue: d.paramKey })}
        </div>
      ))}
    </>
  );
}
```

(add `useMemo` to the React import in this file if not already imported.)

(d) In `KeyframeLane`, compute the focused param and render the graph per layer. Replace the body-rows `props.map(...)` block (the one rendering `<SubLaneDiamond>`) with:

```tsx
  const layerIds = useMemo(() => new Set(track.layers.map((l) => l.id)), [track.layers]);
  const focusedParamKey = useFocusedParamKeyForTrackLayers(layerIds);
  const focusedLayerId = useKeyframeFocusStore((s) => s.layerId);

  return (
    <>
      {props.map((d) => {
        const expanded = d.paramKey === focusedParamKey;
        return (
          <div
            key={d.paramKey}
            className="relative border-b border-border-soft"
            style={{ height: expanded ? KF_SUBLANE_EXPANDED_H : KF_SUBLANE_H }}
          >
            {track.layers.map((layer) => {
              const trk = readParamTrack(layer.params, d.paramKey);
              if (!trk || trk.mode !== "Keyframed") return null;
              const durUs = layer.t_end_us - layer.t_start_us;
              return (
                <LayerCurveLane
                  key={layer.id}
                  layerId={layer.id}
                  paramKey={d.paramKey}
                  track={trk}
                  layerTStartUs={layer.t_start_us}
                  clipDurationUs={durUs}
                  pxPerSec={pxPerSec}
                  height={expanded ? KF_SUBLANE_EXPANDED_H : KF_SUBLANE_H}
                  editable={expanded && focusedLayerId === layer.id}
                  onCommitParamTrack={onCommitParamTrack}
                  onOpenInterpMenu={openInterpMenu}
                />
              );
            })}
          </div>
        );
      })}
      {interpMenu && (() => {
        const layer = track.layers.find((l) => l.id === interpMenu.layerId);
        if (!layer) return null;
        const trk = readParamTrack(layer.params, interpMenu.paramKey);
        if (!trk || trk.mode !== "Keyframed") return null;
        return (
          <EasingMenu
            x={interpMenu.x}
            y={interpMenu.y}
            track={trk}
            kfId={interpMenu.kfId}
            onClose={() => setInterpMenu(null)}
            onCommit={(next) => onCommitParamTrack(interpMenu.layerId, interpMenu.paramKey, next)}
          />
        );
      })()}
    </>
  );
```

(add `useKeyframeFocusStore` to the focusStore import.)

(e) Replace the `SubLaneDiamond` component with a `LayerCurveLane` wrapper that adapts the graph's callbacks to the existing commit/selection plumbing:

```tsx
function LayerCurveLane({
  layerId, paramKey, track, layerTStartUs, clipDurationUs, pxPerSec, height,
  editable, onCommitParamTrack, onOpenInterpMenu,
}: {
  layerId: string;
  paramKey: string;
  track: Extract<AnimTrack<number>, { mode: "Keyframed" }>;
  layerTStartUs: number;
  clipDurationUs: number;
  pxPerSec: number;
  height: number;
  editable: boolean;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
  onOpenInterpMenu: OpenInterpMenu;
}) {
  const selectedKfId = useKeyframeSelectionStore((s) =>
    s.selected && s.selected.layerId === layerId && s.selected.paramKey === paramKey
      ? s.selected.kfId
      : null,
  );
  return (
    <KeyframeCurveGraph
      track={track}
      layerTStartUs={layerTStartUs}
      clipDurationUs={clipDurationUs}
      pxPerSec={pxPerSec}
      height={height}
      editable={editable}
      selectedKfId={selectedKfId}
      onSelectSeek={(kfId) => {
        const kf = track.value.find((k) => k.id === kfId);
        selectKeyframe({ layerId, paramKey, kfId });
        setKeyframeFocus(layerId, paramKey);
        if (kf) transportSeek(layerTStartUs + kf.t_us);
      }}
      onRetime={(kfId, newTUs) =>
        onCommitParamTrack(layerId, paramKey, retimeKeyframe(track, kfId, newTUs))
      }
      onSetInterp={(kfId, interp) =>
        onCommitParamTrack(layerId, paramKey, setKeyframeInterp(track, kfId, interp))
      }
      onOpenMenu={(cx, cy, kfId) => onOpenInterpMenu(cx, cy, layerId, paramKey, kfId)}
    />
  );
}
```

> `AnimTrack` is already imported in `KeyframeLane.tsx`. The `useKeyframeSelectionStore` import already exists. Keep the existing capture-phase Delete effect and `interpMenu` state untouched.

- [ ] **Step 6: Run the full unit suite + typecheck**

Run: `npx vitest run` then `npx tsc -b`
Expected: PASS / no errors. (Confirms KeyframeLane still compiles and other tests are unaffected.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/keyframe/focusStore.ts apps/desktop/src/keyframe/focusStore.test.ts apps/desktop/src/timeline/KeyframeLane.tsx
git commit -m "feat(timeline): render value-curve graph in keyframe sub-lanes (focus to edit)"
```

---

## Task 7: LayerBlock in-clip right-click → EasingMenu; delete the old popup

**Files:**
- Modify: `apps/desktop/src/timeline/LayerBlock.tsx`
- Delete: `apps/desktop/src/timeline/EasingEditor.tsx`, `EasingCanvas.tsx`, `MotionPreview.tsx`

- [ ] **Step 1: Swap the import in LayerBlock.tsx**

Replace:
```tsx
import { EasingEditor } from "./EasingEditor";
```
with:
```tsx
import { EasingMenu } from "./EasingMenu";
```

- [ ] **Step 2: Swap the component usage**

In `LayerBlock.tsx`, the in-clip `interpMenu` render block (currently `<EasingEditor … />`) becomes `<EasingMenu … />` — the props are identical (`x`, `y`, `track`, `kfId`, `onClose`, `onCommit`):

```tsx
      {interpMenu && focusedParam && (() => {
        const track = readParamTrack(layer.params, focusedParam);
        if (!track || track.mode !== "Keyframed") return null;
        return (
          <EasingMenu
            x={interpMenu.x}
            y={interpMenu.y}
            track={track}
            kfId={interpMenu.kfId}
            onClose={() => setInterpMenu(null)}
            onCommit={(next) => onCommitParamTrack(layer.id, focusedParam, next)}
          />
        );
      })()}
```

(The collapsed in-clip diamonds and their pointer/contextmenu handlers stay exactly as they are — keyframe positions only, no curve.)

- [ ] **Step 3: Delete the retired files**

```bash
git rm apps/desktop/src/timeline/EasingEditor.tsx apps/desktop/src/timeline/EasingCanvas.tsx apps/desktop/src/timeline/MotionPreview.tsx
```

- [ ] **Step 4: Verify nothing else references them**

Run: `npx tsc -b`
Expected: no errors. If tsc reports an unresolved import to any deleted file, fix that importer (there should be none beyond LayerBlock/KeyframeLane already handled).

Also confirm by search — expected: no matches.
Run (from repo root): `git grep -n "EasingEditor\|EasingCanvas\|MotionPreview" -- apps/desktop/src`
Expected: no output.

- [ ] **Step 5: Run unit suite + commit**

Run: `npx vitest run`
Expected: PASS.

```bash
git add apps/desktop/src/timeline/LayerBlock.tsx
git commit -m "refactor(timeline): in-clip easing uses EasingMenu; remove abstract popup editor"
```

---

## Task 8: i18n cleanup + docs

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`, `apps/desktop/src/i18n/locales/zh-CN.ts`
- Modify: `docs/render.md` (keyframe-authoring section)

- [ ] **Step 1: Remove the unused `easing_title` key**

In `apps/desktop/src/i18n/locales/en-US.ts` delete the line:
```ts
    easing_title: "Easing",
```
In `apps/desktop/src/i18n/locales/zh-CN.ts` delete the line:
```ts
    easing_title: "缓动",
```
(Keep `smooth` and every `interp_*` key — the preset menu still uses them.)

- [ ] **Step 2: Verify no remaining reference**

Run (from repo root): `git grep -n "easing_title" -- apps/desktop/src`
Expected: no output.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Update the docs**

In `docs/render.md`, find the keyframe-authoring / interpolation section and replace any description of the cubic-bezier popup editor with a short evergreen paragraph (no dates / phase numbers):

```markdown
Easing is shown and edited directly on the timeline. Each animated property's
keyframe sub-lane draws its value over time as a curve; focusing a property
expands its lane and exposes tangent handles on each keyframe (left = the
previous segment's outgoing control point, right = this segment's). Dragging a
handle edits that segment's `cubic-bezier`; right-clicking a keyframe or segment
opens a preset / Smooth menu. The curve follows the value, so which segment an
easing governs is read directly from the picture.
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts docs/render.md
git commit -m "chore(i18n,docs): drop easing_title; document on-lane curve editor"
```

---

## Task 9: Full verification (typecheck, unit, real-WebView2 e2e)

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the whole app**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 2: Full unit suite**

Run: `npx vitest run`
Expected: PASS (includes the new curveGraph / KeyframeCurveGraph / EasingMenu / focusStore tests; pre-existing curve/edits/geometry tests still green).

- [ ] **Step 3: Run the keyframe e2e in real WebView2**

The e2e authors keyframes via `update_layer_param_track` (data path — unchanged) and the sub-lane test clicks `.kf-sublane-diamond` (contract preserved in Task 4). Both must still pass.

Per project memory (wdio single-spec on Windows): call the wdio binary directly and verify "Execution of 1 workers". From `apps/desktop`:

Run: `node node_modules\@wdio\cli\bin\wdio.js run wdio.conf.js --spec e2e/specs/ui/keyframe_authoring.e2e.js`
Expected: the suite reports passing specs — specifically:
- "keyframe authoring end-to-end (opacity ramp → export…)" PASS
- "keyframe sub-lanes (expand → diamonds → click-seek…)" PASS (2 `.kf-sublane-diamond` found, click selects + seeks)
- "custom cubic-Bézier easing reaches exported frames…" PASS

If the sub-lane spec fails to find 2 `.kf-sublane-diamond`, inspect that the dots still render with that class and `style.left` (Task 4 contract). If it fails on click-seek, confirm `onSelectSeek` still calls `selectKeyframe` + `transportSeek`.

> Requires `WEFTCUT_TEST_MEDIA` set and a built/dev app per the e2e README; if the harness/driver isn't available in this environment, mark this step blocked and report — do not claim e2e pass without the run.

- [ ] **Step 4: Manual visual smoke (real app)**

Launch the app (`/run` or the project's dev command), add a clip, keyframe its opacity (2+ keys), expand the track:
- Unfocused sub-lane shows a faint value curve thumbnail (24px).
- Click a keyframe → its property lane grows (~72px), handles appear; drag a handle → the curve reshapes and playback reflects the new easing.
- Right-click a keyframe → preset/Smooth menu; pick "Ease In-Out" → curve updates.
- Collapsed clip (collapse the track) shows keyframe diamonds only, no curve.

- [ ] **Step 5: Final commit (if any doc/notes touched during verification)**

```bash
git add -A
git commit -m "test: verify inline keyframe curve graph (unit + e2e green)"
```

(Skip if nothing changed in this task.)

---

## Self-Review

**Spec coverage:**
- Value-graph semantics (curve follows value, per-lane auto-scale) → Task 1 (`computeValueRange`, `valueToY`), Task 2 (`segmentPolyline`). ✓
- Reuse Model-B `Bezier{p1,p2}` as handles (p1 outgoing / p2 incoming) → Task 2 (`segmentHandles`), Task 4 (per-segment owner = left key). ✓
- Compact thumbnail (24px read-only) + focus-expand (72px editable) → Task 6 (height from `useFocusedParamKeyForTrackLayers`, `editable` gate). ✓
- In-place tangent handles; x∈[0,1] clamp, y free, Δv==0 lock → Task 3 (`handleDragToCoeff`), Task 4 (`dragHandle`). ✓
- Retire abstract popup; preset/Smooth/Hold context menu → Task 5 (`EasingMenu`), Task 7 (delete + wire). ✓
- No vertical value-drag (X-only dot drag) → Task 4 (`dragDot` moves t_us only). ✓
- Collapsed in-clip = diamonds only, right-click → menu → Task 7. ✓
- Last-keyframe edge (no outgoing segment) → Task 4 (`segments` loops `i < length-1`; last key never owns a drawn/edited segment). ✓
- Hold/Linear show no handles → Task 2 (`segmentHandles` returns null). ✓
- No engine/IPC/export change; e2e green → Task 9. ✓
- i18n + docs → Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**Type consistency:** `CurveGeom`/`Seg`/`Pt` defined in Task 1-2 and used identically in Task 4. `KeyframeCurveGraph` prop names (`onSelectSeek`, `onRetime`, `onSetInterp`, `onOpenMenu`, `clipDurationUs`, `editable`) match between Task 4 definition and Task 6 caller. `useFocusedParamKeyForTrackLayers` signature matches Task 6 callers. `EasingMenu` props (`x,y,track,kfId,onCommit,onClose`) match Task 5/6/7. `handleDragToCoeff(which, x, y, seg, geom, current)` matches Task 3 def and Task 4 call. ✓
