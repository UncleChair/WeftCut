import { describe, it, expect } from "vitest";
import {
  canonicalizeProps,
  canonicalizePropsLenient,
  resolveMotifMaxDurUs,
  resolveMotifTEndUs,
  resolveMotifContentDurationUs,
  MotifPropError,
  BUILTIN_MANIFESTS,
} from "./catalog";
import type { Manifest } from "./catalog";

const m: Manifest = {
  id: "t",
  name: "T",
  version: 1,
  size: [1, 1],
  default_duration_s: 5,
  props_schema: {
    title: { type: "string", default: "Hi", max_length: 5 },
    color: { type: "color", default: "#fff" },
    n: { type: "number", default: 1, min: 0, max: 10 },
    mode: { type: "enum", default: "a", options: ["a", "b"] },
  },
};

describe("canonicalizeProps", () => {
  it("fills defaults + alphabetical key order", () => {
    expect(Object.keys(canonicalizeProps(m, {}))).toEqual(["color", "mode", "n", "title"]);
  });

  it("rejects unknown key", () =>
    expect(() => canonicalizeProps(m, { nope: 1 })).toThrow(MotifPropError));

  it("string max_length is unicode char count", () =>
    // "abcdef" is 6 unicode chars, max_length is 5 — must throw
    expect(() => canonicalizeProps(m, { title: "abcdef" })).toThrow());

  it("string max_length exact boundary passes", () =>
    expect(canonicalizeProps(m, { title: "abcde" })).toBeTruthy());

  it("color must match #rgb/#rgba/#rrggbb/#rrggbbaa", () =>
    expect(() => canonicalizeProps(m, { color: "red" })).toThrow());

  it("number min/max", () => {
    expect(() => canonicalizeProps(m, { n: -1 })).toThrow();
    expect(() => canonicalizeProps(m, { n: 11 })).toThrow();
  });

  it("enum options", () =>
    expect(() => canonicalizeProps(m, { mode: "z" })).toThrow());
});

describe("canonicalizePropsLenient", () => {
  it("drops unknown + defaults invalid, never throws", () => {
    expect(canonicalizePropsLenient(m, { nope: 1, n: 99 })).toEqual({
      color: "#fff",
      mode: "a",
      n: 1,
      title: "Hi",
    });
  });
});

describe("resolveMotifMaxDurUs", () => {
  it("excludes content_duration_s", () => {
    expect(resolveMotifMaxDurUs({ ...m, content_duration_s: 99 }, {})).toBeNull();
    expect(resolveMotifMaxDurUs({ ...m, max_duration_prop: "n", max_duration_s: 10 }, { n: 3 })).toBe(3_000_000);
  });
});

describe("resolveMotifTEndUs", () => {
  it("uses provided t_end_us when given", () => {
    expect(resolveMotifTEndUs(0, 5_000_000, 3.0, null)).toBe(5_000_000);
  });

  it("uses default_duration_s TRUNCATED (not rounded) when t_end_us is null", () => {
    // 1.9999999s * 1e6 = 1999999.9 → Math.trunc → 1999999
    expect(resolveMotifTEndUs(0, null, 1.9999999, null)).toBe(1_999_999);
  });

  it("clamps to cap when explicit t_end_us exceeds cap", () => {
    expect(resolveMotifTEndUs(0, 10_000_000, 5.0, 3_000_000)).toBe(3_000_000);
  });

  it("does not clamp when duration fits within cap", () => {
    expect(resolveMotifTEndUs(0, 2_000_000, 5.0, 3_000_000)).toBe(2_000_000);
  });

  it("handles null cap (unbounded)", () => {
    expect(resolveMotifTEndUs(1_000_000, null, 5.0, null)).toBe(6_000_000);
  });
});

describe("resolveMotifContentDurationUs", () => {
  it("returns content_duration_s first when set", () => {
    expect(resolveMotifContentDurationUs({ ...m, content_duration_s: 0.8 }, {})).toBe(800_000);
  });

  it("returns max_duration_prop value when set and valid", () => {
    expect(resolveMotifContentDurationUs({ ...m, max_duration_prop: "n" }, { n: 3 })).toBe(3_000_000);
  });

  it("falls back to max_duration_s", () => {
    expect(resolveMotifContentDurationUs({ ...m, max_duration_s: 10 }, {})).toBe(10_000_000);
  });

  it("returns null when nothing is set", () => {
    expect(resolveMotifContentDurationUs(m, {})).toBeNull();
  });
});

describe("BUILTIN_MANIFESTS", () => {
  it("contains exactly countdown, lower-third, text-fx", () => {
    expect([...BUILTIN_MANIFESTS.keys()].sort()).toEqual(["countdown", "lower-third", "text-fx"]);
  });

  it("countdown has expected shape", () => {
    const c = BUILTIN_MANIFESTS.get("countdown")!;
    expect(c.id).toBe("countdown");
    expect(c.size).toEqual([480, 480]);
    expect(c.max_duration_prop).toBe("seconds");
  });
});
