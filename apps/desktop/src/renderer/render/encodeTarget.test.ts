import { describe, expect, it } from "vitest";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "./exportSettings";
import { needsEncoderProbe, resolveEncodeTarget } from "./encodeTarget";

const s = (over: Partial<ExportSettings>): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  ...over,
});

describe("resolveEncodeTarget (E1: mirrors today's three branches)", () => {
  it("8-bit + smoke ok → WebCodecs direct (path A)", () => {
    expect(resolveEncodeTarget(s({ codec: "h264" }), true)).toEqual({
      engine: "webcodecs", workerCodec: "h264", transcodeAfter: false,
    });
    expect(resolveEncodeTarget(s({ codec: "av1" }), true)).toEqual({
      engine: "webcodecs", workerCodec: "av1", transcodeAfter: false,
    });
  });

  it("8-bit + smoke fail → H.264 mezzanine + ffmpeg transcode (path B)", () => {
    expect(resolveEncodeTarget(s({ codec: "hevc" }), false)).toEqual({
      engine: "webcodecs", workerCodec: "h264", transcodeAfter: true,
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

  it("10-bit H.264 (invalid combo, snapped upstream) probes like 8-bit", () => {
    const st = s({ codec: "h264", bitDepth: 10 });
    expect(needsEncoderProbe(st)).toBe(true);
    expect(resolveEncodeTarget(st, true).engine).toBe("webcodecs");
  });

  it("8-bit paths report needsEncoderProbe", () => {
    expect(needsEncoderProbe(s({ codec: "hevc" }))).toBe(true);
  });
});
