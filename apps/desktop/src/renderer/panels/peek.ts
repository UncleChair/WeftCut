// Pure peek-list logic: which hidden-track layers sit near the playhead
// (`buildPeekItems`), what category a layer falls into (`peekCategory`),
// and how the items split into the At-playhead stack vs the Nearby list
// under the AB-mode filter (`splitPeekSections`).
// Kept separate from presentation so it is unit-testable without a DOM.

import type { LayerSummary, TrackSummary } from "../ipc";
import { trackDisplayName } from "../lib/trackName";

/// One row in the peek list. Carries enough state to render the row +
/// drive selection / reveal on click.
export interface PeekItem {
  layer: LayerSummary;
  trackId: string;
  /// The name the track's own header shows (`lib/trackName.ts`), already
  /// resolved — one lane has one name everywhere.
  trackLabel: string;
  trackKind: string;
  /// Position of the layer's track in the *full* project track array —
  /// `Project.tracks` is ordered bottom-of-z-stack first, so a larger index
  /// composites on top. This is the z source for the At-playhead stack.
  trackIndex: number;
  /// Microseconds from playhead to the *layer's nearest edge* —
  /// negative when the layer ended in the past, positive when it
  /// starts in the future, zero when it spans the playhead.
  offsetUs: number;
  /// True when `playhead ∈ [t_start, t_end]` — gets the LIVE badge.
  spansPlayhead: boolean;
}

/// `t` is injected rather than imported so this module stays DOM- and
/// i18n-instance-free; the label it resolves has to be built here because the
/// item order breaks its ties on the track name.
export function buildPeekItems(
  tracks: TrackSummary[],
  currentTimeUs: number,
  deltaUs: number,
  t: (key: string, values: Record<string, unknown>) => string,
): PeekItem[] {
  const lo = currentTimeUs - deltaUs;
  const hi = currentTimeUs + deltaUs;
  const items: PeekItem[] = [];
  for (const [trackIndex, track] of tracks.entries()) {
    if (track.role !== null) continue;
    for (const layer of track.layers) {
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
        trackId: track.id,
        trackLabel: trackDisplayName(track, tracks, t),
        trackKind: track.kind,
        trackIndex,
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

/// Peek filter buckets. Coarser than `layerOverlapClass` (which is
/// visual-vs-audio) because the user wants Text layers split out from
/// picture for fast scanning.
export type PeekCategory = "video" | "audio" | "text";

/// Order of the filter chips.
export const PEEK_CATEGORY_ORDER: PeekCategory[] = ["video", "audio", "text"];

export function peekCategory(layerKind: string): PeekCategory {
  if (layerKind === "Audio") return "audio";
  if (layerKind === "Text") return "text";
  // VideoClip | ImageOverlay | Color | Motif
  return "video";
}

/// The panel's two sections (ADR 0044): the boundary is the playhead,
/// not the category.
export interface PeekSections {
  /// Exactly the window items spanning the playhead — the stack being
  /// composited right now. Visual kinds merged into one list ordered
  /// top-of-stack first (descending track index, the layer-panel
  /// convention); audio rows sink to the tail because audio mixes by
  /// role and z is meaningless for it.
  atPlayhead: PeekItem[];
  /// Everything else in the window, in `buildPeekItems`' proximity
  /// order, untouched.
  nearby: PeekItem[];
}

/// Split already-sorted peek items into the At-playhead / Nearby sections,
/// honoring the active filter — a category chip filters both sections.
/// Each at-playhead visual row necessarily sits on a distinct track
/// (same-class layers on one track cannot overlap in time), so the
/// descending-index sort is total for the rows it orders. Spanning audio
/// keeps its input order at the tail.
export function splitPeekSections(
  items: PeekItem[],
  filter: "all" | PeekCategory,
): PeekSections {
  const visual: PeekItem[] = [];
  const audio: PeekItem[] = [];
  const nearby: PeekItem[] = [];
  for (const item of items) {
    if (filter !== "all" && peekCategory(item.layer.params.kind) !== filter) {
      continue;
    }
    if (!item.spansPlayhead) {
      nearby.push(item);
    } else if (peekCategory(item.layer.params.kind) === "audio") {
      audio.push(item);
    } else {
      visual.push(item);
    }
  }
  visual.sort((a, b) => b.trackIndex - a.trackIndex);
  return { atPlayhead: [...visual, ...audio], nearby };
}
