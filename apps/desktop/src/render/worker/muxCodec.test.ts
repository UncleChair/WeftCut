import { describe, it, expect } from "vitest";
import { webCodecsToMediabunnyVideoCodec } from "./muxCodec";

describe("webCodecsToMediabunnyVideoCodec", () => {
  it("maps H.264 strings to 'avc'", () => {
    expect(webCodecsToMediabunnyVideoCodec("avc1.640028")).toBe("avc");
    expect(webCodecsToMediabunnyVideoCodec("avc3.42E01E")).toBe("avc");
  });
  it("maps HEVC strings to 'hevc'", () => {
    expect(webCodecsToMediabunnyVideoCodec("hev1.1.6.L93.B0")).toBe("hevc");
    expect(webCodecsToMediabunnyVideoCodec("hvc1.1.6.L93.B0")).toBe("hevc");
  });
  it("maps AV1 / VP9 / VP8", () => {
    expect(webCodecsToMediabunnyVideoCodec("av01.0.04M.08")).toBe("av1");
    expect(webCodecsToMediabunnyVideoCodec("vp09.00.10.08")).toBe("vp9");
    expect(webCodecsToMediabunnyVideoCodec("vp8")).toBe("vp8");
  });
  it("throws on an unrecognized codec", () => {
    expect(() => webCodecsToMediabunnyVideoCodec("mp4a.40.2")).toThrow(/unsupported/i);
  });
});
