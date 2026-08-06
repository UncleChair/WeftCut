// Preview pan matrix mixer (docs/audio.md §Preview mixer). The equal-power pan
// LAW is the shared weftcut-eval leaf (panCoeff); this file only wires the
// native Web Audio graph that APPLIES it: a ChannelSplitter → per-coefficient
// GainNode → ChannelMerger matrix, the same 2×2 mix StereoPannerNode does
// internally, but with coefficients we control so preview and export run one
// law. Coefficient curves are sampled on the 10 ms grid and lerped by
// setValueCurveAtTime (the X parity contract; twin of envelope.rs::pan_coeffs_at).
import { panCoeff } from "../../eval";
import { type Envelope } from "./envelope";

export interface PanGraph {
  input: AudioNode;
  output: AudioNode;
  /// Stereo: [a (l→L), b (r→L), c (l→R), d (r→R)]. Mono: [a (in→L), c (in→R)].
  gains: GainNode[];
}

/// Lerped equal-power coefficients [a,b,c,d] at layer-local `tUs`. Computes
/// panCoeff at the two grid points straddling tUs and lerps the COEFFICIENTS —
/// the X parity contract (mirrors native `pan_coeffs_at`).
export function panCoeffsAt(env: Envelope, channels: number, tUs: number): number[] {
  if (env.values.length <= 1) {
    const p = env.values[0] ?? 0;
    return [0, 1, 2, 3].map((i) => panCoeff(p, channels, i));
  }
  const last = env.values.length - 1;
  const pos = Math.max(0, tUs) / env.stepUs;
  const i = Math.min(Math.floor(pos), last);
  const a = [0, 1, 2, 3].map((k) => panCoeff(env.values[i]!, channels, k));
  if (i >= last) return a;
  const b = [0, 1, 2, 3].map((k) => panCoeff(env.values[i + 1]!, channels, k));
  const u = pos - i;
  return a.map((av, k) => av + (b[k]! - av) * u);
}

/// Coefficient values for the static fast path. Stereo → [a,b,c,d]; mono →
/// [a,c] (the two gains the mono graph wires).
export function constantPanGains(env: Envelope, channels: number): number[] {
  const c = panCoeffsAt(env, channels, 0);
  return channels <= 1 ? [c[0]!, c[2]!] : c;
}

/// One curve per gain across [localStartUs, localEndUs], or null for a constant
/// envelope. Mirrors AudioMixer's gain `cut()` resolution (≈ one point / 10 ms).
export function panCurves(
  env: Envelope,
  channels: number,
  localStartUs: number,
  localEndUs: number,
): (Float32Array | null)[] {
  const slots = channels <= 1 ? 2 : 4;
  if (env.values.length === 1) return Array(slots).fill(null);
  const n = Math.max(2, Math.ceil((localEndUs - localStartUs) / 10_000) + 1);
  const curves = Array.from({ length: slots }, () => new Float32Array(n));
  // Map output slot index → coefficient index: stereo identity, mono [a,c]=[0,2].
  const coeffIdx = channels <= 1 ? [0, 2] : [0, 1, 2, 3];
  for (let i = 0; i < n; i++) {
    const t = localStartUs + ((localEndUs - localStartUs) * i) / (n - 1);
    // X parity: lerp the COEFFICIENTS (panCoeffsAt) — NOT the pan value then
    // cos/sin — so the preview curve matches export's per-sample pan_coeffs_at.
    const coeffs = panCoeffsAt(env, channels, t);
    for (let s = 0; s < slots; s++) curves[s]![i] = coeffs[coeffIdx[s]!]!;
  }
  return curves;
}

/// Build the matrix graph for `channels` (1 or 2). Caller connects its source to
/// `.input` and `.output` onward; per-chunk curves go on `.gains`.
export function buildPanGraph(ctx: BaseAudioContext, channels: number): PanGraph {
  const output = ctx.createChannelMerger(2);
  if (channels <= 1) {
    // mono: one input → two gains → L / R
    const gA = ctx.createGain(); // in → L
    const gC = ctx.createGain(); // in → R
    const input = ctx.createGain(); // fan-out hub
    input.connect(gA);
    input.connect(gC);
    gA.connect(output, 0, 0);
    gC.connect(output, 0, 1);
    return { input, output, gains: [gA, gC] };
  }
  // stereo: split → 4 gains → merge (summing on shared merger inputs)
  const splitter = ctx.createChannelSplitter(2);
  const gA = ctx.createGain(); // l → L
  const gB = ctx.createGain(); // r → L
  const gC = ctx.createGain(); // l → R
  const gD = ctx.createGain(); // r → R
  splitter.connect(gA, 0);
  splitter.connect(gB, 1);
  splitter.connect(gC, 0);
  splitter.connect(gD, 1);
  gA.connect(output, 0, 0);
  gB.connect(output, 0, 0);
  gC.connect(output, 0, 1);
  gD.connect(output, 0, 1);
  return { input: splitter, output, gains: [gA, gB, gC, gD] };
}
