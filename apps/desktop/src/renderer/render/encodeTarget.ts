// The EncodeTarget resolution seam (dual-engine spec §"Export engine").
// Pure: probe results are injected, never awaited here. E1 mirrors the three
// legacy branches exactly; E2 adds the encoderEngine pin, E4 flips auto.

import { isIntermediateCodec, type ExportSettings, type WebCodecsCodecId } from "./exportSettings";

export type NativePixFmt = "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";

export interface WebCodecsTarget {
  engine: "webcodecs";
  /// Codec the worker's VideoEncoder actually encodes. Never a ProRes/DNxHR
  /// intermediate — those are native-only (needsEncoderProbe is false for
  /// them, so this branch is never reached with settings.codec set to one).
  workerCodec: WebCodecsCodecId;
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

/// True only for an explicit WebCodecs pin on a non-intermediate codec — the
/// only case that still needs the smoke-encode result (E4: `auto` resolves
/// native unconditionally and never consults the probe; native-only
/// intermediates never route through WebCodecs at all).
export function needsEncoderProbe(settings: ExportSettings): boolean {
  return settings.encoderEngine === "webcodecs" && !isIntermediateCodec(settings.codec);
}

export function resolveEncodeTarget(
  settings: ExportSettings,
  smokeOk: boolean,
): EncodeTarget {
  void smokeOk; // probe result now only informs the fallback dialog's live gating (useExportFlow)
  // The cast is sound: needsEncoderProbe returns false for intermediates, so
  // this branch is only reached with settings.codec in WebCodecsCodecId.
  if (needsEncoderProbe(settings)) {
    return {
      engine: "webcodecs",
      workerCodec: settings.codec as WebCodecsCodecId,
    };
  }
  return { engine: "native", pixFmt: nativePixFmtFor(settings) };
}
