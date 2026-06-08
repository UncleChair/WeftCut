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
 * @param contentHash optional blake3 content hash — threaded to the host URL's
 *                    `?v=` cache-buster so an in-place draft edit reloads the
 *                    capture host (else it re-captures the stale loaded DOM).
 */
export async function captureMotifFramePngBlob(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
  contentHash?: string,
): Promise<Blob> {
  const b64: string = await invoke("motif_capture_frame", {
    motifId,
    tSec,
    propsJson: JSON.stringify(props),
    width,
    height,
    settleRafs: settleRafs ?? null,
    contentHash: contentHash ?? "",
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
 * @param contentHash optional blake3 content hash — threaded to the host URL's
 *                    `?v=` cache-buster (see `captureMotifFramePngBlob`).
 */
export async function captureMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
  contentHash?: string,
): Promise<ImageBitmap> {
  const blob = await captureMotifFramePngBlob(motifId, tSec, props, width, height, settleRafs, contentHash);
  return createImageBitmap(blob);
}
