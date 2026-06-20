import { describe, expect, it } from "vitest";
import {
  BUNDLED_FONT_FAMILIES,
  DEFAULT_CAPTION_FONT_FAMILY,
} from "./registry";

describe("font registry", () => {
  it("advertises Liberation Sans + Noto CJK and a fallback-chain default", () => {
    expect(BUNDLED_FONT_FAMILIES).toContain("Liberation Sans");
    expect(BUNDLED_FONT_FAMILIES).toContain("Noto Sans SC");
    expect(DEFAULT_CAPTION_FONT_FAMILY).toBe("Liberation Sans, Noto Sans SC");
  });
});
