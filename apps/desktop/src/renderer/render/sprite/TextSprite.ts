// Text layer rendered via PixiJS native `Text` (canvas-backed glyphs).
// Owns three things Pixi does not do for us: the wrap width (from the layer's
// box), the placement of the measured block inside that box, and the size the
// glyphs are actually drawn at when the box is too small for them.
// See docs/render.md, ADR 0049.

import { CanvasTextMetrics, Text, TextStyle, type Container, type TextStyleFontWeight } from "pixi.js";

import { DEFAULT_CAPTION_FONT_FAMILY } from "../../../shared/fonts";
import type { ResolvedTextView } from "../resolveView";
import { fitFontSize, type TextFit } from "../textBox";
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

/// Everything the applied `TextStyle` needs except the size, which shrink-to-fit
/// searches for against one of these.
interface StyleInput {
  view: ResolvedTextView;
  align: keyof typeof ALIGN_FRAC;
  /// Already coalesced — the wrap width, or null for no wrapping at all.
  boxW: number | null;
  /// AUTHORED leading and tracking. The shrink factor is applied to them below,
  /// so a caller that pre-scaled them would compress them twice.
  lineHeight: number;
  letterSpacing: number;
}

/// The style at one candidate size: the shrink search's probe and, at the winning
/// size, the style that renders. One function for both, so a probe can never
/// measure something other than what the frame gets.
///
/// Outline, shadow, leading and tracking are all multiplied by `px /
/// font_size_px` here and nowhere else — derived like the size itself, never
/// written back to state. Everything authored in pixels AGAINST THE GLYPHS has to
/// compress with them, for one reason wearing several faces: an absolute 4 px
/// outline around text compressed to 43% reads as a smeared border, and an
/// absolute 80 px leading over 8 px glyphs reads as broken spacing.
/// `native/src/subtitles/layout.rs` already treats an outline as `size * 0.06` at
/// import, so an absolute width surviving the compression would contradict the
/// importer's own model. ADR 0049.
///
/// Scaling the leading is also what lets the search CONVERGE: an absolute height
/// term no bisection can shrink drives a box shorter than one authored line to
/// the 8 px floor however small the glyphs get, and reports overflow on a case
/// the feature is supposed to handle.
function textStyleFor(i: StyleInput, px: number): TextStyle {
  const v = i.view, o = v.outline, sh = v.shadow;
  // Exactly 1 whenever nothing shrank, and `line_height: 0` — auto, the font's
  // own metrics — stays 0 under any factor. Both `× 1.0` and `0 ×` are exact in
  // IEEE-754, so Auto width and the default leading are bit-for-bit what they
  // were before the box existed.
  const f = v.font_size_px > 0 ? px / v.font_size_px : 1;
  const offX = (sh?.offset_x ?? 0) * f, offY = (sh?.offset_y ?? 0) * f;
  return new TextStyle({
    fontFamily: v.font_family || DEFAULT_CAPTION_FONT_FAMILY,
    fontSize: px,
    fontWeight: String(v.weight || 400) as TextStyleFontWeight,
    fontStyle: v.italic ? "italic" : "normal",
    align: i.align,
    fill: (v.color.r << 16) | (v.color.g << 8) | v.color.b,
    lineHeight: i.lineHeight * f,
    letterSpacing: i.letterSpacing * f,
    // A box width is the wrap width; without one the text runs as far as it
    // likes. `breakWords` stays off so Latin words are never split — CJK wraps
    // through `fonts/lineBreak.ts`'s realm-global hook instead.
    wordWrap: i.boxW !== null,
    wordWrapWidth: i.boxW ?? 0,
    ...(o
      ? { stroke: { color: (o.color.r << 16) | (o.color.g << 8) | o.color.b, width: o.width * f } }
      : {}),
    ...(sh
      ? {
          dropShadow: {
            color: (sh.color.r << 16) | (sh.color.g << 8) | sh.color.b,
            blur: sh.blur * f,
            distance: Math.hypot(offX, offY),
            angle: Math.atan2(offY, offX),
            alpha: sh.color.a / 255,
          },
        }
      : {}),
  });
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
  /// the frame never saw. Written only inside the `appliedSig` gate: every input
  /// to the shrink search is in that signature, so an unchanged signature means
  /// this is still the answer.
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
    const sig =
      `${view.content}|${view.font_family}|${view.font_size_px}|${view.weight}|${view.italic}|${align}|` +
      `${view.color.r},${view.color.g},${view.color.b},${view.color.a}|` +
      // The box joins the signature because it IS a measurement input: a wrap
      // width change re-flows the lines. `valign` rides along so the two box
      // axes and their placement can't be read from different generations.
      // Every input to the shrink search below is in this signature — content,
      // family, size, weight, italic, box, leading, tracking, outline width,
      // shadow geometry — which is what lets the search live inside the gate and
      // cost an unchanged box zero re-measures per frame.
      `${boxW ?? "-"},${boxH ?? "-"},${valign},${lineHeight},${letterSpacing}|` +
      `${o ? `${o.width}:${o.color.r},${o.color.g},${o.color.b}` : "-"}|` +
      `${sh ? `${sh.offset_x},${sh.offset_y},${sh.blur}:${sh.color.r},${sh.color.g},${sh.color.b},${sh.color.a}` : "-"}`;

    if (sig !== this.appliedSig) {
      this.appliedSig = sig;
      const si: StyleInput = { view, align, boxW, lineHeight, letterSpacing };
      // Shrink belongs to Fixed alone, with no exceptions to remember: Auto
      // height narrower than one glyph overflows HORIZONTALLY instead of
      // shrinking, which is what keeps a caption at exactly the size its style
      // asked for. Outside Fixed the authored size IS what renders, and there is
      // no second dimension for the block to fail to fit. ADR 0049.
      let style: TextStyle | null = null;
      if (boxW !== null && boxH !== null) {
        // Probe styles are kept so the WINNER can be the style that renders:
        // `TextStyle.styleKey` is per-instance (`uid-tick`), so a freshly minted
        // style at the same size would miss `CanvasTextMetrics`'s measurement
        // cache and make Pixi measure the chosen size all over again on render.
        const probes = new Map<number, TextStyle>();
        this.fitState = fitFontSize({
          authoredPx: view.font_size_px,
          boxW,
          boxH,
          measure: (px) => {
            const s = textStyleFor(si, px);
            probes.set(px, s);
            // No explicit wrap argument: the style says `wordWrap: true`, and
            // reading it from there is what keeps this cache key identical to
            // the one `Text.updateBounds` computes for the same style.
            const m = CanvasTextMetrics.measureText(view.content, s);
            return { w: m.width, h: m.height };
          },
        });
        style = probes.get(this.fitState.effectivePx) ?? null;
      } else {
        this.fitState = {
          authoredPx: view.font_size_px,
          effectivePx: view.font_size_px,
          overflowing: false,
        };
      }
      // Re-create the style (TextStyle is mutable but Pixi recommends
      // re-assignment for predictable atlas invalidation).
      this.text.text = view.content;
      this.text.style = style ?? textStyleFor(si, this.fitState.effectivePx);
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
