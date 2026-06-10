import { describe, it, expect } from "vitest";
import { newDraftSource } from "./newDraftSource";

describe("newDraftSource", () => {
  it("produces a valid manifest + a motif.define HTML carrying the given name", () => {
    const { manifest, html } = newDraftSource("My Overlay");
    expect(manifest.name).toBe("My Overlay");
    expect(manifest.size).toHaveLength(2);
    expect(manifest.default_duration_s).toBeGreaterThan(0);
    expect(typeof manifest.props_schema).toBe("object");
    expect(html).toContain("motif.define");
    expect(html).not.toContain('id="motif-manifest"');
    expect((manifest.props_schema.title as { default: string }).default).toBe("My Overlay");
  });
});
