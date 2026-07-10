// The EncodeTarget resolution seam (dual-engine spec §"Export engine").
// Pure: probe results are injected, never awaited here. E1 mirrors the three
// legacy branches exactly; E2 adds the encoderEngine pin, E4 flips auto.

import { isIntermediateCodec, type ExportSettings, type WebCodecsCodecId } from "./exportSettings";

export type NativePixFmt = "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";

export interface WebCodecsTarget {
  engine: "webcodecs";
  /// Codec the worker's VideoEncoder actually encodes. Differs from
  /// settings.codec on the mezzanine path (H.264 intermediate). Never a
  /// ProRes/DNxHR intermediate — those are native-only (needsEncoderProbe is
  /// false for them, so this branch is never reached with settings.codec
  /// set to one).
  workerCodec: WebCodecsCodecId;
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
  if (settings.codec === "prores") return "yuv422p10le";
  if (settings.codec === "dnxhr") return "yuv422p";
  return settings.bitDepth === 10 ? "yuv420p10le" : "yuv420p";
}

/// True when resolution depends on the WebCodecs smoke-encode. Pinned-native,
/// the 10-bit native route, and the native-only intermediates never consult it.
export function needsEncoderProbe(settings: ExportSettings): boolean {
  if (settings.encoderEngine === "native") return false;
  if (isIntermediateCodec(settings.codec)) return false; // native-only codecs
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
  // The cast is sound: needsEncoderProbe returns false for intermediates, so
  // this branch is only reached with settings.codec in WebCodecsCodecId.
  if (smokeOk) {
    return {
      engine: "webcodecs",
      workerCodec: settings.codec as WebCodecsCodecId,
      transcodeAfter: false,
    };
  }
  return { engine: "webcodecs", workerCodec: "h264", transcodeAfter: true };
}
