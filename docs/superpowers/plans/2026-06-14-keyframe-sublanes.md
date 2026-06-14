# Keyframe Sub-Lanes (Phase 3, v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Twirl a track open to show one sub-lane per keyframed property, with that property's keyframes as absolute-positioned diamonds (out-of-range dimmed) and single-selection editing (click-seek / drag-retime / Delete / interp menu).

**Architecture:** Frontend + view-state only (the keyframe write path shipped in Phase 2). Selection moves into a new `keyframeSelectionStore` (zustand, atomic selectors) that is the single source of truth for keyframe selection — it replaces `LayerBlock`'s local `selectedKfId`, so collapsed and expanded diamonds share it. Expansion is persisted in `view.json` via `useTimelineView` (mirrors `track_heights`). Sub-lanes render in BOTH timeline columns (labels in the sticky header column, diamonds in the scrolling body) so the two columns stay row-aligned.

**Tech Stack:** React 19 + TS (zustand atomic selectors per `feedback_zustand_composite_selector`), Rust serde (view-state), vitest, `tsc -b`, wdio e2e. Reuses Phase 2: `keyframe/{edits,descriptors,focusStore}.ts`, `KeyframeInterpMenu`, `update_layer_param_track`, `timeline/geometry.ts`.

**Spec:** `docs/superpowers/specs/2026-06-14-keyframe-sublanes-design.md`

**Conventions for every task:** run frontend commands from `apps/desktop/`; Rust from `apps/desktop/src-tauri/`. Stage by explicit path (the checkout is shared). **Always run `npx tsc -b` (not just vitest) — vitest transpiles without full type-checking.** End commit messages with the repo's `Co-Authored-By` trailer.

---

## File Structure

- `apps/desktop/src-tauri/src/view_state.rs` — **modify.** Add `expanded_tracks` to `ViewState`.
- `apps/desktop/src/ipc/index.ts` — **modify.** Add `expanded_tracks` to the TS `ViewState` interface.
- `apps/desktop/src/timeline/hooks/useTimelineView.ts` — **modify.** Manage `expandedTracks` + `toggleExpanded` (load/save/prune).
- `apps/desktop/src/keyframe/selectionStore.ts` — **create.** zustand single-selection store.
- `apps/desktop/src/keyframe/selectionStore.test.ts` — **create.**
- `apps/desktop/src/timeline/geometry.ts` (+ `.test.ts`) — **modify.** `keyframeAbsoluteX` + `trackKeyframeProperties`.
- `apps/desktop/src/timeline/LayerBlock.tsx` — **modify.** Selection → store; skip collapsed diamonds when the track is expanded.
- `apps/desktop/src/timeline/TrackHeader.tsx` — **modify.** Twirl toggle.
- `apps/desktop/src/timeline/KeyframeLane.tsx` — **create.** Body diamond rows + header label rows (two exports).
- `apps/desktop/src/timeline/Timeline.tsx` — **modify.** Render sub-lanes in both loops; thread expansion.
- `apps/desktop/src/styles.css` — **modify.** Sub-lane styles.
- `apps/desktop/e2e/specs/keyframe_sublanes.e2e.js` — **create.**

---

### Task 1: Rust view-state — `expanded_tracks`

**Files:** Modify `apps/desktop/src-tauri/src/view_state.rs`

- [ ] **Step 1: Add a failing test** — append to `mod tests`:
```rust
    #[test]
    fn expanded_tracks_round_trip_and_default() {
        let tmp = TempDir::new().unwrap();
        // missing field defaults to empty
        fs::write(tmp.path().join(VIEW_FILE), "{}").unwrap();
        assert!(load(tmp.path()).expanded_tracks.is_empty());
        // round-trips
        let mut s = ViewState::default();
        s.expanded_tracks = vec!["t1".into(), "t2".into()];
        save(tmp.path(), &s).unwrap();
        assert_eq!(load(tmp.path()).expanded_tracks, vec!["t1".to_string(), "t2".to_string()]);
    }
```
- [ ] **Step 2: Run → FAIL** `cd apps/desktop/src-tauri && cargo test --lib view_state 2>&1 | tail -15` (no field `expanded_tracks`).
- [ ] **Step 3: Implement** — in the `ViewState` struct (after `track_heights`):
```rust
    /// Track ids (UUID strings) whose keyframe sub-lanes are expanded.
    /// Absent / unknown ids are treated as collapsed.
    #[serde(default)]
    pub expanded_tracks: Vec<String>,
```
and in `impl Default for ViewState`, add `expanded_tracks: Vec::new(),`.
- [ ] **Step 4: Run → PASS** `cargo test --lib view_state 2>&1 | tail -10`.
- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src-tauri/src/state/../view_state.rs
git commit -m "feat(view-state): persist expanded_tracks for keyframe sub-lanes"
```
(the path is `apps/desktop/src-tauri/src/view_state.rs` — stage that exact path)

---

### Task 2: TS view-state + `useTimelineView` expansion

**Files:** Modify `apps/desktop/src/ipc/index.ts`, `apps/desktop/src/timeline/hooks/useTimelineView.ts`

No unit test (hook + IPC type); verified by `tsc -b` + Task 6/7 live smoke.

- [ ] **Step 1: Extend the TS `ViewState`** — in `ipc/index.ts`, the `ViewState` interface (currently `timeline_px_per_sec` + `track_heights`):
```ts
export interface ViewState {
  timeline_px_per_sec: number;
  track_heights: Record<string, number>;
  expanded_tracks: string[];
}
```
- [ ] **Step 2: Manage it in `useTimelineView`.** In `hooks/useTimelineView.ts`:
  - Add state + ref: `const [expandedTracks, setExpandedTracks] = useState<Set<string>>(new Set());` and `const expandedTracksRef = useRef(expandedTracks);` with an effect `useEffect(() => { expandedTracksRef.current = expandedTracks; }, [expandedTracks]);`.
  - In the load `.then((state) => { ... })`, add: `setExpandedTracks(new Set(state.expanded_tracks ?? []));`.
  - In the debounced save, add expanded_tracks pruned to live ids (alongside the existing `pruned` heights):
```ts
      const liveExpanded = [...expandedTracksRef.current].filter((id) => live.has(id));
      viewStateSet({
        timeline_px_per_sec: pxPerSecRef.current,
        track_heights: pruned,
        expanded_tracks: liveExpanded,
      }).catch((e) => console.warn("view_state save failed:", e));
```
  - Add `expandedTracks` to the save effect's dep array: `}, [pxPerSec, trackHeights, expandedTracks, tracks]);`.
  - Add a toggle helper: `const toggleExpanded = useCallback((id: string) => setExpandedTracks((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; }), []);` (import `useCallback`).
  - Extend the return type + value: add `expandedTracks: Set<string>; toggleExpanded: (id: string) => void;`.
- [ ] **Step 3: Verify** `cd apps/desktop && npx tsc -b; echo tsc=$?` (0).
- [ ] **Step 4: Commit**
```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/timeline/hooks/useTimelineView.ts
git commit -m "feat(timeline): expanded_tracks view-state in useTimelineView"
```

---

### Task 3: `keyframeSelectionStore` (zustand, single-select, atomic) — TDD

**Files:** Create `apps/desktop/src/keyframe/selectionStore.ts` + `selectionStore.test.ts`

- [ ] **Step 1: Failing test** — `selectionStore.test.ts`:
```ts
import { describe, expect, it, beforeEach } from "vitest";
import {
  selectKeyframe, clearKeyframeSelection, getSelectedKeyframe,
  useKeyframeSelectionStore,
} from "./selectionStore";

beforeEach(() => clearKeyframeSelection());

describe("keyframeSelectionStore", () => {
  it("selects and reads back a key", () => {
    selectKeyframe({ layerId: "L", paramKey: "opacity", kfId: "k1" });
    expect(getSelectedKeyframe()).toEqual({ layerId: "L", paramKey: "opacity", kfId: "k1" });
  });
  it("clear() empties the selection", () => {
    selectKeyframe({ layerId: "L", paramKey: "x", kfId: "k1" });
    clearKeyframeSelection();
    expect(getSelectedKeyframe()).toBeNull();
  });
  it("isSelected matches only the exact (layer,param,kf) triple", () => {
    selectKeyframe({ layerId: "L", paramKey: "x", kfId: "k1" });
    const sel = useKeyframeSelectionStore.getState().selected;
    const eq = (a: typeof sel, layerId: string, paramKey: string, kfId: string) =>
      !!a && a.layerId === layerId && a.paramKey === paramKey && a.kfId === kfId;
    expect(eq(sel, "L", "x", "k1")).toBe(true);
    expect(eq(sel, "L", "x", "k2")).toBe(false);
    expect(eq(sel, "L", "y", "k1")).toBe(false);
  });
});
```
- [ ] **Step 2: Run → FAIL** `cd apps/desktop && npx vitest run src/keyframe/selectionStore.test.ts`.
- [ ] **Step 3: Implement** — `selectionStore.ts`:
```ts
// Single source of truth for keyframe SELECTION (collapsed + expanded
// diamonds share it). Transient — not persisted, not undo. Atomic selectors
// only (per feedback_zustand_composite_selector). v1 is single-selection; the
// inner value widens to a Set in the multi-select fast-follow without changing
// `useIsKeyframeSelected` or its call sites.
import { create } from "zustand";

export interface SelectedKeyframe {
  layerId: string;
  paramKey: string;
  kfId: string;
}

interface State {
  selected: SelectedKeyframe | null;
}

export const useKeyframeSelectionStore = create<State>(() => ({ selected: null }));

export function selectKeyframe(key: SelectedKeyframe): void {
  useKeyframeSelectionStore.setState({ selected: key });
}

export function clearKeyframeSelection(): void {
  useKeyframeSelectionStore.setState({ selected: null });
}

export function getSelectedKeyframe(): SelectedKeyframe | null {
  return useKeyframeSelectionStore.getState().selected;
}

/// Atomic boolean selector — a diamond subscribes only to its own
/// selected-ness, so only the previously- and newly-selected diamonds
/// re-render on a selection change.
export function useIsKeyframeSelected(
  layerId: string,
  paramKey: string,
  kfId: string,
): boolean {
  return useKeyframeSelectionStore(
    (s) =>
      s.selected !== null &&
      s.selected.layerId === layerId &&
      s.selected.paramKey === paramKey &&
      s.selected.kfId === kfId,
  );
}
```
- [ ] **Step 4: Run → PASS** `npx vitest run src/keyframe/selectionStore.test.ts` + `npx tsc -b; echo tsc=$?`.
- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/keyframe/selectionStore.ts apps/desktop/src/keyframe/selectionStore.test.ts
git commit -m "feat(keyframe): single-source keyframe selection store (atomic)"
```

---

### Task 4: geometry — `keyframeAbsoluteX` + `trackKeyframeProperties` — TDD

**Files:** Modify `apps/desktop/src/timeline/geometry.ts` + `geometry.test.ts`

- [ ] **Step 1: Failing tests** — append to `geometry.test.ts` (add the two names to the `./geometry` import):
```ts
describe("keyframeAbsoluteX", () => {
  it("maps t_start+t_us to absolute px", () => {
    // 50px/s: a key at t_us=2s on a clip starting at 1s → (1+2)s*50 = 150
    expect(keyframeAbsoluteX(1_000_000, 2_000_000, 50)).toBe(150);
  });
  it("handles out-of-range (negative) t_us", () => {
    expect(keyframeAbsoluteX(1_000_000, -2_000_000, 50)).toBe(-50);
  });
});

describe("trackKeyframeProperties", () => {
  const kfTrack = { mode: "Keyframed" as const, value: [{ id: "k", t_us: 0, value: 1, interp: { kind: "Linear" as const } }] };
  const staticTrack = { mode: "Static" as const, value: 1 };
  it("returns the union of keyframed params across the track's layers, in descriptor order", () => {
    const track = {
      kind: "Video", layers: [
        { id: "a", kind: "VideoClip", params: { kind: "VideoClip", x: kfTrack, opacity: staticTrack } },
        { id: "b", kind: "VideoClip", params: { kind: "VideoClip", opacity: kfTrack } },
      ],
    } as unknown as import("../ipc").TrackSummary;
    expect(trackKeyframeProperties(track).map((d) => d.paramKey)).toEqual(["x", "opacity"]);
  });
  it("returns empty when no layer has a keyframed param", () => {
    const track = { kind: "Video", layers: [{ id: "a", kind: "VideoClip", params: { kind: "VideoClip", opacity: staticTrack } }] } as unknown as import("../ipc").TrackSummary;
    expect(trackKeyframeProperties(track)).toEqual([]);
  });
});
```
- [ ] **Step 2: Run → FAIL** `npx vitest run src/timeline/geometry.test.ts`.
- [ ] **Step 3: Implement** — append to `geometry.ts` (import the descriptor helpers at the top: `import { animatableParams, readParamTrack, type ParamDescriptor } from "../keyframe/descriptors";` and `import type { TrackSummary } from "../ipc";` if not already):
```ts
/// Absolute x (px) of a keyframe on the timeline ruler: the clip start plus
/// the layer-local keyframe time, scaled by zoom. Used by the expanded
/// sub-lanes (which span the whole track, not one clip).
export function keyframeAbsoluteX(
  layerTStartUs: number,
  kfTUs: number,
  pxPerSec: number,
): number {
  return ((layerTStartUs + kfTUs) / 1_000_000) * pxPerSec;
}

/// The keyframed-property union across a track's layers, in descriptor order
/// — one entry per property that at least one layer animates (Keyframed).
/// Drives the expanded sub-lane rows.
export function trackKeyframeProperties(track: TrackSummary): ParamDescriptor[] {
  const out: ParamDescriptor[] = [];
  // Stable, de-duped, descriptor-ordered: walk each layer's animatable params;
  // include a param the first time any layer has it Keyframed.
  const seen = new Set<string>();
  for (const layer of track.layers) {
    for (const desc of animatableParams(layer.kind)) {
      if (seen.has(desc.paramKey)) continue;
      const t = readParamTrack(layer.params, desc.paramKey);
      if (t && t.mode === "Keyframed") {
        seen.add(desc.paramKey);
      }
    }
  }
  // Emit in a stable global order (x,y,scale_x,scale_y,opacity,gain_db,pan)
  // rather than first-seen order: collect from the canonical descriptor lists.
  const ORDER = ["x", "y", "scale_x", "scale_y", "rotation_deg", "opacity", "gain_db", "pan"];
  for (const key of ORDER) {
    if (!seen.has(key)) continue;
    // find the descriptor (label/fallback) from whichever kind defines it
    for (const layer of track.layers) {
      const d = animatableParams(layer.kind).find((x) => x.paramKey === key);
      if (d) { out.push(d); break; }
    }
  }
  return out;
}
```
- [ ] **Step 4: Run → PASS** `npx vitest run src/timeline/geometry.test.ts` + `npx tsc -b; echo tsc=$?`.
- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/timeline/geometry.ts apps/desktop/src/timeline/geometry.test.ts
git commit -m "feat(timeline): keyframeAbsoluteX + trackKeyframeProperties helpers"
```

---

### Task 5: LayerBlock — selection via the store + skip when expanded

**Files:** Modify `apps/desktop/src/timeline/LayerBlock.tsx`, `apps/desktop/src/timeline/TrackLane.tsx`, `apps/desktop/src/timeline/Timeline.tsx`

Migrate Phase 2's local `selectedKfId` to the shared store, and stop drawing collapsed diamonds when the track is expanded.

- [ ] **Step 1: Pass `isTrackExpanded` to LayerBlock.** In `Timeline.tsx`, the body `TrackLane` map already has `expandedTracks` available (Task 2). Add `isExpanded={expandedTracks.has(track.id)}` to each `<TrackLane>`; thread it through `TrackLane` props to each `<LayerBlock isTrackExpanded={isExpanded} />` (add the boolean to both prop types).
- [ ] **Step 2: In LayerBlock, replace local selection with the store.**
  - Remove `const [selectedKfId, setSelectedKfId] = useState<string | null>(null);`.
  - Import: `import { useIsKeyframeSelected, selectKeyframe, clearKeyframeSelection, getSelectedKeyframe } from "../keyframe/selectionStore";`.
  - The diamond render: instead of `selectedKfId === d.id`, compute selection per diamond. Since `useIsKeyframeSelected` is a hook, render each diamond via a tiny child component (`CollapsedDiamond`) that calls `useIsKeyframeSelected(layer.id, focusedParam!, d.id)` for its `is-selected` class. (A hook can't run in a `.map` callback at the parent; extract the diamond to a component.)
  - On diamond pointerdown (select): `selectKeyframe({ layerId: layer.id, paramKey: focusedParam, kfId: hitId })` (was `setSelectedKfId(hitId)`).
  - The Delete effect: gate on `getSelectedKeyframe()` belonging to THIS layer+param; on delete, `clearKeyframeSelection()`. Restructure the effect to read the store (subscribe via `useKeyframeSelectionStore` selector for the "is one of mine selected" boolean to arm the listener), e.g.:
```tsx
const selectedHere = useKeyframeSelectionStore(
  (s) => s.selected?.layerId === layer.id && s.selected?.paramKey === focusedParam ? s.selected.kfId : null,
);
useEffect(() => {
  if (!selectedHere || !focusedParam) return;
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Delete" && ev.key !== "Backspace") return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    const track = readParamTrack(layer.params, focusedParam);
    if (!track) return;
    const desc = animatableParams(layer.kind).find((d) => d.paramKey === focusedParam);
    onCommitParamTrack(layer.id, focusedParam, removeKeyframe(track, selectedHere, desc?.fallback ?? 0));
    clearKeyframeSelection();
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}, [selectedHere, focusedParam, layer.id, layer.kind, layer.params, onCommitParamTrack]);
```
  - The `isPrimary`-clear effect and the clip-body-pointerdown clear: call `clearKeyframeSelection()` instead of `setSelectedKfId(null)`.
- [ ] **Step 3: Skip collapsed diamonds when expanded.** Guard the `diamonds` computation / render: `if (isTrackExpanded) → no collapsed diamonds` (e.g. `const diamonds = isTrackExpanded ? [] : (…existing…)`).
- [ ] **Step 4: Verify** `npx tsc -b; echo tsc=$?` + `npx vitest run 2>&1 | tail -3`. Live smoke: collapsed diamonds still select/seek/drag/delete via the store; expanding a track hides its collapsed diamonds.
- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/timeline/LayerBlock.tsx apps/desktop/src/timeline/TrackLane.tsx apps/desktop/src/timeline/Timeline.tsx
git commit -m "refactor(timeline): keyframe selection via store; hide collapsed diamonds when expanded"
```

---

### Task 6: TrackHeader twirl

**Files:** Modify `apps/desktop/src/timeline/TrackHeader.tsx`, `apps/desktop/src/timeline/Timeline.tsx`

- [ ] **Step 1: Pass twirl state to TrackHeader.** In `Timeline.tsx`'s header-column `TrackHeader` map, add props: `isExpanded={expandedTracks.has(track.id)}`, `hasKeyframes={trackKeyframeProperties(track).length > 0}`, `onToggleExpand={() => toggleExpanded(track.id)}`. Add these to `TrackHeader`'s prop type.
- [ ] **Step 2: Render the twirl** in `TrackHeader.tsx` — a lucide `ChevronRight`/`ChevronDown` button at the very start of the row (before the Music glyph / name):
```tsx
import { ChevronRight, ChevronDown } from "lucide-react";
// ...
<button
  type="button"
  className="inline-flex size-[14px] items-center justify-center text-muted-foreground/60 disabled:opacity-30"
  disabled={!hasKeyframes}
  aria-label={t("timeline.toggle_keyframe_lanes", { defaultValue: "Expand keyframe lanes" })}
  aria-expanded={isExpanded}
  onClick={onToggleExpand}
>
  {isExpanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
</button>
```
(Add the i18n key `timeline.toggle_keyframe_lanes` to both locales — en: "Expand keyframe lanes", zh: "展开关键帧轨".)
- [ ] **Step 3: Verify** `npx tsc -b; echo tsc=$?`. Live smoke: tracks with keyframed properties show an active twirl that toggles; tracks without show a grayed twirl.
- [ ] **Step 4: Commit**
```bash
git add apps/desktop/src/timeline/TrackHeader.tsx apps/desktop/src/timeline/Timeline.tsx apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(timeline): keyframe-lane twirl on the track header"
```

---

### Task 7: KeyframeLane components + Timeline wiring + styles

**Files:** Create `apps/desktop/src/timeline/KeyframeLane.tsx`; modify `apps/desktop/src/timeline/Timeline.tsx`, `apps/desktop/src/styles.css`

Render in BOTH columns to keep alignment: labels in the header column, diamonds in the body.

- [ ] **Step 1: Create `KeyframeLane.tsx`** with two exports + the per-diamond child:
```tsx
import { useTranslation } from "react-i18next";
import type { AnimTrack, TrackSummary } from "../ipc";
import { trackKeyframeProperties, keyframeAbsoluteX } from "./geometry";
import { readParamTrack } from "../keyframe/descriptors";
import { useIsKeyframeSelected } from "../keyframe/selectionStore";

export const KF_SUBLANE_H = 24;

/// Header-column rows: one property-name label per sub-lane (kept row-aligned
/// with the body rows below by sharing trackKeyframeProperties + KF_SUBLANE_H).
export function KeyframeLaneHeaders({ track }: { track: TrackSummary }) {
  const { t } = useTranslation();
  const props = trackKeyframeProperties(track);
  return (
    <>
      {props.map((d) => (
        <div key={d.paramKey}
          className="flex items-center justify-end border-b border-border-soft px-1.5 text-[10px] text-muted-foreground/80"
          style={{ height: KF_SUBLANE_H }}>
          {t(d.labelKey, { defaultValue: d.paramKey })}
        </div>
      ))}
    </>
  );
}

/// Body rows: one diamond lane per property, diamonds absolute-positioned.
export function KeyframeLane({ track, pxPerSec, onCommitParamTrack }: {
  track: TrackSummary;
  pxPerSec: number;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const props = trackKeyframeProperties(track);
  return (
    <>
      {props.map((d) => (
        <div key={d.paramKey} className="relative border-b border-border-soft" style={{ height: KF_SUBLANE_H }}>
          {track.layers.map((layer) => {
            const trk = readParamTrack(layer.params, d.paramKey);
            if (!trk || trk.mode !== "Keyframed") return null;
            const durUs = layer.t_end_us - layer.t_start_us;
            return trk.value.map((kf) => (
              <SubLaneDiamond key={kf.id}
                layerId={layer.id} paramKey={d.paramKey} kfId={kf.id}
                x={keyframeAbsoluteX(layer.t_start_us, kf.t_us, pxPerSec)}
                outOfRange={kf.t_us < 0 || kf.t_us > durUs} />
            ));
          })}
        </div>
      ))}
    </>
  );
}

function SubLaneDiamond({ layerId, paramKey, kfId, x, outOfRange }: {
  layerId: string; paramKey: string; kfId: string; x: number; outOfRange: boolean;
}) {
  const selected = useIsKeyframeSelected(layerId, paramKey, kfId);
  return (
    <span
      className={`kf-diamond${selected ? " is-selected" : ""}`}
      style={{ left: x, top: "50%", opacity: outOfRange ? 0.4 : 1 }}
      data-kf-id={kfId} data-layer-id={layerId} data-param={paramKey}
    />
  );
}
```
(Interactions wired in Task 8; this task renders + selects-visually only. Note `top: 50%` + the existing `.kf-diamond` transform centers it; adjust the transform in CSS Step 3.)
- [ ] **Step 2: Wire into Timeline (both loops).** In `Timeline.tsx`:
  - Header-column loop: change each entry to a fragment — `<Fragment key={track.id}><TrackHeader .../>{expandedTracks.has(track.id) && <KeyframeLaneHeaders track={track} />}</Fragment>` (import `Fragment`, `KeyframeLaneHeaders`).
  - Body loop: `<Fragment key={track.id}><TrackLane .../>{expandedTracks.has(track.id) && <KeyframeLane track={track} pxPerSec={pxPerSec} onCommitParamTrack={onCommitParamTrack} />}</Fragment>` (import `KeyframeLane`).
  - (Both loops currently use `key={track.id}` on the single child — move the key to the `Fragment`.)
- [ ] **Step 3: Styles** — in `styles.css`, extend the `.kf-diamond` rule so it works both in the clip (Phase 2, bottom-pinned) and the sub-lane (centered). Add a sub-lane-scoped centering rule; the base `.kf-diamond` (Phase 2) stays. Append:
```css
.kf-diamond[style*="top"] { margin-top: -3.5px; }
```
(or add a `.kf-sublane-diamond` class if cleaner — keep Phase 2's `.kf-diamond` untouched). Verify the diamonds appear centered in the 24px row.
- [ ] **Step 4: Verify** `npx tsc -b; echo tsc=$?` + `npx vitest run 2>&1 | tail -3`. Live smoke: expand a track with a keyframed property → a labeled sub-lane appears in the header column, aligned with a diamond row in the body; diamonds sit at the right times; out-of-range keys are dimmed; columns stay aligned when scrolling vertically.
- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/timeline/KeyframeLane.tsx apps/desktop/src/timeline/Timeline.tsx apps/desktop/src/styles.css
git commit -m "feat(timeline): expanded keyframe sub-lanes (header labels + body diamonds)"
```

---

### Task 8: Sub-lane diamond interactions (click-seek / drag-retime / interp)

**Files:** Modify `apps/desktop/src/timeline/KeyframeLane.tsx`

Mirror Phase 2's `LayerBlock` diamond gestures, adapted to absolute positioning + the store. Delete is already handled globally — but it's currently armed by `LayerBlock`'s effect keyed on collapsed selection. Move the Delete effect to fire whenever ANY keyframe is selected (collapsed or expanded). Simplest: keep the Delete effect in `LayerBlock` for collapsed, and add a parallel one for expanded — OR (cleaner) extract one Delete effect to `Timeline` keyed on `getSelectedKeyframe()`. For v1, add the Delete handler in `KeyframeLane` (per-lane, same capture-phase pattern), gated on the selected key being in this track.

- [ ] **Step 1: Add pointer + context handlers to `SubLaneDiamond`** (it already renders the span). On the diamond span:
  - `onPointerDown`: `e.stopPropagation(); selectKeyframe({layerId, paramKey, kfId}); transportSeek(layerTStartUs + kfTUs)` then begin a window-listener drag-retime that on release commits `retimeKeyframe(track, kfId, newTUs)` via `onCommitParamTrack` (Δus = (Δclientx/pxPerSec)*1e6; clamp to `[0, layer.duration]`; shuttle via a ref). This needs the diamond to know `layerTStartUs`, `kfTUs`, `pxPerSec`, the param `track`, and `onCommitParamTrack` — pass them down from `KeyframeLane` (it has `layer` + `trk` + `pxPerSec` + `onCommitParamTrack` in scope).
  - `onContextMenu`: `selectKeyframe(...)` then open `KeyframeInterpMenu` at the cursor; on pick `setKeyframeInterp(track, kfId, interp)` via `onCommitParamTrack`. (Reuse the menu state pattern from `LayerBlock`.)
  Reference the exact drag/menu code in `LayerBlock.tsx` (the `.kf-diamond-row` `onPointerDown` + the `interpMenu` state) — the logic is identical except: the seek/drag use absolute time (`layerTStartUs + kfTUs`) and the x is absolute. `transportSeek` from `../state/playbackStore`; `retimeKeyframe`/`setKeyframeInterp` from `../keyframe/edits`; `KeyframeInterpMenu` from `./KeyframeInterpMenu`.
- [ ] **Step 2: Add the Delete effect** in `KeyframeLane` (once per lane component is fine, or once at the KeyframeLane root): capture-phase `keydown`, gated on `getSelectedKeyframe()` whose `layerId` is one of this track's layers; on Delete/Backspace → `ev.preventDefault(); ev.stopImmediatePropagation();` → `removeKeyframe` the selected key via `onCommitParamTrack` → `clearKeyframeSelection()`. (Same capture-phase rationale as Phase 2: preempt the app delete-selected-layer shortcut.) Subscribe to the selected key via `useKeyframeSelectionStore` so the effect re-arms correctly.
- [ ] **Step 3: Verify** `npx tsc -b; echo tsc=$?` + `npx vitest run 2>&1 | tail -3`. Live smoke: in an expanded sub-lane — click a diamond seeks + selects (amber); drag retimes on release; right-click → interp menu changes the curve; Delete removes it (and on the last key the property collapses to Static → the sub-lane disappears).
- [ ] **Step 4: Commit**
```bash
git add apps/desktop/src/timeline/KeyframeLane.tsx
git commit -m "feat(timeline): sub-lane diamond click-seek / drag-retime / delete / interp"
```

---

### Task 9: e2e + full verification

**Files:** Create `apps/desktop/e2e/specs/keyframe_sublanes.e2e.js`

- [ ] **Step 1: e2e** mirroring `keyframe_authoring.e2e.js`'s harness (driver bootstrap, `__weftcutTest` setup, `update_layer_param_track` via the Tauri invoke surface). The spec: set up a project + a layer with a 2-key opacity track; toggle the track expanded (drive `toggleExpanded` via the dev bridge / a test hook, OR directly assert the sub-lane DOM after setting `expanded_tracks` view-state — choose whichever the harness reaches most cleanly); assert a `.kf-diamond` sub-lane row renders with 2 diamonds; click a diamond and assert the playhead `currentTimeUs` seeks to `t_start + kf.t_us`. (Export-reflects-animation is already covered by the Phase-2 e2e — no need to re-export.)
- [ ] **Step 2: Run** (Windows-safe single-spec, after ensuring no `weftcut` instance is running + a matching msedgedriver in `e2e/.drivers/`):
`node node_modules/@wdio/cli/bin/wdio.js run wdio.conf.mjs --spec specs/keyframe_sublanes.e2e.js` (from `apps/desktop/e2e/`). Expect "Execution of 1 workers" + the spec passes. If env blocks (driver/instance), report it; the spec stays committed.
- [ ] **Step 3: Full verification** `cd apps/desktop && npx tsc -b && npx vitest run 2>&1 | tail -6` (all green) + `cd apps/desktop/src-tauri && cargo test --lib view_state 2>&1 | tail -5`.
- [ ] **Step 4: Commit**
```bash
git add apps/desktop/e2e/specs/keyframe_sublanes.e2e.js
git commit -m "test(e2e): keyframe sub-lanes — expand + diamond render + click-seek"
```

---

## Self-Review notes

- **Spec coverage:** selection store (§1) → Task 3; expansion view-state (§1) → Tasks 1–2; KeyframeLane render + property-union + absolute + out-of-range + collapsed↔expanded (§3, §5) → Tasks 4,5,7; twirl + layout (§5) → Tasks 6,7; single-select interactions (§4) → Tasks 5,8; testing (§6) → tests in each + Task 9. Deferred items (marquee/multi-select/multi-drag, nav arrows, Rgba/Bezier/MCP) are NOT in this plan — correct.
- **Single source of truth:** Phase 2's `LayerBlock` local `selectedKfId` is removed (Task 5); both collapsed + expanded diamonds use `keyframeSelectionStore` — no duplicate selection state.
- **Type consistency:** `SelectedKeyframe {layerId, paramKey, kfId}` used uniformly; `useIsKeyframeSelected(layerId, paramKey, kfId)` signature identical at all call sites (LayerBlock collapsed diamond + KeyframeLane SubLaneDiamond); `onCommitParamTrack(layerId, paramKey, track)` matches the Phase-2 drill; `keyframeAbsoluteX`/`trackKeyframeProperties` signatures match their call sites.
- **Atomic-selector rule honored:** `useIsKeyframeSelected` selects a boolean; the LayerBlock/KeyframeLane "is one of mine selected" reads select a primitive (string|null).
- **Alignment invariant:** sub-lanes render in BOTH the header-column loop (`KeyframeLaneHeaders`) and the body loop (`KeyframeLane`) with the same `trackKeyframeProperties` + `KF_SUBLANE_H` — the two columns can't drift.
