// Subtitle test-fixture generator. Unlike the media fixtures (binary, gitignored,
// produced by generate.go), these are tiny text files written directly here and
// committed — diffable and usable straight from a checkout. Covers the parser
// matrix: plain SRT, CJK SRT (the burn-in spike), multi-line, overlapping cues
// (multi-track auto-stack), Tier-3 ASS (style table + mapped + dropped overrides),
// and WebVTT (header/NOTE/cue-settings dropped).
//
// Files are written with explicit UTF-8 so the CJK content survives on any
// platform (Node fs writes the bytes directly — no shell codepage involved).
//
// Run: `node e2e/fixtures/generate-subtitles.mjs [outDir]`
// Or import { generateSubtitleFixtures } from "./generate-subtitles.mjs" in e2e.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// filename -> content. The single source of truth for the subtitle fixture set.
export const SUBTITLE_FIXTURES = {
  // Plain sequential English SRT — the simplest happy path.
  "basic-en.srt": [
    "1",
    "00:00:00,000 --> 00:00:02,000",
    "Hello, world",
    "",
    "2",
    "00:00:02,000 --> 00:00:04,000",
    "This is a test subtitle",
    "",
    "3",
    "00:00:04,000 --> 00:00:06,000",
    "Caption rendering test",
    "",
  ].join("\n"),

  // CJK SRT — THE font burn-in spike file. Import this, then check preview +
  // export render the Chinese with the bundled Noto Sans SC (no tofu).
  "basic-zh.srt": [
    "1",
    "00:00:00,000 --> 00:00:02,000",
    "你好，世界",
    "",
    "2",
    "00:00:02,000 --> 00:00:04,000",
    "这是一段测试字幕",
    "",
    "3",
    "00:00:04,000 --> 00:00:06,000",
    "中文字幕渲染测试",
    "",
  ].join("\n"),

  // A cue with an explicit line break — v1 preserves it as a real newline.
  "multiline.srt": [
    "1",
    "00:00:00,000 --> 00:00:03,000",
    "First line",
    "second line",
    "",
  ].join("\n"),

  // Overlapping cues — exercises the multi-track auto-stack. Cue 2 [1s,4s)
  // overlaps cue 1 [0s,3s) -> goes on a 2nd caption track; cue 3 [3s,5s)
  // starts exactly when cue 1 ends -> back on track 1. Expect 2 caption tracks.
  "overlapping.srt": [
    "1",
    "00:00:00,000 --> 00:00:03,000",
    "Speaker A talking",
    "",
    "2",
    "00:00:01,000 --> 00:00:04,000",
    "Speaker B interjecting",
    "",
    "3",
    "00:00:03,000 --> 00:00:05,000",
    "Back on the first track",
    "",
  ].join("\n"),

  // Tier-3 ASS: full standard V4+/Events Format columns; a comma inside the
  // first cue's text (splitn must keep it); \an8 + \c mapped; \k karaoke dropped
  // (sets the "simplified" flag). PrimaryColour &H00FFFFFF = white, Bold = -1.
  "styled.ass": [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\an8}Top, styled line",
    "Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\c&H0000FF&}Red text",
    "Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\k50}Karaoke dropped, text kept",
    "",
  ].join("\n"),

  // WebVTT: header + a NOTE comment block (both skipped) + a cue with settings
  // (line/position — dropped in v1) + a plain cue.
  "cue-settings.vtt": [
    "WEBVTT",
    "",
    "NOTE",
    "This comment block must be skipped, not emitted as a cue.",
    "",
    "intro",
    "00:00:00.000 --> 00:00:02.000 line:90% position:50%",
    "First VTT cue (settings dropped)",
    "",
    "00:00:02.000 --> 00:00:04.000",
    "Second VTT cue",
    "",
  ].join("\n"),
};

/// Write every fixture into `outDir` (created if missing). Returns the list of
/// absolute paths written. Always overwrites so files stay in lockstep with this
/// generator (the source of truth).
export function generateSubtitleFixtures(outDir = path.join(HERE, "subtitles")) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [name, content] of Object.entries(SUBTITLE_FIXTURES)) {
    const dest = path.join(outDir, name);
    writeFileSync(dest, content, "utf8");
    written.push(dest);
    console.log(`[subtitles] wrote ${name} (${Buffer.byteLength(content, "utf8")} bytes)`);
  }
  return written;
}

// Standalone: `node generate-subtitles.mjs [outDir]`
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, "subtitles");
  const files = generateSubtitleFixtures(outDir);
  console.log(`[subtitles] done — ${files.length} fixtures in ${outDir}`);
}
