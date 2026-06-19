// Subtitle body normalization for JASSUB.
//
// libass (and JASSUB) only accepts ASS bodies. Inline SRT bodies — what
// Whisper auto-caption emits — and `.srt`-on-disk go through `srtToAss`
// first. `.ass` / `.ssa` bodies pass through verbatim. File-backed
// reads happen in `SubtitlesSprite`; this module is pure so it stays
// testable without DOM.

import type { SubtitlesView } from "../../ipc";

const ASS_HEADER =
  `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

interface SrtCue {
  start: string;
  end: string;
  text: string;
}

const CUE_RE =
  /(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)\s*\r?\n([\s\S]*?)(?=\r?\n\r?\n|\r?\n*$)/g;

function srtTimeToAssTime(t: string): string {
  // SRT:  HH:MM:SS,mmm  (or .mmm)
  // ASS:  H:MM:SS.cs    (centiseconds, no leading zero on hours)
  const m = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(t);
  if (!m) return t;
  const [, hh, mm, ss, frac] = m;
  const h = parseInt(hh!, 10);
  const cs = Math.floor(parseInt(frac!.padEnd(3, "0").slice(0, 3), 10) / 10);
  return `${h}:${mm}:${ss}.${cs.toString().padStart(2, "0")}`;
}

export function srtToAss(srt: string): string {
  const cues: SrtCue[] = [];
  for (const m of srt.matchAll(CUE_RE)) {
    const [, start, end, raw] = m;
    const text = raw!.trim().replace(/\r?\n/g, "\\N");
    if (text.length === 0) continue;
    cues.push({ start: start!, end: end!, text });
  }
  let out = ASS_HEADER;
  for (const cue of cues) {
    out +=
      `Dialogue: 0,${srtTimeToAssTime(cue.start)},${srtTimeToAssTime(cue.end)},Default,,0,0,0,,${cue.text}\n`;
  }
  return out;
}

export function subtitlesViewToAssBody(view: SubtitlesView): string | null {
  switch (view.source_kind) {
    case "InlineAss":
      return view.source_value;
    case "InlineSrt":
      return srtToAss(view.source_value);
    case "Media":
      // Media bodies need an async file read; SubtitlesSprite handles
      // that and feeds the result through `subtitleBodyFromFile`.
      return null;
  }
}

/// Dispatch a fetched subtitle file's contents to the ASS body the
/// JASSUB binding wants. `.ass` / `.ssa` pass through verbatim; `.srt`
/// is converted via `srtToAss`. Anything else (`.vtt`, unknown
/// extensions) returns null — the caller surfaces the skip.
///
/// Pure so chunk 2's file-fetch path stays testable in Node without
/// real assets. The caller picks the path off `MediaItem.path`.
export function subtitleBodyFromFile(
  path: string,
  content: string,
): string | null {
  const ext = extensionOf(path);
  switch (ext) {
    case "ass":
    case "ssa":
      return content;
    case "srt":
      return srtToAss(content);
    default:
      return null;
  }
}

function extensionOf(path: string): string {
  // Strip query / fragment defensively (asset URLs in Tauri may carry
  // a port-token query string), then take the last `.`-tail and
  // normalize to lowercase.
  const cleaned = path.replace(/[?#].*$/, "");
  const idx = cleaned.lastIndexOf(".");
  if (idx < 0) return "";
  return cleaned.slice(idx + 1).toLowerCase();
}
