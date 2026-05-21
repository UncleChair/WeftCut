// foreignObject SVG → ImageBitmap rasterizer for template HTML.
//
// Splits into pure helpers (testable in Node) and the actual
// rasterization (browser-only via `createImageBitmap`). External
// font + image references in the template inputs are inlined as
// `data:` URLs via `embedTemplateAssets` before SVG-wrap — workspace
// templates that ship their own woff2 / png assets render correctly
// inside the foreignObject (which can't issue subresource requests).

import {
  embedTemplateAssets,
  type EmbedTemplateAssetsResult,
} from "./assetEmbed";
import type { TemplateManifest } from "./catalog";

export interface RasterizeInput {
  html: string;
  css: string;
  width: number;
  height: number;
  /// Optional asset resolver invoked once per external URL discovered
  /// in `html` or `css` (font files, `<img>` srcs). Returns the
  /// asset's bytes to inline as a `data:` URL, or null to leave the
  /// reference alone. Built-in templates don't reference anything
  /// external — workspace templates with bundled woff2 / png assets
  /// supply this. See `assetEmbed.ts`.
  fetchAsset?: (url: string) => Promise<Uint8Array | null>;
}

export interface BuildSvgInput {
  html: string;
  css: string;
  width: number;
  height: number;
}

export interface SubstituteTemplateInput {
  html: string;
  css: string;
  props: Record<string, unknown>;
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]!);
}

/// Resolve `__STYLE__` and `{{key}}` placeholders before SVG-wrapping.
/// Scripts inside `foreignObject` rasters don't execute (browser
/// security sandbox on createImageBitmap), so prop values must be
/// baked into the markup at build time rather than read from
/// `window.__props__` at runtime. Unknown placeholders pass through
/// untouched so they show up in the raster — visible signal that a
/// template prop is missing.
export function substituteTemplate(input: SubstituteTemplateInput): string {
  let out = input.html.replace(/__STYLE__/g, input.css);
  out = out.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(input.props, key)) return match;
    const v = input.props[key];
    return escapeHtml(v == null ? "" : String(v));
  });
  return out;
}

/// Build a self-contained SVG with the template HTML wrapped in a
/// foreignObject. The body sits inside an XHTML-namespaced wrapper so
/// the browser parses the inner markup as HTML, not SVG.
export function buildForeignObjectSvg(input: BuildSvgInput): string {
  const { html, css, width, height } = input;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><style>${css}</style></defs>` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px">` +
    html +
    `</div>` +
    `</foreignObject>` +
    `</svg>`
  );
}

/// Fill defaults for missing props, reject unknown keys. Returns a
/// new object with keys in `props_schema` insertion order so the
/// canonical JSON form is stable.
export function canonicalizeProps(
  raw: Record<string, unknown>,
  manifest: TemplateManifest,
): Record<string, unknown> {
  for (const key of Object.keys(raw)) {
    if (!(key in manifest.props_schema)) {
      throw new Error(
        `canonicalizeProps: unknown prop "${key}" for template "${manifest.id}"`,
      );
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(manifest.props_schema)) {
    out[key] = raw[key] ?? spec.default;
  }
  return out;
}

export interface RasterCacheKeyInput {
  templateId: string;
  version: number;
  canonicalProps: Record<string, unknown>;
  width: number;
  height: number;
}

/// Deterministic cache key. Uses canonical JSON of `canonicalProps`
/// (caller is responsible for stable key order — `canonicalizeProps`
/// guarantees this).
export function rasterCacheKey(input: RasterCacheKeyInput): string {
  return [
    input.templateId,
    String(input.version),
    String(input.width),
    String(input.height),
    JSON.stringify(input.canonicalProps),
  ].join("|");
}

/// Browser-only: rasterize the SVG to an `ImageBitmap` via a blob URL.
/// Throws when called outside a window context (no Image, no Blob URL).
/// If `fetchAsset` is supplied, external font + image references in the
/// template inputs are embedded as `data:` URLs first.
export async function rasterizeForeignObject(
  input: RasterizeInput,
): Promise<ImageBitmap> {
  let html = input.html;
  let css = input.css;
  if (input.fetchAsset) {
    const embedded: EmbedTemplateAssetsResult = await embedTemplateAssets({
      html,
      css,
      fetchAsset: input.fetchAsset,
    });
    html = embedded.html;
    css = embedded.css;
    if (embedded.skipped.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/templates] rasterize skipped ${embedded.skipped.length} ` +
          `unresolvable asset(s): ${embedded.skipped.slice(0, 4).join(", ")}` +
          (embedded.skipped.length > 4 ? " …" : ""),
      );
    }
  }
  const svg = buildForeignObjectSvg({
    html,
    css,
    width: input.width,
    height: input.height,
  });
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`loadImage failed: ${String(e)}`));
    img.src = src;
  });
}
