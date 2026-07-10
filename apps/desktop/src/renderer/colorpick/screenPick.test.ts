// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { eyeDropperAvailable, screenPick } from "./screenPick";

type W = { EyeDropper?: unknown };
afterEach(() => {
  delete (window as W).EyeDropper;
  vi.restoreAllMocks();
});

describe("screenPick", () => {
  it("unavailable without window.EyeDropper", async () => {
    expect(eyeDropperAvailable()).toBe(false);
    expect(await screenPick()).toBeNull();
  });
  it("resolves the lowercased sRGBHex", async () => {
    (window as W).EyeDropper = class {
      open() { return Promise.resolve({ sRGBHex: "#AABBCC" }); }
    };
    expect(eyeDropperAvailable()).toBe(true);
    expect(await screenPick()).toBe("#aabbcc");
  });
  it("maps AbortError (user Esc) to null", async () => {
    (window as W).EyeDropper = class {
      open() { return Promise.reject(new DOMException("aborted", "AbortError")); }
    };
    expect(await screenPick()).toBeNull();
  });
});
