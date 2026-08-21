// Where a line is allowed to break during PixiJS text measurement. Sibling of
// registry.ts: that module owns the bundled font BYTES, this one owns the break
// RULE, and both are realm-global installs behind the preview==export
// guarantee. See ADR 0049.
//
// `canBreakWords` is one of four statics PixiJS documents as the intended
// extension point for exactly this ("allows one to customise which words should
// break… if the token is CJK"), so this is the sanctioned mechanism rather than
// a workaround. The other three are the map of what is deliberately NOT done
// here, each wanting its own corpus:
//   canBreakChars    — kinsoku: no line-leading closing punctuation.
//   isBreakingSpace  — a space FOLLOWED by CJK is treated as breaking and should
//                      not be (pixijs/pixijs#6975). Only bites mixed CJK+spaced
//                      text, which subtitles rarely are.
//   wordWrapSplit    — where to cut a token that must be split at all.

import { CanvasTextMetrics } from "pixi.js";

/// East-Asian scripts that break between characters instead of at spaces. One
/// matching character anywhere in the token is enough: an unspaced CJK sentence
/// is a single Pixi token, and a mixed token has to break too.
///
/// Escaped rather than literal so a reviewer can check the ranges. Why each
/// family earns its place — one left out is a token that never wraps:
///   2E80-4DBF  CJK radicals, Kangxi radicals, CJK punctuation, Hiragana,
///              Katakana, Bopomofo, Hangul compatibility Jamo, enclosed and
///              compatibility forms, CJK Ext A — one contiguous East-Asian run.
///   4E00-9FFF  CJK Unified Ideographs — the bulk of any Chinese subtitle.
///   AC00-D7AF  Hangul syllables. Korean IS space-delimited, but the hook is
///              only consulted for a token that alone exceeds the wrap width,
///              where breaking by syllable beats overflowing the box.
///   F900-FAFF  CJK Compatibility Ideographs.
///   FE30-FE4F  CJK Compatibility Forms (vertical punctuation).
///   FF00-FFEF  Halfwidth and fullwidth forms — real subtitles are full of
///              fullwidth commas, periods and question marks.
///   20000-2FA1F  Supplementary ideograph planes, where the rare surnames a
///              name caption hits live. This range is what needs the `u` flag.
const CJK_RE =
  /[\u2E80-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2FA1F}]/u;

/// The hook this module installed, so "already installed" is a fact about
/// `CanvasTextMetrics` rather than about how many times we were called — a
/// bare call-counter would decline to repair a hook something else overwrote.
let ours: ((token: string, breakWords: boolean) => boolean) | null = null;

/// Teach Pixi to wrap CJK. Its wrap unit is a space-delimited token and the
/// stock hook returns the style's `breakWords` (false by default), so an
/// unspaced Chinese sentence is ONE token that never wraps at any
/// `wordWrapWidth` — the text box is inert in Chinese without this.
/// `breakWords: true` is not the alternative: it splits Latin words mid-word.
/// So the rule composes — breakable if the style says so OR the token is CJK.
///
/// `canBreakWords` is a class static, i.e. realm-global: installing it in one
/// realm only means preview wraps where export does not. Call it in EVERY realm
/// that rasterizes text, beside that realm's `loadFontsIntoFaceSet`.
///
/// Call it before the first measurement: `CanvasTextMetrics`'s measurement LRU
/// keys on text + style alone, so metrics cached under the stock hook would
/// survive a later install.
export function installCjkLineBreaking(): void {
  if (CanvasTextMetrics.canBreakWords === ours) return;
  ours = (token: string, breakWords: boolean): boolean => breakWords || CJK_RE.test(token);
  CanvasTextMetrics.canBreakWords = ours;
}
