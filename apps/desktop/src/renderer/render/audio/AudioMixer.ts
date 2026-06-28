// Per-layer buffer-scheduled audio playback (docs/audio.md §Preview mixer).
// Chunks of conform PCM are read over weftcut-media:// Range (zero decode),
// wrapped as AudioBuffers, and scheduled
// sample-accurately on the AudioContext clock against a play anchor.
//
// Node chain per layer:
//   AudioBufferSourceNode (chunk) → GainNode (envelope automation)
//     → PanGraph (matrix: ChannelSplitter → 4×GainNode → ChannelMerger)
//       → GainNode (trim: micro-fades, re-anchor masking) → AudioGraph.input
//
// The gain/pan envelopes are the sampled-envelope contract
// (`envelope.ts` ↔ Rust `audio::envelope`): identical control points,
// identical linear interpolation — `setValueCurveAtTime` here, per-sample
// lerp in the export mixer.
//
// Clock: the Pixi ticker stays master. Chunks run on the AudioContext
// clock against an anchor pair; each tick compares the audio-predicted
// position with the engine position and re-anchors past 40 ms with a 5 ms
// micro-fade (chunkSchedule.shouldReanchor). The audio-master upgrade is
// specified in docs/audio.md §Out of scope.

import type { AudioView } from "../../ipc";
import type { AudioGraph } from "./AudioGraph";
import {
  type Envelope,
  evalEnvelope,
  sampleGain,
  samplePan,
} from "./envelope";
import { buildPanGraph, constantPanGains, panCurves, type PanGraph } from "./panGraph";
import { ConformSource } from "./conformSource";
import {
  type ClockAnchor,
  MICRO_FADE_S,
  SAMPLE_RATE,
  framesToUs,
  planChunks,
  usToFrames,
} from "./chunkSchedule";

export interface AudioMixerInit {
  layerId: string;
  /// weftcut-media:// URL of the layer's conform file.
  conformUrl: string;
  /// The layer's audio view (gain/pan tracks, fades, src trims, mute).
  view: AudioView;
  /// Layer placement in composition time (µs).
  layerTStartUs: number;
  layerTEndUs: number;
}

export class AudioMixer {
  readonly layerId: string;

  private readonly graph: AudioGraph;
  private readonly gainNode: GainNode;
  private readonly trim: GainNode;
  private panGraph: PanGraph | null = null;
  private panChannels = 0;

  private source: ConformSource | null = null;
  private sourcePending = false;
  private readFailedWarned = false;

  private view: AudioView;
  private layerTStartUs: number;
  private layerTEndUs: number;
  private srcInFrame = 0;
  private srcOutFrame = 0;
  private gainEnv: Envelope;
  private panEnv: Envelope;
  /// Role-bus linear gain folded onto the gain envelope — the preview twin of
  /// `plan_for_project`'s `role_gain` fold; see roleGate.ts. Unity until the
  /// Compositor passes one.
  private roleGainLinear = 1;

  /// The engine's clock anchor as of the last tick — by REFERENCE. The
  /// mixer never takes its own anchor: the playhead and every scheduled
  /// chunk derive from the same pair (chunkSchedule.ClockAnchor), so
  /// there is no second clock to reconcile against. Identity change
  /// (engine re-anchored: seek-during-play, ctx state flip) triggers a
  /// micro-faded reschedule.
  private lastAnchor: ClockAnchor | null = null;
  /// Bumped on teardown; in-flight chunk reads from an older generation
  /// are dropped instead of scheduled.
  private generation = 0;
  private liveChunks = new Map<number, AudioBufferSourceNode | null>();

  constructor(init: AudioMixerInit, graph: AudioGraph) {
    this.layerId = init.layerId;
    this.graph = graph;
    this.view = init.view;
    this.layerTStartUs = init.layerTStartUs;
    this.layerTEndUs = init.layerTEndUs;

    const ctx = graph.ctx;
    this.gainNode = ctx.createGain();
    this.trim = ctx.createGain();
    this.gainNode.connect(this.trim);
    this.trim.connect(graph.input);

    this.gainEnv = { stepUs: 10_000, spanUs: 0, values: [1] };
    this.panEnv = { stepUs: 10_000, spanUs: 0, values: [0] };
    this.deriveFromView();

    void this.openSource(init.conformUrl);
  }

  private async openSource(url: string): Promise<void> {
    if (this.sourcePending) return;
    this.sourcePending = true;
    try {
      this.source = await ConformSource.open(url);
      this.installPanGraph(this.source.header.channels);
      this.deriveFromView();
    } catch (e) {
      console.warn(
        `[weftcut/audio] conform open failed for layer ${this.layerId}:`,
        e,
      );
    } finally {
      this.sourcePending = false;
    }
  }

  /// Splice the pan matrix graph between gainNode and trim, sized to the
  /// conform channel count. Idempotent for a given channel count.
  private installPanGraph(channels: number): void {
    if (this.panGraph && this.panChannels === channels) return;
    const ctx = this.graph.ctx;
    try {
      this.gainNode.disconnect();
    } catch {
      // not yet connected — fine
    }
    this.panGraph?.input.disconnect();
    this.panGraph?.gains.forEach((g) => g.disconnect());
    this.panGraph = buildPanGraph(ctx, channels);
    this.panChannels = channels;
    this.gainNode.connect(this.panGraph.input);
    this.panGraph.output.connect(this.trim);
  }

  private deriveFromView(): void {
    const spanUs = this.view.src_out_us - this.view.src_in_us;
    this.srcInFrame = usToFrames(this.view.src_in_us);
    this.srcOutFrame = usToFrames(this.view.src_out_us);
    this.gainEnv = sampleGain(
      this.view.gain_db,
      this.view.fade_in_us,
      this.view.fade_out_us,
      spanUs,
    );
    this.panEnv = samplePan(this.view.pan, spanUs);
    // Fold the role bus gain (preview twin — see roleGate.ts).
    if (this.roleGainLinear !== 1) {
      for (let i = 0; i < this.gainEnv.values.length; i++) {
        this.gainEnv.values[i]! *= this.roleGainLinear;
      }
    }
    // Constant fast path: park the static value on the param; curves are
    // scheduled per chunk only for non-constant envelopes.
    if (this.gainEnv.values.length === 1) {
      this.gainNode.gain.value = this.gainEnv.values[0]!;
    }
    if (this.panEnv.values.length === 1 && this.panGraph) {
      const g = constantPanGains(this.panEnv, this.panChannels);
      this.panGraph.gains.forEach((node, i) => (node.gain.value = g[i] ?? 0));
    }
  }

  /// Layer summary changed (trim, move, gain/pan/fade edit, mute). Re-derive
  /// envelopes and reschedule — `setValueCurveAtTime` forbids overlapping
  /// automation, so a fresh schedule is the only correct move.
  updateView(
    view: AudioView,
    layerTStartUs: number,
    layerTEndUs: number,
    roleGainLinear: number,
  ): void {
    this.view = view;
    this.layerTStartUs = layerTStartUs;
    this.layerTEndUs = layerTEndUs;
    this.roleGainLinear = roleGainLinear;
    this.teardown(true);
    this.lastAnchor = null;
    this.deriveFromView();
  }

  /// Engine tick. `masterUs` is the composition playhead; `playing`
  /// mirrors the engine transport; `anchor` is the engine's clock anchor
  /// (null while paused or while the AudioContext is suspended — a
  /// suspended context makes no sound, so silence is correct).
  tick(
    masterUs: number,
    playing: boolean,
    layerTEndUs: number,
    anchor: ClockAnchor | null,
  ): void {
    this.layerTEndUs = layerTEndUs;
    if (!this.source) return;

    const inside =
      masterUs >= this.layerTStartUs && masterUs < this.layerTEndUs;
    if (!playing || !inside || this.view.mute || anchor === null) {
      // Keep the resume nudge: the first play often starts with the
      // context suspended (autoplay policy) and a null anchor — resuming
      // here lets the engine's clock flip to audio-derived next tick.
      if (playing && anchor === null) void this.graph.resume();
      if (this.lastAnchor) {
        this.teardown(false);
        this.lastAnchor = null;
      }
      return;
    }

    const ctxNow = this.graph.ctx.currentTime;
    if (this.lastAnchor === null) {
      void this.graph.resume();
      this.rampTrimIn(ctxNow);
    } else if (this.lastAnchor !== anchor) {
      // Engine re-anchored (seek during play / clock-source flip):
      // everything scheduled against the old anchor is mis-timed now.
      this.teardown(true);
      this.rampTrimIn(ctxNow);
    }
    this.lastAnchor = anchor;

    const planned = planChunks({
      masterUs,
      anchor,
      ctxNow,
      layerTStartUs: this.layerTStartUs,
      layerTEndUs: this.layerTEndUs,
      srcInFrame: this.srcInFrame,
      srcOutFrame: this.srcOutFrame,
      liveChunkStarts: [...this.liveChunks.keys()],
    });
    for (const chunk of planned) {
      // Reserve the slot synchronously so the next tick doesn't double-
      // schedule while the Range read is in flight; the placeholder is
      // replaced by the real node on resolve.
      this.liveChunks.set(chunk.srcStartFrame, null);
      void this.scheduleChunk(
        chunk.srcStartFrame,
        chunk.frames,
        chunk.when,
        chunk.bufferOffsetFrames,
        this.generation,
      );
    }
  }

  private async scheduleChunk(
    srcStartFrame: number,
    frames: number,
    when: number,
    bufferOffsetFrames: number,
    gen: number,
  ): Promise<void> {
    const source = this.source;
    if (!source) return;
    let channels: Float32Array<ArrayBuffer>[];
    try {
      channels = await source.readWindow(srcStartFrame, frames);
    } catch (e) {
      // Failed read = this chunk stays silent; drop the reservation so the
      // next tick retries. Warn once per layer.
      if (this.liveChunks.get(srcStartFrame) === null) {
        this.liveChunks.delete(srcStartFrame);
      }
      if (!this.readFailedWarned) {
        this.readFailedWarned = true;
        console.warn(
          `[weftcut/audio] conform read failed for layer ${this.layerId}; chunk muted:`,
          e,
        );
      }
      return;
    }
    if (gen !== this.generation) {
      // Torn down while reading — drop silently.
      if (this.liveChunks.get(srcStartFrame) === null) {
        this.liveChunks.delete(srcStartFrame);
      }
      return;
    }

    const ctx = this.graph.ctx;

    // The Range read is async — by resolve time the planned `when` may
    // already be in the past. Starting the buffer at a past time would
    // play it shifted (overlapping the next chunk's start), and Chromium
    // CLAMPS a past-start setValueCurveAtTime to currentTime, sliding the
    // curve into the next one ("overlaps" NotSupportedError). Recompute
    // lateness now and skip INTO the buffer instead, keeping both the
    // audio and its curves ending exactly on the chunk's grid end. One
    // render quantum (128 frames) of cushion absorbs the µs between this
    // computation and the start() call.
    let startAt = when;
    let offsetFrames = bufferOffsetFrames;
    const ctxNow = ctx.currentTime;
    if (ctxNow > when) {
      const lateFrames = Math.ceil((ctxNow - when) * SAMPLE_RATE) + 128;
      offsetFrames += lateFrames;
      startAt = when + lateFrames / SAMPLE_RATE;
      if (offsetFrames >= frames) {
        // Entirely in the past by now — drop; the next tick replans.
        if (this.liveChunks.get(srcStartFrame) === null) {
          this.liveChunks.delete(srcStartFrame);
        }
        return;
      }
    }

    const buffer = ctx.createBuffer(channels.length, frames, SAMPLE_RATE);
    channels.forEach((data, c) => buffer.copyToChannel(data, c));
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gainNode);
    node.onended = (): void => {
      if (this.liveChunks.get(srcStartFrame) === node) {
        this.liveChunks.delete(srcStartFrame);
      }
    };
    node.start(startAt, offsetFrames / SAMPLE_RATE);
    this.liveChunks.set(srcStartFrame, node);

    this.applyCurves(srcStartFrame, frames, startAt, offsetFrames);
  }

  /// Schedule the envelope curve windows covering this chunk's playback
  /// interval. Chunks are contiguous and non-overlapping on both axes, so
  /// per-chunk curves never violate setValueCurveAtTime's no-overlap rule.
  private applyCurves(
    srcStartFrame: number,
    frames: number,
    when: number,
    bufferOffsetFrames: number,
  ): void {
    const playedFrames = frames - bufferOffsetFrames;
    if (playedFrames <= 0) return;
    const localStartUs = framesToUs(
      srcStartFrame + bufferOffsetFrames - this.srcInFrame,
    );
    const localEndUs = framesToUs(srcStartFrame + frames - this.srcInFrame);
    const durationS = playedFrames / SAMPLE_RATE;

    const cut = (env: Envelope): Float32Array | null => {
      if (env.values.length === 1) return null;
      const n = Math.max(
        2,
        Math.ceil((localEndUs - localStartUs) / 10_000) + 1,
      );
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = localStartUs + ((localEndUs - localStartUs) * i) / (n - 1);
        curve[i] = evalEnvelope(env, t);
      }
      return curve;
    };

    // One sample shorter than the chunk: consecutive curves whose end and
    // start times are bit-identical trip Chromium's setValueCurveAtTime
    // overlap check. The param holds the curve's last value through the
    // 1-sample gap, and the next curve starts at that same value, so the
    // hold is inaudible.
    const curveDurationS = Math.max(durationS - 1 / SAMPLE_RATE, 1 / SAMPLE_RATE);
    try {
      const gainCurve = cut(this.gainEnv);
      if (gainCurve) {
        this.gainNode.gain.setValueCurveAtTime(gainCurve, when, curveDurationS);
      }
      if (this.panGraph && this.panEnv.values.length > 1) {
        const curves = panCurves(
          this.panEnv,
          this.panChannels,
          localStartUs,
          localEndUs,
        );
        curves.forEach((curve, i) => {
          if (curve) {
            this.panGraph!.gains[i]!.gain.setValueCurveAtTime(curve, when, curveDurationS);
          }
        });
      }
    } catch (e) {
      // Overlap rejection here means a scheduling bug upstream — surface
      // it loudly in dev consoles rather than failing silent.
      const detail =
        e instanceof DOMException || e instanceof Error
          ? `${e.name}: ${e.message}`
          : String(e);
      console.warn(
        `[weftcut/audio] envelope curve scheduling failed for layer ${this.layerId}: ${detail}`,
      );
    }
  }

  private rampTrimIn(ctxNow: number): void {
    const g = this.trim.gain;
    g.cancelScheduledValues(ctxNow);
    g.setValueAtTime(0, ctxNow);
    g.linearRampToValueAtTime(1, ctxNow + MICRO_FADE_S);
  }

  /// Stop everything scheduled. `microFade` masks the discontinuity with a
  /// 5 ms trim ramp (re-anchor / live edit); pause paths skip it.
  private teardown(microFade: boolean): void {
    this.generation += 1;
    const ctxNow = this.graph.ctx.currentTime;
    const stopAt = microFade ? ctxNow + MICRO_FADE_S : ctxNow;
    if (microFade) {
      const g = this.trim.gain;
      g.cancelScheduledValues(ctxNow);
      g.setValueAtTime(g.value, ctxNow);
      g.linearRampToValueAtTime(0, stopAt);
    }
    for (const node of this.liveChunks.values()) {
      if (!node) continue;
      try {
        node.onended = null;
        node.stop(stopAt);
        node.disconnect();
      } catch {
        // already stopped — fine
      }
    }
    this.liveChunks.clear();
    try {
      this.gainNode.gain.cancelScheduledValues(0);
      this.panGraph?.gains.forEach((g) => g.gain.cancelScheduledValues(0));
    } catch {
      // ignored
    }
    // Restore constant values (curve re-application happens per chunk).
    if (this.gainEnv.values.length === 1) {
      this.gainNode.gain.value = this.gainEnv.values[0]!;
    }
    if (this.panEnv.values.length === 1 && this.panGraph) {
      const g = constantPanGains(this.panEnv, this.panChannels);
      this.panGraph.gains.forEach((node, i) => (node.gain.value = g[i] ?? 0));
    }
  }

  dispose(): void {
    this.teardown(false);
    try {
      this.gainNode.disconnect();
      this.panGraph?.input.disconnect();
      this.panGraph?.gains.forEach((g) => g.disconnect());
      this.panGraph?.output.disconnect();
      this.trim.disconnect();
    } catch {
      // ignored
    }
    this.source = null;
  }
}
