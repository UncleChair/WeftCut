import { describe, it, expect } from "vitest";
import {
  parseManifestIsland,
  stripManifestIsland,
  composeMotifHtml,
  sanitizeId,
  assignUniqueId,
  BUILTIN_IDS,
  type Manifest,
} from "./catalog";

function base(): Manifest {
  return {
    id: "x", name: "X", version: 1, size: [640, 480],
    default_duration_s: 5, props_schema: {},
  };
}

describe("parseManifestIsland", () => {
  it("parses a well-formed island", () => {
    const html = `<head><script type="application/json" id="motif-manifest">{"id":"demo","name":"Demo","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}</script></head><body></body>`;
    const m = parseManifestIsland(html);
    expect(m.id).toBe("demo");
    expect(m.name).toBe("Demo");
  });
  it("throws when no island present", () => {
    expect(() => parseManifestIsland("<html><body>no island</body></html>")).toThrow();
  });
  it("throws on invalid island JSON", () => {
    const html = `<script type="application/json" id="motif-manifest">{not json}</script>`;
    expect(() => parseManifestIsland(html)).toThrow();
  });
});

describe("stripManifestIsland", () => {
  it("removes the island and preserves surrounding HTML", () => {
    const html = `<head><script type="application/json" id="motif-manifest">{"x":1}</script></head><body>keep</body>`;
    const stripped = stripManifestIsland(html);
    expect(stripped).not.toContain(`id="motif-manifest"`);
    expect(stripped).toContain("keep");
    expect(stripped).toContain("<head>");
    expect(stripped).toContain("</head>");
  });
  it("no-ops when no island present", () => {
    const html = `<head></head><body>hi</body>`;
    expect(stripManifestIsland(html)).toBe(html);
  });
});

describe("composeMotifHtml", () => {
  it("injects an island that parses back (round-trip)", () => {
    const m = { ...base(), id: "demo", name: "Demo" };
    const html = `<!doctype html><html><head></head><body><script>motif.define({setup(){}})</script></body></html>`;
    const composed = composeMotifHtml(m, html);
    const parsed = parseManifestIsland(composed);
    expect(parsed.id).toBe("demo");
    expect(parsed.name).toBe("Demo");
    expect(composed).toContain("motif.define");
  });
  it("survives a </script> inside a string field", () => {
    const m = { ...base(), id: "evil", name: "Evil</script><script>x" };
    const composed = composeMotifHtml(m, `<head></head><body><script>motif.define({setup(){}})</script></body>`);
    const parsed = parseManifestIsland(composed);
    expect(parsed.name).toBe("Evil</script><script>x");
    expect(parsed.id).toBe("evil");
  });
  it("prepends island when no <head>", () => {
    const m = { ...base(), id: "nohead" };
    const composed = composeMotifHtml(m, `<body><script>motif.define({setup(){}})</script></body>`);
    expect(parseManifestIsland(composed).id).toBe("nohead");
    expect(composed.trimStart().startsWith("<script")).toBe(true);
  });
  it("replaces a pre-existing island (exactly one remains)", () => {
    const m = { ...base(), id: "new-id" };
    const seed = `<head><script type="application/json" id="motif-manifest">{"id":"old-id","name":"Old","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}</script></head><body><script>motif.define({setup(){}})</script></body>`;
    const composed = composeMotifHtml(m, seed);
    expect(parseManifestIsland(composed).id).toBe("new-id");
    expect((composed.match(/id="motif-manifest"/g) ?? []).length).toBe(1);
  });
});

describe("sanitizeId", () => {
  it("slugifies display names", () => {
    expect(sanitizeId("My Cool Motif!")).toBe("my-cool-motif");
    expect(sanitizeId("  Trailing--dashes  ")).toBe("trailing-dashes");
    expect(sanitizeId("___")).toBe("motif");
    expect(sanitizeId("Lower/Third")).toBe("lower-third");
  });
});

describe("assignUniqueId", () => {
  it("avoids collisions, built-ins, and the reserved drafts dir", () => {
    expect(assignUniqueId("My Motif", ["my-motif", "my-motif-2"])).toBe("my-motif-3");
    expect(assignUniqueId("countdown", [])).toBe("countdown-2");
    expect(assignUniqueId("Drafts", [])).toBe("drafts-2");
    expect(assignUniqueId("Fresh", ["my-motif", "my-motif-2"])).toBe("fresh");
  });
});

describe("BUILTIN_IDS", () => {
  it("is the three built-ins", () => {
    expect([...BUILTIN_IDS].sort()).toEqual(["countdown", "lower-third", "text-fx"]);
  });
});
