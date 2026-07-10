// Pure logic for the export settings dialog. No React, no DOM — every
// function here is unit-tested in exportSettings.test.ts. The renderer owns
// this schema end to end; Rust persists it as an opaque JSON blob.

export type CodecId = "h264" | "av1" | "hevc" | "prores" | "dnxhr";
/// Codecs a WebCodecs VideoEncoder can emit; intermediates are native-only.
export type WebCodecsCodecId = "h264" | "av1" | "hevc";
export function isIntermediateCodec(c: CodecId): c is "prores" | "dnxhr" {
  return c === "prores" || c === "dnxhr";
}
export type BitDepth = 8 | 10;
export type QualityPreset = "low" | "medium" | "high" | "custom";
export type RateMode = "vbr" | "cbr" | "quality";
export type ProresProfile = "proxy" | "lt" | "422" | "hq";
export type DnxhrProfile = "lb" | "sq" | "hq";
export type SpeedPreset = "fast" | "medium" | "slow";
/// Which encode engine writes the video stream. "auto" resolves per machine
/// (E2: legacy behavior; E4: native-first). "native" = the ffmpeg sink;
/// "webcodecs" = the in-renderer VideoEncoder + fMP4 path.
export type EncoderEngine = "auto" | "native" | "webcodecs";
/// Output container. H.264/HEVC can target all three; AV1+MOV is rejected by
/// ffmpeg's MOV muxer, so AV1 is limited to MP4/MKV. WebM is deferred.
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
  /// Write a video stream. false + includeAudio ⇒ audio-only (.m4a/.mka);
  /// both false is rejected by the dialog (nothing to export).
  includeVideo: boolean;
  /// Write an audio stream. Mirrored into `audio.include`, which the export
  /// pipeline reads for the audio mux/gate.
  includeAudio: boolean;
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
  /// ProRes flavor (prores_ks profile). Only meaningful when codec === "prores".
  proresProfile: ProresProfile;
  /// DNxHR flavor. Only meaningful when codec === "dnxhr".
  dnxhrProfile: DnxhrProfile;
  /// Constant-quality value for rateMode === "quality" (native engine only;
  /// forces a software encoder). null ⇒ defaultCrf(codec).
  crf: number | null;
  /// Software-encoder speed/quality preset (native engine; HW encoders and
  /// intermediates ignore it). "medium" matches the pre-E3 hardcoded value.
  preset: SpeedPreset;
  /// Seconds between forced keyframes (IDR cadence). Both encode paths derive
  /// their GOP from this via gopFrames, so WebCodecs and the ffmpeg transcode
  /// agree.
  keyframeIntervalSec: number;
  /// Encoder acceleration. "auto" prefers hardware (the default, today's
  /// behavior); "software" forces a CPU encoder — slower, but higher quality
  /// per bitrate and bit-reproducible across machines. Not a color setting:
  /// color is governed by the colorspace tags + the conformance gate either way.
  hwAccel: "auto" | "software";
  /// Encode engine. Persisted per project; "auto" re-resolves on each machine.
  encoderEngine: EncoderEngine;
  /// Output bit depth. 10 runs the f16/WebGL2 + native-encode pipeline
  /// (HEVC Main10 / AV1 10-bit); 8 uses the standard 8-bit pipeline.
  /// H.264 output is always 8 (Hi10P output compatibility is poor).
  bitDepth: BitDepth;
  /// Output container. Audio is AAC (any container) or Opus (MKV only).
  container: Container;
  /// Audio track settings. Persisted; null/missing back-fills to defaults.
  audio: AudioSettings;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  includeVideo: true,
  includeAudio: true,
  resolutionHeight: null,
  fps: null,
  codec: "h264",
  quality: "medium",
  customBitrate: null,
  rateMode: "vbr",
  proresProfile: "422",
  dnxhrProfile: "sq",
  crf: null,
  preset: "medium",
  keyframeIntervalSec: 1,
  hwAccel: "auto",
  encoderEngine: "auto",
  bitDepth: 8,
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

// Base bits-per-pixel-per-frame tuned for H.264 so medium @ 1080p30 ≈ 8 Mbps.
// bitrate = width * height * fps * bpp.
const BASE_BPP: Record<Exclude<QualityPreset, "custom">, number> = {
  low: 0.07,
  medium: 0.129,
  high: 0.24,
};

// Codec efficiency: AV1/HEVC reach the same perceptual quality at a fraction
// of H.264's bitrate. Keeps the size estimate honest per codec.
const CODEC_BPP_MULTIPLIER: Record<WebCodecsCodecId, number> = {
  h264: 1.0,
  hevc: 0.55,
  av1: 0.5,
};

/// Nominal profile bitrates at 1080p30 (bits/px/frame), SIZE-ESTIMATE ONLY —
/// intra codecs are quality-fixed; these never feed encoder args. Sources:
/// Apple ProRes whitepaper / Avid DNxHR spec sheets, rounded.
const INTERMEDIATE_BPF: Record<ProresProfile | `dnxhr_${DnxhrProfile}`, number> = {
  proxy: 45_000_000 / 62_208_000,
  lt: 102_000_000 / 62_208_000,
  "422": 147_000_000 / 62_208_000,
  hq: 220_000_000 / 62_208_000,
  dnxhr_lb: 45_000_000 / 62_208_000,
  dnxhr_sq: 115_000_000 / 62_208_000,
  dnxhr_hq: 175_000_000 / 62_208_000,
};

export function computeBitrate(
  settings: ExportSettings,
  width: number,
  height: number,
  fps: number,
): number {
  if (settings.codec === "prores") {
    return Math.round(width * height * fps * INTERMEDIATE_BPF[settings.proresProfile]);
  }
  if (settings.codec === "dnxhr") {
    return Math.round(width * height * fps * INTERMEDIATE_BPF[`dnxhr_${settings.dnxhrProfile}`]);
  }
  if (settings.quality === "custom" && settings.customBitrate) {
    return settings.customBitrate;
  }
  const preset = settings.quality === "custom" ? "medium" : settings.quality;
  const bpp = BASE_BPP[preset] * CODEC_BPP_MULTIPLIER[settings.codec];
  return Math.round(width * height * fps * bpp);
}

export function defaultCrf(codec: CodecId): number {
  switch (codec) {
    case "h264": return 18;
    case "hevc": return 22;
    case "av1": return 30;
    default: return 0; // intermediates: fixed-quality by profile, CRF unused
  }
}

/// Composite precision: ProRes is a 10-bit family (f16 composite) even though
/// the user-facing bitDepth control is hidden for it; DNxHR LB/SQ/HQ are 8-bit.
export function compositeBitDepth(s: ExportSettings): 8 | 10 {
  if (s.codec === "prores") return 10;
  if (s.codec === "dnxhr") return 8;
  return s.bitDepth;
}

/// WebCodecs codec strings. H.264 keeps the existing baseline string so a
/// default export matches today byte-for-byte. AV1/HEVC use levels generous
/// enough for up to 4K (downscale-only never exceeds composition size).
export function codecString(codec: WebCodecsCodecId): string {
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
/// missing fields fill in. The renderer is the only schema authority.
export function mergeSettings(
  saved: Partial<ExportSettings> | null,
): ExportSettings {
  const merged: ExportSettings = {
    ...DEFAULT_EXPORT_SETTINGS,
    ...(saved ?? {}),
    audio: { ...DEFAULT_AUDIO_SETTINGS, ...(saved?.audio ?? {}) },
  };
  // Back-compat: pre-checkbox blobs stored audio inclusion in `audio.include`
  // and always wrote video. Map onto the include flags, then keep
  // `audio.include` mirrored to `includeAudio` (the pipeline reads it).
  if (saved?.includeAudio == null && saved?.audio?.include != null) {
    merged.includeAudio = saved.audio.include;
  }
  merged.audio = { ...merged.audio, include: merged.includeAudio };
  // Intermediates imply container + bit depth; snap stale/hand-edited blobs.
  // Must run before the audio-codec check below so that check validates
  // against the FINAL container (e.g. prores+mkv+opus: opus is mkv-valid but
  // the snap forces mov, where opus isn't).
  if (isIntermediateCodec(merged.codec) && merged.container !== "mov") {
    merged.container = "mov";
  }
  // Defend against a stale/hand-edited blob whose audio codec the container
  // can't hold (e.g. Opus in MP4). Only matters when audio is muxed into the
  // video container; audio-only writes .m4a/.mka regardless. Snap to AAC.
  if (
    merged.includeVideo &&
    !isAudioCodecContainerValid(merged.audio.codec, merged.container)
  ) {
    merged.audio = { ...merged.audio, codec: "aac" };
  }
  // Snap an invalid bit depth (e.g. 10 saved with H.264 from a future
  // downgrade, or a non-implied depth saved with an intermediate codec).
  if (!isBitDepthValid(merged.codec, merged.bitDepth)) {
    merged.bitDepth = merged.codec === "prores" ? 10 : 8;
  }
  return merged;
}

export function containerExtension(c: Container): string {
  return c;
}

/// Stream-inclusion helpers.
export function exportIncludesVideo(s: ExportSettings): boolean {
  return s.includeVideo;
}

export function exportIncludesAudio(s: ExportSettings): boolean {
  return s.includeAudio;
}

/// Output file extension. Audio-only (video off, audio on) writes .m4a (AAC) /
/// .mka (Opus), independent of the (irrelevant) container; otherwise the
/// chosen container's extension.
export function exportOutputExtension(settings: ExportSettings): string {
  if (!settings.includeVideo && settings.includeAudio) {
    return settings.audio.codec === "opus" ? "mka" : "m4a";
  }
  return containerExtension(settings.container);
}

export function isBitDepthValid(codec: CodecId, d: BitDepth): boolean {
  if (codec === "prores") return d === 10;
  if (codec === "dnxhr") return d === 8;
  return d === 8 || codec !== "h264";
}

/// Sources whose ORIGINALS Chromium/Electron decodes to copyTo-able I420P10, so the
/// 10-bit export lane can read them at full precision: H.264 Hi10P (probe P1)
/// and AV1 10-bit (probed in real Chromium/Electron: dav1d under prefer-software gives
/// I420P10 with a clean 875-step ramp; the default/HW path "succeeds" but
/// yields format=null OPAQUE frames — so the lane's preferSoftware flag is a
/// correctness requirement for AV1, not just a fallback shortcut). HEVC
/// Main10 originals are HW-opaque with no SW decoder (no copyTo) until the
/// 10-bit conform lands.
export function tenBitExportCapable(m: {
  codec: string | null;
  pix_fmt: string | null;
}): boolean {
  return (m.codec === "h264" || m.codec === "av1") && m.pix_fmt === "yuv420p10le";
}

/// ffmpeg's MOV muxer rejects AV1 ("av1 only supported in MP4 and AVIF"), so
/// AV1+MOV is invalid. Intermediates (ProRes/DNxHR) are MOV-only native
/// codecs. Everything else is valid across mp4/mov/mkv.
export function isCodecContainerValid(
  codec: CodecId,
  container: Container,
): boolean {
  if (isIntermediateCodec(codec)) return container === "mov";
  return !(container === "mov" && codec === "av1");
}

/// Containers the given codec can actually be written into.
export function containersForCodec(codec: CodecId): Container[] {
  return CONTAINERS.filter((c) => isCodecContainerValid(codec, c));
}

/// AAC muxes into mp4/mov/mkv. Opus is restricted to MKV — Chromium/Electron's Opus-in-
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
