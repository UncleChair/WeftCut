/// Frame-math primitives shared between the timeline UI, the preview
/// overlay, and the playback engine. Mirrors
/// `apps/desktop/src-tauri/src/state/time.rs`'s snap helpers — the math
/// must match byte-for-byte so the actor's commit-side snap and the
/// UI's drag-preview snap produce identical results.

const US_PER_SEC = 1_000_000;
const DEFAULT_FRAME_DUR_US = 33_333; // 30 fps fallback

/// Microseconds per composition frame, rounded to nearest. Defaults to
/// 33333 (30 fps) when fps is degenerate.
export function frameDurUs(fpsNum: number, fpsDen: number): number {
  if (fpsNum <= 0 || fpsDen <= 0) return DEFAULT_FRAME_DUR_US;
  return Math.round((US_PER_SEC * fpsDen) / fpsNum);
}

/// Round `tUs` to the nearest composition-fps frame boundary (half-up).
/// Same algorithm as Rust `snap_frame_round`:
///   frame_index = floor((tUs * num + (US_PER_SEC * den) / 2) / (US_PER_SEC * den))
///   snapped     = floor(frame_index * US_PER_SEC * den / num)
///
/// Safe for tUs up to ~2^53 / fpsNum (≈ 150 years at 60000 fps), which
/// covers every realistic timeline.
export function snapFrameRound(
  tUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  if (fpsNum <= 0 || fpsDen <= 0) return tUs;
  const prod = tUs * fpsNum;
  const div = US_PER_SEC * fpsDen;
  const frameIndex = Math.floor((prod + div / 2) / div);
  return Math.floor((frameIndex * US_PER_SEC * fpsDen) / fpsNum);
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
