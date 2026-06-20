// 10-bit limited-range YCbCr ⇄ gamma-encoded RGB, the reference the ingest
// and pack shaders are parity-tested against. Display-referred: NO transfer
// math here (ADR 0021 / design doc: working space = gamma 709).

export interface YuvCoef {
  /// Kr, Kb of the matrix (Kg = 1 − Kr − Kb).
  kr: number;
  kb: number;
}
export const BT709: YuvCoef = { kr: 0.2126, kb: 0.0722 };
export const BT601: YuvCoef = { kr: 0.299, kb: 0.114 };

// GLSL twin: clamp(floor(x + 0.5), 0.0, 1023.0) — NOT round(), whose .5
// behavior is implementation-defined in GLSL ES. Math.round ≡ floor(x+0.5).
const clamp10 = (x: number) => Math.min(1023, Math.max(0, Math.round(x)));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/// Derived shader coefficients [crR, cbG, crG, cbB] for yuv→rgb.
export function inverseCoef(c: YuvCoef): [number, number, number, number] {
  const kg = 1 - c.kr - c.kb;
  const crR = 2 * (1 - c.kr);
  const cbB = 2 * (1 - c.kb);
  return [crR, (c.kb * cbB) / kg, (c.kr * crR) / kg, cbB];
}

/// r/g/b: gamma-encoded [0,1] (clamped). Returns 10-bit LIMITED-range codes (Y 64–940, C 64–960), clamped to [0,1023].
export function rgbToYuv10(
  r: number,
  g: number,
  b: number,
  c: YuvCoef,
): [number, number, number] {
  const kg = 1 - c.kr - c.kb;
  const y = c.kr * clamp01(r) + kg * clamp01(g) + c.kb * clamp01(b);
  const cb = (clamp01(b) - y) / (2 * (1 - c.kb));
  const cr = (clamp01(r) - y) / (2 * (1 - c.kr));
  return [clamp10(64 + 876 * y), clamp10(512 + 896 * cb), clamp10(512 + 896 * cr)];
}

/// Inverse of rgbToYuv10; outputs clamped to [0,1].
export function yuv10ToRgb(
  y10: number,
  u10: number,
  v10: number,
  c: YuvCoef,
): [number, number, number] {
  const [crR, cbG, crG, cbB] = inverseCoef(c);
  const y = (y10 - 64) / 876;
  const cb = (u10 - 512) / 896;
  const cr = (v10 - 512) / 896;
  return [
    clamp01(y + crR * cr),
    clamp01(y - crG * cr - cbG * cb),
    clamp01(y + cbB * cb),
  ];
}

/// CPU reference of the pack shader's byte layout: two samples per RGBA8
/// texel, u16LE each.
export function packTwoSamples(
  a10: number,
  b10: number,
): [number, number, number, number] {
  return [a10 & 255, a10 >> 8, b10 & 255, b10 >> 8];
}
