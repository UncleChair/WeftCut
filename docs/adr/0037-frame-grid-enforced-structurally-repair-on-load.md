---
status: accepted
---

# The composition frame grid is enforced structurally, with one leaf implementation, and off-grid data on disk is repaired on load rather than rejected

## Context

Composition rate is rational (`{num, den}`), timeline times are integer
microseconds, and a canonical time is `round(i × 1e6 × den / num)` for an
integer frame index `i`. Every mutator was supposed to snap, and
`docs/data-model.md` documented that as an invariant — but nothing checked it,
and three write paths did not honour it: a trim clamped against
`duration − 1 µs` or against an arbitrary media duration, `add_transition`
storing a raw duration and extending `t_end_us` by it, and marker times never
snapped at all. The ruler painted a fourth grid of its own, multiplying a
pre-rounded frame duration.

Underneath that, the grid had no single implementation. `snap_frame_round`
lived in the shared `weftcut-eval` leaf (ADR 0025), but `snap_frame_floor` in
the same leaf **truncated** its output while an independent TypeScript
`snapFrameFloor` rounded half-up — one name, two different numbers at
fractional rates, with a caller double-snapping to paper over it. Frame
indexing, output timestamps, tick generation, the last-frame anchor, and
frame stepping each had their own local arithmetic.

## Decision

### One implementation in the leaf, and index policy is separate from output policy

All grid primitives — `time_us_at_frame`, `frame_index_floor/_round/_ceil`,
`frame_count`, `snap_frame_floor/_round/_ceil` — live in `weftcut-eval` with
i128 arithmetic and cross the scalars-only wasm ABI. `src/renderer/frames.ts`
is a typed wrapper and the single surface for the renderer, the timeline UI,
and the main-process actor (through `src/main/state/snap.ts`). Nothing
reimplements a primitive in TypeScript: JS doubles have a real ceiling here —
a 24 h timeline at 60000/1001 evaluates `frame × 1e6 × den ≈ 5.18e15`, only
1.7× under 2^53.

Index selection (`floor` / `nearest` / `ceil`) and output rounding are
**separate policies**. Choosing a frame is a policy; the microsecond value of
a frame boundary is always half-up. There is no truncating variant, which is
what collapsed the two `snapFrameFloor` semantics into one.

The nominal frame duration survives as `approxFrameDurUs`, named so its
non-accumulability is visible at the call site. It is legal for
display/estimate decisions only — a ruler's tick-spacing choice, a progress
readout — never as a time step.

### The invariant is a validation backstop, not a per-mutator convention

`validate` rejects any layer endpoint, `composition.duration_us`, or marker
time that is not canonical, so a mutator that forgets to snap fails loudly
instead of quietly persisting a sub-frame time. The endpoint predicate is
**keyed by layer kind**, so a kind can have its own grid without a sweep over
call sites. [ADR 0038](0038-rate-locks-audio-authors-on-samples-ndf-stays-honest.md)
takes that seam live: audio moved to the 48 kHz sample lattice, and the lookup
grew from one predicate to a shared function with three call sites.

Two fields are deliberately outside the rule:

- **`transition.duration_us`** is a *distance* between two canonical
  boundaries, and at fractional rates a distance is not itself a boundary
  time (a one-frame transition at 30000/1001 is 33_367 µs at cut frame 0 and
  33_366 µs at cut frame 1). What is enforced is the pre-existing
  `overlap == duration_us`; canonical participant endpoints then make the
  duration a whole frame count automatically.
- **Keyframe `t_us`** is snapped on write but not enforced. Trim and split
  rebase keys by a *delta*, which is a difference of canonical times and so
  not canonical itself. Re-snapping the shifted set would run
  dedupe-last-wins over it and silently merge two keys that landed on one
  frame — losing authored data to satisfy a rule whose violation is
  invisible (a ≤ half-frame offset on an interpolated value).

### Off-grid data already on disk is repaired on load

`project_open` reaches the actor through `replace_state`, which runs the same
validator as every mutation. A hard rule alone would therefore make any
project written by an older build — or by the trim bug this work fixed —
refuse to **open**. So `parseProject` snaps every grid-bound field inside its
single normalize pass, beside the additive-field backfills: one pass, one
place, because a second normalize site is how blank-screen-on-open bugs
happen. It re-derives each transition duration from the repaired geometry (an
endpoint moving by 1 µs changes what the duration must be), widens a span the
snap collapsed so the repair can never manufacture an `InvalidLayerRange`,
and reports what it moved so a migrated project is visible rather than
mysterious. The pass is idempotent by construction — every write is a snap.

**Repair on load, reject on edit.** The same off-grid value opens fine from
disk and fails as a mutation argument.

### The ruler's cost is bounded by the viewport

Tick generation is a pure model (`renderer/timeline/rulerModel.ts`) taking
rate, zoom, scroll offset, and viewport width, returning a windowed tick set
with overscan. Scroll position reaches it through a dedicated store that only
the ruler's tick set subscribes to — never React state on the timeline root,
which would re-render the whole tree per wheel event (the regression class the
memory ratchet exists to catch). Node count went from 216 001 at one hour and
5 184 001 at 24 hours to ~61 in both cases; no canvas fallback was needed.

## Consequences

- A mutator can no longer persist an off-grid visual endpoint, and the
  property test over the actor's command matrix at eight rates is what proves
  it. That test caught `duplicate_layer` offsetting both edges by a raw
  microsecond delta.
- Markers now quantize, so a marker dropped mid-frame moves up to half a
  frame — matching Premiere/Resolve. A transition or region marker request
  below half a frame is rejected rather than rounded to nothing.
- Composition `fps` changes re-snap marker times along with layer endpoints;
  without that the new marker rule would fail every fps change on any project
  holding a marker. `fps` is now immutable once a layer exists
  ([ADR 0038](0038-rate-locks-audio-authors-on-samples-ndf-stays-honest.md)), so
  that path serves layer-less projects only.
- The grid repair's report is a callback seam, not yet routed to the LogBus;
  it defaults to a `console.warn` so a migrated project is never fully
  invisible.
- Timeline zoom (`pxPerSec`) remains React state on the timeline root, so a
  ctrl+wheel zoom still re-renders the tree — the same cost class as the
  scroll path this work fixed, and the remaining half of it.

## Where this lives

- `native/eval/src/lib.rs` (the primitives), `native/eval/src/wasm.rs` (the
  scalars-only ABI), `src/renderer/eval/index.ts` (the ABI twin — a missing
  entry is a runtime `undefined`), `src/renderer/frames.ts` (the surface),
  `src/main/state/snap.ts` (the main-process re-export).
- `src/main/state/validate.ts` (the backstop + the kind-keyed endpoint
  predicate), `src/main/state/serialize.ts` (`repairGrid` inside `parseProject`),
  `src/main/state/mutations/{trim,transitions,markers,duplicate}.ts`. The grid
  lookup itself is `gridForLayerKind` in `src/main/state/snap.ts` (ADR 0038).
- `src/renderer/timeline/{rulerModel.ts,TimelineRuler.tsx}`,
  `src/renderer/state/timelineScrollStore.ts`.
- Gates: `src/renderer/snapFrameGolden.fixture.json` (cross-language golden,
  asserted from both TS and Rust), `src/main/state/__tests__/pbt/grid-invariant.test.ts`
  (the actor-wide property), `src/renderer/timeline/rulerModel.test.ts`
  (bounded count at 10 s / 1 h / 24 h), `e2e/scripts/ruler-node-count.mjs`
  (opt-in, `npm run e2e -- --ruler-gate`).
