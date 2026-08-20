---
status: accepted
---

# Transitions open their overlap by placement, not extension, and the record remembers what was borrowed

## Context

ADR 0035 opens the authorized overlap by silently extending the outgoing
layer's tail into handle material (start-at-cut). That violates the editing
principle this decision adopts as a red line: **trimmed ranges are sacred** —
a layer's in/out points are the user's cut, and no default behavior may play
material outside them. Under extension, the outgoing layer's exit frame is
overwritten to `out + duration`, hitting a target frame demands reverse
arithmetic, and the workaround — manually stacking two tracks with opacity
ramps — reproduces the mid-transition alpha dip the two-input node exists to
avoid.

The geometry admits exactly two overlap sources: extra media (handle) or
placement (the incoming layer shifts left by the duration; both participants
play exactly their trimmed ranges — FCP's "Full Overlap"). The rendering
node, reconcile predicate, and undo model are indifferent to which one
produced the overlap; but their *inverses* differ, and the state previously
did not record which arrangement had been made — removal unconditionally
shrank the outgoing layer, which trims real content whenever the overlap was
not born from extension (the pre-positioned add branch already shipped).

## Decision

### Overlap placement is the default

`add_transition` moves the incoming layer left by the frame-floored duration
(measured backward from the cut between two canonical boundaries). Extension
survives behind an explicit `placement: 'extend'` — an MCP parameter and the
chip's right edge — never a default and never a silent fallback. The UI keeps
one add gesture.

Group siblings follow the move on their own lattices; a shifted sibling that
collides on its lane bounces to a free lane (spawning one — ADR 0042's
placement policy), and overlapping audio sums across the window. Two
structured refusals, pre-id-mint: participants sharing a group (the move
would drag both, so the overlap cannot open), and any moved member crossing
t = 0. The span the incoming layer vacates stays a gap: groups are the user's
mechanism for "these move together"; there is no ripple.

### `extended_us` records the borrow

The Transition record carries how many µs of the outgoing tail the transition
extended (`0` for overlap and pre-positioned adds; the full duration for
extend adds; edge drags adjust it), so the outgoing layer's **sacred end** —
the exit frame the user cut — is always `end − extended_us`. Inverse
operations route by it: removal shrinks the outgoing layer by `extended_us`
and moves the incoming layer right by the remainder, refusing structurally
when the restore destination is occupied. `update_transition` treats
`(duration, extended)` as two targets that fully determine both window edges.

Implicit duration changes (menu presets, inspector, MCP patches omitting
`extended_us`) are **sanctity-preferring**: growth never borrows; shrink
returns borrowed handle before moving the incoming layer. Only the explicit
right-edge drag and an explicit patch field increase `extended_us`, so "who
touched the outgoing layer's material" is always attributable to a deliberate
act.

### The chip owns the window's edges

The window `[incoming.start, outgoing.end]` coincides with the participants'
own edges, so the chip captures pointer events across the window and exposes
two placement-independent handles: the left edge moves the incoming layer
(where the overlap starts); the right edge is the outgoing layer's actual end
(borrow/return — and past zero borrow it commits an explicit **negative**
`extended_us`: every borrowed µs returned, then a genuine tail trim in the
same commit, the only operation that moves the sacred end and one the
implicit routing can never produce). Bare participant edges are not grabbable
inside the window — a gesture-layer restriction only. Policy B reconcile
stays the mutation-layer backstop for every bypass path, and the
split-inside-window atomic block stands.

## Considered options

- **Keep extension as the default, visualize handle consumption.** Rejected:
  the information deficit was a symptom; the range violation was the disease.
- **Ripple downstream content to close the vacated gap.** Rejected: in a
  free-placement timeline, groups already express "moves together"
  explicitly; an implicit multi-track ripple desyncs against spanning layers
  and moves layers the user never touched.
- **A placement enum instead of a counter.** Rejected: two-edge dragging
  produces mixed provenance; the counter's arithmetic covers every sequence
  of gestures with two numbers and keeps every state reachable and invertible.
- **Promote Policy C (transition rides participant trims).** Not pursued: the
  chip's capture makes the participant edges unreachable for bare trims, which
  dissolves Policy C's core case at the gesture layer for an order of
  magnitude less machinery.
- **A UI entry for extend adds.** Rejected: a second add affordance for a
  non-default arrangement; the right edge is the extend path and is
  self-revealing.

## Consequences

- The former center-at-cut / end-at-cut alignment deferral dissolves: overlap
  placement is end-at-cut geometry, and mixed `extended_us` covers center.
- `TransitionInsufficientHandle` narrows to extend paths; overlap adds are
  bounded by `duration ≤ min(len_A, len_B)` alone.
- Removal can now refuse (restore destination occupied) where it previously
  always succeeded by trimming content — an honest trade recorded as a
  structured error, consistent with the no-silent-clamping red line.
- Audio crossfade, when it lands, upgrades the summed overlap in place; the
  geometry this decision produces is already the one it needs.
- ADR 0035's placement section is superseded by this decision; its rendering
  node, reconcile-on-commit policy, and split truth table stand unchanged.

## References

- [ADR 0035](0035-transitions-two-input-node-reconcile-on-commit.md)
  (two-input node, reconcile-on-commit),
  [ADR 0042](0042-tracks-are-a-by-product-of-placement.md) (placement policy).
- [`CONTEXT.md`](../../CONTEXT.md#transitions) — Overlap placement and
  extended_us / borrowed handle glossary entries.
- `src/main/state/mutations/transitions.ts` (placement branches, routing),
  `native/src/state/transition.rs` (serde twin),
  `src/main/state/validate.ts` (shared predicate + structural checks).
- Gates: routing/inverse unit suites, the PBT invariant fuzz with both
  placements, golden clamp twins, the transitions WYSIWYG e2e.
