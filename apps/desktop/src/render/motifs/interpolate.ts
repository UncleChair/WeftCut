// apps/desktop/src/render/motifs/interpolate.ts
export interface InterpolateOpts {
  easing?: (t: number) => number;
  clamp?: boolean; // default true
}

/** Map `t` from `inRange` to `outRange`, segment-wise, clamped by default. */
export function interpolate(
  t: number,
  inRange: readonly number[],
  outRange: readonly number[],
  opts: InterpolateOpts = {},
): number {
  if (inRange.length < 2 || inRange.length !== outRange.length) {
    throw new Error("interpolate: ranges must be equal length >= 2");
  }
  const clamp = opts.clamp ?? true;
  if (clamp) {
    if (t <= inRange[0]!) return outRange[0]!;
    if (t >= inRange[inRange.length - 1]!) return outRange[outRange.length - 1]!;
  }
  let i = 1;
  while (i < inRange.length - 1 && t > inRange[i]!) i++;
  const inA = inRange[i - 1]!, inB = inRange[i]!;
  const outA = outRange[i - 1]!, outB = outRange[i]!;
  // Avoid 0/0 on a zero-width segment — return the segment's start output value.
  if (inB === inA) return outA;
  let frac = (t - inA) / (inB - inA);
  if (opts.easing) frac = opts.easing(frac);
  return outA + frac * (outB - outA);
}
