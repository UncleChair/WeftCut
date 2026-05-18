// Synthetic clock with optional Web Audio drift correction.
//
// Plan: docs/pixi-renderer-plan.md (8a.2 — synthetic + Web Audio drift)
//
// Behavior:
//   - When no audio context is bound, clock advances by `performance.now()` deltas.
//   - When an `AudioContext` is bound and running, clock nudges its
//     synthetic position toward `audioCtx.currentTime - audioCtx.baseLatency`
//     by a fraction of the drift each tick. Bounded drift (<1 frame).
//
// P1 will implement the drift-correction loop and integrate with
// PlaybackEngine's RAF tick.

export interface ClockTickInfo {
  /// Current composition time in microseconds.
  tUs: number;
  /// Wall-clock delta in microseconds since the previous tick.
  dtUs: number;
}

export class SyntheticClock {
  private _tUs = 0;
  private _playing = false;
  private _lastWallMs: number | null = null;
  private _audioCtx: AudioContext | null = null;
  /// When non-null, every tick nudges `_tUs` toward
  /// `audioCtx.currentTime * 1e6` by this fraction of the drift.
  private _driftFraction = 0.1;

  bindAudio(ctx: AudioContext | null): void {
    this._audioCtx = ctx;
  }

  setDriftFraction(f: number): void {
    this._driftFraction = Math.max(0, Math.min(1, f));
  }

  play(): void {
    if (this._playing) return;
    this._playing = true;
    this._lastWallMs = performance.now();
  }

  pause(): void {
    this._playing = false;
    this._lastWallMs = null;
  }

  isPlaying(): boolean {
    return this._playing;
  }

  /// Hard-set the composition position. Called by `seek()`.
  setPosition(tUs: number): void {
    this._tUs = Math.max(0, tUs);
    this._lastWallMs = this._playing ? performance.now() : null;
  }

  positionUs(): number {
    return this._tUs;
  }

  /// Advance the clock to "now". Returns the new position + delta
  /// since the previous tick. Caller is expected to invoke once per
  /// rAF (or per encode step in export).
  tick(): ClockTickInfo {
    if (!this._playing) {
      return { tUs: this._tUs, dtUs: 0 };
    }
    const nowMs = performance.now();
    const lastMs = this._lastWallMs ?? nowMs;
    const dtMs = nowMs - lastMs;
    this._lastWallMs = nowMs;
    let dtUs = Math.round(dtMs * 1000);

    // Drift correction toward audio clock if bound.
    if (this._audioCtx && this._audioCtx.state === "running") {
      const audioUs = Math.round(
        (this._audioCtx.currentTime - this._audioCtx.baseLatency) * 1e6,
      );
      const driftUs = audioUs - (this._tUs + dtUs);
      // Apply a fraction of the drift to bound oscillation.
      dtUs += Math.round(driftUs * this._driftFraction);
    }

    this._tUs += dtUs;
    return { tUs: this._tUs, dtUs };
  }
}
