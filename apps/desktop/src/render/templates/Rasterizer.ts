// foreignObject SVG → ImageBitmap rasterizer for template HTML.
//
// Plan: docs/pixi-renderer-plan.md (P5)
//
// P0 stub. P5 implements the SVG build, @font-face base64 embedding,
// image data-URL pre-fetching, and createImageBitmap.

export interface RasterizeInput {
  html: string;
  width: number;
  height: number;
  /// Map of font family → woff2 bytes for @font-face embedding.
  fontCache: Map<string, Uint8Array>;
}

export async function rasterizeForeignObject(
  _input: RasterizeInput,
): Promise<ImageBitmap> {
  // P5:
  //   1. Build <svg xmlns="..." width="W" height="H">
  //        <defs><style>@font-face{...base64...}</style></defs>
  //        <foreignObject width="100%" height="100%">{html}</foreignObject>
  //      </svg>
  //   2. URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml'}))
  //   3. await loadImage(url)
  //   4. createImageBitmap(img) — pixel format matches Texture upload
  //   5. URL.revokeObjectURL
  throw new Error("rasterizeForeignObject: not yet implemented (P5)");
}
