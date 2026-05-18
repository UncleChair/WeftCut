# Effects routing — Pass B (multi-window) + Pass A standalone fix

**Status:** Design only as of 2026-05-18. Pass A (per-layer/group
envelope routing) shipped earlier the same day in commits `947c0a5`,
`369496c` (doc), `7ecafcb` (viewport fix); see
`memory/project_effects_routing.md` for that summary. This doc
proposes Pass B (per-time-window routing) on top of Pass A and folds
in a Pass A gap discovered during design: standalone layers (not in
any group) with keyframed effects are silently dropped at export.

Builds on [[html-render-groups]] (the composition + raster
infrastructure), [[group-system]] (the group model + fan-out edits),
and the existing IR `Overlay { gate_start_us, gate_end_us }` time
gating.

---

## Problem

Pass A routes per-layer or per-group: if any keyframed `Animated<T>`
parameter is present, **the entire layer/group lifetime renders via
html-cap**. A 30-second clip with a 2-second blur kick from 14s to
16s rasterizes 30 seconds of HTML composition through headless
Chromium even though 28 of those seconds have a static blur radius
that `gblur=sigma=N` could produce in a fraction of the time.

Two motivating user patterns expose this:

- **Single short kick on a long layer.** Blur kick, transform pulse,
  rotation flick — all visually brief, all currently force the whole
  surrounding layer onto html-cap.
- **Multi-effect layers where only one is keyframed.** A layer with
  static ColorCorrect plus a 2s keyframed Blur pays full html-cap
  cost for both effects across the layer's full span.

Plus the **standalone Pass A gap**: `lower.rs:86-114` only routes via
`html_group_by_layer` for layers that are members of an html-required
group. A keyframed-effect layer **not** in any group falls into
`apply_static_effects`, which silently drops keyframed effects. The
layer exports with no effect at all. No error, no warning. Authors
who keyframe an effect on a free-standing layer discover the bug
post-export.

Pass B narrows the html-cap rendering window to only the time
intervals where parameters are actually animating, keeping held-tail
intervals on the fast ffmpeg path. The standalone gap is fixed
synchronously because the same code path that builds the "effective
group" list for Pass B can synthesize singleton groups for ungrouped
html-required layers.

---

## The decision contract

These twelve choices define the architecture. Phases below assume
them.

### 1. Unit of routing — per-group, multi-window

The unit stays the group (matches Pass A and html-render-groups
decision 2). What changes is that one group can now produce
**multiple time-disjoint renders** — N html-cap windows for the
animating segments plus M ffmpeg-static segments for the held gaps —
all stacking on the same Overlay chain via mutually-exclusive gates.

Per-effect or per-layer slicing was considered and rejected for v1:
group-level effects (HtmlTransform on the group) compose against the
whole composition, so the rendering boundary has to coincide with
the group boundary. Per-effect granularity adds significant
implementation cost (the held-effect substitution would have to
fragment per effect, not per gap) for marginal additional savings.

### 2. Pass A fix — synthetic singleton groups (Option α)

Before walking real groups, both `lower.rs` and `ir/materialize.rs`
compute the set of ungrouped html-required layers and synthesize a
singleton `Group` per layer. The synthesized group is **ephemeral**:
never persisted, never visible to UI, exists only during the
lower/materialize pass.

**Synthesize only for layers not in any real group.** A layer that's
both in a real group AND html-required is already routed via the
real group's `html_group_by_layer` entry; synthesizing a second
singleton would double-route it (two materializations + two
overlays). The `effective_groups` iterator filters
`ungrouped_html_required` against the union of all real groups'
members before synthesizing.

The synthesized `GroupId` is a **deterministic function of the
LayerId** — namespaced UUID `uuid_v5(NS_SYNTHETIC_GROUP, layer_id)`
or equivalent — so the html-cap cache key remains stable across
re-renders of identical project state. A random per-pass id would
cache-miss every re-render.

Alternatives rejected:

- *Reject keyframed effects on ungrouped layers at edit time.*
  Hostile UX; the user has to group-then-keyframe rather than
  keyframe-then-group.
- *Auto-create a persistent singleton group at edit time.* Pollutes
  the user's group list with one-off groups they didn't ask for.
- *Per-layer html-cap path with no group at all.* Doubles the
  materialize/lower surface; the singleton-group trick reuses the
  existing group path verbatim.

### 3. Animating-run analysis — continuous interpolation only

**Interp-direction convention** (verified against `engine.ts:393-416`
`resolveAnimated`): the segment `[kf[i].t_us, kf[i+1].t_us)` is
governed by **`kf[i].interp`** — the LEFT keyframe's interp kind.
Same convention as the preview/composition engine; the analysis must
match or Hold tracks get classified as animating (and vice versa).

For each `Animated<T>` on each effect on the group + each member
layer:

- **Per adjacent keyframe pair** (`kf[i]`, `kf[i+1]`) with
  `kf[i].interp` in `{ Linear, EaseIn, EaseOut, Bezier }` AND
  `kf[i].value != kf[i+1].value`: contribute the interval
  `[kf[i].t_us, kf[i+1].t_us)` (in owner-local time) as an
  **animating run**.
- **Hold interpolation contributes no animating run.** When
  `kf[i].interp == Hold`, the value is constant `kf[i].value` over
  `[kf[i].t_us, kf[i+1].t_us)`; the value steps to `kf[i+1].value`
  at `t = kf[i+1].t_us`. The step is handled by the gap-fragmentation
  rule (§4), not by emitting a width-1 animating window.
- **Equal-value pair on continuous interp** also contributes nothing
  — no motion to render. Cheap optimization; degenerates correctly
  when authors keyframe a parameter and then drag both keys to the
  same value.

Convert all owner-local times to main-timeline times by adding
`layer.t_start_us` (for layer effects) or
`group.earliest_member.t_start_us` (for group effects), then union
overlapping intervals.

### 4. Gap fragmentation at Hold-step boundaries

Take the complement of the union of animating runs over the group's
`[group_t_start, group_t_end)` span → candidate static gaps. **Then
split each gap at every Hold-step keyframe time across all keyframed
fields on the group.**

Concrete example. `Blur { radius: [0:0 Hold, 5:8 Hold, 10:8 Hold] }`
on a 10s layer:

- Animating runs: none (every left-interp is Hold).
- Candidate static gap: `[0, 10)`.
- Hold-step boundaries inside the gap: `5` (the value steps from 0
  to 8 at the second keyframe's time).
- Fragmented gaps: `[0, 5)` at sigma=0, `[5, 10)` at sigma=8.

Without the fragmentation step, the ffmpeg path would emit one
overlay for `[0, 10)` with some single sigma value — wrong pixels on
one half of the gap.

### 5. Held-value-is-identity per gap

For each fragmented gap, compute each effect's held value at the
gap's start (equals its value at the gap's end since the gap is by
construction static). If **any** effect's held value is **non-identity**,
**absorb the gap into html-cap** by extending the surrounding
animating window. Repeat the absorb-and-merge until the gap set
stabilizes.

This rule keeps the ffmpeg-static path semantically correct:
ffmpeg can replicate "no effect" cheaply but can't replicate
"composed group rotated 90 degrees as a unit" without going through
the composition pipeline.

**Identity definition per effect kind (v1):**

| Effect          | Identity                                                  |
|-----------------|-----------------------------------------------------------|
| Blur            | `radius == 0`                                             |
| ColorCorrect    | `brightness == 1 && contrast == 1 && saturation == 1 && gamma == 1` |
| ChromaKey       | `similarity == 0 && smoothness == 0` (effectively no key) |
| Speed           | `factor == 1`                                             |
| Vignette        | `amount == 0`                                             |
| HtmlTransform   | `x == 0 && y == 0 && scale_x == 1 && scale_y == 1 && rotation == 0 && opacity == 1` |

Float comparison uses `(a - 1.0).abs() < 1e-6` style tolerance; the
identity check is rounded near user-authored exact values.

### 6. Per-window materialization

Replace today's `HtmlGroupRenders: GroupId → HtmlGroupRenderInfo`
with `HtmlGroupWindowedRenders: GroupId → Vec<(WindowSpec,
HtmlGroupRenderInfo)>`. `materialize_html_groups` walks effective
groups, runs the time-windows analysis (§3–§5), and produces one
PngSeq per html-cap window. Each window's `HtmlGroupRenderInfo`
records its main-timeline `(start_us, end_us)`; `lower.rs` reads
that to construct gates.

### 7. Per-window cache key + window-local CompositionState

Two related but distinct concerns; B.4 must ship both.

**(a) Cache discrimination across windows.**
`raster/html_group.rs::state_hash(state)` becomes
`state_hash(state, window)` — `(w_start_us, w_end_us)` participate
in the hash. Cache dir layout:
`<cache>/raster/<state_hash_for_window>/`. Editing keyframes inside
window A doesn't invalidate window B's cached PngSeq.

**(b) Per-tick correctness inside a window.**
The `CompositionState` passed into materialization must capture
**only the window-local animation** — the engine's per-tick
`resolveAnimated` walks the embedded keyframe tracks and would
otherwise resolve out-of-window keyframes against the wrong
composition-local time. See §8 for the rebase math.

Without (a), the hash collides across windows; without (b), the
captured pixels are wrong even when the cache works. Implement and
test both at the same time.

### 8. Window-local keyframe rebase

`materialize_html_groups` today emits composition layers with
`t_start_us: l.t_start_us - group_t_start_us`. The keyframe times
inside `Animated::Keyframed(kfs)` are layer-local (relative to
`layer.t_start_us`). For a narrow window `[w_start, w_end)`, the
engine's clock runs `0 .. (w_end - w_start)`. So a layer-local
keyframe at `kf.t_us` must appear at composition-time
`(layer.t_start_us + kf.t_us) - w_start`.

The materializer must perform this **full keyframe-time rebase**, not
just the `t_start_us` shift it does today. Verify with a fixture
where keyframes at non-zero layer-local times still play at the
right composition time inside a narrow window.

### 9. Per-gap lowering

Each fragmented static gap emits one Overlay-with-gate per group
member, with:

- `t_start_us` / `t_end_us` clipped to the gap (intersect with
  `[layer.t_start_us, layer.t_end_us)` — members not active in the
  gap contribute no overlay).
- `VideoClip` / `Audio` `src_in_us` / `src_out_us` advanced via the
  rebase logic in `lower_range::rebase_layer_for_segment`. **Extract
  just the visual-layer pieces; don't reuse `lower_range` whole** —
  it drops audio (was for the deleted preview-segmented-cache path)
  and doesn't substitute held effects.
- Effects list with every keyframed effect replaced by
  `Static(held_value_at(gap_start))`; static effects pass through
  unchanged. The existing `apply_static_effects` then lowers each to
  its IR node (Gblur today; ColorCorrect, Vignette as they land).

Audio members of an effective group still flow through the regular
audio path regardless of windowing — html-cap mode is visual-only
(html-render-groups decision 7), and audio inside a partially
windowed group is no different.

### 10. Frame-snap at analysis stage

Round animating-run starts **down** and ends **up** to canvas-fps
multiples **before** either path consumes the windows. Snap happens
in `Group::time_windows`, not at emit time, so both branches see the
same numbers.

```text
snap_floor(t_us)   = floor(t_us * fps / 1e6) * 1e6 / fps
snap_ceil(t_us)    =  ceil(t_us * fps / 1e6) * 1e6 / fps
```

Optional defensive measure: emit each ffmpeg-static gap with **one
frame of overlap** into the adjacent html-cap window, so a sub-frame
PngSeq misalignment is covered by the held-value ffmpeg frame
underneath. The PngSeq overlay on top hides it when alignment is
correct; if alignment is off, the held frame fills the seam instead
of producing transparency-bleed. Cheap insurance; opt-in via a
constant.

### 11. Synthetic singleton group id determinism

The Pass A fix's synthetic groups derive their `GroupId` from a
deterministic namespaced UUID seeded by the LayerId:

```rust
const NS_SYNTHETIC_GROUP: Uuid = uuid!("0a9c…");
GroupId(Uuid::new_v5(&NS_SYNTHETIC_GROUP, layer_id.as_bytes()))
```

The same layer always synthesizes the same group id, so:

- Per-window `state_hash` outputs stay stable across re-renders.
- Cache reuse works.
- The synthetic id never collides with a real (`Uuid::new_v4`) group
  id (v5 vs v4 version field).

### 12. Documented degenerate case — non-identity tail

The held-value-is-identity rule (§5) means **an effect that doesn't
return to its identity outside the animating runs gets absorbed all
the way to one of the group's edges**, eliminating Pass B's savings
on that side.

Concrete example. `HtmlTransform { rotation: [0: 0deg, 5: 90deg] }`
on a 30s group:

- Animating run: `[0, 5)`.
- Candidate gap: `[5, 30)`. Held rotation at t=5 is 90deg —
  non-identity.
- Absorb: html-cap window extends to `[0, 30)`.
- Result: **same as Pass A**, no tail savings.

Compare with `rotation: [0: 0deg, 5: 90deg, 10: 0deg]` on the same
group:

- Animating runs: `[0, 5)` and `[5, 10)`.
- Gap: `[10, 30)`. Held = 0deg — identity.
- html-cap window: `[0, 10)`. ffmpeg-static gap: `[10, 30)`. Savings.

User-facing rule that falls out of this:

> Pass B's savings apply when the value outside animating runs is
> the effect's identity. A rotation that ends at 90° gets no help;
> one that returns to 0° does.

Document in the property panel hint for keyframable effects so
authors don't discover this via export-time benchmarks.

---

## Architecture in one paragraph

For each effective group (real plus synthetic singletons for
ungrouped html-required layers), the lower pass runs a
**time-windows analysis** that walks every keyframed `Animated<T>`,
emits one animating run per continuous-interp adjacent keyframe pair
with distinct values, takes the complement, fragments at every
Hold-step boundary, then absorbs any non-identity-held gap back into
the surrounding html-cap window. Animating runs and surviving gaps
both snap to canvas-fps frame boundaries. Each animating run emits
one `materialize_html_group` call with the window's
`(start_us, end_us)` and a window-local keyframe rebase; each gap
emits one Overlay-with-gate per member layer with the keyframed
effects substituted by their held-Static value at the gap's start.
All overlays gate to mutually exclusive time intervals and stack on
the same base. Synthetic singleton groups derive a deterministic
namespaced UUID from the LayerId so the html-cap cache key stays
stable across re-renders. The Pass A standalone gap (keyframed
effect on ungrouped layer silently dropped) is fixed by the same
synthetic-group pass.

---

## Phase plan

Six phases. The doc itself (B.0) is delivered with the design
contract above; B.1 lands the analysis helpers; B.2 ships the Pass A
fix as a standalone improvement (early value); B.3–B.5 wire Pass B
end-to-end; B.6 surfaces telemetry. The phases are sized so each
lands a self-contained, tested improvement.

### Phase B.0 — Design doc (this file) (~half a day)

**Deliverable:** `docs/effects-routing-pass-b.md` (this doc). Decision
contract reviewed and accepted before implementation starts.

**Verification.** User sign-off on the twelve decisions.

### Phase B.1 — Analysis helpers + unit tests (~1.5 days)

Land the pure-function building blocks. No code path consumes them
yet; the next phases will.

**New methods:**

- `Animated<T>::animating_runs() -> Vec<(TimeUs, TimeUs)>` —
  owner-local intervals from §3 (continuous-interp, distinct-value
  pairs only).
- `Animated<T>::hold_step_times() -> Vec<TimeUs>` — owner-local
  timestamps where a Hold-step occurs.
- `Animated<T>::value_at(t_us: TimeUs) -> T` — resolves the value,
  including clamp-to-boundary outside the keyframe range. Required
  by `Effect::held_at`.
- `Effect::animating_runs(owner_t_start: TimeUs) -> Vec<(TimeUs, TimeUs)>`
  — union across the effect's keyframed fields, rebased to
  main-timeline.
- `Effect::hold_step_times(owner_t_start: TimeUs) -> Vec<TimeUs>`
  — same shape.
- `Effect::held_at(t_us: TimeUs) -> Effect` — returns a copy with
  every `Animated<T>` field replaced by `Static(value_at(t_us))`.
- `Effect::is_identity() -> bool` — per the table in §5.
- `Group::time_windows(layer_lookup, canvas_fps) -> TimeWindows`
  where `TimeWindows { html_caps: Vec<TimeWindow>, static_gaps:
  Vec<TimeWindow> }`. Implements §3–§5 + §10 frame-snap end to end.

**Verification.** Pure unit tests:

- Single Animated track with two distinct-value Linear keyframes →
  one animating run.
- Hold-step at boundary → no animating run, one hold_step_time.
- Equal-value Linear pair → no animating run.
- Non-identity tail → absorbed gap.
- Frame-snap rounds correctly at fps=30 and fps=29.97.
- Multi-effect group → union of intervals.
- Synthetic singleton scenario (test the `Group::time_windows` works
  on a one-member group with layer-level effects).

### Phase B.2 — Pass A fix: synthetic singleton groups (~1 day)

Ship the standalone-layer fix as a self-contained improvement.

**Modified files:**

- `apps/desktop/src-tauri/src/state/ids.rs` — `GroupId::synthetic_for_layer(LayerId) -> GroupId`
  using `uuid::Uuid::new_v5(&NS_SYNTHETIC_GROUP, layer_id.as_bytes())`.
  Document the v5-vs-v4 collision guarantee.
- `apps/desktop/src-tauri/src/state/group.rs` — `effective_groups<'a>(project) -> impl Iterator<Item = Cow<'a, Group>>`
  that yields real groups followed by one synthetic singleton per
  ungrouped html-required layer. Both `lower.rs` and `materialize.rs`
  consume this iterator instead of `project.groups.iter()`.
- `apps/desktop/src-tauri/src/ir/lower.rs` — replace the
  `for g in project.groups.iter()` walk at L98 with `effective_groups(project)`.
- `apps/desktop/src-tauri/src/ir/materialize.rs` — same replacement
  in `materialize_html_groups` (L269).

**Verification.**

- Existing 339 lib tests still pass.
- New test: a standalone VideoClip layer with `Blur { radius: kf[1:0, 2:8, 3:0] }`
  exports a real blur effect (the keyframe authoring is preserved).
  Pre-fix: silently drops to no blur. Post-fix: rasterizes via html-cap.
- New test: synthetic group id is stable across two consecutive
  lower calls on the same project state.

**Why ship this before B.3:** it's a correctness fix (silent
data loss bug); independent of the multi-window machinery; the same
`effective_groups` plumbing B.3 needs. Decouples user-visible
unblocking from the longer multi-window implementation.

### Phase B.3 — Per-gap lowering helper (~2 days)

New helper that lowers a group's members at a sub-window with
held-effect substitution.

**New code:**

- `apps/desktop/src-tauri/src/ir/lower.rs::lower_group_static_gap(
    g: &mut IRGraph, group: &Group, members: &[&Layer], gap: TimeWindow,
    project: &Project, target: RenderTarget, …) -> Result<NodeId, LowerError>`
  — emits one Overlay per member active in the gap, gated to the
  gap's `[start, end)`, with effects substituted.
- Extract the visual-layer rebase from `rebase_layer_for_segment`
  into a smaller helper that doesn't touch audio and doesn't drop
  Templates (Template members are §11 of html-render-groups —
  inside the composition island; for the static-gap path they need
  a fallback decision: either render Template members via the
  existing PngSeq path with effects held, or skip-with-warn for v1).

**Template members in a static gap: skip-with-warn.** Matches the
existing Template handling inside html-render-groups (decision 9's
known v1 limitations). Rendering Templates via the existing template
PngSeq path with held effects applied is a real chunk of work and
has no corresponding user pull yet; revisit when one lands.

**Verification.**

- Unit test: a 30s layer split into html-cap `[14, 16)` + static
  gaps `[0, 14)` and `[16, 30)`. Inspect emitted IR — Overlay nodes
  with the right gates, decoded inputs deduped.
- Held-effect substitution test: a static gap inherits the keyframed
  Blur's value at the gap boundary, emitted as `Gblur=sigma=...`.

### Phase B.4 — Per-window materialization + cache key (~2 days)

**Prerequisite check (10 minutes, before any code):** verify the
existing rasterizer-cache LRU policy walks
`<cache>/raster/<state_hash>/` regardless of nesting depth. If it
only enumerates the top level, multi-window cache growth is a real
bug — not a documented risk. Grep `cache::evict` / equivalent;
adjust the LRU traversal in the same phase if needed.

`materialize_html_groups` becomes window-aware.

**Modified files:**

- `apps/desktop/src-tauri/src/ir/materialize.rs` — `HtmlGroupRenders` →
  `HtmlGroupWindowedRenders` (`GroupId → Vec<(TimeWindow, HtmlGroupRenderInfo)>`).
  For each effective group, call `Group::time_windows`, then per
  html-cap window call `materialize_html_group_window`. Window-local
  keyframe rebase applied during `CompositionLayer` construction
  (§8).
- `apps/desktop/src-tauri/src/raster/html_group.rs` — `state_hash`
  takes a `TimeWindow` argument; cache dir layout includes it.

**Verification.**

- Multi-window project: two animating runs on one group produce two
  cached PngSeqs at different paths.
- Window-local rebase test: a keyframe at layer-local t=2s plays at
  composition-time 0 when the window starts at layer-local t=2s.
- Cache-stability test: editing a keyframe inside window A doesn't
  change window B's `state_hash`.

### Phase B.5 — Wire-through in `lower.rs` (~2 days)

End-to-end integration. The lower pass now produces multiple
overlays per effective group.

**Modified files:**

- `apps/desktop/src-tauri/src/ir/lower.rs` — when processing an
  effective group, no longer emit a single `lower_html_group_overlay`.
  Instead, walk the group's `TimeWindows`:
  - Per `html_cap` window: emit one PngSeq overlay gated to that
    window using its `HtmlGroupRenderInfo`.
  - Per `static_gap`: call `lower_group_static_gap`.
- Re-confirm the audio side is unchanged (decision 7 of
  html-render-groups still applies — audio members of an html-mode
  group bypass html-cap regardless of windowing).

**Verification.**

- Smoke export: 30s clip with Blur kick at `[14, 16)` produces a
  final mp4 with the blur present in `[14, 16)` and absent elsewhere.
  Wall-clock export time meaningfully lower than Pass A (target:
  >5× on a 1080p30 example).
- Degenerate case: 30s clip with HtmlTransform rotation ending at
  90deg exports identically to Pass A and roughly the same wall-clock
  time (the absorbed-gap rule kicked in correctly).

### Phase B.6 — Telemetry + UI hint (~half a day)

**Modified files:**

- `apps/desktop/src-tauri/src/raster/html_group.rs` — per-window
  `html_group:start` / `html_group:progress` / `html_group:complete`
  events. Existing event name unchanged; payload gains
  `window_index` + `window_count`.
- `apps/desktop/src/App.tsx` (ExportPanel) — aggregate per-window
  progress under the group's sub-bar. Each window contributes a
  fractional slice to the group's total.
- `apps/desktop/src/effects/EffectPanel.tsx` — tooltip hint on the
  keyframe button noting the "return-to-identity for tail savings"
  rule (§12 degenerate case).

**Verification.** Manual: export a multi-window project, observe
progress reflects per-window phases.

**Total scope ~8–9 days of single-developer time.** Smaller than
preview-dom / html-render-groups because the raster + composition +
group infrastructure all exist; the new surface is analysis +
gap-lowering + per-window cache plumbing.

### Phase B.7 (future) — multi-effect granularity (Pass C territory)

Per-effect time-windowing rather than per-group union. Today a group
with two keyframed effects on disjoint animating windows
`[2, 3) ∪ [27, 28)` produces a single absorbed envelope `[2, 28)`
because the two effects compose against the same composition. Pass C
would split per effect so the held-tail of effect A is on ffmpeg
even when effect B is still animating. Deferred; revisit if usage
profiling shows the pattern.

---

## Risks & mitigations

- **Window-local rebase bug.** Easy to forget the full
  `(layer.t_start_us + kf.t_us) - w_start` rebase and leave keyframes
  pointing at the wrong composition-time. **Mitigation:** dedicated
  test with non-zero layer-local keyframe times at non-zero window
  starts; assert the engine resolves the value correctly mid-window.

- **Frame-snap drift on fractional fps.** `29.97` and `23.976` are
  ratios, not integers. Snap math has to use `Rational` (or the
  underlying `fps_num/fps_den`) to avoid drift over long timelines.
  **Mitigation:** snap helper takes the `Rational` fps directly; unit
  tests at 29.97 and 23.976.

- **Held-effect substitution breaks under interp = Bezier.** The
  `value_at(t_us)` evaluator for Bezier curves has to match the
  preview engine's resolver pixel-for-pixel. **Mitigation:** factor
  the Bezier eval into a single function shared by preview engine,
  composition engine, and `value_at`. Test against a fixture set of
  curves that the preview engine already passes.

- **Hold-step boundary off-by-one.** A Hold step at exactly the
  group boundary (e.g., `kf @ t=group_t_end`) should not fragment a
  zero-length gap. **Mitigation:** the gap fragmenter filters
  zero-length gaps post-split; covered by a unit test with a
  Hold-step at the group's exact end.

- **Synthetic-group cache collision with real groups.** A real group
  with v4 UUID can't equal a synthetic v5 UUID (different version
  field), but a project that *renamed* a real group to recompute its
  id, or a project loaded with a future schema migration, might.
  **Mitigation:** the namespaced UUID for synthetics is documented;
  any future id mutation in the actor surfaces in the
  groups-changed-IDs migration story.

- **Per-window cache disk growth.** N cache dirs per multi-window
  group vs 1 per envelope group. Active projects with many
  keyframed effects could grow the cache linearly. **Mitigation:**
  Phase B.4 starts with a prerequisite check verifying the LRU
  policy walks the per-window cache dirs; document the disk-budget
  implication in the user-facing settings page.

- **Author confusion from the degenerate case.** Users keyframe a
  blur kick expecting fast export, see no improvement, blame the
  tool. **Mitigation:** the §12 user-facing rule + tooltip hint in
  Phase B.6. Also: emit a diagnostic log line per group naming the
  absorption reason so we can debug user reports.

---

## What "done" looks like

After Phase B.6 lands:

- A 30-second clip with a 2-second keyframed Blur kick at `[14, 16)`
  exports in roughly `2/30` the html-cap wall-clock of Pass A (the
  rest is ffmpeg-fast). Concrete target: a sample export that took
  60 s under Pass A takes <15 s under Pass B.
- Standalone layers with keyframed effects (no group) export with
  the keyframe applied. Pre-Pass-B-fix: silent drop. Post-fix:
  rasterized via synthetic singleton group.
- Multi-window projects (multiple animating runs per group) produce
  one cache entry per window; editing one window's keyframes doesn't
  invalidate the others.
- Authors who hit the "non-identity tail" degenerate case see a
  tooltip-level hint explaining why their export didn't speed up.
- All 339 → ~360 lib tests pass; existing Pass A behavior holds
  unchanged for groups whose held values are not identity (those
  collapse to the same whole-group html-cap render).
- Net code change: ~600–900 LoC added across Rust; zero deleted
  (additive). The only old-code adjustment is the
  `for g in project.groups.iter()` walks in `lower.rs` /
  `materialize.rs` switching to `effective_groups(project)`.
