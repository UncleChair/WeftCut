// TS twin of native/src/audio/envelope.rs — the sampled envelope
// contract (docs/audio.md §The envelope contract). Keep BOTH sides + the
// golden fixture (audioEnvelopeGolden.fixture.json) in lockstep; the
// cross-language test exists to catch drift.

import { type AnimTrack, resolveAnimated } from "../animated";
import { dbToLinear } from "../../eval";

export const ENVELOPE_STEP_US = 10_000;

export interface Envelope {
  stepUs: number;
  spanUs: number;
  /// length 1 ⇔ constant
  values: number[];
}

// dbToLinear (10^(db/20)) now comes from the shared weftcut-eval wasm — ONE
// formula across renderer preview, the actor, and export (was a hand-mirrored
// Math.pow). Re-exported so the role-gate twin and docs/audio.md's envelope
// contract keep a single source.
export { dbToLinear };

/// Fade multiplier at layer-local `tUs`: linear 0→1 over fadeIn from the
/// layer start, 1→0 over fadeOut into the layer end, multiplied when they
/// overlap. Zero-length fades are identity. Mirrors `fade_multiplier`.
export function fadeMultiplier(
  tUs: number,
  spanUs: number,
  fadeInUs: number,
  fadeOutUs: number,
): number {
  let m = 1;
  if (fadeInUs > 0 && tUs < fadeInUs) m *= Math.max(0, tUs) / fadeInUs;
  if (fadeOutUs > 0) {
    const fromEnd = spanUs - tUs;
    if (fromEnd < fadeOutUs) m *= Math.max(0, fromEnd) / fadeOutUs;
  }
  return m;
}

function isAnimated(track: AnimTrack<number>): boolean {
  return track.mode === "Keyframed" && track.value.length > 1;
}

/// Gain envelope for one audio layer: linear(resolveAnimated(gainDb)) ×
/// fades. Static gain + no fades short-circuits to a single point.
export function sampleGain(
  gainDb: AnimTrack<number>,
  fadeInUs: number,
  fadeOutUs: number,
  spanUs: number,
): Envelope {
  if (!isAnimated(gainDb) && fadeInUs === 0 && fadeOutUs === 0) {
    return {
      stepUs: ENVELOPE_STEP_US,
      spanUs,
      values: [dbToLinear(resolveAnimated(gainDb, 0, 0))],
    };
  }
  const values: number[] = [];
  for (let k = 0; ; k++) {
    const t = Math.min(k * ENVELOPE_STEP_US, spanUs);
    values.push(
      dbToLinear(resolveAnimated(gainDb, t, 0)) *
        fadeMultiplier(t, spanUs, fadeInUs, fadeOutUs),
    );
    if (t >= spanUs) break;
  }
  return { stepUs: ENVELOPE_STEP_US, spanUs, values };
}

/// Pan envelope: plain sampling of the Animated pan, clamped to [-1, 1].
export function samplePan(pan: AnimTrack<number>, spanUs: number): Envelope {
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  if (!isAnimated(pan)) {
    return {
      stepUs: ENVELOPE_STEP_US,
      spanUs,
      values: [clamp(resolveAnimated(pan, 0, 0))],
    };
  }
  const values: number[] = [];
  for (let k = 0; ; k++) {
    const t = Math.min(k * ENVELOPE_STEP_US, spanUs);
    values.push(clamp(resolveAnimated(pan, t, 0)));
    if (t >= spanUs) break;
  }
  return { stepUs: ENVELOPE_STEP_US, spanUs, values };
}

/// Linear interp between grid points — mirrors `Envelope::eval`. The preview
/// scheduler uses this to cut per-chunk curve windows for
/// `setValueCurveAtTime` (which lerps between array entries natively).
export function evalEnvelope(e: Envelope, tUs: number): number {
  if (e.values.length === 0) return 1;
  if (e.values.length === 1) return e.values[0]!;
  if (tUs <= 0) return e.values[0]!;
  const last = e.values.length - 1;
  const pos = tUs / e.stepUs;
  const i = Math.floor(pos);
  if (i >= last) return e.values[last]!;
  const u = pos - i;
  return e.values[i]! + (e.values[i + 1]! - e.values[i]!) * u;
}
