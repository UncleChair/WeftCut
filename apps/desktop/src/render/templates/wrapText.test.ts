import { describe, expect, test } from "vitest";
import { wrapTspans } from "./wrapText";

const measure = (s: string) => s.length * 10; // 10px per char (fake)

describe("wrapTspans", () => {
  test("greedy-wraps to maxWidth", () => {
    expect(wrapTspans("aaa bbb ccc", 75, measure)).toEqual(["aaa bbb", "ccc"]);
  });

  test("empty string returns empty array", () => {
    expect(wrapTspans("", 100, measure)).toEqual([]);
  });

  test("whitespace-only string returns empty array", () => {
    expect(wrapTspans("   ", 100, measure)).toEqual([]);
  });

  test("single word that fits goes on its own line", () => {
    expect(wrapTspans("hello", 100, measure)).toEqual(["hello"]);
  });

  test("single word wider than maxWidth goes on its own line (no infinite loop)", () => {
    expect(wrapTspans("superlongword", 30, measure)).toEqual(["superlongword"]);
  });

  test("all words fit on one line", () => {
    expect(wrapTspans("a b c", 100, measure)).toEqual(["a b c"]);
  });

  test("each word wider than maxWidth goes on separate lines", () => {
    expect(wrapTspans("longword1 longword2", 30, measure)).toEqual(["longword1", "longword2"]);
  });

  test("wraps at exact boundary", () => {
    // "aaa bbb" = 7 chars * 10 = 70 <= 75, "aaa bbb ccc" = 11 * 10 = 110 > 75
    expect(wrapTspans("aaa bbb ccc", 75, measure)).toEqual(["aaa bbb", "ccc"]);
  });

  test("multiple breaks across a longer string", () => {
    // each word is 3 chars = 30px; "aaa bbb" = 70 <= 75, adding " ccc" = 110 > 75
    expect(wrapTspans("aaa bbb ccc ddd eee", 75, measure)).toEqual(["aaa bbb", "ccc ddd", "eee"]);
  });
});
