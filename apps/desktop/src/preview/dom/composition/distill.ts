/// Distills the live `ProjectStore` state for one `Html`-mode group
/// into the engine-facing `CompositionState` shape. Run by
/// `HtmlGroupHandle` on first mount and whenever a structural change
/// invalidates the prior state hash.
///
/// **Decision context** (`docs/html-render-groups.md`):
///   - Decision 7: audio members bypass the composition (caller filters
///     them out before passing here).
///   - Decision 10: in-place flatten — composition canvas inherits the
///     project canvas; each member's coords are unchanged relative to
///     the canvas.
///   - Composition-local time: each member's `t_start/t_end` is shifted
///     by `−groupTStartUs` so the engine's `__setTime(t)` is in the
///     local frame of the composition. The handle does the
///     `masterUs → localSec` conversion at tick time using
///     `groupTStartUs` returned alongside the state.
///
/// H.4 supports Color / Text / VideoClip / ImageOverlay members.
/// Template + Subtitles members are skipped with a `console.warn` —
/// the composition generator + engine don't support them yet
/// (H.3 follow-up). The skip is silent at the validator level
/// because validation operates on effect kinds, not layer kinds; the
/// runtime drop is the v1 limitation.

import type {
  AnimTrack,
  GroupSummary,
  LayerSummary,
  MediaSummary,
} from "../../../ipc";
import type {
  CompositionLayer,
  CompositionLayerParams,
  CompositionState,
  CompositionTransform,
} from "./engine";

export interface DistillResult {
  /// The state to feed to `buildComposition()`.
  state: CompositionState;
  /// Offset from main-timeline microseconds to composition-local
  /// microseconds: `localUs = masterUs − groupTStartUs`. Handles use
  /// this to map the engine's master clock into the composition's
  /// time space before calling `__setTime(localSec)`.
  groupTStartUs: number;
  /// Set of layer ids whose kind isn't supported by the H.4
  /// composition path (Template / Subtitles for now). Caller may
  /// surface a "limitation" badge.
  skipped: { layerId: string; kind: string; reason: string }[];
  /// `media_id → media` lookup distilled for the resolver. Avoids the
  /// resolver having to reach back into the projectStore for every
  /// `applyAt` call.
  mediaByLayer: Map<string, MediaSummary>;
}

export interface DistillInputs {
  group: GroupSummary;
  layerById: ReadonlyMap<string, LayerSummary>;
  mediaById: ReadonlyMap<string, MediaSummary>;
  /// Lower index = lower z (renders deeper). Computed by the caller
  /// from `summary.tracks` order to keep the distiller decoupled from
  /// the projectStore.
  trackIndexByLayerId: ReadonlyMap<string, number>;
  /// Project canvas — the composition inherits these dimensions per
  /// decision 10 (in-place flatten).
  canvasWidth: number;
  canvasHeight: number;
}

/// Build the engine state for a group. Members are processed in
/// `(trackIndex ASC, t_start ASC)` order so the resulting z values are
/// stable across re-distillations.
export function distillCompositionState(input: DistillInputs): DistillResult {
  const skipped: DistillResult["skipped"] = [];
  const mediaByLayer = new Map<string, MediaSummary>();

  // Resolve members + filter audio (decision 7 — audio passes through
  // to amix, never enters the composition) + filter unsupported kinds.
  // Template is supported preview-side post Template-in-composition
  // followup (2026-05-17); HtmlGroupHandle walks the composition's
  // shadow for `[data-kind="Template"]` placeholders after the engine
  // mounts and instantiates each via TemplateHandle.instantiateTemplate.
  // Subtitles still skipped — JASSUB integration is a separate piece.
  type Resolved = { layer: LayerSummary; trackIndex: number };
  const resolved: Resolved[] = [];
  for (const lid of input.group.layer_ids) {
    const layer = input.layerById.get(lid);
    if (!layer) continue;
    if (!layer.enabled) continue;
    if (layer.params.kind === "Audio") continue; // bypass (decision 7)
    if (layer.params.kind === "Subtitles") {
      skipped.push({
        layerId: lid,
        kind: layer.params.kind,
        reason: "Subtitles in html-render compositions not yet wired (JASSUB integration pending)",
      });
      console.warn(
        `HtmlGroupHandle: skipping layer ${lid} (kind=${layer.params.kind}) — ` +
          "Subtitles in compositions need JASSUB plumbing (separate follow-up).",
      );
      continue;
    }
    const trackIndex = input.trackIndexByLayerId.get(lid) ?? 0;
    resolved.push({ layer, trackIndex });
  }

  // Order by (trackIndex ASC, t_start ASC) so paint order matches the
  // outer timeline's z-stack within the group.
  resolved.sort((a, b) => {
    if (a.trackIndex !== b.trackIndex) return a.trackIndex - b.trackIndex;
    return a.layer.t_start_us - b.layer.t_start_us;
  });

  // Group-local origin = earliest member t_start (after filtering).
  // Empty resolved set → groupTStartUs = 0; the engine renders nothing
  // and the handle is essentially a no-op until a real member arrives.
  const groupTStartUs = resolved.length > 0 ? resolved[0]!.layer.t_start_us : 0;

  const layers: CompositionLayer[] = resolved.map(({ layer, trackIndex }, idx) => {
    const params = compositionLayerParams(layer, input.mediaById, mediaByLayer);
    const effectTransform = pickHtmlTransform(layer.effects);
    return {
      id: layer.id,
      // Use the sorted index as z so successive distillations produce
      // identical z values for an unchanged member set. trackIndex
      // alone would tie members on the same track; the sorted index
      // breaks the tie deterministically.
      z: idx,
      t_start_us: layer.t_start_us - groupTStartUs,
      t_end_us: layer.t_end_us - groupTStartUs,
      ...positionFor(layer),
      params,
      ...(effectTransform ? { effectTransform } : {}),
    };
    // `trackIndex` retained in scope only to surface the field as
    // documentation; the engine reads `z` for ordering.
    void trackIndex;
  });

  const compositionTransform = pickCompositionTransform(input.group);

  const state: CompositionState = {
    width: input.canvasWidth,
    height: input.canvasHeight,
    layers,
    ...(compositionTransform ? { compositionTransform } : {}),
  };
  return { state, groupTStartUs, skipped, mediaByLayer };
}

/// Find the group's first `HtmlTransform` effect and convert its
/// `Animated<f64>` tracks into the engine-facing `CompositionTransform`
/// shape. Returns `null` when the group has no `HtmlTransform` — the
/// engine then writes `compositionEl.style.transform = ""`, matching
/// the no-effect ffmpeg render exactly.
///
/// Multi-`HtmlTransform` composition isn't supported in v1 (only the
/// first wins). Authors should put complex motion into one effect's
/// keyframe tracks; multiple effects with overlapping windows can land
/// later if the use case shows up.
function pickCompositionTransform(group: GroupSummary): CompositionTransform | null {
  return pickHtmlTransform(group.effects);
}

/// Walk an effect chain (group or layer) and return the first enabled
/// `HtmlTransform`'s tracks as a `CompositionTransform`. Returns `null`
/// when none present. Multiple HtmlTransforms in one chain isn't
/// supported in v1 (the first wins).
function pickHtmlTransform(
  effects: ReadonlyArray<{ enabled: boolean; params: { kind: string } & Record<string, unknown> }>,
): CompositionTransform | null {
  for (const e of effects) {
    if (!e.enabled) continue;
    if (e.params.kind !== "HtmlTransform") continue;
    const p = e.params as unknown as {
      x: AnimTrack<number>;
      y: AnimTrack<number>;
      scale_x: AnimTrack<number>;
      scale_y: AnimTrack<number>;
      rotation_deg: AnimTrack<number>;
      opacity: AnimTrack<number>;
    };
    return {
      x: p.x,
      y: p.y,
      scale_x: p.scale_x,
      scale_y: p.scale_y,
      rotation_deg: p.rotation_deg,
      opacity: p.opacity,
    };
  }
  return null;
}

function positionFor(layer: LayerSummary): {
  opacity: number;
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
} {
  const p = layer.params;
  switch (p.kind) {
    case "VideoClip":
    case "ImageOverlay":
    case "Template":
      return {
        opacity: p.opacity,
        x: p.x,
        y: p.y,
        scale_x: p.scale_x,
        scale_y: p.scale_y,
      };
    case "Text":
      return {
        opacity: p.opacity,
        x: p.x,
        y: p.y,
        scale_x: 1,
        scale_y: 1,
      };
    case "Color":
      // Color layers fill the canvas at (0, 0); transform applies on top.
      return { opacity: 1, x: 0, y: 0, scale_x: 1, scale_y: 1 };
    case "Subtitles":
    case "Audio":
      // Skipped upstream; defensive fallback.
      return { opacity: 1, x: 0, y: 0, scale_x: 1, scale_y: 1 };
  }
}

function compositionLayerParams(
  layer: LayerSummary,
  mediaById: ReadonlyMap<string, MediaSummary>,
  mediaByLayer: Map<string, MediaSummary>,
): CompositionLayerParams {
  const p = layer.params;
  switch (p.kind) {
    case "Color":
      return {
        kind: "Color",
        rgba: { r: p.color.r, g: p.color.g, b: p.color.b, a: p.color.a },
        width: p.width,
        height: p.height,
      };
    case "Text":
      return {
        kind: "Text",
        content: p.content,
        font_family: p.font_family,
        font_size_px: p.font_size_px,
        color: { r: p.color.r, g: p.color.g, b: p.color.b, a: p.color.a },
      };
    case "VideoClip": {
      const media = mediaById.get(p.media_id);
      if (media) mediaByLayer.set(layer.id, media);
      return {
        kind: "VideoClip",
        media_id: p.media_id,
        src_in_us: p.src_in_us,
        src_out_us: p.src_out_us,
      };
    }
    case "ImageOverlay": {
      const media = mediaById.get(p.media_id);
      if (media) mediaByLayer.set(layer.id, media);
      return { kind: "ImageOverlay", media_id: p.media_id };
    }
    case "Template":
      return {
        kind: "Template",
        template_id: p.template_id,
        props: { ...p.props },
      };
    // Defensive — the resolved set already filtered these.
    case "Audio":
    case "Subtitles":
      throw new Error(`distill: unexpected kind ${p.kind} after filtering`);
  }
}
