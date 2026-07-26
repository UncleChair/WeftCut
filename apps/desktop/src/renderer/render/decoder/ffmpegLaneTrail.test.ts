import { beforeEach, describe, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => ({ rows: [] as { level: string; category: unknown; message: string }[] }));
vi.mock("../../ipc", () => ({
  logEmit: async (input: { level: string; category: unknown; message: string }) => {
    bus.rows.push(input);
  },
}));

import { noteLaneOpen, resetFfmpegLaneTrail } from "./ffmpegLaneTrail";

const messages = () => bus.rows.map((r) => r.message);

describe("ffmpegLaneTrail.noteLaneOpen", () => {
  beforeEach(() => {
    bus.rows.length = 0;
    resetFfmpegLaneTrail();
  });

  it("records a clip's first open without emitting (that is the resolution trail's row)", () => {
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "hardware" });
    expect(bus.rows).toEqual([]);
  });

  it("stays silent on a same-lane re-open, however many times", () => {
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "software" });
    for (let i = 0; i < 50; i++) noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "software" });
    expect(bus.rows).toEqual([]);
  });

  it("emits one row naming layer, media, lane left and lane taken when the lane changes", () => {
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "hardware" });
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "software", reason: "hw-budget-exceeded" });
    expect(bus.rows).toHaveLength(1);
    expect(bus.rows[0]!.category).toEqual({ kind: "Other", name: "decode-lane" });
    expect(bus.rows[0]!.message).toContain("L1");
    expect(bus.rows[0]!.message).toContain("m1");
    expect(bus.rows[0]!.message).toContain("hardware → software");
    expect(bus.rows[0]!.message).toContain("hw-budget-exceeded");
  });

  it("honours an explicit `from` when the trail has no prior entry", () => {
    // The open-time budget throw: the hardware open never completed, so nothing
    // recorded "hardware". Without the override this reads as a first open.
    noteLaneOpen({
      layerId: "L1",
      mediaId: "m1",
      lane: "software",
      from: "hardware",
      reason: "hw-budget-exceeded",
    });
    expect(messages()).toEqual([
      "decode lane: layer L1 media m1 hardware → software (hw-budget-exceeded)",
    ]);
  });

  it("logs the return trip once the clip is re-promoted", () => {
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "software", from: "hardware", reason: "hw-budget-exceeded" });
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "hardware" });
    expect(messages()).toEqual([
      "decode lane: layer L1 media m1 hardware → software (hw-budget-exceeded)",
      "decode lane: layer L1 media m1 software → hardware",
    ]);
  });

  it("keeps a per-clip trail — one layer's transition is not another's", () => {
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "hardware" });
    noteLaneOpen({ layerId: "L2", mediaId: "m1", lane: "hardware" });
    noteLaneOpen({ layerId: "L2", mediaId: "m1", lane: "software", from: "hardware", reason: "device-lost" });
    expect(messages()).toEqual(["decode lane: layer L2 media m1 hardware → software (device-lost)"]);

    // L1 never moved, so its next open on the same lane is still silent.
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "hardware" });
    expect(bus.rows).toHaveLength(1);
  });

  it("treats a new media on the same layer as a first open, not a transition", () => {
    // A relink/replace swaps the media under a stable layer id; the incoming
    // clip has no lane history of its own.
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "hardware" });
    noteLaneOpen({ layerId: "L1", mediaId: "m2", lane: "software" });
    expect(bus.rows).toEqual([]);
  });

  it("forgets history on reset", () => {
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "hardware" });
    resetFfmpegLaneTrail();
    noteLaneOpen({ layerId: "L1", mediaId: "m1", lane: "software" });
    expect(bus.rows).toEqual([]);
  });
});
