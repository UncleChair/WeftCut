# Keyframe Bézier Easing: Real Cubic Presets, Custom Curve Editor, Smooth

**Date:** 2026-06-15
**Status:** Implemented and merged to local `main` (merge `e292f8b8`, unpushed).
Built subagent-driven over 12 TDD tasks (implement + spec-compliance + code-quality
review each); tsc clean / vitest 571 / cargo 590; e2e-verified in real WebView2
(`e2e/specs/ui/keyframe_authoring.e2e.js` — a custom slow-start Bézier's exported
mid-frame is ordinally closer to the black start than the full end). The
Out-of-scope items below remain (Model A handles/graph editor, `Animated<Rgba>` +
color stopwatch, MCP keyframe tools). Manual real-app visual acceptance of the
editor (feel/look) still pending — the e2e covers only the functional path.

## Goal

Turn keyframe interpolation from "Hold / Linear / two crude quadratic eases" into
proper cubic-Bézier easing, with three user-facing pieces: a real **named-preset
set**, a one-click **Smooth** command (velocity-continuous through a keyframe), and
a **custom curve editor** for arbitrary curves. The `Animated<T>` schema, the
dual-engine resolve (`value_at` ≡ `resolveAnimated`), the per-frame eval
(`resolveView.ts`, preview + export share it), and keyframe authoring
(stopwatch/diamonds/write-path) already ship — this is purely an upgrade to the
*shape between two keys* plus its authoring UI.

This builds on `2026-06-14-keyframe-authoring-design.md`, which deferred Bézier
authoring because the engine's `Bezier` arm is a linear stub.

## Decisions (settled during brainstorming)

- **Interpolation model = B (per-segment single timing function), NOT model A
  (per-keyframe dual temporal handles).** The schema already commits to B:
  `Bezier{p1, p2}` *is* `cubic-bezier(x1,y1,x2,y2)` — one curve per segment, stored
  on the segment's left keyframe (`kf[i].interp` governs `kf[i]→kf[i+1]`). There are
  **no incoming/outgoing handles in the data model**. Model A would be a
  schema-breaking change + a 2-engine 2D-Bézier rewrite (X-inversion + monotonic
  clamp) + a whole new value-time graph-editor panel + a migration — over-building
  against a schema that cannot even store its richness, and against the "keep it
  simple" goal. Model B reaches the one capability people actually ask A for —
  velocity continuity through a keyframe — via the **Smooth** command (§3), with no
  schema change.
- **Scope = all three pieces:** real presets + Smooth + custom curve editor.
- **Editor form = unified easing editor (mockup "C"):** one popover holding preset
  chips + the curve canvas + a looping motion preview. Presets, Smooth, and custom
  all live in one surface; it replaces the current bare `KeyframeInterpMenu`.
- **Smooth flavor = monotone / no overshoot** (Easy-Ease style): tangents are clamped
  to 0 at local extrema so the curve never exceeds the keyframe values. Predictable
  over "physical". One flavor in v1 (no overshoot toggle).
- **Motion preview = auto-loops** on open (not hover/click-gated).

## 1. Data model — no schema change

Reuse the existing enum (`state/animated.rs`, mirrored in `ipc/index.ts` +
`render/animated.ts`):

```
Interpolation = Hold | Linear | EaseIn | EaseOut | Bezier { p1: (f64,f64), p2: (f64,f64) }
```

- `Hold`, `Linear` keep their meaning.
- **`EaseIn`/`EaseOut` are redefined** from the crude quadratics (`u²` / `1−(1−u)²`)
  to their true CSS cubic-Béziers: `EaseIn ≡ (.42,0, 1,1)`, `EaseOut ≡ (0,0, .58,1)`.
  Keeping the named variants (vs collapsing to `Bezier`) means **zero migration**:
  old projects' ease keyframes simply render with the nicer curve. This is an
  intentional, minor, monotone behavior change — covered by updated golden vectors.
- Everything the editor authors beyond Hold/Linear emits `Bezier{p1,p2}` (the `Ease`
  and `Ease In-Out` presets, custom drags, and Smooth's baked tangents).

**Preset coefficients** (CSS-standard cubic-Béziers):

| Preset      | Stored as              |
|-------------|------------------------|
| Linear      | `Linear`               |
| Hold        | `Hold`                 |
| Ease        | `Bezier (.25,.1, .25,1)` |
| Ease In     | `EaseIn` (`.42,0, 1,1`)  |
| Ease Out    | `EaseOut` (`0,0, .58,1`) |
| Ease In-Out | `Bezier (.42,0, .58,1)`  |

## 2. Engine — the cubic-Bézier solver (the correctness core)

A `cubic-bezier(x1,y1,x2,y2)` timing function maps normalized segment progress
`u = (t−a.t)/(b.t−a.t)` through the parametric curve with control points
`(0,0),(x1,y1),(x2,y2),(1,1)`: solve `X(s)=u` for the Bézier parameter `s`, then
output `Y(s)`. The result `w` replaces `u` in the existing lerp
`a.value + (b.value−a.value)·w`.

- Implement the standard **WebKit `UnitBezier`** solver: Newton-Raphson (≤8
  iterations, slope ε guard) with a bisection fallback when the derivative is too
  small or iteration leaves `[0,1]`. Identical, byte-for-byte, in Rust
  `state/animated.rs::value_at` and TS `render/animated.ts::resolveAnimated`.
- `Hold` and `Linear` keep their fast paths (no solve). `EaseIn`/`EaseOut`/`Bezier`
  go through the solver with their respective control points.
- Overshoot: `y` outside `[0,1]` is allowed (custom curves may overshoot); `x1,x2`
  are assumed within `[0,1]` (enforced at authoring, §4) so `X` stays monotone and
  the solve is single-valued.

**Anti-drift gate.** Expand `render/animated.golden.test.ts`'s cross-language
fixture to cover: every preset, custom curves, overshoot `y`, and degenerate spans
(`Δt=0`, single key). This fixture asserted by both Rust and TS is the only thing
preventing the two engines from drifting — the recurring hazard noted across prior
keyframe work. The solver gets dedicated unit tests on top.

## 3. Smooth command — monotone auto-tangents (pure function)

Velocity continuity at an interior keyframe is achievable entirely within model B by
choosing the adjacent segments' control-point slopes to agree on `dV/dt` at the
shared key. A segment's timing-function endpoint slopes are `y1/x1` (start) and
`(1−y2)/(1−x2)` (end); real velocity = `(Δv/Δt)·slope`. C1 continuity at `kf[i]`:

```
(Δv_{i-1}/Δt_{i-1})·(1−y2^{i-1})/(1−x2^{i-1})  =  (Δv_i/Δt_i)·(y1^{i}/x1^{i})
```

**`smoothKeyframe(track, kfId)`** — pure `AnimTrack` transform:

1. Target tangent at `kf[i]` = neighbour secant `m_i = (v_{i+1} − v_{i-1}) / (t_{i+1} − t_{i-1})`.
2. **Monotone clamp:** if `kf[i]` is a local extremum (`sign(v_i−v_{i-1}) ≠
   sign(v_{i+1}−v_i)`, or either neighbour delta is 0), set `m_i = 0`. Additionally
   apply Fritsch-Carlson clamping so neither adjacent Hermite segment overshoots
   monotonicity. → never exceeds the keyframe values.
3. Convert to control points with fixed x-handles (`1/3`):
   - outgoing segment `i`: `p1 = (1/3, (1/3)·m_i·Δt_i/Δv_i)`
   - incoming segment `i−1`: `p2 = (2/3, 1 − (1/3)·m_i·Δt_{i-1}/Δv_{i-1})`
   - **`Δv = 0` guard:** a flat segment gets `Linear` (slope is 0 regardless; avoids
     div-by-zero).
4. First/last keyframe: one-sided tangent, or `0` (soft start/stop).

Smooth is **keyframe-scoped**: it writes the new `p1` onto `kf[i].interp` *and* the
new `p2` onto `kf[i-1].interp` — two keys, one whole-track write (§4 already replaces
the whole track per gesture). A **"Smooth all"** convenience smooths every interior
key in one commit.

**One-shot bake, not a live mode.** The schema has no "auto" flag, so moving a
neighbour later does not re-smooth (re-invoke Smooth). Keeping it one-shot preserves
the **local, deterministic** resolve — a live mode would need a per-key flag +
non-local `value_at` (neighbour-aware), which is the slide toward model A we are
explicitly avoiding.

## 4. UI — unified easing editor popover (replaces `KeyframeInterpMenu`)

Opened from a keyframe's right-click / double-click on both entry points that today
open `KeyframeInterpMenu` (collapsed-mode diamonds in `LayerBlock`, expanded-mode
sub-lane diamonds in `KeyframeLane`). Anchored at the click; Base-UI popover, modal
off. It edits the **segment that starts at the clicked keyframe** (`kf.interp` = that
segment's outgoing curve). Three regions:

- **Preset chips:** `Linear · Ease · In · Out · In-Out · Hold · Smooth`. Clicking a
  preset writes the corresponding `Interpolation` (table §1); `Hold`/`Linear` short
  out the curve canvas; `Smooth` runs §3 (and so also rewrites the previous key).
- **Curve canvas:** unit square, the cubic-Bézier drawn, two draggable handles. Drag
  emits `Bezier{p1,p2}`. `x` of each handle **clamped to `[0,1]`** (keeps time
  monotone → solver single-valued); `y` free (overshoot allowed). A read-only
  `cubic-bezier(x1,y1,x2,y2)` numeric readout below (editable numbers = optional
  nice-to-have, not v1).
- **Motion preview:** a dot travels a mini track on a ~1 s auto-loop, eased by the
  current curve — shows *motion feel*, not just curve shape. Pausable.

Edits flow through the existing whole-track write path: the popover composes the new
`AnimTrack` (via `keyframe/edits.ts`) and calls `updateLayerParamTrack`. New pure
transform in `edits.ts`: `smoothKeyframe` (+ `smoothTrack` for "Smooth all");
`setKeyframeInterp` already exists for the preset/custom case.

## 5. Determinism & export

Export inherits everything for free — the export Worker shares `resolveView.ts` →
`resolveAnimated`, so once the solver lands in the engine pair, exported frames use
the identical curve. No third engine copy exists anymore (the old `engine.ts`
`ENGINE_SOURCE` string was retired when export adopted `resolveView`). The only
determinism obligation is the solver being identical across Rust/TS — locked by §2's
golden vectors.

## 6. Migration, docs, testing

- **Migration:** none on disk. Old `EaseIn`/`EaseOut` keyframes auto-render with the
  new cubic curve (§1).
- **Docs:** `docs/data-model.md` (interpolation semantics — note `EaseIn/EaseOut` are
  the named CSS cubics; `Bezier` is a per-segment timing function) and `docs/render.md`
  (the engine-pair resolve now solves a real cubic Bézier). Evergreen tone — no dates
  / phase numbers in `docs/`.
- **Testing:**
  - *Pure unit (vitest):* `UnitBezier` solver (presets hit known midpoints; overshoot;
    degenerate); `smoothKeyframe` (extremum → 0 tangent / no overshoot; `Δv=0` →
    Linear; endpoints; the two-segment write); curve-canvas handle→coeff mapping.
  - *Rust unit (cargo):* `value_at` solver parity cases; `smooth` transform twin if
    the smoothing also lives in Rust (decide in plan — TS-only is acceptable since
    Smooth only *produces* `Bezier` data that both engines already resolve identically;
    keeping smoothing TS-only avoids a third math mirror).
  - *Cross-language:* expanded `animated.golden.test.ts` fixture (§2) — the gate.
  - *One e2e (real WebView2):* author a custom Bézier (or Smooth) on an opacity track,
    export, sample frames to confirm the eased value matches the curve at sampled
    times (extends `keyframe_authoring.e2e.js`).

## Out of scope (this round) / future

- **Model A** — per-keyframe in/out handles, a value-time graph-editor panel, live
  auto-smooth that re-computes when neighbours move. Revisit only if real recurring
  demand for per-keyframe handle shaping appears; the schema migration is the only
  one-way door.
- **`Animated<Rgba>` / colour keyframes** — needs a Rust `value_at` twin for `Rgba`
  first (dual-engine rule); colour easing rides on that, not this.
- **`rotation_deg` stopwatch row** — backend supports the param; the inspector
  descriptor (`animatableParams`) doesn't expose it yet. Independent small gap.
- **MCP keyframe tools** — orthogonal; `update_layer_param_track` exists for them to
  build on.
- **Editable numeric coefficient entry** in the editor (drag-only in v1).

## Related

- `docs/superpowers/specs/2026-06-14-keyframe-authoring-design.md` — the authoring
  loop (stopwatch/diamonds/write-path) this extends; §7 deferred Bézier to here.
- `docs/superpowers/specs/2026-06-11-timeline-redesign-design.md` — the keyframe
  paradigm + sub-lanes the editor's entry points live on.
- `docs/data-model.md` — `Animated<T>` / `Interpolation`, snap storage invariant.
- `docs/render.md` — the single per-frame resolution point shared by preview + export.
