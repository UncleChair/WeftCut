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

  test("multi-chunk base64 round-trips correctly (guards chunking logic)", () => {
    // 65_541 bytes > 0x8000 (32_768) — forces at least two chunks in bytesToBase64.
    const bytes = new Uint8Array(65_541);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const style = buildFontFaceStyle([{ family: "X", bytes }]);
    // Extract the base64 payload from the data URL.
    const match = style.match(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/);
    expect(match).not.toBeNull();
    const b64 = match?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    // Decode back to bytes via atob.
    const binary = atob(b64);
    expect(binary.length).toBe(bytes.length);
    // Spot-check first, last, and a mid-array index.
    expect(binary.charCodeAt(0)).toBe(bytes[0]);
    expect(binary.charCodeAt(32_767)).toBe(bytes[32_767]);
    expect(binary.charCodeAt(65_540)).toBe(bytes[65_540]);
  });

  test("injectFontFace returns input unchanged when no <svg> tag is present", () => {
    const input = "<div>no svg here</div>";
    expect(injectFontFace(input, "@font-face{}")).toBe(input);
  });
});
