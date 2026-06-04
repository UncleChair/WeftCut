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

export type AudioCodecId = "aac" | "opus";
export const AUDIO_CODECS: AudioCodecId[] = ["aac", "opus"];
export const AUDIO_BITRATES = [96_000, 128_000, 192_000, 256_000, 320_000] as const;
export const AUDIO_SAMPLE_RATES = [48_000, 44_100] as const;
export const AUDIO_CHANNELS = [2, 1] as const;

export interface AudioSettings {
  /// Include an audio track in the export. false ⇒ video-only.
  include: boolean;
  codec: AudioCodecId;
  /// Audio bitrate in bits per second.
  bitrate: number;
  /// Output sample rate; null = follow composition.
  sampleRate: number | null;
  /// Output channel count (2 = stereo, 1 = mono); null = follow composition.
  channels: number | null;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  include: true,
  codec: "aac",
  bitrate: 192_000,
  sampleRate: null,
  channels: null,
};

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
  /// Seconds between forced keyframes (IDR cadence). Both encode paths derive
  /// their GOP from this via gopFrames, so WebCodecs and the ffmpeg transcode
  /// agree.
  keyframeIntervalSec: number;
  /// Encoder acceleration. "auto" prefers hardware (the default, today's
  /// behavior); "software" forces a CPU encoder — slower, but higher quality
  /// per bitrate and bit-reproducible across machines. Not a color setting:
  /// color is governed by the colorspace tags + the conformance gate either way.
  hwAccel: "auto" | "software";
  /// Output container. Audio is AAC (any container) or Opus (MKV only).
  container: Container;
  /// Audio track settings. Persisted; null/missing back-fills to defaults.
  audio: AudioSettings;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  resolutionHeight: null,
  fps: null,
  codec: "h264",
  quality: "medium",
  customBitrate: null,
  rateMode: "vbr",
  keyframeIntervalSec: 1,
  hwAccel: "auto",
  container: "mp4",
  audio: DEFAULT_AUDIO_SETTINGS,
};

/// Keyframe-interval presets offered in the dialog (seconds).
export const KEYFRAME_INTERVALS = [0.5, 1, 2, 5] as const;

/// Frames between forced keyframes for a keyframe interval in seconds at the
/// given fps. Shared by both encode paths (WebCodecs `keyFrame` cadence + the
/// ffmpeg `-g`) so they agree. Floored at 1.
export function gopFrames(keyframeIntervalSec: number, fps: number): number {
  return Math.max(1, Math.round(fps * keyframeIntervalSec));
}

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
  audioBitrate: number,
): number {
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
  const merged: ExportSettings = {
    ...DEFAULT_EXPORT_SETTINGS,
    ...(saved ?? {}),
    audio: { ...DEFAULT_AUDIO_SETTINGS, ...(saved?.audio ?? {}) },
  };
  // Defend against a stale/hand-edited blob whose audio codec the container
  // can't hold (e.g. Opus in MP4) — the live dialog can't produce this, but a
  // corrupted export.json would otherwise break the ffmpeg mux. Snap to AAC.
  if (!isAudioCodecContainerValid(merged.audio.codec, merged.container)) {
    merged.audio = { ...merged.audio, codec: "aac" };
  }
  return merged;
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

/// AAC muxes into mp4/mov/mkv. Opus is restricted to MKV — WebView2's Opus-in-
/// MP4/MOV playback is unreliable and WebM is deferred.
export function isAudioCodecContainerValid(
  codec: AudioCodecId,
  container: Container,
): boolean {
  return codec === "opus" ? container === "mkv" : true;
}

/// Audio codecs that can be written into the given container.
export function audioCodecsForContainer(container: Container): AudioCodecId[] {
  return AUDIO_CODECS.filter((c) => isAudioCodecContainerValid(c, container));
}

/// Clamp an export range to be ordered and within [0, durationUs]. Inputs are
/// already frame-aligned (parseTimecode and the snapped playhead both produce
/// frame-grid values), so this only enforces ordering + bounds; a degenerate
/// range falls back to the whole span.
export function clampExportRange(
  startUs: number,
  endUs: number,
  durationUs: number,
): { startUs: number; endUs: number } {
  if (
    !Number.isFinite(startUs) ||
    !Number.isFinite(endUs) ||
    !Number.isFinite(durationUs)
  ) {
    return { startUs: 0, endUs: Math.max(0, durationUs) };
  }
  const lo = Math.max(0, Math.min(startUs, durationUs));
  const hi = Math.max(0, Math.min(endUs, durationUs));
  if (hi <= lo) return { startUs: 0, endUs: durationUs };
  return { startUs: lo, endUs: hi };
}

/// H.264 bitrate for the ffmpeg-path mezzanine. The worker WebCodecs-encodes
/// this; ffmpeg then transcodes it to the target codec. It must be a clean
/// transcode source, but NOT bigger than a normal H.264 export of the same
/// quality — the worker buffers the whole mezzanine MP4 in one ArrayBuffer
/// (mediabunny BufferTarget), and V8 caps a single ArrayBuffer at ~2 GB, so a
/// too-high mezzanine OOMs long exports. The H.264-equivalent of the chosen
/// quality already runs ~1.8x the (codec-discounted) final target — ample
/// headroom — while matching an H.264 export's footprint. A ≥1.5x floor over
/// the final target covers the custom-bitrate case.
export function mezzanineBitrate(
  settings: ExportSettings,
  width: number,
  height: number,
  fps: number,
): number {
  const h264Equiv = computeBitrate(
    { ...settings, codec: "h264" },
    width,
    height,
    fps,
  );
  const finalTarget = computeBitrate(settings, width, height, fps);
  return Math.max(h264Equiv, Math.round(finalTarget * 1.5));
}
