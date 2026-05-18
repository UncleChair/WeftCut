// Web Audio mixer for preview. Ported from preview/dom/audio/AudioGraph.
// Wires audioCtx.currentTime into the SyntheticClock's drift correction.
//
// Plan: docs/pixi-renderer-plan.md (P7)
//
// P0 stub. P7 ports the existing implementation.

export class AudioGraph {
  readonly ctx: AudioContext;
  private master: GainNode;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== "running") {
      await this.ctx.resume();
    }
  }

  muteMaster(): void {
    this.master.gain.value = 0;
  }

  unmuteMaster(): void {
    this.master.gain.value = 1;
  }

  dispose(): void {
    void this.ctx.close();
  }
}
