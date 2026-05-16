/// Audio layer handle — drives one `<audio>` element through the
/// AudioGraph. No visual surface (audio layers are silent on the
/// preview canvas); just timing + Web Audio routing.
///
/// `gain_db` and `pan` on `AudioView` are applied via the AudioGraph
/// slot's GainNode. `mute` zeros the slot gain. `speed` is `1.0` for
/// audio (no time-stretch in preview); future speed support would
/// need WebAudio's `playbackRate` on the AudioBufferSourceNode path
/// rather than `<audio>.playbackRate` for sample-accurate behavior.

import { convertFileSrc } from "@tauri-apps/api/core";

import { playbackPathFor, useProjectStore } from "../../../state/projectStore";
import type { AudioGraph, LayerSlot } from "../audio/AudioGraph";
import type { HandleContext, LayerHandle } from "./types";

const DRIFT_NUDGE_THRESHOLD_SEC = 0.1;

function dbToLinear(db: number): number {
  // 10^(db / 20). Standard audio engineering conversion.
  return Math.pow(10, db / 20);
}

export class AudioHandle implements LayerHandle {
  private audio: HTMLAudioElement;
  private audioSlot: LayerSlot | null = null;
  private metadataReady = false;
  private currentSrc: string | null = null;
  /// Cached (gainDb, mute) — write to GainNode only on change.
  private appliedGainSig: string | null = null;
  private disposed = false;

  constructor(private ctx: HandleContext) {
    this.audio = document.createElement("audio");
    this.audio.preload = "auto";
    this.audio.addEventListener("loadedmetadata", this.onLoadedMetadata);
    // Audio layers have no visible element, but mounting in the
    // container keeps the DOM tree owned by one parent so dispose
    // can find the node. `display: none` keeps any browser-default
    // audio chrome from showing.
    this.audio.style.display = "none";
    ctx.container.appendChild(this.audio);

    this.applyParams(/*initial=*/ true);
  }

  // ===== LayerHandle =====================================================

  tick(masterUs: number, playing: boolean): void {
    if (this.disposed) return;

    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Audio") return;

    // Outside the layer's window — pause + bail. Even silent
    // playback wastes decoder cycles.
    if (masterUs < layer.t_start_us || masterUs >= layer.t_end_us) {
      if (!this.audio.paused) this.audio.pause();
      return;
    }

    this.applyParams(/*initial=*/ false);

    if (playing && this.audio.paused && this.metadataReady) {
      void this.audio.play().catch(() => {});
    } else if (!playing && !this.audio.paused) {
      this.audio.pause();
    }

    if (!this.metadataReady) return;

    const params = layer.params;
    const localUs = masterUs - layer.t_start_us + params.src_in_us;
    const targetSec = Math.max(0, localUs / 1_000_000);

    if (!playing) {
      if (Math.abs(this.audio.currentTime - targetSec) > 0.005) {
        try {
          this.audio.currentTime = targetSec;
        } catch {
          // ignored
        }
      }
      return;
    }

    const drift = this.audio.currentTime - targetSec;
    if (Math.abs(drift) > DRIFT_NUDGE_THRESHOLD_SEC) {
      try {
        this.audio.currentTime = targetSec;
      } catch {
        // ignored
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.audio.removeEventListener("loadedmetadata", this.onLoadedMetadata);
    if (this.audioSlot) {
      this.audioSlot.dispose();
      this.audioSlot = null;
    }
    try {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    } catch {
      // ignored
    }
    if (this.audio.parentNode) this.audio.parentNode.removeChild(this.audio);
  }

  // ===== Internal =========================================================

  private onLoadedMetadata = () => {
    this.metadataReady = true;
  };

  private applyParams(initial: boolean): void {
    if (this.disposed) return;
    const store = useProjectStore.getState();
    const layer = store.layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Audio") return;

    const media = store.mediaById.get(layer.params.media_id);
    // Audio sources aren't currently proxied (jobs/proxy.rs only
    // handles video), so `playbackPathFor` returns `media.path` for
    // audio. That's fine for browser-decodable formats; flac /
    // exotic codecs may fail and surface in the engine's
    // play() rejection.
    const playbackPath = playbackPathFor(media);

    if (playbackPath && playbackPath !== this.currentSrc) {
      this.currentSrc = playbackPath;
      this.metadataReady = false;
      this.audio.src = convertFileSrc(playbackPath);
      this.wireAudio();
    } else if (initial && playbackPath === null) {
      this.currentSrc = null;
    }

    // Apply gain_db + mute on the AudioGraph slot. The slot uses
    // `linearRampToValueAtTime` internally so changes are click-free.
    const p = layer.params;
    const gainSig = `${p.gain_db}|${p.mute ? 1 : 0}`;
    if (gainSig !== this.appliedGainSig) {
      this.appliedGainSig = gainSig;
      const linearGain = p.mute ? 0 : dbToLinear(p.gain_db);
      this.ctx.audioGraph?.setLayerVolume(this.ctx.layerId, linearGain);
    }
  }

  private wireAudio(): void {
    const ag: AudioGraph | null = this.ctx.audioGraph;
    if (this.audioSlot) {
      this.audioSlot.dispose();
      this.audioSlot = null;
    }
    if (!ag) return;
    try {
      this.audioSlot = ag.attach(this.ctx.layerId, this.audio);
    } catch (e) {
      console.warn(`AudioHandle[${this.ctx.layerId}]: audio attach failed`, e);
    }
  }
}
