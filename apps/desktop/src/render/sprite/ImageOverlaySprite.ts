// ImageOverlay sprite. One-time decode via createImageBitmap → texture;
// per-frame sample Animated transform/opacity.
//
// Plan: docs/pixi-renderer-plan.md (P3)
//
// P0 stub.

import { Sprite, Texture } from "pixi.js";

export interface ImageOverlaySpriteInit {
  layerId: string;
  mediaId: string;
}

export class ImageOverlaySprite {
  readonly sprite: Sprite;
  readonly layerId: string;

  constructor(init: ImageOverlaySpriteInit) {
    this.layerId = init.layerId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  async loadFromAsset(_assetUrl: string): Promise<void> {
    // P3: fetch → ArrayBuffer → createImageBitmap → Texture.from(bitmap).
  }

  update(_tUs: number): void {
    // P3: sample Animated transform/opacity/blend_mode.
  }

  dispose(): void {
    this.sprite.destroy({ children: true, texture: true });
  }
}
