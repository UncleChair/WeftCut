// Encode a captured motif ImageBitmap to lossless PNG bytes for the L2 disk
// cache. PNG (not WebP) because the Canvas WebP encoder is lossy and crisp
// motif text edges matter. CDP-captured bitmaps are taint-free, so
// `convertToBlob` succeeds.
//
// Reading the bitmap via drawImage does NOT consume or neuter it, so the same
// ImageBitmap can be bound as a texture and encoded for disk.

/// Encode `bitmap` to a PNG `Blob`. Main-thread or worker (OffscreenCanvas is
/// available in both); the baker calls it on the main thread.
export async function encodeBitmapToPng(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("encodeBitmapToPng: no 2d context");
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}
