// Subtitles via libass-wasm (JASSUB). The JASSUB renderer paints into
// its own offscreen canvas at libass's own cadence; we sample that
// canvas as a PixiJS texture each frame and draw as a full-stage
// sprite covering the composition.
//
// Plan: docs/pixi-renderer-plan.md (P6)
//
// P0 stub.

import { Sprite, Texture } from "pixi.js";

export interface SubtitlesSpriteInit {
  layerId: string;
}

export class SubtitlesSprite {
  readonly sprite: Sprite;
  readonly layerId: string;

  constructor(init: SubtitlesSpriteInit) {
    this.layerId = init.layerId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  async loadAss(_assBody: string, _width: number, _height: number): Promise<void> {
    // P6: create JASSUB instance with an offscreen canvas of size
    // (width, height), feed ASS body, hook the per-frame setCurrentTime
    // → wrap output canvas as Texture.from(canvas).
  }

  update(_tUs: number): void {
    // P6: call jassub.setCurrentTime(tUs / 1e6), invalidate texture.
  }

  dispose(): void {
    this.sprite.destroy({ children: true, texture: true });
  }
}
