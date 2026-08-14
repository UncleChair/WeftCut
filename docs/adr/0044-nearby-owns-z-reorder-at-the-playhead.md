---
status: accepted
---

# Z-order is reordered in Nearby, on the stack under the playhead

## Context

ADR 0042 removed every human surface for managing tracks: placement spawns
lanes, emptying prunes them, and z-order rearrangement composes from repeated
raises to the top. That decision named its own gap. Rejecting drag-reorder on
the track header, it assigned ordering to the Nearby panel — "operate on the
media" — and noted the one thing it did not provide: *Nearby currently sorts by
playhead span and start time, not by z-order.*

The gap bites hardest in A/B Roll mode. There the timeline shows only the
reserved skeleton plus at most one inline-revealed hidden track at a time
(single-track exclusive reveal), so two stacked overlays are never on screen
together and a stacking decision has nowhere to live on the timeline at all.
Ordering n overlays costs n−1 raises, performed blind.

Three model facts shape the fix. A layer has no index: z is exactly the
position of its track in the project's track array, and tracks are
kind-agnostic containers. Audio composites by role, not by stacking
(ADR 0023), so z is meaningless for it. Text layers — captions included
(ADR 0026) — are visual and interleave with video in the stack, so any
per-category presentation slices the stack into pieces that lie about
adjacency.

Nearby today lists the layers of non-reserved tracks within ±Δ of the
playhead, sectioned by category (video / audio / text), sorted
playhead-spanning first, then start time. It selects, reveals, jumps and
renames; it reorders nothing.

## Decision

Nearby gains z-reorder, and the ordering boundary is the playhead — not a
mode.

1. **Two sections replace the three category sections.** *At playhead* holds
   the layers that span the playhead: visual layers merged into one list,
   ordered top-of-stack first (the layer-panel convention), each row
   draggable by a grip; audio rows sink to the section's tail and carry no
   grip. *Nearby* holds everything else in the window, sorted exactly as
   today. You reorder what is being composited right now, in the one place
   that shows it as a stack; category survives as row icons and the filter
   chips.

2. **Reorder operates on the layer and degrades smartly.** If the layer is
   its track's sole occupant, the track itself moves — identity, label, lock
   and height survive. If the track holds anything else (a neighbour outside
   the window, a co-resident audio layer), the layer splits onto a new track
   at the target position and the source is pruned if that emptied it. A
   role-stamped track never moves: a layer restacked out of one always takes
   the split path, and the reserved skeleton stays where it is. Either way it
   is one history entry, so one undo restores everything.

3. **One new op, anchor-addressed: `restack_layer(layer, above|below
   anchor)`.** Anchors are layers, not indices — an index drifts between an
   agent's read and its write, and the gesture itself is anchored ("drop it
   above this row"). Placement resolves against the anchor's track. Restacking
   a layer to where it already sits is a no-op that burns no op id, matching
   `move_track`. The op is exposed over MCP; front/back are not op variants —
   any caller derives them as *above the top* / *below the bottom* of the
   stack it is looking at.

4. **A row context menu is the second path.** Bring forward / send backward /
   bring to front / send to back, enabled only on At-playhead visual rows and
   disabled at the extremes. Front and back mean the top and bottom of the
   non-reserved visual stack — the menu never composes a move below the
   reserved skeleton. This mirrors the effect chain's convention that every
   drag has a non-drag equivalent.

5. **Filtered views stay draggable under a fixed rule.** With a category chip
   active the stack shows a subset; a drop inserts directly above the visible
   row below the gap (at the section's bottom: directly below the last
   visible row). Intent relative to what the user can see is honoured
   exactly; layers hidden by the filter keep their positions relative to each
   other.

6. **The gesture is the effect chain's, inherited.** Pure pointer events —
   never HTML5 drag-and-drop, so a row drag can never become a Dockview panel
   drag — a grip handle because the row body already spends click on select
   and double-click on rename, zero commands mid-drag and exactly one op at
   drop, Escape and pointercancel disarm. The list is snapshotted for the
   duration of a gesture: the playhead ticks on a throttle and must not
   reshuffle the rows under the pointer.

7. **A/B Roll only.** Nearby in Show All keeps its explainer. The panel's
   reason to exist is the layers the timeline is hiding; Show All hides
   nothing, and its ordering story (raises, at 0042's accepted n−1 cost)
   is unchanged by this decision.

## Considered options

**A proximity ↔ z-order mode toggle.** Rejected. It is a second mode to
learn, and the model already contains the right boundary: spanning the
playhead is what makes z observable. The toggle also leaves the temporal list
draggable-looking but inert, or the z list windowless — every variant
smuggles in a new question the playhead boundary answers for free.

**Sort the whole list by z.** Rejected. Proximity ordering is the panel's
accepted discovery semantics (the original acceptance criteria and spec call
it a discovery surface); z is undefined ordering for items that do not
overlap in time anyway.

**Keep the category sections, z-sort within each.** Rejected. Video and text
interleave in the stack; section borders would show as adjacent two rows with
a hidden layer between them, and a drop between them would be a lie.

**Compose existing ops from the renderer.** `move_track` plus a
position-taking `move_layers_to_new_track` could express both degradation
branches. Rejected: the sole-occupant/shared distinction is a fact about the
model, so the model should own it; the renderer choosing between two ops
means one user action carries two history labels, and agents are left to
reimplement the degradation themselves.

**Index-addressed op (`new_track_position`).** Rejected — the renderer would
convert visible neighbours to an index only for the op to convert it back,
and agents get a read-modify-write race for free. Anchors survive concurrent
edits or fail loudly.

**Disable dragging while a filter is active.** Rejected in favour of the
deterministic local rule; "why can't I drag" is an explanation owed forever,
and the rule honours every intent the filtered view can express.

## Consequences

- Nearby's job widens from discovery to management. The original acceptance
  criteria are extended, not overturned: select-without-seek, go-to, rename
  and the explainer all survive unchanged.
- The glossary's *Raise* entry — "the whole of z-order rearrangement" — stops
  being true. Raise remains the spawn-at-top gesture; *Restack* is the new
  verb for anchored reordering, and CONTEXT.md changes with this ADR.
- In A/B Roll, ordering n overlays now costs one drag instead of n−1 blind
  raises. In Show All nothing changes.
- The common restack (sole-occupant overlay) preserves the lane name the user
  set, which repeated raises destroyed — 0042's accepted name-loss consequence
  now applies only to the split path, where the source lane survives anyway
  unless the moved layer was its last.
- An anchored placement can land between tracks the user cannot currently see
  (filter, window, or the timeline's A/B filter). The rule is deterministic
  and stated; the alternative — normalising the whole stack per drop — would
  move things the user never touched.
- The op accepts any visual layer as anchor, including one on a reserved
  track, so an agent can say "put this above the A-roll clip". The renderer
  never generates such a call; the context menu clamps to the non-reserved
  stack.
- Audio stays unordered everywhere, by construction: no grip, no menu items,
  and the op rejects audio movers and audio anchors.
- No schema change. Z remains track-array order; the project file, the Rust
  mirror and persistence are untouched. History covers the op automatically
  because it is one `commit`.

## Where this lives

- List semantics — the peek module (`renderer/panels/peek.ts`): the
  two-section split, the z-ordering of the At-playhead section, and the pure
  gap→anchor mapping the drop resolves through. All of it stays DOM-free.
- The op — a new mutation beside `mutations/move.ts` / `mutations/tracks.ts`,
  dispatched through the actor's `commit` (auto undo), labelled in
  `history-labels.ts`, exposed in `mcp-commands.ts` and documented in
  `docs/mcp.md`.
- The gesture — `panels/NearbyPanel.tsx`, borrowing the pointer-reorder
  skeleton of `properties/EffectsSection.tsx` (drag state, gap hit-testing,
  edge auto-scroll, window listeners, escape/cancel disarm).
- The menu — a new Nearby row context menu, sibling to the timeline's layer
  context menu.
- Vocabulary — CONTEXT.md: *Restack* added, *Raise* narrowed.

## Industry baseline

Photoshop, After Effects and every layer-panel editor order top-of-stack
first and reorder by dragging the layer, not its container — that convention
carries over. NLEs (Premiere, Resolve) instead reorder by dragging clips
across typed tracks, which 0042 already declined: WeftCut's tracks are
by-products, so the layer panel is the honest surface, and the playhead scope
is what a timeline-less stack view needs that Photoshop does not.
