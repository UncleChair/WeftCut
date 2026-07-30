import { describe, expect, it } from "vitest";
import {
  HW_DECODE_LANES,
  hwEligibleOnAnyLane,
  hwEligibleOnLane,
  isHwDecodeLane,
  isTenBitPixFmt,
} from "./hwLaneEligibility";

// Lane-aware HW eligibility (issue #10 ticket 03): videotoolbox carries its
// own set (ProRes + 10-bit allowed); EVERY other lane keeps the historical
// 8-bit h264/hevc/vp9 gate exactly. Tested per lane so a future widening of
// one lane cannot silently leak into another.

const LEGACY_LANES = ["nvdec", "vaapi", "d3d11va"] as const;

describe("hwEligibleOnLane — legacy lanes keep today's gate exactly", () => {
  for (const lane of LEGACY_LANES) {
    it(`${lane}: admits 8-bit h264/hevc/vp9 only`, () => {
      expect(hwEligibleOnLane(lane, "h264", "yuv420p")).toBe(true);
      expect(hwEligibleOnLane(lane, "hevc", "yuv420p")).toBe(true);
      expect(hwEligibleOnLane(lane, "vp9", "yuv420p")).toBe(true);
      // The production hang: MPEG-2 HW-decodes forward, wedges on backward seek.
      expect(hwEligibleOnLane(lane, "mpeg2video", "yuv420p")).toBe(false);
      expect(hwEligibleOnLane(lane, "av1", "yuv420p")).toBe(false);
      // ProRes stays OFF every lane but videotoolbox.
      expect(hwEligibleOnLane(lane, "prores", "yuv422p10le")).toBe(false);
      // 10-bit stays excluded for the in-scope trio.
      expect(hwEligibleOnLane(lane, "hevc", "yuv420p10le")).toBe(false);
      expect(hwEligibleOnLane(lane, "hevc", "P010")).toBe(false); // case-insensitive
      expect(hwEligibleOnLane(lane, "h264", "yuv420p10le")).toBe(false);
      // Null codec (audio/image) never eligible; unknown pix_fmt admits.
      expect(hwEligibleOnLane(lane, null, "yuv420p")).toBe(false);
      expect(hwEligibleOnLane(lane, "h264", null)).toBe(true);
    });
  }
});

describe("hwEligibleOnLane — videotoolbox admits ProRes and 10-bit formats", () => {
  it("admits ProRes (the lane's whole prize — yuv422p10le and 4444 alike)", () => {
    expect(hwEligibleOnLane("videotoolbox", "prores", "yuv422p10le")).toBe(true);
    expect(hwEligibleOnLane("videotoolbox", "prores", "yuv444p10le")).toBe(true);
    expect(hwEligibleOnLane("videotoolbox", "prores", null)).toBe(true);
  });
  it("admits the interframe trio at 8 AND 10 bit", () => {
    expect(hwEligibleOnLane("videotoolbox", "h264", "yuv420p")).toBe(true);
    expect(hwEligibleOnLane("videotoolbox", "hevc", "yuv420p10le")).toBe(true);
    expect(hwEligibleOnLane("videotoolbox", "vp9", "yuv420p")).toBe(true);
  });
  it("still rejects out-of-scope codecs (seek-survival is per codec, not per lane)", () => {
    expect(hwEligibleOnLane("videotoolbox", "mpeg2video", "yuv420p")).toBe(false);
    expect(hwEligibleOnLane("videotoolbox", "av1", "yuv420p")).toBe(false);
    expect(hwEligibleOnLane("videotoolbox", "dnxhd", "yuv422p10le")).toBe(false);
    expect(hwEligibleOnLane("videotoolbox", null, "yuv420p")).toBe(false);
  });
});

describe("hwEligibleOnLane — non-HW lane names are never eligible", () => {
  it("rejects software and unknown lanes outright", () => {
    expect(hwEligibleOnLane("software", "h264", "yuv420p")).toBe(false);
    expect(hwEligibleOnLane("sw", "h264", "yuv420p")).toBe(false);
    expect(hwEligibleOnLane("quicksync", "h264", "yuv420p")).toBe(false);
  });
});

describe("hwEligibleOnAnyLane — the renderer's probe-kick union", () => {
  it("admits what any lane admits (8-bit trio everywhere; ProRes/10-bit via videotoolbox)", () => {
    expect(hwEligibleOnAnyLane("h264", "yuv420p")).toBe(true);
    expect(hwEligibleOnAnyLane("prores", "yuv422p10le")).toBe(true);
    expect(hwEligibleOnAnyLane("hevc", "yuv420p10le")).toBe(true);
  });
  it("rejects what no lane admits", () => {
    expect(hwEligibleOnAnyLane("mpeg2video", "yuv420p")).toBe(false);
    expect(hwEligibleOnAnyLane("av1", "yuv420p")).toBe(false);
    expect(hwEligibleOnAnyLane(null, null)).toBe(false);
  });
});

describe("isTenBitPixFmt / isHwDecodeLane", () => {
  it("flags the 10-bit tags case-insensitively, null is not 10-bit", () => {
    expect(isTenBitPixFmt("yuv422p10le")).toBe(true);
    expect(isTenBitPixFmt("yuv420p10le")).toBe(true);
    expect(isTenBitPixFmt("P010")).toBe(true);
    expect(isTenBitPixFmt("yuv420p")).toBe(false);
    expect(isTenBitPixFmt("yuv420p12le")).toBe(false); // 12-bit is NOT this lane
    expect(isTenBitPixFmt(null)).toBe(false);
  });
  it("names exactly the four advertised HW lanes", () => {
    for (const lane of HW_DECODE_LANES) expect(isHwDecodeLane(lane)).toBe(true);
    expect(isHwDecodeLane("software")).toBe(false);
  });
});
