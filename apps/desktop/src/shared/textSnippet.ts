// Collapsing a text body down to something that can be shown on ONE row, for
// the places a Text layer has to be named rather than rendered. Lives in
// src/shared/ because that name is derived on both sides of the IPC seam —
// renderer/lib/layerName.ts for the timeline block and the panels,
// main/state/history-labels.ts for the history rows — and the two must not name
// one layer two ways. Same reason DecodeRoute / AppSettings / Interpolation
// live here: not "shared utility", but "one rule, two processes".

/// A Text layer's body as a single line: runs of whitespace (newlines included)
/// collapse to single spaces, so a three-line caption occupies one row instead
/// of silently rendering as its first line only. Longer than `max` gets an
/// ellipsis INSIDE the budget — `max` is the length of what comes back, not the
/// length before the dots, so a caller sizing a row can trust the number.
///
/// Returns "" for a blank body, which every caller reads as "no name here" and
/// falls through on. A zero-width name is worse than the kind word it displaced.
export function textSnippet(content: string, max: number): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3)}...`;
}

/// The cap for a Text layer used AS A NAME — timeline chip, history row, Nearby
/// row, error message. Generous enough that a normal subtitle line survives
/// whole, tight enough that a paragraph pasted into one layer cannot stretch a
/// history row; the surfaces that are narrower than this truncate again in CSS.
///
/// Distinct from search/buildEntries.ts's `CAPTION_SNIPPET_MAX`, which caps a
/// HAYSTACK rather than a display string — trading recall for row width there
/// would be the wrong trade, so the two numbers are deliberately not shared.
export const TEXT_NAME_MAX = 64;
