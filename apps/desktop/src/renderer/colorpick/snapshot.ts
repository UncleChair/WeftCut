// Frozen window snapshot for in-app non-canvas sampling. One capturePage IPC +
// one PNG decode per pick session; every hover read afterwards is a CPU array
// access. scaleX/scaleY convert CSS-px client coords → snapshot device pixels.

export interface WindowSnapshot {
  data: ImageData;
  scaleX: number;
  scaleY: number;
}

export async function captureWindowSnapshot(): Promise<WindowSnapshot> {
  const png = await window.api.window.captureSnapshot();
  const bmp = await createImageBitmap(new Blob([png as unknown as BlobPart], { type: "image/png" }));
  const w = bmp.width;
  const h = bmp.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    throw new Error("captureWindowSnapshot: no 2d context");
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return {
    data: ctx.getImageData(0, 0, w, h),
    scaleX: w / window.innerWidth,
    scaleY: h / window.innerHeight,
  };
}
