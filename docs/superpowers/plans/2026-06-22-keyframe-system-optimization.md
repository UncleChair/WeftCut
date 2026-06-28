# Keyframe System — Optimization Backlog

> Standing assessment + prioritized backlog from a keyframe-architecture review
> (2026-06-22). Not a single executable plan — each item below is a candidate
> for its own spec/plan when picked up. Consolidate the relevant bullets into
> [`../../roadmap.md`](../../roadmap.md) and delete this file once the backlog is
> exhausted (git is the archive). Items the roadmap already tracks are linked,
> not duplicated; this doc adds the *why* and the evidence those bullets lack.

## Baseline — what the foundation gets right

The geometry is sound and worth preserving as-is:

- **`Animated<T> = Static(T) | Keyframed(Vector<Keyframe<T>>)`** — clean sum
  type; a single-keyframe track reads as "not animated" (`is_animated()`),
  a nice touch. `native/src/state/animated.rs:30-35`, `:261-268`.
- **Layer-local microsecond keyframe times**, frame-snapped on every mutation;
  moving a layer never breaks its animation. Composition time =
  `layer.t_start_us + kf.t_us`.
- **Non-destructive trim**: out-of-range keys are retained (the validator
  permits `t_us` outside `[0, duration]`), shifted content-anchored on
  head-trim, clamped in eval. Matches pro-NLE behavior. `state/validate.rs:496`.
- **One shared eval engine, `weftcut-eval`**, compiled native + wasm32; the
  renderer calls the wasm leaf, export links the rlib, and a cross-language
  golden fixture (`render/animatedGolden.fixture.json`) locks both sides. This
  kills the Rust↔TS drift class of bug. Newton-Raphson bezier solve with
  bisection fallback. `native/eval/src/lib.rs:116-256`.
- **For a single scalar, "time-remap via cubic-bezier + linear value lerp" is
  mathematically identical to a value-graph bezier** — so x/y/scale/opacity/gain
  lose *no* expressiveness vs After Effects' value graph. Do not "fix" this.

## Done

- **P0 — easing-handle drag coalesced to one undo step.** `dragHandle` in
  `src/renderer/timeline/KeyframeCurveGraph.tsx` previously called `onSetInterp`
  on *every* `pointermove` → one async actor round-trip (`updateLayerParamTrack`
  → `onMutated`) and one undo entry per move (60+ per gesture). Now it previews
  locally during the drag and commits once on `pointerup`; the preview holds
  until the committed track catches up, so there's no flicker. Test:
  `KeyframeCurveGraph.test.tsx` ("commits a tangent-handle drag as a single
  deferred onSetInterp"). _Shipped 2026-06-22._

## Backlog (prioritized)

### P1 — Make the generic real: `Interpolate` trait + `Animated<Rgba>`

**Designed — see
[`2026-06-28-animated-generic-interpolate.md`](./2026-06-28-animated-generic-interpolate.md).**
Resolved shape: an `Interpolate` two-endpoint-lerp trait + generic
`eval<T: Interpolate>` *folded* into the locked scalar engine (golden fixture is
the safety net); `Animated<T>` stays generic + type-safe (no `ParamValue` enum,
no hand-copied evaluators). Color interpolates in **OkLab + premultiplied alpha**
(transient eval math; storage stays sRGB u8, ADR 0021 untouched). wasm crosses
the scalar-only boundary via a **packed-i32** color shim; `Vec2` rides the scalar
path. Scope is **engine only** (no authoring UI / MCP this round). Spatial motion
paths stay a separate layer above the trait (P5); no schema change now (spatial
tangents = documented commitment + P5-owned migration).

### P2 — Extrapolation modes (loop / cycle / ping-pong / continue)

**Problem.** Before the first / after the last keyframe the value clamps to the
endpoint; there is no loop/cycle/ping-pong/continue
(`native/eval/src/lib.rs:216-256`). Harmless for plain cuts, but WeftCut has
looping overlays / Motifs / text-effects where this is the first thing a user
reaches for.

**Recommended shape.** Add `extrapolate: { before, after }` (enum
Hold/Loop/PingPong/Continue) to the keyframed track and honor it in `eval`
before the segment lookup. Cheap, self-contained, high value. Extend the golden
fixture.

**Effort/risk.** Low. Schema addition (plan the migration — see Minor).
**Not in the roadmap.**

### P3 — Desktop-grade multi-keyframe authoring

**Problem.** Selection and drag are single-keyframe (`focusStore` is
single-focus per layer). Missing the table-stakes batch operations: marquee
box-select, cross-property/cross-layer multi-drag, **time-scale a selection**
(stretch/squash a group of keys), **copy/paste keyframes**, and per-frame nudge.

**Recommended shape.** Ride the existing batch `update_layer_param_tracks` actor
command (one undo for the whole gesture). Box-select in the sub-lanes, a
selection model spanning properties/layers, and a scale-about-anchor transform
for time-stretch. Copy/paste serializes the selected keys (layer-local times
rebased on paste at the playhead).

**Effort/risk.** Medium (mostly renderer; backend command exists).
**Roadmap.** Partially tracked as "Multi-select keyframe editing in the
sub-lanes" — [`roadmap.md`](../../roadmap.md) §Keyframes. Copy/paste and
time-scale are not separately called out there.

### P4 — Per-keyframe tangent model / auto-bezier maintenance

**Problem.** `interp` is owned by the *segment* (stored on the left keyframe),
so a keyframe's "velocity" is split across two records: its outgoing tangent is
`thisSeg.p1`, its incoming tangent is `prevSeg.p2`. Consequences: (a) `smooth`
must write into two keyframe records to get C1 continuity (`keyframe_edits.rs`
`smooth_one`); (b) **smoothing is a one-shot bake — editing a neighbor's value
or time does not re-smooth**, so smoothed motion silently goes stale, unlike
AE's auto-bezier keyframes which re-solve continuously. The data model has no
natural home for the per-keyframe interpolation type (auto/continuous/bezier/
linear/hold) that every pro UI presents.

**Recommended shape.** Two options, pick when scoped:
1. *Cheap:* keep the segment model but re-run `smooth_one` on the affected
   keys after any value/time edit to an auto-smoothed key (track a per-key
   "auto" flag).
2. *Proper:* promote `interp` to a per-keyframe `{ in, out, mode }` tangent
   record; derive segment beziers at eval time. Bigger change, aligns the model
   with AE/Blender and makes P3's tangent editing first-class.

**Effort/risk.** Option 1 low; option 2 high (schema + engine + UI + golden).
**Not in the roadmap.**

### P5 — Vector position with spatial motion paths

**Problem.** Position is two independent scalar tracks (`Transform.x`,
`Transform.y` — both `Animated<f64>`, `state/transform.rs:10-11`). This
**cannot represent a curved spatial path**: a motion path is a 2D bezier through
space, and AE separates *spatial* interpolation (path curvature; auto/continuous
/linear) from *temporal* interpolation (the velocity/speed curve). Per-axis
time-remaps can only produce axis-aligned eased moves; arcs, roving keyframes
(float-in-time-to-keep-constant-velocity), and orient-along-path are impossible.

**Recommended shape.** Only worth it if WeftCut targets motion graphics (the
Motif / text-FX direction suggests it eventually will). Model position as a
single `Animated<Vec2>` (depends on P1's vector `Interpolate`), carry per-key
spatial tangents separate from the temporal curve, and add a viewport path
editor. The longer this waits, the more keyframe data has to migrate — flag
the decision early even if the build is deferred.

**Effort/risk.** High; structural. Largest gap vs AE. **Not in the roadmap.**

## Minor / cleanup

- **Animatable anchor.** `Transform.anchor` is a static `(f64, f64)`
  (`state/transform.rs:15-16`) — scale/rotate-about-a-point works, but the pivot
  can't be keyframed (AE allows it). Fold into P1's vector type when convenient.
- **Named-ease identity loss.** The `"ease"` preset is stored as a raw
  `Bezier{p1,p2}` while EaseIn/EaseOut are named variants, so a reloaded "ease"
  no longer reads as a named preset. Cosmetic; either make `"ease"` a named
  variant or accept it.
- **Eliminate the last cross-language twin.** One JS `unitBezier`
  (`src/renderer/render/animated.ts:33-72`) survives for the curve-graph UI and
  is a hand-mirror of the Rust solver (drift risk per the engine-source-drift
  note). Have the curve graph call the wasm `unit_bezier` instead.
- **Schema migration.** Pre-release currently hard-rejects old `.vproj` (no
  migration). P2/P4/P5 all touch the keyframe schema — once the format is
  shipped, each needs a migration; plan them with the feature, not after.

## Cross-references

- Engine + types: [`../../data-model.md`](../../data-model.md),
  `native/eval/src/lib.rs`, `native/src/state/animated.rs`.
- Authoring + MCP: [`../../roadmap.md`](../../roadmap.md) §Keyframes,
  [`../../mcp.md`](../../mcp.md), `native/src/mcp/keyframes.rs`.
- Color model: ADR 0021. Effects: ADR 0027, [`../../render.md`](../../render.md).
