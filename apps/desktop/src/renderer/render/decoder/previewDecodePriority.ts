import type { LayerSummary, ProjectSummary } from "../../ipc";
import { swapKeys } from "../swapKeys";

export interface PreviewDecodePriorityPlan {
  /// Actual preview pool keys protected from capacity reclamation. Both base
  /// and overlap-swap keys are included because either may own the clip's live
  /// hardware session while a resolver-key swap is in flight or completed.
  poolKeys: string[];
  /// Nearest future VideoClip boundary inside the lookahead window.
  nextStartUs: number | null;
  /// Every enabled clip starting at that same nearest boundary.
  upcomingLayers: LayerSummary[];
}

/// Plan native decode ownership for one composition time. Active clips and all
/// clips at the nearest upcoming boundary are peers; older retained clips and
/// later boundaries are deliberately absent so the pool may reclaim them only
/// after main reports real admission pressure.
export function planPreviewDecodePriority(
  summary: ProjectSummary,
  tUs: number,
  windowUs: number,
): PreviewDecodePriorityPlan {
  const active: LayerSummary[] = [];
  let nextStartUs: number | null = null;
  let upcomingLayers: LayerSummary[] = [];
  const horizonEndUs = tUs + windowUs;

  for (const track of summary.tracks) {
    if (!track.enabled) continue;
    for (const layer of track.layers) {
      if (!layer.enabled || layer.params.kind !== "VideoClip") continue;
      if (layer.t_start_us <= tUs && tUs < layer.t_end_us) {
        active.push(layer);
        continue;
      }
      if (layer.t_start_us <= tUs || layer.t_start_us > horizonEndUs) continue;
      if (nextStartUs === null || layer.t_start_us < nextStartUs) {
        nextStartUs = layer.t_start_us;
        upcomingLayers = [layer];
      } else if (layer.t_start_us === nextStartUs) {
        upcomingLayers.push(layer);
      }
    }
  }

  const poolKeys: string[] = [];
  const seen = new Set<string>();
  for (const layer of [...active, ...upcomingLayers]) {
    if (layer.params.kind !== "VideoClip") continue;
    const keys = [
      layer.id,
      swapKeys(layer.id, layer.params.media_id).swapLayerId,
    ];
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      poolKeys.push(key);
    }
  }

  return { poolKeys, nextStartUs, upcomingLayers };
}
