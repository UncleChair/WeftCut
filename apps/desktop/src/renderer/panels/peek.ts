// Pure peek-list logic: which hidden-track layers sit near the playhead
// (`buildPeekItems`), what category a layer falls into (`peekCategory`),
// and how the items group under the AB-mode filter (`groupPeekItems`).
// Kept out of RightPanel.tsx so it is unit-testable without a DOM.

import type { LayerSummary, TrackSummary } from "../ipc";

/// One row in the peek list. Carries enough state to render the row +
/// drive selection / reveal on click.
export interface PeekItem {
  layer: LayerSummary;
  trackId: string;
  trackLabel: string;
  trackKind: string;
  /// Microseconds from playhead to the *layer's nearest edge* —
  /// negative when the layer ended in the past, positive when it
  /// starts in the future, zero when it spans the playhead.
  offsetUs: number;
  /// True when `playhead ∈ [t_start, t_end]` — gets the LIVE badge.
  spansPlayhead: boolean;
}

export function buildPeekItems(
  tracks: TrackSummary[],
  currentTimeUs: number,
  deltaUs: number,
): PeekItem[] {
  const lo = currentTimeUs - deltaUs;
  const hi = currentTimeUs + deltaUs;
  const items: PeekItem[] = [];
  for (const t of tracks) {
    if (t.role !== null) continue;
    for (const layer of t.layers) {
      // Window intersection: layer.t_end > lo AND layer.t_start < hi.
      if (layer.t_end_us <= lo || layer.t_start_us >= hi) continue;
      const spans =
        layer.t_start_us <= currentTimeUs && layer.t_end_us >= currentTimeUs;
      const offset = spans
        ? 0
        : layer.t_start_us > currentTimeUs
          ? layer.t_start_us - currentTimeUs
          : layer.t_end_us - currentTimeUs;
      items.push({
        layer,
        trackId: t.id,
        trackLabel: t.label ?? t.kind,
        trackKind: t.kind,
        offsetUs: offset,
        spansPlayhead: spans,
      });
    }
  }
  // Order: spanning items first (LIVE bubble), then chronologically by
  // t_start. Equal t_start ties break by track label (stable enough).
  items.sort((a, b) => {
    if (a.spansPlayhead !== b.spansPlayhead) {
      return a.spansPlayhead ? -1 : 1;
    }
    if (a.layer.t_start_us !== b.layer.t_start_us) {
      return a.layer.t_start_us - b.layer.t_start_us;
    }
    return a.trackLabel.localeCompare(b.trackLabel);
  });
  return items;
}

/// Peek filter / section buckets. Coarser than `layerOverlapClass`
/// (which is visual-vs-audio) because the user wants Text/Subtitles
/// split out from picture for fast scanning.
export type PeekCategory = "video" | "audio" | "text";

/// Render + filter order of the category sections.
export const PEEK_CATEGORY_ORDER: PeekCategory[] = ["video", "audio", "text"];

export function peekCategory(layerKind: string): PeekCategory {
  if (layerKind === "Audio") return "audio";
  if (layerKind === "Text" || layerKind === "Subtitles") return "text";
  // VideoClip | ImageOverlay | Color | Motif
  return "video";
}

export interface PeekSection {
  category: PeekCategory;
  items: PeekItem[];
}

/// Group already-sorted peek items into category sections, honoring the
/// active filter. `filter === "all"` returns every non-empty section in
/// `PEEK_CATEGORY_ORDER`; a specific filter returns just that one
/// section (empty array if it has no items). Item order within a
/// section is preserved from `buildPeekItems`.
export function groupPeekItems(
  items: PeekItem[],
  filter: "all" | PeekCategory,
): PeekSection[] {
  const sections: PeekSection[] = [];
  for (const category of PEEK_CATEGORY_ORDER) {
    if (filter !== "all" && filter !== category) continue;
    const catItems = items.filter(
      (it) => peekCategory(it.layer.params.kind) === category,
    );
    if (catItems.length > 0) sections.push({ category, items: catItems });
  }
  return sections;
}
