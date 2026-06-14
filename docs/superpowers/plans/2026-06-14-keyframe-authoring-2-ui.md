# Keyframe Authoring — Plan 2: Authoring UI (Stopwatch, Diamonds, Interp)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Depends on Plan 1** (`2026-06-14-keyframe-authoring-1-write-path.md`): the
> `updateLayerParamTrack(s)` IPC wrappers and the actor write path must be merged first.

**Status: SHIPPED — all 12 tasks implemented and merged to main (`29c76f8f`).**
Built subagent-driven in worktree wt2 (each task spec + code-quality reviewed; the
reviews caught a HIGH bug where deleting a keyframe also deleted the layer — fixed
via capture-phase `keydown` + `stopImmediatePropagation`). tsc 0 / vitest 547, and
the export-sampling e2e passed in real WebView2. Checkboxes below were not
back-ticked during execution; kept as the execution record.

**Goal:** Make `Animated<f64>` properties authorable end-to-end — a per-property stopwatch + auto-key in the inspector, collapsed-mode keyframe diamonds on the clip with click/drag/delete/interp-menu, and the preview reflecting the animation — all driving Plan 1's `updateLayerParamTrack`.

**Architecture:** A thin per-kind descriptor (`animatableParams(kind)`) enumerates each kind's animatable params (the frontend mirror of Plan 1's `resolve_animated_f64_mut`). Pure `AnimTrack` transforms (`keyframe/edits.ts`) implement lift/collapse/upsert/remove/retime/set-interp; components call them then `updateLayerParamTrack`. A shared `<AnimatableField>` wraps the existing inspector controls with a stopwatch and a playhead-evaluated display value. A `keyframeFocusStore` broadcasts the focused `{layerId, paramKey}`; `LayerBlock` renders that param's diamonds and handles their interactions, drilling a commit callback from `Timeline` (the `onCommitLabel` pattern).

**Tech Stack:** React 19 + TypeScript, zustand (atomic selectors per `feedback_zustand_composite_selector`), lucide-react icons, `@base-ui/react` Menu, react-i18next, vitest (pure logic), Tauri IPC. Verification: `npm run typecheck` + `npx vitest run` + one wdio e2e in real WebView2.

**Spec:** `docs/superpowers/specs/2026-06-14-keyframe-authoring-design.md` (§2 architecture, §4 stopwatch/auto-key, §5 diamonds, §7 interp/fields).

---

## File Structure

- `apps/desktop/src/keyframe/descriptors.ts` — **create.** `ParamDescriptor`,
  `animatableParams(kind)`, `readParamTrack(params, key)`. Pure.
- `apps/desktop/src/keyframe/descriptors.test.ts` — **create.** Unit tests.
- `apps/desktop/src/keyframe/edits.ts` — **create.** Pure `AnimTrack` transforms:
  `liftToKeyframed`, `collapseToStatic`, `upsertKeyframe`, `removeKeyframe`,
  `retimeKeyframe`, `setKeyframeInterp`.
- `apps/desktop/src/keyframe/edits.test.ts` — **create.** Unit tests.
- `apps/desktop/src/keyframe/focusStore.ts` — **create.** zustand `{layerId, paramKey}`.
- `apps/desktop/src/timeline/geometry.ts` — **modify.** Add `keyframeXWithinClip` +
  `keyframeHitTest` pure helpers.
- `apps/desktop/src/timeline/geometry.test.ts` — **modify.** Tests for the above.
- `apps/desktop/src/components/AnimatableField.tsx` — **create.** Stopwatch + control + display.
- `apps/desktop/src/properties/PropertyPanel.tsx` — **modify.** Wrap animatable rows in
  `<AnimatableField>`; thread `currentTimeUs`.
- `apps/desktop/src/panels/RightPanel.tsx` — **modify.** Pass `currentTimeUs` to `PropertyPanel`.
- `apps/desktop/src/timeline/LayerBlock.tsx` — **modify.** Collapsed diamonds + interactions.
- `apps/desktop/src/timeline/TrackLane.tsx` + `Timeline.tsx` — **modify.** Drill the
  keyframe-commit callback (the `onCommitLabel` pattern) + the focused param.
- `apps/desktop/src/timeline/KeyframeInterpMenu.tsx` — **create.** Right-click interp menu.
- `apps/desktop/src/i18n/locales/en-US.ts` + `zh-CN.ts` — **modify.** New strings.
- `apps/desktop/e2e/specs/keyframe_authoring.e2e.js` — **create.** Real-WebView2 e2e.

All frontend commands run from `apps/desktop/`. Stage by explicit path; re-check
`git status --short` before each commit; use the repo's `Co-Authored-By` trailer.

---

### Task 1: `descriptors.ts` — animatable param table (pure, TDD)

**Files:**
- Create: `apps/desktop/src/keyframe/descriptors.ts`
- Create: `apps/desktop/src/keyframe/descriptors.test.ts`

The descriptor matches the rows the inspector already renders per kind (spec §1).
The IPC view flattens transform, so `params.x` / `params.opacity` / `params.gain_db`
are `AnimTrack<number>` directly.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/keyframe/descriptors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { animatableParams, readParamTrack } from "./descriptors";
import type { AnimTrack, LayerSummary } from "../ipc";

describe("animatableParams", () => {
  it("VideoClip exposes the five transform+opacity params", () => {
    expect(animatableParams("VideoClip").map((d) => d.paramKey)).toEqual([
      "x", "y", "scale_x", "scale_y", "opacity",
    ]);
  });
  it("ImageOverlay and Text omit scale", () => {
    expect(animatableParams("ImageOverlay").map((d) => d.paramKey)).toEqual(["x", "y", "opacity"]);
    expect(animatableParams("Text").map((d) => d.paramKey)).toEqual(["x", "y", "opacity"]);
  });
  it("Audio exposes gain_db + pan", () => {
    expect(animatableParams("Audio").map((d) => d.paramKey)).toEqual(["gain_db", "pan"]);
  });
  it("Color and Subtitles have no animatable params", () => {
    expect(animatableParams("Color")).toEqual([]);
    expect(animatableParams("Subtitles")).toEqual([]);
  });
});

describe("readParamTrack", () => {
  it("reads the AnimTrack off the flattened params view", () => {
    const track: AnimTrack<number> = { mode: "Static", value: 0.5 };
    const params = { kind: "VideoClip", opacity: track } as unknown as LayerSummary["params"];
    expect(readParamTrack(params, "opacity")).toBe(track);
    expect(readParamTrack(params, "nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframe/descriptors.test.ts`
Expected: FAIL — cannot resolve `./descriptors`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/keyframe/descriptors.ts`:

```ts
// The frontend mirror of Plan 1's Rust `resolve_animated_f64_mut`: which
// params each layer kind can keyframe, in inspector order. The IPC view
// flattens transform, so `params[paramKey]` is the `AnimTrack<number>`.
import type { AnimTrack, LayerSummary } from "../ipc";

export interface ParamDescriptor {
  /// Wire key understood by `updateLayerParamTrack` and the Rust resolver.
  paramKey: string;
  /// Existing i18n key (reuse the property-panel labels).
  labelKey: string;
  /// Static fallback used when a Keyframed track is empty / before its first key.
  fallback: number;
}

const X: ParamDescriptor = { paramKey: "x", labelKey: "property_panel.x", fallback: 0 };
const Y: ParamDescriptor = { paramKey: "y", labelKey: "property_panel.y", fallback: 0 };
const SCALE_X: ParamDescriptor = { paramKey: "scale_x", labelKey: "property_panel.scale_x", fallback: 1 };
const SCALE_Y: ParamDescriptor = { paramKey: "scale_y", labelKey: "property_panel.scale_y", fallback: 1 };
const OPACITY: ParamDescriptor = { paramKey: "opacity", labelKey: "property_panel.opacity", fallback: 1 };
const GAIN_DB: ParamDescriptor = { paramKey: "gain_db", labelKey: "property_panel.gain_db", fallback: 0 };
const PAN: ParamDescriptor = { paramKey: "pan", labelKey: "property_panel.pan", fallback: 0 };

export function animatableParams(kind: string): ParamDescriptor[] {
  switch (kind) {
    case "VideoClip":
    case "Motif":
      return [X, Y, SCALE_X, SCALE_Y, OPACITY];
    case "ImageOverlay":
    case "Text":
      return [X, Y, OPACITY];
    case "Audio":
      return [GAIN_DB, PAN];
    default:
      return []; // Color (Rgba only), Subtitles
  }
}

/// Read the `AnimTrack<number>` for `paramKey` off the flattened params view.
/// `null` if the kind doesn't carry that param.
export function readParamTrack(
  params: LayerSummary["params"],
  paramKey: string,
): AnimTrack<number> | null {
  const v = (params as unknown as Record<string, unknown>)[paramKey];
  if (v && typeof v === "object" && "mode" in (v as object)) {
    return v as AnimTrack<number>;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframe/descriptors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/keyframe/descriptors.ts apps/desktop/src/keyframe/descriptors.test.ts
git commit -m "feat(keyframe): animatable param descriptor table"
```

---

### Task 2: `edits.ts` — pure AnimTrack transforms (TDD)

**Files:**
- Create: `apps/desktop/src/keyframe/edits.ts`
- Create: `apps/desktop/src/keyframe/edits.test.ts`

These produce the new `AnimTrack` the component sends to `updateLayerParamTrack`.
The actor re-normalizes (sort/snap/dedupe), so these keep things sane but need not
frame-snap. `collapseToStatic` reuses the render engine's `resolveAnimated`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/keyframe/edits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  liftToKeyframed, collapseToStatic, upsertKeyframe, removeKeyframe,
  retimeKeyframe, setKeyframeInterp,
} from "./edits";
import type { AnimTrack } from "../ipc";

const kf = (id: string, t: number, value: number): AnimTrack<number> =>
  ({ mode: "Keyframed", value: [{ id, t_us: t, value, interp: { kind: "Linear" } }] });

describe("liftToKeyframed", () => {
  it("makes a single-key track at tUs", () => {
    const tr = liftToKeyframed(0.5, 1_000_000);
    expect(tr.mode).toBe("Keyframed");
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value).toHaveLength(1);
    expect(tr.value[0].t_us).toBe(1_000_000);
    expect(tr.value[0].value).toBe(0.5);
  });
});

describe("collapseToStatic", () => {
  it("evaluates the track at tUs and returns Static", () => {
    const tr: AnimTrack<number> = { mode: "Keyframed", value: [
      { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
      { id: "b", t_us: 10_000_000, value: 10, interp: { kind: "Linear" } },
    ]};
    expect(collapseToStatic(tr, 5_000_000, 1)).toEqual({ mode: "Static", value: 5 });
  });
});

describe("upsertKeyframe", () => {
  it("lifts a Static track, keying current value at other times too", () => {
    const tr = upsertKeyframe({ mode: "Static", value: 0.2 }, 2_000_000, 0.9);
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value.map((k) => [k.t_us, k.value])).toEqual([[2_000_000, 0.9]]);
  });
  it("updates the key when one already sits at tUs", () => {
    const tr = upsertKeyframe(kf("a", 1_000_000, 0.1), 1_000_000, 0.7);
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value).toHaveLength(1);
    expect(tr.value[0].value).toBe(0.7);
  });
  it("inserts a new key sorted by t_us", () => {
    const tr = upsertKeyframe(kf("a", 2_000_000, 0.1), 1_000_000, 0.9);
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value.map((k) => k.t_us)).toEqual([1_000_000, 2_000_000]);
  });
});

describe("removeKeyframe", () => {
  it("removes by id, staying Keyframed when keys remain", () => {
    const tr: AnimTrack<number> = { mode: "Keyframed", value: [
      { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
      { id: "b", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
    ]};
    const out = removeKeyframe(tr, "a", 1);
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value.map((k) => k.id)).toEqual(["b"]);
  });
  it("collapses to Static at the removed key's value when it was the last", () => {
    expect(removeKeyframe(kf("a", 0, 0.33), "a", 1)).toEqual({ mode: "Static", value: 0.33 });
  });
});

describe("retimeKeyframe", () => {
  it("moves a key and re-sorts", () => {
    const tr: AnimTrack<number> = { mode: "Keyframed", value: [
      { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
      { id: "b", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
    ]};
    const out = retimeKeyframe(tr, "a", 2_000_000);
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value.map((k) => k.id)).toEqual(["b", "a"]);
  });
});

describe("setKeyframeInterp", () => {
  it("changes a key's interpolation", () => {
    const out = setKeyframeInterp(kf("a", 0, 0), "a", { kind: "Hold" });
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value[0].interp).toEqual({ kind: "Hold" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframe/edits.test.ts`
Expected: FAIL — cannot resolve `./edits`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/keyframe/edits.ts`:

```ts
// Pure AnimTrack<number> transforms for the authoring UI. Each returns a NEW
// track to hand to `updateLayerParamTrack`; the actor re-normalizes
// (sort/snap/dedupe), so these need only stay self-consistent. Times are
// layer-local microseconds (the keyframe `t_us` base).
import type { AnimTrack, Interpolation, Keyframe } from "../ipc";
import { resolveAnimated } from "../render/animated";

function newId(): string {
  return crypto.randomUUID();
}

const DEFAULT_INTERP: Interpolation = { kind: "Linear" };

export function liftToKeyframed(value: number, tUs: number): AnimTrack<number> {
  return { mode: "Keyframed", value: [{ id: newId(), t_us: tUs, value, interp: DEFAULT_INTERP }] };
}

export function collapseToStatic(
  track: AnimTrack<number>,
  tUs: number,
  fallback: number,
): AnimTrack<number> {
  const value = track.mode === "Static" ? track.value : resolveAnimated(track, tUs, fallback);
  return { mode: "Static", value };
}

/// Insert-or-update a key at `tUs`. A Static track is lifted (the new key is
/// the only key). An existing key at exactly `tUs` is updated in place; else a
/// new key is inserted (interp copied from the preceding key, or Linear).
export function upsertKeyframe(
  track: AnimTrack<number>,
  tUs: number,
  value: number,
): AnimTrack<number> {
  if (track.mode === "Static") return liftToKeyframed(value, tUs);
  const keys = track.value.slice();
  const at = keys.findIndex((k) => k.t_us === tUs);
  if (at >= 0) {
    keys[at] = { ...keys[at]!, value };
    return { mode: "Keyframed", value: keys };
  }
  // Inherit interp from the key immediately before tUs (CapCut/AE behavior).
  const prev = keys.filter((k) => k.t_us < tUs).pop();
  const interp = prev?.interp ?? DEFAULT_INTERP;
  keys.push({ id: newId(), t_us: tUs, value, interp });
  keys.sort((a, b) => a.t_us - b.t_us);
  return { mode: "Keyframed", value: keys };
}

/// Remove a key by id. When it was the last key, collapse to a Static holding
/// that key's value (so the property keeps its on-screen value).
export function removeKeyframe(
  track: AnimTrack<number>,
  id: string,
  fallback: number,
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const remaining = track.value.filter((k) => k.id !== id);
  if (remaining.length === 0) {
    const removed = track.value.find((k) => k.id === id);
    return { mode: "Static", value: removed?.value ?? fallback };
  }
  return { mode: "Keyframed", value: remaining };
}

export function retimeKeyframe(
  track: AnimTrack<number>,
  id: string,
  newTUs: number,
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const keys = track.value.map((k) => (k.id === id ? { ...k, t_us: newTUs } : k));
  keys.sort((a, b) => a.t_us - b.t_us);
  return { mode: "Keyframed", value: keys };
}

export function setKeyframeInterp(
  track: AnimTrack<number>,
  id: string,
  interp: Interpolation,
): AnimTrack<number> {
  if (track.mode === "Static") return track;
  return { mode: "Keyframed", value: track.value.map((k) => (k.id === id ? { ...k, interp } : k)) };
}

export type { Keyframe };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframe/edits.test.ts`
Expected: PASS. (Confirm `resolveAnimated`'s signature is `(track, tUs, fallback)` —
it is, per `render/animated.ts`.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/keyframe/edits.ts apps/desktop/src/keyframe/edits.test.ts
git commit -m "feat(keyframe): pure AnimTrack edit transforms"
```

---

### Task 3: `focusStore.ts` — focused-property broadcast

**Files:**
- Create: `apps/desktop/src/keyframe/focusStore.ts`

- [ ] **Step 1: Implement (zustand, atomic selectors)**

Create `apps/desktop/src/keyframe/focusStore.ts`:

```ts
// Which (layer, param) the inspector last focused — drives which property's
// diamonds the collapsed clip renders. Atomic selectors only (per
// feedback_zustand_composite_selector).
import { create } from "zustand";

interface State {
  layerId: string | null;
  paramKey: string | null;
}

export const useKeyframeFocusStore = create<State>(() => ({ layerId: null, paramKey: null }));

export function setKeyframeFocus(layerId: string, paramKey: string): void {
  useKeyframeFocusStore.setState({ layerId, paramKey });
}

export function clearKeyframeFocus(): void {
  useKeyframeFocusStore.setState({ layerId: null, paramKey: null });
}

/// The focused param FOR a given layer, or null when another layer is focused.
export function useFocusedParamFor(layerId: string): string | null {
  return useKeyframeFocusStore((s) => (s.layerId === layerId ? s.paramKey : null));
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/keyframe/focusStore.ts
git commit -m "feat(keyframe): focused-property zustand store"
```

---

### Task 4: Diamond geometry helpers (pure, TDD)

**Files:**
- Modify: `apps/desktop/src/timeline/geometry.ts`
- Modify: `apps/desktop/src/timeline/geometry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/timeline/geometry.test.ts` (import the two new fns into
the existing `./geometry` import at the top):

```ts
describe("keyframeXWithinClip", () => {
  it("maps a layer-local keyframe time to px within the clip width", () => {
    // clip duration 4s rendered at 200px => 50px/s.
    expect(keyframeXWithinClip(0, 4_000_000, 200)).toBe(0);
    expect(keyframeXWithinClip(2_000_000, 4_000_000, 200)).toBe(100);
    expect(keyframeXWithinClip(4_000_000, 4_000_000, 200)).toBe(200);
  });
  it("clamps out-of-range keyframes to the clip bounds", () => {
    expect(keyframeXWithinClip(-1_000_000, 4_000_000, 200)).toBe(0);
    expect(keyframeXWithinClip(5_000_000, 4_000_000, 200)).toBe(200);
  });
  it("returns 0 for a zero-duration clip", () => {
    expect(keyframeXWithinClip(1_000_000, 0, 200)).toBe(0);
  });
});

describe("keyframeHitTest", () => {
  const diamonds = [
    { id: "a", x: 10 },
    { id: "b", x: 100 },
  ];
  it("returns the id whose x is within the radius of pointerX", () => {
    expect(keyframeHitTest(diamonds, 12, 6)).toBe("a");
    expect(keyframeHitTest(diamonds, 103, 6)).toBe("b");
  });
  it("returns null when no diamond is within the radius", () => {
    expect(keyframeHitTest(diamonds, 50, 6)).toBeNull();
  });
  it("returns the nearest when two are within the radius", () => {
    expect(keyframeHitTest([{ id: "a", x: 10 }, { id: "b", x: 14 }], 11, 6)).toBe("a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/timeline/geometry.test.ts`
Expected: FAIL — `keyframeXWithinClip is not a function`.

- [ ] **Step 3: Implement**

Append to `apps/desktop/src/timeline/geometry.ts`:

```ts
/// Map a layer-local keyframe time (µs) to an x offset (px) within a clip
/// chip of `clipDurationUs` rendered `clipWidthPx` wide. Clamps out-of-range
/// keyframes (kept in data after trims) to the clip bounds.
export function keyframeXWithinClip(
  kfTUs: number,
  clipDurationUs: number,
  clipWidthPx: number,
): number {
  if (clipDurationUs <= 0) return 0;
  const u = clamp(kfTUs / clipDurationUs, 0, 1);
  return u * clipWidthPx;
}

/// Nearest diamond id within `radiusPx` of `pointerX`, else null.
export function keyframeHitTest(
  diamonds: readonly { id: string; x: number }[],
  pointerX: number,
  radiusPx: number,
): string | null {
  let best: { id: string; d: number } | null = null;
  for (const dia of diamonds) {
    const d = Math.abs(dia.x - pointerX);
    if (d <= radiusPx && (best === null || d < best.d)) best = { id: dia.id, d };
  }
  return best?.id ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/timeline/geometry.test.ts`
Expected: PASS (new + existing geometry tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/timeline/geometry.ts apps/desktop/src/timeline/geometry.test.ts
git commit -m "feat(timeline): diamond geometry helpers (keyframeXWithinClip, keyframeHitTest)"
```

---

### Task 5: i18n strings

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add keys to en-US**

In `apps/desktop/src/i18n/locales/en-US.ts`, add a `keyframe` block (alongside the
other top-level sections):

```ts
  keyframe: {
    stopwatch_enable: "Animate this property (add a keyframe at the playhead)",
    stopwatch_disable: "Stop animating (collapse to the value at the playhead)",
    stopwatch_offscreen: "Move the playhead over the clip to keyframe",
    interp_hold: "Hold",
    interp_linear: "Linear",
    interp_ease_in: "Ease In",
    interp_ease_out: "Ease Out",
    delete_keyframe: "Delete keyframe",
  },
```

- [ ] **Step 2: Add the same keys to zh-CN**

In `apps/desktop/src/i18n/locales/zh-CN.ts`:

```ts
  keyframe: {
    stopwatch_enable: "为该属性添加动画（在播放头处打关键帧）",
    stopwatch_disable: "停止动画（折叠为播放头处的值）",
    stopwatch_offscreen: "把播放头移到 clip 上方才能打关键帧",
    interp_hold: "保持",
    interp_linear: "线性",
    interp_ease_in: "缓入",
    interp_ease_out: "缓出",
    delete_keyframe: "删除关键帧",
  },
```

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` (Expected: PASS — both locales carry identical keys.)

```bash
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "i18n(keyframe): stopwatch / interp / delete strings (en-US, zh-CN)"
```

---

### Task 6: `<AnimatableField>` component

**Files:**
- Create: `apps/desktop/src/components/AnimatableField.tsx`

Wraps an existing inspector control with a stopwatch toggle and routes the
display value through `resolveAnimated` at the playhead when keyframed. The
control is passed as children; the parent computes the display value via
`displayValue` (below) and feeds it to its own control.

- [ ] **Step 1: Implement**

Create `apps/desktop/src/components/AnimatableField.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";
import type { AnimTrack } from "../ipc";
import { updateLayerParamTrack } from "../ipc";
import { resolveAnimated } from "../render/animated";
import { collapseToStatic, liftToKeyframed } from "../keyframe/edits";
import { setKeyframeFocus } from "../keyframe/focusStore";

/// The value to show in the control: the static value, or the track evaluated
/// at the playhead-local time when keyframed.
export function displayValue(
  track: AnimTrack<number>,
  tInLayerUs: number,
  fallback: number,
): number {
  return track.mode === "Static" ? track.value : resolveAnimated(track, tInLayerUs, fallback);
}

export function AnimatableField({
  layerId,
  paramKey,
  label,
  track,
  fallback,
  tInLayerUs,
  playheadInSpan,
  onMutated,
  children,
}: {
  layerId: string;
  paramKey: string;
  label: string;
  track: AnimTrack<number>;
  fallback: number;
  /// Playhead time relative to the layer's t_start (may be <0 or > duration).
  tInLayerUs: number;
  /// True when the playhead is within the layer's span — gates keyframe creation.
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
  /// The existing control (slider / number field), already bound to the
  /// parent's display value + commit. Rendered to the right of the stopwatch.
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const lit = track.mode === "Keyframed";
  const disabled = !lit && !playheadInSpan; // can't START animating off-clip

  const toggle = async () => {
    try {
      if (lit) {
        await updateLayerParamTrack(layerId, paramKey, collapseToStatic(track, tInLayerUs, fallback));
      } else {
        const value = track.mode === "Static" ? track.value : fallback;
        await updateLayerParamTrack(layerId, paramKey, liftToKeyframed(value, tInLayerUs));
      }
      await onMutated();
    } catch (e) {
      console.warn("stopwatch toggle failed:", e);
    }
  };

  return (
    <div className="anim-field" onFocusCapture={() => setKeyframeFocus(layerId, paramKey)}>
      <button
        type="button"
        className={`anim-stopwatch ${lit ? "is-lit" : ""}`}
        aria-pressed={lit}
        disabled={disabled}
        title={
          disabled
            ? t("keyframe.stopwatch_offscreen")
            : lit
              ? t("keyframe.stopwatch_disable")
              : t("keyframe.stopwatch_enable")
        }
        onClick={toggle}
      >
        <Clock size={12} aria-hidden />
      </button>
      <span className="anim-field-label">{label}</span>
      <div className="anim-field-control">{children}</div>
    </div>
  );
}
```

Add minimal styles to `apps/desktop/src/styles.css` (near `.prop-field`):

```css
.anim-field { display: flex; align-items: center; gap: 6px; }
.anim-field-label { flex: 0 0 auto; font-size: 11px; color: var(--muted-foreground); min-width: 56px; }
.anim-field-control { flex: 1 1 auto; display: flex; align-items: center; gap: 6px; }
.anim-stopwatch { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 4px; color: var(--color-gray-500); background: transparent; border: none; cursor: pointer; }
.anim-stopwatch:hover:not(:disabled) { color: var(--muted-foreground); background: var(--secondary); }
.anim-stopwatch.is-lit { color: #facc15; }
.anim-stopwatch:disabled { opacity: 0.35; cursor: default; }
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck` (Expected: PASS.)

```bash
git add apps/desktop/src/components/AnimatableField.tsx apps/desktop/src/styles.css
git commit -m "feat(keyframe): AnimatableField stopwatch wrapper"
```

---

### Task 7: Wire the inspector — thread playhead + wrap animatable rows

**Files:**
- Modify: `apps/desktop/src/panels/RightPanel.tsx`
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx`

`RightPanel` already has `currentTimeUs`; `PropertyPanel` does not. Thread it
through, compute `tInLayerUs = currentTimeUs - layer.t_start_us` and
`playheadInSpan`, and wrap each animatable row.

- [ ] **Step 1: Pass `currentTimeUs` from RightPanel to PropertyPanel**

In `apps/desktop/src/panels/RightPanel.tsx`, the `<PropertyPanel … />` render (~line
162) gains a prop:

```tsx
        <PropertyPanel
          tracks={tracks}
          groups={groups}
          selectedLayerId={selectedLayerId}
          currentTimeUs={currentTimeUs}
          onMutated={onMutated}
          fpsNum={fpsNum}
          fpsDen={fpsDen}
        />
```

- [ ] **Step 2: Accept it in PropertyPanel + compute layer-local playhead**

In `apps/desktop/src/properties/PropertyPanel.tsx`, add `currentTimeUs: number;` to
the `Props` interface (line 38) and the destructure (line 49). Pass
`currentTimeUs` and the layer down to `KindFields`; inside `KindFields` compute
once:

```tsx
  const tInLayerUs = currentTimeUs - layer.t_start_us;
  const playheadInSpan = currentTimeUs >= layer.t_start_us && currentTimeUs < layer.t_end_us;
```

Thread `tInLayerUs` + `playheadInSpan` into each `*Fields` (add them to the props
each `*Fields` already receives).

- [ ] **Step 3: Wrap each animatable row in `<AnimatableField>`**

Replace each animatable `<Field>` row with an `<AnimatableField>` whose control is
the existing widget bound to the playhead-evaluated value. Worked example for
`VideoClipFields` opacity (apply the same shape to every row listed below):

```tsx
import { AnimatableField, displayValue } from "../components/AnimatableField";
import { readParamTrack } from "../keyframe/descriptors";
// ...
// opacity row — was a plain <Field><AppSlider .../></Field>:
{(() => {
  const track = readParamTrack(v, "opacity") ?? { mode: "Static" as const, value: 1 };
  const shown = displayValue(track, tInLayerUs, 1);
  return (
    <AnimatableField
      layerId={layer.id} paramKey="opacity" label={t("property_panel.opacity")}
      track={track} fallback={1} tInLayerUs={tInLayerUs}
      playheadInSpan={playheadInSpan} onMutated={onMutated}
    >
      <AppSlider min={0} max={1} step={0.01} value={shown}
        onValueChange={(val) => {
          // Edit-while-keyframed = auto-key at the playhead; else Static.
          const next = track.mode === "Keyframed"
            ? upsertKeyframe(track, tInLayerUs, val)
            : { mode: "Static" as const, value: val };
          // Continuous control: debounce the IPC (reuse useDebouncedCommit pattern).
          debouncedCommitTrack("opacity", next);
        }}
      />
      <span className="prop-range-value">{shown.toFixed(2)}</span>
    </AnimatableField>
  );
})()}
```

where `debouncedCommitTrack(paramKey, track)` is a small local helper (mirror the
existing `useDebouncedCommit`) that calls `updateLayerParamTrack(layer.id, paramKey,
track).then(onMutated)`. For non-continuous controls (`AppNumberField`), commit on
`onCommit` (no debounce) using the same `upsertKeyframe`-or-Static branch.

**Apply to exactly these rows (paramKey, fallback, control):**
- `VideoClipFields`: opacity (slider, 1) · scale_x (number, 1) · scale_y (number, 1) · x (number, 0) · y (number, 0). Leave speed/fade/flip as plain `<Field>`.
- `ImageOverlayFields`: opacity (slider, 1) · x (number, 0) · y (number, 0). Leave fades.
- `TextFields`: x (number, 0) · y (number, 0) · opacity (slider, 1). Leave content/font/color (color is Rgba — no stopwatch in v1).
- `AudioFields`: gain_db (number, 0) · pan (slider, 0). Leave mute.
- `MotifFields`: x (number, 0) · y (number, 0) · scale_x (number, 1) · scale_y (number, 1) · opacity (slider, 1). Leave props/lifecycle.
- `ColorFields`, `SubtitlesFields`: unchanged (no animatable params).

`import { upsertKeyframe } from "../keyframe/edits";` at the top.

- [ ] **Step 4: Typecheck + unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/panels/RightPanel.tsx apps/desktop/src/properties/PropertyPanel.tsx
git commit -m "feat(keyframe): stopwatch + auto-key in the inspector"
```

- [ ] **Step 6: Live smoke (real WebView2 via dev MCP bridge)**

Run `npm run tauri:dev`. Select a clip; light the opacity stopwatch; move the
playhead; change opacity — confirm a second keyframe is created and the slider
value tracks the playhead between keys. Confirm the stopwatch is disabled when the
playhead is off the clip.

---

### Task 8: Collapsed-mode diamonds — render

**Files:**
- Modify: `apps/desktop/src/timeline/LayerBlock.tsx`
- Modify: `apps/desktop/src/timeline/TrackLane.tsx` (pass the focused param down)

- [ ] **Step 1: Render the focused param's diamonds inside the clip chip**

In `LayerBlock.tsx`, after computing `liveStart`/`liveEnd`/`width`, resolve the
diamonds to draw:

```tsx
import { useFocusedParamFor } from "../keyframe/focusStore";
import { readParamTrack } from "../keyframe/descriptors";
import { keyframeXWithinClip } from "./geometry";
// ...
const focusedParam = useFocusedParamFor(layer.id);
const clipDurationUs = layer.t_end_us - layer.t_start_us;
const diamonds = (() => {
  if (!focusedParam) return [];
  const track = readParamTrack(layer.params, focusedParam);
  if (!track || track.mode !== "Keyframed") return [];
  return track.value
    // collapsed mode hides out-of-range keys (kept in data; shown dimmed in Phase 3)
    .filter((k) => k.t_us >= 0 && k.t_us <= clipDurationUs)
    .map((k) => ({ id: k.id, x: keyframeXWithinClip(k.t_us, clipDurationUs, layerWidthPx) }));
})();
```

Render a diamond row pinned to the bottom of the chip (inside the existing chip
`<div>`, after the label span):

```tsx
{diamonds.length > 0 && (
  <div className="kf-diamond-row" aria-hidden>
    {diamonds.map((d) => (
      <span key={d.id} className="kf-diamond" style={{ left: d.x }} data-kf-id={d.id} />
    ))}
  </div>
)}
```

Styles in `styles.css`:

```css
.kf-diamond-row { position: absolute; left: 0; right: 0; bottom: 1px; height: 8px; pointer-events: none; }
.kf-diamond { position: absolute; width: 7px; height: 7px; transform: translateX(-50%) rotate(45deg); background: #fff; border: 1px solid rgba(0,0,0,0.5); }
```

- [ ] **Step 2: Pass the focused param requirement through TrackLane**

`LayerBlock` reads the focus store directly (Step 1), so `TrackLane` needs no new
prop. Confirm `useFocusedParamFor` re-renders only the affected `LayerBlock`
(atomic selector keyed by `layerId`).

- [ ] **Step 3: Typecheck + live smoke**

Run: `npm run typecheck` (Expected: PASS.) Then `npm run tauri:dev`: focus the
opacity field of a keyframed clip → diamonds appear on the clip at each key;
focus a non-keyframed field → none.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/timeline/LayerBlock.tsx apps/desktop/src/styles.css
git commit -m "feat(timeline): render collapsed-mode keyframe diamonds for the focused property"
```

---

### Task 9: Diamond interactions — click-seek, drag-retime, delete

**Files:**
- Modify: `apps/desktop/src/timeline/LayerBlock.tsx`
- Modify: `apps/desktop/src/timeline/TrackLane.tsx`, `Timeline.tsx` (drill the commit callback)

- [ ] **Step 1: Drill a keyframe-commit callback (the `onCommitLabel` pattern)**

In `Timeline.tsx`, add a `useCallback` beside `onCommitLabel` (~line 380):

```tsx
const onCommitParamTrack = useCallback(
  async (layerId: string, paramKey: string, track: AnimTrack<number>) => {
    try {
      await updateLayerParamTrack(layerId, paramKey, track);
      await onMutated();
    } catch (e) {
      console.warn("commit param track failed:", e);
    }
  },
  [onMutated],
);
```

Pass it `Timeline → TrackLane → LayerBlock` exactly as `onCommitLabel` is passed.
Add `onCommitParamTrack` to the `TrackLane` and `LayerBlock` prop types
(signature `(layerId: string, paramKey: string, track: AnimTrack<number>) => void`).

- [ ] **Step 2: Make the diamond row interactive**

Change `.kf-diamond-row` to `pointer-events: auto` and add handlers in `LayerBlock`.
Use `keyframeHitTest` against the rendered `diamonds` (in chip-local px). On the
diamond row:

```tsx
import { keyframeHitTest } from "./geometry";
import { retimeKeyframe, removeKeyframe } from "../keyframe/edits";
import { readParamTrack } from "../keyframe/descriptors";
import { transportSeek } from "../state/playbackStore";
// ...
const rowRef = useRef<HTMLDivElement | null>(null);
const KF_HIT_RADIUS = 6;

const diamondPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
  if (!focusedParam) return;
  const track = readParamTrack(layer.params, focusedParam);
  if (!track || track.mode !== "Keyframed") return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const hitId = keyframeHitTest(diamonds, x, KF_HIT_RADIUS);
  if (!hitId) return;
  e.stopPropagation(); // don't start a clip move/select
  const key = track.value.find((k) => k.id === hitId)!;
  // Click = select + seek the playhead to the key (composition time).
  transportSeek(layer.t_start_us + key.t_us);
  // Begin a drag-retime: track pointer until release, commit once.
  const startClientX = e.clientX;
  const startTUs = key.t_us;
  const onMove = (me: PointerEvent) => {
    const dxUs = ((me.clientX - startClientX) / pxPerSec) * 1_000_000;
    const nextTUs = Math.max(0, Math.min(clipDurationUs, startTUs + dxUs));
    // Live visual feedback only; commit on release (actor frame-snaps).
    e.currentTarget.querySelector<HTMLElement>(`[data-kf-id="${hitId}"]`)
      ?.style.setProperty("left", `${keyframeXWithinClip(nextTUs, clipDurationUs, layerWidthPx)}px`);
    (e.currentTarget as HTMLElement).dataset.dragTUs = String(nextTUs);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const nextTUs = Number((e.currentTarget as HTMLElement).dataset.dragTUs ?? startTUs);
    if (nextTUs !== startTUs) {
      onCommitParamTrack(layer.id, focusedParam, retimeKeyframe(track, hitId, nextTUs));
    }
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
};
```

Wire `onPointerDown={diamondPointerDown}` and `onContextMenu` (Task 10) on the
diamond row. (The `data-drag` shuttle keeps the closure simple; the live `left`
nudge is cosmetic — the committed value is frame-snapped by the actor.)

- [ ] **Step 3: Delete-key handling**

When a diamond is the active selection, `Delete` removes it. Track the selected
diamond id in `LayerBlock` local state (`selectedKfId`), set it on diamond
pointerdown, clear on clip deselect. Add a `keydown` effect:

```tsx
useEffect(() => {
  if (!selectedKfId || !focusedParam) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const track = readParamTrack(layer.params, focusedParam);
    if (!track) return;
    const desc = animatableParams(layer.kind).find((d) => d.paramKey === focusedParam);
    onCommitParamTrack(layer.id, focusedParam, removeKeyframe(track, selectedKfId, desc?.fallback ?? 0));
    setSelectedKfId(null);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [selectedKfId, focusedParam, layer.id, layer.kind, layer.params, onCommitParamTrack]);
```

(`import { animatableParams } from "../keyframe/descriptors";`)

- [ ] **Step 4: Typecheck + live smoke**

Run: `npm run typecheck` (Expected: PASS.) Then `npm run tauri:dev`: click a diamond
→ playhead jumps to it; drag → it retimes on release; select + Delete → removed
(deleting the last collapses to Static).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/timeline/LayerBlock.tsx apps/desktop/src/timeline/TrackLane.tsx apps/desktop/src/timeline/Timeline.tsx
git commit -m "feat(timeline): diamond click-seek / drag-retime / delete"
```

---

### Task 10: Interpolation context menu

**Files:**
- Create: `apps/desktop/src/timeline/KeyframeInterpMenu.tsx`
- Modify: `apps/desktop/src/timeline/LayerBlock.tsx`

- [ ] **Step 1: Build the menu**

Create `apps/desktop/src/timeline/KeyframeInterpMenu.tsx` modeled on the existing
`LayerContextMenu.tsx` (same floating-menu shell, position from a click event):

```tsx
import { useTranslation } from "react-i18next";
import type { Interpolation } from "../ipc";

const OPTIONS: { kind: Interpolation["kind"]; labelKey: string }[] = [
  { kind: "Hold", labelKey: "keyframe.interp_hold" },
  { kind: "Linear", labelKey: "keyframe.interp_linear" },
  { kind: "EaseIn", labelKey: "keyframe.interp_ease_in" },
  { kind: "EaseOut", labelKey: "keyframe.interp_ease_out" },
];

export function KeyframeInterpMenu({ x, y, onPick, onClose }: {
  x: number; y: number;
  onPick: (interp: Interpolation) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="timeline-ctx-menu" style={{ left: x, top: y }} onPointerLeave={onClose}>
      {OPTIONS.map((o) => (
        <button key={o.kind} type="button" className="timeline-ctx-item"
          onClick={() => { onPick({ kind: o.kind } as Interpolation); onClose(); }}>
          {t(o.labelKey)}
        </button>
      ))}
    </div>
  );
}
```

(Match `LayerContextMenu.tsx`'s actual class names / dismissal mechanism — reuse
its menu container styling rather than inventing new CSS.)

- [ ] **Step 2: Open it on diamond right-click**

In `LayerBlock`, the diamond row's `onContextMenu`: hit-test, and if a diamond is
hit, open `KeyframeInterpMenu` at the cursor; on pick, call
`onCommitParamTrack(layer.id, focusedParam, setKeyframeInterp(track, hitId, interp))`.
Hold local `{x, y, kfId} | null` menu state.

- [ ] **Step 3: Typecheck + live smoke**

Run: `npm run typecheck` (Expected: PASS.) Then `npm run tauri:dev`: right-click a
diamond → menu → pick Hold/Linear/EaseIn/EaseOut → preview interpolation changes
between that key and the next.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/timeline/KeyframeInterpMenu.tsx apps/desktop/src/timeline/LayerBlock.tsx
git commit -m "feat(timeline): keyframe interpolation context menu"
```

---

### Task 11: e2e — stopwatch → auto-key → drag → export samples the animation

**Files:**
- Create: `apps/desktop/e2e/specs/keyframe_authoring.e2e.js`

Mirror an existing spec's harness (driver bootstrap, project setup, the
`__weftcut*` test hooks, export + frame sampling) — copy the structure from an
export-sampling spec such as `export_content_modes.e2e.js`.

- [ ] **Step 1: Write the e2e**

Create `apps/desktop/e2e/specs/keyframe_authoring.e2e.js` that, in the real app:
1. adds a VideoClip (or Color) layer,
2. via the dev MCP bridge / inspector, lights the `opacity` stopwatch at t=0
   (value 0) and auto-keys at a later frame (value 1) — or drives
   `updateLayerParamTrack` directly through the bridge with a two-key opacity
   track,
3. drags/retimes one diamond (optional — assert the committed track changed),
4. exports a short range and samples two frames, asserting the opacity (mean
   luma / alpha) differs between an early and a late frame — i.e. the animation
   took effect in export.

This also closes the known keyframed-gain e2e gap (the same pattern applies to an
`Audio.gain_db` track if a clip with audio is used).

- [ ] **Step 2: Run the single spec (Windows wdio invocation)**

Per `feedback_wdio_spec_filter_windows`, call wdio directly so `--spec` isn't
dropped:

Run: `node node_modules/@wdio/cli/bin/wdio.js run wdio.conf.js --spec apps/desktop/e2e/specs/keyframe_authoring.e2e.js`
Expected: "Execution of 1 workers" + the spec passes.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/specs/keyframe_authoring.e2e.js
git commit -m "test(e2e): keyframe authoring — auto-key + export samples animation"
```

---

### Task 12: Full verification

**Files:** none.

- [ ] **Step 1: Typecheck + full unit suite**

Run: `npm run typecheck && npx vitest run 2>&1 | tail -20`
Expected: clean; all new `descriptors`/`edits`/`geometry` specs pass.

- [ ] **Step 2: Manual acceptance (real WebView2)**

Run `npm run tauri:dev` and verify the full loop:
- [ ] Stopwatch lights/uns; field value tracks the playhead between keys.
- [ ] Diamonds appear for the focused property only; click-seek, drag-retime,
  Delete (last → Static) all work and undo as single steps.
- [ ] Right-click interp menu changes the curve in preview.
- [ ] Trimming the clip head keeps keyframes glued to content (Plan 1 §6);
  out-of-range keys vanish from collapsed mode and return on un-trim.
- [ ] Export reflects the animation.

- [ ] **Step 3: Commit any smoke fixes**

```bash
git add -A
git commit -m "fix(keyframe): address authoring smoke findings"
```

---

## Self-Review notes

- **Spec coverage:** descriptor (§2) → Task 1; pure edits / auto-key semantics (§4)
  → Tasks 2,7; focus store (§2) → Task 3; diamond geometry + render + interactions
  (§5) → Tasks 4,8,9; interp menu (§7) → Task 10; stopwatch + playhead-tracked
  display (§4) → Tasks 6,7; i18n → Task 5; e2e (§8) → Task 11. Trim/split (§6) is
  Plan 1; this plan's Task-12 manual step verifies it end-to-end.
- **Out of scope (honored):** no `Animated<Rgba>` stopwatch (color rows untouched);
  no Bezier in the interp menu; no expanded sub-lanes (Phase 3); no MCP tools.
- **Type consistency:** `paramKey` strings match Plan 1's resolver + the descriptor;
  `updateLayerParamTrack(layerId, paramKey, track)` arg order matches the Plan 1
  wrapper; `AnimTrack<number>` / `Interpolation` are the existing IPC types; the
  commit callback signature `(layerId, paramKey, track)` is identical across
  Timeline → TrackLane → LayerBlock.
- **Atomic-selector rule:** `useFocusedParamFor(layerId)` selects a primitive string
  (per `feedback_zustand_composite_selector`).
- **Dependency:** every IPC call here (`updateLayerParamTrack`) requires Plan 1 merged.
