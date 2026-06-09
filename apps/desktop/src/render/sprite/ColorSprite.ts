// Color layer — a flat rectangle of `(width, height)` at the
// composition origin, filled with the layer's animated `Rgba`.
// The Rust schema stores `color: Animated<Rgba>` but the LayerSummary
// view ships only the static-resolved snapshot (`color: Rgba`); per-
// frame keyframe interpolation will arrive when the IPC ships full
// `AnimTrack<T>` (separate work).
//
// Plan: docs/render.md (P3)

import { Graphics } from "pixi.js";

import type { ColorView } from "../../ipc";

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

  update(view: ColorView): void {
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
