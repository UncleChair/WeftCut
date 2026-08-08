import { describe, expect, it } from "vitest";

import { resolveAccelerator } from "./match";

// Both platform branches are exercised through the explicit `mac` parameter —
// same pattern as platform.ts's classifyOS, no DOM or module mocking involved.
describe("resolveAccelerator", () => {
  it("renders text with plus separators on Windows/Linux", () => {
    expect(resolveAccelerator("Mod+Shift+S", false)).toBe("Ctrl+Shift+S");
    expect(resolveAccelerator("Mod+K", false)).toBe("Ctrl+K");
    expect(resolveAccelerator("Ctrl+Alt+O", false)).toBe("Ctrl+Alt+O");
  });

  it("renders the macOS compact glyph run", () => {
    expect(resolveAccelerator("Mod+Shift+S", true)).toBe("⇧⌘S");
    expect(resolveAccelerator("Mod+K", true)).toBe("⌘K");
    expect(resolveAccelerator("Ctrl+Alt+O", true)).toBe("⌃⌥O");
  });

  it("normalises modifier order to the platform canon", () => {
    expect(resolveAccelerator("Shift+Alt+K", false)).toBe("Alt+Shift+K");
    expect(resolveAccelerator("Shift+Ctrl+Alt+K", true)).toBe("⌃⌥⇧K");
  });

  it("renders arrows as glyphs on every platform", () => {
    expect(resolveAccelerator("Alt+ArrowLeft", false)).toBe("Alt+←");
    expect(resolveAccelerator("Alt+Shift+ArrowRight", true)).toBe("⌥⇧→");
    expect(resolveAccelerator("ArrowUp", false)).toBe("↑");
  });

  it("renders named punctuation as the character it types", () => {
    expect(resolveAccelerator("Ctrl+Shift+Period", false)).toBe("Ctrl+Shift+.");
    expect(resolveAccelerator("Ctrl+Shift+Comma", true)).toBe("⌃⇧,");
    expect(resolveAccelerator("Backquote", false)).toBe("`");
  });

  it("uses macOS key glyphs only on macOS", () => {
    expect(resolveAccelerator("Delete", true)).toBe("⌦");
    expect(resolveAccelerator("Delete", false)).toBe("Delete");
    expect(resolveAccelerator("Mod+Backspace", true)).toBe("⌘⌫");
    expect(resolveAccelerator("Escape", false)).toBe("Escape");
  });

  it("keeps Space and other named keys textual", () => {
    expect(resolveAccelerator("Space", true)).toBe("Space");
    expect(resolveAccelerator("Space", false)).toBe("Space");
    expect(resolveAccelerator("Home", true)).toBe("Home");
    expect(resolveAccelerator("F1", false)).toBe("F1");
  });

  it("uppercases single letters and shows unknown modifiers verbatim", () => {
    expect(resolveAccelerator("Mod+s", false)).toBe("Ctrl+S");
    expect(resolveAccelerator("Hyper+K", false)).toBe("Hyper+K");
    expect(resolveAccelerator("", false)).toBe("");
  });
});
