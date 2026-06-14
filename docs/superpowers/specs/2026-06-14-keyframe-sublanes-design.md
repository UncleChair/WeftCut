# Keyframe Sub-Lanes (Timeline Redesign Phase 3): Expanded Per-Property Lanes

**Date:** 2026-06-14
**Status:** Approved design, pending implementation plan

## Goal

Add the **expanded-mode** half of the hybrid-C+A keyframe paradigm
(timeline-redesign spec §5). Twirling a track open reveals one sub-lane per
animated property (the union across the track's layers), with the property's
keyframes shown as diamonds at their absolute timeline position — including
out-of-range keys (dimmed). Phase 2 gave collapsed-mode diamonds for one
focused property on the clip; Phase 3 gives the full per-property view below the
track.

**No backend work** — the write path, the batch `update_layer_param_tracks`,
trim/split content-anchoring, and the engines all shipped in Phase 2. Phase 3 is
**frontend + view-state only**, reusing `keyframe/edits.ts`,
`keyframe/descriptors.ts`, `KeyframeInterpMenu`, `update_layer_param_track`, and
the timeline geometry helpers.

## Decisions (settled during brainstorming)

- **Selection state = a dedicated `keyframeSelectionStore` (zustand, atomic
  selectors).** Mirrors Phase 2's `focusStore`: each diamond subscribes via an
  atomic `useIsKeyframeSelected(...)` so only diamonds whose selected-ness
  changed re-render; the keydown/drag/menu handlers read/write imperatively. No
  prop-drilling, no composite-object selectors (per the documented zustand
  gotcha). This store is the **single source of truth** for keyframe selection —
  it **replaces** Phase 2's per-`LayerBlock` local `selectedKfId`, so collapsed
  AND expanded diamonds share one selection model. Selection is **transient**
  (not persisted, not undo).
- **Expansion state = `useTimelineView` + `view.json`** (a persisted view
  preference, exactly like `track_heights` — not project data, not undo). Adds an
  `expanded_tracks` field to the Rust `ViewState`, the TS type, and the hook
  (load / debounced-save / dead-id prune).
- **v1 scope = single-selection.** v1 ships expansion + the sub-lane render +
  single-diamond interactions (click-select+seek, drag-retime, Delete, interp
  menu). **Deferred to a fast-follow:** Shift+click multi-select, marquee
  box-select, and batch multi-drag. The selection store is built single-valued
  but with an API that generalizes to a set (the fast-follow swaps the inner
  value for a `Set` without touching consumers).

## 1. State architecture

### `keyframe/selectionStore.ts` (new, zustand, transient)

```
type SelectedKey = { layerId: string; paramKey: string; kfId: string } | null;
// internal state: { selected: SelectedKey }
```

- `useIsKeyframeSelected(layerId, paramKey, kfId): boolean` — atomic selector
  (compares against the single selected key). Each diamond calls this; only the
  previously- and newly-selected diamonds re-render on a selection change.
- `useSelectedKeyframe(): SelectedKey` — for the (one) consumer that needs the
  whole selection (e.g. the Delete handler reading it).
- Imperative (non-hook) API: `selectKeyframe(key)`, `clearKeyframeSelection()`,
  `getSelectedKeyframe()`.
- Cleared on: clicking empty timeline, the owning layer losing primary
  selection, the owning track collapsing, Escape.
- **v1→fast-follow seam:** the inner value is a single key now; widening to
  `Set<selKey>` later changes only the store internals + adds `toggle`/
  `selectMany` — `useIsKeyframeSelected` and all call sites stay identical.

### Expansion in `useTimelineView` + `view.json`

- Rust `ViewState` gains `expanded_tracks: Vec<TrackId>` (serialized like
  `track_heights`); `view_state_get`/`view_state_set` carry it; the TS
  `ViewState` type mirrors it.
- `useTimelineView` loads `expanded_tracks` into a `Set<string>` state,
  debounced-saves it (pruning dead ids alongside `track_heights`), and exposes
  `expandedTracks` + `toggleExpanded(trackId)`.

## 2. Components & reuse

- **New:** `timeline/KeyframeLane.tsx` (the sub-lane stack for one track),
  `keyframe/selectionStore.ts`.
- **Reuse:** `keyframe/edits.ts` (`retimeKeyframe`/`removeKeyframe`/
  `setKeyframeInterp`), `keyframe/descriptors.ts` (`animatableParams` to build
  the property union + `readParamTrack`), `KeyframeInterpMenu`,
  `update_layer_param_track` (single — v1 doesn't need the batch), and the
  `onCommitParamTrack` callback already drilled to `LayerBlock` (drill the same
  to `KeyframeLane`).
- **Modify:** `timeline/geometry.ts` (+ `keyframeAbsoluteX`), `useTimelineView`
  (expansion), `TrackHeader.tsx` (twirl toggle), `Timeline.tsx` (render
  `KeyframeLane` below expanded tracks; drill commit callback + expansion),
  `LayerBlock.tsx` (skip collapsed diamonds when its track is expanded; migrate
  its local `selectedKfId` to the selection store), Rust `view_state` struct.

## 3. `KeyframeLane` rendering

- Rendered (by `Timeline`) directly below an expanded track's main row.
- **Property union:** for each layer on the track, the keyframed `Animated<f64>`
  params (via `animatableParams(kind)` + `readParamTrack`, keep only
  `mode === "Keyframed"`); union across layers, ordered by descriptor order. One
  sub-lane per property. A track with no keyframed property renders no lanes (and
  its header twirl is grayed — see §5).
- Each sub-lane: fixed **24px** height, not resizable; row header = the property
  label (i18n `property_panel.*`) right-aligned in the sticky header column.
- **Diamonds at absolute timeline x:** `keyframeAbsoluteX(layer.t_start_us,
  kf.t_us, pxPerSec)` = `((t_start_us + t_us)/1e6) * pxPerSec`. One sub-lane
  holds diamonds from every layer on the track for that property (they're
  spatially separated because the clips are; overlapping same-property layers may
  interleave — nearest-hit disambiguation, acceptable for v1).
- **Out-of-range keys** (`t_us < 0` or `> layer.duration`): rendered at **40%
  opacity** at their true absolute position — selectable / deletable / draggable
  back (complements collapsed mode, which hides them).
- **Selected diamond:** the `.is-selected` style (amber + ring, shared with
  collapsed mode).

## 4. Interactions (v1 — single-selection)

All single-key edits commit via `onCommitParamTrack(layerId, paramKey, track)`
→ `update_layer_param_track`.

- **Click** a diamond: `selectKeyframe({layerId, paramKey, kfId})` + seek
  (`transportSeek(layer.t_start_us + kf.t_us)`).
- **Drag** a diamond horizontally: frame-snapped retime, commit on release via
  `retimeKeyframe` (clamped to `[0, layer.duration]`) — the same window-listener
  + `dragTUsRef` shuttle pattern as Phase 2's `LayerBlock`.
- **Delete / Backspace** with a diamond selected: `removeKeyframe` (last key on a
  track collapses to Static, handled by `removeKeyframe`). Capture-phase keydown
  + `stopImmediatePropagation` to preempt the app's delete-selected-layer
  shortcut (the Phase-2 fix; now centralized via the store — fires when
  `getSelectedKeyframe()` is non-null).
- **Right-click** a diamond: open `KeyframeInterpMenu` at the cursor; on pick,
  `setKeyframeInterp` for that key.
- **Deferred (fast-follow):** Shift+click extend, marquee box-select, batch
  multi-drag (group selected keys by `(layerId, paramKey)`, one undo via
  `update_layer_param_tracks`).

## 5. Twirl, expansion & layout

- **Twirl** on `TrackHeader`: a lucide chevron; click → `toggleExpanded(trackId)`.
  Grayed/disabled when the track has no keyframed property (computed from the
  property union being empty).
- **Collapsed ↔ expanded coordination:** when a track is expanded, its
  `LayerBlock`s **stop** rendering collapsed-mode diamonds (read `expandedTracks`)
  — no double display (timeline-redesign §1).
- **Layout:** sub-lanes insert below the track's main row in `Timeline`'s
  per-track render block (after `TrackLane`). The height-drag handle stays on the
  main row (sub-lanes are fixed-height). The playhead line (a timeline-level
  overlay) spans the sub-lanes. Blade / clip-drag / drop-zones are oblivious to
  sub-lanes.
- Expansion is view state (§1), so it survives reload and is per-workspace.

## 6. Testing

- **Pure (vitest):** `selectionStore` (select/clear, `useIsKeyframeSelected`
  atomicity), `keyframeAbsoluteX`, the property-union builder (given a track's
  layers → ordered list of keyframed params), out-of-range classification.
- **Component:** `tsc -b` (no RTL in the project) + live smoke in real WebView2.
- **e2e (real WebView2):** expand a track that has a keyframed property, assert a
  sub-lane renders with the right diamond count/positions; click a diamond and
  assert the playhead seeks; drag and assert the committed track retimed. (Reuses
  the Phase-2 e2e harness; the export-reflects-animation path is already covered
  by the Phase-2 e2e.)

## Out of scope

- **Fast-follow (next, not v1):** Shift-multi-select, marquee box-select, batch
  multi-drag, bulk Delete/interp over a multi-selection. (The store + handlers
  are built so these are additive.)
- **Later polish:** AE prev/next-keyframe navigation arrows (§5).
- **Separate keyframe follow-ons (not Phase 3):** `Animated<Rgba>` color
  keyframes (needs a Rust `value_at` twin), Bezier interpolation authoring (engine
  arm is a linear stub), MCP keyframe tools.

## Related

- `docs/superpowers/specs/2026-06-11-timeline-redesign-design.md` §5 (the
  expanded sub-lanes this implements) and §1 (collapsed↔expanded coordination).
- `docs/superpowers/specs/2026-06-14-keyframe-authoring-design.md` (Phase 2 — the
  write path, edits, descriptor, focus store, collapsed diamonds, interp menu
  this builds on).
- `docs/data-model.md` — `Animated<T>`, out-of-range keyframes are valid stored
  state.
