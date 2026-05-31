// The single source of truth for "which VideoClip layers does export decode?"
// Both the export Worker's decode loop (exportWorker.ts `activeVideoClips`)
// and the export-readiness gate (exportReadiness.ts) select from this. They
// MUST stay in lockstep: if the gate selects a different set than the Worker
// decodes, an undecodable source either reaches the Worker un-gated (the scary
// failure returns) or the export hangs on a proxy it never needed.

import type { ProjectSummary } from "../ipc";

export interface ActiveVideoLayer {
  layerId: string;
  mediaId: string;
  tStartUs: number;
  tEndUs: number;
  srcInUs: number;
}

/// Every enabled VideoClip layer on an enabled track whose interval overlaps
/// [aUs, bUs] (bUs INCLUSIVE — matches the Worker's per-chunk call, which
/// passes `chunkEndUs` as an inclusive PTS). Audio/Image/Text/etc. are not
/// WebCodecs-video-decoded and are excluded.
export function selectActiveVideoLayers(
  summary: ProjectSummary,
  aUs: number,
  bUs: number,
): ActiveVideoLayer[] {
  const out: ActiveVideoLayer[] = [];
  for (const track of summary.tracks) {
    if (!track.enabled) continue;
    for (const layer of track.layers) {
      if (!layer.enabled) continue;
      if (layer.params.kind !== "VideoClip") continue;
      if (layer.t_end_us <= aUs) continue;
      if (layer.t_start_us > bUs) continue;
      out.push({
        layerId: layer.id,
        mediaId: layer.params.media_id,
        tStartUs: layer.t_start_us,
        tEndUs: layer.t_end_us,
        srcInUs: layer.params.src_in_us,
      });
    }
  }
  return out;
}

/// Distinct video media ids the export of [startUs, endUs) will decode.
/// `endUs` is the half-open range end; pass `endUs - 1` to the inclusive
/// selector so the boundary matches the Worker's chunk math exactly.
export function referencedVideoMediaIds(
  summary: ProjectSummary,
  startUs: number,
  endUs: number,
): Set<string> {
  return new Set(
    selectActiveVideoLayers(summary, startUs, endUs - 1).map((l) => l.mediaId),
  );
}
