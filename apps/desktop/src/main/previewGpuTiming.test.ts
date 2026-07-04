import { describe, it, expect, beforeEach } from "vitest";
import {
  recordFrameReadySent,
  recordConsumeAck,
  takeMainTimings,
  clearMainPendingFor,
} from "./previewGpuTiming";

// The accumulator is a module singleton; drain before each test to reset it.
beforeEach(() => {
  takeMainTimings();
});

describe("previewGpuTiming", () => {
  it("records one round-trip sample (ms) per send+ack pair", () => {
    recordFrameReadySent("s1", 0, 100);
    recordConsumeAck("s1", 0, 105);
    recordFrameReadySent("s1", 1, 200);
    recordConsumeAck("s1", 1, 208);
    const t = takeMainTimings();
    expect(t.rendererRoundTripMs.count).toBe(2);
    expect(t.rendererRoundTripMs.meanMs).toBe(6.5); // (5 + 8) / 2
    expect(t.rendererRoundTripMs.maxMs).toBe(8);
  });

  it("ignores an ack with no prior send", () => {
    recordConsumeAck("s1", 0, 105);
    expect(takeMainTimings().rendererRoundTripMs.count).toBe(0);
  });

  it("drains: a second take is empty", () => {
    recordFrameReadySent("s1", 0, 100);
    recordConsumeAck("s1", 0, 110);
    expect(takeMainTimings().rendererRoundTripMs.count).toBe(1);
    expect(takeMainTimings().rendererRoundTripMs.count).toBe(0);
  });

  it("keys by (streamId, slot) so streams do not collide", () => {
    recordFrameReadySent("s1", 0, 100);
    recordFrameReadySent("s2", 0, 200);
    recordConsumeAck("s2", 0, 210); // s2 slot0 -> 10
    recordConsumeAck("s1", 0, 130); // s1 slot0 -> 30
    expect(takeMainTimings().rendererRoundTripMs.meanMs).toBe(20);
  });

  it("clearMainPendingFor drops un-acked stamps for a stream", () => {
    recordFrameReadySent("s1", 0, 100);
    clearMainPendingFor("s1");
    recordConsumeAck("s1", 0, 110); // no pending -> no sample
    expect(takeMainTimings().rendererRoundTripMs.count).toBe(0);
  });
});
