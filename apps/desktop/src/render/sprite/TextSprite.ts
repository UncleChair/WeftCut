// Text layer rendered via PixiJS native `Text`.
//
// Plan: docs/render.md (P4 — T1 decision: PixiJS Text
// native canvas)
//
// Implementation: a single `Text` object with a cached style
// signature. Per-frame `update(view)` checks whether the content /
// font / color / size actually changed; if not, no redraw cost. If
// changed, `text` reassigns the content + style.
//
// Limitations vs the legacy DOM TextHandle (parity TBD as needs
// surface):
//   - LayerSummary's TextView ships only flattened content, font,
//     size, color, position, opacity. The Rust schema has
//     additional `align`, `shadow`, `outline`, `intro`, `outro`
//     fields that aren't in the view today; once they appear in
//     LayerSummary we'll plug them in (drop-shadow filter for
//     `shadow`, `stroke` for `outline`, sprite-side keyframe for
//     intros/outros).

import { Text, TextStyle } from "pixi.js";

import type { TextView } from "../../ipc";

export interface TextSpriteInit {
  layerId: string;
}

export class TextSprite {
  readonly text: Text;
  readonly layerId: string;
  /// Cached signature of the last-applied content + style. Skips
  /// the (relatively expensive) glyph re-rasterize when nothing
  /// visible has changed.
  private appliedSig: string | null = null;

  constructor(init: TextSpriteInit) {
    this.layerId = init.layerId;
    this.text = new Text({
      text: "",
      style: new TextStyle({
        fontFamily: "Arial",
        fontSize: 48,
        fill: 0xffffff,
      }),
    });
  }

  update(view: TextView): void {
    const sig =
      `${view.content}|${view.font_family}|${view.font_size_px}|` +
      `${view.color.r},${view.color.g},${view.color.b},${view.color.a}`;

    if (sig !== this.appliedSig) {
      this.appliedSig = sig;
      const fillColor =
        (view.color.r << 16) | (view.color.g << 8) | view.color.b;
      // Re-create the style (TextStyle is mutable but Pixi recommends
      // re-assignment for predictable atlas invalidation).
      this.text.text = view.content;
      this.text.style = new TextStyle({
        fontFamily: view.font_family || "Arial",
        fontSize: view.font_size_px,
        fill: fillColor,
      });
    }

    // Per-frame: position + alpha (cheap — no atlas rebuild).
    this.text.position.set(view.x, view.y);
    // Color alpha (Rgba.a) multiplies the layer's `opacity` field.
    this.text.alpha = view.opacity * (view.color.a / 255);
  }

  dispose(): void {
    this.text.destroy({ children: true, texture: true });
  }
}
