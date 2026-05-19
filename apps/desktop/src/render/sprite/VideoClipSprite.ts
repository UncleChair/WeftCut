// Per-VideoClip sprite. Texture is fed by SourceDecoderPool's
// FrameRing: each composite frame we look up the VideoFrame whose
// presentation interval contains the layer-local time, build a
// Texture from it, and assign it to the sprite.
//
// Plan: docs/pixi-renderer-plan.md (P2)
//
// Initial state is `Texture.EMPTY` — the canonical PixiJS 1×1 white
// texture that's guaranteed safe in the batched renderer. We allocate
// a real `Texture` only when a decoded `VideoFrame` arrives, and
// destroy the previous one in place so the GPU footprint stays
// bounded.
//
// We deliberately do NOT create a `TextureSource({ width, height })`
// without a `resource` — that combination crashes PixiJS v8's batched
// renderer at shader-compile time when it tries to bind a source with
// no backing GL texture.

import { Sprite, Texture } from "pixi.js";

export interface VideoClipSpriteInit {
  layerId: string;
  mediaId: string;
}

export class VideoClipSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly mediaId: string;
  /// The VideoFrame whose pixels currently sit on the GPU. Borrowed
  /// from FrameRing — we do NOT close it.
  private currentFrame: VideoFrame | null = null;

  constructor(init: VideoClipSpriteInit) {
    this.layerId = init.layerId;
    this.mediaId = init.mediaId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Push a decoded frame onto the GPU. No-op if the same frame is
  /// already current (identity check against the FrameRing's owned
  /// VideoFrame). Destroys the previously-bound texture before
  /// assigning the new one.
  updateFrame(frame: VideoFrame): void {
    if (this.currentFrame === frame) return;
    this.currentFrame = frame;
    const prev = this.sprite.texture;
    // PixiJS v8: `Texture.from` accepts any TexImageSource including
    // VideoFrame. It also caches by source-identity, so a fresh
    // VideoFrame produces a fresh Texture each call.
    const next = Texture.from(frame);
    this.sprite.texture = next;
    // Drop the previous one unless it was the shared empty texture.
    if (prev !== Texture.EMPTY && prev !== next) {
      try {
        prev.destroy(true);
      } catch {
        // Already destroyed elsewhere — ignore.
      }
    }
  }

  dispose(): void {
    this.currentFrame = null;
    const tex = this.sprite.texture;
    this.sprite.destroy({ children: true });
    if (tex !== Texture.EMPTY) {
      try {
        tex.destroy(true);
      } catch {
        // ignore
      }
    }
  }
}
