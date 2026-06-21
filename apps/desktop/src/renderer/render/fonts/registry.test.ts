// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  BUNDLED_FONT_FAMILIES,
  DEFAULT_CAPTION_FONT_FAMILY,
  resolveFontsForFamilies,
} from "./registry";

describe("font registry", () => {
  it("advertises Liberation Sans + Noto CJK and a fallback-chain default", () => {
    expect(BUNDLED_FONT_FAMILIES).toContain("Liberation Sans");
    expect(BUNDLED_FONT_FAMILIES).toContain("Noto Sans SC");
    expect(DEFAULT_CAPTION_FONT_FAMILY).toBe("Liberation Sans, Noto Sans SC");
  });
});

describe("resolveFontsForFamilies", () => {
  it("resolves non-bundled families and skips bundled + misses", async () => {
    (globalThis as Record<string, unknown>).window = {
      api: { font: { resolve: vi.fn(async (f: string) => (f === "Impact" ? new Uint8Array([1, 2]) : null)) } },
    };
    const out = await resolveFontsForFamilies(["Impact", "Liberation Sans", "Nonexistent"]);
    expect(Object.keys(out)).toEqual(["Impact"]);
  });
});
