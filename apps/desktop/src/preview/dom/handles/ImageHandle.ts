/// Image overlay handle — `<img>` element positioned by the layer's
/// transform. Static (no per-frame timing), but the visibility
/// window + opacity + transform are still read each tick to follow
/// keyframe-style edits.

import { convertFileSrc } from "@tauri-apps/api/core";

import { playbackPathFor, useProjectStore } from "../../../state/projectStore";
import type { HandleContext, LayerHandle } from "./types";

export class ImageHandle implements LayerHandle {
  private img: HTMLImageElement;
  private currentSrc: string | null = null;
  private appliedSig: string | null = null;
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

    const sig = `${p.x}|${p.y}|${p.scale_x}|${p.scale_y}|${p.opacity}`;
    if (sig === this.appliedSig) return;
    this.appliedSig = sig;
    this.img.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.scale_x}, ${p.scale_y})`;
    this.img.style.opacity = String(p.opacity);
  }
}
