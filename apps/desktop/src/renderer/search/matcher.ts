import fuzzysort from "fuzzysort";
import type { SearchEntry, SearchEntryType } from "./types";

export interface RankedResult {
  entry: SearchEntry;
  score: number;
  /// Char indexes into entry.label to emphasize. Empty when the best
  /// match came from a pinyin/extra haystack — those indexes don't map
  /// 1:1 onto the label's CJK chars, so we skip char highlighting.
  highlight: number[];
}

/// Display + iteration order for result groups.
export const GROUP_ORDER: SearchEntryType[] = [
  "command",
  "media",
  "track",
  "clip",
  "caption",
  "marker",
];

// fuzzysort v3 scores are 0..1. Floor keeps low-quality scatter matches
// (single chars spread across a long caption) out of the list.
const MIN_SCORE = 0.25;
const COMMAND_BOOST = 0.1;
const PREFIX_BOOST = 0.15;

export function rankEntries(
  query: string,
  entries: SearchEntry[],
  limitPerGroup = 5,
): Map<SearchEntryType, RankedResult[]> {
  const grouped = new Map<SearchEntryType, RankedResult[]>();
  const q = query.trim();
  if (!q) {
    // Browse mode: no query yet — list commands in registration order.
    // Floor the browse-mode cap at 8 (independent of limitPerGroup): an
    // empty palette should still list a useful batch of commands even for
    // callers configured with a small per-group display cap. The UI layer
    // does its own display slicing on top of this, so a larger list here
    // doesn't force a larger render.
    const rows = entries
      .filter((e) => e.type === "command")
      .slice(0, Math.max(limitPerGroup, 8))
      .map((entry) => ({ entry, score: 0, highlight: [] as number[] }));
    if (rows.length > 0) grouped.set("command", rows);
    return grouped;
  }

  const scored: RankedResult[] = [];
  for (const entry of entries) {
    let bestScore = -1;
    let bestHighlight: number[] = [];
    for (let i = 0; i < entry.haystacks.length; i++) {
      const r = fuzzysort.single(q, entry.haystacks[i]!);
      if (!r || r.score <= bestScore) continue;
      bestScore = r.score;
      bestHighlight = i === 0 ? Array.from(r.indexes) : [];
    }
    if (bestScore < MIN_SCORE) continue;
    let score = bestScore;
    if (entry.type === "command") score += COMMAND_BOOST;
    if (entry.label.toLowerCase().startsWith(q.toLowerCase())) score += PREFIX_BOOST;
    scored.push({ entry, score, highlight: bestHighlight });
  }
  scored.sort((a, b) => b.score - a.score);

  for (const type of GROUP_ORDER) {
    const rows = scored.filter((r) => r.entry.type === type).slice(0, limitPerGroup);
    if (rows.length > 0) grouped.set(type, rows);
  }
  return grouped;
}
