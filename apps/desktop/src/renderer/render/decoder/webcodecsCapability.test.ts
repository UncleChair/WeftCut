import { beforeEach, describe, expect, it } from "vitest";
import {
  markWebcodecsUnusable,
  isWebcodecsUnusable,
  resetWebcodecsCapabilitySession,
} from "./webcodecsCapability";

beforeEach(() => resetWebcodecsCapabilitySession());

// The sticky per-media "WebCodecs-confirmed-unusable" marker — the runtime
// signal behind PixiPreview's `webcodecsCanDecodeOriginal: "fail"` feed, set
// only on a DEFINITIVE codec-unsupported sweep verdict (never a transient
// stall). Mirrors ffmpegCapability's markFfmpegUnusable/isFfmpegUnusable tests.
describe("markWebcodecsUnusable / isWebcodecsUnusable", () => {
  it("is false initially, true after marking, false again after a session reset", () => {
    expect(isWebcodecsUnusable("m")).toBe(false);
    markWebcodecsUnusable("m", "webcodecs cannot decode original");
    expect(isWebcodecsUnusable("m")).toBe(true);
    resetWebcodecsCapabilitySession();
    expect(isWebcodecsUnusable("m")).toBe(false);
  });

  it("tracks ids independently", () => {
    markWebcodecsUnusable("a", "prores");
    expect(isWebcodecsUnusable("a")).toBe(true);
    expect(isWebcodecsUnusable("b")).toBe(false);
  });
});
