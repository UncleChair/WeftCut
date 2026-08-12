import type { HistoryStackEntry } from "../ipc";

/// Renderer-side derivation of the History Panel's row model from the raw
/// `ops` array. Pure and locale-free: it decides WHICH rows exist and WHAT
/// each one jumps to; `HistoryPanel` decides how they look and translates
/// `label_key` through `t()`.
///
/// Folding is renderer-side on purpose (spec decision 2): the backend records
/// no transactions, so every agent step stays individually addressable — which
/// is exactly what a human auditing an agent needs. The group is a rendering
/// affordance over a run, never a collapse of it.

/// One line of a group header's aggregate: `Split layer ×2`.
export interface HistoryAggregateItem {
  labelKey: string;
  /// Interpolation values for `labelKey`, taken from the run's FIRST entry
  /// carrying that key. Only the three templated phrases have any, and an
  /// aggregate needs one representative rendering, not N.
  labelArgs?: Record<string, string | number>;
  count: number;
}

export interface HistoryEntryItem {
  kind: "entry";
  /// Absolute index into `ops` — also the `jumpTo` target (click row i →
  /// cursor = i, the state AFTER op i).
  index: number;
  entry: HistoryStackEntry;
}

export interface HistoryGroupItem {
  kind: "group";
  /// Absolute index of the run's first entry.
  startIndex: number;
  /// Absolute index of the run's last entry (inclusive).
  endIndex: number;
  /// The `actor.client` every entry in the run shares.
  client: string;
  entries: HistoryStackEntry[];
  /// Cursor target for a header click: the state BEFORE the run, i.e.
  /// `startIndex - 1`. Null when the run starts at index 0 — eviction does
  /// not spare the `Initial` entry, so after an overflow there may be no
  /// stack index left holding "before this run". A null header is rendered
  /// non-interactive rather than clamped to 0, which would land the cursor
  /// INSIDE the run and quietly do the wrong thing.
  jumpIndex: number | null;
  aggregate: HistoryAggregateItem[];
}

export type HistoryItem = HistoryEntryItem | HistoryGroupItem;

/// Stable identity for a group across refetches. The first entry's `op_id` is
/// minted once at commit time and never rewritten, so an expanded group stays
/// expanded through a `project:changed` refetch.
export function historyGroupId(item: HistoryGroupItem): string {
  return item.entries[0]?.op_id ?? `group-${item.startIndex}`;
}

/// Count a run's `label_key`s, first-appearance order preserved.
export function aggregateLabels(
  entries: readonly HistoryStackEntry[],
): HistoryAggregateItem[] {
  const byKey = new Map<string, HistoryAggregateItem>();
  for (const entry of entries) {
    const existing = byKey.get(entry.label_key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byKey.set(entry.label_key, {
      labelKey: entry.label_key,
      ...(entry.label_args ? { labelArgs: entry.label_args } : {}),
      count: 1,
    });
  }
  return Array.from(byKey.values());
}

/// Fold consecutive same-`actor.client` AGENT entries into groups.
///
/// Three rules, all from spec decision 3:
///   - a run of length 1 does not fold (a group of one is chrome, not signal);
///   - human runs never fold — people have muscle memory for the steps they
///     just took, and PS / Premiere don't fold them either;
///   - two different agent clients back to back are two runs, not one.
export function buildHistoryItems(
  ops: readonly HistoryStackEntry[],
): HistoryItem[] {
  const items: HistoryItem[] = [];
  let i = 0;
  while (i < ops.length) {
    const entry = ops[i]!;
    const actor = entry.actor;
    if (actor.kind !== "Agent") {
      items.push({ kind: "entry", index: i, entry });
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < ops.length) {
      const next = ops[end]!;
      if (next.actor.kind !== "Agent" || next.actor.client !== actor.client) break;
      end += 1;
    }
    if (end - i < 2) {
      items.push({ kind: "entry", index: i, entry });
      i += 1;
      continue;
    }
    const entries = ops.slice(i, end);
    items.push({
      kind: "group",
      startIndex: i,
      endIndex: end - 1,
      client: actor.client,
      entries,
      jumpIndex: i > 0 ? i - 1 : null,
      aggregate: aggregateLabels(entries),
    });
    i = end;
  }
  return items;
}

/// Where a row sits relative to the cursor. `future` is the redo tail: greyed
/// but still clickable (spec decision 6 — the grey IS the warning; the next
/// edit drops those entries silently).
export type HistoryRowState = "past" | "current" | "future";

export function rowState(index: number, cursor: number): HistoryRowState {
  if (index === cursor) return "current";
  return index < cursor ? "past" : "future";
}

/// A group's own state: `current` while the cursor sits anywhere inside the
/// run, so a collapsed group still shows the user where they are.
export function groupState(
  item: HistoryGroupItem,
  cursor: number,
): HistoryRowState {
  if (cursor < item.startIndex) return "future";
  if (cursor > item.endIndex) return "past";
  return "current";
}
