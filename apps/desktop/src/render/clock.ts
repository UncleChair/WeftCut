// Synthetic clock with optional Web Audio drift correction.
//
// Plan: docs/render.md (8a.2 — synthetic + Web Audio drift)
//
// Behavior:
//   - When no audio context is bound, clock advances by `performance.now()` deltas.
//   - When an `AudioContext` is bound and running, clock nudges its
//     synthetic position toward `audioCtx.currentTime - audioCtx.baseLatency`
//     by a fraction of the drift each tick. Bounded drift (<1 frame).
//
// Internal state `_rawTUs` is raw wall-clock (with drift correction).
// Externally observable `positionUs()` returns the value snapped to a
// composition-frame boundary — so the storage invariant ("every
// observable TimeUs is on a comp-frame grid") extends through the
// playback engine. Drift correction operates on the raw value so small
// nudges aren't rounded away.

import { snapFrameRound } from "../frames";

export interface ClockTickInfo {
  /// Current composition time in microseconds (snapped to comp frame).
  tUs: number;
  /// Wall-clock delta in microseconds since the previous tick.
  dtUs: number;
}

export class SyntheticClock {
  private _rawTUs = 0;
  private _playing = false;
  private _lastWallMs: number | null = null;
  private _audioCtx: AudioContext | null = null;
  /// When non-null, every tick nudges `_rawTUs` toward
  /// `audioCtx.currentTime * 1e6` by this fraction of the drift.
  private _driftFraction = 0.1;
  private _fpsNum = 30;
  private _fpsDen = 1;

  bindAudio(ctx: AudioContext | null): void {
    this._audioCtx = ctx;
  }

  /// Bind the composition fps so `positionUs()` and `setPosition` can
  /// snap to frame. Called by the Compositor / PlaybackEngine on
  /// project load and on fps changes; before the first call, snap
  /// defaults to 30fps.
  bindFps(num: number, den: number): void {
    this._fpsNum = num > 0 ? num : 30;
    this._fpsDen = den > 0 ? den : 1;
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

  /// Hard-set the composition position. Called by `seek()`. Snaps on
  /// entry so external callers can't inject off-grid values.
  setPosition(tUs: number): void {
    this._rawTUs = Math.max(0, snapFrameRound(tUs, this._fpsNum, this._fpsDen));
    this._lastWallMs = this._playing ? performance.now() : null;
  }

  positionUs(): number {
    return snapFrameRound(this._rawTUs, this._fpsNum, this._fpsDen);
  }

  /// Advance the clock to "now". Returns the new position + delta
  /// since the previous tick. Caller is expected to invoke once per
  /// rAF (or per encode step in export).
  tick(): ClockTickInfo {
    if (!this._playing) {
      return { tUs: this.positionUs(), dtUs: 0 };
    }
    const nowMs = performance.now();
    const lastMs = this._lastWallMs ?? nowMs;
    const dtMs = nowMs - lastMs;
    this._lastWallMs = nowMs;
    let dtUs = Math.round(dtMs * 1000);

    // Drift correction toward audio clock if bound. Operates on raw
    // wall-clock state — small drift nudges below one frame would get
    // rounded away if applied to a snapped position.
    if (this._audioCtx && this._audioCtx.state === "running") {
      const audioUs = Math.round(
        (this._audioCtx.currentTime - this._audioCtx.baseLatency) * 1e6,
      );
      const driftUs = audioUs - (this._rawTUs + dtUs);
      dtUs += Math.round(driftUs * this._driftFraction);
    }

    this._rawTUs += dtUs;
    return { tUs: this.positionUs(), dtUs };
  }
}
