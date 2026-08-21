import { CanvasTextMetrics, Container, TextStyle, type Application } from "pixi.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Compositor } from "../Compositor";
import type { DecoderPool } from "../decoder/session";
import { installCjkLineBreaking } from "./lineBreak";

// Measured, not string-matched: the only thing that proves the two realms agree
// is that the same text and style resolve to the same lines under each realm's
// install path.

/// Every glyph this wide, so the expected line counts are arithmetic.
const ADVANCE_PX = 10;
/// Six glyphs per line.
const WRAP_PX = 6 * ADVANCE_PX;

/// One unspaced Chinese sentence — 15 characters, therefore one Pixi token.
const CJK = "这是一段没有空格的中文字幕文本";

/// Pixi's stock hook, captured before anything installs over it, so a test can
/// measure the pre-install world the export defect lives in.
const STOCK_CAN_BREAK_WORDS = CanvasTextMetrics.canBreakWords;

/// The measurement LRU keys on text + style and NOT on the break hook, so a
/// metric cached under one hook would answer for the other. Production installs
/// before its first measurement; a test that switches hooks has to evict.
function clearMetricsCache(): void {
  (
    CanvasTextMetrics as unknown as { _measurementCache: { clear: () => void } }
  )._measurementCache.clear();
}

function wrapStyle(): TextStyle {
  return new TextStyle({
    fontFamily: "Liberation Sans",
    fontSize: 40,
    wordWrap: true,
    wordWrapWidth: WRAP_PX,
  });
}

function measureLines(text: string): string[] {
  clearMetricsCache();
  return CanvasTextMetrics.measureText(text, wrapStyle()).lines;
}

/// The node test env has no canvas. Pixi reaches for `OffscreenCanvas` first, so
/// stubbing the constructor owns the whole measurement path;
/// `CanvasRenderingContext2D` exists only for Pixi's letter-spacing probe, which
/// reads its prototype.
beforeAll(() => {
  const ctx = {
    font: "",
    letterSpacing: "0px",
    measureText: (s: string) => {
      const width = [...s].length * ADVANCE_PX;
      return {
        width,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
      };
    },
  };
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width = 0,
        public height = 0,
      ) {}
      getContext(): unknown {
        return ctx;
      }
    },
  );
  vi.stubGlobal("CanvasRenderingContext2D", class {});
});

beforeEach(() => {
  CanvasTextMetrics.canBreakWords = STOCK_CAN_BREAK_WORDS;
});

describe("CJK line breaking", () => {
  it("is the defect it exists for: without it a Chinese sentence is one line", () => {
    // One space-delimited token, wider than any wrap width — Pixi emits it whole
    // and the text box is inert in Chinese.
    expect(measureLines(CJK)).toEqual([CJK]);
  });

  it("wraps Chinese per character once installed", () => {
    installCjkLineBreaking();
    expect(measureLines(CJK)).toEqual(["这是一段没有", "空格的中文字", "幕文本"]);
  });

  it("still wraps English at word boundaries, and never inside a word", () => {
    installCjkLineBreaking();
    // "wonderful" is 9 glyphs in a 6-glyph box: it overflows its line rather
    // than splitting, which is what `breakWords: false` buys.
    expect(measureLines("hello wonderful world")).toEqual(["hello", "wonderful", "world"]);
  });

  it("breaks a token that mixes scripts, because one CJK glyph is enough", () => {
    installCjkLineBreaking();
    expect(measureLines("中文OK中文OK").length).toBeGreaterThan(1);
  });

  it("agrees between the main-thread install and a fresh (Worker-realm) one", async () => {
    // Main thread: constructing a Compositor is the install site, so this
    // measures the downstream behaviour of the real call rather than its text.
    const compositor = new Compositor({
      app: { stage: new Container() } as unknown as Application,
      width: 640,
      height: 360,
      mode: "preview",
      originalAssetUrl: () => null,
      sourceColor: () => undefined,
      mediaById: () => undefined,
      pool: { dispose: vi.fn() } as unknown as DecoderPool,
    });
    const mainThread = measureLines(CJK);
    compositor.dispose();
    expect(mainThread.length).toBeGreaterThan(1);

    // The export Worker is a separate bundle, so it installs from its own
    // instance of this module. Reset both the registry and the hook, or a
    // surviving install would make the assertion vacuous.
    CanvasTextMetrics.canBreakWords = STOCK_CAN_BREAK_WORDS;
    vi.resetModules();
    const fresh = await import("./lineBreak");
    expect(measureLines(CJK)).toEqual([CJK]);
    fresh.installCjkLineBreaking();

    expect(measureLines(CJK)).toEqual(mainThread);
  });
});
