import { describe, expect, test } from "vitest";
import { buildFontFaceStyle, injectFontFace } from "./fontFace";

describe("fontFace", () => {
  test("injects a data-URL @font-face into the svg defs", () => {
    const style = buildFontFaceStyle([{ family: "Inter", bytes: new Uint8Array([1, 2, 3]) }]);
    expect(style).toContain("@font-face");
    expect(style).toContain("font-family:'Inter'");
    expect(style).toContain("data:font/woff2;base64,");
    const svg = injectFontFace('<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>', style);
    expect(svg).toMatch(/<defs><style>@font-face/);
  });

  test("empty font list produces empty string", () => {
    expect(buildFontFaceStyle([])).toBe("");
  });

  test("empty style leaves svg unchanged", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>';
    expect(injectFontFace(svg, "")).toBe(svg);
  });

  test("includes font-weight when provided", () => {
    const style = buildFontFaceStyle([{ family: "Inter", weight: 700, bytes: new Uint8Array([1]) }]);
    expect(style).toContain("font-weight:700");
  });

  test("includes font-style when provided", () => {
    const style = buildFontFaceStyle([{ family: "Inter", style: "italic", bytes: new Uint8Array([1]) }]);
    expect(style).toContain("font-style:italic");
  });

  test("multiple fonts are concatenated", () => {
    const style = buildFontFaceStyle([
      { family: "Inter", bytes: new Uint8Array([1]) },
      { family: "Mono", bytes: new Uint8Array([2]) },
    ]);
    expect(style).toContain("font-family:'Inter'");
    expect(style).toContain("font-family:'Mono'");
  });

  test("base64-encodes bytes correctly", () => {
    // [1,2,3] → base64 "AQID"
    const style = buildFontFaceStyle([{ family: "X", bytes: new Uint8Array([1, 2, 3]) }]);
    expect(style).toContain("AQID");
  });
});
