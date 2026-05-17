/// Text layer handle — a `<div>` rendering the layer's content via
/// CSS font + color. No fade-window support today (the Rust-side
/// `TextParams` has `intro/outro: Option<TextAnimPreset>` but that
/// isn't surfaced through the IPC view yet; surfacing it is Phase 4
/// keyframe MCP territory).
///
/// CSS-vs-ffmpeg-drawtext kerning + subpixel positioning will differ
/// by 1–2 px from export — accepted by the Q1 fidelity contract.
/// Render & Play is the verification path when it matters.

import { useProjectStore } from "../../../state/projectStore";
import {
  buildLayerFilter,
  buildLayerOpacityMultiplier,
  buildLayerTransform,
} from "../effects/applyFilter";
import type { HandleContext, LayerHandle } from "./types";

export class TextHandle implements LayerHandle {
  private div: HTMLDivElement;
  private appliedSig: string | null = null;
  private appliedOpacity = -1;
  private appliedFilter = "";
  private appliedTransform = "";
  private disposed = false;

  constructor(private ctx: HandleContext) {
    this.div = document.createElement("div");
    this.div.style.position = "absolute";
    this.div.style.top = "0";
    this.div.style.left = "0";
    this.div.style.transformOrigin = "top left";
    this.div.style.willChange = "transform, opacity";
    this.div.style.visibility = "hidden";
    // White-space + line-height tweaks so text wraps the way users
    // expect when they author multi-line content. Width is "auto"
    // (intrinsic) — set explicitly via params if needed later.
    this.div.style.whiteSpace = "pre";
    this.div.style.lineHeight = "1.2";
    this.div.style.pointerEvents = "none";
    ctx.container.appendChild(this.div);
    this.applyParams();
  }

  tick(masterUs: number, _playing: boolean): void {
    if (this.disposed) return;
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Text") {
      this.div.style.visibility = "hidden";
      return;
    }
    if (masterUs < layer.t_start_us || masterUs >= layer.t_end_us) {
      if (this.div.style.visibility !== "hidden") {
        this.div.style.visibility = "hidden";
      }
      return;
    }
    this.applyParams();

    // Static opacity for text — fade_in_us/fade_out_us not exposed
    // on TextView today. When the IPC view picks up the intro/outro
    // presets from TextParams, this becomes a real animated path.
    const tLocalUs = masterUs - layer.t_start_us;
    const opacityMul = buildLayerOpacityMultiplier(layer.effects, tLocalUs);
    const composedOpacity = layer.params.opacity * opacityMul;
    if (Math.abs(this.appliedOpacity - composedOpacity) > 0.001) {
      this.appliedOpacity = composedOpacity;
      this.div.style.opacity = String(composedOpacity);
    }

    const transform = buildLayerTransform(
      {
        x: layer.params.x,
        y: layer.params.y,
        scale_x: 1,
        scale_y: 1,
      },
      layer.effects,
      tLocalUs,
    );
    if (transform !== this.appliedTransform) {
      this.appliedTransform = transform;
      this.div.style.transform = transform;
    }

    const filter = buildLayerFilter(layer.effects, tLocalUs);
    if (filter !== this.appliedFilter) {
      this.appliedFilter = filter;
      this.div.style.filter = filter;
    }

    this.div.style.visibility = "visible";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.div.parentNode) this.div.parentNode.removeChild(this.div);
  }

  private applyParams(): void {
    if (this.disposed) return;
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Text") return;
    const p = layer.params;
    const sig = `${p.content}|${p.font_family}|${p.font_size_px}|${p.color.r},${p.color.g},${p.color.b},${p.color.a}|${p.x}|${p.y}`;
    if (sig === this.appliedSig) return;
    this.appliedSig = sig;

    this.div.textContent = p.content;
    this.div.style.fontFamily = p.font_family;
    this.div.style.fontSize = `${p.font_size_px}px`;
    const alpha = p.color.a / 255;
    this.div.style.color = `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, ${alpha})`;
    // Transform composed per-tick in tick() (HtmlTransform layers on
    // top of the base translate).
  }
}
