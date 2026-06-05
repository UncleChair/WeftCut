import { describe, expect, it } from "vitest";

import {
  resolveTemplateContentDurationUs,
  type TemplateManifest,
} from "./catalog";

const base: TemplateManifest = {
  id: "countdown",
  name: "Countdown",
  version: 1,
  size: [480, 480],
  default_duration_s: 5,
  max_duration_s: 5,
  max_duration_prop: "seconds",
  props_schema: { seconds: { type: "number", default: 5, min: 1, max: 60 } },
};

describe("resolveTemplateContentDurationUs", () => {
  it("uses the live prop value when present", () => {
    expect(resolveTemplateContentDurationUs(base, { seconds: 6 })).toBe(6_000_000);
  });
  it("falls back to max_duration_s when the prop is missing/invalid/non-number", () => {
    expect(resolveTemplateContentDurationUs(base, {})).toBe(5_000_000);
    expect(resolveTemplateContentDurationUs(base, { seconds: -3 })).toBe(5_000_000);
    expect(resolveTemplateContentDurationUs(base, { seconds: "x" })).toBe(5_000_000);
    expect(resolveTemplateContentDurationUs(base, { seconds: "6" })).toBe(5_000_000); // string not coerced (Rust parity)
    expect(resolveTemplateContentDurationUs(base, { seconds: true })).toBe(5_000_000); // bool not coerced
  });
  it("returns null when fully unbounded", () => {
    const unbounded: TemplateManifest = {
      id: base.id,
      name: base.name,
      version: base.version,
      size: base.size,
      default_duration_s: base.default_duration_s,
      props_schema: base.props_schema,
    };
    expect(resolveTemplateContentDurationUs(unbounded, {})).toBeNull();
  });
});
