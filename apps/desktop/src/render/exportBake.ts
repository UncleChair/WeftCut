// Main-thread template pre-rasterization for export.
//
// The export Worker has no DOM, so the SVG capture harness (`TemplateHarness`
// → sandboxed iframe → serialized `<svg>`) can't run there. Instead, the MAIN
// thread bakes EVERY frame of each Template layer in the export range to an
// `ImageBitmap[]` (indexed by composition-frame), and the bitmaps are
// TRANSFERRED into the Worker, where `TemplateSprite` binds them by index
// synchronously (no harness).
//
// The bake runs on the COMPOSITION fps grid — the same grid the Worker's
// Compositor uses when it constructs each `TemplateSprite` (from
// `summary.composition.fps_num/den`). The export OUTPUT fps may differ
// (resolution/fps dialog), but the Worker maps each output-frame time back to a
// composition-frame index via `frameIndexInLayer(..., compFps)` inside
// `TemplateSprite.update`, so the bake MUST be keyed on comp fps or the indices
// diverge (out-of-range / duplicated frames). See `exportWorker.ts` →
// `compositor.setProject` (which sets the Compositor's fps from the comp) and
// `Compositor.ensureTemplate` (which passes that fps into `TemplateSprite`).
//
// CACHE HYGIENE: this bake renders FRESH bitmaps via its own per-layer
// `TemplateHarness` and never reads/writes `sharedTemplateFrameCache`. The
// resulting bitmaps are transferred to the Worker, and transfer NEUTERS the
// source ImageBitmap — pulling from the preview's shared cache would neuter
// preview's cached frames and break the live preview after any export.

import { frameIndexInLayer, snapFrameFloor } from "../frames";
import type { ProjectSummary, TemplateView } from "../ipc";
import { getTemplate, resolveTemplateContentDurationUs, type Template } from "./templates/catalog";
import { TemplateHarness } from "./templates/harness";
import { canonicalizeProps } from "./templates/Rasterizer";
import { rasterizeSvg } from "./templates/svgRaster";
import {
  frameTimeSec,
  templateDurationFrames,
} from "./sprite/TemplateSprite";

const US_PER_SEC = 1_000_000;

/// Compute the content frame to bake into layer-local slot `layerLocalFrame`,
/// mirroring the preview path (`templateContentFrame` in `TemplateSprite.ts`)
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
/// `TemplateView`, and the comp-fps frame range to raster. `durationFrames` is
/// the layer's full animated length on the comp grid (NOT clamped to the export
/// range) so the per-frame index math matches `TemplateSprite.update` exactly —
/// a partial export range only narrows WHICH of those frames we actually bake.
export interface TemplateBakeSpec {
  layerId: string;
  template: Template;
  view: TemplateView;
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
      if (layer.params.kind !== "Template") continue;
      // Overlap test against the half-open export range. `t_end_us` is the
      // exclusive boundary, so a layer ending exactly at `startUs` doesn't
      // overlap.
      if (layer.t_end_us <= startUs) continue;
      if (layer.t_start_us >= endUs) continue;

      const view = layer.params;
      const template = getTemplate(view.template_id);
      if (!template) {
        // eslint-disable-next-line no-console
        console.warn(
          `[weftcut/export] bake: unknown template "${view.template_id}" ` +
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

/// Bake every Template layer overlapping `[startUs, endUs)` to a per-layer
/// `ImageBitmap[]` indexed by COMPOSITION-frame index. The array is sparse only
/// at the head when the export range starts mid-layer: indices `[0, firstFrame)`
/// are left `undefined` (the Worker never requests them — they're outside the
/// range), so the array's `length` is `lastFrame + 1` and `frames[idx]` is the
/// raster for comp-frame `idx`. The Worker binds `frames[clamp(idx)]`.
///
/// MUST run on the MAIN thread (needs `document` for the harness iframe +
/// `createImageBitmap`). `fpsNum/fpsDen` are the COMPOSITION fps. Renders fresh
/// bitmaps via per-layer harnesses (NOT the shared preview cache — see the
/// module header), disposing each harness when done.
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
    const harness = new TemplateHarness();
    try {
      await harness.load(spec.template);

      // Canonicalize props once per layer — the value is identical across the
      // layer's frames (only `tSec` varies), matching `TemplateSprite.update`
      // which canonicalizes per tick against the same manifest.
      const canonical = canonicalizeProps(spec.view.props, spec.template.manifest);
      // Content-window model: bake the INTRINSIC content. `durationSec` is the
      // content duration (the harness `dur` argument), NOT the layer width
      // (`spec.durationUs`). Uncapped templates fall back to layer-width content
      // with src_in=0 (legacy).
      const cap = resolveTemplateContentDurationUs(spec.template.manifest, spec.view.props);
      const contentDurationUs = cap ?? spec.durationUs;
      const srcInUs = cap == null ? 0 : spec.view.src_in_us;
      const durationSec = contentDurationUs / US_PER_SEC;

      // Allocate the full array up to `lastFrame`; leave `[0, firstFrame)`
      // holes for a mid-layer export start. Bitmaps land at their comp-frame
      // index so the Worker's `frames[frameIndexInLayer(...)]` is a direct hit.
      const frames: ImageBitmap[] = new Array(spec.lastFrame + 1);
      for (let frame = spec.firstFrame; frame <= spec.lastFrame; frame++) {
        // mirrors the preview path: reconstruct tInLayerUs for this
        // layer-local slot on the comp grid, then single-floor with srcInUs.
        const contentFrame = bakeContentFrameFor(
          frame,
          spec.tStartUs,
          srcInUs,
          contentDurationUs,
          fpsNum,
          fpsDen,
        );
        const tSec = frameTimeSec(contentFrame, fpsNum, fpsDen);
        // eslint-disable-next-line no-await-in-loop
        const svg = await harness.renderFrameSvg(tSec, durationSec, canonical);
        // eslint-disable-next-line no-await-in-loop
        const bitmap = await rasterizeSvg(svg);
        frames[frame] = bitmap;
        baked++;
        onProgress?.(baked, total);
      }
      result[spec.layerId] = frames;
    } finally {
      harness.dispose();
    }
  }

  return result;
}
