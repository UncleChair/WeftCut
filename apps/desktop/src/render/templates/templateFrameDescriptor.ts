import type { MotifView } from "../../ipc";
import { canonicalizeProps } from "./Rasterizer";
import { resolveTemplateContentDurationUs, type Template } from "./catalog";
import {
  US_PER_SEC,
  frameTimeSec,
  templateContentFrame,
  templateFrameCacheKey,
} from "./templateFrames";

/// `renderW/renderH/contentDurationUs/srcInUs/contentDurationFrames` are carried
/// for the prewarmer path; the sprite only uses cacheKey/contentFrame/tSec/durationSec/canonicalProps.
export interface TemplateFrameDescriptor {
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
export function templateFrameDescriptor(
  view: MotifView,
  tInLayerUs: number,
  durationUs: number,
  fpsNum: number,
  fpsDen: number,
  template: Template,
): TemplateFrameDescriptor | null {
  let canonicalProps: Record<string, unknown>;
  try {
    canonicalProps = canonicalizeProps(view.props, template.manifest);
  } catch {
    return null;
  }
  const cap = resolveTemplateContentDurationUs(template.manifest, view.props);
  const contentDurationUs = cap ?? durationUs;
  const srcInUs = cap == null ? 0 : view.src_in_us;
  const { frame, contentDurationFrames } = templateContentFrame(
    tInLayerUs, srcInUs, contentDurationUs, fpsNum, fpsDen,
  );
  const [renderW, renderH] = template.manifest.size;
  const cacheKey = templateFrameCacheKey({
    templateId: template.manifest.id,
    version: template.manifest.version,
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
