import { describe, expect, test } from "vitest";
import {
  buildForeignObjectSvg,
  canonicalizeProps,
  rasterCacheKey,
} from "./Rasterizer";
import type { TemplateManifest } from "./catalog";

const sampleManifest: TemplateManifest = {
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

describe("buildForeignObjectSvg", () => {
  test("wraps html + css inside a foreignObject with the SVG namespace", () => {
    const svg = buildForeignObjectSvg({
      html: "<div>hi</div>",
      css: "body { margin: 0 }",
      width: 800,
      height: 200,
    });
    expect(svg).toMatch(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toMatch(/width="800"/);
    expect(svg).toMatch(/height="200"/);
    expect(svg).toMatch(/<foreignObject[^>]*width="100%"[^>]*height="100%"/);
    expect(svg).toMatch(/xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/);
    expect(svg).toContain("<div>hi</div>");
    expect(svg).toContain("body { margin: 0 }");
  });

  test("escapes nothing about the html (templates are trusted, embedded as-is)", () => {
    const svg = buildForeignObjectSvg({
      html: "<p>A & B < C</p>",
      css: "",
      width: 100,
      height: 100,
    });
    expect(svg).toContain("<p>A & B < C</p>");
  });
});

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

describe("rasterCacheKey", () => {
  test("is deterministic across calls with the same inputs", () => {
    const k1 = rasterCacheKey({
      templateId: "lower-third-simple",
      version: 1,
      canonicalProps: { title: "A", subtitle: "", color: "#0050ff" },
      width: 800,
      height: 200,
    });
    const k2 = rasterCacheKey({
      templateId: "lower-third-simple",
      version: 1,
      canonicalProps: { title: "A", subtitle: "", color: "#0050ff" },
      width: 800,
      height: 200,
    });
    expect(k1).toBe(k2);
  });

  test("differs when any input differs", () => {
    const base = {
      templateId: "lower-third-simple",
      version: 1,
      canonicalProps: { title: "A", subtitle: "", color: "#0050ff" },
      width: 800,
      height: 200,
    };
    const k0 = rasterCacheKey(base);
    expect(rasterCacheKey({ ...base, templateId: "title-card" })).not.toBe(k0);
    expect(rasterCacheKey({ ...base, version: 2 })).not.toBe(k0);
    expect(
      rasterCacheKey({
        ...base,
        canonicalProps: { ...base.canonicalProps, title: "B" },
      }),
    ).not.toBe(k0);
    expect(rasterCacheKey({ ...base, width: 1920 })).not.toBe(k0);
    expect(rasterCacheKey({ ...base, height: 1080 })).not.toBe(k0);
  });
});
