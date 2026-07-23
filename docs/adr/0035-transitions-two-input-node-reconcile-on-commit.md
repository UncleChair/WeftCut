---
status: accepted
---

# Every transition kind renders through one two-input compositor node, and ordinary edits reconcile transitions on commit

## Context

A transition authorizes a specific timeline overlap between two same-track
layers that the no-overlap invariant would otherwise reject; the overlap span
must equal the transition's duration so validation can reason about it. Three
kinds ship: Crossfade, and Wipe and Slide, each carrying a direction — the
**motion** direction, never the reveal side (see the
[CONTEXT.md glossary](../../CONTEXT.md#transitions)).

Two questions needed settling. First, *how kinds render*: crossfade looked
completable on the cheap by ramping the incoming layer's per-layer `opacity`
across the overlap, but wipe and slide are two-input operations — each output
pixel is a function of *both* clips at once — so they can never ride the
per-layer path. Second, *how ordinary edits interact with a transition*: a
trim, move, split, or delete that breaks the authorized overlap would
otherwise be rejected by validation with an error naming an invariant the
user never touched, deadlocking the timeline around every transition.

## Decision

### One two-input compositor node for every kind

During an active transition window the Compositor diverts both participating
layers from normal drawing into a `TransitionNodeManager` node
(`src/renderer/render/transitions/`). Each side renders — with its own
transform, opacity, and effects filter chain already applied — into a
composition-sized offscreen render texture, and a single full-frame quad
composites the two captures with the kind's fragment shader (GLSL and WGSL
twins; two texture uniforms + linear progress + direction) at the first
participant's stage slot, so the transition sits at its track's z-position.
Crossfade is the degenerate `mix()` case; Wipe sweeps a hard boundary across
the frame; Slide translates the incoming capture in over the outgoing one.

Supporting choices:

- **Composition-space full-frame semantics.** The wipe/slide boundary sweeps
  the full frame, not the source bounds; uncovered regions stay transparent,
  and the mix runs on premultiplied captures — which is what makes alpha
  content (titles, transparent Motifs) blend without a mid-transition dip.
- **Pooled render textures.** Side RTs come from a pool sized by the
  concurrent active transitions (×2), reused across frames, never allocated
  per frame — the playback-loop memory-ratchet red line governs this path.
- **Fixed linear progress**: `(t − overlapStart) / duration`, not
  keyframeable. Easing is a future additive parameter reusing the keyframe
  bézier infrastructure.
- **Preview and export share the node**, so WYSIWYG holds by construction and
  is gated: the transitions e2e asserts exported frames within 1/255 of
  preview on solid-color fixtures.

### Placement, participants, and handle

Alignment is **start-at-cut** (glossary): the window occupies the incoming
layer's first `duration` microseconds, and `add_transition` auto-extends only
the outgoing layer forward, pulling its tail source handle to open the
authorized overlap. The handle is pre-checked **before the transition id is
minted** — insufficient tail media throws
`TransitionInsufficientHandle { available_us }` instead of burning an id;
free-duration outgoing layers (image, text, Motif) have unlimited handle.
Participants are visual layer kinds only; audio participants are rejected
with a named error at both the mutation and validation seams. No silent
duration clamping anywhere: ask for 1 s, get 1 s or a structured error.

### Ordinary edits reconcile transitions on commit (Policy B)

The per-transition invariant — participants exist, same track, visual-only,
overlap exactly equals duration, duration within both layers — is **one
shared predicate with two callers** (`src/main/state/validate.ts`):
`validateTransitions` fails on it, `reconcileTransitions` drops on it, so the
two can never drift. Structural corruption no layer edit can produce
(duplicate transition id, self-reference, a layer in two transitions) stays
validate-only.

Reconcile runs inside every commit's `produce()` — after the mutation apply,
before validate — and in `dryRun`, so a dry-run of an edit across a
transition edge predicts the real succeed-with-drop outcome. Every dropped
transition emits a LogBus status row, and the drop lands in the same history
snapshot as the edit, so one undo restores both. Reconcile removal does
**not** shrink the outgoing layer back — the user's edit defines the new
shape; only explicit `remove_transition` keeps its shrink-back. The layer
mutations themselves (trim / move / split / delete / track ops) stay
transition-blind.

Two consequences of remove-only reconcile are deliberate, and test-pinned as
a truth table in `src/main/state/reconcile.test.ts`:

- **Split inside a transition is blocked atomically.** A from-side split, or
  a to-side split inside the overlap, leaves the overlap region covered by a
  non-participant piece; after the reconcile drop the overlap is unauthorized,
  so validate's `LayerOverlap` rejects the whole commit — state and
  transition untouched. This is geometrically necessary, and honest: the edit
  is semantically ambiguous in a linear NLE. A to-side split beyond the
  overlap commits normally, the transition riding the left half.
- **Group moves preserve transitions.** Moving a group containing both
  participants preserves the overlap, so the transition survives without any
  group-awareness in reconcile.

## Considered options

- **Opacity-ramp completion path for crossfade.** *Rejected.* Ramping the
  incoming layer's effective `opacity` across the overlap would have created
  two evaluation semantics for one feature (crossfade on the per-layer path,
  wipe/slide on a node the feature needs anyway), and on alpha content it
  produces the classic mid-transition darkening artifact — both layers below
  unity opacity mid-window lets the background bleed through wherever either
  source carries transparency.
- **Block edits that break a transition (Policy A).** Rejected: every
  transition would deadlock the timeline around it, surfacing invariant
  errors for edits the user reads as ordinary.
- **Transition-aware mutations — the transition rides the trim (Policy C).**
  *Deferred, upgrade path open.* Individual mutations can later become
  transition-aware (Premiere-style), with reconcile degrading to a backstop;
  nothing in Policy B forecloses it.
- **Shrink the outgoing layer back on reconcile drop.** Rejected: the user's
  edit defines the new shape; a shrink-back would fight the gesture that
  triggered the drop.

## Consequences

- One evaluation semantics for all kinds; adding a kind (Push is the named
  next) is an enum variant plus a shader, not new plumbing.
- Side RTs are 8-bit (`rgba8unorm` on WebGL, `bgra8unorm` on WebGPU — Pixi's
  WebGPU pipelines hard-code bgra8unorm color targets), so the 10-bit export
  lane quantizes through a transition window. Accepted for v1: float RTs
  would need `EXT_color_buffer_float`, which preview's WebGL fallback can't
  assume.
- A blocked in-transition split surfaces as the generic `LayerOverlap` error,
  not a transition-specific message — recorded as roadmap debt.
- The reconcile pass runs on every commit and silently mutates state, so it
  is the fuzz target: the PBT op pool includes the three transition
  operations, with the property that every surviving transition satisfies the
  shared predicate.
- Deferred surface (softness, easing, alignment variants, audio crossfade,
  Policy C, chip drag-resize) is tracked in
  [`roadmap.md`](../roadmap.md#transitions--v1-shipped-named-deferrals-remain).

## References

- [`CONTEXT.md`](../../CONTEXT.md#transitions) — Transition direction and
  Start-at-cut glossary entries.
- `src/main/state/validate.ts` (the shared predicate +
  `reconcileTransitions`), `src/main/state/actor.ts` (commit + dryRun
  callers, LogBus drop rows), `src/main/state/mutations/transitions.ts`
  (handle pre-check, add/update/remove).
- `src/renderer/render/transitions/` — `TransitionNodes.ts`,
  `TransitionRtPool.ts`, `transitionSources.ts`, `activeTransitions.ts`.
- `native/src/state/transition.rs` — the deserialize-only serde wire
  contract (TS is the sole writer).
- Gates: `e2e/electron/transitions-wysiwyg.spec.ts` (preview + export, same
  assertions), the memory-ratchet `transitions` scenario,
  `src/main/state/reconcile.test.ts` (the split truth table), the PBT
  invariant-fuzz suite.
