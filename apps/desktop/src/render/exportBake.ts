// Main-thread Motif pre-capture for export.
//
// The export Worker has no DOM and no Tauri `invoke`, so it can't capture
// Motif frames itself. Instead the MAIN thread captures EVERY frame of each
// Motif layer in the export range to an `ImageBitmap[]` (indexed by
// composition-frame) via the SAME CDP path the preview uses (`bakeMotifFrame`
// → `captureMotifFrame` → the hidden Motif host), and the bitmaps are
// TRANSFERRED into the Worker, where `MotifSprite` binds them by index
// synchronously. Export pixels are therefore identical to preview (one
// producer) and carry the Motif's transparent backdrop.
//
// The bake runs on the COMPOSITION fps grid — the same grid the Worker's
// Compositor uses when it constructs each `MotifSprite`. The export OUTPUT fps
// may differ; the Worker maps each output-frame time back to a composition
// frame index via `frameIndexInLayer(..., compFps)`, so the bake MUST be keyed
// on comp fps or the indices diverge.
//
// CACHE HYGIENE: this bake produces FRESH bitmaps (a CDP capture) and never
// reads the in-RAM `sharedTemplateFrameCache` (L0). Transfer NEUTERS the source
// ImageBitmap; pulling L0 bitmaps would neuter preview's cached frames and
// break live preview after an export.

import { frameIndexInLayer, snapFrameFloor } from "../frames";
import type { ProjectSummary, MotifView } from "../ipc";
import { getTemplate, resolveTemplateContentDurationUs, type Template } from "./templates/catalog";
import { canonicalizeProps } from "./templates/Rasterizer";
import { bakeMotifFrame } from "./motifs/motifRaster";
import { templateDurationFrames } from "./templates/templateFrames";

const US_PER_SEC = 1_000_000;

/// Compute the content frame to bake into layer-local slot `layerLocalFrame`,
/// mirroring the preview path (`templateContentFrame` in `templateFrames.ts`)
/// EXACTLY. The key invariant: a composition frame at index `layerStartFrame +
/// layerLocalFrame` arrives at the compositor as
/// `tInLayerUs = snapFrameFloor(compFrameUs) - tStartUs`, and the preview
/// selects `frameIndexInLayer(srcInUs + tInLayerUs)`. This function reconstructs
/// that same `tInLayerUs` from the layer-local frame index so both paths always
/// agree, including when fractional parts of `srcInUs` and `tInLayerUs` would
/// cause floor(a) + floor(b) ≠ floor(a+b).
///
/// `layerStartFrame` = frameIndexInLayer(tStartUs, fpsNum, fpsDen) — the caller
/// computes it ONCE and passes it rather than recomputing per frame.
///
/// Exported so the parity unit-test can import and validate it directly.
export function bakeContentFrameFor(
  layerLocalFrame: number,
  tStartUs: number,
  srcInUs: number,
  contentDurationUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  const contentDurationFrames = Math.max(
    1,
    Math.round((contentDurationUs * fpsNum) / (US_PER_SEC * fpsDen)),
  );
  // Reconstruct the absolute comp-frame index for this layer-local slot.
  const layerStartFrame = frameIndexInLayer(tStartUs, fpsNum, fpsDen);
  const absFrame = layerStartFrame + layerLocalFrame;
  // Reconstruct the comp-grid µs for that absolute frame — same as the
  // compositor's `snapFrameFloor(playheadUs)` for a playhead sitting exactly
  // on a frame boundary.  absFrame is always an integer, so
  //   Math.round(absFrame * US_PER_SEC * fpsDen / fpsNum)
  // is the exact half-up grid value (matches snapFrameFloor on-grid).
  const compFrameUs = Math.round((absFrame * US_PER_SEC * fpsDen) / fpsNum);
  const tInLayerUs = compFrameUs - tStartUs;
  // Single summed floor — mirrors templateContentFrame exactly.
  const contentTimeUs = srcInUs + Math.max(0, tInLayerUs);
  const contentFrame = Math.min(
    contentDurationFrames - 1,
    frameIndexInLayer(contentTimeUs, fpsNum, fpsDen),
  );
  return contentFrame;
}

/// One Template layer to bake: its id, the resolved `Template`, the layer's
/// `MotifView`, and the comp-fps frame range to raster. `durationFrames` is
/// the layer's full animated length on the comp grid (NOT clamped to the export
/// range) so the per-frame index math matches `TemplateSprite.update` exactly —
/// a partial export range only narrows WHICH of those frames we actually bake.
export interface TemplateBakeSpec {
  layerId: string;
  template: Template;
  view: MotifView;
  /// Layer duration in microseconds (`t_end_us - t_start_us`).
  durationUs: number;
  /// Total animated frames on the comp grid (`templateDurationFrames`).
  durationFrames: number;
  /// First/last comp-frame index (inclusive) overlapping the export range.
  /// Clamped to `[0, durationFrames - 1]`.
  firstFrame: number;
  lastFrame: number;
  /// Layer start time in microseconds on the composition timeline (`t_start_us`).
  /// Required to reconstruct `tInLayerUs` the same way the compositor does for
  /// each layer-local frame, so the bake's content-frame selection mirrors the
  /// preview path exactly (see `bakeContentFrameFor`).
  tStartUs: number;
}

/// Collect the Template layers (enabled, on an enabled track) whose interval
/// overlaps `[startUs, endUs)`, resolving each to a `TemplateBakeSpec`. Pure +
/// Node-testable: no DOM, no rasterize. Layers whose `template_id` isn't in the
/// catalog are skipped (they can't render anywhere — the live compositor warns
/// too). `fpsNum/fpsDen` are the COMPOSITION fps.
export function templateLayersToBake(
  summary: ProjectSummary,
  startUs: number,
  endUs: number,
  fpsNum: number,
  fpsDen: number,
): TemplateBakeSpec[] {
  const out: TemplateBakeSpec[] = [];
  for (const track of summary.tracks) {
    if (!track.enabled) continue;
    for (const layer of track.layers) {
      if (!layer.enabled) continue;
      if (layer.params.kind !== "Motif") continue;
      // Overlap test against the half-open export range. `t_end_us` is the
      // exclusive boundary, so a layer ending exactly at `startUs` doesn't
      // overlap.
      if (layer.t_end_us <= startUs) continue;
      if (layer.t_start_us >= endUs) continue;

      const view = layer.params;
      const template = getTemplate(view.motif_id);
      if (!template) {
        // eslint-disable-next-line no-console
        console.warn(
          `[weftcut/export] bake: unknown template "${view.motif_id}" ` +
            `(layer ${layer.id}) — skipping`,
        );
        continue;
      }

      const durationUs = layer.t_end_us - layer.t_start_us;
      const durationFrames = templateDurationFrames(durationUs, fpsNum, fpsDen);

      // Comp-frame indices of the export-range overlap, expressed layer-local
      // (templates have no source-in offset, so layer-local time = comp time −
      // t_start_us). Mirrors `TemplateSprite.update`'s
      // `frameIndexInLayer(tInLayerUs, ...)` + the `min(durationFrames - 1, …)`
      // clamp. We bake only the frames the export can reach; a frame the
      // playhead never visits would be wasted raster work.
      const overlapStartUs = Math.max(layer.t_start_us, startUs);
      // The last instant the layer is visible inside the range is the smaller
      // of the layer's last displayable µs and the range's. `endUs` is
      // exclusive, so subtract 1 µs before mapping to a frame index.
      const overlapEndUs = Math.min(layer.t_end_us, endUs) - 1;
      // Snap both bounds to the composition-frame grid BEFORE computing the
      // frame index. The export Worker's Compositor snaps `tUs` via
      // `snapFrameFloor` in `compositeFrame` before passing `tUsSnapped -
      // t_start_us` to `TemplateSprite.update` → `frameIndexInLayer`. When
      // `startUs` is not on the grid (e.g. the playhead was set to a raw time
      // via "set range to playhead"), the raw `overlapStartUs` maps to a
      // higher frame index than the snapped value, so `injectedFrames[0]`
      // would be `undefined` and the leading exported frame would show a blank.
      const firstFrame = Math.min(
        durationFrames - 1,
        frameIndexInLayer(snapFrameFloor(overlapStartUs, fpsNum, fpsDen) - layer.t_start_us, fpsNum, fpsDen),
      );
      const lastFrame = Math.min(
        durationFrames - 1,
        frameIndexInLayer(snapFrameFloor(overlapEndUs, fpsNum, fpsDen) - layer.t_start_us, fpsNum, fpsDen),
      );

      out.push({
        layerId: layer.id,
        template,
        view,
        durationUs,
        durationFrames,
        firstFrame,
        lastFrame,
        tStartUs: layer.t_start_us,
      });
    }
  }
  return out;
}

/// Progress callback: `(baked, total)` cumulative frames across all layers.
export type BakeProgress = (baked: number, total: number) => void;

/// Bake every Motif layer overlapping `[startUs, endUs)` to a per-layer
/// `ImageBitmap[]` indexed by COMPOSITION-frame index. The array is sparse only
/// at the head when the export range starts mid-layer: indices `[0, firstFrame)`
/// are left `undefined` (the Worker never requests them — they're outside the
/// range), so the array's `length` is `lastFrame + 1` and `frames[idx]` is the
/// capture for comp-frame `idx`. The Worker binds `frames[clamp(idx)]`.
///
/// MUST run on the MAIN thread (Tauri `invoke` / CDP is not available in the
/// Worker). `fpsNum/fpsDen` are the COMPOSITION fps. Captures fresh bitmaps via
/// the CDP path (NOT the shared preview cache — see the module header).
export async function exportBakeTemplates(
  summary: ProjectSummary,
  startUs: number,
  endUs: number,
  fpsNum: number,
  fpsDen: number,
  onProgress?: BakeProgress,
): Promise<Record<string, ImageBitmap[]>> {
  const specs = templateLayersToBake(summary, startUs, endUs, fpsNum, fpsDen);
  const result: Record<string, ImageBitmap[]> = {};
  if (specs.length === 0) return result;

  const total = specs.reduce(
    (acc, s) => acc + (s.lastFrame - s.firstFrame + 1),
    0,
  );
  let baked = 0;
  onProgress?.(0, total);

  for (const spec of specs) {
    // Canonicalize props once per layer (identical across the layer's frames;
    // only the content frame varies). Mirrors the preview path's per-tick
    // canonicalize against the same manifest, so export pixels == preview.
    const canonical = canonicalizeProps(spec.view.props, spec.template.manifest);
    // Content-window model: src_in offset + intrinsic content duration. Uncapped
    // templates fall back to layer-width content with src_in=0 (legacy).
    const cap = resolveTemplateContentDurationUs(spec.template.manifest, spec.view.props);
    const contentDurationUs = cap ?? spec.durationUs;
    const srcInUs = cap == null ? 0 : spec.view.src_in_us;

    // Allocate up to lastFrame; leave [0, firstFrame) holes for a mid-layer
    // export start. Bitmaps land at their comp-frame index so the Worker's
    // frames[frameIndexInLayer(...)] is a direct hit.
    const frames: ImageBitmap[] = new Array(spec.lastFrame + 1);
    for (let frame = spec.firstFrame; frame <= spec.lastFrame; frame++) {
      const contentFrame = bakeContentFrameFor(
        frame,
        spec.tStartUs,
        srcInUs,
        contentDurationUs,
        fpsNum,
        fpsDen,
      );
      // CDP capture of the hidden Motif host — the SAME producer the preview
      // prewarmer/baker use (manifest size + manifest settle_rafs), so the
      // exported bitmap is pixel-identical to preview AND carries the Motif's
      // transparent backdrop. tSec is derived inside bakeMotifFrame as
      // contentFrame*fpsDen/fpsNum (== the old frameTimeSec(contentFrame)).
      // eslint-disable-next-line no-await-in-loop
      const bitmap = await bakeMotifFrame(spec.template, contentFrame, fpsNum, fpsDen, canonical);
      frames[frame] = bitmap;
      baked++;
      onProgress?.(baked, total);
    }
    result[spec.layerId] = frames;
  }

  return result;
}
