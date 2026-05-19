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

export interface VideoClipSpriteInit {
  layerId: string;
  mediaId: string;
}

export class VideoClipSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly mediaId: string;
  /// Persistent ImageSource, lazily allocated on first updateFrame.
  private source: ImageSource | null = null;
  private texture: Texture | null = null;
  /// Borrowed VideoFrame whose pixels are on the GPU. We do not
  /// close this — the FrameRing owns it.
  private currentFrame: VideoFrame | null = null;

  constructor(init: VideoClipSpriteInit) {
    this.layerId = init.layerId;
    this.mediaId = init.mediaId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Push a decoded frame onto the GPU. No-op if the same frame is
  /// already current.
  updateFrame(frame: VideoFrame): void {
    if (this.currentFrame === frame) return;
    this.currentFrame = frame;

    if (!this.source || !this.texture) {
      // First frame — allocate the ImageSource bound to this
      // VideoFrame. PixiJS v8 explicitly accepts VideoFrame as an
      // ImageSource resource.
      this.source = new ImageSource({
        resource: frame,
        // alphaMode "premultiply-alpha-on-upload" matches PixiJS's
        // default; we leave it implicit but record the choice here
        // for future readers.
      });
      this.texture = new Texture({ source: this.source });
      this.sprite.texture = this.texture;
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
