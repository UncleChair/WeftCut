// Per-VideoClip sprite. Texture is fed by SourceDecoderPool's
// FrameRing: each composite frame we look up the VideoFrame whose
// presentation interval contains the layer-local time, and update the
// sprite's persistent texture source from it.
//
// Plan: docs/pixi-renderer-plan.md (P2)
//
// Memory-conscious texture lifecycle: we keep ONE persistent texture
// per sprite. Each frame we update its TextureSource's resource and
// call `source.update()` so PixiJS re-uploads only when the
// underlying VideoFrame actually changes. Creating a new
// `Texture.from(videoFrame)` per frame works correctness-wise but
// leaks one texture object + GPU upload per frame at 30+ fps.

import { Sprite, Texture, TextureSource } from "pixi.js";

export interface VideoClipSpriteInit {
  layerId: string;
  mediaId: string;
}

export class VideoClipSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly mediaId: string;
  /// Persistent texture; we swap `_videoFrame` in place each frame.
  private texture: Texture;
  private textureSource: TextureSource;
  /// The VideoFrame whose pixels currently sit on the GPU. Borrowed
  /// from FrameRing — we do NOT close it.
  private currentFrame: VideoFrame | null = null;

  constructor(init: VideoClipSpriteInit) {
    this.layerId = init.layerId;
    this.mediaId = init.mediaId;
    // Start with EMPTY texture; updateFrame() swaps in real frames.
    this.textureSource = new TextureSource({
      width: 1,
      height: 1,
    });
    this.texture = new Texture({ source: this.textureSource });
    this.sprite = new Sprite(this.texture);
  }

  /// Push a decoded frame onto the GPU. No-op if the same frame is
  /// already current (binary-identity check against the FrameRing's
  /// owned VideoFrame).
  updateFrame(frame: VideoFrame): void {
    if (this.currentFrame === frame) return;
    this.currentFrame = frame;
    // Replace the underlying resource. PixiJS v8 TextureSource takes
    // a `resource` field which can be a VideoFrame / ImageBitmap /
    // HTMLVideoElement / etc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.textureSource as any).resource = frame;
    // Force PixiJS to re-upload + invalidate caches.
    this.textureSource.update();
  }

  dispose(): void {
    this.currentFrame = null;
    this.sprite.destroy({ children: true });
    this.texture.destroy(true);
  }
}
