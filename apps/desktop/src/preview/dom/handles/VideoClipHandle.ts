/// VideoClip layer handle — drives one `<video>` element from the
/// PlaybackEngine's master clock. Reads its current layer params
/// from `useProjectStore` each tick so live MCP edits to transform /
/// opacity / speed propagate without re-mounting the element.
///
/// Drift policy: nudge `<video>.currentTime` only when |drift| > 100 ms
/// (the threshold from `docs/preview-dom.md` Q4). Smaller drifts are
/// absorbed by the browser's own playback ramp.

import { convertFileSrc } from "@tauri-apps/api/core";

import { playbackPathFor, useProjectStore } from "../../../state/projectStore";
import type { LayerSummary } from "../../../ipc";
import type { AudioGraph, LayerSlot } from "../audio/AudioGraph";
import {
  buildLayerFilter,
  buildLayerOpacityMultiplier,
  buildLayerTransform,
} from "../effects/applyFilter";
import { resolveFadeOpacity } from "../keyframes/fade";
import type { HandleContext, LayerHandle } from "./types";

const DRIFT_NUDGE_THRESHOLD_SEC = 0.1;
/// Skip an opacity write if the new value is within this of the
/// applied one. Avoids per-tick DOM churn on static layers and
/// keeps the engine cheap even with many active layers.
const OPACITY_WRITE_THRESHOLD = 0.001;

export class VideoClipHandle implements LayerHandle {
  private video: HTMLVideoElement;
  private audioSlot: LayerSlot | null = null;
  /// True once `loadedmetadata` has fired — we can safely
  /// `play()` / set `currentTime`.
  private metadataReady = false;
  /// Last `proxy_path ?? path` we set on `video.src`. Updates only when
  /// the path actually changes (avoid re-loading on every tick).
  private currentSrc: string | null = null;
  /// Cached layer snapshot we last applied to `video.style` /
  /// `playbackRate`. Skip writes when unchanged to avoid layout
  /// thrash on every tick.
  private appliedSig: string | null = null;
  /// Last opacity value written. Tracked separately from `appliedSig`
  /// because fade ramps need per-tick writes; folding opacity into
  /// the sig would invalidate it every frame during a fade.
  private appliedOpacity = -1;
  /// Last CSS filter string written. Avoids per-tick DOM writes for
  /// static-radius blurs; keyframed radii naturally invalidate via
  /// the changing value.
  private appliedFilter = "";
  /// Last composed transform string written. Keyframed HtmlTransforms
  /// drive per-tick re-composition; the string compare skips DOM
  /// writes when neither base params nor effects produced a delta.
  private appliedTransform = "";
  private disposed = false;

  constructor(private ctx: HandleContext) {
    this.video = document.createElement("video");
    this.video.preload = "auto";
    this.video.playsInline = true;
    this.video.style.position = "absolute";
    this.video.style.top = "0";
    this.video.style.left = "0";
    this.video.style.transformOrigin = "top left";
    this.video.style.willChange = "transform, opacity";
    this.video.style.visibility = "hidden";

    this.video.addEventListener("loadedmetadata", this.onLoadedMetadata);
    ctx.container.appendChild(this.video);

    // Initial src + Web Audio wiring. Both are idempotent on later
    // ticks via the cached sig — but we need them in place before
    // `loadedmetadata` can fire.
    this.applyParams(/*initial=*/ true);
  }

  // ===== LayerHandle =====================================================

  tick(masterUs: number, playing: boolean): void {
    if (this.disposed) return;

    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "VideoClip") {
      this.hide();
      return;
    }

    // Visibility window: [t_start, t_end]. Outside → hide + pause +
    // bail (don't touch currentTime; the next entry-tick can reset).
    if (masterUs < layer.t_start_us || masterUs >= layer.t_end_us) {
      this.hide();
      if (!this.video.paused) this.video.pause();
      return;
    }

    this.applyParams(/*initial=*/ false);

    // Per-tick time-varying state: fade-resolved opacity. Separate
    // from `applyParams` so a fade ramp doesn't invalidate its
    // sig every frame.
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
      this.video.style.opacity = String(composedOpacity);
    }

    const baseSx = (params.flip_h ? -1 : 1) * params.scale_x;
    const baseSy = (params.flip_v ? -1 : 1) * params.scale_y;
    const transform = buildLayerTransform(
      { x: params.x, y: params.y, scale_x: baseSx, scale_y: baseSy },
      layer.effects,
      tLocalUs,
    );
    if (transform !== this.appliedTransform) {
      this.appliedTransform = transform;
      this.video.style.transform = transform;
    }

    const filter = buildLayerFilter(layer.effects, tLocalUs);
    if (filter !== this.appliedFilter) {
      this.appliedFilter = filter;
      this.video.style.filter = filter;
    }

    this.video.style.visibility = "visible";

    // Engine controls play state; mirror to the element.
    if (playing && this.video.paused && this.metadataReady) {
      // play() returns a Promise that rejects if interrupted by a
      // seek; swallow — the next tick re-tries.
      void this.video.play().catch(() => {});
    } else if (!playing && !this.video.paused) {
      this.video.pause();
    }

    // Compute target local time in the source. `speed=1` is the
    // common case; for non-unit speed we also set playbackRate
    // below in applyParams.
    if (!this.metadataReady) return;

    const localUs = (masterUs - layer.t_start_us) * params.speed + params.src_in_us;
    const targetSec = Math.max(0, localUs / 1_000_000);

    if (!playing) {
      // Paused or scrubbing — snap to the exact target so the user
      // sees the frame at master_us. Avoid no-op writes.
      if (Math.abs(this.video.currentTime - targetSec) > 0.005) {
        try {
          this.video.currentTime = targetSec;
        } catch {
          // Element not ready or out of range; ignore.
        }
      }
      return;
    }

    // Playing — only nudge when drift exceeds threshold. Small drifts
    // are absorbed by the browser's playback ramp; nudging too
    // aggressively causes audible+visible hitches.
    const drift = this.video.currentTime - targetSec;
    if (Math.abs(drift) > DRIFT_NUDGE_THRESHOLD_SEC) {
      try {
        this.video.currentTime = targetSec;
      } catch {
        // ignored
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.video.removeEventListener("loadedmetadata", this.onLoadedMetadata);
    if (this.audioSlot) {
      this.audioSlot.dispose();
      this.audioSlot = null;
    }
    try {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load(); // hint the browser to drop the decoder
    } catch {
      // ignored
    }
    if (this.video.parentNode) this.video.parentNode.removeChild(this.video);
  }

  // ===== Internal =========================================================

  private onLoadedMetadata = () => {
    this.metadataReady = true;
  };

  /// Set src + style + playbackRate from the current layer snapshot.
  /// Idempotent — short-circuits when the cached sig matches.
  ///
  /// `initial=true` from the constructor: force src + audio wiring
  /// even when the cached sig hasn't been seeded yet.
  private applyParams(initial: boolean): void {
    if (this.disposed) return;
    const store = useProjectStore.getState();
    const layer = store.layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "VideoClip") return;

    const media = store.mediaById.get(layer.params.media_id);
    const playbackPath = playbackPathFor(media);

    // Src change — reload + re-wire audio. Skip if same path.
    if (playbackPath && playbackPath !== this.currentSrc) {
      this.currentSrc = playbackPath;
      this.metadataReady = false;
      this.video.src = convertFileSrc(playbackPath);
      this.wireAudio();
    } else if (initial && playbackPath === null) {
      // No path resolvable yet — leave src empty; subsequent ticks
      // can populate when the media derivative job lands.
      this.currentSrc = null;
    }

    // Visual state — produce a sig string so we don't touch the
    // DOM unless something actually changed. Element size comes
    // from the SOURCE's native dimensions (not the proxy's), so
    // `scale_x=1.0` produces the same visual size export will
    // emit: ffmpeg's Scale node operates on source pixels too.
    //
    // The proxy's native resolution (540p / 1080p / canvas-capped
    // per the workspace setting) is rescaled by the browser to
    // fit whatever CSS size we declare here — quality suffers when
    // upscaling, but that's the explicit fidelity trade-off of
    // proxy-everywhere from `docs/preview-dom.md` Q3.
    //
    // `opacity` is NOT in this sig; per-tick fade resolution owns
    // the opacity write (see `tick`).
    const p = layer.params;
    const srcW = media?.width ?? 0;
    const srcH = media?.height ?? 0;
    const sig = `${srcW}|${srcH}|${p.x}|${p.y}|${p.scale_x}|${p.scale_y}|${p.speed}|${p.flip_h ? 1 : 0}|${p.flip_v ? 1 : 0}`;
    if (sig === this.appliedSig) return;
    this.appliedSig = sig;

    if (srcW > 0 && srcH > 0) {
      this.video.style.width = `${srcW}px`;
      this.video.style.height = `${srcH}px`;
    }

    // Transform is now composed per-tick in tick() so HtmlTransform
    // effects can layer on top — see buildLayerTransform. applyParams
    // owns dimensions + playbackRate only.
    this.video.playbackRate = Math.max(0.0625, p.speed); // browsers clamp to 0.0625–16
  }

  private wireAudio(): void {
    const ag: AudioGraph | null = this.ctx.audioGraph;
    if (this.audioSlot) {
      this.audioSlot.dispose();
      this.audioSlot = null;
    }
    if (!ag) return;
    try {
      this.audioSlot = ag.attach(this.ctx.layerId, this.video);
    } catch (e) {
      console.warn(`VideoClipHandle[${this.ctx.layerId}]: audio attach failed`, e);
    }
  }

  private hide(): void {
    if (this.video.style.visibility !== "hidden") {
      this.video.style.visibility = "hidden";
    }
  }

  /// Exposed for the Layer component's debug + the engine's drift
  /// inspector. Not load-bearing.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _debug(): { metadataReady: boolean; currentSrc: string | null } {
    return { metadataReady: this.metadataReady, currentSrc: this.currentSrc };
  }

  /// Same caller — fine to read layer snapshot here for tests.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _readLayer(): LayerSummary | undefined {
    return useProjectStore.getState().layerById.get(this.ctx.layerId);
  }
}
