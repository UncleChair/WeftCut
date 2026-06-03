// Per-VideoClip sprite. Texture is fed by SourceDecoderPool's
// FrameRing (preview) or ExportFrameStore (export): each composite
// frame we look up the bitmap / VideoFrame whose presentation interval
// contains the layer-local time, and update the sprite's persistent
// texture source from it.
//
// Plan: docs/pixi-renderer-plan.md (P2)
//
// Implementation per PixiJS v8 docs:
//
//   - `Texture.from(source)` is cache-only in v8: "The source should
//     be loaded and ready to go." Passing a raw VideoFrame yields a
//     texture that may not actually upload pixels to the GPU.
//   - `ImageSource` is the correct TextureSource subclass for
//     WebCodecs frames — it explicitly accepts HTMLImageElement,
//     ImageBitmap, VideoFrame, OffscreenCanvas, and HTMLVideoElement.
//   - `VideoSource` only handles HTMLVideoElement, NOT VideoFrame.
//
// Lifecycle: one persistent `ImageSource` per sprite. On each new
// frame we update the source's underlying pixels and call
// `source.update()` to notify the renderer; the same Texture object
// stays bound to the sprite. On the very first frame we allocate the
// ImageSource (it requires a non-empty resource at construction).
//
// UNIFIED SNAPSHOT PATH — `drawImage` into a sprite-owned canvas
//
// Both preview (`ImageBitmap` from the ring) and export (`VideoFrame`
// from the `ExportFrameStore`) frames are snapshotted into a
// sprite-owned `OffscreenCanvas` via a synchronous `drawImage` inside
// `updateFrame`, then that canvas (not the borrowed frame) is bound as
// the texture's resource. Two independent reasons converge on one path:
//
//   1. Detach-race (preview). PixiJS v8 defers the WebGPU upload of the
//      bound resource until `renderer.render()` runs, so a composite
//      that binds bitmap X followed by an eviction-driven
//      `bitmap.close()` on X (fast playhead scrubbing) can detach the
//      resource before that deferred upload — `InvalidStateError:
//      Failed to execute 'copyExternalImageToTexture' on 'GPUQueue':
//      External Image has been detached`. The canvas's pixels are owned
//      by the sprite for its whole lifetime, so eviction of the source
//      frame a microsecond later is harmless.
//
//   2. ColorSpace correctness (export). Pixi's WebGPU upload of a raw
//      `VideoFrame` goes through `copyExternalImageToTexture`, which
//      IGNORES the frame's `colorSpace` and converts every frame as
//      BT.709 — so a BT.601 (or otherwise non-709) DirectExport source
//      mis-converts (the matrix error the color-conformance gate
//      catches). A 2D-canvas `drawImage(videoFrame)` performs the
//      YUV→RGB conversion HONORING the frame's matrix/range, so binding
//      the resulting RGBA canvas hands Pixi already-correct pixels.
//      (Verified in WebView2: `drawImage` distinguishes 601 vs 709; the
//      raw-VideoFrame upload does not.)
//
// Cost: a per-frame 2D `drawImage` (a GPU blit) the old export path
// avoided by binding the VideoFrame directly. Acceptable for offline
// export; the zero-copy WebGPU `importExternalTexture` path that would
// recover it AND honor the matrix is tracked in docs/roadmap.md
// ("Zero-copy color-correct GPU frame upload").

import { ImageSource, Sprite, Texture } from "pixi.js";

import type { DecodedFrame } from "../decoder/SourceDecoderPool";

export interface VideoClipSpriteInit {
  layerId: string;
  mediaId: string;
}

/// Read the natural dimensions off either flavour of `DecodedFrame`.
/// `VideoFrame` exposes `codedWidth/codedHeight`; `ImageBitmap` exposes
/// plain `width/height`. PixiJS's `ImageSource` needs the size at
/// construction time so the texture's `orig` dims are correct before
/// any upload completes.
function decodedDims(frame: DecodedFrame): { width: number; height: number } {
  if ("codedWidth" in frame) {
    return { width: frame.codedWidth, height: frame.codedHeight };
  }
  return { width: frame.width, height: frame.height };
}

export class VideoClipSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly mediaId: string;
  /// Persistent ImageSource, lazily allocated on first updateFrame.
  private source: ImageSource | null = null;
  private texture: Texture | null = null;
  /// Sprite-owned canvas every decoded frame is drawn into each tick
  /// (both preview `ImageBitmap`s and export `VideoFrame`s — see the
  /// file header). Reused across updates by overwriting its pixels;
  /// re-allocated only if the source dims change (rare — a video
  /// doesn't normally change `codedWidth/Height` mid-stream).
  private snapCanvas: OffscreenCanvas | null = null;
  private snapCtx: OffscreenCanvasRenderingContext2D | null = null;
  /// Identity of the frame last fed in. Used only to short-circuit
  /// duplicate updates — the frame's pixels are not retained past
  /// `updateFrame`'s return (they live in `snapCanvas`), so a borrowed
  /// preview bitmap or a soon-evicted export VideoFrame can be released
  /// immediately after.
  private currentFrame: DecodedFrame | null = null;

  constructor(init: VideoClipSpriteInit) {
    this.layerId = init.layerId;
    this.mediaId = init.mediaId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Push a decoded frame onto the GPU. No-op if the same frame is
  /// already current. Both preview frames (`ImageBitmap`) and export
  /// frames (`VideoFrame`) are snapshotted into the sprite-owned canvas
  /// — see the file header for why this single path serves both.
  updateFrame(frame: DecodedFrame): void {
    if (this.currentFrame === frame) return;
    this.currentFrame = frame;
    const { width, height } = decodedDims(frame);
    this.bindFromSnapshot(frame, width, height);
  }

  private bindFromSnapshot(
    frame: DecodedFrame,
    width: number,
    height: number,
  ): void {
    const dimsChanged =
      !this.snapCanvas ||
      this.snapCanvas.width !== width ||
      this.snapCanvas.height !== height;
    if (dimsChanged) {
      this.snapCanvas = new OffscreenCanvas(width, height);
      this.snapCtx = this.snapCanvas.getContext("2d");
    }
    if (!this.snapCtx || !this.snapCanvas) return;
    // Synchronous pixel copy. For a `VideoFrame` this is also the
    // colorSpace-honoring YUV→RGB conversion (file header §2); for an
    // `ImageBitmap` it's a plain RGBA blit. Either way, by the time this
    // returns the canvas owns the pixels, so the borrowed preview bitmap
    // (evicted on fast scrub) or the export VideoFrame (closed by the
    // store's `evictBefore`) can be released right after.
    this.snapCtx.drawImage(frame, 0, 0, width, height);

    if (!this.source || !this.texture || dimsChanged) {
      this.rebindSource(this.snapCanvas, width, height);
      return;
    }
    // Canvas identity unchanged; the underlying pixels just got
    // overwritten. Mark the source dirty so Pixi re-uploads on next
    // render.
    this.source.update();
  }

  /// Build (or rebuild on a dims change) the ImageSource + Texture
  /// pair and bind the texture to the sprite. Destroys the previous
  /// pair if any. Logs the first-bind event so the renderer log
  /// retains its "sprite came alive" milestone.
  private rebindSource(
    resource: OffscreenCanvas,
    width: number,
    height: number,
  ): void {
    const oldTexture = this.texture;
    this.source = new ImageSource({ resource, width, height });
    this.texture = new Texture({ source: this.source });
    this.sprite.texture = this.texture;
    if (oldTexture) {
      try {
        oldTexture.destroy(true);
      } catch {
        // ignore — best-effort cleanup; Pixi may have already released
      }
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] sprite ${this.layerId} first texture bound: ` +
          `${width}×${height} ` +
          `texture.orig=${this.texture.orig.width}×${this.texture.orig.height}`,
      );
    }
  }

  dispose(): void {
    this.currentFrame = null;
    this.sprite.destroy({ children: true });
    if (this.texture) {
      try {
        this.texture.destroy(true);
      } catch {
        // ignore
      }
      this.texture = null;
    }
    this.source = null;
    this.snapCanvas = null;
    this.snapCtx = null;
  }
}
