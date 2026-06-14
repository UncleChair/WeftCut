# Keyframe Authoring (Timeline Redesign Phase 2): Stopwatch, Diamonds, Write Path

**Date:** 2026-06-14
**Status:** Approved design, pending implementation plan

## Goal

Make `Animated<f64>` properties authorable. The data model (`AnimTrack<T>`),
both interpolation engines (Rust `state/animated.rs::value_at` ≡ TS
`render/animated.ts::resolveAnimated`, golden-vector locked), and the per-frame
IPC/eval path (`resolveView.ts`, preview + export Worker share it) already ship —
today every animatable field is authored only as a `Static` scalar. This phase
adds the **authoring loop**: a per-property stopwatch + auto-key in the property
panel, collapsed-mode keyframe diamonds on the clip, the actor write path that
persists keyframes, and the trim/split rules that keep keyframes glued to content.

This is **Phase 2** of the timeline redesign
(`2026-06-11-timeline-redesign-design.md`). Phase 1 (decompose + visual refresh +
track header) and the audio×A/B-roll refinement have shipped. Phase 3 (expanded
per-property sub-lanes) is explicitly **out of scope** here and follows once this
authoring loop lands.

## Decisions (settled during brainstorming)

- **Property exposure = property list + per-row stopwatch** (the NLE standard —
  AE/Premiere/Resolve/FCP all expose a fixed property list and toggle animation
  per property). NOT menu-to-add-property (that is the DAW/game-engine pattern for
  large/sparse param spaces, which WeftCut only reaches via effects). A menu, when
  effects land, adds the *effect* — its params then join the list as a sub-group,
  each a normal stopwatch row.
- **Architecture = incremental per-kind + a shared `<AnimatableField>` row + a thin
  per-kind descriptor table.** Keep the existing `*Fields` components; factor a
  reusable stopwatch+control+keyframe row; a small `animatableParams(kind)`
  descriptor (the explicit form of today's hardcoded `Animated<f64>` fields) drives
  both the inspector rows and the timeline's diamond enumeration. NOT a fully
  generalized descriptor system now (effect param shapes are undesigned — avoid
  abstracting before they exist); NOT pure hand-wiring (the timeline could not then
  enumerate a layer's animatable properties).
- **Scope = the complete Phase-2 authoring loop**: write path + stopwatch/auto-key +
  collapsed diamonds (focused property) + click/drag/delete/interp-menu + undo +
  preview reflects + the trim/split keyframe transforms.
- **Trim/split = content-anchored** (see §6): keyframes stay glued to source content
  and are never destroyed by trimming.

## 1. Data model & time base (unchanged)

- Keyframe `t_us` is **relative to the layer's `t_start_us`** (the clip's left
  edge), not the source content. The Compositor evaluates each layer per frame at
  `tInLayerUs = compositionTime − t_start_us` via `resolveAnimated` (preview) /
  `value_at` (export Worker) — one resolution point, so keyframed properties hold
  `preview == export` by construction.
- Media-bearing clips carry a **source range** (`src_in`/`src_out`). Trimming the
  IN edge advances `t_start_us` *and* `src_in` by the same delta (content moves
  forward); trimming OUT moves `t_end_us`/`src_out`. This is what makes
  content-anchoring (§6) meaningful.
- v1 animatable set = each kind's `Animated<f64>` struct fields:
  - **VideoClip:** `opacity, scale_x, scale_y, x, y`
  - **ImageOverlay:** `opacity, x, y`
  - **Text:** `x, y, opacity`
  - **Audio:** `gain_db, pan`
  - **Motif:** `x, y, scale_x, scale_y, opacity`
- **Color and Subtitles have NO animatable field in v1.** Color's only continuous
  property is `Animated<Rgba>` (no Rust interpolation engine yet — excluded);
  width/height are `u32`. Motif `props` are plain values, not `Animated<T>`. The
  inspector must not render a dead stopwatch on these — selecting a Color layer
  shows the same non-animatable fields as today.

## 2. Frontend architecture: shared `AnimatableField` row + per-kind descriptor

### Descriptor (`keyframe/descriptors.ts`, new, pure)

```
interface ParamDescriptor {
  paramKey: string;     // "opacity" | "x" | "scale_x" | "gain_db" | "pan" | ...
  labelKey: string;     // i18n key (reuse existing property_panel.* keys)
  fallback: number;     // static fallback (x/y→0, scale/opacity→1, gain/pan→0)
}
function animatableParams(kind: LayerKind): ParamDescriptor[]
```

This is the explicit form of the §1 field table. **Both** the inspector rows and
the timeline diamond enumeration read from it. A kind with no entry (Color,
Subtitles) renders no stopwatches and no diamonds. Unit-tested.

### `<AnimatableField>` (new component)

Renders `[stopwatch] [label] [control children]`. Inputs: the `AnimTrack<number>`
for its `paramKey`, the playhead's layer-local time, and an `onCommitTrack`
callback. Behavior:

- Stopwatch lit ⇔ `track.mode === "Keyframed"`.
- **Display value** = `track.mode === "Keyframed" ? resolveAnimated(track,
  playheadInLayerUs, fallback) : trackStatic(track, fallback)`. This is the real
  change to the `*Fields`: a keyframed field's displayed value tracks the playhead
  (today they read `trackStatic` only).
- The control itself (slider / number field) is passed as children — the existing
  `*Fields` keep owning how each property renders.

### Wiring the existing `*Fields`

Each `Animated<f64>` row in `TextFields`/`VideoClipFields`/`ImageOverlayFields`/
`AudioFields`/`MotifFields` is wrapped in `<AnimatableField>`. Non-animatable rows
(fades, flip, speed, width/height, font family/size, mute) stay plain `<Field>`.
The panel needs the current playhead time (layer-local) — sourced from the
playback transport / project store, converted to `tInLayerUs` for the selected
layer.

### Focus broadcast (`keyframe/focusStore.ts`, new zustand store)

`{ layerId: string | null, paramKey: string | null }`, written when an
`<AnimatableField>` gains focus or its stopwatch is clicked. Drives which property's
diamonds the collapsed clip renders. Fallback when nothing focused: the layer's
first `Keyframed` property in descriptor order; none → no diamonds.

## 3. Write path (Rust actor + IPC, new)

New actor ops:

```
update_layer_param_track  { layer_id, param_key, track: AnimTrack<f64> }
update_layer_param_tracks { entries: Vec<{ layer_id, param_key, track }> }
```

- **Whole-track replacement.** The frontend composes the full `AnimTrack` after any
  add/delete/move/interp edit and sends it. (Batch form = one history step for a
  multi-keyframe gesture.)
- **Actor normalizes rather than rejects:** sort by `t_us`; snap each `t_us` to the
  composition frame grid (the actor-side snap storage invariant); dedupe same-frame
  keys (last write wins).
- **Hard rejections only:** a `Keyframed` track with an empty keyframe array; any
  write to a locked track or locked layer (same convention as locked group members).
- **Recorded in history; one gesture = one commit = one undo step.** Emits
  `project:changed` → UI re-renders (panel + timeline).
- `param_key` is validated against the layer kind's animatable set (an unknown key
  or a key for a non-`Animated<f64>` field is rejected).

## 4. Stopwatch + auto-key semantics

- **Light up** (Static → Keyframed): create the first keyframe at the playhead with
  the current static value.
- **Turn off** (Keyframed → Static): collapse to a Static value evaluated at the
  playhead; discard all keyframes. Destructive but undoable; **no confirm dialog**.
- **Edit value while lit**: upsert a keyframe at the playhead's layer-local time —
  playhead exactly on an existing key updates it, otherwise insert. This is auto-key.
- **Edit value while off**: write Static, as today.
- **Authoring validation:** lighting the stopwatch and auto-key both require the
  playhead to fall within the selected layer's `[t_start_us, t_end_us]` span
  (creating a key outside the visible span is meaningless and would land out-of-
  range immediately). When the playhead is outside, the stopwatch is disabled with a
  tooltip ("move the playhead over the clip to keyframe"); editing the value still
  works for Static fields.

## 5. Collapsed-mode diamonds (`LayerBlock`)

Render the focused property's keyframes as diamonds on the clip body (white, 45°
square per the timeline-redesign visual spec). Interactions:

- **Click**: select the diamond and seek the playhead to it (jump-and-edit).
- **Drag**: horizontal retime, frame-grid snapped, commit on release (one
  `update_layer_param_track`).
- **Del**: delete the selection; deleting the last keyframe auto-collapses the track
  to Static at the current evaluated value.
- **Right-click**: interpolation menu — **Hold / Linear / EaseIn / EaseOut** (Bezier
  is a linear stub in the engine; not offered).

Keyframe times are layer-relative, so diamonds ride along when the clip moves.
Keys pushed outside the clip span by trimming are **kept in data** but not rendered
in collapsed mode (expanded mode renders them dimmed — Phase 3).

## 6. Trim / split vs keyframes — content-anchored (resolves the open TBD)

Using the `src_in` model (§1), keyframes stay glued to source content and are never
destroyed:

- **Move** (`t_start` changes, `src_in` unchanged): keyframes unchanged — they ride
  along. Free.
- **Trim OUT (tail)** (`t_end` decreases): keyframes unchanged; keys with
  `t_us > new_duration` become **out-of-range** — kept in data, hidden in collapsed
  mode (dimmed in Phase-3 expanded mode), restored if the clip is un-trimmed.
- **Trim IN (head)** (`t_start` increases by Δ, `src_in += Δ`): shift every keyframe
  `t_us -= Δ`, so each key stays on the same content frame *and* the same absolute
  composition time. Keys whose `t_us` goes negative are out-of-range (kept, hidden).
- **Split** at composition time P (clip-local offset `p = P − t_start`): the left
  clip keeps keys with `t_us ≤ p`; the right clip inherits keys with `t_us > p`,
  re-based by `t_us -= p`. Every key stays on its content. If a half ends up with
  **zero** keys (all keys fell on the other side), it collapses to `Static` at the
  clamp-boundary value (left → first-key value, right → last-key value) so the half
  keeps the value the clip actually showed instead of the engine fallback.
- **Out-of-range keyframes are never dropped**, so trimming is non-destructive and
  reversible. This requires the layer **validator to permit keyframe times outside
  `[0, duration]`** (it previously rejected them as `KeyframeOutOfRange`); `value_at`
  clamps out-of-range keys at eval and the UI hides them, so they are valid stored
  state, not a defect.

**Implementation:** extend Rust `apply_trim_layer` (IN edge) and `apply_split_layer`
to transform every `Animated<T>` track on the affected layer's params. This is the
work this phase adds beyond pure create/edit/delete — without it, trimming a
keyframed clip's head drifts the animation off its content. The transform lives in
the actor (single source of truth, recorded in history, preview == export).

## 7. Interpolation types & field set

- Offered interpolation: **Hold, Linear, EaseIn, EaseOut**. Bezier is excluded (the
  engine's Bezier arm is a linear stub; authoring a curve editor is later work).
- Animatable fields: `opacity, x, y, scale_x, scale_y, gain_db, pan`. **No
  `Animated<Rgba>`** — color fields get no stopwatch until a Rust `value_at` twin for
  `Rgba` exists (the dual-engine mirror rule forbids a TS-only interpolator).

## 8. Testing

- **Pure unit (vitest):** `descriptors.ts` (`animatableParams` per kind, empty for
  Color/Subtitles); `geometry.ts` additions (layer-local ↔ absolute time, diamond
  hit-testing).
- **Rust unit (cargo test):** `update_layer_param_track` normalization
  (sort/frame-snap/same-frame-dedupe/empty-reject/locked-reject); the trim/split
  keyframe transforms (IN-edge `-Δ` shift + out-of-range retention, OUT-edge
  retention, split partition + re-base).
- **One e2e (real WebView2, wdio harness):** select a clip → light a property's
  stopwatch → auto-key two frames → drag a diamond → export and sample frames to
  verify the animation took effect. This also closes the known keyframed-gain e2e
  gap.
- The interpolation engines themselves need no new tests — the cross-language
  golden-vector fixture already locks `value_at ≡ resolveAnimated`.

## Out of scope (this phase) / future

- **Phase 3:** expanded per-property sub-lanes (`KeyframeLane`), marquee box-select,
  cross-property/cross-layer multi-drag, prev/next-key navigation, dimmed out-of-
  range rendering.
- **`Animated<Rgba>`** + a color stopwatch (needs the Rust interpolation twin first).
- **Bezier interpolation authoring** (engine arm is a linear stub) + keyframe glyph
  shape variants per interp type.
- **Effect parameters** (the effect subsystem is separate; its params will reuse the
  `<AnimatableField>` row + a descriptor derived from the effect schema).
- **MCP keyframe tools** (`add_keyframe` / `update_keyframe` / `remove_keyframe`) —
  a natural follow-on once `update_layer_param_track` exists.

## Related

- `docs/superpowers/specs/2026-06-11-timeline-redesign-design.md` — §4–6 (the
  keyframe-authoring behavior this implements; Phase 3 sub-lanes).
- `docs/superpowers/plans/2026-06-10-keyframe-ipc-animtrack.md` — the merged IPC/eval
  foundation (`AnimTrack<T>` over the wire, `resolveView.ts`).
- `docs/data-model.md` — `Animated<T>` / `AnimTrack<T>`, layer source range, snap
  storage invariant.
- `docs/render.md` — the single per-frame resolution point shared by preview and
  export.
