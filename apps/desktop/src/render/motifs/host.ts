import { invoke } from "@tauri-apps/api/core";

/**
 * Render a Motif to a single frame and return the raw PNG as a `Blob`.
 *
 * Drives the Rust `motif_capture_frame` command (Approach A: hidden WebView2
 * host window + `motif:` scheme + CDP `Page.captureScreenshot`). The PNG is
 * taint-free (CDP screenshot, not a canvas readback).
 *
 * @param motifId    built-in Motif id (e.g. "countdown")
 * @param tSec       content time in SECONDS
 * @param props      Motif props (will be JSON-serialized for the IPC boundary)
 * @param width      capture width in pixels
 * @param height     capture height in pixels
 * @param settleRafs optional extra rAF settle count before capture
 */
export async function captureMotifFramePngBlob(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
): Promise<Blob> {
  const b64: string = await invoke("motif_capture_frame", {
    motifId,
    tSec,
    propsJson: JSON.stringify(props),
    width,
    height,
    settleRafs: settleRafs ?? null,
  });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

/**
 * As `captureMotifFramePngBlob`, decoded to an `ImageBitmap` for GPU upload.
 *
 * The bitmap can be uploaded to WebGPU/Pixi without cross-origin tainting.
 *
 * @param motifId    built-in Motif id (e.g. "countdown")
 * @param tSec       content time in SECONDS
 * @param props      Motif props (will be JSON-serialized for the IPC boundary)
 * @param width      capture width in pixels
 * @param height     capture height in pixels
 * @param settleRafs optional extra rAF settle count before capture
 */
export async function captureMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
): Promise<ImageBitmap> {
  const blob = await captureMotifFramePngBlob(motifId, tSec, props, width, height, settleRafs);
  return createImageBitmap(blob);
}
