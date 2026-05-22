// Per-VideoClip sprite. Texture is fed by SourceDecoderPool's
// FrameRing: each composite frame we look up the VideoFrame whose
// presentation interval contains the layer-local time, and update the
// sprite's persistent texture source from it.
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
//     ImageBitmap, VideoFrame, and HTMLVideoElement.
//   - `VideoSource` only handles HTMLVideoElement, NOT VideoFrame.
//
// Lifecycle: one persistent `ImageSource` per sprite. On each new
// frame we swap `source.resource` and call `source.update()` to
// notify the renderer; the same Texture object stays bound to the
// sprite. This is the canonical "swap resource + update" pattern.
// On the very first frame we allocate the ImageSource (we can't
// allocate it earlier because ImageSource requires a non-empty
// resource at construction).

import { ImageSource, Sprite, Texture } from "pixi.js";

import type { DecodedFrame } from "../decoder/SourceDecoderPool";

export interface VideoClipSpriteInit {
  layerId: string;
  mediaId: string;
}

/// Read the natural dimensions off either flavour of `DecodedFrame`.
/// `VideoFrame` exposes `codedWidth/codedHeight`; `ImageBitmap` exposes
/// plain `width/height`. PixiJS's `ImageSource` accepts both as a
/// resource but needs us to declare the size at construction time.
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
  /// Borrowed decoded frame whose pixels are uploaded to the GPU. We
  /// do not close this — the FrameRing / ExportFrameStore owns it.
  /// Preview's ring holds `ImageBitmap`s (decoupled from the WebCodecs
  /// decoder buffer pool); export's store holds `VideoFrame`s and
  /// evicts them after each composited output. Both satisfy
  /// PixiJS v8 `ImageSource` as a resource.
  private currentFrame: DecodedFrame | null = null;

  constructor(init: VideoClipSpriteInit) {
    this.layerId = init.layerId;
    this.mediaId = init.mediaId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Push a decoded frame onto the GPU. No-op if the same frame is
  /// already current.
  updateFrame(frame: DecodedFrame): void {
    if (this.currentFrame === frame) return;
    this.currentFrame = frame;

    if (!this.source || !this.texture) {
      // First frame — allocate the ImageSource bound to this frame.
      // PixiJS v8 explicitly accepts both VideoFrame and ImageBitmap
      // as an ImageSource resource. We pass width/height explicitly
      // so the texture's `orig` dimensions are correct before any
      // upload completes (sprite scale math reads them).
      const { width, height } = decodedDims(frame);
      this.source = new ImageSource({ resource: frame, width, height });
      this.texture = new Texture({ source: this.source });
      this.sprite.texture = this.texture;
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] sprite ${this.layerId} first texture bound: ` +
          `${width}×${height} ` +
          `texture.orig=${this.texture.orig.width}×${this.texture.orig.height}`,
      );
      return;
    }

    // Subsequent frames — swap the resource on the existing source
    // and notify PixiJS to re-upload. The Texture object stays
    // bound to the sprite; no new GPU texture handle is allocated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.source as any).resource = frame;
    this.source.update();
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
  }
}
