import { afterEach, describe, expect, it, vi } from "vitest";
import { probeEncoderSupported } from "./exportCodecProbe";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeEncoderSupported", () => {
  it("always reports H.264 supported without touching VideoEncoder", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    expect(await probeEncoderSupported("h264", 1920, 1080, 30)).toBe(true);
  });

  it("returns false for AV1/HEVC when VideoEncoder is unavailable", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    expect(await probeEncoderSupported("av1", 1920, 1080, 30)).toBe(false);
    expect(await probeEncoderSupported("hevc", 1920, 1080, 30)).toBe(false);
  });

  it("delegates AV1/HEVC to isConfigSupported and reads .supported", async () => {
    const isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    vi.stubGlobal("VideoEncoder", { isConfigSupported });
    expect(await probeEncoderSupported("av1", 3840, 2160, 30)).toBe(true);
    expect(isConfigSupported).toHaveBeenCalledOnce();
    const cfg = isConfigSupported.mock.calls[0]![0];
    expect(cfg.codec).toMatch(/^av01\./);
    expect(cfg.width).toBe(3840);
  });

  it("returns false when isConfigSupported rejects", async () => {
    const isConfigSupported = vi.fn().mockRejectedValue(new Error("nope"));
    vi.stubGlobal("VideoEncoder", { isConfigSupported });
    expect(await probeEncoderSupported("hevc", 1920, 1080, 30)).toBe(false);
  });
});
