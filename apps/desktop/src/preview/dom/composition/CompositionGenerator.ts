/// CompositionGenerator — builds the composed HTML for an html-render
/// group. Per decision 11 (`docs/html-render-groups.md`) the artifact is
/// mount-agnostic: the same content mounts both inside a Shadow DOM in
/// preview *and* as a full root document in the offscreen export raster.
///
/// Two entry points:
///   - `buildProbeHtml()` — the single-pixel transparency probe (H.0).
///   - `buildComposition(state)` — the per-group composition (H.3).
///
/// H.3 supports Color / Text / VideoClip / ImageOverlay child kinds.
/// Template + Subtitles children are H.3 follow-ups (templates need
/// the `TemplateHandle` shadowed-globals dance integrated; subtitles
/// need JASSUB plumbing). Effect-catalog integration is also a
/// follow-up — the engine currently applies only transform/opacity +
/// kind-specific styling.

import { ENGINE_SOURCE, STATE_SCRIPT_ID, type CompositionState } from "./engine";

/// Per-slot media binding. The composition embeds
/// `<div class="layer-video|layer-image" data-layer-id="...">` slots;
/// the preview-side resolvers fill them with `<video>` / `<img>`
/// elements and the export-side resolver (decision 5) fills them with
/// per-frame extracted `<img>`s. The `kind` discriminator lets the
/// host dispatch to the right resolver. Empty in H.0 probe; populated
/// by the H.3 generator (VideoClip) and the F.1 follow-up
/// (ImageOverlay).
export interface VideoBinding {
  layerId: string;
  /// `"VideoClip"` mounts a `<video>` element + per-tick currentTime
  /// nudge. `"ImageOverlay"` mounts a static `<img>`.
  kind: "VideoClip" | "ImageOverlay";
  /// Selector inside the composition that resolves to the slot element.
  /// `[data-layer-id="<id>"]` is the shipped shape.
  slotSelector: string;
}

export interface CompositionArtifact {
  /// Shadow-root content: `<style>` block(s) + `#composition` subtree,
  /// no `<html>` / `<body>` wrappers. Mount via
  /// `shadowRoot.innerHTML = artifact.shadow` (or via DOM construction
  /// for stronger XSS hygiene once we accept untrusted templates).
  shadow: string;
  /// Full HTML document including `<!doctype>` / `<html>` / `<head>` /
  /// `<body>`, embedding the same `<style>` and `#composition` content.
  /// The offscreen raster webview navigates to this as a root document.
  document: string;
  /// Slots that need per-frame video source resolution. Empty for the
  /// H.0 probe (no media).
  bindings: VideoBinding[];
}

/// Probe canvas dimensions. Small on purpose — the probe needs at most
/// a few hundred KB of captured PNG and we want the offscreen raster
/// resize step to be quick.
export const PROBE_CANVAS_W = 800;
export const PROBE_CANVAS_H = 200;

/// Probe rect inside the composition. Center pixel sampled from the
/// middle of this rect — both preview and export should report the
/// same `(255, 0, 0, 128)` ± tolerance per decision 12.
export const PROBE_RECT = {
  left: 200,
  top: 50,
  width: 400,
  height: 100,
} as const;

/// Acceptable ±tolerance per channel — captures going through
/// pre-multiplication, color-managed compositing, or 8-bit rounding can
/// shift values by a small amount. ±4 is what decision 12 specifies.
export const PROBE_TOLERANCE = 4;

/// Target pixel value the probe must report at its center: 50%-alpha
/// pure red on a transparent backdrop, captured as straight (not
/// premultiplied) RGBA. Any opaque-backdrop bug pushes alpha toward 255
/// and the RGB channels toward the backdrop color.
export const PROBE_TARGET = { r: 255, g: 0, b: 0, a: 128 } as const;

/// Common styles + body markup for the probe. Used identically by both
/// the shadow-mount and the root-document mount; the root document just
/// adds the HTML/body shell around it.
const PROBE_INNER = `
<style>
  #composition {
    position: relative;
    width: ${PROBE_CANVAS_W}px;
    height: ${PROBE_CANVAS_H}px;
    /* Explicit transparent — defends against any inherited background
       leaking in from the parent context. */
    background: transparent;
  }
  #probe {
    position: absolute;
    left: ${PROBE_RECT.left}px;
    top: ${PROBE_RECT.top}px;
    width: ${PROBE_RECT.width}px;
    height: ${PROBE_RECT.height}px;
    /* The pixel-under-test. 50% alpha red. If captured pixels report
       the wrong RGBA, the iframe-transparency arc has re-opened on a
       new surface. */
    background: rgba(255, 0, 0, 0.5);
  }
</style>
<div id="composition">
  <div id="probe"></div>
</div>`;

/// Root-document wrapper. `<meta name="color-scheme" content="normal">`
/// defends against WebView2's color-scheme inheritance making the
/// document opaque (commit 35875e7 hit this for iframes; root-doc
/// navigation is a different surface but the same defense is cheap).
/// `html, body { background: transparent; margin: 0; }` is the standard
/// transparent-host shape.
const PROBE_DOCUMENT = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="normal">
<style>
  html, body { background: transparent; margin: 0; padding: 0; }
</style>
</head>
<body>
${PROBE_INNER}
</body>
</html>`;

/// Single-pixel transparency probe per decision 12.
///
/// Mount in preview by attaching a shadow root and setting
/// `shadowRoot.innerHTML = artifact.shadow`. Mount in export by
/// navigating the offscreen raster webview to a data URL or temp file
/// containing `artifact.document`. Sample the captured pixel at
/// `(PROBE_CANVAS_W/2, PROBE_CANVAS_H/2)` and compare against
/// `PROBE_TARGET` with `PROBE_TOLERANCE` per channel.
export function buildProbeHtml(): CompositionArtifact {
  return {
    shadow: PROBE_INNER,
    document: PROBE_DOCUMENT,
    bindings: [],
  };
}

/// Per-channel tolerance comparison. Returns `null` if every channel
/// is within `PROBE_TOLERANCE` of `PROBE_TARGET`; otherwise returns a
/// human-readable diagnostic of which channels drifted.
export function checkProbePixel(actual: { r: number; g: number; b: number; a: number }):
  | null
  | string {
  const channels: Array<["r" | "g" | "b" | "a", number, number]> = [
    ["r", actual.r, PROBE_TARGET.r],
    ["g", actual.g, PROBE_TARGET.g],
    ["b", actual.b, PROBE_TARGET.b],
    ["a", actual.a, PROBE_TARGET.a],
  ];
  const drifted = channels
    .filter(([, got, want]) => Math.abs(got - want) > PROBE_TOLERANCE)
    .map(([name, got, want]) => `${name}=${got} (want ${want}±${PROBE_TOLERANCE})`);
  return drifted.length === 0 ? null : drifted.join(", ");
}

// ============================================================
// Composition builder (H.3)
// ============================================================

/// Standard CSS shell for every composition. Same selectors regardless
/// of mount surface (decision 11 — `#composition` not `:host`).
const COMPOSITION_BASE_STYLES = `
html, body {
  background: transparent;
  margin: 0;
  padding: 0;
  /* Suppress scrollbars unconditionally — see the same comment in
     Rust composition.rs. The export raster's offscreen window
     viewport can be a pixel smaller than #composition; without
     this rule, captured frames show OS scrollbars instead of
     content. Harmless in the preview shadow-DOM mount where the
     shadow root has no viewport scroll. */
  overflow: hidden;
  width: 100%;
  height: 100%;
}
#composition { position: relative; overflow: hidden; background: transparent; }
.layer {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
  pointer-events: none;
  /* Hidden until the engine applies the per-frame opacity — avoids a
     one-frame flash of unstyled content before __setTime fires. */
  opacity: 0;
}
.layer-color, .layer-text {
  /* These layer kinds carry their visual content via background-color
     or text content directly on the host element. */
}
.layer-text {
  white-space: pre-wrap;
  line-height: 1.2;
}
.layer-video, .layer-image {
  /* Resolver fills the slot; sizing comes from the inner element. */
}
.layer-video > video,
.layer-video > img,
.layer-image > img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.layer-template {
  /* Width/height set imperatively after the host walks the shadow
     and reads template.size from the catalog. Browsers treat
     unset width/height on an absolutely-positioned div as
     auto = the content's intrinsic size — which is 0×0 before
     attachShadow runs, so the host is invisible for one frame.
     Acceptable: HtmlGroupHandle.refresh() runs synchronously
     immediately after innerHTML, so there's no perceptible flash. */
}`;

function rgbaCss(c: { r: number; g: number; b: number; a: number }): string {
  // The Rust Rgba carries channels as 0..255. CSS rgba() accepts 0..255
  // for r/g/b and 0..1 for alpha — convert alpha at the boundary.
  return `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, ${(c.a / 255).toFixed(3)})`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/// Per-layer DOM subtree. The host element carries `data-layer-id` so the
/// engine can locate it via querySelector. Per-kind `data-kind` is
/// preserved so resolvers and a future inspector can introspect the
/// composition.
///
/// Sizing strategy: layer kinds carry their own intrinsic size on the
/// host element (Color: w/h; Text: auto from font metrics; VideoClip /
/// ImageOverlay: filled by the resolver). The engine's transform stack
/// positions and scales the host; intrinsic sizing happens in CSS.
function renderLayerHtml(layer: CompositionState["layers"][number]): string {
  const id = escapeAttr(layer.id);
  switch (layer.params.kind) {
    case "Color": {
      const w = layer.params.width | 0;
      const h = layer.params.height | 0;
      const bg = rgbaCss(layer.params.rgba);
      return (
        `<div class="layer layer-color" data-layer-id="${id}" data-kind="Color" ` +
        `style="width: ${w}px; height: ${h}px; background-color: ${bg};"></div>`
      );
    }
    case "Text": {
      const family = escapeAttr(layer.params.font_family);
      const size = layer.params.font_size_px;
      const fg = rgbaCss(layer.params.color);
      const content = escapeHtml(layer.params.content);
      return (
        `<div class="layer layer-text" data-layer-id="${id}" data-kind="Text" ` +
        `style="font-family: ${family}; font-size: ${size}px; color: ${fg};">${content}</div>`
      );
    }
    case "VideoClip": {
      // Resolver (preview: <video src=proxy>; export: <img src=...frame>)
      // fills the slot at mount. We bake the slot's native pixel size
      // here so the `<video>`/`<img>` child can be `width: 100%; height:
      // 100%` of the slot and the layer's CSS transform (scale_x/y)
      // composes on top — same model as the standalone VideoClipHandle
      // outside compositions (style.width = srcW + style.transform).
      const w = layer.params.width | 0;
      const h = layer.params.height | 0;
      return (
        `<div class="layer layer-video" data-layer-id="${id}" data-kind="VideoClip" ` +
        `data-media-id="${escapeAttr(layer.params.media_id)}" ` +
        `style="width: ${w}px; height: ${h}px;"></div>`
      );
    }
    case "ImageOverlay": {
      const w = layer.params.width | 0;
      const h = layer.params.height | 0;
      return (
        `<div class="layer layer-image" data-layer-id="${id}" data-kind="ImageOverlay" ` +
        `data-media-id="${escapeAttr(layer.params.media_id)}" ` +
        `style="width: ${w}px; height: ${h}px;"></div>`
      );
    }
    case "Template": {
      // Template-in-composition: HtmlGroupHandle walks the mounted
      // shadow for `[data-kind="Template"]` placeholders after the
      // engine runs and calls `TemplateHandle.instantiateTemplate` on
      // each — which attachShadows the placeholder and runs the
      // template's scripts with per-instance shadowed globals (same
      // pattern as standalone Template layers outside compositions).
      // The host's width/height are set at mount time from the
      // template manifest's `size`; we leave size off the generated
      // element so the first frame doesn't flash a default 0×0 box.
      return (
        `<div class="layer layer-template" data-layer-id="${id}" data-kind="Template" ` +
        `data-template-id="${escapeAttr(layer.params.template_id)}"></div>`
      );
    }
  }
}

/// Build the composition artifact for the given state. The returned
/// `shadow` content embeds composition `<style>`, `#composition`
/// subtree, the JSON state blob, and the engine `<script>`. The
/// `document` is the same content wrapped in `<!doctype><html><body>`.
///
/// The state's `layers` are sorted by `z` ascending before emission so
/// later DOM siblings paint on top — z-index doesn't apply to absolutely
/// positioned siblings without explicit z-index, and using DOM order
/// matches the export-time IR's bottom-to-top overlay walk.
///
/// `bindings` lists every VideoClip slot; the host's resolver consumes
/// this at mount time. Empty for compositions with no video children.
export function buildComposition(state: CompositionState): CompositionArtifact {
  const sorted = [...state.layers].sort((a, b) => a.z - b.z);

  const layerHtml = sorted.map(renderLayerHtml).join("\n");
  const bindings: VideoBinding[] = sorted
    .filter(
      (l) => l.params.kind === "VideoClip" || l.params.kind === "ImageOverlay",
    )
    .map((l) => ({
      layerId: l.id,
      kind: l.params.kind as "VideoClip" | "ImageOverlay",
      slotSelector: `[data-layer-id="${l.id}"]`,
    }));

  // Composition-specific style block, plus the canvas size on
  // `#composition`. Placed before the layer DOM so the .layer rule
  // takes effect on first paint (avoiding flash of unstyled content).
  const compositionStyle = `
<style>
${COMPOSITION_BASE_STYLES}
#composition { width: ${state.width | 0}px; height: ${state.height | 0}px; }
</style>`;

  // State + engine emit at the END of body so the layer DOM exists by
  // the time the engine first walks it.
  const stateScript = `<script type="application/json" id="${STATE_SCRIPT_ID}">${
    safeJsonEmbed(state)
  }</script>`;
  const engineScript = `<script>${ENGINE_SOURCE}</script>`;

  const shadowBody =
    `${compositionStyle}\n<div id="composition">\n${layerHtml}\n</div>\n${stateScript}\n${engineScript}`;

  const documentBody = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="normal">
</head>
<body>
${shadowBody}
</body>
</html>`;

  return {
    shadow: shadowBody,
    document: documentBody,
    bindings,
  };
}

/// Escape `</` inside JSON so a `</script>` token in a state value
/// can't break out of the embedding `<script>` tag. The browser's
/// JSON parser tolerates `\/` as a literal forward slash.
function safeJsonEmbed(value: unknown): string {
  return JSON.stringify(value).replace(/<\/(script)/gi, "<\\/$1");
}

export type { CompositionState };
export { ENGINE_SOURCE };
