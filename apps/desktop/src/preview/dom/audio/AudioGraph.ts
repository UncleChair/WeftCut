/// Phase A.6 — Web Audio mixer for the DOM preview.
///
/// Owns a single `AudioContext` + master `GainNode`. Provides
/// per-layer `attach(element, layerId)` that wires an
/// `HTMLMediaElement` through `createMediaElementSource` → layer
/// `GainNode` → master `GainNode` → `destination`. Exposes
/// click-free volume + mute via `linearRampToValueAtTime`.
///
/// Designed in `docs/preview-dom.md` Q4 (γ): the AudioGraph is the
/// **mixer**, not the **clock**. The PlaybackEngine's synthetic
/// `performance.now()` clock drives timing; this graph mixes whatever
/// audio happens to be playing at sample-level fidelity.
///
/// Critical footgun (also flagged in plan risks): once a
/// `<video>` / `<audio>` element is routed via
/// `createMediaElementSource()`, the element NO LONGER plays through
/// its own output — only through the returned source's connected
/// graph. Forgetting to connect down to `destination` produces
/// silent video with no error. `attach()` enforces the full chain on
/// every call.
///
/// AudioContext autoplay policy: Chromium suspends contexts created
/// before any user gesture. Call `resume()` (or trigger the engine's
/// `play()` after a real click) to make sound audible.

const DEFAULT_RAMP_MS = 30;
const MUTE_RAMP_MS = 50;

export interface LayerSlot {
  readonly layerId: string;
  /// Live `GainNode` for this layer. Use `setVolume(layerId, v)`
  /// rather than touching `gain.value` directly — direct writes
  /// zipper.
  readonly gain: GainNode;
  /// Detach the element + dispose this slot. Idempotent; safe to
  /// call multiple times. The graph removes the slot's entry from
  /// its registry on the first call.
  dispose(): void;
}

export class AudioGraph {
  private ctx: AudioContext;
  private master: GainNode;
  /// Pre-mute volume — restored on `unmuteMaster`. Set on the first
  /// `muteMaster()` call so successive scrub begins / ends don't
  /// stomp on a user volume change made between them.
  private preMuteMasterGain = 1;
  private muted = false;
  private disposed = false;
  /// `layerId → slot`. Each slot caches the source + layer gain so
  /// the engine can adjust volume without rewiring.
  private slots = new Map<string, InternalSlot>();
  /// Elements already routed through `createMediaElementSource` —
  /// calling that twice on the same element throws
  /// `InvalidStateError`. Cache so a re-mount of the same layer
  /// (HMR / strict-mode double-render) is detected and reuses the
  /// existing source rather than failing.
  private sourcesByElement = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
  }

  // ===== Lifecycle ========================================================

  /// AudioContext starts `suspended` on Chromium without a user
  /// gesture. Engine's `play()` should `await ctx.resume()` (or have
  /// the user click play, which counts as a gesture and lets
  /// `resume()` succeed). No-op if already running.
  async resume(): Promise<void> {
    if (this.disposed) return;
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch (e) {
        console.warn("AudioGraph: ctx.resume() failed:", e);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, slot] of this.slots) {
      this.disposeSlotInternal(slot);
    }
    this.slots.clear();
    try {
      this.master.disconnect();
    } catch {
      // Already disconnected.
    }
    void this.ctx.close().catch(() => {});
  }

  // ===== Slot lifecycle ===================================================

  /// Wire an `HTMLMediaElement` into the graph for `layerId`. Returns
  /// a `LayerSlot` whose `.gain` the engine ramps for fade automation
  /// or per-layer volume changes. Idempotent: calling twice for the
  /// same layerId disposes the prior slot first.
  ///
  /// The element's `.muted` is set to `false` — Web Audio handles
  /// gain; element-level mute would silence the graph entirely. If
  /// you want this layer silent, set `.gain.value = 0` via
  /// `setVolume(layerId, 0)`.
  attach(layerId: string, element: HTMLMediaElement): LayerSlot {
    if (this.disposed) {
      throw new Error("AudioGraph: attach() called after dispose()");
    }
    const existing = this.slots.get(layerId);
    if (existing) {
      this.disposeSlotInternal(existing);
      this.slots.delete(layerId);
    }

    // `createMediaElementSource` throws on second call for the same
    // element. Cache + reuse so HMR / strict-mode double-mount don't
    // explode.
    let source = this.sourcesByElement.get(element);
    if (!source) {
      source = this.ctx.createMediaElementSource(element);
      this.sourcesByElement.set(element, source);
    }
    element.muted = false;

    const layerGain = this.ctx.createGain();
    layerGain.gain.value = 1;

    // The footgun-prone chain. If any of these three connect() calls
    // is missing, audio vanishes silently.
    source.connect(layerGain);
    layerGain.connect(this.master);

    const internal: InternalSlot = {
      layerId,
      source,
      gain: layerGain,
      disposed: false,
    };
    this.slots.set(layerId, internal);

    const slot: LayerSlot = {
      layerId,
      gain: layerGain,
      dispose: () => {
        this.detach(layerId);
      },
    };
    return slot;
  }

  /// Remove the slot for `layerId`. No-op if not attached.
  detach(layerId: string): void {
    const slot = this.slots.get(layerId);
    if (!slot) return;
    this.slots.delete(layerId);
    this.disposeSlotInternal(slot);
  }

  // ===== Volume + mute ====================================================

  /// Click-free volume change for one layer. Ramps over
  /// `ms` (default 30 ms) so fader scrubs / fade-in/out keyframes
  /// don't zipper.
  setLayerVolume(layerId: string, value: number, ms = DEFAULT_RAMP_MS): void {
    const slot = this.slots.get(layerId);
    if (!slot) return;
    this.rampGain(slot.gain, value, ms);
  }

  /// Click-free master volume change. Use the engine's scrub-mute
  /// path (`muteMaster` / `unmuteMaster`) rather than calling
  /// `setMasterVolume(0)` so pre-mute volume is preserved.
  setMasterVolume(value: number, ms = DEFAULT_RAMP_MS): void {
    this.rampGain(this.master, value, ms);
  }

  /// Smoothly mute the master output. Engine calls this on scrub
  /// begin. Idempotent: stacked calls don't double-bury the
  /// pre-mute volume.
  muteMaster(): void {
    if (this.muted) return;
    this.muted = true;
    this.preMuteMasterGain = Math.max(0, this.master.gain.value);
    this.rampGain(this.master, 0, MUTE_RAMP_MS);
  }

  /// Restore pre-mute master gain. Engine calls on scrub end.
  unmuteMaster(): void {
    if (!this.muted) return;
    this.muted = false;
    this.rampGain(this.master, this.preMuteMasterGain, MUTE_RAMP_MS);
  }

  // ===== Diagnostics ======================================================

  /// True iff the AudioContext is running (i.e. audio can actually
  /// reach the output device). Useful for surfacing "click play to
  /// enable audio" hints when the autoplay policy has the context
  /// suspended.
  isRunning(): boolean {
    return !this.disposed && this.ctx.state === "running";
  }

  // ===== Internal =========================================================

  private rampGain(node: GainNode, target: number, ms: number): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const t1 = t0 + ms / 1000;
    // `cancelScheduledValues` plus `setValueAtTime(current, now)` is
    // the canonical "stop any in-flight ramp and start a new one
    // from where we are right now" pattern. Without it, an overlapping
    // ramp can produce audible glitches.
    node.gain.cancelScheduledValues(t0);
    node.gain.setValueAtTime(node.gain.value, t0);
    node.gain.linearRampToValueAtTime(target, t1);
  }

  private disposeSlotInternal(slot: InternalSlot): void {
    if (slot.disposed) return;
    slot.disposed = true;
    try {
      slot.source.disconnect();
    } catch {
      // Already disconnected — the same source can't be reused for
      // a different layerId because of `createMediaElementSource`'s
      // one-per-element rule.
    }
    try {
      slot.gain.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

interface InternalSlot {
  layerId: string;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  disposed: boolean;
}
