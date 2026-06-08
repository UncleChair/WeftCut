import { describe, expect, it } from "vitest";

import {
  resolveMotifContentDurationUs,
  getMotif,
  listMotifs,
  type MotifManifest,
} from "./catalog";

const base: MotifManifest = {
  id: "countdown",
  name: "Countdown",
  version: 1,
  size: [480, 480],
  default_duration_s: 5,
  max_duration_s: 5,
  max_duration_prop: "seconds",
  props_schema: { seconds: { type: "number", default: 5, min: 1, max: 60 } },
};

describe("resolveMotifContentDurationUs", () => {
  it("prefers content_duration_s over a max_duration cap", () => {
    const m: any = {
      content_duration_s: 0.8,
      max_duration_s: 5,
      max_duration_prop: "seconds",
      props_schema: {},
    };
    expect(resolveMotifContentDurationUs(m, { seconds: 5 })).toBe(800_000);
  });
  it("uses the live prop value when present", () => {
    expect(resolveMotifContentDurationUs(base, { seconds: 6 })).toBe(6_000_000);
  });
  it("falls back to max_duration_s when the prop is missing/invalid/non-number", () => {
    expect(resolveMotifContentDurationUs(base, {})).toBe(5_000_000);
    expect(resolveMotifContentDurationUs(base, { seconds: -3 })).toBe(5_000_000);
    expect(resolveMotifContentDurationUs(base, { seconds: "x" })).toBe(5_000_000);
    expect(resolveMotifContentDurationUs(base, { seconds: "6" })).toBe(5_000_000); // string not coerced (Rust parity)
    expect(resolveMotifContentDurationUs(base, { seconds: true })).toBe(5_000_000); // bool not coerced
  });
  it("returns null when fully unbounded", () => {
    const unbounded: MotifManifest = {
      id: base.id,
      name: base.name,
      version: base.version,
      size: base.size,
      default_duration_s: base.default_duration_s,
      props_schema: base.props_schema,
    };
    expect(resolveMotifContentDurationUs(unbounded, {})).toBeNull();
  });
});

it("registers the lower-third built-in (content_duration_s, non-square)", () => {
  const lt = getMotif("lower-third");
  expect(lt).not.toBeNull();
  expect(lt!.manifest.content_duration_s).toBe(0.8);
  expect(lt!.manifest.size).toEqual([1280, 320]);
  const ids = listMotifs().map((m) => m.id);
  expect(ids).toContain("countdown");
  expect(ids).toContain("lower-third");
});
