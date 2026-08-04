// Search + grouping for the add-effect picker. Pure functions over a plain
// item list so the ranking is unit-testable without mounting the popup.
//
// The catalog is small enough to rank in one pass — no index, no memo beyond
// the pinyin module's own content-keyed cache.

import fuzzysort from "fuzzysort";
import { pinyinHaystacks } from "../search/pinyin";
import {
  EFFECT_CATEGORY_ORDER,
  type EffectCategory,
} from "../render/effects/effectRegistry";

/// One picker row: a catalog entry with its labels already translated by the
/// caller, so this module never touches i18n.
export interface EffectPickItem {
  kind: string;
  label: string;
  desc: string;
  category: EffectCategory;
  categoryLabel: string;
}

export interface EffectPickGroup {
  category: EffectCategory;
  label: string;
  items: EffectPickItem[];
}

// fuzzysort v3 scores are 0..1; same floor as the global palette's matcher
// (search/matcher.ts) so scatter matches don't pad a short catalog.
const MIN_SCORE = 0.25;
const PREFIX_BOOST = 0.15;

/// Every string a query may match against. The raw `kind` is included so an
/// English query still finds a Chinese-labelled effect (and vice versa), and
/// pinyin full/initials are added for any CJK text — "mohu" and "mh" both
/// reach 模糊.
function haystacksOf(item: EffectPickItem): string[] {
  const out = [item.label, item.kind, item.desc, item.categoryLabel];
  for (const text of [item.label, item.desc, item.categoryLabel]) {
    const py = pinyinHaystacks(text);
    if (py) out.push(py.full, py.initials);
  }
  return out.filter((s) => s !== "");
}

/// Rank the catalog against `query`, best first. An empty query is browse
/// mode: the catalog in registration order, unfiltered.
export function filterEffects(
  query: string,
  items: EffectPickItem[],
): EffectPickItem[] {
  const q = query.trim();
  if (!q) return items;
  const qLower = q.toLowerCase();
  const scored: Array<{ item: EffectPickItem; score: number }> = [];
  for (const item of items) {
    let best = -1;
    for (const hay of haystacksOf(item)) {
      const r = fuzzysort.single(q, hay);
      if (r && r.score > best) best = r.score;
    }
    if (best < MIN_SCORE) continue;
    const boost = item.label.toLowerCase().startsWith(qLower) ? PREFIX_BOOST : 0;
    scored.push({ item, score: best + boost });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/// Bucket already-ranked items under their category headers, in
/// EFFECT_CATEGORY_ORDER. Empty groups are dropped, so a filtered list only
/// shows the headers it still has rows for. Relevance order is preserved
/// *within* a group; the group sequence stays fixed so the popup doesn't
/// reshuffle its headers on every keystroke.
export function groupEffects(items: EffectPickItem[]): EffectPickGroup[] {
  const groups: EffectPickGroup[] = [];
  for (const category of EFFECT_CATEGORY_ORDER) {
    const rows = items.filter((i) => i.category === category);
    if (rows.length > 0) {
      groups.push({ category, label: rows[0]!.categoryLabel, items: rows });
    }
  }
  return groups;
}
