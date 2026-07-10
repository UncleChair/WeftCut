import { describe, expect, it } from "vitest";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "./exportSettings";
import { needsEncoderProbe, resolveEncodeTarget } from "./encodeTarget";

const s = (over: Partial<ExportSettings>): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  ...over,
});

describe("resolveEncodeTarget (E1: mirrors today's three branches)", () => {
  it("webcodecs pin + smoke ok → WebCodecs direct (path A)", () => {
    expect(resolveEncodeTarget(s({ codec: "h264", encoderEngine: "webcodecs" }), true)).toEqual({
      engine: "webcodecs", workerCodec: "h264",
    });
    expect(resolveEncodeTarget(s({ codec: "av1", encoderEngine: "webcodecs" }), true)).toEqual({
      engine: "webcodecs", workerCodec: "av1",
    });
  });

  it("10-bit HEVC/AV1 → native sink yuv420p10le (path C), probe not needed", () => {
    for (const codec of ["hevc", "av1"] as const) {
      const st = s({ codec, bitDepth: 10 });
      expect(needsEncoderProbe(st)).toBe(false);
      expect(resolveEncodeTarget(st, /* ignored */ false)).toEqual({
        engine: "native", pixFmt: "yuv420p10le",
      });
    }
  });

  it("webcodecs-pinned paths report needsEncoderProbe", () => {
    expect(needsEncoderProbe(s({ codec: "hevc", encoderEngine: "webcodecs" }))).toBe(true);
  });
});

describe("encoderEngine pins (E2)", () => {
  it("native pin → native sink with bit-depth-matched pixFmt", () => {
    expect(resolveEncodeTarget(s({ codec: "h264", encoderEngine: "native" }), true))
      .toEqual({ engine: "native", pixFmt: "yuv420p" });
    expect(resolveEncodeTarget(s({ codec: "hevc", bitDepth: 10, encoderEngine: "native" }), true))
      .toEqual({ engine: "native", pixFmt: "yuv420p10le" });
    expect(needsEncoderProbe(s({ codec: "hevc", encoderEngine: "native" }))).toBe(false);
  });

  it("auto prefers native for every codec (E4)", () => {
    expect(resolveEncodeTarget(s({ codec: "h264" }), true))
      .toEqual({ engine: "native", pixFmt: "yuv420p" });
    expect(resolveEncodeTarget(s({ codec: "hevc" }), false))
      .toEqual({ engine: "native", pixFmt: "yuv420p" });
    expect(needsEncoderProbe(s({ codec: "h264" }))).toBe(false);
  });

  it("webcodecs pin without smoke → stays webcodecs direct (dialog gates combos; no ffmpeg fallback)", () => {
    expect(resolveEncodeTarget(s({ codec: "hevc", encoderEngine: "webcodecs" }), false))
      .toEqual({ engine: "webcodecs", workerCodec: "hevc" });
  });
});

describe("intermediates route native with 422 formats (E3)", () => {
  it("prores → yuv422p10le, dnxhr → yuv422p; no probe", () => {
    const p = s({ codec: "prores", bitDepth: 10, container: "mov" });
    expect(needsEncoderProbe(p)).toBe(false);
    expect(resolveEncodeTarget(p, false)).toEqual({ engine: "native", pixFmt: "yuv422p10le" });
    const d = s({ codec: "dnxhr", container: "mov" });
    expect(needsEncoderProbe(d)).toBe(false);
    expect(resolveEncodeTarget(d, false)).toEqual({ engine: "native", pixFmt: "yuv422p" });
  });
});
