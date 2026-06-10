// Color layer — a flat rectangle of `(width, height)` at the
// composition origin, filled with the layer's `Rgba`. The IPC ships the
// full `Animated<Rgba>` track; the Compositor resolves it statically
// (`resolveColorView`) until the Rust `Animated<Rgba>::value_at` twin
// exists to mirror per-frame color interpolation.
//
// Plan: docs/render.md (P3)

import { Graphics } from "pixi.js";

import type { ResolvedColorView } from "../resolveView";

export interface ColorSpriteInit {
  layerId: string;
}

export class ColorSprite {
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
