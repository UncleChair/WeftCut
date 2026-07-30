/// THE frame-grid surface for the renderer, the timeline UI, and the main-process
/// actor (via `main/state/snap.ts`). Every primitive here is the wasm-backed
/// `weftcut-eval` leaf — the SAME crate the Rust actor and export link natively —
/// so there is one frame grid, not hand-mirrored copies (ADR 0025). What this
/// module adds on top is composition-level policy: the playhead's last-frame
/// anchor, a neighbouring boundary, layer-local indexing, and SMPTE timecode.
///
/// DO NOT reimplement a primitive in TS. The leaf is i128 precisely because JS
/// doubles have a ceiling here: a 24 h timeline at 60000/1001 evaluates
/// `frame * 1e6 * den ≈ 5.18e15`, only 1.7× under 2^53 — exact today, and one
/// added factor away from silently losing integers. The µs values and frame
/// indices that cross the wasm ABI as f64 are far below that bound; the
/// intermediate products are not.
///
/// This module is the COMPOSITION-frame surface. Audio geometry lives on a second
/// lattice (the fixed 48 kHz mix rate, ADR 0038), and which lattice a given layer
/// uses is decided in exactly one place — `gridForLayerKind` in `./grid.ts`. Reach
/// for that when the answer depends on layer kind; reach for this when you already
/// know you mean composition frames (the ruler, the playhead, timecode).
///
/// `initEval()` must have resolved before any call (the renderer bootstrap and
/// the main-process boot both await it; vitest does it in `testSetup.ts`).
export {
  snapFrameRound,
  snapFrameFloor,
  snapFrameCeil,
  timeUsAtFrame,
  frameIndexFloor,
  frameIndexRound,
  frameIndexCeil,
  frameCount,
} from "./eval";

import { frameIndexFloor, frameIndexRound, snapFrameFloor, timeUsAtFrame } from "./eval";

const US_PER_SEC = 1_000_000;
const DEFAULT_FRAME_DUR_US = 33_333; // 30 fps fallback

/// NOMINAL microseconds per composition frame — display and estimate only, e.g.
/// a ruler's tick-spacing decision or a single frame-step delta. Falls back to
/// 33333 (30 fps) on degenerate fps.
///
/// NOT ACCUMULABLE: rational rates have no constant integer frame width (adjacent
/// 30000/1001 boundaries are 33_366 or 33_367 µs apart), so `i * approxFrameDurUs`
/// drifts off the grid — ~99 µs by frame 299 at 30 fps, eventually a whole frame.
/// Anything that needs a real grid time calls `timeUsAtFrame`.
export function approxFrameDurUs(fpsNum: number, fpsDen: number): number {
  if (fpsNum <= 0 || fpsDen <= 0) return DEFAULT_FRAME_DUR_US;
  return Math.round((US_PER_SEC * fpsDen) / fpsNum);
}

/** The canonical frame boundary immediately before or after `anchorUs`, derived
 * from the anchor's frame index (never by adding a frame duration — see
 * `approxFrameDurUs`), so trim previews and commits land on the same grid the
 * commit-side snap uses. Clamped at frame 0. */
export function adjacentFrameBoundaryUs(
  anchorUs: number,
  direction: -1 | 1,
  fpsNum: number,
  fpsDen: number,
): number {
  if (fpsNum <= 0 || fpsDen <= 0) {
    return Math.max(0, anchorUs + direction * DEFAULT_FRAME_DUR_US);
  }
  const anchorFrame = frameIndexRound(anchorUs, fpsNum, fpsDen);
  return timeUsAtFrame(Math.max(0, anchorFrame + direction), fpsNum, fpsDen);
}

/// Start of the last displayable frame in a composition of length
/// `durationUs` µs. The playhead's upper bound under the frame-anchor
/// rule (see `docs/data-model.md`).
///
/// Boundary entities — layer `t_end_us`, `composition.duration_us`,
/// trim-end handles — are unaffected; they remain exclusive and may
/// equal `durationUs`. The clamp is per-tool, not per-time-value.
export function lastFrameAnchorUs(
  durationUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  if (fpsNum <= 0 || fpsDen <= 0 || durationUs <= 0) return 0;
  // durationUs is on the comp-frame grid (snap invariant), so `round` recovers
  // an exact total-frame count rather than approximating one.
  const totalFrames = frameIndexRound(durationUs, fpsNum, fpsDen);
  if (totalFrames <= 1) return 0;
  return timeUsAtFrame(totalFrames - 1, fpsNum, fpsDen);
}

/// Start of the frame the playhead at `playheadUs` DISPLAYS. Identical to
/// `snapFrameFloor` — this name exists so display-translation call sites read
/// as the convention they implement (see `docs/data-model.md`, boundary
/// semantics), not as arithmetic.
export function displayedFrameStartUs(
  playheadUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  if (fpsNum <= 0 || fpsDen <= 0) return Math.max(0, playheadUs);
  return snapFrameFloor(Math.max(0, playheadUs), fpsNum, fpsDen);
}

/// Exclusive end boundary of the frame the playhead at `playheadUs` displays —
/// what an inclusive "mark out at the playhead" must STORE, given that range
/// and boundary entities are exclusive while the playhead is a frame anchor.
/// A playhead parked on the last frame yields exactly the composition
/// duration, so set-from-playhead can reach the final frame.
///
/// The one-frame gap between the two conventions is bridged HERE, never by a
/// bare `+1` at a call site — a stored exclusive end fed by a frame-anchor
/// source without this translation silently drops the displayed frame.
export function inclusiveOutBoundaryUs(
  playheadUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  const anchor = Math.max(0, playheadUs);
  if (fpsNum <= 0 || fpsDen <= 0) return anchor + DEFAULT_FRAME_DUR_US;
  return timeUsAtFrame(frameIndexFloor(anchor, fpsNum, fpsDen) + 1, fpsNum, fpsDen);
}

/// The frame a boundary should SHOW the user. `in` side: the boundary itself
/// (first kept frame). `out` side: the start of the last kept frame BEFORE the
/// exclusive boundary — the trim/out-point display convention traditional NLEs
/// pair with frame-anchor playheads (Premiere/Resolve show the last included
/// frame while dragging a tail trim, not the frame past the cut).
export function boundaryDisplayFrameUs(
  boundaryUs: number,
  side: "in" | "out",
  fpsNum: number,
  fpsDen: number,
): number {
  if (side === "in") return Math.max(0, boundaryUs);
  return lastFrameAnchorUs(boundaryUs, fpsNum, fpsDen);
}

/// Format `us` as SMPTE-style `HH:MM:SS:FF` against the given comp fps.
///
/// NDF (non-drop-frame) at EVERY rate, deliberately and permanently: frame
/// intervals are uniform and the label counts them, so at 29.97 a displayed hour
/// spans 3603.6 s of wall clock (~3.6 s/hour of "drift"). That is correct NDF
/// behaviour, not a rounding bug.
///
/// Drop-frame was DECLINED, not deferred (spec R2-D3): DF never changes a stored
/// microsecond — it is purely a label — and its value chain needs an interchange
/// consumer (EDL / AAF / OTIO / FCPXML) that does not exist here, while export
/// writes no timecode track. It would cost a persisted field, a schema migration,
/// `;` parsing, and skipped-label rejection to relabel numbers that are already
/// right. The honest fix for the one thing that actually misleads a user — reading
/// a DURATION and assuming wall clock — is `wallClockAside` below, shown beside
/// duration readouts. Starting timecode is fixed at zero for schema v1 (R2-D4);
/// this function and `parseTimecode` are the single insertion point if that is
/// ever revisited, and DF + a start offset must then be revisited TOGETHER
/// (they share one migration). See ADR 0038.
///
/// Frame field zero-pads to two digits, which stays correct because there is no
/// custom-rate entry — the preset ceiling is 60 fps (R2-D5).
///
/// totalFrames comes from the grid, not `us / approxFrameDurUs` — the nominal
/// duration accumulates ~1 frame of error per hour at 30 fps.
export function formatTimecode(
  us: number,
  fpsNum: number,
  fpsDen: number,
): string {
  if (fpsNum <= 0 || fpsDen <= 0) {
    return formatTimecode(us, 30, 1);
  }
  const totalFrames = Math.max(0, frameIndexRound(us, fpsNum, fpsDen));
  const framesPerSec = Math.max(1, Math.round(fpsNum / fpsDen));
  const f = totalFrames % framesPerSec;
  const totalSec = Math.floor(totalFrames / framesPerSec);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}:${pad(f, 2)}`;
}

/// Format `us` as real elapsed time, `HH:MM:SS.mmm`. No frame rate in it at all —
/// that is the point: this is what a stopwatch would read, so it is the honest
/// companion to an NDF timecode whose digits do not.
///
/// Milliseconds truncate rather than round so the label never reads one step past
/// the value it describes (a 999_900 µs duration shows `00:00:00.999`, not `1.000`).
export function formatWallClock(us: number): string {
  const clamped = Math.max(0, Math.floor(us));
  const ms = Math.floor(clamped / 1_000) % 1_000;
  const totalSec = Math.floor(clamped / US_PER_SEC);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/// True when the rate is not a whole number of frames per second — i.e. the NTSC
/// family (24000/1001, 30000/1001, 60000/1001). Only here do an NDF timecode's
/// digits disagree with wall clock, because `formatTimecode` divides by the
/// ROUNDED `fpsNum/fpsDen` to fill the seconds field.
export function isFractionalRate(fpsNum: number, fpsDen: number): boolean {
  if (fpsNum <= 0 || fpsDen <= 0) return false;
  return fpsNum % fpsDen !== 0;
}

/// The wall-clock figure to show beside a DURATION readout, or `null` when there
/// is nothing worth saying.
///
/// Positions deliberately have no caller here: a playhead readout or a ruler label
/// makes no wall-clock claim, so a second figure there is noise. A duration does
/// make one — "01:00:00:00 long" reads as an hour and at 29.97 it is 3.6 s more —
/// and that is the only place NDF actually misleads (spec R2-D3).
///
/// Returns null at integer rates BECAUSE the two figures are then the same instant
/// rendered twice; showing it anyway would train the user to ignore it.
export function wallClockAside(
  us: number,
  fpsNum: number,
  fpsDen: number,
): string | null {
  if (!isFractionalRate(fpsNum, fpsDen)) return null;
  return formatWallClock(us);
}

/// Given an in-layer playhead position `tInLayerUs` (µs from the layer's
/// own origin, i.e. after subtracting `t_start_us` from the comp position
/// and adding `src_in_us`), return the zero-based index of the source
/// frame that should be displayed. Clamped to 0 for non-positive inputs
/// and degenerate fps.
///
/// The grid floor (not an exact-rational one) is what makes this robust to its
/// own input: callers hand it a DIFFERENCE of two canonical times, and
/// `canonical(a) - canonical(b)` can sit 1 µs off `canonical(a - b)`.
export function frameIndexInLayer(tInLayerUs: number, fpsNum: number, fpsDen: number): number {
  if (tInLayerUs <= 0) return 0;
  return frameIndexFloor(tInLayerUs, fpsNum, fpsDen);
}

/// Parse a SMPTE timecode string into microseconds, or null when invalid.
/// Accepts SS, MM:SS, HH:MM:SS, HH:MM:SS:FF. Frame field is bounded by
/// the composition fps. Inverse of `formatTimecode` — strings
/// round-tripped through both functions return to the original snapped
/// microseconds.
export function parseTimecode(
  input: string,
  fpsNum: number,
  fpsDen: number,
): number | null {
  const s = input.trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = parts.map((p) => Number(p));
  if (!nums.every((n) => Number.isFinite(n) && n >= 0)) return null;
  let h = 0;
  let m = 0;
  let ss = 0;
  let f = 0;
  if (parts.length === 4) {
    [h, m, ss, f] = nums as [number, number, number, number];
  } else if (parts.length === 3) {
    [h, m, ss] = nums as [number, number, number];
  } else if (parts.length === 2) {
    [m, ss] = nums as [number, number];
  } else {
    ss = nums[0]!;
  }
  if (m >= 60 || ss >= 60) return null;
  const framesPerSec = Math.max(1, Math.round(fpsNum / fpsDen));
  if (f >= framesPerSec) return null;
  const totalFrames = (h * 3600 + m * 60 + ss) * framesPerSec + f;
  return timeUsAtFrame(totalFrames, fpsNum, fpsDen);
}
