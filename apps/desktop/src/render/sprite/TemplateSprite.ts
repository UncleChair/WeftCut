// Template layer rendered via foreignObject SVG raster → texture.
// Texture cached by content hash; only re-rasterizes on prop edits
// or font changes.
//
// Plan: docs/pixi-renderer-plan.md (P5 — β: always raster, cached)
//
// P0 stub.

import { Sprite, Texture } from "pixi.js";

export interface TemplateSpriteInit {
  layerId: string;
  templateId: string;
}

export class TemplateSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly templateId: string;

  constructor(init: TemplateSpriteInit) {
    this.layerId = init.layerId;
    this.templateId = init.templateId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  async rasterize(_props: unknown, _width: number, _height: number): Promise<void> {
    // P5: build SVG with <foreignObject><body>{html}</body></foreignObject>,
    // embed @font-face base64, createImageBitmap → Texture.
  }

  update(_tUs: number): void {
    // P5: sample Animated transform/opacity, apply to sprite.
  }

  dispose(): void {
    this.sprite.destroy({ children: true, texture: true });
  }
}
