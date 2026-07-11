// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eyeDropperAvailable, screenPick } from "./screenPick";

type W = { EyeDropper?: unknown; api?: unknown };
const focus = vi.fn(async () => {});
beforeEach(() => {
  (window as W).api = { window: { focus } };
});
afterEach(() => {
  delete (window as W).EyeDropper;
  delete (window as W).api;
  focus.mockClear();
  vi.restoreAllMocks();
});

describe("screenPick", () => {
  it("unavailable without window.EyeDropper", async () => {
    expect(eyeDropperAvailable()).toBe(false);
    expect(await screenPick()).toBeNull();
    // No dropper opened ⇒ no focus was stolen ⇒ nothing to restore.
    expect(focus).not.toHaveBeenCalled();
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
  it("snaps focus back after a successful pick (electron#27980 steal)", async () => {
    (window as W).EyeDropper = class {
      open() { return Promise.resolve({ sRGBHex: "#AABBCC" }); }
    };
    await screenPick();
    expect(focus).toHaveBeenCalledTimes(1);
  });
  it("snaps focus back after a cancelled pick too", async () => {
    (window as W).EyeDropper = class {
      open() { return Promise.reject(new DOMException("aborted", "AbortError")); }
    };
    await screenPick();
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
