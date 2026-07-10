// Geometry for the GPU byte-pack passes (PackYuvPlanar). Each pack pass
// renders into an RGBA8 target whose 4-byte texels carry either two u16LE
// samples (10-bit) or four u8 samples (8-bit). Widths that don't divide the
// samples-per-texel get a PADDED pass row (ceil), and the CPU readback trims
// each row to `rowBytes` — this is what admits W%4==2 outputs (e.g. 1366)
// that the frozen PackYuv420p10 rejects.

import type { NativePixFmt } from "../encodeTarget";

export interface PlanePass {
  /// Pack-pass render-target size in texels.
  passW: number;
  passH: number;
  /// VALID bytes per plane row (= samples * bytesPerSample). passW*4 may
  /// exceed this by up to 3 bytes (pad, trimmed on readback).
  rowBytes: number;
  planeBytes: number;
}

export interface YuvLayout {
  bytesPerSample: 1 | 2;
  samplesPerTexel: 2 | 4;
  y: PlanePass;
  c: PlanePass;
  frameBytes: number;
}

export function yuvPlaneLayout(
  pixFmt: NativePixFmt,
  outW: number,
  outH: number,
): YuvLayout {
  if (outW % 2 !== 0 || outH % 2 !== 0) {
    throw new Error(`yuvPlaneLayout: even dimensions required, got ${outW}x${outH}`);
  }
  const tenBit = pixFmt.endsWith("10le");
  const bytesPerSample: 1 | 2 = tenBit ? 2 : 1;
  const samplesPerTexel: 2 | 4 = tenBit ? 2 : 4;
  const is420 = pixFmt.startsWith("yuv420");
  const cW = outW / 2;
  const cH = is420 ? outH / 2 : outH;
  const plane = (samplesW: number, h: number): PlanePass => {
    const rowBytes = samplesW * bytesPerSample;
    return {
      passW: Math.ceil(samplesW / samplesPerTexel),
      passH: h,
      rowBytes,
      planeBytes: rowBytes * h,
    };
  };
  const y = plane(outW, outH);
  const c = plane(cW, cH);
  return { bytesPerSample, samplesPerTexel, y, c, frameBytes: y.planeBytes + 2 * c.planeBytes };
}
