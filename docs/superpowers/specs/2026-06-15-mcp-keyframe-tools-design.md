# MCP Keyframe Authoring Tools

**Date:** 2026-06-15
**Status:** Designed; not yet implemented.

## Goal

Give external AI agents (via the MCP surface) the ability to author keyframes.
Today the MCP server has **zero** keyframe tools — the only adjacent tool,
`update_layer_params`, sets *static* values and explicitly **wipes** any
existing keyframes. So an agent cannot create, edit, retime, re-ease, smooth, or
delete a keyframe at all, even though the rest of the stack is complete:

- `Animated<f64>` data model + both interpolation engines (Rust
  `state/animated.rs::value_at` ≡ TS `render/animated.ts::resolveAnimated`,
  golden-locked) ship.
- The actor write path ships: `update_layer_param_track(layer, param_key,
  Animated<f64>)` writes a whole track and normalizes it (snap-to-frame / sort /
  dedupe), rejecting empty `Keyframed` tracks, unknown params, and locked tracks.
  `update_layer_param_tracks` is the batch (one-undo) form.
- The keyframe-edit math ships **in TS only** (`keyframe/edits.ts`): pure
  transforms (`upsertKeyframe`, `removeKeyframe`, `retimeKeyframe`,
  `setKeyframeInterp`, `smoothKeyframe`, `smoothTrack`, `liftToKeyframed`,
  `collapseToStatic`) that the UI applies client-side, then ships the whole
  track over IPC.

This spec adds the agent-facing keyframe authoring surface on top of the
existing write path, and ports the keyframe-edit math to a shared Rust module so
the MCP server can run it server-side.

## Decisions (settled during brainstorming)

- **Granularity = granular semantic tools + a low-level escape hatch.** Each
  keyframe operation is its own tool (matching the existing high-level MCP
  style: `split_layer`, `trim_layer`, `groups_create`…), plus one
  `set_param_track` that takes a whole `AnimTrack<f64>` for bulk/power use. NOT
  whole-track-only (would push keyframe math + read-modify-write onto the agent).
- **Param scope = the existing f64 surface only.** `x`, `y`, `scale_x`,
  `scale_y`, `rotation_deg`, `opacity`, `gain_db`, `pan` — exactly what the data
  model already animates. Color / `Animated<Rgba>` keyframes are explicitly out
  of scope (a separate project touching data model + resolver + renderer + IPC +
  UI).
- **Where the math runs = MCP handler-side read-modify-write, reusing the
  existing actor command.** Each handler does snapshot → apply pure Rust
  transform → `update_layer_param_track`. NO new actor command. Reuses the
  already-tested normalization, validation, lock check, and history. Accepts two
  known limitations (see §3): the read-modify-write isn't atomic against a
  concurrent UI edit, and history labels stay generic. Both are acceptable —
  every existing MCP edit tool uses the same snapshot-then-command pattern, and
  agent-mode (`begin_agent_session`) flips the human UI to record-only so
  concurrent edits don't happen.
- **Time convention = timeline-absolute microseconds everywhere.** All `t_us`
  inputs/outputs are timeline-absolute, converted to layer-local
  (`t − t_start_us`) inside the handler. Matches every other MCP tool and how
  agents reason about the timeline.

## 1. Tool surface

One read tool, six semantic write tools, one escape hatch. All take
`layer_id` (UUID string) and `param_key` (string). All write tools route through
`update_layer_param_track`, inheriting its snap/sort/dedupe normalization,
empty-track rejection, `UnknownKeyframeParam` / `LayerNotFound` / `TrackLocked`
errors, and history entry.

### `get_param_track(layer_id, param_key)`
Returns the current track flattened for the agent:
```json
{
  "mode": "Keyframed",
  "fallback": 1.0,
  "keyframes": [
    { "id": "<uuid>", "t_us": 5000000, "t_local_us": 0, "value": 0.0, "interp": { "kind": "Linear" } },
    { "id": "<uuid>", "t_us": 6000000, "t_local_us": 1000000, "value": 1.0, "interp": { "kind": "Linear" } }
  ]
}
```
`t_us` is timeline-absolute; `t_local_us` is layer-local (the stored base) for
reference. For a `Static` track, `keyframes` is empty and `mode` is `"Static"`
with the static value surfaced as `fallback`. Partly redundant with the
`project://layers/{id}` resource, but flattened, timeline-absolute, and
purpose-built so the agent can discover keyframe ids before editing.

### `set_keyframe(layer_id, param_key, t_us, value, interp?)`
Insert-or-update (upsert). A `Static` track is lifted to `Keyframed` with this
as the only key. An existing key at the same frame (after snap) is updated in
place. Otherwise a new key is inserted; `interp` defaults to the preceding key's
interp, else `Linear`. `interp` (optional) is the interpolation wire object.

### `remove_keyframe(layer_id, param_key, keyframe_id)`
Remove one key by id. When it was the last key, the track collapses to `Static`
holding that key's value (so the property keeps its on-screen value), matching
the TS `removeKeyframe` semantics.

### `retime_keyframe(layer_id, param_key, keyframe_id, t_us)`
Move one key to a new timeline-absolute time. Re-sorts. Keys may legitimately
land outside `[t_start, t_end]` (consistent with trim/split keeping out-of-range
keys).

### `set_keyframe_easing(layer_id, param_key, keyframe_id, interp)`
Set the easing of the **outgoing** segment governed by this key. `interp` is the
wire object: `{"kind":"Hold"}`, `{"kind":"Linear"}`, `{"kind":"EaseIn"}`,
`{"kind":"EaseOut"}`, or `{"kind":"Bezier","p1":[x,y],"p2":[x,y]}`.

### `smooth_keyframes(layer_id, param_key, keyframe_id?)`
Bake monotone (no-overshoot) C1 tangents. With `keyframe_id`, smooths that one
key (its incoming + outgoing segments); without, smooths every interior key in
one write. Mirrors TS `smoothKeyframe` / `smoothTrack`.

### `clear_keyframes(layer_id, param_key, value?)`
Collapse the track to `Static`. `value` (optional) is the static value to hold;
when omitted, defaults to the **first** keyframe's value (what the track clamps
to before its start). No-op on an already-`Static` track. Partly overlaps
`update_layer_params`' static-set, but is kind-agnostic and explicit about
intent.

### `set_param_track(layer_id, param_key, track)`
Low-level escape hatch. `track` is a whole `AnimTrack<f64>` wire value
(`{"mode":"Static","value":n}` or `{"mode":"Keyframed","value":[{id,t_us,value,
interp}…]}`), with keyframe `t_us` given **timeline-absolute** (converted to
layer-local before the write, to keep one convention across the surface). Maps
directly to the existing `update_layer_param_track`. For bulk authoring or
shapes the granular tools don't express.

### Valid `param_key` per layer kind
Validated for free by the actor (`resolve_animated_f64_mut` → `None` yields
`UnknownKeyframeParam`); the tool descriptions enumerate them for discovery:

- **VideoClip, Motif** → `x`, `y`, `scale_x`, `scale_y`, `rotation_deg`, `opacity`
- **ImageOverlay, Text** → `x`, `y`, `rotation_deg`, `opacity`
- **Audio** → `gain_db`, `pan`
- **Color, Subtitles** → none

`rotation_deg` is resolvable in Rust and evaluated by the renderer, so it is
exposed here even though the timeline UI does not yet surface a `rotation_deg`
sub-lane (the TS `animatableParams` descriptor omits it). This is a deliberate,
harmless asymmetry — adding the UI sub-lane is separate work.

## 2. Architecture

New pure module **`src-tauri/src/state/keyframe_edits.rs`** mirroring
`apps/desktop/src/keyframe/edits.ts`:

- `upsert(track, t_local_us, value, interp: Option<Interpolation>) -> Animated<f64>`
- `remove(track, id, fallback) -> Animated<f64>`
- `retime(track, id, new_t_local_us) -> Animated<f64>`
- `set_interp(track, id, interp) -> Animated<f64>`
- `smooth_one(track, id) -> Animated<f64>` and `smooth_all(track) -> Animated<f64>`
- `lift_to_keyframed(value, t_local_us)` / `collapse_to_static(track, value)`
- helpers `tangent_at` and `interp_to_coeffs` (the `Hold`/`Linear` → diagonal,
  named-ease / `Bezier` → coords table — port of `keyframe/curve.ts`).

These are pure `Animated<f64> -> Animated<f64>` transforms. They need only stay
self-consistent; the actor re-normalizes (snap/sort/dedupe) on write.

**MCP handlers** (in `mcp/mod.rs`, new "Keyframe tools" section):
1. `parse_uuid` the layer id; take `self.project.snapshot()`.
2. Locate the layer; compute `t_local = t_us − layer.t_start_us` for time args.
3. Read the current `Animated<f64>` for `param_key` (clone from the snapshot via
   the same `resolve_animated_f64_mut`-shaped lookup, or a read-only sibling).
   `get_param_track` stops here and serializes.
4. Apply the pure transform.
5. Write back via `self.project.update_layer_param_track(agent_actor(), id,
   param_key, new_track)`, mapping `CommandError` with `map_command_error`.

No new `Command` variant, no new `ProjectHandle` method. `set_param_track`
deserializes the wire `AnimTrack`, converts keyframe times to layer-local, and
goes straight to step 5.

## 3. Known tradeoffs (accepted)

- **Non-atomic read-modify-write.** Between snapshot and write, a concurrent UI
  edit to the same track could be lost (last-write-wins on the whole track).
  Accepted: identical to every existing MCP edit tool, and agent-mode puts the
  human UI in record-only mode. The clean alternative — a new atomic
  `Command::EditKeyframe { layer, param_key, op }` doing read-transform-write
  inside the actor lock, with per-op semantic history labels — is **deferred**.
- **Generic history labels.** Reusing `update_layer_param_track` means undo shows
  its generic label, not "Delete keyframe" / "Smooth keyframes" etc. Acceptable
  for v1; the deferred atomic command would fix this.

## 4. Cross-language drift mitigation

This adds a third Rust↔TS twin that must stay behavior-identical, alongside the
engine-source pair (`feedback_engine_source_drift`) and the snap-math pair
(`feedback_snap_math_drift`), neither of which has an enforcing test. To not make
the drift surface worse:

- Add a **cross-language golden fixture** `keyframeEditsGolden.fixture.json`
  (sibling of `animatedGolden.fixture.json`): each case = a fixed input track + an
  op + args → the expected output track. A Rust test (`keyframe_edits.rs`) and a
  TS test (`keyframe/edits.golden.test.ts`) both assert against it.
- IDs are random, so: `remove`/`retime`/`set_interp`/`smooth` preserve ids and
  are asserted exactly; for `upsert` of a brand-new key, the generated id is a
  wildcard and only `t_us`/`value`/`interp`/ordering are asserted.

## 5. Edge cases & validation

- **Empty result** — any op that would leave a `Keyframed` track with zero keys
  is impossible by construction (`remove` of the last key collapses to `Static`);
  the actor's empty-track rejection is the backstop.
- **Unknown `keyframe_id`** for remove/retime/set_easing/smooth → the transform is
  a no-op on a missing id; the tool returns a clear "keyframe id not found on
  (layer, param)" error rather than silently no-op-ing.
- **Wrong `param_key` for the layer kind** → `UnknownKeyframeParam` from the actor,
  surfaced verbatim.
- **Locked track** → `TrackLocked`, surfaced verbatim.
- **Snap collisions** — two keys snapping to the same frame are deduped
  last-write-wins by the actor (existing behavior); the agent isn't responsible
  for frame alignment.
- **Composition duration** — writing keyframes never changes a layer's
  `t_start`/`t_end`, so no autofit (confirmed in `apply_update_layer_param_track`).

## 6. Testing

- **Rust unit tests** on `keyframe_edits.rs` (each transform; the collapse-to-
  Static-on-last-remove case; smoothing tangents).
- **Golden fixture** asserted from both languages (§4).
- **MCP smoke test** that actually invokes the new tools end-to-end (per the
  "emit smoke tests" rule — string-match unit tests miss tool-integration grammar
  bugs): `set_keyframe` twice → `get_param_track` shows two keys → `retime` →
  `set_keyframe_easing` → `remove` one → `remove` the last collapses to `Static`.
- Existing actor tests for `update_layer_param_track` already cover the write
  path's normalization/validation; not re-tested here.

## 7. Documentation

Update `docs/mcp.md` to document the keyframe tool surface (evergreen — no phase
numbers, dates, or commit hashes; phase history lives in git + memory).

## Out of scope

- Color / `Animated<Rgba>` keyframes.
- The atomic `Command::EditKeyframe` actor command + per-op semantic undo labels.
- A `rotation_deg` timeline UI sub-lane (the param is exposed via MCP regardless).
- Multi-param batch keyframe tools (`update_layer_param_tracks` exists at the
  actor level; no agent demand yet — revisit if needed).
