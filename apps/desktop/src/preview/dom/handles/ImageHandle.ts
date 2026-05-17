/// Image overlay handle — `<img>` element positioned by the layer's
/// transform. Static (no per-frame timing), but the visibility
/// window + opacity + transform are still read each tick to follow
/// keyframe-style edits.

import { convertFileSrc } from "@tauri-apps/api/core";

import { playbackPathFor, useProjectStore } from "../../../state/projectStore";
import {
  buildLayerFilter,
  buildLayerOpacityMultiplier,
  buildLayerTransform,
} from "../effects/applyFilter";
import { resolveFadeOpacity } from "../keyframes/fade";
import type { HandleContext, LayerHandle } from "./types";

const OPACITY_WRITE_THRESHOLD = 0.001;

export class ImageHandle implements LayerHandle {
  private img: HTMLImageElement;
  private currentSrc: string | null = null;
  private appliedOpacity = -1;
  private appliedFilter = "";
  private appliedTransform = "";
  private disposed = false;

  constructor(private ctx: HandleContext) {
    this.img = document.createElement("img");
    this.img.style.position = "absolute";
    this.img.style.top = "0";
    this.img.style.left = "0";
    this.img.style.transformOrigin = "top left";
    this.img.style.willChange = "transform, opacity";
    this.img.style.visibility = "hidden";
    this.img.draggable = false;
    ctx.container.appendChild(this.img);
    this.applyParams();
  }

  tick(masterUs: number, _playing: boolean): void {
    if (this.disposed) return;
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "ImageOverlay") {
      this.img.style.visibility = "hidden";
      return;
    }
    if (masterUs < layer.t_start_us || masterUs >= layer.t_end_us) {
      if (this.img.style.visibility !== "hidden") {
        this.img.style.visibility = "hidden";
      }
      return;
    }
    this.applyParams();

    // Per-tick fade-resolved opacity. Same pattern as VideoClipHandle.
    const params = layer.params;
    const eff = resolveFadeOpacity(
      {
        tStartUs: layer.t_start_us,
        tEndUs: layer.t_end_us,
        fadeInUs: params.fade_in_us,
        fadeOutUs: params.fade_out_us,
        baseOpacity: params.opacity,
      },
      masterUs,
    );
    const tLocalUs = masterUs - layer.t_start_us;
    const opacityMul = buildLayerOpacityMultiplier(layer.effects, tLocalUs);
    const composedOpacity = eff * opacityMul;
    if (Math.abs(this.appliedOpacity - composedOpacity) > OPACITY_WRITE_THRESHOLD) {
      this.appliedOpacity = composedOpacity;
      this.img.style.opacity = String(composedOpacity);
    }

    const transform = buildLayerTransform(
      { x: params.x, y: params.y, scale_x: params.scale_x, scale_y: params.scale_y },
      layer.effects,
      tLocalUs,
    );
    if (transform !== this.appliedTransform) {
      this.appliedTransform = transform;
      this.img.style.transform = transform;
    }

    const filter = buildLayerFilter(layer.effects, tLocalUs);
    if (filter !== this.appliedFilter) {
      this.appliedFilter = filter;
      this.img.style.filter = filter;
    }

    this.img.style.visibility = "visible";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.img.removeAttribute("src");
    if (this.img.parentNode) this.img.parentNode.removeChild(this.img);
  }

  private applyParams(): void {
    const store = useProjectStore.getState();
    const layer = store.layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "ImageOverlay") return;
    const p = layer.params;
    const media = store.mediaById.get(p.media_id);
    const playbackPath = playbackPathFor(media);

    if (playbackPath && playbackPath !== this.currentSrc) {
      this.currentSrc = playbackPath;
      this.img.src = convertFileSrc(playbackPath);
    }
    // Transform now composed per-tick in tick() (HtmlTransform layers
    // on top of base x/y/scale); applyParams owns src only.
  }
}
