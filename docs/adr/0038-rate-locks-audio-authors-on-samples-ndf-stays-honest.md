---
status: accepted
---

# The composition rate locks once content exists, audio authors on the 48 kHz sample lattice, and NDF timecode is made honest rather than joined by drop-frame

## Context

[ADR 0037](0037-frame-grid-enforced-structurally-repair-on-load.md) made the
composition frame grid structural: one leaf implementation, a validation
backstop, repair on load. It left three questions open, and each one is about the
grid's *edges* rather than its arithmetic.

**The rate could still change under existing content.** `set_composition` accepted
an `fps` patch and re-snapped every layer edge, Motif `src_in_us`, the composition
duration and every marker. Each edit point moved by up to half a new frame, a
short layer could collapse and reject the whole operation, and it was reachable
from the MCP surface through what looked like an ordinary settings patch. Meanwhile
new-project offered only 30 / 60 / 29.97 while export already offered
60 / 50 / 30 / 25 / 24 — so a PAL or 24p shooter had to edit on a 30 fps timeline
and rate-convert on the way out.

**Audio authoring was coarser than the engine underneath it.** The mixer already
converts `t_start_us` / `src_in_us` / `src_out_us` to 48 kHz sample frames, but the
actor snapped every layer edge — and every keyframe, gain and pan included — to the
video frame grid. Raising the video fps silently changed how precisely audio could
be placed, and the value stored was not the value rendered.

**NDF timecode was documented as a "v1 policy"**, implying drop-frame was pending.

## Decision

### The rate is immutable once any track holds a layer

`set_composition { fps }` rejects with `FpsLockedByContent { current, requested,
layer_count }` when a layer exists anywhere. The rejection happens before any draft
work, so it mints no op id, records no history and emits nothing.

Not a convert workflow and not a confirmation flag. There is **no UI caller** —
`SettingsPanel` only reads fps to format timecode — so locking removes no existing
user capability; it converts a silently destructive settings patch into an
actionable error for an agent. It also pins the timecode policy at creation and
deletes the whole rate-migration question downstream. If rate conversion is ever
wanted it is *duplicate timeline → convert*, previewing the rounding and leaving the
original intact: a feature, not a patch.

**"Content" means at least one layer.** Markers, a pinned duration, and
imported-but-unplaced media do not lock it: a fresh project has two tracks and no
layers, and marker re-snapping is lossless, so a stray marker must not brick the
rate. That threshold also keeps a future "dropping the first clip offers to match
the sequence rate" flow reachable — it sets fps while the timeline is still
layer-less, then adds.

Because the list is now the only way to pick a rate, it must be complete:
23.976 / 24 / 25 / 30 / 50 / 59.94 / 60 and 29.97, plus 4K at 30 and 60. There is
no custom-rate entry, which is what keeps `formatTimecode`'s frame field two digits
(ceiling 60 fps) and retires the ">99 fps" question unasked.

### Audio geometry lives on the fixed 48 kHz mix lattice

An audio layer's `t_start_us` / `t_end_us` — and its automation write grid — are
canonical on `round(i × 1e6 / 48000)`, ~20.83 µs apart. The rate is the **fixed mix
rate**, not `composition.sample_rate`: that field is read only as the export target,
so it is a delivery parameter, moves no edit, and is deliberately not locked.

The reason to pick samples rather than a finer video subdivision is that it makes
the authoring grid and the render grid *the same lattice*: **zero rounding at the
seam.** A 48 kHz sample boundary is a frame boundary at rate 48000/1, so
`gridIndex(us, AUDIO_GRID)` is exactly the mixer's `us_to_frame(us, 48000)` — one
i128 leaf implementation, not a second grid. µs storage represents it exactly:
consecutive boundaries are ~20.83 µs apart, so the mapping is distinct and
invertible.

An FCP-style 1/80-frame subframe was rejected because it *re-creates* two grids: at
30000/1001 one subframe is 20.02 samples, so a subframe edit lands between mix
samples and is rounded again at render. It is only integral at integer rates.

### One grid lookup, three enforcement sites

`gridForLayerKind(kind, fps)` in `src/main/state/snap.ts` is the only place the
choice is made. All three sites that enforce ADR 0037's structural invariant ask it:

1. the commit validator's endpoint predicate;
2. every mutation snap — add, move (including the **group fan-out**), trim, split,
   duplicate/paste, and the param-track normalize;
3. the load repair inside `parseProject`.

Two of those are data-loss sites rather than tidiness, and both fail *silently*
because a kind-blind snap does not error — it just moves the user's audio:

- **`move`'s group fan-out.** Snapping siblings on the composition grid drags a
  slipped audio member back to the nearest video frame on any unrelated whole-group
  move. The offset survives only because each member shifts by the same delta and
  then lands on its own lattice.
- **`repairGrid`.** A kind-blind load repair snaps sample-aligned audio onto the
  frame grid on **every open**, so opening and saving is enough to destroy every
  sync offset in the project.

Both are gated with **negative controls**: the test re-implements the kind-blind
version inline and asserts it produces the wrong answer, because an assertion that
passes against correct code proves nothing about a silent failure mode.

`composition.duration_us` stays a frame count: the autofit rounds the layer
high-water mark **up** to the enclosing frame, so a sub-frame audio tail is
contained rather than clipping the composition or pushing its duration off grid.

A grouped A/V pair's sync offset is **derived, never stored** —
`audio.t_start_us − video.t_start_us` — so no field can disagree with the geometry.
That works because the two existing fan-out behaviours already do the right thing:
a whole-group move shifts every member by the same delta (offset preserved), while
a trim's aligned set requires coinciding edges (a video trim does not drag slipped
audio).

The offset is measured in **sample indices, not raw microseconds**, and that is
load-bearing rather than cosmetic: at 29.97 / 59.94 a freshly dropped A/V pair
already sits up to ~10 µs apart (one requested time, two lattices), so a µs-based
offset would report that grid residue as a slip and the badge would light up on
every clip anyone drops. Both members' indices round to the same sample when nothing
has been slipped.

### The authoring surface: keys and numbers, never a drag

Because sample precision is unreachable by pointer, the entry points are:

- **Nudge commands** — one sample, and 1 ms (48 samples) as a usable coarse tier,
  plus a re-sync that zeroes the offset. Registered as real actions, so the search
  palette lists them, Settings → Keyboard rebinds them, and an agent can call them.
  Every one steps by an **index**, never by adding a quantum's width in µs — 48 kHz
  spacing alternates 20/21 µs, so an additive step drifts and 10 000 nudges out and
  back would not return to the original sample. That is exactly how the video
  frame-step bug looked, and it is gated by a property test.
- **Numeric entry** in the inspector, whose unit is switchable between timecode,
  milliseconds and samples. Scoped to **audio readouts only**: the ruler and playhead
  stay frame-based, because there is no zoom at which a sample ruler is legible and
  it would put a second grid on screen — the thing this effort spent a round removing.
- **Pointer drags keep snapping to the visible quantum**, unchanged and documented so
  it does not read as a bug.

The nudges and the inspector's start field both escape the group, because a sub-frame
audio edit *is* a slip: dragging the video member along would put that member off its
own grid.

### Drop-frame is declined; NDF is made honest instead

No DF, and project starting timecode stays fixed at zero. DF changes no stored
microsecond — it is purely a relabelling — and its consumers are interchange
formats (EDL / AAF / OTIO / FCPXML) that do not exist here; export writes no
timecode track. Building it costs a persisted field, a schema migration, `;`
parsing, skipped-label rejection and a test matrix, to relabel numbers that are
already correct.

What actually misleads a user is reading a **duration** at 29.97 and assuming wall
clock. So where a duration is displayed — the export dialog's range, the
composition duration and content-end floor in Settings — the wall-clock figure is
shown beside the timecode at fractional rates, and only there: a **position** makes
no wall-clock claim, and at integer rates the second figure would be the same
instant twice.

The NTSC presets stay. 29.97 *timeline* support is a grid capability that already
works; DF was only ever the label.

## Consequences

- An agent can no longer move a whole timeline by half a frame through a settings
  patch, and gets the current rate plus the blocking layer count back instead.
- The fps branch's layer re-snap is now unreachable by construction. It stays as the
  backstop for the two ways that can change — a future match-the-first-clip flow, or
  any relaxation of the lock.
- **Projects written before this open with a repair**: audio on a frame boundary is
  not on the 48 kHz lattice at 29.97 / 59.94, so it is pulled ≤ half a sample
  (~10 µs, inaudible) and reported. Repair on load, never reject, exactly as
  ADR 0037 established.
- A newly dropped A/V pair at 29.97 starts ~8 µs apart, because each member resolves
  the same requested time on its own lattice. That is where the mixer would have
  played the audio anyway — the file now says what renders.
- Sample precision is **not reachable by dragging**: at the 2000 px/s zoom ceiling
  one sample is 0.042 px. Pointer drags keep snapping to a visible quantum; sample
  accuracy arrives through nudge commands and numeric entry.
- `OffGridLayerBoundary` grew a `grid: "frame" | "sample"` field, because `fps:
  48000/1` alone is indistinguishable from an absurd 48000 fps composition.
- No schema change anywhere in this ADR: no rate field, no DF flag, no starting-
  timecode offset, no stored sync offset.

## Where this lives

- `src/renderer/grid.ts` — `gridForLayerKind`, `AUDIO_GRID`,
  `AUDIO_SAMPLE_RATE_HZ`, and the `snapOnGrid` / `gridIndex` /
  `timeUsAtGridIndex` / `stepOnGrid` wrappers over the ADR 0025 leaf. It lives in the
  renderer tree beside `frames.ts` because BOTH sides need it: `src/main/state/snap.ts`
  re-exports it for the actor (narrowing the kind to `LayerParams['kind']`), and the
  timeline UI imports it for nudges and readouts. A copy per side is the drift the
  single seam exists to prevent.
- `src/main/state/actor.ts` (`setComposition`'s lock), `src/main/state/errors.ts`
  (`FpsLockedByContent`), `src/main/state/validate.ts`,
  `src/main/state/serialize.ts` (`repairGrid`),
  `src/main/state/mutations/{add,move,trim,split,duplicate,params,helpers}.ts`.
- `src/renderer/startup/canvasPresets.ts` (the complete rate list),
  `src/renderer/frames.ts` (`formatWallClock` / `wallClockAside` and the NDF
  decision comment), `src/renderer/panels/ExportSettingsDialog.tsx`,
  `src/renderer/settings/SettingsPanel.tsx`.
- Authoring surface: `src/renderer/timeline/audioSlip.ts` (nudge steps + the derived
  offset, pure), `src/renderer/timeline/audioSyncOffsetStore.ts` (per-clip badge
  values), `src/renderer/state/audioUnitsStore.ts` (the display mode and its
  parsers), `src/renderer/shortcuts/defs.ts` (the five actions),
  `src/renderer/timeline/Timeline.tsx` (handlers + command registration),
  `src/renderer/timeline/LayerBlock.tsx` (the badge),
  `src/renderer/properties/PropertyPanel.tsx` (sub-frame fields + unit selector).
- Gates: `src/main/state/__tests__/audio-grid.test.ts` (both negative controls),
  `src/main/state/snap.test.ts` (the mixer twin + lattice-nesting properties),
  `src/main/state/__tests__/pbt/grid-invariant.test.ts` (now kind-aware, at eight
  rates — this is what fails if any of the three sites reverts to frame-only),
  `src/renderer/timeline/audioSlip.test.ts` (the no-drift-over-10 000-nudges
  property), `src/renderer/state/audioUnitsStore.test.ts`,
  `src/renderer/panels/AttributePanel.test.tsx`,
  `src/renderer/startup/canvasPresets.test.ts`, `src/renderer/frames.test.ts`.
  E2E: `e2e/electron/export-range-audio.spec.ts` (a slip survives group move,
  save/reopen and export) and `e2e/electron/audio-waveform-alignment.spec.ts`
  (a slip leaves waveform↔PCM addressing untouched).
- `docs/data-model.md` (§ Two grids), `docs/audio.md` (§ The authoring grid),
  `docs/features.md` (§ Groups — the A/V sync offset).
