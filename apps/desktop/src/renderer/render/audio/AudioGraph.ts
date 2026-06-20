// Master audio bus for the preview mixer (docs/audio.md §Preview mixer):
//
//   layer chains → input (GainNode, master mute)
//                → analyser (meter tap)
//                → DynamicsCompressor (−1 dB / 20:1 / 1 ms — soft overload
//                  protection; the export-side alimiter is the contract,
//                  this is the preview approximation)
//                → destination
//
// The meter is engine plumbing in this slice: surfaced to the dev PerfHUD
// and over MCP, no product UI (mixer UI belongs to the UX redesign).

export interface MeterSnapshot {
  /// dBFS; -Infinity when silent.
  rmsDb: number;
  peakDb: number;
}

export function linearToDb(v: number): number {
  if (v <= 0) return -Infinity;
  return 20 * Math.log10(v);
}

export class AudioGraph {
  readonly ctx: AudioContext;
  private readonly inputNode: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly meterBuf: Float32Array<ArrayBuffer>;

  constructor() {
    // 48 kHz to match the conform canonical rate; if the device forces a
    // different rate the context resamples AudioBuffers transparently.
    this.ctx = new AudioContext({ sampleRate: 48_000 });

    this.inputNode = this.ctx.createGain();
    this.inputNode.gain.value = 1;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.2;
    // Explicit ArrayBuffer so the strict Float32Array<ArrayBuffer>
    // analyser overload accepts it.
    this.meterBuf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -1;
    this.compressor.ratio.value = 20;
    this.compressor.attack.value = 0.001;
    this.compressor.release.value = 0.25;
    this.compressor.knee.value = 0;

    this.inputNode.connect(this.analyser);
    this.analyser.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);
  }

  /// The node layer chains connect to.
  get input(): GainNode {
    return this.inputNode;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== "running") {
      await this.ctx.resume();
    }
  }

  setMasterMute(muted: boolean): void {
    this.inputNode.gain.value = muted ? 0 : 1;
  }

  // Boolean-free aliases for setMasterMute(true/false).
  muteMaster(): void {
    this.setMasterMute(true);
  }

  unmuteMaster(): void {
    this.setMasterMute(false);
  }

  /// One combined-channel RMS + peak read off the analyser. Per-channel
  /// splitting is future work.
  meterSnapshot(): MeterSnapshot {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const s = this.meterBuf[i]!;
      sumSq += s * s;
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sumSq / this.meterBuf.length);
    return { rmsDb: linearToDb(rms), peakDb: linearToDb(peak) };
  }

  dispose(): void {
    try {
      this.inputNode.disconnect();
      this.analyser.disconnect();
      this.compressor.disconnect();
    } catch {
      // best-effort
    }
    void this.ctx.close();
  }
}
