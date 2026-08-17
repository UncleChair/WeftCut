// The 4×5 colour matrices behind the brightness / contrast / saturation
// catalog entries.
//
// Pixi's ColorMatrixFilter supplies the shader and nothing else: its fragment
// program is dual-source (GLSL + WGSL) and already unpremultiplies before the
// transform and re-premultiplies after, so semi-transparent pixels survive.
// The maths is authored here because ColorMatrixFilter.saturate() desaturates
// with EQUAL channel weights — fully desaturated it collapses pure green and
// pure blue onto the same 0.333 grey, where Rec.709 gives 0.715 and 0.072.
// Shipping that helper would ship a visible grading error, so only the shell
// is borrowed.
//
// Layout: row-major 4×5, column 4 the additive offset — read straight off
// colorMatrixFilter.frag:
//     result.r = m[0]·r + m[1]·g + m[2]·b + m[3]·a + m[4]
//     result.g = m[5]·r + m[6]·g + m[7]·b + m[8]·a + m[9]     … and so on.
// Row 3 is alpha; every writer here leaves it [0, 0, 0, 1, 0].
//
// Each writer takes the target array as an OUT-PARAM rather than returning a
// fresh one. EffectChain calls apply() per param, per effect, per frame, and
// ColorMatrixFilter's `matrix` SETTER replaces the uniform reference
// (`uniforms.uColorMatrix = value`) — so writing into the array pixi already
// owns allocates nothing at 60 fps. Same in-place uniform idiom as
// ChromaKeyFilter. The functions stay pure and GPU-free, which is what makes
// the maths testable without a renderer.

/// Rec.709 luma weights (BT.709 Y'), the luminance the whole render path is
/// display-referred to (ADR 0021). Also the reason these writers exist.
export const REC709_LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/// Slot count of one 4×5 colour matrix — pixi's `uColorMatrix` uniform is
/// declared `{ type: "f32", size: 20 }`.
export const COLOR_MATRIX_LENGTH = 20;

/// The alpha row. Written by every writer so a matrix is complete whatever the
/// caller's array held before; no writer ever transforms alpha.
function writeAlphaRow(out: number[]): void {
  out[15] = 0;
  out[16] = 0;
  out[17] = 0;
  out[18] = 1;
  out[19] = 0;
}

/// The shared shape of brightness and contrast: the same gain on all three
/// channels, the same offset added to each.
function writeDiagonal(out: number[], gain: number, offset: number): void {
  out[0] = gain; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = offset;
  out[5] = 0; out[6] = gain; out[7] = 0; out[8] = 0; out[9] = offset;
  out[10] = 0; out[11] = 0; out[12] = gain; out[13] = 0; out[14] = offset;
  writeAlphaRow(out);
}

/// Brightness as a GAIN, `g = 1 + amount/100`: black stays black at every
/// positive amount, which is what makes the control read as exposure rather
/// than the washed-out look an additive lift gives. `amount = -100` is g = 0,
/// a black frame; `amount = 0` is the identity.
export function writeBrightness(out: number[], amount: number): void {
  writeDiagonal(out, 1 + amount / 100, 0);
}

/// Contrast as a gain about mid grey, `c = 1 + amount/100` with the offset
/// `0.5·(1 − c)` that pivots it at 0.5. `amount = -100` is c = 0 with a 0.5
/// offset — a flat mid-grey frame; `amount = 0` is the identity.
export function writeContrast(out: number[], amount: number): void {
  const c = 1 + amount / 100;
  writeDiagonal(out, c, 0.5 * (1 - c));
}

/// Saturation as a lerp between the Rec.709 luma of the pixel and the pixel
/// itself, `s = 1 + amount/100`. At `amount = -100` (s = 0) every row becomes
/// the luma weights, so pure green desaturates to 0.715 and pure blue to
/// 0.072 — a photographic greyscale, not the equal-weight paste pixi's own
/// helper produces. `amount = 0` is the identity; above 0 the weights are
/// extrapolated past the original, which is how a saturation boost works.
export function writeSaturation(out: number[], amount: number): void {
  const s = 1 + amount / 100;
  const k = 1 - s;
  const [lr, lg, lb] = REC709_LUMA;
  out[0] = lr * k + s; out[1] = lg * k; out[2] = lb * k; out[3] = 0; out[4] = 0;
  out[5] = lr * k; out[6] = lg * k + s; out[7] = lb * k; out[8] = 0; out[9] = 0;
  out[10] = lr * k; out[11] = lg * k; out[12] = lb * k + s; out[13] = 0; out[14] = 0;
  writeAlphaRow(out);
}
