// Pure frame-math helpers for motif rendering. Extracted from
// MotifSprite.ts so motifFrameDescriptor.ts (and the prewarmer) can
// import them without creating a circular dependency:
//   motifFrameDescriptor → MotifSprite → motifFrameDescriptor
//
// This module is deliberately low-dependency: only the pure frame-grid helper
// from `../../frames`. No Pixi, no DOM, no catalog — Node-testable.

import { frameIndexInLayer } from "../../frames";

export const US_PER_SEC = 1_000_000;

/// Total animated frames a motif spans over `durationUs` on the comp-fps
/// grid, clamped to at least 1 (a zero/sub-frame placement still shows frame
/// 0). Exact-rational (no pre-rounded frame duration) to match the rest of
/// the renderer's frame math. Exported for unit testing.
export function motifDurationFrames(
  durationUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  if (fpsNum <= 0 || fpsDen <= 0) return 1;
  return Math.max(1, Math.round((durationUs * fpsNum) / (US_PER_SEC * fpsDen)));
}

/// Exact-rational seconds at the start of comp frame `frame`. The harness
/// renders `render(tSec)` at this time. Exported for unit testing.
export function frameTimeSec(frame: number, fpsNum: number, fpsDen: number): number {
  if (fpsNum <= 0) return 0;
  return (frame * fpsDen) / fpsNum;
}

/// Compute the content-frame selection for the preview path. `contentDurationUs`
/// is the resolved intrinsic content duration (or the layer width for uncapped
/// motifs); `srcInUs` is the window offset (0 for uncapped). Returns the
/// absolute content frame to render and the total content-duration frame count
/// (for the cache key). Exported for unit testing.
export function motifContentFrame(
  tInLayerUs: number,
  srcInUs: number,
  contentDurationUs: number,
  fpsNum: number,
  fpsDen: number,
): { frame: number; contentDurationFrames: number } {
  const contentDurationFrames = motifDurationFrames(contentDurationUs, fpsNum, fpsDen);
  const contentTimeUs = srcInUs + Math.max(0, tInLayerUs);
  const frame = Math.min(
    contentDurationFrames - 1,
    frameIndexInLayer(contentTimeUs, fpsNum, fpsDen),
  );
  return { frame, contentDurationFrames };
}

export interface MotifFrameCacheKeyInput {
  motifId: string;
  version: number;
  canonicalProps: Record<string, unknown>;
  renderW: number;
  renderH: number;
  fpsNum: number;
  fpsDen: number;
  durationFrames: number;
}

/// Stable opaque key for `MotifFrameCache`. The cache appends `#<frame>`;
/// callers must not. `canonicalProps` is already in stable key order
/// (`canonicalizeProps` or `canonicalizePropsLenient`), so its JSON is deterministic. Exported for unit
/// testing.
export function motifFrameCacheKey(input: MotifFrameCacheKeyInput): string {
  return [
    input.motifId,
    String(input.version),
    String(input.renderW),
    String(input.renderH),
    String(input.fpsNum),
    String(input.fpsDen),
    String(input.durationFrames),
    JSON.stringify(input.canonicalProps),
  ].join("|");
}
