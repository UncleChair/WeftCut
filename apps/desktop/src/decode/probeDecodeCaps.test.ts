import { describe, it, expect } from "vitest";
import { summarizeProbe, PROBE_CONFIGS } from "./probeDecodeCaps";

describe("summarizeProbe", () => {
  it("maps supported results onto the right fields", () => {
    const caps = summarizeProbe([
      { key: "hevc", supported: true },
      { key: "av1", supported: false },
      { key: "vp9", supported: true },
    ]);
    expect(caps).toEqual({ hevc: true, av1: false, vp9: true });
  });

  it("defaults everything false with no results", () => {
    expect(summarizeProbe([])).toEqual({ hevc: false, av1: false, vp9: false });
  });

  it("probes one config per DecodeCaps field", () => {
    const keys = PROBE_CONFIGS.map((c) => c.key).sort();
    expect(keys).toEqual(["av1", "hevc", "vp9"]);
  });
});
