# Timeline frame-grid NLE alignment plan

**Status:** implementation started; FG-P1-1 completed locally
**Recorded:** 2026-07-22
**Implementation contract:** `.scratch/timeline-frame-grid/spec.md` — pinned
decisions, the enforced invariant, nine findings this review missed, and tickets
`01`–`07` for the correctness + scalability round. This document keeps the review
itself (industry baseline, drift tables, capability matrix); the spec keeps the
plan of record. Do not restate one in the other.
**Scope:** composition frame grid, timeline ruler, edit snapping, timecode,
audio edit precision, and composition-frame-rate lifecycle.

## Decision

WeftCut's video timing foundation is directionally correct and stronger than a
typical lightweight editor: composition fps is rational, timeline state uses
integer microseconds, edit ranges are half-open, the authoritative actor snaps
mutations, and export derives every output timestamp from the exact rational
rate.

The current system is **not yet at professional NLE parity**, however. There
are two correctness defects in the shipped frame-grid path, one long-timeline
scalability problem, and several inconsistent or missing professional
behaviours:

1. the ruler paints a drift-prone approximation rather than the authoritative
   rational frame grid;
2. an extreme trim can clamp an endpoint to `end - 1us` and persist an off-grid
   timeline value;
3. frame mode creates one DOM node per frame across the whole composition;
4. **resolved 2026-07-22:** mouse edge-drag trim now uses adjacent composition
   frame boundaries instead of a fixed 100 ms minimum;
5. timecode is NDF-only even for the 29.97 NTSC preset;
6. audio edits and audio keyframes are constrained to the video frame grid;
7. the actor can change fps after edits and silently re-snap timeline geometry.

For a lightweight/social-video editor the current behaviour is usable. For a
broadcast, interchange, or Premiere/Resolve/Final Cut-class workflow, the
items above are blockers.

## Industry baseline used for this review

There is no single standard prescribing the appearance of an NLE timeline.
This review uses the following interoperable and de-facto professional
behaviours as the baseline:

- [SMPTE ST 12-1](https://pub.smpte.org/latest/st12-1/st0012-1-2014.pdf) for
  timecode rates and time-address semantics;
- [OpenTimelineIO `RationalTime` and `TimeRange`](https://opentimelineio.readthedocs.io/en/v0.17.0/api/python/opentimelineio.opentime.html)
  for rational time and explicit exclusive-end ranges;
- [Adobe sequence settings](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/sequence-presets-and-settings.html)
  for a sequence timebase that is fixed after creation;
- [Adobe timecode settings](https://helpx.adobe.com/uk/premiere/desktop/edit-projects/change-clip-sequence/sequence-settings-reference.html)
  for DF/NDF and sample-level audio display;
- [Final Cut Pro project settings](https://support.apple.com/en-mide/guide/final-cut-pro/ver1b946a4ff/mac)
  for locking project fps once a timeline is non-empty;
- [Final Cut Pro trimming](https://support.apple.com/guide/final-cut-pro/trim-ver8e3f33db/mac)
  and [subframes](https://support.apple.com/en-ca/guide/final-cut-pro/ver8e3f3850/mac)
  for one-frame video precision and finer-than-frame audio precision.

These references are comparison points, not a requirement to copy another
editor's UI or internal storage model.

## Current design that should be preserved

### Rational composition rate

`Composition.fps` is `{num, den}` rather than a decimal. This correctly keeps
`30000/1001` distinct from `29.97` and should remain the canonical rate shape.
See `docs/data-model.md` and
`apps/desktop/src/main/state/model.ts`.

### Integer timeline time with distinct source time

Persisting realistic project times as integer microseconds is precise enough;
it does not need to be replaced merely to claim NLE correctness. Composition
geometry and source-media time are already treated as separate domains:

- `t_start_us` / `t_end_us` are composition positions;
- `src_in_us` / `src_out_us` are source-media positions and are not
  composition-frame-snapped.

That distinction is important for mixed-rate and VFR media and should be made
more explicit in types, not collapsed.

### Shared commit-side snap

`snap_frame_round` lives in `native/eval/src/lib.rs`, uses `i128` arithmetic,
and is exposed to TypeScript through the same WASM leaf used by the actor. This
is the correct seam for renderer/actor agreement. Keep the shared native/WASM
implementation.

### Exact export timestamps and half-open ranges

`renderer/render/worker/frameGrid.ts` computes output timestamp `i` from the
exact rational expression and derives frame count from the same `[start,end)`
predicate. This avoids the classic 301-output-frames-from-a-300-frame-range
bug. The playhead's last-frame anchor and exclusive layer Out semantics are
also sound.

### Magnetic snapping is separate from frame quantization

The optional pixel-threshold snap to clip boundaries and the playhead is
layered on top of unconditional composition-frame quantization. Preserve this
separation: disabling magnetic snapping must not allow off-grid video edits.

### One-frame capability clarification (2026-07-22)

The product does **not** lack single-frame editing as a whole. The earlier
review wording conflated one broken interaction path with the complete editing
surface. The current capability matrix is:

| Operation | Current support | Evidence |
|---|---|---|
| Step the playhead by one frame | Yes | `ArrowLeft` / `ArrowRight` dispatch frame-step commands and the clock returns to the canonical grid. |
| Create a one-frame clip with the blade | Yes | A blade click is frame-snapped; splitting one frame from an existing edge produces a one-frame half. The split mutation has no 100 ms minimum. |
| Set a one-frame duration by timecode | Yes | The Attribute panel accepts `HH:MM:SS:FF` duration and sends the resulting Out point directly to the trim command. Normal source bounds still apply. |
| Move an existing one-frame clip | Yes | Move destinations are frame-snapped and the clip span is retained. |
| Trim down to one frame by dragging an edge | Yes | Drag preview, magnetic-snap validation, and pointer-up commit use the adjacent canonical frame boundary. |
| Safely edge-drag an existing one-frame clip | Yes | Extending by one frame produces a two-frame clip; dragging inward cannot cross the opposite edge's adjacent frame boundary. |

This cross-path consistency defect was corrected on 2026-07-22. The actor's
separate one-microsecond clamp and its possible off-grid extreme result remain
tracked by FG-P0-2.

## Findings

### FG-P0-1 — The painted ruler is not the authoritative frame grid

**Evidence**

`apps/desktop/src/renderer/timeline/TimelineRuler.tsx` does the following in
frame mode:

```text
fDur = round(1_000_000 * fpsDen / fpsNum)
tUs  = frameIndex * fDur
```

This is the exact approximation that `renderer/frames.ts` and
`renderer/render/worker/frameGrid.ts` warn must not be accumulated. Persisted
clip edges and the playhead use `round(frameIndex * exactFrameDuration)`, so
the ruler and the edited content are two different grids.

At the current maximum zoom of 2000 px/s, the error after one nominal hour is:

| Rate | Ruler drift | Visual displacement | Timecode-frame error |
|---|---:|---:|---:|
| 30/1 | -36 ms | -72 px | -1 frame |
| 30000/1001 | +36 ms | +72 px | +1 frame |
| 60/1 | +72 ms | +144 px | +4 frames |
| 60000/1001 | -72 ms | -144 px | -4 frames |

**Impact**

- frame ticks eventually stop lining up with clip edges and the playhead;
- major labels can show a neighbouring frame;
- the error is most visible exactly when the user zooms in for precision work.

**Required correction**

Generate every tick from a frame index through the authoritative exact-rational
conversion. Never multiply by a pre-rounded frame duration. Ruler labels must
format that same canonical tick time or, preferably, the tick's frame index.

### FG-P0-2 — Trim clamping can violate the persisted grid invariant

**Evidence**

`apps/desktop/src/main/state/mutations/trim.ts::trimDeltaBounds` protects a
layer from collapsing by allowing a maximum trim of `duration - 1us`. The
clamped delta is then added directly to `t_start_us` or `t_end_us` without a
second grid conversion.

For a 30 fps layer `[1_000_000, 3_000_000)`, requesting an In trim at or beyond
the Out edge can persist:

```text
t_start_us = 2_999_999
t_end_us   = 3_000_000
```

`main/state/validate.ts` checks only `start < end`; it does not verify frame
alignment, so the commit succeeds despite the documented invariant in
`docs/data-model.md`.

Source-duration clamps can create the same class of problem because an
arbitrary source boundary may clamp a composition delta to a non-frame value.

**Impact**

- actor state can contradict its own public contract;
- later move, split, timecode, render, and export paths have to repair or
  reinterpret the endpoint;
- UI, MCP, and future adapters can observe different results at the same edit.

**Required correction**

- express the minimum video-layer duration and trim bounds in composition frame
  indices;
- select the nearest valid grid boundary inside both timeline and source
  constraints;
- add a validation backstop that rejects non-canonical video timeline
  boundaries after every mutation;
- add regression coverage for over-trimming at both edges and for an off-grid
  source-duration cap.

### FG-P0-3 — Ruler complexity grows with total timeline frames

**Evidence**

Frame mode builds an array from frame zero through the complete timeline extent
and renders one absolutely positioned `<div>` per entry. A one-hour 60 fps
timeline therefore creates roughly 216,000 React/DOM nodes before accounting
for edit padding.

**Impact**

- long-form timelines can stall render, reconciliation, layout, and memory;
- zooming into frame mode does more work as the project gets longer even when
  the viewport still shows only a small number of frames.

**Required correction**

Make ruler cost proportional to the visible viewport, not composition length:

- derive the visible time/frame interval from `scrollLeft`, viewport width,
  and `pxPerSec`;
- render only visible ticks plus a small overscan;
- alternatively paint minor ticks on Canvas/SVG or a repeating background,
  while keeping accessible labels as a small virtualized DOM set;
- keep node count bounded independently of a 24-hour test composition.

### FG-P1-1 — Resolved: edge-drag trim supports one-frame clips

**Status:** completed locally on 2026-07-22

**Original evidence**

Before the correction, `renderer/timeline/geometry.ts` defined
`MIN_LAYER_DURATION_US = 100_000`, and the edge-drag preview, magnetic-snap
validity check, and pointer-up commit used it for both trim edges.

This meant edge-drag trim could not reduce a clip to:

- a one- or two-frame clip at 30 fps;
- a one- through five-frame clip at 60 fps.

Other interaction paths were already more capable: the blade could split one
frame from an edge, the Attribute panel could submit a one-frame duration,
frame stepping was available from the keyboard, and a one-frame clip could be
moved. The actor still accepts any positive duration down to one microsecond;
that remaining policy mismatch is covered by FG-P0-2.

**Resolution requirements**

- Replace the edge-drag-only 100 ms clamp with adjacent canonical frame
  boundaries computed through `FrameGrid`.
- Use the same rule for live preview and pointer-up commit.
- Preserve the existing one-frame blade, timecode-entry, stepping, selection,
  and move paths.
- Ensure grabbing either edge of an existing one-frame clip never expands it
  to 100 ms.
- For audio layers, define one sample or a deliberate subframe quantum in the
  later audio phase. Hit-target sizing must be solved visually; it must not
  impose a larger temporal duration.

**Implementation**

- Added exact-rational adjacent-frame-boundary calculation in
  `renderer/frames.ts`; it derives the neighbour from the anchor frame index
  instead of adding a rounded frame duration.
- Routed live trim preview, magnetic-snap validity, and pointer-up commit
  through that shared calculation.
- Added left/right edge interaction coverage at 30 and 60 fps, existing
  one-frame clip coverage, fractional-rate boundary tests, and actor-side
  acceptance tests for one-frame In/Out trims.

### FG-P1-2 — 29.97/59.94 timecode has no drop-frame mode

**Evidence**

`renderer/frames.ts::formatTimecode` and `parseTimecode` implement NDF only,
always use `:` separators, and intentionally accept wall-clock drift. The new
project UI nevertheless exposes a 29.97 NTSC preset.

NDF is not intrinsically wrong, but NDF-only prevents accurate clock-duration
reporting in common NTSC broadcast workflows. At 29.97, `01:00:00:00` NDF is
about 3.6 seconds longer than one wall-clock hour.

**Required correction**

Introduce an explicit timecode policy:

```text
mode: NDF | DF
start frame/timecode: project-defined, default 00:00:00:00
```

- DF is offered for `30000/1001` and `60000/1001`;
- DF formatting uses `;` before the frame field;
- parsing rejects skipped DF labels;
- existing projects migrate to NDF to preserve their current display;
- the NTSC new-project preset must make its default policy an explicit product
  decision rather than inheriting an accidental global default.

Source timecode and configurable sequence starting timecode should be designed
with this work so interchange does not require another incompatible format.

### FG-P1-3 — Audio authoring is constrained to video frames

**Evidence**

The actor snaps every layer's composition edges without distinguishing visual
from audio layers. `main/state/mutations/params.ts` also normalizes every
keyframe, including audio gain and pan, to the composition video grid.

The audio mixer internally uses a sample grid, but the authoring model cannot
place an audio edit or automation point at sample/subframe precision.

**Impact**

- dialogue, transient, and sync corrections finer than one video frame are
  impossible to author;
- increasing the video fps accidentally changes available audio edit
  precision;
- the UI cannot reach the precision already present in the audio engine.

**Required correction**

Add a distinct audio-time module and typed time domain:

- video/visual geometry: composition `FrameGrid`;
- audio layer geometry and audio automation: sample grid or a documented
  subframe grid;
- source media PTS: source-time domain, unchanged;
- conversions occur at explicit seams rather than by passing an unqualified
  `number` called `TimeUs` everywhere.

This is a separate phase because overlap validation, groups, transitions,
waveforms, snapping, and export-range lowering must all be audited together.

### FG-P1-4 — Composition fps remains mutable after editing

**Evidence**

`main/state/actor.ts::setComposition` accepts an fps patch, re-snaps every layer
edge, re-snaps Motif source time, and records the transformed geometry. The
operation is available to the MCP surface even though the regular settings UI
does not prominently expose it.

**Impact**

- edit points move by up to half a new frame per edge;
- short layers may collapse and reject the whole operation;
- an AI client can perform a structurally destructive conversion through what
  appears to be a composition-settings patch.

**Required correction**

Lock composition fps once temporal content exists. If rate conversion is later
needed, expose an explicit `duplicate/convert timeline` workflow that previews
rounding effects and leaves the original timeline intact.

### FG-P2-1 — The frame-grid module interface is fragmented

The shared snap algorithm is sound, but the overall module is shallow and
spread across several caller-visible implementations:

- native/WASM round and floor functions;
- `renderer/frames.ts` frame duration, a second floor policy, last-frame anchor,
  frame indexing, and timecode;
- worker-only output time/count functions;
- ruler-local tick generation;
- shortcut-local one-frame stepping.

Callers must know which helper is safe for accumulation and which rounding
policy its output uses. The ruler drift is a direct result of this fragmented
interface.

## Target module design

### `FrameGrid` module

Create one deep module whose small interface hides rational arithmetic and
integer-microsecond quantization. At minimum it owns:

```text
timeUsAt(frameIndex)
frameIndexAt(timeUs, floor | nearest | ceil)
snap(timeUs, floor | nearest | ceil)
frameCount([startUs, endUs))
lastFrameAnchor(durationUs)
isCanonical(timeUs)
```

Rules:

- all functions derive from the exact rational `fpsNum/fpsDen`;
- no caller may accumulate `frameDurUs`;
- the native/WASM leaf remains the implementation source of truth;
- renderer, main actor, playback, ruler, and export cross the same interface;
- `frameDurUs` may remain only as a display/estimate helper and must be named to
  make its non-accumulable nature obvious.

Keep persisted `TimeUs` for the first correction phase to avoid an unnecessary
schema migration. A future OTIO/interchange project can reconsider storing
video positions as frame-index/rate pairs independently.

### `Timecode` module

Timecode is a presentation and interchange policy layered on `FrameGrid`, not
the grid itself. It owns DF/NDF, separator rules, starting timecode, parsing,
formatting, and frame-number display.

### `TimelineRulerModel` module

Extract tick selection and visible-range generation from React. Its interface
takes rate, zoom, visible pixel interval, and overscan, and returns a bounded
set of exact-grid ticks. React should only render the returned view model.

### `AudioGrid` module

Add this only when the audio-authoring phase starts. It owns sample/subframe
conversion and makes the distinction from video `FrameGrid` explicit.

## Delivery phases

### Phase 0 — Characterization gates

- Add exact-rational ruler-model tests before changing rendering.
- Add a mutation invariant helper that checks canonical layer endpoints.
- Add a failing regression for extreme In/Out trim and off-grid source caps.
- Characterize the already-working one-frame blade, timecode-entry, and move
  paths so the correction cannot regress them.
- Add failing edge-drag cases that trim to one frame and manipulate an existing
  one-frame clip at 30 and 60 fps.
- Record a long-timeline node-count/performance baseline.

### Phase 1 — Correctness and consistent one-frame trimming

- Land the shared `FrameGrid` interface.
- Replace ruler multiplication with exact frame-index conversion.
- Clamp trim bounds in frame-index space.
- Add actor validation as a final grid backstop.
- Replace the fixed 100 ms UI minimum with one frame.
- Route shortcut frame stepping through frame indices rather than a rounded
  duration delta.

### Phase 2 — Long-timeline ruler scalability

- Extract `TimelineRulerModel`.
- Plumb visible scroll geometry into the ruler.
- Virtualize ticks and labels with overscan.
- Verify bounded node count on one-hour and 24-hour timelines.

### Phase 3 — Timebase lifecycle and timecode

- Lock fps after temporal content exists.
- Define project timecode policy and schema migration.
- Implement DF/NDF parsing and formatting.
- Add starting timecode and source-timecode design needed for interchange.
- Add 23.976/24/25/50/59.94 presets or a validated custom-rate path.

### Phase 4 — Audio subframe/sample authoring

- Define the audio timeline quantum and UI mode.
- Make layer-boundary validation kind-aware.
- Support subframe/sample audio trim, nudge, snapping, and automation.
- Audit groups containing video and audio so linked edits preserve sync while
  each member remains canonical in its own time domain.
- Verify preview/export waveform and PCM alignment after subframe edits.

## Acceptance criteria

### Correctness

- For every supported rate and frame index, actor, ruler, playback, and export
  resolve the same canonical microsecond value.
- No successful video/visual mutation can leave an off-grid timeline endpoint.
- Existing blade and timecode-entry paths can create a one-frame clip, and the
  resulting clip remains selectable and movable.
- Edge-drag trim can land on one frame, and dragging either edge of an existing
  one-frame clip never expands it to 100 ms.
- Frame count and frame timestamps agree at every half-open range tail.
- FPS mutation on a non-empty timeline fails with a structured, actionable
  error.

### Timecode

- NDF round-trips at all supported rates.
- DF round-trips at 29.97 and 59.94, rejects skipped labels, and uses `;`.
- One wall-clock hour displays as one DF hour at NTSC fractional rates.
- Existing projects retain their current NDF display after migration.

### Performance

- Ruler DOM/tick count is bounded by viewport width and zoom, not project
  duration.
- A 24-hour timeline does not allocate a frame-sized array.
- Zooming across the frame-mode threshold does not visibly jump tick positions.

### Audio

- Audio-only edits can move at the selected sample/subframe precision.
- Video edits remain composition-frame-aligned.
- Linked video/audio edits preserve sync without coercing audio back to the
  video grid.

## Test matrix

Exercise at least:

- rates: `24000/1001`, `24/1`, `25/1`, `30000/1001`, `30/1`, `50/1`,
  `60000/1001`, `60/1`;
- durations: one frame, ten seconds, ten minutes, one hour, and 24 hours;
- zoom: below frame mode, exactly at the threshold, and maximum zoom;
- ranges: aligned, sub-frame raw input, arbitrary source cap, empty, inverted,
  and exact exclusive tail;
- mutations: add, move, trim both edges, split, duplicate/paste, grouped edits,
  composition duration, and attempted fps change;
- property tests: snap idempotence, index/time round-trip, monotonic frame times,
  invariant preservation after every successful actor command.

The relevant baseline run on 2026-07-22 passed:

```text
7 test files passed
75 tests passed
```

Those tests cover shared snap, frame helpers, export frame count, timeline
snapping, actor snap/trim, and timeline interactions. They do **not** currently
cover exact ruler tick positions over long durations, bounded ruler rendering,
DF timecode, grid invariants after a clamped trim, or an end-to-end one-frame
clip workflow. In particular, the existing split test cuts at 400 ms and the
Attribute-panel duration test enters one second, so the current one-frame
capabilities are established by the implementation paths but are not protected
by explicit regression tests yet.

## Design decisions to make before Phase 3/4

1. Should new 29.97/59.94 projects default to DF, or should the preset expose an
   explicit choice?
2. Is project starting timecode unrestricted, conventionally `01:00:00:00`, or
   fixed at zero for the first schema version?
3. Should audio authoring use exact sample positions or an NLE-style subframe
   quantum such as 1/80 video frame?
4. What happens when a linked video/audio group is moved by an audio-only
   subframe command?
5. Do high-frame-rate projects above 99 fps use a three-digit frame field or a
   separate high-frame-rate timecode policy?

These questions do not block Phase 0-2. Resolve them before changing persisted
timecode or audio geometry.

## Primary code seams

- `apps/desktop/native/eval/src/lib.rs`
- `apps/desktop/src/renderer/eval/index.ts`
- `apps/desktop/src/renderer/frames.ts`
- `apps/desktop/src/renderer/render/worker/frameGrid.ts`
- `apps/desktop/src/renderer/timeline/TimelineRuler.tsx`
- `apps/desktop/src/renderer/timeline/hooks/useLayerDrag.ts`
- `apps/desktop/src/renderer/timeline/geometry.ts`
- `apps/desktop/src/main/state/mutations/trim.ts`
- `apps/desktop/src/main/state/mutations/params.ts`
- `apps/desktop/src/main/state/validate.ts`
- `apps/desktop/src/main/state/actor.ts`

Delete this plan after the corrected invariants and professional behaviours are
documented in their evergreen homes (`docs/data-model.md`, `docs/audio.md`, and
the relevant ADRs).
