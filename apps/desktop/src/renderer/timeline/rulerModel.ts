import {
  approxFrameDurUs,
  formatTimecode,
  frameCount,
  frameIndexCeil,
  frameIndexFloor,
  timeUsAtFrame,
} from "../frames";
import { formatRulerLabel } from "./geometry";

/// The time ruler's view model: which ticks exist, where they sit, and what they
/// read — for one (rate, zoom, viewport) triple. Pure and DOM/React-free, so the
/// long-timeline behaviour (24 h at 60 fps) is asserted by unit tests instead of
/// an e2e measurement.
///
/// Owns: the two tick regimes, the major-tick stride, tick labels, and the
/// VIEWPORT WINDOW that bounds the set. Does not own: how `scrollLeftPx` gets
/// here (`TimelineRuler` subscribes to `state/timelineScrollStore`), nor the
/// frame grid itself (`renderer/frames.ts`). See
/// `.scratch/timeline-frame-grid/spec.md`.
///
/// Two regimes:
///   - Below `pxPerFrame >= FRAME_MODE_THRESHOLD_PX`: the classic second-level
///     `NICE_STEPS_SEC` ladder, mm:ss labels.
///   - At/above the threshold: frame-grid mode. Major-tick stride is the largest
///     of `NICE_STEPS_FRAMES` where `stride * pxPerFrame >=
///     TARGET_MAJOR_PX_FRAME_MODE`, labels read SMPTE `HH:MM:SS:FF`, and minor
///     ticks land at every single frame regardless of major stride so the user
///     has a visible frame grid to align edits against.
///
/// Frame-mode tick times come from the composition frame grid, so the ruler and
/// the edited content are the same grid.

// Major-tick candidates: classic 1/2/5 decade ladder extended into sub-second
// territory for high-zoom cases. Anything above 600 s falls off the top of the
// ladder and clamps to 600.
const NICE_STEPS_SEC = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600,
] as const;
const NICE_STEPS_FRAMES = [1, 2, 5, 10, 30] as const;
const TARGET_MAJOR_PX = 100;
const TARGET_MAJOR_PX_FRAME_MODE = 80;
const SUBDIVISIONS = 5;
const FRAME_MODE_THRESHOLD_PX = 12;
const US_PER_SEC = 1_000_000;

/// Scroll distance the viewport may travel before the ruler recomputes its
/// window. The tick set is a function of the QUANTIZED scroll offset, so a
/// wheel gesture commits the ruler at most once per block instead of once per
/// event — the cheapest way to keep scroll out of React state above a leaf.
export const RULER_SCROLL_QUANTUM_PX = 200;

/// Extra px painted each side of the viewport. Expressed in pixels, not frames,
/// so it is zoom-invariant.
///
/// INVARIANT: `RULER_OVERSCAN_PX >= RULER_SCROLL_QUANTUM_PX`. The window is
/// built from a scroll offset that can lag the true one by up to a quantum, so
/// the overscan is what still covers the viewport's trailing edge; shrink it
/// below the quantum and ticks visibly stop short of the right edge mid-scroll.
export const RULER_OVERSCAN_PX = 400;

export type RulerMode = "second" | "frame";

/// One painted tick.
export interface RulerTick {
  /// Frame index in frame mode, minor-step index in second mode. Also the
  /// React key.
  frame: number;
  /// Left offset (px) at the current zoom, in row coordinates (x = 0 is time 0).
  xPx: number;
  /// The tick's time. In frame mode this is the canonical grid µs of frame
  /// `frame`, i.e. the same integer the actor's snap writes for a clip edge on
  /// that frame — that identity is what keeps a tick under the edit it marks an
  /// hour into the timeline.
  tUs: number;
  isMajor: boolean;
  /// Major ticks only: SMPTE `HH:MM:SS:FF` in frame mode, `mm:ss[.cs]` in
  /// second mode.
  label?: string;
}

export interface RulerModel {
  mode: RulerMode;
  /// The ticks inside the viewport window and nothing else — the length scales
  /// with viewport width and zoom, never with composition length.
  ticks: RulerTick[];
  /// Major spacing in seconds — second mode only (0 in frame mode).
  majorSec: number;
  /// Major spacing in frames — frame mode only (0 in second mode).
  strideFrames: number;
}

/// One options object rather than the six positional arguments the ticket
/// sketches: `totalSec` (the row's right bound, independent of the viewport) is
/// a required sixth input, and six same-typed numbers in a row is a call site
/// nobody can read.
export interface RulerModelInput {
  fpsNum: number;
  fpsDen: number;
  pxPerSec: number;
  /// Painted row extent in seconds (`computeTimelineExtent().totalSec`).
  totalSec: number;
  /// Row-local px offset of the visible lane area's left edge. The sticky
  /// track-header column covers the first `HEADER_COL_PX` of the scroll
  /// viewport, which makes the scroll root's `scrollLeft` exactly this offset —
  /// the same identity `registerScrollToTime` centres a time with.
  scrollLeftPx: number;
  viewportWidthPx: number;
  overscanPx?: number;
}

const EMPTY: RulerModel = {
  mode: "second",
  ticks: [],
  majorSec: 0,
  strideFrames: 0,
};

/// Tick layout for one (zoom, extent, rate, viewport).
export function computeRulerModel(input: RulerModelInput): RulerModel {
  const { fpsNum, fpsDen, pxPerSec, totalSec, scrollLeftPx, viewportWidthPx } =
    input;
  const overscanPx = input.overscanPx ?? RULER_OVERSCAN_PX;
  // Zoom is the px↔time conversion for every tick below; a non-positive one has
  // no layout to compute.
  if (!(pxPerSec > 0)) return EMPTY;

  // The window, in row pixels then in time. Both regimes turn these two times
  // into an index range and walk only that — nothing iterates the project.
  const x0 = Math.max(0, scrollLeftPx - overscanPx);
  const x1 = Math.max(x0, scrollLeftPx + Math.max(0, viewportWidthPx) + overscanPx);
  const startUs = (x0 / pxPerSec) * US_PER_SEC;
  const endUs = (x1 / pxPerSec) * US_PER_SEC;

  // px-per-frame is a DISPLAY DENSITY: it picks the regime and the major
  // stride, and never becomes a tick's time. That is the only use
  // `approxFrameDurUs` is licensed for — it is a rounded nominal width and
  // `i * approxFrameDurUs` walks off the grid (see its doc comment). Tick
  // times below come from `timeUsAtFrame`.
  const approxDurUs = approxFrameDurUs(fpsNum, fpsDen);
  const pxPerFrame = (approxDurUs / US_PER_SEC) * pxPerSec;
  // Degenerate fps has no grid to paint, so it stays on the second ladder
  // rather than collapsing every frame tick onto time 0.
  const frameMode =
    fpsNum > 0 && fpsDen > 0 && pxPerFrame >= FRAME_MODE_THRESHOLD_PX;

  if (frameMode) {
    // Pick the largest stride from [1, 2, 5, 10, 30] where the
    // major-tick spacing meets the target px. Fall back to the
    // largest if none meet the target (very low zoom for a
    // high-fps comp — rare).
    // Annotated `number` (not the `as const` literal `1`) so the loop can
    // assign any element of NICE_STEPS_FRAMES below.
    let stride: number = NICE_STEPS_FRAMES[0]!;
    for (let i = NICE_STEPS_FRAMES.length - 1; i >= 0; i--) {
      if (NICE_STEPS_FRAMES[i]! * pxPerFrame >= TARGET_MAJOR_PX_FRAME_MODE) {
        stride = NICE_STEPS_FRAMES[i]!;
      }
    }
    // Minor ticks at every frame; majors at every `stride` frames. The row's
    // last index comes from the same grid as the times: `frameCount` is how
    // many frames fall strictly inside the row, so its value is the index of
    // the first frame at or past the end — the deliberate trailing tick.
    const totalUs = Math.ceil(Math.max(0, totalSec) * US_PER_SEC);
    const lastFrame = frameCount(0, totalUs, fpsNum, fpsDen);
    // Window edges in frame-index space. `floor`/`ceil` (not `round`) so the
    // first tick sits at or left of the window and the last at or right of it —
    // the set always covers the window it was asked for.
    const first = Math.min(
      lastFrame,
      Math.max(0, frameIndexFloor(startUs, fpsNum, fpsDen)),
    );
    const last = Math.min(
      lastFrame,
      Math.max(first, frameIndexCeil(endUs, fpsNum, fpsDen)),
    );
    const ticks: RulerTick[] = [];
    for (let f = first; f <= last; f++) {
      const tUs = timeUsAtFrame(f, fpsNum, fpsDen);
      const isMajor = f % stride === 0;
      ticks.push({
        frame: f,
        xPx: (tUs / US_PER_SEC) * pxPerSec,
        tUs,
        isMajor,
        ...(isMajor ? { label: formatTimecode(tUs, fpsNum, fpsDen) } : {}),
      });
    }
    return { mode: "frame", ticks, majorSec: 0, strideFrames: stride };
  }

  const targetSec = TARGET_MAJOR_PX / pxPerSec;
  let major = NICE_STEPS_SEC[NICE_STEPS_SEC.length - 1] ?? 1;
  for (const s of NICE_STEPS_SEC) {
    if (s >= targetSec) {
      major = s;
      break;
    }
  }
  const minorUs = Math.round((major * US_PER_SEC) / SUBDIVISIONS);
  // Allow a half-step over `totalSec` so the trailing major lands on a clean
  // number if the timeline ends mid-interval — visually it gets clipped by the
  // canvas width, but the major label stays on its grid until the very end.
  const limitUs = Math.max(0, totalSec) * US_PER_SEC + minorUs * 0.5;
  const lastIdx = Math.floor(limitUs / minorUs);
  const first = Math.min(lastIdx, Math.max(0, Math.floor(startUs / minorUs)));
  const last = Math.min(lastIdx, Math.max(first, Math.ceil(endUs / minorUs)));
  const ticks: RulerTick[] = [];
  for (let i = first; i <= last; i++) {
    const tUs = i * minorUs;
    const isMajor = i % SUBDIVISIONS === 0;
    ticks.push({
      frame: i,
      xPx: (tUs / US_PER_SEC) * pxPerSec,
      tUs,
      isMajor,
      ...(isMajor
        ? { label: formatRulerLabel(tUs / US_PER_SEC, major) }
        : {}),
    });
  }
  return { mode: "second", ticks, majorSec: major, strideFrames: 0 };
}
