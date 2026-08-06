// The one place the user-facing Playback Resolution preference becomes a
// number. The settings file, the UI and the i18n keys speak in fractions
// (`full` | `half` | `quarter`); the two halves of the setting each want a
// different shape of the same number — the native ship stage takes a divisor
// (`FfmpegSourceInit.playbackScaleDiv` → `SwTransport` → `preview_sw_open`'s
// `scale_div` → Rust `OutScale`), Pixi's renderer takes its reciprocal.
import type { PlaybackResolution } from "../../../shared/app-settings";

/// Divisor applied to BOTH axes of the shipped frame. Native owns the rest of
/// the dimension math (even rounding, the 320 px long-edge floor); 1 is
/// byte-identical to no downscale at all.
export type PlaybackScaleDiv = 1 | 2 | 4;

/// Full ⇒ 1, Half ⇒ 2, Quarter ⇒ 4. Anything else — an absent field on an
/// older settings file, or a hand-edited value — resolves to full resolution,
/// the same direction `app-settings.ts`'s per-field defaulting takes.
export function playbackScaleDiv(
  resolution: PlaybackResolution | undefined,
): PlaybackScaleDiv {
  switch (resolution) {
    case "half":
      return 2;
    case "quarter":
      return 4;
    default:
      return 1;
  }
}

/// Fraction handed to Pixi's `renderer.resolution`, which scales ONLY the
/// canvas backing store — `app.screen`, `renderer.width/height` and every
/// sprite transform stay in composition coordinates. 1 is byte-identical to
/// no throttle at all.
export type PlaybackRenderResolution = 1 | 0.5 | 0.25;

/// The reciprocal of `playbackScaleDiv`, spelled out rather than computed so
/// the return type stays the literal union. Routed through the divisor so the
/// two halves of the setting can never disagree about what "half" means.
export function playbackRenderResolution(
  resolution: PlaybackResolution | undefined,
): PlaybackRenderResolution {
  switch (playbackScaleDiv(resolution)) {
    case 2:
      return 0.5;
    case 4:
      return 0.25;
    default:
      return 1;
  }
}
