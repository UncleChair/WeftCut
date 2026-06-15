# Inline Keyframe Curve Graph: On-Timeline Value Curves with In-Place Tangent Handles

**Date:** 2026-06-15
**Status:** Designed (brainstorming complete). Not yet implemented.

## Goal

The current easing UX pops a detached `cubic-bezier` unit-square editor at the
clicked keyframe (`EasingEditor` + `EasingCanvas`). It works, but it is spatially
divorced from the timeline: nothing tells the user **which segment** the curve
governs — before the keyframe or after it. (The data answer is "after": a
keyframe's `interp` governs its *outgoing* segment, `kf[i] → kf[i+1]`, confirmed in
`render/animated.ts::resolveAnimated`.)

Replace the abstract popup with an **inline value-curve graph drawn directly on the
timeline**: the parameter's value over time, rendered on its keyframe sub-lane, with
AE/Premiere-style **tangent handles** editable in place. The curve follows the value
(rises and falls with it), so "which segment / which direction" is answered by the
picture itself. No data-model, engine, IPC, or export change — this is purely a
timeline-UI rework of how the *same* per-segment `Bezier` data is shown and authored.

## Relationship to `2026-06-15-keyframe-bezier-easing-design.md` (just shipped)

That spec listed a "value-time graph-editor panel" under **Model A / out of scope**,
because it bundled the *panel* together with a schema-breaking change (per-keyframe
dual temporal handles), a 2-engine 2D-Bézier rewrite, and a migration.

**This design takes the graph presentation without any of that baggage.** The
existing Model-B schema — `kf[i].interp = Bezier{p1, p2}`, one timing function per
segment — is already sufficient to render and edit as value-space tangent handles:

- `p1 = (x1,y1)` is the control point near the segment's start → the **outgoing
  handle of `kf[i]`**.
- `p2 = (x2,y2)` is the control point near the segment's end → the **incoming
  handle of `kf[i+1]`** (stored on `kf[i]`).

So an interior keyframe naturally shows two independently-draggable handles (left =
previous segment's `p2`, right = this segment's `p1`) — the AE "unlinked Bézier
handles" feel — with **no schema change, no engine change, no migration**. What the
prior spec correctly deferred (Model A's data model + live C1 auto-smoothing) stays
deferred; velocity continuity remains the one-shot `Smooth` command already shipped.

## Decisions (settled during brainstorming)

- **Curve semantics = value graph (NOT per-segment normalized).** Y axis is the
  parameter's actual value; the curve rises/falls with it; keyframes sit at their
  value heights. The rejected alternative (each segment normalized to a 0→1 box,
  every segment rising corner-to-corner) was technically simpler but reads
  unnaturally — it does not match the AE/Premiere value-graph mental model.
- **Per-lane auto-scale.** Each property's sub-lane scales its Y axis to its own
  value range, so position (±1000) and opacity (0–1) coexist without a shared axis.
- **Hybrid height (compact always-on read + focus-to-edit).** Sub-lanes stay at the
  current 24px with an always-on faint read-only curve (the "always visible"
  requirement); focusing a property grows *that* lane to ~72px with draggable
  handles. Reuses the existing `focusStore`.
- **In-place tangent handles; retire the abstract popup.** Editing is dragging the
  handles on the timeline. `EasingEditor` / `EasingCanvas` / `MotionPreview` are
  removed. Presets / `Smooth` / `Hold` move to a lightweight right-click context
  menu.
- **Graph lives only in the expanded sub-lanes.** The collapsed in-clip view
  (`LayerBlock`) keeps its keyframe diamonds and shows **no curve** — the clip chip
  displays keyframe *positions* only; its right-click just opens the same
  preset/`Smooth`/`Hold` context menu. Curve + handle editing is reached by expanding
  the track.
- **No vertical value-drag.** Keyframe dots in the graph drag in X only (retime);
  authoring a key's *value* stays in the inspector. Keeps the change scoped to the
  easing-clarity problem.
- **No data-model / engine / IPC / export change.** The stored `Interpolation`
  (Model B `Bezier{p1,p2}`) and the dual-engine `unitBezier` solver are untouched;
  the export e2e (custom Bézier reaching exported frames) must stay green.

## 1. Data model — unchanged (reuse Model B)

```
Interpolation = Hold | Linear | EaseIn | EaseOut | Bezier { p1:(f64,f64), p2:(f64,f64) }
```

`kf[i].interp` governs the outgoing segment `kf[i] → kf[i+1]`. The graph reads and
writes exactly these fields. Handle ↔ stored-coefficient mapping for a keyframe
`kf[i]` (`n` keyframes, `0 ≤ i ≤ n−1`):

| Handle of `kf[i]`         | Edits                | Exists when      |
|---------------------------|----------------------|------------------|
| right / outgoing          | `kf[i].interp.p1`    | `i < n−1`        |
| left / incoming           | `kf[i−1].interp.p2`  | `i > 0`          |

- First keyframe: right handle only. Last keyframe: left handle only — its own
  `interp` is dead data the graph never reads, so the "edit a meaningless outgoing
  segment on the last key" confusion disappears for free.
- `Hold` / `Linear` segments carry no editable handles (see §3).

## 2. Value↔pixel mapping (the math core — pure, unit-tested)

New pure module `keyframe/curveGraph.ts`, mirroring how `keyframe/curve.ts` isolated
the unit-square handle math. All functions take the lane geometry explicitly so they
test without a DOM.

**Per-lane value range.** Sample every segment's curve (the same ~40 samples used
for the polyline) and take min/max of the sampled *values* (not just keyframe
values — overshoot `y∉[0,1]` makes the curve exceed the endpoints). Pad by ~10% so
extreme handles aren't flush to the lane edge.
- Degenerate `vmax == vmin` (all keyframes equal, e.g. a flat "move later" pair):
  use a nominal ± range centered on the value so the flat line sits mid-lane.

**Conversions** (`top` = lane top px, `H` = lane draw height, y-down):
```
valueToY(v) = top + (vmax − v) / (vmax − vmin) · H
yToValue(py) = vmax − (py − top) / H · (vmax − vmin)
xToTimeUs(px), timeUsToX(tUs)   // via existing keyframeAbsoluteX / its inverse
```

**Curve polyline for segment i** (`Δt = t[i+1]−t[i]`, `Δv = v[i+1]−v[i]`), sampling
`u ∈ [0,1]` — identical shape to the engine, just placed in (time,value) space:
```
timeUs = t[i] + u·Δt
value  = v[i] + unitBezier(x1,y1,x2,y2, u) · Δv
point  = ( timeUsToX(timeUs), valueToY(value) )
```
`Hold` → flat line at `v[i]` then a vertical step at `kf[i+1]`. `Linear` → straight
segment corner-to-corner.

**Handle positions** (control polygon `(0,0),(x1,y1),(x2,y2),(1,1)` in time/value):
```
outgoing p1 of seg i:  ( timeUsToX(t[i]+x1·Δt),  valueToY(v[i]+y1·Δv) )
incoming p2 of seg i:  ( timeUsToX(t[i]+x2·Δt),  valueToY(v[i]+y2·Δv) )
```

**Drag → coefficient** (right/outgoing handle of `kf[i]` = `p1` of segment i):
```
x1' = clamp01( (xToTimeUs(px) − t[i]) / Δt )        // clamp keeps time monotone
y1' = Δv == 0 ? y1 (vertical locked) : (yToValue(py) − v[i]) / Δv   // y free → overshoot ok
```
Left/incoming handle of `kf[i]` maps the same way onto `p2` of segment `i−1`
(`x2', y2'` against `Δt_{i−1}`, `Δv_{i−1}`). `x` clamped to `[0,1]` (solver stays
single-valued — same invariant the unit-square editor enforced); `y` free.

**Axis freeze during a drag.** Compute `[vmin,vmax]` once at gesture start and hold
it for the duration, recomputing only on release (and on keyframe value/data
changes). Otherwise overshoot dragging would rescale the lane live and the curve
would "breathe" under the cursor.

## 3. Rendering surfaces

New component `timeline/KeyframeCurveGraph.tsx` — given a property's `AnimTrack`,
the lane geometry, and an `editable` flag, it draws the value polyline (all
segments), the keyframe dots at their value heights, and (when editable) the tangent
handle lines + grab dots. Read-only and editable modes share one renderer.

- **Expanded sub-lanes (`KeyframeLane.tsx`) — primary surface.**
  - Unfocused property: lane stays `KF_SUBLANE_H` (24px), draws a **faint read-only
    value curve** (sparkline) with dots at value heights. Always visible → satisfies
    the "常驻 / always see the shape & which segment" requirement.
  - Focused property (via `focusStore`): lane grows to **~72px**, full-contrast
    curve + draggable handles. The track's expanded height is the sum of its
    sub-lane heights, so one lane growing is absorbed by the existing expanded-height
    computation — *verify this sum-of-heights assumption in planning* and adjust the
    height source if the track height is computed from a fixed per-lane constant.
- **Collapsed in-clip view (`LayerBlock.tsx`) — unchanged visually.** Keep the
  existing single row of `focusedParam` diamonds and draw **no curve** (the clip chip
  shows keyframe *positions* only). The sole change here is swapping the right-click
  target from the removed `EasingEditor` popup to the preset/`Smooth`/`Hold` context
  menu (§4); curve + handle editing is reached by expanding the track.

## 4. Interaction

- **Focus to edit.** Clicking a keyframe dot or the curve in a sub-lane focuses that
  property (`setKeyframeFocus`) → the lane expands to editable height. Reuses the
  existing focus plumbing; no new global mode.
- **Handle drag.** Pointer-drag a tangent grab-dot → live `setKeyframeInterp`
  (existing `edits.ts` pure transform) on the owning keyframe, mapped per §2. Same
  window-listener + teardown-on-unmount pattern as today's `EasingCanvas`.
- **Keyframe drag (retime, X only).** Horizontal drag of a keyframe dot retimes it
  (existing `retimeKeyframe`). Vertical value-drag is **not** included — value
  authoring stays in the inspector; dots drag in X only.
- **Preset / Smooth / Hold context menu.** Right-click a segment or a keyframe dot →
  compact menu: `Linear · Ease · In · Out · In-Out · Hold · Smooth`. These reuse the
  existing `PRESETS` table, `setKeyframeInterp`, and `smoothKeyframe`. This preserves
  one-click presets and `Smooth` without the abstract unit-square box.
- **Hold / Linear** segments render per §2 and expose no tangent handles (matches
  the current "Smooth disabled on Hold" rule); pick a curved preset or drag is
  re-enabled once the segment is `Bezier`.
- **Narrow segments** (keyframes close in time / zoomed out): handles crowd
  horizontally. Mitigate with a minimum grab radius and the fact that the right-click
  preset menu still works regardless of segment width; precise drag improves on zoom.

## 5. Determinism & export — untouched

No engine, schema, IPC, or export-path change. Preview and export keep sharing
`resolveView.ts → resolveAnimated`; the stored `Bezier{p1,p2}` is authored exactly as
before, only through a different gesture. The existing cross-language golden vectors
and the `keyframe_authoring.e2e.js` export assertion remain the determinism gate and
must stay green.

## 6. Migration, docs, testing

- **Migration:** none — no stored shape changes.
- **Docs:** update `docs/render.md` / the timeline doc section that describes
  keyframe authoring to say easing is shown/edited as an on-lane value curve with
  tangent handles (evergreen tone — no dates / phase numbers). Note the retirement of
  the popup editor.
- **Testing:**
  - *Pure unit (vitest):* `curveGraph.ts` — `valueToY`/`yToValue` round-trip;
    handle-position math for presets at known points; drag→coeff mapping incl. `x`
    clamp and `Δv==0` vertical lock; value-range incl. overshoot and the degenerate
    `vmax==vmin` case; Hold/Linear polyline shapes.
  - *Interaction smoke:* focus expands the lane; drag a handle mutates `p1`/`p2`
    correctly; right-click preset/Smooth/Hold writes the expected `Interpolation`;
    read-only thumbnail renders without handles.
  - *e2e:* the shipped `keyframe_authoring.e2e.js` already proves the *data* path
    (a custom Bézier reaches exported frames); extend its UI portion to author the
    curve via a handle drag instead of the removed popup, asserting the same exported
    result — so the new gesture is covered end-to-end without a third engine path.

## Out of scope (this round) / future

- **Vertical value-drag of keyframe dots** in the graph (author a key's value by
  dragging it up/down) — decided out: value authoring stays in the inspector.
- **In-clip value sparkline** (a read-only curve behind the collapsed clip diamonds)
  — decided out: the clip chip shows keyframe positions only.
- **Speed graph** (velocity on Y instead of value). More abstract; value graph is
  the habitual default.
- **Model A** (per-keyframe linked tangents + live C1 auto-smooth + schema change) —
  still deferred per the bezier-easing spec; this design deliberately stays on Model
  B and reaches the same on-screen feel without it.
- **`Animated<Rgba>` / colour curves**, **MCP curve-editing tools** — orthogonal.

## Related

- `docs/superpowers/specs/2026-06-15-keyframe-bezier-easing-design.md` — the solver +
  `Smooth` + presets this reuses; deferred the graph panel as "Model A".
- `docs/superpowers/specs/2026-06-14-keyframe-sublanes-design.md` — the sub-lane
  surface the graph primarily lives on.
- `docs/superpowers/specs/2026-06-11-timeline-redesign-design.md` — the keyframe
  paradigm + focus model.
- `docs/data-model.md` — `Animated<T>` / `Interpolation`, snap storage invariant.
- `docs/render.md` — the single per-frame resolution shared by preview + export.
