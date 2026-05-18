// Color layer — a flat colored rect at the project canvas dimensions.
//
// Plan: docs/pixi-renderer-plan.md (P3)
//
// P0 stub.

import { Graphics } from "pixi.js";

export interface ColorSpriteInit {
  layerId: string;
  width: number;
  height: number;
}

export class ColorSprite {
  readonly graphics: Graphics;
  readonly layerId: string;
  private width: number;
  private height: number;

  constructor(init: ColorSpriteInit) {
    this.layerId = init.layerId;
    this.width = init.width;
    this.height = init.height;
    this.graphics = new Graphics();
    this.graphics.rect(0, 0, this.width, this.height).fill(0x000000);
  }

  update(_tUs: number): void {
    // P3: sample Animated color → graphics.clear().rect(...).fill(rgba)
    // sample Animated opacity → graphics.alpha
  }

  dispose(): void {
    this.graphics.destroy({ children: true });
  }
}
