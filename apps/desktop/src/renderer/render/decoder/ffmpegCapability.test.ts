import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hwEligibleCodec,
  pickInitialLane,
  markHwUnusable,
  markFfmpegUnusable,
  isFfmpegUnusable,
  resetFfmpegCapabilitySession,
} from "./ffmpegCapability";

beforeEach(() => resetFfmpegCapabilitySession());

// Task 19: the HW-lane codec allow-list. The one-frame HW probe tests
// decode-viability, not seek-survival, so eligibility is gated by this static
// seek-validated set (8-bit H.264/HEVC/VP9) — NOT by the probe alone. This is
// what stops MPEG-2 (which some drivers HW-decode) from promoting to the HW
// lane where a backward seek hangs. (Merged in from the deleted
// decodeCapability.test.ts in Task 9 — this module is the sole home of
// `hwEligibleCodec` now.)
describe("hwEligibleCodec", () => {
  it("admits 8-bit H.264 / HEVC / VP9", () => {
    expect(hwEligibleCodec("h264", "yuv420p")).toBe(true);
    expect(hwEligibleCodec("hevc", "yuv420p")).toBe(true);
    expect(hwEligibleCodec("vp9", "yuv420p")).toBe(true);
  });

  it("rejects out-of-scope codecs (MPEG-2, AV1) regardless of pixel format", () => {
    // MPEG-2 is the production hang: driver HW-decodes it, one-frame probe
    // passes, backward seek wedges — must never reach the HW lane.
    expect(hwEligibleCodec("mpeg2video", "yuv420p")).toBe(false);
    expect(hwEligibleCodec("av1", "yuv420p")).toBe(false);
    expect(hwEligibleCodec("prores", "yuv422p10le")).toBe(false);
  });

  it("rejects a 10-bit pixel format even for an in-scope codec", () => {
    expect(hwEligibleCodec("hevc", "yuv420p10le")).toBe(false);
    expect(hwEligibleCodec("hevc", "P010")).toBe(false); // case-insensitive
    expect(hwEligibleCodec("h264", "yuv420p10le")).toBe(false);
  });

  it("rejects a null codec (audio/image — no HW video lane)", () => {
    expect(hwEligibleCodec(null, "yuv420p")).toBe(false);
    expect(hwEligibleCodec(null, null)).toBe(false);
  });

  it("admits an in-scope codec with an unknown (null) pixel format", () => {
    // A null pix_fmt is not a KNOWN 10-bit tag, so it isn't excluded here; the
    // resolution/format-class probe still guards the actual open.
    expect(hwEligibleCodec("h264", null)).toBe(true);
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

describe("markFfmpegUnusable / isFfmpegUnusable", () => {
  it("is false initially, true after marking, false again after a session reset", () => {
    expect(isFfmpegUnusable("m")).toBe(false);
    markFfmpegUnusable("m", "boom");
    expect(isFfmpegUnusable("m")).toBe(true);
    resetFfmpegCapabilitySession();
    expect(isFfmpegUnusable("m")).toBe(false);
  });
});
