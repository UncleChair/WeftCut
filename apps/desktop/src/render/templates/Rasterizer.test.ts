import { describe, expect, test } from "vitest";
import { canonicalizeProps } from "./Rasterizer";
import type { MotifManifest } from "./catalog";

const sampleManifest: MotifManifest = {
  id: "lower-third-simple",
  name: "Simple Lower Third",
  version: 1,
  size: [800, 200],
  default_duration_s: 5.0,
  props_schema: {
    title: { type: "string", default: "Title", max_length: 80 },
    subtitle: { type: "string", default: "" },
    color: { type: "color", default: "#0050ff" },
  },
};

describe("canonicalizeProps", () => {
  test("fills missing keys from schema defaults", () => {
    const out = canonicalizeProps({}, sampleManifest);
    expect(out).toEqual({
      title: "Title",
      subtitle: "",
      color: "#0050ff",
    });
  });

  test("keeps provided values and fills the rest", () => {
    const out = canonicalizeProps(
      { title: "Custom" },
      sampleManifest,
    );
    expect(out).toEqual({
      title: "Custom",
      subtitle: "",
      color: "#0050ff",
    });
  });

  test("throws on unknown keys (matches Rust validator)", () => {
    expect(() =>
      canonicalizeProps({ nonsense: 42 }, sampleManifest),
    ).toThrow(/unknown prop/i);
  });

  test("output is key-order-stable regardless of input order", () => {
    const a = canonicalizeProps(
      { color: "#ff0000", title: "A" },
      sampleManifest,
    );
    const b = canonicalizeProps(
      { title: "A", color: "#ff0000" },
      sampleManifest,
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
