// foreignObject SVG → ImageBitmap rasterizer for template HTML.
//
// Splits into pure helpers (testable in Node) and the actual
// rasterization (browser-only via `createImageBitmap`).
//
// Plan: docs/pixi-renderer-plan.md (P5 chunk 1 — no font embedding or
// image pre-fetch yet; those land in chunk 2.)

import type { TemplateManifest } from "./catalog";

export interface RasterizeInput {
  html: string;
  css: string;
  width: number;
  height: number;
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
export async function rasterizeForeignObject(
  input: RasterizeInput,
): Promise<ImageBitmap> {
  const svg = buildForeignObjectSvg(input);
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
