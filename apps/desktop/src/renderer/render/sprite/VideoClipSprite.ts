// Per-VideoClip sprite. Texture is fed by SourceDecoderPool's
// FrameRing (preview) or ExportFrameStore (export): each composite
// frame we look up the bitmap / VideoFrame whose presentation interval
// contains the layer-local time, and update the sprite's persistent
// texture source from it. Both frame kinds bind through ONE snapshot
// path — a sprite-owned OffscreenCanvas `drawImage` (why: see
// `bindFromSnapshot`); CPU-plane kinds never enter it and ride
// `bindExternalTexture` via their ingest shaders instead.
//
// See docs/render.md (video-clip layers).

import { type Container, ImageSource, Sprite, Texture } from "pixi.js";

import { type BrowserConvertibleFrame, decodedDims } from "../decoder/decodedFrame";
import { STAGE, stageAdd, stageNow } from "../perf/stageTimers";
import type { StageableSprite } from "./StageableSprite";

export interface VideoClipSpriteInit {
  layerId: string;
  mediaId: string;
}

export class VideoClipSprite implements StageableSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly mediaId: string;
  /// Persistent ImageSource, lazily allocated on first updateFrame.
  private source: ImageSource | null = null;
  private texture: Texture | null = null;
  /// Sprite-owned canvas every decoded frame is drawn into each tick
  /// (both preview `ImageBitmap`s and export `VideoFrame`s — see
  /// `bindFromSnapshot`). Reused across updates by overwriting its pixels;
  /// re-allocated only if the source dims change (rare — a video
  /// doesn't normally change `codedWidth/Height` mid-stream).
  private snapCanvas: OffscreenCanvas | null = null;
  private snapCtx: OffscreenCanvasRenderingContext2D | null = null;
  /// Identity of the frame last fed in. Used only to short-circuit
  /// duplicate updates — the frame's pixels are not retained past
  /// `updateFrame`'s return (they live in `snapCanvas`), so a borrowed
  /// preview bitmap or a soon-evicted export VideoFrame can be released
  /// immediately after.
  private currentFrame: BrowserConvertibleFrame | null = null;

  constructor(init: VideoClipSpriteInit) {
    this.layerId = init.layerId;
    this.mediaId = init.mediaId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  get displayObject(): Container {
    return this.sprite;
  }

  /// EMPTY-texture sprites are not staged: PixiJS v8's batched renderer
  /// crashes on the EMPTY placeholder in some Chromium configs. Once the
  /// first decoded frame lands, the texture swaps and stageReady flips true.
  get stageReady(): boolean {
    return this.sprite.texture !== Texture.EMPTY;
  }

  /// Push a decoded frame onto the GPU. No-op if the same frame is
  /// already current. Both preview frames (`ImageBitmap`) and export
  /// frames (`VideoFrame`) are snapshotted into the sprite-owned canvas —
  /// see `bindFromSnapshot` for why this single path serves both, and why
  /// the parameter type excludes the CPU-plane kinds (they must go through
  /// `bindExternalTexture` via their ingest shaders).
  updateFrame(frame: BrowserConvertibleFrame): void {
    if (this.currentFrame === frame) return;
    this.currentFrame = frame;
    const { width, height } = decodedDims(frame);
    this.bindFromSnapshot(frame, width, height);
  }

  /// 10-bit export lane: bind a converter-owned texture directly (the f16
  /// conversion result). Skips the 8-bit canvas snapshot entirely. The texture
  /// is owned by TenBitIngest — dispose() must NOT destroy it, so it is never
  /// stored in `this.texture`.
  ///
  /// Safety: `sprite.destroy({ children: true })` in dispose() does NOT pass
  /// `{ texture: true }`, so the sprite's bound texture is never destroyed by
  /// Pixi on cleanup. The texture here therefore remains alive and ingest-owned
  /// through the clip's full lifecycle.
  bindExternalTexture(texture: Texture): void {
    this.currentFrame = null;
    if (this.sprite.texture !== texture) this.sprite.texture = texture;
  }

  /// The unified snapshot path: draw the borrowed frame into the sprite-owned
  /// canvas, then bind/refresh the canvas as the texture resource. Two
  /// independent reasons converge on this one path:
  ///
  /// 1. Detach-race (preview). PixiJS v8 defers the WebGPU upload of the
  ///    bound resource until `renderer.render()` runs, so binding bitmap X
  ///    and then an eviction-driven `bitmap.close()` on X (fast playhead
  ///    scrubbing) can detach the resource before that deferred upload —
  ///    `InvalidStateError: Failed to execute 'copyExternalImageToTexture'
  ///    on 'GPUQueue': External Image has been detached`. The canvas's
  ///    pixels are sprite-owned for its whole lifetime, so evicting the
  ///    source frame a microsecond later is harmless.
  ///
  /// 2. ColorSpace correctness (export). Pixi's WebGPU upload of a raw
  ///    `VideoFrame` goes through `copyExternalImageToTexture`, which
  ///    IGNORES the frame's `colorSpace` and converts every frame as
  ///    BT.709 — a BT.601 (or otherwise non-709) DirectExport source
  ///    mis-converts (the matrix error the color-conformance gate catches).
  ///    A 2D-canvas `drawImage(videoFrame)` performs the YUV→RGB conversion
  ///    HONORING the frame's matrix/range (verified in Chromium/Electron),
  ///    so the bound RGBA canvas hands Pixi already-correct pixels.
  ///    LANDMINE: that guarantee holds for DECODER-produced frames only —
  ///    buffer-defined NV12 VideoFrames still convert as BT.601 (see
  ///    nv12Frame.ts). Such frames must never reach this path; they ride
  ///    `NativeNv12Frame` → `Nv12Ingest` → `bindExternalTexture`, and
  ///    `updateFrame`'s `BrowserConvertibleFrame` parameter excludes the
  ///    CPU-plane kinds at compile time.
  ///
  /// Cost: a per-frame 2D `drawImage` (a GPU blit). The zero-copy
  /// `importExternalTexture` path that would recover it AND honor the
  /// matrix is tracked in docs/roadmap.md ("Zero-copy color-correct GPU
  /// frame upload").
  private bindFromSnapshot(
    frame: BrowserConvertibleFrame,
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
    // colorSpace-honoring YUV→RGB conversion (reason 2 above); for an
    // `ImageBitmap` it's a plain RGBA blit. Either way, by the time this
    // returns the canvas owns the pixels, so the borrowed preview bitmap
    // (evicted on fast scrub) or the export VideoFrame (closed by the
    // store's `evictBefore`) can be released right after.
    const tBlit = stageNow();
    this.snapCtx.drawImage(frame, 0, 0, width, height);
    stageAdd(STAGE.BlitDrawImage, tBlit);

    if (!this.source || !this.texture || dimsChanged) {
      this.rebindSource(this.snapCanvas, width, height);
      return;
    }
    // Canvas identity unchanged; the underlying pixels just got
    // overwritten. Mark the source dirty so Pixi re-uploads on next
    // render.
    this.source.update();
    // A prior bindExternalTexture may have swapped the sprite's texture out;
    // re-point it at the snapshot texture so 8-bit frames become visible again.
    if (this.texture && this.sprite.texture !== this.texture) {
      this.sprite.texture = this.texture;
    }
  }

  /// Build (or rebuild on a dims change) the ImageSource + Texture
  /// pair and bind the texture to the sprite. Destroys the previous
  /// pair if any. `ImageSource` + per-frame `source.update()` is the v8
  /// pattern for a mutating canvas resource — `Texture.from` is
  /// cache-only ("the source should be loaded and ready to go") and
  /// would never re-upload, and `VideoSource` only handles
  /// HTMLVideoElement. Logs the first-bind event so the renderer log
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
