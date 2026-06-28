// Color layer — a flat rectangle of `(width, height)` at the
// composition origin, filled with the layer's `Rgba`. The IPC ships the
// full `Animated<Rgba>` track; the Compositor resolves it per-frame via
// `resolveColorView` (OkLab interpolation through the wasm eval twin).
//
// See docs/render.md (color layers).

import { Graphics, type Container } from "pixi.js";

import type { ResolvedColorView } from "../resolveView";
import type { StageableSprite } from "./StageableSprite";

export interface ColorSpriteInit {
  layerId: string;
}

export class ColorSprite implements StageableSprite {
  readonly graphics: Graphics;
  readonly layerId: string;
  /// Cached signature of the most recently-drawn fill. Skips the
  /// per-frame `graphics.clear().rect().fill()` cycle when nothing
  /// visible has changed.
  private appliedSig: string | null = null;

  constructor(init: ColorSpriteInit) {
    this.layerId = init.layerId;
    this.graphics = new Graphics();
  }

  get displayObject(): Container {
    return this.graphics;
  }

  /// A Graphics fill has no EMPTY-placeholder phase — always ready.
  get stageReady(): boolean {
    return true;
  }

  update(view: ResolvedColorView): void {
    const sig = `${view.color.r},${view.color.g},${view.color.b},${view.color.a}|${view.width}x${view.height}`;
    if (sig === this.appliedSig) return;
    this.appliedSig = sig;
    // Pixi v8 Color accepts `{r,g,b,a}` with components in 0–255 by
    // default. The schema's Rgba uses 0–255 for all four channels,
    // so we pass through.
    const fillColor = (view.color.r << 16) | (view.color.g << 8) | view.color.b;
    const fillAlpha = view.color.a / 255;
    this.graphics.clear();
    this.graphics
      .rect(0, 0, view.width, view.height)
      .fill({ color: fillColor, alpha: fillAlpha });
  }

  dispose(): void {
    this.graphics.destroy({ children: true });
  }
}
