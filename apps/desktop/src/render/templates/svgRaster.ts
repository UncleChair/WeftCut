// Rasterize a plain-SVG string to an ImageBitmap via an <img> element.
// NOTE: createImageBitmap(blob) directly fails for SVG in WebView2 — the
// <img> indirection is REQUIRED. foreignObject taints; plain SVG is clean.
export async function rasterizeSvg(svg: string): Promise<ImageBitmap> {
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
