// Text layer rendered via PixiJS native `Text` (canvas-backed glyphs).
// Owns two things Pixi does not do for us: the wrap width (from the layer's
// box) and the placement of the measured block inside that box.
// See docs/render.md, ADR 0049.

import { Text, TextStyle, type Container, type TextStyleFontWeight } from "pixi.js";

import { DEFAULT_CAPTION_FONT_FAMILY } from "../../../shared/fonts";
import type { ResolvedTextView } from "../resolveView";
import type { TextFit } from "../textBox";
import type { StageableSprite } from "./StageableSprite";

export interface TextSpriteInit {
  layerId: string;
}

/// Where the block sits along one axis of the box, as a fraction of the slack.
/// `align` doubles as the horizontal one: Pixi keeps using it for line-to-line
/// alignment WITHIN the block, and the same intent places the block in the box.
const ALIGN_FRAC = { left: 0, center: 0.5, right: 1 } as const;
const VALIGN_FRAC = { Top: 0, Middle: 0.5, Bottom: 1 } as const;

/// Pixi's lowercase alignment vocabulary, and the one place a garbage `align`
/// stops. The renderer half of the same pair as the `(null, set)` guard in
/// `update`: `main/state/mutations/params.ts` refuses an unrecognized
/// `align`/`valign` at the boundary with `InvalidArgument`, so this only fires
/// on a hand-edited project or a writer that bypassed the mutation layer.
function pixiAlign(align: string | undefined): keyof typeof ALIGN_FRAC {
  const a = (align ?? "").toLowerCase();
  return a === "left" || a === "right" ? a : "center";
}

/// A box axis as the renderer will honour it — the same refusal, one layer
/// later. Non-finite or non-positive is not a box: `wordWrapWidth: -5` puts
/// every token on its own line, and `NaN` silently disables wrapping.
function boxAxis(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/// Leading and tracking, ditto: a non-finite value propagates through
/// `CanvasTextMetrics` into every measured width, so it reads as the default.
function finiteOr0(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface BlockInBoxInput {
  /// The rendered block's own extent, LOCAL (pre-`scale`). This is Pixi's
  /// `maxLineWidth` adjusted for stroke and shadow, NOT `wordWrapWidth`
  /// (`CanvasTextMetrics.measureText`), so it can even exceed the box.
  blockW: number;
  blockH: number;
  /// Null = auto on that axis: the box IS the block there.
  boxW: number | null;
  boxH: number | null;
  align: keyof typeof ALIGN_FRAC;
  valign: keyof typeof VALIGN_FRAC;
  /// `Transform.anchor`, taken over the BOX.
  anchorX: number;
  anchorY: number;
}

/// Re-express "anchor the box, place the block inside it" as a Pixi anchor.
///
/// Pixi normalizes `anchor` over the object's OWN bounds and lands that point
/// on `position` (`Text.updateBounds`: `minX = -anchor.x * width`), so the
/// block point that must sit on `(x, y)` is `anchor·box − offset`, divided by
/// the block's extent. No new mechanism, and rotation/scale keep turning about
/// `(x, y)` — a `pivot` would move that center too (see anchorPivot.ts).
///
/// The `??` fallbacks are not dead code the types have already ruled out: the
/// keys arrive from a project file, so an unrecognized `valign: 'Center'`
/// indexes to `undefined`, makes the offset NaN, and hands Pixi a NaN anchor —
/// a VANISHED layer, worse than a misplaced one. `pixiAlign` above names the
/// boundary refusal this is the renderer half of.
export function blockAnchorInBox(i: BlockInBoxInput): { anchorX: number; anchorY: number } {
  return {
    anchorX: anchorAxis(i.blockW, i.boxW, ALIGN_FRAC[i.align] ?? ALIGN_FRAC.center, i.anchorX),
    anchorY: anchorAxis(i.blockH, i.boxH, VALIGN_FRAC[i.valign] ?? VALIGN_FRAC.Middle, i.anchorY),
  };
}

function anchorAxis(block: number, box: number | null, frac: number, anchor: number): number {
  // Auto axis: the box is the block, the offset is 0, and the renormalization
  // below is the identity — returned rather than computed, because
  // `(anchor * block) / block` is not bit-exact in IEEE-754 and Auto width has
  // to stay pixel-for-pixel what it was before the box existed (ADR 0049).
  if (box === null || !Number.isFinite(box) || box <= 0) return anchor;
  // An empty layer measures 0 wide: dividing by it would hand Pixi a NaN
  // transform, which is a vanished layer rather than an invisible one.
  if (!Number.isFinite(block) || block <= 0) return anchor;
  return (anchor * box - frac * (box - block)) / block;
}

export class TextSprite implements StageableSprite {
  readonly text: Text;
  readonly layerId: string;
  /// Cached signature of the last-applied content + style. Skips
  /// the (relatively expensive) glyph re-rasterize when nothing
  /// visible has changed.
  private appliedSig: string | null = null;
  /// Last-applied box, AFTER the (null, set) coalescing below — so the gizmo's
  /// rectangle and the wrap width can never come from different readings of
  /// the same layer.
  private boxW: number | null = null;
  private boxH: number | null = null;
  /// What the last `update` did with the font size, for the `GizmoProbe`
  /// read-back. Held here and not recomputed on demand because the UI must be
  /// told what was RENDERED, and a fresh computation could answer from a style
  /// the frame never saw.
  private fitState: TextFit | null = null;

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

  get displayObject(): Container {
    return this.text;
  }

  /// A Text node has no EMPTY-placeholder phase — always ready.
  get stageReady(): boolean {
    return true;
  }

  /// The rectangle `x`/`y` anchors and the on-canvas gizmo draws: the box when
  /// one is set, the measured glyph bounds otherwise (Text is the one visual
  /// kind with no intrinsic size). LOCAL composition px, pre-`scale`, like
  /// every other kind's natural size. Null while the layer measures empty.
  naturalSize(): { w: number; h: number } | null {
    // Fixed needs no measurement, which also keeps the gizmo's box off the
    // glyph atlas while a drag is resizing it.
    if (this.boxW !== null && this.boxH !== null) return { w: this.boxW, h: this.boxH };
    const b = this.text.getLocalBounds();
    const w = this.boxW ?? b.width, h = this.boxH ?? b.height;
    return w > 0 && h > 0 ? { w, h } : null;
  }

  /// What the last `update` did with the font size — the `GizmoProbe.textFitOf`
  /// read-back. Null before the first update, so "nothing staged" and "no shrink"
  /// stay different answers.
  fit(): TextFit | null {
    return this.fitState;
  }

  update(view: ResolvedTextView): void {
    const o = view.outline, sh = view.shadow;
    const align = pixiAlign(view.align);
    const valign = view.valign;
    // The renderer half of the (null, set) triple defense: box_h without a
    // box_w is not a mode, so it degenerates to Auto width instead of blanking
    // the frame. The other two halves refuse it upstream — an edge-drag gesture
    // backfills box_w in the same commit, and MCP rejects the patch — so this
    // only ever fires on a hand-edited project. Same posture as `anchorOr`.
    const boxW = boxAxis(view.box_w);
    const boxH = boxW === null ? null : boxAxis(view.box_h);
    const lineHeight = finiteOr0(view.line_height);
    const letterSpacing = finiteOr0(view.letter_spacing);
    this.boxW = boxW;
    this.boxH = boxH;
    // Outside Fixed nothing shrinks, so the authored size IS what renders and
    // the box cannot overflow — Auto height grows to hold the block instead.
    this.fitState = {
      authoredPx: view.font_size_px,
      effectivePx: view.font_size_px,
      overflowing: false,
    };
    const sig =
      `${view.content}|${view.font_family}|${view.font_size_px}|${view.weight}|${view.italic}|${align}|` +
      `${view.color.r},${view.color.g},${view.color.b},${view.color.a}|` +
      // The box joins the signature because it IS a measurement input: a wrap
      // width change re-flows the lines. `valign` rides along so the two box
      // axes and their placement can't be read from different generations.
      `${boxW ?? "-"},${boxH ?? "-"},${valign},${lineHeight},${letterSpacing}|` +
      `${o ? `${o.width}:${o.color.r},${o.color.g},${o.color.b}` : "-"}|` +
      `${sh ? `${sh.offset_x},${sh.offset_y},${sh.blur}:${sh.color.r},${sh.color.g},${sh.color.b},${sh.color.a}` : "-"}`;

    if (sig !== this.appliedSig) {
      this.appliedSig = sig;
      const fill = (view.color.r << 16) | (view.color.g << 8) | view.color.b;
      // Re-create the style (TextStyle is mutable but Pixi recommends
      // re-assignment for predictable atlas invalidation).
      this.text.text = view.content;
      this.text.style = new TextStyle({
        fontFamily: view.font_family || DEFAULT_CAPTION_FONT_FAMILY,
        fontSize: view.font_size_px,
        fontWeight: String(view.weight || 400) as TextStyleFontWeight,
        fontStyle: view.italic ? "italic" : "normal",
        align,
        fill,
        lineHeight,
        letterSpacing,
        // A box width is the wrap width; without one the text runs as far as it
        // likes. `breakWords` stays off so Latin words are never split — CJK
        // wraps through `fonts/lineBreak.ts`'s realm-global hook instead.
        wordWrap: boxW !== null,
        wordWrapWidth: boxW ?? 0,
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

    // Per-frame transforms and alpha are cheap and do not rebuild the atlas.
    const anchorX = view.anchor_x ?? 0.5, anchorY = view.anchor_y ?? 0.5;
    // Auto on both axes short-circuits the measurement, not just the
    // arithmetic: there is nothing to place the block against, and Auto width
    // must not start paying for `getLocalBounds` per frame.
    const a =
      boxW === null && boxH === null
        ? { anchorX, anchorY }
        : blockAnchorInBox({
            ...localExtent(this.text),
            boxW,
            boxH,
            align,
            valign,
            anchorX,
            anchorY,
          });
    this.text.anchor.set(a.anchorX, a.anchorY);
    this.text.position.set(view.x, view.y);
    this.text.scale.set(view.scale_x, view.scale_y);
    this.text.angle = view.rotation_deg;
    // Color alpha (Rgba.a) multiplies the layer's `opacity` field.
    this.text.alpha = view.opacity * (view.color.a / 255);
  }

  dispose(): void {
    this.text.destroy({ children: true, texture: true });
  }
}

/// Local bounds are anchor-independent in width/height (`Text.updateBounds`
/// only shifts `minX`/`minY` by the anchor), so reading them to DERIVE the
/// anchor is a one-pass fixed point, not a feedback loop.
function localExtent(text: Text): { blockW: number; blockH: number } {
  const b = text.getLocalBounds();
  return { blockW: b.width, blockH: b.height };
}
