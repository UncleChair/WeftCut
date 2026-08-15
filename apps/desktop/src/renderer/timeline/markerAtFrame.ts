import { displayedFrameStartUs } from "../frames";
import type { MarkerSummary } from "../ipc";

/// The `M` key's same-frame rule, as one pure function: which marker, if any,
/// STARTS in the frame the playhead is displaying? A hit means `M` opens rename
/// for it; a miss means `M` adds.
///
/// Matching is on where a mark BEGINS, so a region merely spanning the playhead
/// does not block a new point marker — "this frame already carries a mark" is a
/// statement about starts, not coverage. Markers arrive sorted by `t_us`, so
/// when several share the frame (a batched agent sweep can), the first is the
/// stable winner.
export function markerStartingInFrame(
  markers: readonly MarkerSummary[],
  playheadUs: number,
  fpsNum: number,
  fpsDen: number,
): MarkerSummary | null {
  const frameStartUs = displayedFrameStartUs(playheadUs, fpsNum, fpsDen);
  for (const marker of markers) {
    if (displayedFrameStartUs(marker.t_us, fpsNum, fpsDen) === frameStartUs) {
      return marker;
    }
  }
  return null;
}
