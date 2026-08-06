// The EncodeTarget resolution seam (see docs/render.md §"Encode exits").
// Pure: probe results are injected, never awaited here. `auto` and the
// intermediate codecs resolve native; only an explicit `webcodecs` pin
// resolves webcodecs.

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

/// rawvideo format the native sink consumes for these settings: ProRes →
/// yuv422p10le, DNxHR → yuv422p, everything else follows `bitDepth`.
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
  void smokeOk; // probe result is consumed by the fallback dialog's live gating (useExportFlow)
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
