// Text layer rendered via PixiJS native `Text`.
//
// Rendered via PixiJS native `Text` (canvas-backed glyphs). See docs/render.md.
//
// Implementation: a single `Text` object with a cached style
// signature. Per-frame `update(view)` checks whether the content /
// font / color / size / style actually changed; if not, no redraw
// cost. If changed, `text` reassigns the content + style.
//
// Style fields rendered: fontWeight, fontStyle, align, fill, stroke
// (from outline), dropShadow (from shadow). Anchor is set every
// frame (cheap — no atlas rebuild).

import { Text, TextStyle, type TextStyleFontWeight } from "pixi.js";

import type { ResolvedTextView } from "../resolveView";

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

  update(view: ResolvedTextView): void {
    const o = view.outline, sh = view.shadow;
    // Default align when field is absent (stale backend / old serialised view).
    const align = ((view.align ?? "Center") as string).toLowerCase() as "left" | "center" | "right";
    const sig =
      `${view.content}|${view.font_family}|${view.font_size_px}|${view.weight}|${view.italic}|${align}|` +
      `${view.color.r},${view.color.g},${view.color.b},${view.color.a}|` +
      `${o ? `${o.width}:${o.color.r},${o.color.g},${o.color.b}` : "-"}|` +
      `${sh ? `${sh.offset_x},${sh.offset_y},${sh.blur}:${sh.color.r},${sh.color.g},${sh.color.b},${sh.color.a}` : "-"}`;

    if (sig !== this.appliedSig) {
      this.appliedSig = sig;
      const fill = (view.color.r << 16) | (view.color.g << 8) | view.color.b;
      // Re-create the style (TextStyle is mutable but Pixi recommends
      // re-assignment for predictable atlas invalidation).
      this.text.text = view.content;
      this.text.style = new TextStyle({
        fontFamily: view.font_family || "Liberation Sans, Noto Sans SC",
        fontSize: view.font_size_px,
        fontWeight: String(view.weight || 400) as TextStyleFontWeight,
        fontStyle: view.italic ? "italic" : "normal",
        align,
        fill,
        ...(o ? { stroke: { color: (o.color.r << 16) | (o.color.g << 8) | o.color.b, width: o.width } } : {}),
        ...(sh
          ? {
              dropShadow: {
                color: (sh.color.r << 16) | (sh.color.g << 8) | sh.color.b,
                blur: sh.blur,
                distance: Math.hypot(sh.offset_x, sh.offset_y),
                angle: Math.atan2(sh.offset_y, sh.offset_x),
                alpha: sh.color.a / 255,
              },
            }
          : {}),
      });
    }

    // Per-frame: anchor + position + alpha (cheap — no atlas rebuild).
    this.text.anchor.set(view.anchor_x ?? 0.5, view.anchor_y ?? 0.5);
    this.text.position.set(view.x, view.y);
    // Color alpha (Rgba.a) multiplies the layer's `opacity` field.
    this.text.alpha = view.opacity * (view.color.a / 255);
  }

  dispose(): void {
    this.text.destroy({ children: true, texture: true });
  }
}
