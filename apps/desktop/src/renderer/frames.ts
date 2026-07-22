/// Frame-math primitives shared between the timeline UI, the preview
/// overlay, and the playback engine. `snapFrameRound` is re-exported from the
/// wasm `weftcut-eval` leaf — the SAME crate the Rust actor links — so the
/// actor's commit-side snap and the UI's drag-preview snap run one
/// implementation, not hand-mirrored copies (ADR 0025). The other helpers here
/// (`snapFrameFloor` with its ring-lookup correction loop, `lastFrameAnchorUs`,
/// `formatTimecode`, `parseTimecode`, …) are TS-only — no Rust twin.

const US_PER_SEC = 1_000_000;
const DEFAULT_FRAME_DUR_US = 33_333; // 30 fps fallback

/// Microseconds per composition frame, rounded to nearest. Defaults to
/// 33333 (30 fps) when fps is degenerate.
export function frameDurUs(fpsNum: number, fpsDen: number): number {
  if (fpsNum <= 0 || fpsDen <= 0) return DEFAULT_FRAME_DUR_US;
  return Math.round((US_PER_SEC * fpsDen) / fpsNum);
}

/// Round `tUs` to the nearest composition-fps frame boundary (half-up).
///
/// SINGLE SOURCE OF TRUTH: this is the wasm-backed `weftcut-eval::snap_frame_round`
/// (the SAME crate the Rust actor links natively), re-exported so the actor's
/// commit-side snap and the UI's drag-preview snap can never drift. The
/// degenerate-fps guard + the half-up OUTPUT rounding rule (which keeps
/// `t_start_us`/`src_in_us` aligned with the composition's exact rational grid)
/// live in the leaf — see
/// `native/eval/src/lib.rs::snap_frame_round`. `initEval()` must have resolved
/// (the renderer bootstrap awaits it before mount).
export { snapFrameRound } from "./eval";

/// Snap `tUs` to the start of the frame containing it, on the comp
/// fps grid, using EXACT rational arithmetic and HALF-UP rounding for
/// the output value.
///
/// Two distinct things that have to be exact:
///
/// 1. Frame index — the integer N such that frame N's interval
///    `[N·F_exact, (N+1)·F_exact)` contains `tUs`. Computed via the
///    integer expression `floor(tUs·num / (US_PER_SEC·den))` with a
///    correction loop for the rounding-direction edge case.
///
/// 2. Output grid value — the integer-µs representation of frame N's exact
///    composition start, used as the input to `ring.frameAt(...)`. It uses
///    HALF-UP so UI snapping, the Rust actor, and export `frameTimeUs` share
///    one composition grid. Decoder PTS may use a different integer
///    quantization (Mediabunny/WebCodecs truncates); frame stores deliberately
///    select the greatest presentation PTS <= this target instead of requiring
///    numeric equality.
///
/// The pre-rounded `frameDurUs(num, den)` integer (33_333 for 30 fps,
/// truncated from 33_333.333…) is NOT safe for either computation —
/// `Math.floor(tUs / 33_333) * 33_333` drifts by ~1 µs per frame and
/// at frame 299 lands ~99 µs below the correct grid value.
export function snapFrameFloor(
  tUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  if (fpsNum <= 0 || fpsDen <= 0) return tUs;
  const div = US_PER_SEC * fpsDen;
  let n = Math.floor((tUs * fpsNum) / div);
  if (n < 0) n = 0;
  while (Math.floor(((n + 1) * div) / fpsNum) <= tUs) n++;
  // Half-up: matches the composition/output frame-grid contract shared with
  // frameTimeUs and the Rust actor. Source PTS quantization is independent.
  return Math.round((n * div) / fpsNum);
}

/// Start of the last displayable frame in a composition of length
/// `durationUs` µs. The playhead's upper bound under the frame-anchor
/// rule (see `docs/data-model.md`).
///
/// Half-up rounded so the value aligns with the source-PTS-to-µs
/// rounding in render/decoder/PacketPump.ts for the same frame (see
/// `snapFrameFloor` for the long version).
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
  // durationUs is on the comp-frame grid (snap invariant), so this
  // is an integer total-frame count.
  const totalFrames = Math.round((durationUs * fpsNum) / (US_PER_SEC * fpsDen));
  if (totalFrames <= 1) return 0;
  return Math.round(((totalFrames - 1) * US_PER_SEC * fpsDen) / fpsNum);
}

/// Format `us` as SMPTE-style `HH:MM:SS:FF` against the given comp fps.
/// NDF (non-drop-frame): uniform frame intervals; at 29.97 the displayed
/// timecode drifts vs wall-clock (~3.6 s/hour) — that's the v1 policy.
/// Frame field zero-pads to two digits (correct up to 99 fps; bump to
/// three when 100+ fps comps are authored).
///
/// totalFrames uses exact rational arithmetic (`us * num / (1e6 * den)`)
/// instead of `us / frameDurUs` — `frameDurUs` is pre-rounded to
/// integer microseconds and accumulates ~1 frame of error per hour at
/// 30 fps. Exact math keeps the timecode honest across long timelines.
export function formatTimecode(
  us: number,
  fpsNum: number,
  fpsDen: number,
): string {
  if (fpsNum <= 0 || fpsDen <= 0) {
    return formatTimecode(us, 30, 1);
  }
  const totalFrames = Math.max(0, Math.round((us * fpsNum) / (US_PER_SEC * fpsDen)));
  const framesPerSec = Math.max(1, Math.round(fpsNum / fpsDen));
  const f = totalFrames % framesPerSec;
  const totalSec = Math.floor(totalFrames / framesPerSec);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}:${pad(f, 2)}`;
}

/// Given an in-layer playhead position `tInLayerUs` (µs from the layer's
/// own origin, i.e. after subtracting `t_start_us` from the comp position
/// and adding `src_in_us`), return the zero-based index of the source
/// frame that should be displayed.
///
/// Uses exact rational arithmetic — no pre-rounded `frameDurUs` integer —
/// so the result matches the source's own PTS-derived frame index without
/// accumulating drift over long layers. Clamped to 0 for non-positive
/// inputs and degenerate fps parameters.
export function frameIndexInLayer(tInLayerUs: number, fpsNum: number, fpsDen: number): number {
  if (fpsNum <= 0 || fpsDen <= 0) return 0;
  if (tInLayerUs <= 0) return 0;
  return Math.floor((tInLayerUs * fpsNum) / (US_PER_SEC * fpsDen));
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
  return Math.round((totalFrames * US_PER_SEC * fpsDen) / fpsNum);
}
