# Keyframe Navigator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an After Effects-style per-property keyframe navigator (`◄ ◆ ►` = previous key / set-key-at-playhead / next key) to the left of each row in the expanded keyframe sub-lane header.

**Architecture:** Pure-frontend, reusing the shipped `update_layer_param_track` write path and the existing pure transforms in `keyframe/edits.ts`. Two new modules — a pure query helper (`keyframe/nav.ts`) and a presentational component (`timeline/KeyframeNavigator.tsx`) — plus wiring into `KeyframeLaneHeaders` / `Timeline.tsx` and three i18n keys. No backend, IPC, Rust, engine, schema, or export change.

**Tech Stack:** React + TypeScript, Zustand stores (`focusStore`/`selectionStore`/`playbackStore`), lucide-react icons, Tailwind v4 + the legacy `.anim-stopwatch` CSS class, vitest + @testing-library/react (jsdom) for tests.

**Spec:** `docs/superpowers/specs/2026-06-16-keyframe-navigator-design.md`

---

## File Structure

- **Create `apps/desktop/src/keyframe/nav.ts`** — pure queries over an `AnimTrack<number>` (`keyAt` / `prevKeyAt` / `nextKeyAt`) plus `resolveNavLayer` (which clip a row's navigator targets). No DOM, no stores.
- **Create `apps/desktop/src/keyframe/nav.test.ts`** — vitest for the above.
- **Create `apps/desktop/src/timeline/KeyframeNavigator.tsx`** — the `◄ ◆ ►` button group for one (track, param) row; reads `focusStore`, computes the frame-snapped local playhead, dispatches seeks and `◆` commits.
- **Create `apps/desktop/src/timeline/KeyframeNavigator.test.tsx`** — RTL (jsdom) for the component.
- **Modify `apps/desktop/src/timeline/KeyframeLane.tsx`** — `KeyframeLaneHeaders` renders a `<KeyframeNavigator>` per row and gains four props.
- **Modify `apps/desktop/src/timeline/Timeline.tsx`** (~line 563) — pass `currentTimeUs` / `fpsNum` / `fpsDen` / `onCommitParamTrack` into `<KeyframeLaneHeaders>`.
- **Modify `apps/desktop/src/i18n/locales/en-US.ts` + `zh-CN.ts`** — add `keyframe.nav_prev` / `nav_set` / `nav_next`.
- **Modify `docs/render.md`** — one paragraph documenting the navigator (evergreen tone).

All commands below assume the working directory `apps/desktop`. Run them from there.

---

### Task 1: Pure keyframe queries — `keyframe/nav.ts`

**Files:**
- Create: `apps/desktop/src/keyframe/nav.ts`
- Test: `apps/desktop/src/keyframe/nav.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/keyframe/nav.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { keyAt, prevKeyAt, nextKeyAt } from "./nav";
import type { AnimTrack } from "../ipc";

const track3: AnimTrack<number> = {
  mode: "Keyframed",
  value: [
    { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
    { id: "b", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
    { id: "c", t_us: 2_000_000, value: 0, interp: { kind: "Linear" } },
  ],
};
const staticTrack: AnimTrack<number> = { mode: "Static", value: 0.5 };

describe("keyAt", () => {
  it("returns the key at an exact t_us", () => expect(keyAt(track3, 1_000_000)?.id).toBe("b"));
  it("returns null off a key", () => expect(keyAt(track3, 1_500_000)).toBeNull());
  it("returns null for a Static track", () => expect(keyAt(staticTrack, 0)).toBeNull());
});

describe("prevKeyAt", () => {
  it("finds the latest key strictly before", () => expect(prevKeyAt(track3, 1_500_000)?.id).toBe("b"));
  it("steps off a key sitting exactly on it", () => expect(prevKeyAt(track3, 1_000_000)?.id).toBe("a"));
  it("returns null before the first key", () => expect(prevKeyAt(track3, 0)).toBeNull());
});

describe("nextKeyAt", () => {
  it("finds the earliest key strictly after", () => expect(nextKeyAt(track3, 500_000)?.id).toBe("b"));
  it("steps off a key sitting exactly on it", () => expect(nextKeyAt(track3, 1_000_000)?.id).toBe("c"));
  it("returns null after the last key", () => expect(nextKeyAt(track3, 2_000_000)).toBeNull());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframe/nav.test.ts`
Expected: FAIL — `Failed to resolve import "./nav"` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/keyframe/nav.ts`:

```ts
// Pure read-only queries over an AnimTrack<number> for the keyframe navigator.
// Distinct from the transforms in `edits.ts` (which return new tracks). Times
// are layer-local microseconds; the caller pre-snaps to the frame grid. Static
// tracks have no keys, so every query returns null for them.
import type { AnimTrack, Keyframe } from "../ipc";

/// The key whose t_us exactly equals tUs (caller pre-snaps), or null.
export function keyAt(track: AnimTrack<number>, tUs: number): Keyframe<number> | null {
  if (track.mode !== "Keyframed") return null;
  return track.value.find((k) => k.t_us === tUs) ?? null;
}

/// The latest key strictly before tUs (strict `<` so sitting on a key steps
/// off it), or null. Does not assume the keys are sorted.
export function prevKeyAt(track: AnimTrack<number>, tUs: number): Keyframe<number> | null {
  if (track.mode !== "Keyframed") return null;
  let best: Keyframe<number> | null = null;
  for (const k of track.value) {
    if (k.t_us < tUs && (best === null || k.t_us > best.t_us)) best = k;
  }
  return best;
}

/// The earliest key strictly after tUs, or null.
export function nextKeyAt(track: AnimTrack<number>, tUs: number): Keyframe<number> | null {
  if (track.mode !== "Keyframed") return null;
  let best: Keyframe<number> | null = null;
  for (const k of track.value) {
    if (k.t_us > tUs && (best === null || k.t_us < best.t_us)) best = k;
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframe/nav.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/keyframe/nav.ts src/keyframe/nav.test.ts
git commit -m "feat(keyframe): pure prev/next/at queries for the navigator"
```

---

### Task 2: Target-clip resolution — `resolveNavLayer`

A sub-lane row is a union across the track's clips for one param, but the navigator must act on a single clip. `resolveNavLayer` picks it: the focused clip if it's a candidate, else the sole keyframed clip, else `null` (ambiguous → navigator disabled).

**Files:**
- Modify: `apps/desktop/src/keyframe/nav.ts`
- Test: `apps/desktop/src/keyframe/nav.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/keyframe/nav.test.ts`:

```ts
import { resolveNavLayer } from "./nav";
import type { LayerSummary, TrackSummary } from "../ipc";

const layer = (id: string, opacityMode: "Static" | "Keyframed"): LayerSummary =>
  ({
    id,
    params: {
      opacity:
        opacityMode === "Keyframed"
          ? { mode: "Keyframed", value: [{ id: `${id}k`, t_us: 0, value: 1, interp: { kind: "Linear" } }] }
          : { mode: "Static", value: 1 },
    },
  }) as unknown as LayerSummary;

const trackOf = (...layers: LayerSummary[]): TrackSummary =>
  ({ layers }) as unknown as TrackSummary;

describe("resolveNavLayer", () => {
  it("returns the sole keyframed clip when only one has the param", () => {
    const tr = trackOf(layer("L1", "Keyframed"), layer("L2", "Static"));
    expect(resolveNavLayer(tr, "opacity", null)?.id).toBe("L1");
  });
  it("returns the focused clip when several are keyframed", () => {
    const tr = trackOf(layer("L1", "Keyframed"), layer("L2", "Keyframed"));
    expect(resolveNavLayer(tr, "opacity", "L2")?.id).toBe("L2");
  });
  it("returns null when several are keyframed and none is focused", () => {
    const tr = trackOf(layer("L1", "Keyframed"), layer("L2", "Keyframed"));
    expect(resolveNavLayer(tr, "opacity", null)).toBeNull();
  });
  it("ignores a focused id outside the candidate set", () => {
    const tr = trackOf(layer("L1", "Keyframed"));
    expect(resolveNavLayer(tr, "opacity", "OTHER")?.id).toBe("L1");
  });
  it("returns null when no clip has the param keyframed", () => {
    const tr = trackOf(layer("L1", "Static"));
    expect(resolveNavLayer(tr, "opacity", "L1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/keyframe/nav.test.ts`
Expected: FAIL — `resolveNavLayer is not a function` / no export named `resolveNavLayer`.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/desktop/src/keyframe/nav.ts` (extend the import line and append the function):

```ts
import type { AnimTrack, Keyframe, LayerSummary, TrackSummary } from "../ipc";
import { readParamTrack } from "./descriptors";
```

```ts
/// Which clip on the track the navigator for `paramKey` acts on:
///  1. the focused clip, if it is on the track AND has `paramKey` Keyframed;
///  2. else the sole clip with `paramKey` Keyframed;
///  3. else null (ambiguous — the navigator disables itself).
export function resolveNavLayer(
  track: TrackSummary,
  paramKey: string,
  focusedLayerId: string | null,
): LayerSummary | null {
  const candidates = track.layers.filter((l) => {
    const t = readParamTrack(l.params, paramKey);
    return t?.mode === "Keyframed";
  });
  if (candidates.length === 0) return null;
  if (focusedLayerId) {
    const focused = candidates.find((l) => l.id === focusedLayerId);
    if (focused) return focused;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}
```

(Replace the existing `import type { AnimTrack, Keyframe } from "../ipc";` line with the extended import above. Keep the three query functions from Task 1.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/keyframe/nav.test.ts`
Expected: PASS (14 tests total).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: clean (no errors). (vitest transpiles without a full typecheck, so run `tsc -b` explicitly — a known lesson from the keyframe-authoring work.)

- [ ] **Step 6: Commit**

```bash
git add src/keyframe/nav.ts src/keyframe/nav.test.ts
git commit -m "feat(keyframe): resolveNavLayer target-clip resolution"
```

---

### Task 3: i18n keys for the navigator tooltips

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts` (the `keyframe:` block, ~line 9)
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts` (the `keyframe:` block, ~line 12)

- [ ] **Step 1: Add the en-US keys**

In `apps/desktop/src/i18n/locales/en-US.ts`, inside the `keyframe: { … }` object, after `stopwatch_offscreen`, add:

```ts
    nav_prev: "Previous keyframe",
    nav_set: "Add or remove a keyframe at the playhead",
    nav_next: "Next keyframe",
```

- [ ] **Step 2: Add the zh-CN keys**

In `apps/desktop/src/i18n/locales/zh-CN.ts`, inside the `keyframe: { … }` object, after `stopwatch_offscreen`, add:

```ts
    nav_prev: "上一个关键帧",
    nav_set: "在播放头处添加或删除关键帧",
    nav_next: "下一个关键帧",
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: clean. (If the locale modules are type-checked against each other, both must carry the same keys — this step catches a missing one.)

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/en-US.ts src/i18n/locales/zh-CN.ts
git commit -m "i18n: keyframe navigator tooltips (prev/set/next)"
```

---

### Task 4: The `KeyframeNavigator` component

**Files:**
- Create: `apps/desktop/src/timeline/KeyframeNavigator.tsx`
- Test: `apps/desktop/src/timeline/KeyframeNavigator.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/timeline/KeyframeNavigator.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "../i18n"; // initialize i18next so t(key) resolves (mirrors EasingMenu.test)
import type { AnimTrack, TrackSummary } from "../ipc";
import { KeyframeNavigator } from "./KeyframeNavigator";
import { clearKeyframeFocus } from "../keyframe/focusStore";

vi.mock("../state/playbackStore", () => ({ transportSeek: vi.fn() }));
import { transportSeek } from "../state/playbackStore";

// jsdom lacks PointerEvent; polyfill so fireEvent.pointerDown works.
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

afterEach(() => {
  cleanup();
  clearKeyframeFocus();
  vi.clearAllMocks();
});

const opacityTrack: AnimTrack<number> = {
  mode: "Keyframed",
  value: [
    { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
    { id: "b", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
  ],
};

const oneClipTrack = (params: Record<string, AnimTrack<number>>): TrackSummary =>
  ({ layers: [{ id: "L1", t_start_us: 0, t_end_us: 2_000_000, params }] }) as unknown as TrackSummary;

function renderNav(currentTimeUs: number, onCommit = vi.fn()) {
  render(
    <KeyframeNavigator
      track={oneClipTrack({ opacity: opacityTrack })}
      paramKey="opacity"
      fallback={1}
      currentTimeUs={currentTimeUs}
      fpsNum={30}
      fpsDen={1}
      onCommitParamTrack={onCommit}
    />,
  );
  return onCommit;
}

const setBtn = () => screen.getByTestId("kf-nav-set") as HTMLButtonElement;
const prevBtn = () => screen.getByTestId("kf-nav-prev") as HTMLButtonElement;
const nextBtn = () => screen.getByTestId("kf-nav-next") as HTMLButtonElement;

describe("KeyframeNavigator ◆ set button", () => {
  it("is pressed when the playhead sits on a key", () => {
    renderNav(1_000_000);
    expect(setBtn().getAttribute("aria-pressed")).toBe("true");
  });
  it("is not pressed off a key", () => {
    renderNav(500_000);
    expect(setBtn().getAttribute("aria-pressed")).toBe("false");
  });
  it("removes the key when pressed on a key", () => {
    const onCommit = renderNav(1_000_000);
    fireEvent.click(setBtn());
    expect(onCommit).toHaveBeenCalledTimes(1);
    const next = onCommit.mock.calls[0]![2] as AnimTrack<number>;
    expect(next.mode === "Keyframed" && next.value.some((k) => k.id === "b")).toBe(false);
  });
  it("adds a key at the playhead when pressed off a key in span", () => {
    const onCommit = renderNav(500_000);
    fireEvent.click(setBtn());
    const next = onCommit.mock.calls[0]![2] as AnimTrack<number>;
    expect(next.mode === "Keyframed" && next.value.some((k) => k.t_us === 500_000)).toBe(true);
  });
  it("is disabled off the clip span when not on a key", () => {
    renderNav(3_000_000); // beyond t_end_us
    expect(setBtn().disabled).toBe(true);
  });
});

describe("KeyframeNavigator ◄ ► arrows", () => {
  it("disables ◄ before the first key", () => {
    renderNav(0);
    expect(prevBtn().disabled).toBe(true);
  });
  it("disables ► after the last key", () => {
    renderNav(2_000_000);
    expect(nextBtn().disabled).toBe(true);
  });
  it("seeks to the next key in absolute time on ►", () => {
    renderNav(0);
    fireEvent.click(nextBtn());
    expect(transportSeek).toHaveBeenCalledWith(1_000_000); // t_start 0 + key b at 1_000_000
  });
});

describe("KeyframeNavigator ambiguous track", () => {
  it("disables every button when two clips are keyframed and none is focused", () => {
    const tr = {
      layers: [
        { id: "L1", t_start_us: 0, t_end_us: 2_000_000, params: { opacity: opacityTrack } },
        { id: "L2", t_start_us: 0, t_end_us: 2_000_000, params: { opacity: opacityTrack } },
      ],
    } as unknown as TrackSummary;
    render(
      <KeyframeNavigator
        track={tr}
        paramKey="opacity"
        fallback={1}
        currentTimeUs={500_000}
        fpsNum={30}
        fpsDen={1}
        onCommitParamTrack={vi.fn()}
      />,
    );
    expect(setBtn().disabled).toBe(true);
    expect(prevBtn().disabled).toBe(true);
    expect(nextBtn().disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/timeline/KeyframeNavigator.test.tsx`
Expected: FAIL — `Failed to resolve import "./KeyframeNavigator"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/timeline/KeyframeNavigator.tsx`:

```tsx
import type { SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Diamond } from "lucide-react";
import type { AnimTrack, Keyframe, TrackSummary } from "../ipc";
import { readParamTrack } from "../keyframe/descriptors";
import { keyAt, prevKeyAt, nextKeyAt, resolveNavLayer } from "../keyframe/nav";
import { upsertKeyframe, removeKeyframe } from "../keyframe/edits";
import { resolveAnimated } from "../render/animated";
import { snapFrameRound } from "../frames";
import { transportSeek } from "../state/playbackStore";
import { selectKeyframe } from "../keyframe/selectionStore";
import { setKeyframeFocus, useKeyframeFocusStore } from "../keyframe/focusStore";

/// AE-style per-property keyframe navigator (◄ ◆ ►) for one sub-lane row.
/// Acts on a single resolved clip (focused clip → sole keyframed clip →
/// disabled, per `resolveNavLayer`): ◄/► seek the playhead to the prev/next
/// key (and select+focus it); ◆ toggles a key at the frame-snapped playhead.
/// Pure-frontend — every mutation goes through `onCommitParamTrack`
/// (→ updateLayerParamTrack), one click = one undo step.
export function KeyframeNavigator({
  track,
  paramKey,
  fallback,
  currentTimeUs,
  fpsNum,
  fpsDen,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  paramKey: string;
  fallback: number;
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const { t } = useTranslation();
  // Atomic primitive selector (per the zustand composite-selector rule).
  const focusedLayerId = useKeyframeFocusStore((s) => s.layerId);

  const layer = resolveNavLayer(track, paramKey, focusedLayerId);
  const trk = layer ? readParamTrack(layer.params, paramKey) : null;
  const keyed = trk && trk.mode === "Keyframed" ? trk : null;

  const tLocalUs = layer ? snapFrameRound(currentTimeUs - layer.t_start_us, fpsNum, fpsDen) : 0;
  const inSpan = layer != null && tLocalUs >= 0 && tLocalUs <= layer.t_end_us - layer.t_start_us;

  const at = keyed ? keyAt(keyed, tLocalUs) : null;
  const prev = keyed ? prevKeyAt(keyed, tLocalUs) : null;
  const next = keyed ? nextKeyAt(keyed, tLocalUs) : null;

  const seekTo = (kf: Keyframe<number>) => {
    if (!layer) return;
    selectKeyframe({ layerId: layer.id, paramKey, kfId: kf.id });
    setKeyframeFocus(layer.id, paramKey);
    transportSeek(layer.t_start_us + kf.t_us);
  };

  const onToggle = () => {
    if (!layer || !keyed) return;
    if (at) {
      onCommitParamTrack(layer.id, paramKey, removeKeyframe(keyed, at.id, fallback));
    } else if (inSpan) {
      onCommitParamTrack(
        layer.id,
        paramKey,
        upsertKeyframe(keyed, tLocalUs, resolveAnimated(keyed, tLocalUs, fallback)),
      );
    }
  };

  // The buttons live inside the timeline root, whose onClick deselects the
  // current layer. Stop the bubble so navigating keys doesn't clear selection.
  const stop = (e: SyntheticEvent) => e.stopPropagation();

  return (
    <div className="flex flex-none items-center gap-0.5" onClick={stop} onPointerDown={stop}>
      <button
        type="button"
        data-testid="kf-nav-prev"
        className="anim-stopwatch"
        disabled={!keyed || !prev}
        title={t("keyframe.nav_prev")}
        aria-label={t("keyframe.nav_prev")}
        onClick={() => prev && seekTo(prev)}
      >
        <ChevronLeft size={12} aria-hidden />
      </button>
      <button
        type="button"
        data-testid="kf-nav-set"
        className="anim-stopwatch"
        disabled={!keyed || (!at && !inSpan)}
        aria-pressed={at != null}
        title={t("keyframe.nav_set")}
        aria-label={t("keyframe.nav_set")}
        onClick={onToggle}
      >
        <Diamond size={11} fill={at ? "currentColor" : "none"} aria-hidden />
      </button>
      <button
        type="button"
        data-testid="kf-nav-next"
        className="anim-stopwatch"
        disabled={!keyed || !next}
        title={t("keyframe.nav_next")}
        aria-label={t("keyframe.nav_next")}
        onClick={() => next && seekTo(next)}
      >
        <ChevronRight size={12} aria-hidden />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/timeline/KeyframeNavigator.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/timeline/KeyframeNavigator.tsx src/timeline/KeyframeNavigator.test.tsx
git commit -m "feat(timeline): AE-style keyframe navigator component"
```

---

### Task 5: Wire the navigator into the sub-lane headers

**Files:**
- Modify: `apps/desktop/src/timeline/KeyframeLane.tsx` (the `KeyframeLaneHeaders` export, ~lines 35–53, plus the import block)
- Modify: `apps/desktop/src/timeline/Timeline.tsx` (~line 563)

- [ ] **Step 1: Add the import to `KeyframeLane.tsx`**

Near the other `./` imports at the top of `apps/desktop/src/timeline/KeyframeLane.tsx`, add:

```ts
import { KeyframeNavigator } from "./KeyframeNavigator";
```

- [ ] **Step 2: Replace `KeyframeLaneHeaders`**

Replace the entire existing `KeyframeLaneHeaders` function (currently from `export function KeyframeLaneHeaders({ track }: { track: TrackSummary }) {` through its closing `}`) with:

```tsx
/// Header-column rows: each property's keyframe navigator (◄ ◆ ►) on the left,
/// the property-name label right-aligned. Row-aligned with the body rows below
/// by sharing trackKeyframeProperties + KF_SUBLANE_H.
export function KeyframeLaneHeaders({
  track,
  currentTimeUs,
  fpsNum,
  fpsDen,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const { t } = useTranslation();
  const props = trackKeyframeProperties(track);
  const layerIds = useMemo(() => new Set(track.layers.map((l) => l.id)), [track.layers]);
  const focusedParamKey = useFocusedParamKeyForTrackLayers(layerIds);
  return (
    <>
      {props.map((d) => (
        <div
          key={d.paramKey}
          className="flex items-center justify-between gap-1 border-b border-border-soft px-1.5 text-[10px] text-muted-foreground/80"
          style={{ height: d.paramKey === focusedParamKey ? KF_SUBLANE_EXPANDED_H : KF_SUBLANE_H }}
        >
          <KeyframeNavigator
            track={track}
            paramKey={d.paramKey}
            fallback={d.fallback}
            currentTimeUs={currentTimeUs}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
            onCommitParamTrack={onCommitParamTrack}
          />
          <span className="truncate">{t(d.labelKey, { defaultValue: d.paramKey })}</span>
        </div>
      ))}
    </>
  );
}
```

(`AnimTrack`, `TrackSummary`, `useMemo`, `useTranslation`, `trackKeyframeProperties`, `useFocusedParamKeyForTrackLayers`, `KF_SUBLANE_H`, `KF_SUBLANE_EXPANDED_H` are all already imported/defined in this file. `d.fallback` is a field of the `ParamDescriptor` returned by `trackKeyframeProperties`.)

- [ ] **Step 3: Update the call site in `Timeline.tsx`**

In `apps/desktop/src/timeline/Timeline.tsx` (~line 563), replace:

```tsx
              {expandedTracks.has(track.id) && <KeyframeLaneHeaders track={track} />}
```

with:

```tsx
              {expandedTracks.has(track.id) && (
                <KeyframeLaneHeaders
                  track={track}
                  currentTimeUs={currentTimeUs}
                  fpsNum={fpsNum}
                  fpsDen={fpsDen}
                  onCommitParamTrack={onCommitParamTrack}
                />
              )}
```

(`currentTimeUs`, `fpsNum`, `fpsDen` are props of `Timeline` and `onCommitParamTrack` is the `useCallback` defined at ~line 403 — all in scope at this site.)

- [ ] **Step 4: Typecheck and run the timeline tests**

Run: `npx tsc -b`
Expected: clean.

Run: `npx vitest run src/timeline`
Expected: PASS (existing timeline tests + the new navigator test; the existing `Timeline.interaction.test.tsx` keeps passing — `KeyframeLaneHeaders` is only rendered when a track is expanded).

- [ ] **Step 5: Commit**

```bash
git add src/timeline/KeyframeLane.tsx src/timeline/Timeline.tsx
git commit -m "feat(timeline): render keyframe navigator in expanded sub-lane headers"
```

---

### Task 6: Docs + full gate + manual smoke

**Files:**
- Modify: `docs/render.md` (after the "Keyframe easing authoring" section, ~line 108)

- [ ] **Step 1: Document the navigator (evergreen tone)**

In `docs/render.md`, immediately after the "Keyframe easing authoring" paragraph (the one ending "…read directly from the picture."), add:

```markdown
Each expanded sub-lane header also carries an After Effects-style keyframe
navigator — `◄ ◆ ►` — to the left of the property name. The arrows seek the
playhead to the previous / next keyframe of that property and select it; the
middle diamond toggles a keyframe at the playhead (filled when one sits there →
click removes it; hollow → click adds one at the current value), and is disabled
when the playhead is off the clip. The navigator acts on the focused clip, or
the sole keyframed clip when a track row spans several. Unlike the inspector
stopwatch, which turns a property's animation on or off, the navigator only adds
and removes keys on an already-animated property.
```

- [ ] **Step 2: Run the full gate**

Run: `npx tsc -b`
Expected: clean.

Run: `npx vitest run`
Expected: all green (the suite total grows by the new `nav` + `KeyframeNavigator` tests).

- [ ] **Step 3: Commit**

```bash
git add docs/render.md
git commit -m "docs(render): document the keyframe navigator"
```

- [ ] **Step 4: Manual smoke (real app — the visual/feel acceptance the e2e can't give)**

Run the dev app (`npm run dev` from the repo root if not already running) and verify:
1. Add a clip, animate a property from the inspector (stopwatch on, move the playhead, change the value) so a sub-lane appears.
2. Expand the track (twirl) → each property row shows `◄ ◆ ►` on the left.
3. `►` / `◄` jump the playhead between keys and highlight the landed key; they grey out at the first/last key.
4. With the playhead between keys, `◆` is hollow → click adds a key (diamond appears in the body lane). With the playhead on a key, `◆` is filled → click removes it.
5. Move the playhead off the clip → `◆` greys out.
6. (If easy) put two clips with the same animated property on one track: with neither focused the row's navigator is disabled; click a diamond on one clip → that clip's navigator activates.

Note any rough edges (button sizing in the 24px collapsed row, vertical alignment in the 72px expanded row) and report back; these are CSS-only follow-ups, not blockers.

---

## Self-Review

**1. Spec coverage:**
- §1 Layout → Task 5 (`justify-between`, navigator left + label right).
- §2 Button behavior (◄/►/◆, filled/hollow, disabled off-span, last-key collapse) → Task 4 (component) + Task 1 (queries). `removeKeyframe`/`upsertKeyframe` reused, last-key→Static collapse is their existing behavior.
- §3 Target-clip resolution (focused → sole → disabled) → Task 2 (`resolveNavLayer`) + Task 4 ambiguous-disabled test.
- §4 Pure queries (`keyAt`/`prevKeyAt`/`nextKeyAt`, strict `<`/`>`) → Task 1.
- §5 Component + `KeyframeLaneHeaders` 4 new props threaded from `Timeline.tsx` → Tasks 4 + 5. i18n keys → Task 3.
- §6 Determinism/migration/docs → no engine/schema change (reuses the write path); docs → Task 6.
- §7 Testing (vitest unit + RTL component, `tsc -b` gate, e2e optional) → Tasks 1/2/4 + Task 6 gate. e2e intentionally omitted per the spec (the navigator re-drives the already-gated `update_layer_param_track` path).

**2. Placeholder scan:** none — every code/test step contains complete content.

**3. Type consistency:** `keyAt`/`prevKeyAt`/`nextKeyAt` take `AnimTrack<number>` and return `Keyframe<number> | null` (consistent across Tasks 1/4). `resolveNavLayer(track, paramKey, focusedLayerId)` returns `LayerSummary | null` (Tasks 2/4). `onCommitParamTrack(layerId, paramKey, track)` matches the existing signature in `Timeline.tsx`. `KeyframeLaneHeaders` props (`currentTimeUs`/`fpsNum`/`fpsDen`/`onCommitParamTrack`) match what `Timeline.tsx` passes in Task 5. i18n keys `keyframe.nav_prev`/`nav_set`/`nav_next` defined in Task 3, consumed in Task 4. `data-testid` values (`kf-nav-prev`/`kf-nav-set`/`kf-nav-next`) match between component and test.
