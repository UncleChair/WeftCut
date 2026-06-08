import type { MotifView } from "../../ipc";
import { canonicalizeProps } from "./Rasterizer";
import { resolveMotifContentDurationUs, type Motif } from "./catalog";
import {
  US_PER_SEC,
  frameTimeSec,
  motifContentFrame,
  motifFrameCacheKey,
} from "./motifFrames";

/// `renderW/renderH/contentDurationUs/srcInUs/contentDurationFrames` are carried
/// for the prewarmer path; the sprite only uses cacheKey/contentFrame/tSec/durationSec/canonicalProps.
export interface MotifFrameDescriptor {
  cacheKey: string;
  contentFrame: number;
  contentDurationFrames: number;
  contentDurationUs: number;
  srcInUs: number;
  renderW: number;
  renderH: number;
  canonicalProps: Record<string, unknown>;
  tSec: number;
  durationSec: number;
}

/// The cache identity + render inputs for one template frame at `tInLayerUs`.
/// Single source of truth shared by the on-demand sprite path and the
/// prewarmer, so they can never disagree on (cacheKey, contentFrame).
/// `durationUs` is the LAYER width (used only for uncapped templates).
/// Returns null when props canonicalization fails.
export function motifFrameDescriptor(
  view: MotifView,
  tInLayerUs: number,
  durationUs: number,
  fpsNum: number,
  fpsDen: number,
  motif: Motif,
): MotifFrameDescriptor | null {
  let canonicalProps: Record<string, unknown>;
  try {
    canonicalProps = canonicalizeProps(view.props, motif.manifest);
  } catch {
    return null;
  }
  const cap = resolveMotifContentDurationUs(motif.manifest, view.props);
  const contentDurationUs = cap ?? durationUs;
  // Windowing (`src_in`) applies ONLY to layer-capped Motifs (`max_duration*`).
  // A `content_duration_s` holdable always plays from content frame 0 (its
  // in-animation, then a clamped/held tail); a wholly-uncapped Motif animates
  // over the layer width from 0. Neither windows.
  const windowed = motif.manifest.content_duration_s == null && cap != null;
  const srcInUs = windowed ? view.src_in_us : 0;
  const { frame, contentDurationFrames } = motifContentFrame(
    tInLayerUs, srcInUs, contentDurationUs, fpsNum, fpsDen,
  );
  const [renderW, renderH] = motif.manifest.size;
  const cacheKey = motifFrameCacheKey({
    motifId: motif.manifest.id,
    version: motif.manifest.version,
    canonicalProps, renderW, renderH, fpsNum, fpsDen,
    durationFrames: contentDurationFrames,
  });
  return {
    cacheKey, contentFrame: frame, contentDurationFrames, contentDurationUs, srcInUs,
    renderW, renderH, canonicalProps,
    tSec: frameTimeSec(frame, fpsNum, fpsDen),
    durationSec: contentDurationUs / US_PER_SEC,
  };
}
