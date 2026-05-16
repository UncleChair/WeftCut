/// CompositionGenerator — builds the composed HTML for an html-render
/// group. Per decision 11 (`docs/html-render-groups.md`) the artifact is
/// mount-agnostic: the same content mounts both inside a Shadow DOM in
/// preview *and* as a full root document in the offscreen export raster.
///
/// H.0 scope: only `buildProbeHtml()` exists — the single-pixel
/// transparency probe that decision 12 mandates lands before any other
/// composition work. Real per-child generation arrives in Phase H.3.

/// Per-slot video binding. The composition embeds
/// `<video data-source-layer="L-id">` slots; the preview-side resolver
/// fills `<video src="asset://proxy">` and the export-side resolver
/// fills `<img src="tmp/frame_NNNNN.png">` (decision 5). Empty in H.0
/// probe; populated by the H.3 generator.
export interface VideoBinding {
  layerId: string;
  /// Selector inside the composition that resolves to the slot element.
  /// `#L-<id>-video` is the planned shape.
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
