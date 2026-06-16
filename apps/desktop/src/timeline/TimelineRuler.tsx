import { useMemo } from "react";
import { formatTimecode, frameDurUs } from "../frames";
import { formatRulerLabel } from "./geometry";

/// Time ruler that lives at the top of the scrollable timeline root,
/// replacing the legacy 18 px playhead-strip padding. Width matches the
/// canvas so horizontal scroll keeps ticks aligned with the layers
/// below, and tick density scales with `pxPerSec`.
///
/// Two regimes:
///   - Below `pxPerFrame >= FRAME_MODE_THRESHOLD_PX`: classic
///     second-level NICE_STEPS_SEC ladder, mm:ss labels.
///   - At/above the threshold: switch to frame-grid mode. Major-tick
///     stride is the largest of `NICE_STEPS_FRAMES` where
///     `stride * pxPerFrame >= TARGET_MAJOR_PX_FRAME_MODE`, labels read
///     SMPTE `HH:MM:SS:FF`, and minor ticks land at every single frame
///     regardless of major stride so the user has a visible frame
///     grid to align edits against.

// Major-tick candidates: classic 1/2/5 decade ladder extended into
// sub-second territory for high-zoom cases. Anything above 600 s
// falls off the top of the ladder and clamps to 600.
const NICE_STEPS_SEC = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600,
] as const;
const NICE_STEPS_FRAMES = [1, 2, 5, 10, 30] as const;
const TARGET_MAJOR_PX = 100;
const TARGET_MAJOR_PX_FRAME_MODE = 80;
const SUBDIVISIONS = 5;
const FRAME_MODE_THRESHOLD_PX = 12;

export function TimelineRuler({
  pxPerSec,
  totalSec,
  widthPx,
  fpsNum,
  fpsDen,
}: {
  pxPerSec: number;
  totalSec: number;
  widthPx: number;
  fpsNum: number;
  fpsDen: number;
}) {
  const { items, majorSec, isFrameMode } = useMemo(() => {
    const fDur = frameDurUs(fpsNum, fpsDen);
    const pxPerFrame = (fDur / 1_000_000) * pxPerSec;
    const frameMode = pxPerFrame >= FRAME_MODE_THRESHOLD_PX;

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
      // Minor ticks at every frame; majors at every `stride` frames.
      const totalFrames =
        Math.ceil(totalSec * 1_000_000 / fDur) + 1;
      const out: { i: number; x: number; t: number; isMajor: boolean }[] = [];
      for (let f = 0; f <= totalFrames; f++) {
        const tUs = f * fDur;
        out.push({
          i: f,
          x: (tUs / 1_000_000) * pxPerSec,
          t: tUs / 1_000_000,
          isMajor: f % stride === 0,
        });
      }
      return { items: out, majorSec: 0, isFrameMode: true };
    }

    const targetSec = TARGET_MAJOR_PX / pxPerSec;
    let major = NICE_STEPS_SEC[NICE_STEPS_SEC.length - 1] ?? 1;
    for (const s of NICE_STEPS_SEC) {
      if (s >= targetSec) {
        major = s;
        break;
      }
    }
    const minor = major / SUBDIVISIONS;
    const out: { i: number; x: number; t: number; isMajor: boolean }[] = [];
    // Allow a half-step over `totalSec` so the trailing major lands on
    // a clean number if the timeline ends mid-interval — visually it
    // gets clipped by the canvas width, but the major label stays on
    // its grid until the very end.
    const limit = totalSec + minor * 0.5;
    for (let i = 0; ; i++) {
      const t = i * minor;
      if (t > limit) break;
      out.push({ i, x: t * pxPerSec, t, isMajor: i % SUBDIVISIONS === 0 });
    }
    return { items: out, majorSec: major, isFrameMode: false };
  }, [pxPerSec, totalSec, fpsNum, fpsDen]);

  return (
    /* Sizing notes (migrated from the legacy `.timeline-ruler` CSS):
       - `h-5` (20 px) accommodates a 10 px label in the upper half and
         4–8 px tick marks at the bottom; the playhead's `top: 2px` knob
         (Timeline.tsx renders it `top-0.5`) still lands inside this
         strip — keep the two coupled.
       - `overflow-hidden` is load-bearing: the major label is
         `whitespace-nowrap` at `left-[3px]` of an abs-positioned tick,
         so the rightmost major's label would spill past widthPx and
         inflate the parent's scrollWidth, leaving a few px of phantom
         horizontal scroll at fit-zoom that the user can't get rid of by
         zooming further. Same for the trailing-frame tick deliberately
         rendered past `totalSec` ("visually it gets clipped by the
         canvas width" below — this overflow clip is what actually
         clips it). */
    <div
      data-testid="timeline-ruler"
      className="relative h-5 flex-none select-none overflow-hidden border-b border-border-soft bg-card text-[10px] text-muted-foreground"
      style={{ width: widthPx }}
    >
      {items.map((tk) => (
        <div
          key={tk.i}
          className={`pointer-events-none absolute top-0 h-full w-0 after:absolute after:bottom-0 after:left-0 after:w-px after:content-[''] ${
            tk.isMajor
              ? "after:h-2 after:bg-foreground/55"
              : "after:h-1 after:bg-muted-foreground/55"
          }`}
          style={{ left: tk.x }}
        >
          {tk.isMajor && (
            <span className="absolute left-[3px] top-px whitespace-nowrap leading-3">
              {isFrameMode
                ? formatTimecode(Math.round(tk.t * 1_000_000), fpsNum, fpsDen)
                : formatRulerLabel(tk.t, majorSec)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
