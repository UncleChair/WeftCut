import { describe, expect, it } from "vitest";
import { pinyinHaystacks } from "./pinyin";

describe("pinyinHaystacks", () => {
  it("generates full pinyin + initials for Chinese text", () => {
    const h = pinyinHaystacks("字幕");
    expect(h).not.toBeNull();
    expect(h!.full).toBe("zimu");
    expect(h!.initials).toBe("zm");
  });

  it("returns null for pure-Latin text", () => {
    expect(pinyinHaystacks("export video")).toBeNull();
  });

  it("keeps Latin runs intact in mixed text", () => {
    const h = pinyinHaystacks("导出mp4");
    expect(h!.full).toBe("daochump4");
    expect(h!.initials).toBe("dcmp4");
  });

  it("memoizes by content (same object identity)", () => {
    expect(pinyinHaystacks("字幕")).toBe(pinyinHaystacks("字幕"));
  });
});
