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
// PREVIEW PATH — sprite-owned canvas snapshot
//
// The preview ring stores `ImageBitmap`s with a strict lookbehind +
// flush-on-reset eviction policy. PixiJS v8 defers the WebGPU upload
// of the bound resource until `renderer.render()` runs, which means a
// `compositeFrame` that binds bitmap X and an eviction-driven
// `bitmap.close()` on X can happen between Compositor.updateClip and
// the renderer's deferred upload. Symptom: `InvalidStateError: Failed
// to execute 'copyExternalImageToTexture' on 'GPUQueue': External
// Image has been detached`, repro by fast playhead scrubbing.
//
// Fix: on every preview frame, `drawImage` the borrowed bitmap into a
// sprite-owned `OffscreenCanvas` synchronously inside `updateFrame`,
// then bind that canvas (not the borrowed bitmap) as the texture's
// resource. The canvas's pixels are owned by the sprite for its
// whole lifetime — eviction of the source bitmap a microsecond later
// is harmless because Pixi's GPU upload now reads from the canvas,
// not the freed bitmap.
//
// EXPORT PATH — VideoFrame zero-copy
//
// The export `ExportFrameStore` evicts each VideoFrame only AFTER
// the worker has composited it (the upload inside `renderer.render()`
// is synchronous from JS perspective, so by the time evict fires the
// GPU texture already holds the pixels). The race that preview hits
// is structurally absent here, so we bind the VideoFrame directly
// and skip the per-frame canvas drawImage — important for 4K+ export
// where the extra pixel-shuffle would eat the frame budget.

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

/// `VideoFrame` carries `codedWidth`; `ImageBitmap` doesn't. Same duck
/// type used by `decodedDims`. Narrowing on this tells us whether we
/// need the snapshot-canvas escape hatch (preview) or can bind the
/// frame directly (export).
function isImageBitmap(frame: DecodedFrame): frame is ImageBitmap {
  return !("codedWidth" in frame);
}

export class VideoClipSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly mediaId: string;
  /// Persistent ImageSource, lazily allocated on first updateFrame.
  private source: ImageSource | null = null;
  private texture: Texture | null = null;
  /// Preview path only: sprite-owned canvas the borrowed ring bitmap
  /// is drawn into each frame. Reused across updates by overwriting
  /// its pixels; re-allocated only if the source dims change (rare —
  /// a video doesn't normally change `codedWidth/Height` mid-stream).
  /// Stays null on the export path where VideoFrame is bound directly.
  private snapCanvas: OffscreenCanvas | null = null;
  private snapCtx: OffscreenCanvasRenderingContext2D | null = null;
  /// Identity of the frame last fed in. Used to short-circuit
  /// duplicate updates only — for the preview path the bitmap's
  /// pixels are not retained past `updateFrame`'s return (they live
  /// in `snapCanvas`); for the export path this IS the bound
  /// resource.
  private currentFrame: DecodedFrame | null = null;

  constructor(init: VideoClipSpriteInit) {
    this.layerId = init.layerId;
    this.mediaId = init.mediaId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Push a decoded frame onto the GPU. No-op if the same frame is
  /// already current. Preview frames (`ImageBitmap`) are snapshotted
  /// into the sprite-owned canvas; export frames (`VideoFrame`) are
  /// bound zero-copy.
  updateFrame(frame: DecodedFrame): void {
    if (this.currentFrame === frame) return;
    this.currentFrame = frame;
    const { width, height } = decodedDims(frame);

    if (isImageBitmap(frame)) {
      this.bindFromBitmapSnapshot(frame, width, height);
    } else {
      this.bindFromVideoFrame(frame, width, height);
    }
  }

  private bindFromBitmapSnapshot(
    bitmap: ImageBitmap,
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
    // Synchronous pixel copy — by the time this returns, the canvas
    // owns the pixels and the borrowed bitmap can safely be evicted
    // by the ring (which is exactly what fast scrub will do).
    this.snapCtx.drawImage(bitmap, 0, 0, width, height);

    if (!this.source || !this.texture || dimsChanged) {
      this.rebindSource(this.snapCanvas, width, height);
      return;
    }
    // Canvas identity unchanged; the underlying pixels just got
    // overwritten. Mark the source dirty so Pixi re-uploads on next
    // render.
    this.source.update();
  }

  private bindFromVideoFrame(
    frame: VideoFrame,
    width: number,
    height: number,
  ): void {
    if (!this.source || !this.texture) {
      this.rebindSource(frame, width, height);
      return;
    }
    // Subsequent frames — swap the resource on the existing source
    // and notify PixiJS to re-upload. The Texture object stays
    // bound to the sprite; no new GPU texture handle is allocated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.source as any).resource = frame;
    this.source.update();
  }

  /// Build (or rebuild on a dims change) the ImageSource + Texture
  /// pair and bind the texture to the sprite. Destroys the previous
  /// pair if any. Logs the first-bind event so the renderer log
  /// retains its "sprite came alive" milestone.
  private rebindSource(
    resource: OffscreenCanvas | VideoFrame,
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
