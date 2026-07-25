/// Two time domains, ONE grid implementation.
///
/// Video geometry lives on the composition frame grid; audio geometry lives on the
/// fixed 48 kHz mix lattice (ADR 0038). Everything here exists so those two are
/// selected by a single function instead of being re-decided at every snap site —
/// the mistake ADR 0037 left behind, where `move`'s group fan-out and
/// `serialize.ts`'s load repair would silently drag sample-aligned audio back onto
/// the video frame grid.
///
/// THE KEY FACT, and the reason this is not a second grid: a 48 kHz sample boundary
/// IS a frame boundary at rate 48000/1.
///   timeUsAtFrame(i, 48000, 1)  === round(i * 1e6 / 48000)   ← the sample time
///   frameIndexRound(us, 48000, 1) === usToFrame(us, 48000)   ← the mixer's index
/// (that second identity reduces to `(us*48000 + 500000)/1000000` on both sides —
/// asserted in `main/state/snap.test.ts`.) So `domain` NAMES the lattice for
/// diagnostics and messaging; it does not select a different algorithm. There is one
/// i128 leaf implementation, which is what makes "zero rounding at the render seam"
/// true rather than aspirational: the authoring index and the mixer's sample index
/// are the same integer.
///
/// Lives in the renderer tree, beside `frames.ts`, because BOTH sides need it: the
/// actor re-exports it through `main/state/snap.ts` (the same direction main already
/// takes for the eval leaf), and the timeline UI imports it directly for nudges and
/// readouts. A copy on each side would be exactly the drift this file prevents.
import { frameIndexRound, snapFrameCeil, snapFrameFloor, snapFrameRound, timeUsAtFrame } from './eval'

/** The mix lattice, hard-coded in BOTH engines (`native/src/audio/mix.rs`
 *  MIX_SAMPLE_RATE, and the TS twin's `chunkSchedule.ts` framesToUs). Do not add a
 *  third: this constant is the authoring half of that same pair.
 *
 *  NOT `composition.sample_rate` — that field is read only as the EXPORT target, so
 *  it is a delivery parameter, moves no edit, and is deliberately never locked. */
export const AUDIO_SAMPLE_RATE_HZ = 48_000

/** Samples per millisecond — the coarse nudge tier's step (1 ms = 48 samples). */
export const AUDIO_SAMPLES_PER_MS = AUDIO_SAMPLE_RATE_HZ / 1000

/** Which lattice a time lives on. Diagnostics only — see the note above. */
export type GridDomain = 'frame' | 'sample'

/** A rate pair, structurally compatible with the actor's `Rational`. */
export interface RateLike {
  num: number
  den: number
}

/** A lattice: canonical times are `round(i * 1e6 * den / num)` for integer `i`. */
export interface Grid extends RateLike {
  domain: GridDomain
}

/** The 48 kHz sample lattice. A module constant because it never varies: the mix
 *  rate is fixed, so audio precision does NOT change when the video fps does —
 *  which was the defect (raising fps silently changed available audio precision). */
export const AUDIO_GRID: Grid = { domain: 'sample', num: AUDIO_SAMPLE_RATE_HZ, den: 1 }

/** The composition frame lattice for `fps`. */
export function frameGrid(fps: RateLike): Grid {
  return { domain: 'frame', num: fps.num, den: fps.den }
}

/** THE grid lookup — the single seam every enforcement and authoring site shares
 *  (`validate.ts`'s predicate, the mutation snaps incl. `move`'s group fan-out,
 *  `serialize.ts`'s load repair, and the UI's nudge + readout paths). Adding another
 *  site means calling this, never re-deriving the choice.
 *
 *  `kind` is a plain `string` on purpose: `repairGrid` runs on the WIRE shape before
 *  the cast to `Project`, and the renderer reads kinds off the project summary, so
 *  neither side has the narrowed union to hand. An unrecognized kind answers the
 *  frame grid — the conservative default, since every visual kind is on it and a
 *  corrupt kind is validate's to reject. */
export function gridForLayerKind(kind: string, fps: RateLike): Grid {
  return kind === 'Audio' ? AUDIO_GRID : frameGrid(fps)
}

/** Nearest lattice point (half-up) — the snap every mutator uses. */
export function snapOnGrid(tUs: number, g: Grid): number {
  return snapFrameRound(tUs, g.num, g.den)
}

/** Lattice point at or below `tUs` — outward-safe for a low bound. */
export function snapDownOnGrid(tUs: number, g: Grid): number {
  return snapFrameFloor(tUs, g.num, g.den)
}

/** Lattice point at or above `tUs` — outward-safe for a high bound. */
export function snapUpOnGrid(tUs: number, g: Grid): number {
  return snapFrameCeil(tUs, g.num, g.den)
}

/** Index of the lattice point nearest `tUs`. For `AUDIO_GRID` this IS the mixer's
 *  sample-frame index (`usToFrame(tUs, 48000)`), which is what makes a one-sample
 *  nudge exact rather than approximately one sample. */
export function gridIndex(tUs: number, g: Grid): number {
  return frameIndexRound(tUs, g.num, g.den)
}

/** Canonical µs of lattice point `i`. */
export function timeUsAtGridIndex(i: number, g: Grid): number {
  return timeUsAtFrame(i, g.num, g.den)
}

/** True when `tUs` is a lattice point — equivalently, when snapping is identity.
 *  A degenerate rate has no lattice; `InvalidFps` owns that. */
export function isCanonicalOnGrid(tUs: number, g: Grid): boolean {
  if (g.num <= 0 || g.den <= 0) return true
  return snapOnGrid(tUs, g) === tUs
}

/** `tUs` stepped by `steps` lattice points, clamped at 0.
 *
 *  Resolved through the INDEX, never by adding a quantum's width in µs. That is the
 *  whole reason a nudge is exact: lattice spacing is not an integer number of
 *  microseconds (48 kHz alternates 20/21 µs), so `tUs + steps * 20.83` accumulates
 *  error and 10 000 nudges out-and-back would not return to the start — the same
 *  defect class as the video frame-step bug. Index arithmetic is exact by
 *  construction, so out-and-back is the identity for any step count. */
export function stepOnGrid(tUs: number, steps: number, g: Grid): number {
  return timeUsAtGridIndex(Math.max(0, gridIndex(tUs, g) + steps), g)
}
