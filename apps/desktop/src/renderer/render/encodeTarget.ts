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

/// rawvideo format the native sink consumes for these settings. E3 extends
/// this for the intermediate codecs (ProRes → yuv422p10le, DNxHR → yuv422p).
export function nativePixFmtFor(settings: ExportSettings): NativePixFmt {
  return settings.bitDepth === 10 ? "yuv420p10le" : "yuv420p";
}

/// True when resolution depends on the WebCodecs smoke-encode. Pinned-native
/// and the 10-bit native route never consult it.
export function needsEncoderProbe(settings: ExportSettings): boolean {
  if (settings.encoderEngine === "native") return false;
  return !(settings.bitDepth === 10 && settings.codec !== "h264");
}

export function resolveEncodeTarget(
  settings: ExportSettings,
  smokeOk: boolean,
): EncodeTarget {
  if (!needsEncoderProbe(settings)) {
    return { engine: "native", pixFmt: nativePixFmtFor(settings) };
  }
  // "webcodecs" pin and "auto" share the legacy probe behavior until E4
  // flips auto to native-first (the mezzanine still backstops smoke failures).
  if (smokeOk) {
    return { engine: "webcodecs", workerCodec: settings.codec, transcodeAfter: false };
  }
  return { engine: "webcodecs", workerCodec: "h264", transcodeAfter: true };
}
