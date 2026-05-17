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
/// Color / Text / VideoClip / ImageOverlay / Template members all
/// render inside an Html-mode composition. Template embedding is
/// driven by `mountCompositionTemplates` in the engine — distill
/// embeds each template's parsed `(style, scripts, body, props,
/// width, height)` into the layer params via the cached catalog
/// (`templatesById`); HtmlGroupHandle threads it in. Subtitles
/// members are still skipped with a `console.warn` until libass-wasm
/// (JASSUB) integration lands.

import type {
  AnimTrack,
  GroupSummary,
  LayerSummary,
  MediaSummary,
  TemplateSummary,
} from "../../../ipc";
import type {
  CompositionFilter,
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
  /// Template catalog keyed by id (caller awaits `loadTemplates()` +
  /// builds the map). The distiller pre-parses each Template member's
  /// composed HTML into the embedded `style`/`scripts`/`body` strings
  /// the engine's `instantiateCompositionTemplate` consumes. Absent →
  /// any Template member is emitted as a placeholder (engine will mount
  /// nothing). HtmlGroupHandle is the only known caller and threads
  /// this in.
  templatesById?: ReadonlyMap<string, TemplateSummary>;
}

/// Pieces a composed template HTML splits into for the composition
/// engine. Mirrors the Rust `ParsedComposed` shape.
interface ParsedTemplate {
  style: string;
  scripts: string;
  body: string;
}

/// Parse a composed template (post `__STYLE__` substitution) into the
/// three pieces the composition engine consumes. Uses DOMParser for the
/// extraction — the harvested `<style>` / `<script>` blocks are stripped
/// from the body so the engine doesn't re-parse them via innerHTML.
///
/// Mirrors `parse_composed_template` in `apps/desktop/src-tauri/src/raster/template.rs`
/// so preview-side and export-side compositions feed the engine
/// identical `(style, scripts, body)` triples.
function parseTemplateComposed(composed: string): ParsedTemplate {
  const parser = new DOMParser();
  const doc = parser.parseFromString(composed, "text/html");
  const style = Array.from(doc.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  const scripts = Array.from(doc.querySelectorAll("script"))
    .map((s) => s.textContent ?? "")
    .join("\n;\n");
  // Strip script + style elements from the body so the engine's
  // shadow `innerHTML` assignment doesn't recreate them as inert
  // siblings.
  Array.from(doc.body.querySelectorAll("script, style")).forEach((el) => el.remove());
  return {
    style: style.trim(),
    scripts: scripts.trim(),
    body: doc.body.innerHTML.trim(),
  };
}

/// Build the engine state for a group. Members are processed in
/// `(trackIndex ASC, t_start ASC)` order so the resulting z values are
/// stable across re-distillations.
export function distillCompositionState(input: DistillInputs): DistillResult {
  const skipped: DistillResult["skipped"] = [];
  const mediaByLayer = new Map<string, MediaSummary>();

  // Resolve members + filter audio (decision 7 — audio passes through
  // to amix, never enters the composition) + filter unsupported kinds.
  // Template renders inside the composition via the engine's
  // `mountCompositionTemplates` — distill embeds the parsed template
  // pieces in layer.params (see Template branch in
  // `compositionLayerParams`). Subtitles still skipped — JASSUB
  // integration is a separate follow-up.
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
    const params = compositionLayerParams(
      layer,
      input.mediaById,
      mediaByLayer,
      input.canvasWidth,
      input.canvasHeight,
      input.templatesById,
    );
    const effectTransform = pickHtmlTransform(layer.effects);
    const effectFilter = pickBlur(layer.effects);
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
      ...(effectFilter ? { effectFilter } : {}),
    };
    // `trackIndex` retained in scope only to surface the field as
    // documentation; the engine reads `z` for ordering.
    void trackIndex;
  });

  const compositionTransform = pickCompositionTransform(input.group);
  const compositionFilter = pickBlur(input.group.effects);

  const state: CompositionState = {
    width: input.canvasWidth,
    height: input.canvasHeight,
    layers,
    ...(compositionTransform ? { compositionTransform } : {}),
    ...(compositionFilter ? { compositionFilter } : {}),
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
/// Walk an effect chain (group or layer) and return the first enabled
/// `Blur`'s `radius` track as a `CompositionFilter`. Returns `null`
/// when none present. Multiple Blurs in one chain isn't supported in
/// v1 (the first wins, same convention as `pickHtmlTransform`).
function pickBlur(
  effects: ReadonlyArray<{ enabled: boolean; params: { kind: string } & Record<string, unknown> }>,
): CompositionFilter | null {
  for (const e of effects) {
    if (!e.enabled) continue;
    if (e.params.kind !== "Blur") continue;
    const p = e.params as unknown as { radius: AnimTrack<number> };
    return { blur_px: p.radius };
  }
  return null;
}

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
  canvasFallbackW: number,
  canvasFallbackH: number,
  templatesById: ReadonlyMap<string, TemplateSummary> | undefined,
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
      // Slot is sized to the source media's native dimensions so the
      // layer's transform (x/y/scale) operates in the same coordinate
      // space as the standalone VideoClipHandle outside compositions.
      // Falls back to canvas dims when ffprobe didn't return a size.
      const w = media?.width ?? canvasFallbackW;
      const h = media?.height ?? canvasFallbackH;
      return {
        kind: "VideoClip",
        media_id: p.media_id,
        src_in_us: p.src_in_us,
        src_out_us: p.src_out_us,
        width: w,
        height: h,
      };
    }
    case "ImageOverlay": {
      const media = mediaById.get(p.media_id);
      if (media) mediaByLayer.set(layer.id, media);
      const w = media?.width ?? canvasFallbackW;
      const h = media?.height ?? canvasFallbackH;
      return { kind: "ImageOverlay", media_id: p.media_id, width: w, height: h };
    }
    case "Template": {
      // Look up the template + parse the composed HTML into the engine-
      // facing (style, scripts, body) triple. Missing catalog or unknown
      // template_id → emit a placeholder with empty strings; the engine
      // attachShadows but renders nothing. Matches the Rust materializer's
      // defensive fallback so a corrupted state doesn't hard-fail the
      // composition mount.
      const tpl = templatesById?.get(p.template_id);
      if (!tpl) {
        return {
          kind: "Template",
          template_id: p.template_id,
          style: "",
          scripts: "",
          body: "",
          props: { ...p.props },
          width: 0,
          height: 0,
        };
      }
      const composed = tpl.html.replace("__STYLE__", tpl.style);
      const parsed = parseTemplateComposed(composed);
      const [w, h] = tpl.size;
      return {
        kind: "Template",
        template_id: p.template_id,
        style: parsed.style,
        scripts: parsed.scripts,
        body: parsed.body,
        props: { ...p.props },
        width: w,
        height: h,
      };
    }
    // Defensive — the resolved set already filtered these.
    case "Audio":
    case "Subtitles":
      throw new Error(`distill: unexpected kind ${p.kind} after filtering`);
  }
}
