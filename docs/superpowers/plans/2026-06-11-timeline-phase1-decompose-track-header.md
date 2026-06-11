# Timeline Phase 1: Decompose + Visual Refresh + Track Header — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the ~1930-line `Timeline.tsx` into a module directory, restyle the timeline to the neutral-gray Tailwind token system, introduce a real track-header column with eye/M/S/lock controls (Rust `muted`/`solo` fields + mixer skips + unrecorded `update_track_flags` op).

**Architecture:** Behavior-preserving extraction first (move verbatim, translate CSS classes to Tailwind in the same touch, never rewrite interaction logic), then a two-column sticky-header layout, then the Rust track-flags plumbing, then the control buttons. Spec: `docs/superpowers/specs/2026-06-11-timeline-redesign-design.md` (sections 1–3, 6).

**Tech Stack:** React 18 + TypeScript (vitest), Tailwind v4 (`@theme inline` is wired — semantic classes like `bg-background` work), lucide-react icons, Rust/Tauri actor (`tokio`, cargo test).

**Working directory conventions:**
- Frontend commands run in `apps/desktop` (`npm test`, `npx tsc -b`)
- Rust commands run in `apps/desktop/src-tauri` (`cargo test`)
- Phase 2 (keyframe write path) and Phase 3 (expanded sub-lanes) get their own plans after this lands.

**Key existing facts (verified):**
- `Timeline.tsx` is `apps/desktop/src/timeline/Timeline.tsx` (1930 lines). Components inside: `Timeline` (root, 302–1151), `LayerContextMenu` (1163–1243), `MotifBakeDot` (1247–1260), `DisplayModePill` (1267–1290), `TimelineRuler` (1313–1416), `formatRulerLabel` (1422–1434), `EmptyHint` (1436–1449), `TrackLane` (1451–1666), `LayerBlock` (1668–1930). Pure helpers at top: `parseMediaDrag` (69), `trackAcceptsMedia` (84), `computeLayerSlices` (116), `visualOrderedTracks` (166), `trackAcceptsMediaForAutoRoute` (190), `clamp` (272), `groupHue` (279), `indexGroups` (292), `layerOverlapClass` (103), `trackAcceptsForLayer` (1295).
- Timeline legacy CSS lives in `apps/desktop/src/styles.css` lines 822–1129 (`.timeline-toolbar` … `.timeline-root.is-resizing-track`), 1483–1525 (`.timeline-playhead`, `.playhead-knob`), 1684–1692 (`.drop-indicator`). `.timeline` (822–828) and `.timeline { grid-area: timeline; }` (560) style the App-level `<section>` — they STAY. `.motif-bake-dot` (4684–4702) stays this round.
- Rust `Track` struct: `apps/desktop/src-tauri/src/state/track.rs:10-41` (has `enabled`, `locked`; no `muted`/`solo`). `TrackSummary`: `src-tauri/src/commands.rs:70-95`. TS `TrackSummary`: `src/ipc/index.ts:187-208`.
- Mixer: `src-tauri/src/audio/mix.rs` `plan_for_project` — track loop skips `!track.enabled` then per-layer filters.
- Unrecorded-mutation convention: `actor.rs` `do_update_project_settings` (~2928) → `history.replace_settings_everywhere(&next)` + `broadcast_unrecorded(...)`, NO `self.commit()`. Recorded contrast: `do_update_layer` (~2134) → `self.commit(next, actor, summary, affected, diff_hint)`.
- Command chain to mirror: `commands.rs` `update_layer` (1857) → registered in `lib.rs` `invoke_handler` (~124–135) → `ProjectHandle::update_layer` (actor.rs ~1021) → `Command::UpdateLayer` match arm (~1620) → TS `updateLayer` (`ipc/index.ts:784`).
- Icon-button pattern: `<Button variant="ghost" size="icon-xs"><XIcon size={13} /></Button>` from `components/ui/button.tsx` (`icon-xs: size-6 rounded-[3px]`).

---

### Task 1: Extract pure helpers into `timeline/geometry.ts` (TDD)

**Files:**
- Create: `apps/desktop/src/timeline/geometry.ts`
- Create: `apps/desktop/src/timeline/geometry.test.ts`
- Modify: `apps/desktop/src/timeline/Timeline.tsx` (delete moved code, import instead)

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/timeline/geometry.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  clamp,
  computeLayerSlices,
  formatRulerLabel,
  groupHue,
  indexGroups,
  layerOverlapClass,
  visualOrderedTracks,
} from "./geometry";
import type { LayerSummary, TrackSummary } from "../ipc";

function layer(partial: Partial<LayerSummary>): LayerSummary {
  return {
    id: "L",
    kind: "VideoClip",
    label: null,
    t_start_us: 0,
    t_end_us: 1_000_000,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind: "VideoClip" },
    ...partial,
  } as LayerSummary;
}

function track(partial: Partial<TrackSummary>): TrackSummary {
  return {
    id: "T",
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    role: null,
    transient: false,
    layers: [],
    ...partial,
  } as TrackSummary;
}

describe("clamp", () => {
  it("clamps to bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("layerOverlapClass", () => {
  it("classifies Audio vs everything else", () => {
    expect(layerOverlapClass(layer({ params: { kind: "Audio" } as never }))).toBe("audio");
    expect(layerOverlapClass(layer({ params: { kind: "Text" } as never }))).toBe("visual");
  });
});

describe("computeLayerSlices", () => {
  it("gives full slice when no opposite-class overlap", () => {
    const a = layer({ id: "a" });
    const slices = computeLayerSlices([a]);
    expect(slices.get("a")).toBe("full");
  });
  it("splits overlapping visual+audio into top/bottom", () => {
    const v = layer({ id: "v", t_start_us: 0, t_end_us: 2_000_000 });
    const a = layer({
      id: "a",
      params: { kind: "Audio" } as never,
      t_start_us: 1_000_000,
      t_end_us: 3_000_000,
    });
    const slices = computeLayerSlices([v, a]);
    expect(slices.get("v")).toBe("top");
    expect(slices.get("a")).toBe("bottom");
  });
  it("keeps non-overlapping pairs full", () => {
    const v = layer({ id: "v", t_start_us: 0, t_end_us: 1_000_000 });
    const a = layer({
      id: "a",
      params: { kind: "Audio" } as never,
      t_start_us: 2_000_000,
      t_end_us: 3_000_000,
    });
    const slices = computeLayerSlices([v, a]);
    expect(slices.get("v")).toBe("full");
    expect(slices.get("a")).toBe("full");
  });
});

describe("visualOrderedTracks", () => {
  it("reverses data order and marks the role/extra boundary", () => {
    const t0 = track({ id: "t0", role: null, transient: true });
    const t1 = track({ id: "t1", role: "a-roll" as never });
    const t2 = track({ id: "t2", role: "b-roll" as never });
    const out = visualOrderedTracks([t0, t1, t2]);
    expect(out.map((v) => v.track.id)).toEqual(["t2", "t1", "t0"]);
    expect(out.map((v) => v.isGroupStart)).toEqual([false, false, true]);
  });
});

describe("groupHue", () => {
  it("is deterministic and skips the 60-120 band", () => {
    const h = groupHue("group-1");
    expect(h).toBe(groupHue("group-1"));
    expect(h < 60 || h >= 120).toBe(true);
    expect(h).toBeLessThan(360);
  });
});

describe("indexGroups", () => {
  it("maps layer ids to group ids", () => {
    const idx = indexGroups([
      { id: "g1", layer_ids: ["a", "b"] } as never,
    ]);
    expect(idx.get("a")).toBe("g1");
    expect(idx.get("b")).toBe("g1");
    expect(idx.get("c")).toBeUndefined();
  });
});

describe("formatRulerLabel", () => {
  it("formats mm:ss for >=1s steps", () => {
    expect(formatRulerLabel(65, 5)).toBe("1:05");
  });
  it("formats centiseconds for sub-second steps", () => {
    expect(formatRulerLabel(1.25, 0.5)).toBe("0:01.25");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (cwd `apps/desktop`): `npx vitest run src/timeline/geometry.test.ts`
Expected: FAIL — `Cannot find module './geometry'` (or equivalent resolve error).

- [ ] **Step 3: Create `geometry.ts` by moving the helpers verbatim**

Create `apps/desktop/src/timeline/geometry.ts`. Content = the following moved **verbatim** from `Timeline.tsx` (source lines given), with `export` added to each, plus the shared constants:

```typescript
import type { GroupSummary, LayerSummary, TrackSummary } from "../ipc";

// ---- shared constants (moved from Timeline.tsx:46-60) ----
export const DEFAULT_PX_PER_SEC = 80;
export const MIN_PX_PER_SEC_FLOOR = 0.05;
export const MAX_PX_PER_SEC = 800;
export const DEFAULT_TRACK_HEIGHT = 56;
export const MIN_TRACK_HEIGHT = 24;
export const MAX_TRACK_HEIGHT = 200;
export const MIN_LAYER_DURATION_US = 100_000;
export const VIEW_SAVE_DEBOUNCE_MS = 200;
/// Width of the sticky track-header column introduced by the Phase-1
/// redesign (spec section 1).
export const HEADER_COL_PX = 160;

// ---- moved verbatim ----
export interface VisualTrack { ... }            // Timeline.tsx:88-94
export type LayerOverlapClass = "visual" | "audio";   // :101
export function layerOverlapClass(...) { ... }  // :103-105
export type LayerSlice = "full" | "top" | "bottom";   // :114
export function computeLayerSlices(...) { ... } // :116-138 (keep doc comments)
export function visualOrderedTracks(...) { ... } // :166-182
export function clamp(...) { ... }              // :272-274
export function groupHue(...) { ... }           // :279-287
export function indexGroups(...) { ... }        // :292-300
export function formatRulerLabel(...) { ... }   // :1422-1434
```

(The `{ ... }` bodies above are NOT placeholders to invent — they are the exact bodies currently at the cited `Timeline.tsx` lines; cut-paste them unchanged, including their doc comments.)

- [ ] **Step 4: Update `Timeline.tsx` to import from geometry**

In `Timeline.tsx`: delete the moved constants/functions/types and add:

```typescript
import {
  DEFAULT_PX_PER_SEC,
  DEFAULT_TRACK_HEIGHT,
  HEADER_COL_PX,
  MAX_PX_PER_SEC,
  MAX_TRACK_HEIGHT,
  MIN_LAYER_DURATION_US,
  MIN_PX_PER_SEC_FLOOR,
  MIN_TRACK_HEIGHT,
  VIEW_SAVE_DEBOUNCE_MS,
  clamp,
  computeLayerSlices,
  formatRulerLabel,
  groupHue,
  indexGroups,
  visualOrderedTracks,
  type LayerSlice,
} from "./geometry";
```

(Note: `layerOverlapClass` is only used by `computeLayerSlices` internally — don't import it. `HEADER_COL_PX` is imported now to avoid touching this import block again in Task 6.) Leave `parseMediaDrag`, `trackAcceptsMedia`, `trackAcceptsMediaForAutoRoute`, `trackAcceptsForLayer` in `Timeline.tsx` — they're DOM/drag-coupled stubs, not geometry.

- [ ] **Step 5: Run tests + typecheck**

Run (cwd `apps/desktop`): `npx vitest run src/timeline/geometry.test.ts` → PASS (all tests).
Run: `npx tsc -b` → no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/timeline/geometry.ts apps/desktop/src/timeline/geometry.test.ts apps/desktop/src/timeline/Timeline.tsx
git commit -m "refactor(timeline): extract pure helpers into geometry.ts with unit tests"
```

---

### Task 2: Extract `TimelineRuler.tsx` + Tailwind restyle

**Files:**
- Create: `apps/desktop/src/timeline/TimelineRuler.tsx`
- Modify: `apps/desktop/src/timeline/Timeline.tsx` (delete `TimelineRuler`, import it)

- [ ] **Step 1: Create `TimelineRuler.tsx`**

Move `TimelineRuler` (Timeline.tsx:1313-1416) verbatim into the new file, then replace ONLY the `className` strings in its return JSX with Tailwind equivalents. Final return block:

```tsx
import { useMemo } from "react";
import { formatTimecode, frameDurUs } from "../frames";
import { formatRulerLabel } from "./geometry";

export function TimelineRuler({ pxPerSec, totalSec, widthPx, fpsNum, fpsDen }: {
  pxPerSec: number;
  totalSec: number;
  widthPx: number;
  fpsNum: number;
  fpsDen: number;
}) {
  // ... tick computation moved verbatim from Timeline.tsx:1326-1395 ...
  return (
    <div
      className="relative h-5 flex-none select-none overflow-hidden border-b border-border-soft bg-card text-[10px] text-muted-foreground"
      style={{ width: widthPx }}
    >
      {items.map((tk) => (
        <div
          key={tk.i}
          className={`pointer-events-none absolute top-0 h-full w-0 after:absolute after:bottom-0 after:left-0 after:w-px after:content-[''] ${
            tk.isMajor
              ? "after:h-2 after:bg-foreground/55"
              : "after:h-1 after:bg-muted-foreground/55"
          }`}
          style={{ left: tk.x }}
        >
          {tk.isMajor && (
            <span className="absolute left-[3px] top-px whitespace-nowrap leading-3">
              {isFrameMode
                ? formatTimecode(Math.round(tk.t * 1_000_000), fpsNum, fpsDen)
                : formatRulerLabel(tk.t, majorSec)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
```

(The tick-computation `useMemo` — `NICE_STEPS_SEC`, `NICE_STEPS_FRAMES`, frame-mode branch, etc. — is the exact code at Timeline.tsx:1326-1395, unchanged.)

- [ ] **Step 2: Update Timeline.tsx**

Delete `TimelineRuler` + its consts from `Timeline.tsx`; `formatRulerLabel` already lives in geometry. Add `import { TimelineRuler } from "./TimelineRuler";`. The call-site JSX (line ~1081) is unchanged.

- [ ] **Step 3: Verify**

Run: `npx tsc -b` → clean. Run: `npm test` → all green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/timeline/TimelineRuler.tsx apps/desktop/src/timeline/Timeline.tsx
git commit -m "refactor(timeline): extract TimelineRuler with token styling"
```

---

### Task 3: Extract `LayerBlock.tsx` + new clip look

**Files:**
- Create: `apps/desktop/src/timeline/LayerBlock.tsx`
- Modify: `apps/desktop/src/timeline/Timeline.tsx`

- [ ] **Step 1: Create `LayerBlock.tsx`**

Move `LayerBlock` (Timeline.tsx:1668-1930) and `MotifBakeDot` (1247-1260) into the new file. `MotifBakeDot` keeps its legacy `motif-bake-dot is-*` classes (its CSS at styles.css:4684 stays this round). Also move the `DragState`/`DragKind`/`PendingLayerPlacement` **type** definitions (Timeline.tsx:194-226) here and export them (LayerBlock is their primary consumer; Timeline imports them back):

```typescript
export type DragKind = "move" | "trim-start" | "trim-end";
export interface DragState { /* verbatim from Timeline.tsx:196-213 */ }
export interface PendingLayerPlacement { /* verbatim from :221-226 */ }
```

Logic (live-start/end computation, edge-zone trim, pointer handlers, slice math) moves **verbatim**. Only the root `<div>` of the return JSX changes — legacy classes → Tailwind, plus the spec's gradient/border treatment:

```tsx
const sliceClasses =
  slice === "top"
    ? "rounded-b-none border-b border-b-black/25"
    : slice === "bottom"
      ? "rounded-t-none border-t border-t-white/10"
      : "";

return (
  <div
    className={[
      "timeline-layer", // retained as a JS hook for the blade-cursor rule + tests; carries no styles after Task 9
      "absolute flex items-center overflow-hidden rounded border border-white/15 px-2",
      "text-[11px] font-semibold text-background select-none cursor-grab",
      "shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-[outline,filter] duration-75",
      "hover:brightness-110",
      sliceClasses,
      isSelected ? "z-[2] outline outline-2 -outline-offset-2 outline-ring" : "",
      isDragging ? "z-[3] cursor-grabbing brightness-[1.15]" : "",
      layer.locked ? "cursor-not-allowed outline outline-1 outline-dashed outline-black/50" : "",
      movedAcrossTracks ? "pointer-events-none" : "",
    ].join(" ")}
    style={{
      left,
      top: sliceTop,
      width: layerWidthPx,
      height: sliceHeight,
      backgroundColor: layer.color_hint,
      backgroundImage:
        "linear-gradient(180deg, rgba(255,255,255,0.10), rgba(0,0,0,0.14))",
      opacity: movedAcrossTracks ? 0.3 : layer.enabled ? 1 : 0.45,
      cursor:
        !layer.locked && !bladeMode && !isDragging && edgeHover !== null
          ? "ew-resize"
          : undefined,
      ...groupStyle,
    }}
    /* onClick / onPointerDown / onPointerMove / onPointerLeave /
       onContextMenu / title — verbatim from source */
  >
    <span className="relative z-[1] flex-1 overflow-hidden text-ellipsis whitespace-nowrap [text-shadow:0_1px_0_rgba(255,255,255,0.4)]">
      {label}
    </span>
    {layer.kind === "Motif" && <MotifBakeDot layerId={layer.id} />}
  </div>
);
```

Notes: the old `is-primary` class was styled nowhere in CSS — drop it (keep the `isPrimary` prop; it's unused visually today). `background: layer.color_hint` becomes `backgroundColor` so the gradient `backgroundImage` can layer on top.

- [ ] **Step 2: Update Timeline.tsx**

Delete moved code; add `import { LayerBlock, type DragKind, type DragState, type PendingLayerPlacement } from "./LayerBlock";` and `MotifBakeDot` import removal (now internal to LayerBlock).

- [ ] **Step 3: Verify**

`npx tsc -b` → clean. `npm test` → green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/timeline/LayerBlock.tsx apps/desktop/src/timeline/Timeline.tsx
git commit -m "refactor(timeline): extract LayerBlock with gradient clip styling"
```

---

### Task 4: Extract `TrackLane.tsx` + neutral lane styling

**Files:**
- Create: `apps/desktop/src/timeline/TrackLane.tsx`
- Modify: `apps/desktop/src/timeline/Timeline.tsx`

- [ ] **Step 1: Create `TrackLane.tsx`**

Move `TrackLane` (Timeline.tsx:1451-1666) verbatim. Also move `MEDIA_DRAG_TYPE`, `MediaDragPayload`, `parseMediaDrag` (Timeline.tsx:62-77) here and export them (TrackLane's drop zone is the consumer; Timeline imports `MEDIA_DRAG_TYPE`/`parseMediaDrag` back for `onMediaDrop` typing). Root `<div>` className translation — kind tints are REMOVED per spec section 2 (all lanes neutral):

```tsx
<div
  className={[
    "relative border-b border-border-soft bg-background",
    isCrossTrackTarget ? "bg-secondary outline outline-1 outline-dashed -outline-offset-1 outline-primary" : "",
    isGroupStart ? "border-t border-t-border" : "",
    isRevealed ? "outline outline-1 outline-dashed -outline-offset-1 outline-blue-400/55 bg-blue-400/5" : "",
  ].join(" ")}
  style={{ height }}
  /* onClick / onDragOver / onDragLeave / onDrop — verbatim */
>
```

(`is-group-start` had no CSS rule before — the spec's divider intent gets a real `border-t border-t-border` now. `kind-video/audio/subtitle` tints die here.)

Keep the floating `.track-label` div for now (Task 6 moves it into TrackHeader) but translate its classes inline:

```tsx
<div className="pointer-events-none absolute left-1 top-1 text-[10px] uppercase tracking-wider text-muted-foreground">
  {track.label ?? kindLabel}
  {isRevealed && <span className="text-blue-400/70 font-medium"> (revealed)</span>}
</div>
```

(The `(revealed)` suffix was a CSS `::after`; render it in JSX from here on. It is NOT i18n'd today — keep it literal.)

Drop indicator + resize handle translations:

```tsx
{dragOverX !== null && (
  <div
    className="pointer-events-none absolute bottom-1 top-1 w-0.5 bg-foreground shadow-[0_0_6px_rgba(255,255,255,0.4)]"
    style={{ left: dragOverX }}
  />
)}
/* layers render — verbatim */
<div
  className="absolute inset-x-0 -bottom-[3px] z-[3] h-1.5 cursor-ns-resize bg-transparent transition-colors duration-75 hover:bg-blue-400/35"
  title={...}
  onPointerDown={onHeightDragStart}
/>
```

- [ ] **Step 2: Update Timeline.tsx**

Delete moved code; import `{ TrackLane }`, `{ MEDIA_DRAG_TYPE, parseMediaDrag, type MediaDragPayload }` from `./TrackLane`. Call-site unchanged.

- [ ] **Step 3: Verify + commit**

`npx tsc -b` clean, `npm test` green.

```bash
git add apps/desktop/src/timeline/TrackLane.tsx apps/desktop/src/timeline/Timeline.tsx
git commit -m "refactor(timeline): extract TrackLane; neutral lane styling, kind tints removed"
```

---

### Task 5: Extract `contextMenu.tsx` + view/zoom/drag hooks

**Files:**
- Create: `apps/desktop/src/timeline/contextMenu.tsx`
- Create: `apps/desktop/src/timeline/hooks/useTimelineView.ts`
- Create: `apps/desktop/src/timeline/hooks/useHeightDrag.ts`
- Create: `apps/desktop/src/timeline/hooks/useLayerDrag.ts`
- Modify: `apps/desktop/src/timeline/Timeline.tsx`

- [ ] **Step 1: Move `LayerContextMenu`**

Move Timeline.tsx:1163-1243 verbatim into `contextMenu.tsx` (export it; keep the Base UI `MenuPrimitive` import + `menu-list`/`menu-item` legacy classes — the shared dropdown chrome is NOT timeline CSS). `DisplayModePill` and `EmptyHint` stay in `Timeline.tsx` (small, single-consumer).

- [ ] **Step 2: Create `useTimelineView`**

Signature and contents — moves Timeline.tsx state/effects verbatim: `pxPerSec`/`trackHeights` state (321-322), `viewLoadedRef` + initial load (326, 523-546), ref mirrors + debounced save (550-585), wheel zoom + scroll re-anchor (594-661):

```typescript
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { viewStateGet, viewStateSet, type TrackSummary } from "../../ipc";
import {
  DEFAULT_PX_PER_SEC, MAX_PX_PER_SEC, MIN_PX_PER_SEC_FLOOR,
  VIEW_SAVE_DEBOUNCE_MS, clamp,
} from "../geometry";

export function useTimelineView(opts: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  tracks: TrackSummary[];
  durationUs: number;
}): {
  pxPerSec: number;
  trackHeights: Record<string, number>;
  setTrackHeights: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  trackHeightsRef: React.MutableRefObject<Record<string, number>>;
} {
  // body = the verbatim blocks listed above; the wheel handler keeps
  // reading durationUsRef/pxPerSecRef exactly as before.
}
```

- [ ] **Step 3: Create `useHeightDrag`**

Moves `HeightDragState` (215-219), `beginHeightDrag` (868-884), and the height pointermove effect (886-908):

```typescript
export function useHeightDrag(opts: {
  trackHeightsRef: React.MutableRefObject<Record<string, number>>;
  setTrackHeights: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}): {
  heightDrag: { trackId: string; startY: number; startHeight: number } | null;
  beginHeightDrag: (trackId: string) => (e: React.PointerEvent) => void;
}
```

- [ ] **Step 4: Create `useLayerDrag`**

Moves drag/pendingPlacement state (330-332), `pendingLayer`/`dragLayer` memos (484-517), `trackUnderPointer` (665-676), `snapDragDelta` (683-690), `snapMoveDeltaToClipBoundary` (692-757), `handlePointerMove`/`handlePointerUp` + listener effect (759-864):

```typescript
export function useLayerDrag(opts: {
  tracks: TrackSummary[];
  groups: GroupSummary[];
  groupByLayerId: Map<string, string>;
  orderedTracks: VisualTrack[];
  trackRows: { track: TrackSummary; y: number; height: number }[];
  canvasRef: React.RefObject<HTMLDivElement | null>;
  pxPerSec: number;
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
  tailSnapEnabled: boolean;
  tailSnapStrengthPx: number;
  onMutated: () => Promise<void>;
}): {
  drag: DragState | null;
  setDrag: (s: DragState | null) => void;
  pendingPlacement: PendingLayerPlacement | null;
  pendingLayer: LayerSummary | null;
  dragLayer: LayerSummary | null;
}
```

`trackRows` moves with it or stays in Timeline — keep `trackRows` in Timeline.tsx (the render also needs it) and pass it in. All bodies verbatim; the only edits are `const [x, setX] = useState(...)` plumbing and `opts.` prefixes where captured props became options.

- [ ] **Step 5: Rewire Timeline.tsx**

`Timeline` now reads:

```typescript
const { pxPerSec, trackHeights, setTrackHeights, trackHeightsRef } =
  useTimelineView({ rootRef, tracks, durationUs });
const { heightDrag, beginHeightDrag } = useHeightDrag({ trackHeightsRef, setTrackHeights });
const { drag, setDrag, pendingPlacement, pendingLayer, dragLayer } = useLayerDrag({ ... });
```

After this task `Timeline.tsx` should be roughly: props/selection/shortcuts/seek/blade/context-menu state + render. Sanity-check size: `(Get-Content apps/desktop/src/timeline/Timeline.tsx | Measure-Object -Line).Lines` — expect ≲ 500.

- [ ] **Step 6: Verify + manual smoke**

`npx tsc -b` clean, `npm test` green. Launch `npm run tauri dev` (or the user's running instance) and manually verify: Ctrl+wheel zoom anchors under cursor; drag/move/trim/blade/group-click all behave; track height drag persists across restart.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/timeline/contextMenu.tsx apps/desktop/src/timeline/hooks apps/desktop/src/timeline/Timeline.tsx
git commit -m "refactor(timeline): extract context menu and view/height/drag hooks"
```

---

### Task 6: Two-column layout + `TrackHeader.tsx` (names only)

**Files:**
- Create: `apps/desktop/src/timeline/TrackHeader.tsx`
- Modify: `apps/desktop/src/timeline/Timeline.tsx`, `apps/desktop/src/timeline/TrackLane.tsx`

- [ ] **Step 1: Create `TrackHeader.tsx`**

```tsx
import { useTranslation } from "react-i18next";
import type { TrackSummary } from "../ipc";

/// One sticky header cell per track row. Controls (eye/M/S/lock) land in
/// a later task; this version carries the name + revealed suffix that
/// used to float over the lane. pointerdown must not bubble into the
/// timeline-root seek path.
export function TrackHeader({ track, height, isRevealed }: {
  track: TrackSummary;
  height: number;
  isRevealed: boolean;
}) {
  const { t } = useTranslation();
  const kindLabel = t(`kinds.${track.kind.toLowerCase()}`, { defaultValue: track.kind });
  return (
    <div
      className="flex items-center gap-1.5 border-b border-border-soft px-2"
      style={{ height }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-muted-foreground">
        {track.label ?? kindLabel}
        {isRevealed && <span className="font-medium text-blue-400/70"> (revealed)</span>}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Restructure Timeline.tsx render**

Replace the current root JSX (toolbar stays; inside `timeline-root`) with the two-pane structure. The headers column is sticky-left; the body keeps `canvasRef` so every existing x-coordinate computation (`seekFromClientX`, `splitFromClientX`, drop x, playhead) is untouched:

```tsx
<div
  ref={rootRef}
  className={`timeline-root relative min-h-0 w-full flex-1 overflow-auto bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
    drag ? "cursor-grabbing select-none" : ""
  } ${heightDrag ? "cursor-ns-resize select-none" : ""} ${bladeMode ? "is-blade-mode" : ""}`}
  onClick={() => onSelect(null)}
  onPointerDown={onCanvasPointerDown}
>
  <div className="flex min-w-max">
    {/* sticky header column */}
    <div className="sticky left-0 z-10 w-40 flex-none border-r border-border bg-card">
      <div className="h-5 border-b border-border-soft" /> {/* ruler corner */}
      {orderedTracks.map(({ track }) => (
        <TrackHeader
          key={track.id}
          track={track}
          height={trackHeights[track.id] ?? DEFAULT_TRACK_HEIGHT}
          isRevealed={track.id === (revealedTrackId ?? null)}
        />
      ))}
    </div>
    {/* scrolling body */}
    <div className="relative">
      <TimelineRuler ... />
      <div ref={canvasRef} className="relative min-w-full" style={{ width: Math.max(widthPx, 200) }}>
        {orderedTracks.length === 0 && <EmptyHint mode={displayMode} />}
        {orderedTracks.map(({ track, isGroupStart }) => (
          <TrackLane ... /* unchanged props */ />
        ))}
      </div>
      {currentTimeUs >= 0 && (
        <div
          className="pointer-events-none absolute bottom-0 top-0.5 z-[4] w-0.5 rounded-px bg-gradient-to-b from-red-300 via-red-500 to-red-500 shadow-[0_0_0_0.5px_rgba(0,0,0,0.55),0_0_6px_rgba(239,68,68,0.35)]"
          style={{ left: playheadX }}
        >
          <div className="absolute -left-1.5 top-0 h-3.5 w-3.5 bg-gradient-to-b from-[#fb7185] via-red-500 to-red-700 [clip-path:polygon(0_0,100%_0,100%_45%,50%_100%,0_45%)] [filter:drop-shadow(0_1px_1.5px_rgba(0,0,0,0.6))]" />
        </div>
      )}
    </div>
  </div>
</div>
```

> **Executed-with-fixes note (review findings, landed in `f527cd99`):** the snippet above has two bugs found in code review — the body wrapper needs `className="relative grow"` (without `grow` it sizes to max-content and short projects get no lane stretch + a dead drop zone right of the content), and the ruler-corner spacer needs the same `onPointerDown`/`onClick` stopPropagation as TrackHeader (otherwise clicking it seeks). Also the header column width is pinned via `style={{ width: HEADER_COL_PX }}` instead of `w-40` so the wheel-anchor constant can't diverge from the rendered width.

Behavior notes the implementer must preserve:
- `onCanvasPointerDown` sits on `timeline-root`; TrackHeader's `stopPropagation` keeps header clicks from seeking. Verify clicking a header does NOT move the playhead.
- The playhead now lives inside the body wrapper → `left: playheadX` stays t-relative; when scrolled right it slides UNDER the sticky header (z-10 header > z-[4] playhead). That is the intended NLE look.
- `seekFromClientX`/`splitFromClientX` use `canvasRef.getBoundingClientRect().left` — still correct because `canvasRef` starts after the header column.
- The transitional `timeline-root` class is KEPT on the root through this task so the legacy blade-cursor rule (`.timeline-root.is-blade-mode`, styles.css:989) and scrollbar-hiding keep working until Task 12 deletes the legacy block. Legacy `.timeline-root` background (#0a0c10, unlayered CSS wins over `bg-background`) persists until Task 12 — expected, near-identical color.
- The wheel-zoom scroll re-anchor in `useTimelineView` measures `cursorXInViewport` from the ROOT rect, which now includes the 160 px header. Re-anchoring math is offset-invariant under fixed offsets EXCEPT the header is sticky (doesn't scroll) — so anchor on the body instead: in `useTimelineView`'s wheel handler change `const cursorXInViewport = e.clientX - rect.left;` to `const cursorXInViewport = e.clientX - rect.left - HEADER_COL_PX;` (import `HEADER_COL_PX` from `../geometry`). Verify by zooming with the cursor over a clip edge — the edge must stay put.

- [ ] **Step 3: Remove the floating label from TrackLane**

Delete the `track-label` div (added back in Task 4 step 1) from `TrackLane.tsx` — the header now owns the name. Delete its `kindLabel` computation if unused.

- [ ] **Step 4: Verify + manual smoke**

`npx tsc -b` clean, `npm test` green. Manual: header column stays put on horizontal scroll; vertical scroll moves both; zoom anchor correct; header click doesn't seek; playhead slides under header.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/timeline/TrackHeader.tsx apps/desktop/src/timeline/TrackLane.tsx apps/desktop/src/timeline/Timeline.tsx
git commit -m "feat(timeline): sticky track-header column; playhead and ruler tokens"
```

---

### Task 7: Rust — `Track.muted` / `Track.solo` fields + summaries

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/track.rs`
- Modify: `apps/desktop/src-tauri/src/commands.rs` (TrackSummary)
- Modify: `apps/desktop/src/ipc/index.ts` (TS TrackSummary)

- [ ] **Step 1: Write the failing test**

In `track.rs`'s `#[cfg(test)] mod tests` (create the module if absent, following `state/actor.rs` convention):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Old `.vproj` JSON (written before muted/solo existed) must load
    /// with both flags defaulting to false.
    #[test]
    fn track_deserializes_without_muted_solo() {
        let t = Track::new();
        let mut v = serde_json::to_value(&t).expect("serialize");
        let obj = v.as_object_mut().unwrap();
        obj.remove("muted");
        obj.remove("solo");
        let back: Track = serde_json::from_value(v).expect("deserialize legacy");
        assert!(!back.muted);
        assert!(!back.solo);
    }
}
```

Run (cwd `apps/desktop/src-tauri`): `cargo test track_deserializes_without_muted_solo`
Expected: FAIL — `no field muted on type Track` (compile error).

- [ ] **Step 2: Add the fields**

In the `Track` struct (track.rs:10-41), after `pub locked: bool,`:

```rust
    /// Track-level audio mute (spec: timeline redesign, section 3).
    /// Silences this track's Audio layers in preview AND export; video
    /// output is unaffected. Toggled via the unrecorded
    /// `update_track_flags` path so undo never flips it. Defaults to
    /// `false` for `.vproj` files written before the field existed.
    #[serde(default)]
    pub muted: bool,
    /// Track-level solo. When ANY track has `solo == true`, only solo
    /// tracks are audible; `muted` wins over `solo`. Same unrecorded
    /// toggle path and back-compat default as `muted`.
    #[serde(default)]
    pub solo: bool,
```

Add `muted: false, solo: false,` to `Track::new()`.

- [ ] **Step 3: Extend the summaries**

`commands.rs` `TrackSummary`: add `pub muted: bool,` and `pub solo: bool,` after `locked`, and populate them where `TrackSummary` is constructed (search `TrackSummary {` in commands.rs — copy from `track.muted` / `track.solo` exactly like `enabled`/`locked`).

`ipc/index.ts` `TrackSummary` interface: add after `locked: boolean;`:

```typescript
  /// Track-level audio mute — audio layers silent, video unaffected.
  muted: boolean;
  /// Track-level solo — when any track is soloed, only soloed tracks
  /// are audible (mute wins over solo).
  solo: boolean;
```

Fix the test fixture in `geometry.test.ts` `track()` helper: add `muted: false, solo: false,`.

- [ ] **Step 4: Verify**

`cargo test track_deserializes_without_muted_solo` → PASS. `cargo test` → all green. `npx tsc -b` (cwd `apps/desktop`) → clean. `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/state/track.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src/ipc/index.ts apps/desktop/src/timeline/geometry.test.ts
git commit -m "feat(audio): Track muted/solo fields with back-compat defaults"
```

---

### Task 8: Rust — mixer respects mute/solo (TDD)

**Files:**
- Modify: `apps/desktop/src-tauri/src/audio/mix.rs`

- [ ] **Step 1: Write the failing tests**

In `mix.rs`'s test module (it has one — follow its existing helpers for building a project with audio layers; if a helper builds `Project` + audio track + conform fixture, reuse it; the assertions below are on `plan_for_project(...).layers.len()`):

```rust
#[test]
fn muted_track_is_skipped() {
    let (mut project, track_a, _track_b) = two_audio_tracks_project(); // reuse/adapt existing test scaffolding
    set_track_muted(&mut project, track_a, true);
    let plan = plan_for_project(&project, None).expect("plan");
    assert_eq!(plan.layers.len(), 1, "muted track contributes no layers");
}

#[test]
fn solo_silences_non_solo_tracks() {
    let (mut project, track_a, _track_b) = two_audio_tracks_project();
    set_track_solo(&mut project, track_a, true);
    let plan = plan_for_project(&project, None).expect("plan");
    assert_eq!(plan.layers.len(), 1, "only the soloed track plays");
}

#[test]
fn mute_wins_over_solo() {
    let (mut project, track_a, _track_b) = two_audio_tracks_project();
    set_track_solo(&mut project, track_a, true);
    set_track_muted(&mut project, track_a, true);
    let plan = plan_for_project(&project, None).expect("plan");
    assert_eq!(plan.layers.len(), 0, "muted solo track is silent and silences the rest");
}
```

If `mix.rs` tests have no two-track scaffolding, write `two_audio_tracks_project()` modeled on the closest existing test in the file (two tracks, one enabled Audio layer each with a valid conform fixture path per the existing pattern), plus trivial `set_track_muted`/`set_track_solo` helpers that find the track by id and set the flag.

Run: `cargo test --lib audio::mix` → FAIL (no `muted` skip yet — counts come back wrong / helpers reference missing fields compile-fine since Task 7 added them; the assertions fail).

- [ ] **Step 2: Implement the skips**

In `plan_for_project`, before the track loop:

```rust
    let any_solo = project.tracks.iter().any(|t| t.enabled && t.solo);
```

Inside the loop, immediately after the `if !track.enabled { continue; }` check:

```rust
        // Track-level audio gates (spec: timeline redesign §3). Mute wins
        // over solo; an empty solo set takes the normal path.
        if track.muted {
            continue;
        }
        if any_solo && !track.solo {
            continue;
        }
```

- [ ] **Step 3: Verify + commit**

`cargo test --lib audio::mix` → PASS. `cargo test` → green.

```bash
git add apps/desktop/src-tauri/src/audio/mix.rs
git commit -m "feat(audio): mixer skips muted tracks; solo set gates the rest"
```

---

### Task 9: Rust — unrecorded `update_track_flags` op + IPC + TS binding (TDD)

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` (+ the history struct file it delegates to — find via `replace_settings_everywhere` definition)
- Modify: `apps/desktop/src-tauri/src/commands.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/ipc/index.ts`

- [ ] **Step 1: Read the existing unrecorded mechanism**

Read `do_update_project_settings` (actor.rs ~2928) and the definition of `History::replace_settings_everywhere` (grep `fn replace_settings_everywhere` — it lives with the history ring). The new op mirrors this pair exactly, but patches one track's flags instead of settings.

- [ ] **Step 2: Write the failing test**

In actor.rs's test module, modeled on `update_project_settings_is_unrecorded_and_patches_history` (actor.rs ~4500):

```rust
#[tokio::test]
async fn update_track_flags_is_unrecorded_and_patches_history() {
    let h = spawn(Project::new_blank("test"));
    // grab an existing reserved track id
    let snap = h.snapshot().await;
    let track_id = snap.tracks.front().expect("blank project has tracks").id;
    // a recorded op AFTER which we'll toggle, so undo has something to rewind
    let added = h.add_track(Actor::User, Some("overlay".into())).await.expect("add_track");
    h.update_track_flags(
        Actor::User,
        track_id,
        TrackFlagsPatch { enabled: None, muted: Some(true), solo: Some(true), locked: Some(true) },
    )
    .await
    .expect("update_track_flags");
    let snap = h.snapshot().await;
    let t = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
    assert!(t.muted && t.solo && t.locked);
    // Undo rewinds add_track, NOT the flags toggle; flags survive.
    h.undo(Actor::User).await.expect("undo");
    let snap = h.snapshot().await;
    assert!(snap.tracks.iter().all(|t| t.id != added), "undo rewound add_track");
    let t = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
    assert!(t.muted && t.solo && t.locked, "flags survive undo (patched into every snapshot)");
}
```

(If `add_track` returns `()` rather than the new id in this codebase, adapt: snapshot before/after to find the added id. Check the existing settings test for the exact `spawn`/`add_track` signatures and copy them.)

Run: `cargo test update_track_flags_is_unrecorded` → FAIL (compile: no `TrackFlagsPatch`).

- [ ] **Step 3: Implement**

a. Patch struct (next to `ProjectSettingsPatch`):

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct TrackFlagsPatch {
    pub enabled: Option<bool>,
    pub muted: Option<bool>,
    pub solo: Option<bool>,
    pub locked: Option<bool>,
}
```

b. History method, sibling of `replace_settings_everywhere` (same file, same iteration over the snapshot ring; mirror its body — only the patched field differs). Tracks absent from older snapshots are skipped:

```rust
    /// Patch one track's preference-shaped flags into EVERY history
    /// snapshot so undo/redo never flips them (same contract as
    /// `replace_settings_everywhere`). Snapshots from before the track
    /// existed are left alone.
    pub fn replace_track_flags_everywhere(&mut self, track_id: TrackId, patch: &TrackFlagsPatch) {
        // iterate exactly like replace_settings_everywhere over all stored
        // Arc<Project> snapshots; for each:
        //   let mut p = (**snapshot).clone();
        //   if let Some(t) = p.tracks.iter_mut().find(|t| t.id == track_id) {
        //       if let Some(v) = patch.enabled { t.enabled = v; }
        //       if let Some(v) = patch.muted   { t.muted = v; }
        //       if let Some(v) = patch.solo    { t.solo = v; }
        //       if let Some(v) = patch.locked  { t.locked = v; }
        //       *snapshot = Arc::new(p);
        //   }
    }
```

(The comment block is the exact logic; the iteration wrapper comes from the sibling method — copy it.)

c. Actor: `Command::UpdateTrackFlags { id, patch, actor, reply }` variant + match arm + handler:

```rust
fn do_update_track_flags(
    &mut self,
    id: TrackId,
    patch: TrackFlagsPatch,
    actor: Actor,
) -> Result<(), CommandError> {
    if !self.history.current().tracks.iter().any(|t| t.id == id) {
        return Err(CommandError::NotFound(format!("track {id}")));
    }
    self.history.replace_track_flags_everywhere(id, &patch);
    let snapshot = self.history.current();
    self.broadcast_unrecorded(actor, format!("Updated track flags {id}"), snapshot);
    Ok(())
}
```

(`CommandError::NotFound` — use whatever not-found variant `do_update_layer` uses for a missing id; check and match.)

d. `ProjectHandle::update_track_flags` — mirror `update_layer`'s oneshot pattern verbatim with the new Command variant.

e. Tauri command in commands.rs:

```rust
#[tauri::command]
pub async fn update_track_flags(
    handle: State<'_, ProjectHandle>,
    track_id: String,
    patch: TrackFlagsPatch,
) -> Result<(), String> {
    let id = Uuid::parse_str(&track_id).map_err(|e| format!("track_id: {e}"))?;
    handle
        .update_track_flags(Actor::User, id, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}
```

f. Register `commands::update_track_flags,` in lib.rs `invoke_handler` list.

g. TS binding in `ipc/index.ts` next to `updateLayer`:

```typescript
export interface TrackFlagsPatch {
  enabled?: boolean;
  muted?: boolean;
  solo?: boolean;
  locked?: boolean;
}

/// Unrecorded toggle path (spec §3): eye/M/S/lock changes never enter
/// undo history; the actor patches every history snapshot instead.
export async function updateTrackFlags(trackId: string, patch: TrackFlagsPatch): Promise<void> {
  return invoke<void>("update_track_flags", { trackId, patch });
}
```

- [ ] **Step 4: Verify + commit**

`cargo test update_track_flags_is_unrecorded` → PASS. `cargo test` → green. `npx tsc -b` → clean.

```bash
git add apps/desktop/src-tauri/src/state apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/ipc/index.ts
git commit -m "feat(timeline): unrecorded update_track_flags op end-to-end"
```

---

### Task 10: Rust — locked-track edits rejected by the actor (TDD)

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` (or the ops module where `apply_move_layer` lives)

- [ ] **Step 1: Check current behavior, write the failing test**

`Track.locked` exists, but verify the structural ops enforce it. Test in actor.rs tests:

```rust
#[tokio::test]
async fn locked_track_rejects_layer_mutations() {
    let h = spawn(Project::new_blank("test"));
    // add a color layer to the first track (reuse the existing test
    // helper the actor tests use for layer creation — grep `add_demo`
    // or the cheapest add_*_layer in the test module)
    let snap = h.snapshot().await;
    let track_id = snap.tracks.front().unwrap().id;
    let layer_id = add_test_layer(&h, track_id).await;
    h.update_track_flags(
        Actor::User, track_id,
        TrackFlagsPatch { enabled: None, muted: None, solo: None, locked: Some(true) },
    ).await.expect("lock track");
    let err = h.move_layer(Actor::User, layer_id, track_id, 1_000_000, false).await;
    assert!(err.is_err(), "move on locked track must be rejected");
    let err = h.trim_layer(Actor::User, layer_id, TrimEdge::In, 100_000, false).await;
    assert!(err.is_err(), "trim on locked track must be rejected");
}
```

(Adapt helper/signature names to the actual test module — `move_layer`/`trim_layer` handle methods exist; check their exact parameter shapes in actor.rs and mirror an existing move/trim test.)

Run: `cargo test locked_track_rejects` → may already PASS (layer-level lock fanout might cover it) or FAIL.

- [ ] **Step 2: If it fails, add the guard**

In `do_move_layer` / `do_trim_layer` / `do_split_layer` (and the grouped variants if they don't funnel through these), before mutating: look up the layer's owning track in `self.history.current()`; if `track.locked`, return the same error variant used for locked layers (grep `locked` in actor.rs for the existing rejection message style, e.g. the group locked-member rejection). Keep the message shape consistent: `format!("track {id} is locked")`.

- [ ] **Step 3: Verify + commit**

`cargo test locked_track_rejects` → PASS. `cargo test` → green.

```bash
git add apps/desktop/src-tauri/src/state/actor.rs
git commit -m "feat(timeline): actor rejects layer mutations on locked tracks"
```

---

### Task 11: TrackHeader controls UI (eye / M / S / lock) + lane feedback

**Files:**
- Modify: `apps/desktop/src/timeline/TrackHeader.tsx`
- Modify: `apps/desktop/src/timeline/TrackLane.tsx`, `apps/desktop/src/timeline/LayerBlock.tsx`, `apps/desktop/src/timeline/Timeline.tsx`
- Modify: `apps/desktop/src/locales/en-US/translation.json`, `apps/desktop/src/locales/zh-CN/translation.json` (paths per the i18n setup — confirm with a grep for an existing `timeline.` key)

- [ ] **Step 1: Full TrackHeader with controls**

```tsx
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Lock, LockOpen } from "lucide-react";
import { updateTrackFlags, type TrackSummary } from "../ipc";

function FlagButton({ active, activeClass, label, onToggle, children }: {
  active: boolean;
  activeClass: string;
  label: string;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onToggle}
      className={`inline-flex size-[18px] items-center justify-center rounded-[4px] text-[9px] font-semibold transition-colors ${
        active ? activeClass : "text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export function TrackHeader({ track, height, isRevealed, onMutated }: {
  track: TrackSummary;
  height: number;
  isRevealed: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const kindLabel = t(`kinds.${track.kind.toLowerCase()}`, { defaultValue: track.kind });
  const toggle = (patch: Parameters<typeof updateTrackFlags>[1]) => async () => {
    try {
      await updateTrackFlags(track.id, patch);
      await onMutated();
    } catch (err) {
      console.error("update_track_flags failed:", err);
    }
  };
  return (
    <div
      className="flex items-center gap-1 border-b border-border-soft px-1.5"
      style={{ height }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-muted-foreground">
        {track.label ?? kindLabel}
        {isRevealed && <span className="font-medium text-blue-400/70"> (revealed)</span>}
      </span>
      <FlagButton
        active={!track.enabled}
        activeClass="bg-secondary text-foreground"
        label={t("timeline.track_eye_hint", { defaultValue: "Hide this track's output (affects export)" })}
        onToggle={toggle({ enabled: !track.enabled })}
      >
        {track.enabled ? <Eye size={11} aria-hidden /> : <EyeOff size={11} aria-hidden />}
      </FlagButton>
      <FlagButton
        active={track.muted}
        activeClass="bg-red-500/20 text-red-300"
        label={t("timeline.track_mute_hint", { defaultValue: "Mute this track's audio (affects export)" })}
        onToggle={toggle({ muted: !track.muted })}
      >
        M
      </FlagButton>
      <FlagButton
        active={track.solo}
        activeClass="bg-amber-500/25 text-amber-300"
        label={t("timeline.track_solo_hint", { defaultValue: "Solo this track's audio (affects export)" })}
        onToggle={toggle({ solo: !track.solo })}
      >
        S
      </FlagButton>
      <FlagButton
        active={track.locked}
        activeClass="bg-secondary text-foreground"
        label={t("timeline.track_lock_hint", { defaultValue: "Lock this track against edits" })}
        onToggle={toggle({ locked: !track.locked })}
      >
        {track.locked ? <Lock size={11} aria-hidden /> : <LockOpen size={11} aria-hidden />}
      </FlagButton>
    </div>
  );
}
```

Timeline.tsx passes `onMutated={onMutated}` to each `TrackHeader`.

- [ ] **Step 2: Lane feedback for eye-off + locked track**

`TrackLane.tsx`: wrap the rendered layers (the `renderedLayers.map(...)` IIFE output) in:

```tsx
<div className={track.enabled ? "contents" : "pointer-events-none opacity-40"}>
  {/* existing slices IIFE */}
</div>
```

(`contents` keeps the enabled case layout-transparent; the disabled case dims and de-interactivizes the whole lane content. Absolute-positioned children keep their containing block because the wrapper div is not positioned — verify visually.)

`LayerBlock.tsx`: add a `trackLocked: boolean` prop (TrackLane passes `track.locked`). Update the three guards:
- `onLayerPointerDown`: `if (e.button !== 0 || layer.locked || trackLocked) return;`
- `onPointerMoveHover`: add `trackLocked` to the early-return condition alongside `layer.locked`
- locked styling: `(layer.locked || trackLocked)` drives the `cursor-not-allowed outline-dashed` classes
- the inline `cursor: ew-resize` condition: add `&& !trackLocked`

Blade: `onLayerPointerDown` returns before `onBladeSplit` when `trackLocked` (covered by the first guard since blade routes through pointerdown).

- [ ] **Step 2.5: Preview-side M/S gating (review finding — the spec assumed mix.rs served preview, it does NOT)**

Preview audio is mixed TS-side: `render/Compositor.ts` `compositeFrame`'s audio pass iterates tracks (~line 653) with only `!track.enabled` / `!layer.enabled` skips, then per-layer WebAudio mixers. Mirror the `audio/mix.rs` gates there so M/S affect playback, not just export:

```typescript
// before the track loop (once per compositeFrame):
// Track-level audio gates — mirror audio/mix.rs plan_for_project semantics:
// mute wins over solo; only ENABLED tracks' solo flags count.
const anySolo = this.projectSummary.tracks.some((t) => t.enabled && t.solo);
// inside the loop, right after the `!track.enabled` skip:
if (track.muted) continue;
if (anySolo && !track.solo) continue;
```

Verify the existing teardown path handles "track became inaudible mid-playback" (mixers for layers that drop out of the collection set should already be stopped/cleaned the way disabling a layer does — check how `ensureAudio` mixers are reaped and confirm gated tracks go silent promptly, not just stop scheduling new chunks).

- [ ] **Step 3: i18n keys**

Add to both locale files under the existing `timeline` object (grep `"timeline"` to find it): `track_eye_hint`, `track_mute_hint`, `track_solo_hint`, `track_lock_hint`. zh-CN values: `"隐藏此轨道的输出（影响导出）"`, `"静音此轨道的音频（影响导出）"`, `"独奏此轨道的音频（影响导出）"`, `"锁定此轨道禁止编辑"`.

- [ ] **Step 4: Verify + manual smoke**

`npx tsc -b` clean, `npm test` green. Manual in the running app: toggle each button — eye dims the lane + kills preview video/audio for that track; M silences audio only; S with two audio tracks silences the other; lock blocks drag/trim/blade on the lane; undo (Ctrl+Z) after toggling NEVER flips a flag back; flags survive app restart (project file).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/timeline apps/desktop/src/locales
git commit -m "feat(timeline): eye/mute/solo/lock track-header controls"
```

---

### Task 12: Toolbar/pill/empty/blade sweep + delete legacy timeline CSS

**Files:**
- Modify: `apps/desktop/src/timeline/Timeline.tsx`
- Modify: `apps/desktop/src/styles.css`

- [ ] **Step 1: Translate the stragglers in Timeline.tsx**

Toolbar (replaces `.timeline-toolbar`):

```tsx
<div className="flex flex-none items-center gap-2 border-b border-border-soft bg-black/20 px-2 py-1 text-[11px]">
```

`DisplayModePill` (replaces `.timeline-mode-pill` + `.is-ab`):

```tsx
className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-[3px] text-[11px] font-semibold tracking-wide transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
  mode === "AbRoll"
    ? "border-blue-400/50 bg-blue-950 text-blue-100"
    : "border-border bg-secondary text-foreground hover:bg-accent"
}`}
```

`EmptyHint` (replaces `.timeline-empty`): `className="p-6 text-center text-xs text-muted-foreground"`.

Blade cursor: the `is-blade-mode` class on the root is still referenced by the CSS rule with the SVG cursor (styles.css:989-992). Keep exactly that one rule in styles.css (an arbitrary-variant Tailwind class for a data-URI SVG cursor is unreadable); move it OUT of the deleted block into a small clearly-labeled remnant:

```css
/* Timeline blade-tool cursor. The only legacy timeline rule that
   survives the Tailwind migration — a data-URI SVG cursor is kept as
   CSS for readability. `.timeline-layer` is a bare JS/test hook class
   with no other styles. */
.timeline-root-blade,
.timeline-root-blade .timeline-layer { cursor: url("...exact existing data-URI...") 4 18, crosshair; }
```

Rename the class in Timeline.tsx root from `is-blade-mode` to `timeline-root-blade`, and remove the transitional `timeline-root` class from the root in the same edit (its legacy rules die with the deleted block; all its styles are already covered by the Tailwind classes from Task 6).

> **Accumulated review notes for this task:** (a) migrate the `overflow: hidden` rationale comment (styles.css ~926-933, phantom-scrollWidth clip) and the 20px-height↔playhead-knob coupling note (~913-916) into `TimelineRuler.tsx` before deleting them; fix the stale `.timeline-ruler` mention in the comment at ~907. (b) The deletion list explicitly includes the now-dead `.timeline-canvas`, `.timeline-playhead`/`.playhead-knob`, `.timeline-root.is-dragging`, `.timeline-root.is-resizing-track`, `.track-resize-handle`, and `.drop-indicator` blocks. (c) While in TrackLane: make the drop-target/revealed background conditionals mutually exclusive (`isCrossTrackTarget ? … : isRevealed ? … : ""`) so precedence stops depending on Tailwind's alphabetical emit order. (d) After deletion, re-verify the selected+locked outline interplay on LayerBlock (legacy rules gone → Tailwind emit order decides). (e) Optionally hoist TimelineRuler's tuning consts to module scope.

- [ ] **Step 2: Delete the legacy timeline block from styles.css**

Delete: lines 830–1129 region (`.timeline-toolbar` through `.timeline-root.is-resizing-track`, including `.timeline-track-lane.*`, `.track-label`, `.timeline-layer.*`, `.layer-label`, `.track-resize-handle`, `.ruler-*`, `.timeline-ruler`, `.timeline-root*`, `.timeline-canvas`, `.timeline-empty`, `.timeline-mode-pill*`, `.drop-indicator` at 1684–1692, `.timeline-playhead`/`.playhead-knob` at 1483–1525). KEEP: `.timeline` (822–828) + `.timeline { grid-area: timeline; }` (560) — App-level section wrapper; `.mini-timeline*`; `.motif-bake-dot*`; the new blade-cursor remnant.

- [ ] **Step 3: Prove zero dangling references**

Run (repo root): `rg -n "timeline-toolbar|timeline-mode-pill|timeline-ruler|ruler-tick|ruler-label|timeline-canvas|timeline-empty|timeline-track-lane|track-label|drop-indicator|track-resize-handle|timeline-playhead|playhead-knob|is-blade-mode|is-drop-target|is-revealed|slice-top|slice-bottom|is-ghost|layer-label" apps/desktop/src --type-add 'web:*.{ts,tsx,css}' -t web`

Expected: zero hits outside `MiniTimeline.tsx`'s own `mini-*` classes and this plan/spec docs. Any hit in `src/**` code = a missed translation; fix it.

- [ ] **Step 4: Verify + visual smoke**

`npx tsc -b` clean, `npm test` green, `npm run build` (vite) succeeds. Manual: full visual pass — neutral lanes, clip gradients, ruler, playhead, pill, blade cursor still razor-shaped, drop indicator on media drag, revealed-track chrome, resize handle hover.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/timeline/Timeline.tsx apps/desktop/src/styles.css
git commit -m "refactor(timeline): finish Tailwind migration; delete legacy timeline CSS block"
```

---

### Task 13: Full verification sweep

- [ ] **Step 1: Automated gates**

- `apps/desktop`: `npm test` → green; `npx tsc -b` → clean; `npm run build` → succeeds.
- `apps/desktop/src-tauri`: `cargo test` → green.

- [ ] **Step 2: Manual interaction checklist (real app, `npm run tauri dev`)**

Zero-behavior-change items: drag-move (same track + cross-track), trim both edges, blade split + Esc exit, group click semantics (plain / Alt / Shift), Ctrl+G / Ctrl+Shift+G, snap-to-clip-boundary + playhead snap, Ctrl+wheel zoom anchored under cursor, track-height drag + persistence, media drag-drop at cursor position, context menu (separate audio / pre-bake), A/B ↔ All pill, revealed-track flow, empty-state hints.
New-behavior items: header column sticky on horizontal scroll; header click doesn't seek; eye/M/S/lock per Task 11's checklist; undo never flips a flag.

- [ ] **Step 3: Existing e2e suites (real WebView2)**

Run the export/audio e2e suites per `docs/conformance.md` (wdio harness; msedgedriver must match WebView2 — see harness README). Expected: same pass rate as before this branch. The timeline refactor must not touch them — any new failure is a regression to fix before merge.

- [ ] **Step 3.5: Phase-1 deferred follow-ups (recorded by the final review — for later phases/sessions, NOT this branch)**

- **Per-layer `Layer.locked` delete/param-edit gap (pre-existing):** the actor's new locked-TRACK guards cover move/trim/split/delete/update_layer/update_layer_params, but a locked LAYER on an unlocked track can still be deleted / param-edited. A blanket layer-lock rejection in `apply_update_layer` would make a locked layer un-unlockable (update_layer is also the unlock path) — needs a deliberate design (e.g. allow `locked`-field-only patches through).
- **Preview locked-layer audio divergence:** export drops locked layers' audio (mix.rs), preview plays them — recorded in `docs/audio.md` skip-rule 7; resolving it (probably by removing the export-side locked skip) is a behavior decision.
- **Dead Phase-0 CSS:** `.timeline-grid` / `.timeline-track` (styles.css ~431/439) have zero consumers; candidate for a general dead-CSS pass.
- **`timeline/types.ts` consolidation:** drag types live in LayerBlock.tsx, media-drag contract in TrackLane.tsx with the producer in App.tsx (now sharing `MEDIA_DRAG_TYPE`); a neutral `timeline/dnd.ts` + `makeMediaDrag` serializer would lock the payload shape in one place.
- **V.10 stub inlining:** `trackAcceptsMedia`/`trackAcceptsMediaForAutoRoute` (Timeline.tsx) and `trackAcceptsForLayer` (useLayerDrag.ts) are always-constant stubs awaiting the promised inline-away cleanup.
- **`formatRulerLabel` centisecond carry bug (pre-existing, unreachable from the ruler):** `formatRulerLabel(1.999, 0.5)` → `"0:01.100"` (cs rounds to 100 without carrying into seconds).
- **UX polish ideas from reviews:** per-handle resize highlight (`heightDrag?.trackId === track.id`); locked-layer right-click could offer "Unlock track"; optimistic flag-button UI; eye-off currently freezes interaction (`pointer-events-none`) beyond the spec's 40%-dim — deliberate v1, revisit if users want to edit hidden tracks.

- [ ] **Step 4: Update docs**

`docs/` is evergreen (no phase numbers / dates in design docs): if any doc describes the old timeline layout (grep `docs/` for "track label" / timeline structure mentions — likely `docs/data-model.md` R.5b ruler/toolbar notes), update the description to the two-column layout + track-header controls. Commit doc changes separately:

```bash
git add docs
git commit -m "docs: timeline layout reflects header column + track controls"
```
