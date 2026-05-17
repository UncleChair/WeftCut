/// Color layer handle — a `<div>` painted with the layer's RGBA fill.
/// Time-invariant other than its `[t_start, t_end]` visibility window.
/// No audio, no media element, no decoder warmup.

import { useProjectStore } from "../../../state/projectStore";
import {
  buildLayerFilter,
  buildLayerOpacityMultiplier,
  buildLayerTransform,
} from "../effects/applyFilter";
import type { HandleContext, LayerHandle } from "./types";

export class ColorHandle implements LayerHandle {
  private div: HTMLDivElement;
  /// Cached `<background, w, h>` sig; skip DOM writes on unchanged.
  private appliedSig: string | null = null;
  private appliedFilter = "";
  private appliedTransform = "";
  private appliedOpacity = -1;
  private disposed = false;

  constructor(private ctx: HandleContext) {
    this.div = document.createElement("div");
    this.div.style.position = "absolute";
    this.div.style.top = "0";
    this.div.style.left = "0";
    this.div.style.visibility = "hidden";
    this.div.style.willChange = "transform, opacity";
    ctx.container.appendChild(this.div);
    this.applyParams();
  }

  tick(masterUs: number, _playing: boolean): void {
    if (this.disposed) return;
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Color") {
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

    const tLocalUs = masterUs - layer.t_start_us;
    const opacityMul = buildLayerOpacityMultiplier(layer.effects, tLocalUs);
    if (Math.abs(this.appliedOpacity - opacityMul) > 0.001) {
      this.appliedOpacity = opacityMul;
      this.div.style.opacity = String(opacityMul);
    }

    const transform = buildLayerTransform(
      { x: 0, y: 0, scale_x: 1, scale_y: 1 },
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
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Color") return;
    const p = layer.params;
    const sig = `${p.color.r},${p.color.g},${p.color.b},${p.color.a}|${p.width}x${p.height}`;
    if (sig === this.appliedSig) return;
    this.appliedSig = sig;
    const alpha = p.color.a / 255;
    this.div.style.background = `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, ${alpha})`;
    this.div.style.width = `${p.width}px`;
    this.div.style.height = `${p.height}px`;
  }
}
