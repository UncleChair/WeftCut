import { describe, it, expect } from "vitest";
import { parseManifest, canonicalizeProps } from "../catalog";

const RAW = JSON.stringify({
  id: "countdown", name: "Countdown", formatVersion: 1, size: [480, 480],
  default_duration_s: 5, max_duration_s: 5, max_duration_prop: "seconds",
  props_schema: {
    seconds: { type: "number", default: 5, min: 1, max: 60 },
    label: { type: "string", default: "GO", maxLength: 12 },
    accent: { type: "color", default: "#ff4d4d" },
  },
});

describe("parseManifest", () => {
  it("parses a valid manifest", () => {
    const m = parseManifest(RAW);
    expect(m.id).toBe("countdown");
    expect(m.size).toEqual([480, 480]);
    expect(m.propsSchema.seconds.type).toBe("number");
  });
  it("rejects a manifest missing required fields", () => {
    expect(() => parseManifest(JSON.stringify({ id: "x" }))).toThrow();
  });
  it("rejects max_duration_prop naming a missing prop", () => {
    const bad = { ...JSON.parse(RAW), max_duration_prop: "nope" };
    expect(() => parseManifest(JSON.stringify(bad))).toThrow(/max_duration_prop/);
  });
});

describe("canonicalizeProps", () => {
  const m = parseManifest(RAW);
  it("fills defaults, drops unknowns, orders keys stably", () => {
    const out = canonicalizeProps(m, { label: "3", zzz: "x" } as Record<string, unknown>);
    expect(Object.keys(out)).toEqual(["accent", "label", "seconds"]);
    expect(out).toEqual({ accent: "#ff4d4d", label: "3", seconds: 5 });
  });
  it("rejects a number prop outside its min/max", () => {
    expect(() => canonicalizeProps(m, { seconds: 999 })).toThrow(/seconds/);
  });
  it("clamps string length to maxLength", () => {
    expect(canonicalizeProps(m, { label: "0123456789abcdef" }).label).toBe("0123456789ab");
  });
});
