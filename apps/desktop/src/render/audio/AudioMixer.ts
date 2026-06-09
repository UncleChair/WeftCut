// Per-layer audio playback wrapper. Hides an `<audio>` element off-DOM
// (mounted under a single host element managed by the Compositor),
// keeps it in sync with the engine's master clock, and routes
// play/pause/seek calls through to it.
//
// v1 (this phase): browser-native audio mixing. Each AudioMixer plays
// independently through the default destination; concurrent layers
// are mixed by the OS audio path. Per-layer gain / pan / mute will
// land when we route through a Web Audio graph in a follow-up.
//
// Plan: docs/render.md (P7)

/// Drift threshold beyond which we hard-snap `audio.currentTime` to
/// the engine's expected position. Anything smaller is absorbed by
/// the browser's natural playback ramp (matches the DOM
/// `AudioHandle`'s 100 ms heuristic).
const DRIFT_NUDGE_THRESHOLD_SEC = 0.1;

export interface AudioMixerInit {
  layerId: string;
  audioUrl: string;
  /// Layer's start in composition time (microseconds).
  layerTStartUs: number;
  /// In-point inside the source media (microseconds). For
  /// VideoClips/Audio with no trim this is 0.
  srcInUs: number;
}

export class AudioMixer {
  readonly layerId: string;
  private el: HTMLAudioElement;
  private layerTStartUs: number;
  private srcInUs: number;
  /// Set on `loadedmetadata` — before this fires, `play()` /
  /// `currentTime =` are no-ops.
  private metadataReady = false;
  /// Loud-fail subscriber kept around so `dispose` can remove it.
  private onMetadata: () => void;

  constructor(init: AudioMixerInit, host: HTMLElement) {
    this.layerId = init.layerId;
    this.layerTStartUs = init.layerTStartUs;
    this.srcInUs = init.srcInUs;

    this.el = document.createElement("audio");
    this.el.preload = "auto";
    this.el.style.display = "none";
    this.el.src = init.audioUrl;
    this.onMetadata = (): void => {
      this.metadataReady = true;
    };
    this.el.addEventListener("loadedmetadata", this.onMetadata);
    host.appendChild(this.el);
  }

  /// Update layer-window params if the LayerSummary changed (trim,
  /// move). Idempotent if values are the same.
  updateLayerParams(layerTStartUs: number, srcInUs: number): void {
    this.layerTStartUs = layerTStartUs;
    this.srcInUs = srcInUs;
  }

  /// Engine tick. `masterUs` is the composition-time playhead;
  /// `playing` mirrors `engine.isPlaying()`.
  tick(masterUs: number, playing: boolean, layerTEndUs: number): void {
    if (!this.metadataReady) return;

    // Outside the layer's window: keep silent.
    if (masterUs < this.layerTStartUs || masterUs >= layerTEndUs) {
      if (!this.el.paused) this.el.pause();
      return;
    }

    if (playing && this.el.paused) {
      void this.el.play().catch(() => {
        // Common during the first tick before a user gesture; the
        // engine's `play()` resumes the AudioContext + a fresh play
        // attempt fires after the user clicks play. Subsequent
        // failures are silent.
      });
    } else if (!playing && !this.el.paused) {
      this.el.pause();
    }

    const layerLocalUs = masterUs - this.layerTStartUs + this.srcInUs;
    const targetSec = Math.max(0, layerLocalUs / 1_000_000);

    if (!playing) {
      // Hard-snap when paused — drift is irrelevant here, only
      // accuracy matters for the next play() resume.
      if (Math.abs(this.el.currentTime - targetSec) > 0.005) {
        try {
          this.el.currentTime = targetSec;
        } catch {
          // ignored
        }
      }
      return;
    }

    const drift = this.el.currentTime - targetSec;
    if (Math.abs(drift) > DRIFT_NUDGE_THRESHOLD_SEC) {
      try {
        this.el.currentTime = targetSec;
      } catch {
        // ignored
      }
    }
  }

  dispose(): void {
    this.el.removeEventListener("loadedmetadata", this.onMetadata);
    try {
      this.el.pause();
    } catch {
      // ignored
    }
    if (this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
    // Clear src to release the file handle / decoder resources.
    this.el.src = "";
    this.el.load();
  }
}
