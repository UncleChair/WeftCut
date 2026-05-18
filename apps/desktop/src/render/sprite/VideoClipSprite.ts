// Per-VideoClip sprite. Texture is fed by SourceDecoderPool's
// FrameRing: each composite frame we look up the VideoFrame whose
// presentation interval contains the layer-local time, upload it as
// a texture, and apply the sampled Animated<T> transforms.
//
// Plan: docs/pixi-renderer-plan.md (P1 + P2)
//
// P0 stub — implementation lands in P2.

import { Sprite, Texture } from "pixi.js";

export interface VideoClipSpriteInit {
  layerId: string;
  mediaId: string;
}

export class VideoClipSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly mediaId: string;

  constructor(init: VideoClipSpriteInit) {
    this.layerId = init.layerId;
    this.mediaId = init.mediaId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Update sprite state for composition time `tUs`. P2 implementation
  /// will:
  ///   1. Compute layer-local time = tUs - layer.t_start_us
  ///   2. Look up frame from FrameRing
  ///   3. Texture.from(frame) or sprite.texture.source.update(frame)
  ///   4. Sample Animated<T> transform/opacity channels at tUs
  ///   5. Apply position/scale/rotation/alpha to the sprite
  update(_tUs: number): void {
    // P2
  }

  dispose(): void {
    this.sprite.destroy({ children: true, texture: true });
  }
}
