import { beforeEach, describe, expect, it, vi } from "vitest";
import { hwEligibleCodec, pickInitialLane, markHwUnusable, resetFfmpegCapabilitySession } from "./ffmpegCapability";

beforeEach(() => resetFfmpegCapabilitySession());

describe("hwEligibleCodec", () => {
  it("accepts 8-bit h264/hevc/vp9, rejects 10-bit and others", () => {
    expect(hwEligibleCodec("h264", "yuv420p")).toBe(true);
    expect(hwEligibleCodec("hevc", "yuv420p10le")).toBe(false);
    expect(hwEligibleCodec("mpeg2video", "yuv420p")).toBe(false);
  });
});

describe("pickInitialLane", () => {
  it("returns software for an ineligible codec without probing", async () => {
    const probe = vi.fn();
    const lane = await pickInitialLane({ mediaId: "m", codec: "mpeg2video", pixFmt: "yuv420p", componentAvailable: true }, probe);
    expect(lane).toBe("software");
    expect(probe).not.toHaveBeenCalled();
  });
  it("returns hardware when an eligible codec's probe passes", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    expect(await pickInitialLane({ mediaId: "m", codec: "h264", pixFmt: "yuv420p", componentAvailable: true }, probe, "C:/x.mp4")).toBe("hardware");
  });
  it("returns software after markHwUnusable, even for an eligible codec", async () => {
    markHwUnusable("m", "device-lost");
    const probe = vi.fn(async () => ({ ok: true }));
    expect(await pickInitialLane({ mediaId: "m", codec: "h264", pixFmt: "yuv420p", componentAvailable: true }, probe, "C:/x.mp4")).toBe("software");
  });
  it("returns software when the component is unavailable", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    expect(await pickInitialLane({ mediaId: "m", codec: "h264", pixFmt: "yuv420p", componentAvailable: false }, probe, "C:/x.mp4")).toBe("software");
    expect(probe).not.toHaveBeenCalled();
  });
  it("returns software when the probe declines (ok:false)", async () => {
    const probe = vi.fn(async () => ({ ok: false }));
    expect(await pickInitialLane({ mediaId: "m", codec: "h264", pixFmt: "yuv420p", componentAvailable: true }, probe, "C:/x.mp4")).toBe("software");
  });
});
