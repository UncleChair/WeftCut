import type { CanvasPreset } from "../ipc";

/// The complete set of authorable composition rates — this list IS the rate
/// picker, because `set_composition { fps }` locks once the timeline holds a layer
/// (spec R2-D1) and there is no custom-rate entry.
///
/// That coupling is why the list must cover every standard rate rather than the
/// three it started with: an incomplete list plus an irreversible choice is a trap.
/// It also closed a live gap against export, which already offered 60/50/30/25/24
/// (`exportSettings.ts` STANDARD_FPS) while new-project offered only 30/60/29.97 —
/// so a PAL or 24p shooter had to edit on a 30 fps timeline and rate-convert on
/// export, which is exactly the judder case.
///
/// No custom entry is also what keeps `formatTimecode`'s frame field two digits:
/// the ceiling here is 60 fps (R2-D5). Fractional rates carry the exact rational —
/// 30000/1001 is not 29.97 to ffmpeg — and the label rounds for reading only.
///
/// `key` indexes `new_project.preset.*` in the locales and is UI-only (nothing
/// persists it). Index 0 is the default selection.
export const CANVAS_PRESETS: ReadonlyArray<{ key: string; preset: CanvasPreset }> = [
  { key: "hd1080p30", preset: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } },
  { key: "hd1080p60", preset: { width: 1920, height: 1080, fpsNum: 60, fpsDen: 1 } },
  { key: "hd1080p24", preset: { width: 1920, height: 1080, fpsNum: 24, fpsDen: 1 } },
  { key: "hd1080p25", preset: { width: 1920, height: 1080, fpsNum: 25, fpsDen: 1 } },
  { key: "hd1080p50", preset: { width: 1920, height: 1080, fpsNum: 50, fpsDen: 1 } },
  { key: "uhd4k30", preset: { width: 3840, height: 2160, fpsNum: 30, fpsDen: 1 } },
  { key: "uhd4k60", preset: { width: 3840, height: 2160, fpsNum: 60, fpsDen: 1 } },
  // The NTSC family, grouped last: 23.976 / 29.97 / 59.94 are all n/1001.
  { key: "ntsc1080p2398", preset: { width: 1920, height: 1080, fpsNum: 24000, fpsDen: 1001 } },
  { key: "ntsc1080p", preset: { width: 1920, height: 1080, fpsNum: 30000, fpsDen: 1001 } },
  { key: "ntsc1080p5994", preset: { width: 1920, height: 1080, fpsNum: 60000, fpsDen: 1001 } },
];
