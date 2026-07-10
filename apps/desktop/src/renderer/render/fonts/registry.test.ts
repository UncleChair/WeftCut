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
  // The per-family cache is module-global (by design — session-stable verdicts),
  // so each test uses family names no other test touches.
  const mockResolve = (impl: (f: string) => Promise<Uint8Array | null>) => {
    const resolve = vi.fn(impl);
    (globalThis as Record<string, unknown>).window = { api: { font: { resolve } } };
    return resolve;
  };

  it("resolves non-bundled families and skips bundled + misses", async () => {
    mockResolve(async (f) => (f === "Impact" ? new Uint8Array([1, 2]) : null));
    const out = await resolveFontsForFamilies(["Impact", "Liberation Sans", "Nonexistent"]);
    expect(Object.keys(out)).toEqual(["Impact"]);
  });

  it("memoizes hits: one IPC resolve per family per session", async () => {
    const resolve = mockResolve(async () => new Uint8Array([7, 8, 9]));
    const a = await resolveFontsForFamilies(["MemoHitFont"]);
    const b = await resolveFontsForFamilies(["MemoHitFont"]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(b.MemoHitFont!)).toEqual(new Uint8Array(a.MemoHitFont!));
  });

  it("hands out copies, never the cached buffer (transfer would detach it)", async () => {
    mockResolve(async () => new Uint8Array([4, 5]));
    const a = await resolveFontsForFamilies(["CopyFont"]);
    const b = await resolveFontsForFamilies(["CopyFont"]);
    expect(a.CopyFont).not.toBe(b.CopyFont);
    expect(new Uint8Array(a.CopyFont!)).toEqual(new Uint8Array([4, 5]));
  });

  it("caches misses: an absent family doesn't re-pay IPC every export", async () => {
    const resolve = mockResolve(async () => null);
    await resolveFontsForFamilies(["MissFont"]);
    const out = await resolveFontsForFamilies(["MissFont"]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(out).toEqual({});
  });

  it("does not cache rejections: the next call retries and can succeed", async () => {
    let calls = 0;
    const resolve = mockResolve(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ipc hiccup");
      return new Uint8Array([6]);
    });
    await expect(resolveFontsForFamilies(["RetryFont"])).rejects.toThrow("ipc hiccup");
    const out = await resolveFontsForFamilies(["RetryFont"]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(out.RetryFont!)).toEqual(new Uint8Array([6]));
  });
});
