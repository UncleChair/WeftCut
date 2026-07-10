// The EncodeTarget resolution seam (dual-engine spec §"Export engine").
// Pure: probe results are injected, never awaited here. E1 mirrors the three
// legacy branches exactly; E2 adds the encoderEngine pin, E4 flips auto.

import type { CodecId, ExportSettings } from "./exportSettings";

export type NativePixFmt = "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";

export interface WebCodecsTarget {
  engine: "webcodecs";
  /// Codec the worker's VideoEncoder actually encodes. Differs from
  /// settings.codec on the mezzanine path (H.264 intermediate).
  workerCodec: CodecId;
  /// ffmpeg re-encodes the mezzanine to settings.codec after the worker.
  transcodeAfter: boolean;
}

export interface NativeTarget {
  engine: "native";
  /// rawvideo format the worker packs and the ffmpeg sink consumes.
  pixFmt: NativePixFmt;
}

export type EncodeTarget = WebCodecsTarget | NativeTarget;

/// The 10-bit native route needs no WebCodecs smoke-encode; everything else
/// consults it. Callers skip the (async) probe when this is false.
export function needsEncoderProbe(settings: ExportSettings): boolean {
  return !(settings.bitDepth === 10 && settings.codec !== "h264");
}

export function resolveEncodeTarget(
  settings: ExportSettings,
  smokeOk: boolean,
): EncodeTarget {
  if (!needsEncoderProbe(settings)) {
    return { engine: "native", pixFmt: "yuv420p10le" };
  }
  if (smokeOk) {
    return { engine: "webcodecs", workerCodec: settings.codec, transcodeAfter: false };
  }
  return { engine: "webcodecs", workerCodec: "h264", transcodeAfter: true };
}
