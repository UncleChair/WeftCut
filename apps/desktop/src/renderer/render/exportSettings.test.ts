import { describe, expect, it } from "vitest";
import {
  CONTAINERS,
  type Container,
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_AUDIO_SETTINGS,
  codecString,
  compositeBitDepth,
  computeBitrate,
  containerExtension,
  containersForCodec,
  defaultCrf,
  isBitDepthValid,
  isCodecContainerValid,
  isIntermediateCodec,
  isAudioCodecContainerValid,
  audioCodecsForContainer,
  downscaleFpsOptions,
  downscaleHeightOptions,
  estimateBytes,
  formatBytes,
  mergeSettings,
  mezzanineBitrate,
  resolveOutputDims,
  clampExportRange,
  gopFrames,
  tenBitExportCapable,
  type ExportSettings,
  type WebCodecsCodecId,
} from "./exportSettings";

const comp = { width: 1920, height: 1080, fps_num: 30, fps_den: 1 };

describe("resolveOutputDims", () => {
  it("follows composition when resolutionHeight is null", () => {
    expect(resolveOutputDims(comp, DEFAULT_EXPORT_SETTINGS)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("downscales preserving aspect, rounding to even", () => {
    const s = { ...DEFAULT_EXPORT_SETTINGS, resolutionHeight: 720 };
    expect(resolveOutputDims(comp, s)).toEqual({ width: 1280, height: 720 });
  });

  it("never upscales beyond composition height", () => {
    const s = { ...DEFAULT_EXPORT_SETTINGS, resolutionHeight: 2160 };
    expect(resolveOutputDims(comp, s)).toEqual({ width: 1920, height: 1080 });
  });

  it("forces even dimensions for odd aspect ratios", () => {
    const oddComp = { width: 1080, height: 1349, fps_num: 30, fps_den: 1 };
    const s = { ...DEFAULT_EXPORT_SETTINGS, resolutionHeight: 720 };
    const dims = resolveOutputDims(oddComp, s);
    expect(dims.width % 2).toBe(0);
    expect(dims.height % 2).toBe(0);
  });
});

describe("downscale option lists", () => {
  it("offers only standard heights below composition", () => {
    expect(downscaleHeightOptions(1080)).toEqual([720, 480, 360]);
  });
  it("offers only standard fps below composition", () => {
    expect(downscaleFpsOptions(60)).toEqual([50, 30, 25, 24]);
  });
});

describe("computeBitrate", () => {
  it("medium H.264 at 1080p30 is ~8 Mbps (matches today's default)", () => {
    const s = { ...DEFAULT_EXPORT_SETTINGS, quality: "medium" as const };
    const bps = computeBitrate(s, 1920, 1080, 30);
    expect(bps).toBeGreaterThan(7_500_000);
    expect(bps).toBeLessThan(8_700_000);
  });

  it("AV1 targets roughly half the H.264 bitrate at the same quality", () => {
    const h264 = computeBitrate(
      { ...DEFAULT_EXPORT_SETTINGS, codec: "h264", quality: "high" },
      1920,
      1080,
      30,
    );
    const av1 = computeBitrate(
      { ...DEFAULT_EXPORT_SETTINGS, codec: "av1", quality: "high" },
      1920,
      1080,
      30,
    );
    expect(av1).toBeLessThan(h264 * 0.6);
    expect(av1).toBeGreaterThan(h264 * 0.4);
  });

  it("uses the custom bitrate verbatim when quality is custom", () => {
    const s: ExportSettings = {
      ...DEFAULT_EXPORT_SETTINGS,
      quality: "custom",
      customBitrate: 12_000_000,
    };
    expect(computeBitrate(s, 1920, 1080, 30)).toBe(12_000_000);
  });
});

describe("codecString", () => {
  it("keeps H.264 at the existing baseline string", () => {
    expect(codecString("h264")).toBe("avc1.640028");
  });
  it("returns valid AV1 and HEVC strings", () => {
    expect(codecString("av1")).toMatch(/^av01\./);
    expect(codecString("hevc")).toMatch(/^hev1\./);
  });
});

describe("estimateBytes / formatBytes", () => {
  it("adds the given audio bitrate on top of the video bitrate", () => {
    // 8 Mbps × 10 s / 8 bits-per-byte = 10_000_000 bytes
    expect(estimateBytes(8_000_000, 10_000_000, 0)).toBe(10_000_000);
    // + 192 kbps audio → +240_000 bytes
    expect(estimateBytes(8_000_000, 10_000_000, 192_000)).toBe(10_240_000);
  });
  it("formats bytes into human units", () => {
    expect(formatBytes(10_500_000)).toBe("10.5 MB");
    expect(formatBytes(2_100_000_000)).toBe("2.10 GB");
  });
});

describe("mergeSettings", () => {
  it("fills missing fields from defaults", () => {
    expect(mergeSettings({ codec: "av1" })).toEqual({
      ...DEFAULT_EXPORT_SETTINGS,
      codec: "av1",
    });
  });
  it("returns defaults for null", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_EXPORT_SETTINGS);
  });
  it("back-fills encoderEngine for old blobs", () => {
    const merged = mergeSettings({ codec: "h264" } as Partial<ExportSettings>);
    expect(merged.encoderEngine).toBe("auto");
  });
});

describe("default-export baseline", () => {
  it("default settings at 1080p30 H.264 match today's hardcoded config", () => {
    const comp1080 = { width: 1920, height: 1080 };
    const dims = resolveOutputDims(comp1080, DEFAULT_EXPORT_SETTINGS);
    expect(dims).toEqual({ width: 1920, height: 1080 });
    // Cast is sound: the default codec is the literal "h264"; ExportSettings
    // widens the field to CodecId (which now includes the native-only
    // intermediates codecString never accepts).
    expect(codecString(DEFAULT_EXPORT_SETTINGS.codec as WebCodecsCodecId)).toBe("avc1.640028");
    const bitrate = computeBitrate(
      DEFAULT_EXPORT_SETTINGS,
      dims.width,
      dims.height,
      30,
    );
    // Medium @ 1080p30 H.264 should land at ~8 Mbps.
    expect(Math.abs(bitrate - 8_000_000)).toBeLessThan(500_000);
    // VBR by default → bitrateMode "variable" (set in App; documented here).
    expect(DEFAULT_EXPORT_SETTINGS.rateMode).toBe("vbr");
  });
});

describe("containers", () => {
  it("lists mp4, mov, mkv (webm deferred)", () => {
    expect(CONTAINERS).toEqual(["mp4", "mov", "mkv"]);
  });
  it("maps container to file extension", () => {
    expect(containerExtension("mp4")).toBe("mp4");
    expect(containerExtension("mov")).toBe("mov");
    expect(containerExtension("mkv")).toBe("mkv");
  });
  it("defaults container to mp4", () => {
    expect(DEFAULT_EXPORT_SETTINGS.container).toBe("mp4");
  });
});

describe("codec/container compatibility", () => {
  it("rejects AV1 in MOV (ffmpeg MOV muxer limitation)", () => {
    expect(isCodecContainerValid("av1", "mov")).toBe(false);
    expect(containersForCodec("av1")).toEqual(["mp4", "mkv"]);
  });
  it("allows everything else across mp4/mov/mkv", () => {
    expect(containersForCodec("h264")).toEqual(["mp4", "mov", "mkv"]);
    expect(containersForCodec("hevc")).toEqual(["mp4", "mov", "mkv"]);
    expect(isCodecContainerValid("av1", "mp4")).toBe(true);
    expect(isCodecContainerValid("av1", "mkv")).toBe(true);
  });
});

describe("mezzanineBitrate", () => {
  it("equals the H.264-equivalent of the chosen quality (not a fixed 20Mbps floor)", () => {
    const s = {
      ...DEFAULT_EXPORT_SETTINGS,
      codec: "hevc" as const,
      quality: "medium" as const,
    };
    const mezz = mezzanineBitrate(s, 1920, 1080, 30);
    // ≈ a normal H.264 export of the same quality → no worse memory than H.264.
    expect(mezz).toBe(computeBitrate({ ...s, codec: "h264" }, 1920, 1080, 30));
    // A medium HEVC mezzanine stays well under 12 Mbps.
    expect(mezz).toBeLessThan(12_000_000);
  });
  it("keeps >=1.5x headroom over the final target for custom bitrate", () => {
    const s = {
      ...DEFAULT_EXPORT_SETTINGS,
      codec: "hevc" as const,
      quality: "custom" as const,
      customBitrate: 4_000_000,
    };
    expect(mezzanineBitrate(s, 1920, 1080, 30)).toBe(6_000_000);
  });
  it("scales with resolution", () => {
    const s = { ...DEFAULT_EXPORT_SETTINGS, codec: "hevc" as const };
    expect(mezzanineBitrate(s, 3840, 2160, 30)).toBeGreaterThan(
      mezzanineBitrate(s, 1920, 1080, 30),
    );
  });
});

// `Container` type is exercised via the typed assignments above.
const _containerTypeCheck: Container = "mp4";
void _containerTypeCheck;

describe("audio settings schema", () => {
  it("defaults audio to AAC / 192k / follow-composition", () => {
    expect(DEFAULT_EXPORT_SETTINGS.audio).toEqual({
      include: true,
      codec: "aac",
      bitrate: 192_000,
      sampleRate: null,
      channels: null,
    });
  });

  it("Opus is MKV-only; AAC is valid in every container", () => {
    expect(isAudioCodecContainerValid("opus", "mkv")).toBe(true);
    expect(isAudioCodecContainerValid("opus", "mp4")).toBe(false);
    expect(isAudioCodecContainerValid("opus", "mov")).toBe(false);
    expect(isAudioCodecContainerValid("aac", "mp4")).toBe(true);
    expect(isAudioCodecContainerValid("aac", "mov")).toBe(true);
    expect(isAudioCodecContainerValid("aac", "mkv")).toBe(true);
  });

  it("lists the audio codecs valid for a container", () => {
    expect(audioCodecsForContainer("mkv")).toEqual(["aac", "opus"]);
    expect(audioCodecsForContainer("mp4")).toEqual(["aac"]);
    expect(audioCodecsForContainer("mov")).toEqual(["aac"]);
  });
});

describe("mergeSettings audio back-fill", () => {
  it("back-fills audio from an old blob with no audio key", () => {
    expect(mergeSettings({ codec: "av1" }).audio).toEqual(DEFAULT_AUDIO_SETTINGS);
  });
  it("merges a partial audio object onto the audio defaults", () => {
    const merged = mergeSettings({
      audio: { bitrate: 256_000 } as unknown as ExportSettings["audio"],
    });
    expect(merged.audio).toEqual({ ...DEFAULT_AUDIO_SETTINGS, bitrate: 256_000 });
  });
  it("snaps a saved audio codec the container can't hold back to AAC", () => {
    const merged = mergeSettings({
      container: "mp4",
      audio: { codec: "opus" } as unknown as ExportSettings["audio"],
    });
    expect(merged.audio.codec).toBe("aac");
  });
  it("keeps a valid Opus + MKV saved audio codec", () => {
    const merged = mergeSettings({
      container: "mkv",
      audio: { codec: "opus" } as unknown as ExportSettings["audio"],
    });
    expect(merged.audio.codec).toBe("opus");
  });
});

describe("hwAccel", () => {
  it("defaults to auto (prefer hardware)", () => {
    expect(DEFAULT_EXPORT_SETTINGS.hwAccel).toBe("auto");
  });
  it("back-fills auto for an old blob and preserves a saved choice", () => {
    expect(mergeSettings({ codec: "av1" }).hwAccel).toBe("auto");
    expect(mergeSettings({ hwAccel: "software" }).hwAccel).toBe("software");
  });
});

describe("gopFrames", () => {
  it("derives the GOP from interval x fps", () => {
    expect(gopFrames(1, 30)).toBe(30);
    expect(gopFrames(2, 30)).toBe(60);
    expect(gopFrames(0.5, 30)).toBe(15);
    expect(gopFrames(1, 29.97)).toBe(30);
  });
  it("floors at 1 frame", () => {
    expect(gopFrames(1, 0)).toBe(1);
  });
  it("defaults to a 1-second interval", () => {
    expect(DEFAULT_EXPORT_SETTINGS.keyframeIntervalSec).toBe(1);
  });
});

describe("clampExportRange", () => {
  it("passes through an ordered, in-bounds range", () => {
    expect(clampExportRange(1_000_000, 5_000_000, 10_000_000)).toEqual({
      startUs: 1_000_000,
      endUs: 5_000_000,
    });
  });
  it("clamps to [0, duration]", () => {
    expect(clampExportRange(-1, 99_000_000, 10_000_000)).toEqual({
      startUs: 0,
      endUs: 10_000_000,
    });
  });
  it("falls back to the whole span when start >= end", () => {
    expect(clampExportRange(8_000_000, 2_000_000, 10_000_000)).toEqual({
      startUs: 0,
      endUs: 10_000_000,
    });
  });
  it("returns the whole span when an input is NaN", () => {
    expect(clampExportRange(NaN, 5_000_000, 10_000_000)).toEqual({
      startUs: 0,
      endUs: 10_000_000,
    });
  });
});

describe("bitDepth", () => {
  it("defaults to 8 and survives merge", () => {
    expect(mergeSettings(null).bitDepth).toBe(8);
    expect(mergeSettings({ bitDepth: 10, codec: "hevc" }).bitDepth).toBe(10);
  });
  it("snaps 10-bit H.264 back to 8 (no Hi10P output)", () => {
    expect(mergeSettings({ bitDepth: 10, codec: "h264" }).bitDepth).toBe(8);
  });
  it("detects 10-bit-capable sources (Hi10P H.264 + AV1-10)", () => {
    expect(tenBitExportCapable({ codec: "h264", pix_fmt: "yuv420p10le" })).toBe(true);
    expect(tenBitExportCapable({ codec: "av1", pix_fmt: "yuv420p10le" })).toBe(true);
    expect(tenBitExportCapable({ codec: "hevc", pix_fmt: "yuv420p10le" })).toBe(false);
    expect(tenBitExportCapable({ codec: "h264", pix_fmt: "yuv420p" })).toBe(false);
    expect(tenBitExportCapable({ codec: "av1", pix_fmt: "yuv420p" })).toBe(false);
    expect(tenBitExportCapable({ codec: null, pix_fmt: null })).toBe(false);
  });
});

describe("E3 schema", () => {
  it("intermediates are MOV-only and native-implied", () => {
    expect(containersForCodec("prores")).toEqual(["mov"]);
    expect(containersForCodec("dnxhr")).toEqual(["mov"]);
    expect(isIntermediateCodec("prores")).toBe(true);
    expect(isIntermediateCodec("h264")).toBe(false);
  });

  it("bit depth is implied: prores=10, dnxhr=8", () => {
    expect(isBitDepthValid("prores", 10)).toBe(true);
    expect(isBitDepthValid("prores", 8)).toBe(false);
    expect(isBitDepthValid("dnxhr", 8)).toBe(true);
    expect(isBitDepthValid("dnxhr", 10)).toBe(false);
  });

  it("mergeSettings snaps stale blobs onto valid combos", () => {
    const m = mergeSettings({ codec: "prores", container: "mp4", bitDepth: 8 } as Partial<ExportSettings>);
    expect(m.container).toBe("mov");
    expect(m.bitDepth).toBe(10);
    const d = mergeSettings({ codec: "dnxhr" } as Partial<ExportSettings>);
    expect(d.bitDepth).toBe(8);
    expect(d.proresProfile).toBe("422");
    expect(d.dnxhrProfile).toBe("sq");
    expect(d.rateMode === "vbr" || d.rateMode === "cbr" || d.rateMode === "quality").toBe(true);
    expect(d.preset).toBe("medium");
    expect(d.crf).toBeNull();
  });

  it("quality rate mode has per-codec CRF defaults", () => {
    expect(defaultCrf("h264")).toBe(18);
    expect(defaultCrf("hevc")).toBe(22);
    expect(defaultCrf("av1")).toBe(30);
  });

  it("computeBitrate for intermediates estimates from the profile table", () => {
    // 1080p30 ProRes 422 ≈ 147 Mbps (Apple whitepaper nominal; size-estimate only).
    const br = computeBitrate(
      mergeSettings({ codec: "prores", proresProfile: "422" } as Partial<ExportSettings>),
      1920, 1080, 30,
    );
    expect(br).toBeGreaterThan(100_000_000);
    expect(br).toBeLessThan(200_000_000);
  });

  it("compositeBitDepth: prores composites f16, dnxhr stays 8", () => {
    expect(compositeBitDepth(mergeSettings({ codec: "prores" } as Partial<ExportSettings>))).toBe(10);
    expect(compositeBitDepth(mergeSettings({ codec: "dnxhr" } as Partial<ExportSettings>))).toBe(8);
    expect(compositeBitDepth(mergeSettings({ codec: "hevc", bitDepth: 10 } as Partial<ExportSettings>))).toBe(10);
  });

  it("intermediate container snap runs before the audio-codec validity check", () => {
    // Stale blob: prores + MKV + Opus. Opus is valid in MKV, so an audio
    // check against the SAVED container would pass — but the intermediate
    // snap then forces MOV, where Opus is invalid. The audio check must see
    // the final container, yielding a fully valid combo (mov + aac).
    const m = mergeSettings({
      codec: "prores",
      container: "mkv",
      audio: { codec: "opus" } as unknown as ExportSettings["audio"],
    } as Partial<ExportSettings>);
    expect(m.container).toBe("mov");
    expect(isAudioCodecContainerValid(m.audio.codec, m.container)).toBe(true);
    expect(m.audio.codec).toBe("aac");
  });
});
