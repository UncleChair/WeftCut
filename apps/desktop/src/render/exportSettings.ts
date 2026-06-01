// Pure logic for the export settings dialog. No React, no Tauri — every
// function here is unit-tested in exportSettings.test.ts. The webview owns
// this schema end to end; Rust persists it as an opaque JSON blob.

export type CodecId = "h264" | "av1" | "hevc";
export type QualityPreset = "low" | "medium" | "high" | "custom";
export type RateMode = "vbr" | "cbr";
/// Output container. All three hold H.264/AV1/HEVC + AAC, so any codec is
/// valid in any of them. WebM is deferred (needs Opus audio + VP9/AV1).
export type Container = "mp4" | "mov" | "mkv";
export const CONTAINERS: Container[] = ["mp4", "mov", "mkv"];

export interface ExportSettings {
  /// Target output height in pixels; null = follow composition. Width is
  /// derived from the composition aspect ratio. Downscale-only.
  resolutionHeight: number | null;
  /// Target output fps (integer); null = follow composition fps.
  fps: number | null;
  codec: CodecId;
  quality: QualityPreset;
  /// Bits per second, used only when quality === "custom".
  customBitrate: number | null;
  rateMode: RateMode;
  /// Output container. Audio stays AAC for all three (WebM deferred).
  container: Container;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  resolutionHeight: null,
  fps: null,
  codec: "h264",
  quality: "medium",
  customBitrate: null,
  rateMode: "vbr",
  container: "mp4",
};

/// Standard heights offered as downscale presets (largest first).
export const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360] as const;
/// Standard fps offered as downscale presets (largest first).
export const STANDARD_FPS = [60, 50, 30, 25, 24] as const;

function makeEven(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

export interface CompDims {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
}

/// Resolve the encoder's output width/height. Follows composition when
/// resolutionHeight is null; otherwise downscales (never upscales) preserving
/// aspect, and forces even dimensions (H.264/yuv420p reject odd w/h).
export function resolveOutputDims(
  comp: Pick<CompDims, "width" | "height">,
  settings: ExportSettings,
): { width: number; height: number } {
  if (settings.resolutionHeight == null) {
    return { width: makeEven(comp.width), height: makeEven(comp.height) };
  }
  const targetH = Math.min(settings.resolutionHeight, comp.height);
  const scale = targetH / comp.height;
  return {
    width: makeEven(comp.width * scale),
    height: makeEven(targetH),
  };
}

export function downscaleHeightOptions(compHeight: number): number[] {
  return STANDARD_HEIGHTS.filter((h) => h < compHeight);
}

export function downscaleFpsOptions(compFps: number): number[] {
  return STANDARD_FPS.filter((f) => f < compFps);
}

// Base bits-per-pixel-per-frame tuned for H.264 so medium @ 1080p30 ≈ 8 Mbps
// (matches today's hardcoded default). bitrate = width * height * fps * bpp.
const BASE_BPP: Record<Exclude<QualityPreset, "custom">, number> = {
  low: 0.07,
  medium: 0.129,
  high: 0.24,
};

// Codec efficiency: AV1/HEVC reach the same perceptual quality at a fraction
// of H.264's bitrate. Keeps the size estimate honest per codec.
const CODEC_BPP_MULTIPLIER: Record<CodecId, number> = {
  h264: 1.0,
  hevc: 0.55,
  av1: 0.5,
};

export function computeBitrate(
  settings: ExportSettings,
  width: number,
  height: number,
  fps: number,
): number {
  if (settings.quality === "custom" && settings.customBitrate) {
    return settings.customBitrate;
  }
  const preset = settings.quality === "custom" ? "medium" : settings.quality;
  const bpp = BASE_BPP[preset] * CODEC_BPP_MULTIPLIER[settings.codec];
  return Math.round(width * height * fps * bpp);
}

/// WebCodecs codec strings. H.264 keeps the existing baseline string so a
/// default export matches today byte-for-byte. AV1/HEVC use levels generous
/// enough for up to 4K (downscale-only never exceeds composition size).
export function codecString(codec: CodecId): string {
  switch (codec) {
    case "h264":
      return "avc1.640028"; // High@4.0 — existing default
    case "av1":
      return "av01.0.13M.08"; // Main profile, ~level 5.1, 8-bit
    case "hevc":
      return "hev1.1.6.L153.B0"; // Main profile, level 5.1
  }
}

export function estimateBytes(
  bitrate: number,
  durationUs: number,
  hasAudio: boolean,
): number {
  const audioBitrate = hasAudio ? 192_000 : 0;
  const durationSec = durationUs / 1_000_000;
  return Math.round(((bitrate + audioBitrate) * durationSec) / 8);
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

/// Overlay a (possibly partial / null) saved blob onto the defaults so old or
/// missing fields fill in. The webview is the only schema authority.
export function mergeSettings(
  saved: Partial<ExportSettings> | null,
): ExportSettings {
  return { ...DEFAULT_EXPORT_SETTINGS, ...(saved ?? {}) };
}

export function containerExtension(c: Container): string {
  return c;
}

/// ffmpeg's MOV muxer rejects AV1 ("av1 only supported in MP4 and AVIF"), so
/// AV1+MOV is invalid. Everything else is valid across mp4/mov/mkv.
export function isCodecContainerValid(
  codec: CodecId,
  container: Container,
): boolean {
  return !(container === "mov" && codec === "av1");
}

/// Containers the given codec can actually be written into.
export function containersForCodec(codec: CodecId): Container[] {
  return CONTAINERS.filter((c) => isCodecContainerValid(codec, c));
}

/// High, near-transparent H.264 bitrate for the ffmpeg-path mezzanine. The
/// worker encodes this; ffmpeg then transcodes it to the target codec, so it
/// must be visually lossless. ~0.2 bits/pixel/frame, floored at 20 Mbps.
export function mezzanineBitrate(
  width: number,
  height: number,
  fps: number,
): number {
  return Math.max(20_000_000, Math.round(width * height * fps * 0.2));
}
