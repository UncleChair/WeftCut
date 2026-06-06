// Rasterize a plain-SVG string to an ImageBitmap. Prefers the off-main-thread
// RasterPool (parallel, keeps the work off the main thread); falls back to the
// inline main-thread path on any pool failure or when there is no DOM.
import { getRasterPool } from "./rasterSlot";
import type { RasterPool } from "./rasterPool";

// Inline main-thread rasterizer (the fallback + the original implementation).
// NOTE: createImageBitmap(blob) directly fails for SVG in WebView2 — the
// <img> indirection is REQUIRED. foreignObject taints; plain SVG is clean.
export async function rasterizeSvgInline(svg: string): Promise<ImageBitmap> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("svgRaster: <img> failed to load SVG"));
      img.src = url;
    });
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/// Pure routing: pool first (parallel/off-main), inline on any pool rejection
/// or when there is no pool. Injected `pool`/`inline` make it DOM-free testable.
export async function rasterizeSvgVia(
  pool: RasterPool | null,
  inline: (svg: string) => Promise<ImageBitmap>,
  svg: string,
): Promise<ImageBitmap> {
  if (pool) {
    try {
      return await pool.rasterize(svg);
    } catch {
      // Pool unavailable / disabled / this raster failed — fall back to inline.
    }
  }
  return inline(svg);
}

/// Rasterize a plain-SVG string to an ImageBitmap (pooled, with inline fallback).
export function rasterizeSvg(svg: string): Promise<ImageBitmap> {
  return rasterizeSvgVia(getRasterPool(), rasterizeSvgInline, svg);
}
