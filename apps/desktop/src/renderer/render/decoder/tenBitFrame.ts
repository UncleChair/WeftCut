// CPU-plane copy of a >8-bit decoder frame. Created in the decoder output
// callback (copyTo + frame.close() immediately — drains the WebCodecs pool
// outright, ADR 0004), stored in the export ring in place of the VideoFrame.

export interface TenBitFrame {
  readonly kind: "p10";
  readonly width: number;
  readonly height: number;
  /// Tightly packed I420P10 planes (u16LE): Y at yOffset (stride width*2),
  /// then U, V at half resolution (stride width).
  readonly data: Uint8Array;
  readonly yOffset: number;
  readonly uOffset: number;
  readonly vOffset: number;
  readonly colorSpace: VideoColorSpaceInit | null;
  readonly timestamp: number;
  readonly duration: number | null;
  /// Uniform-shape no-op so ring eviction code treats both frame kinds alike.
  close(): void;
}

export function isTenBitFrame(f: unknown): f is TenBitFrame {
  return !!f && typeof f === "object" && (f as { kind?: string }).kind === "p10";
}

/// True for decoder output formats this lane handles (I420P10 today; P12
/// would need 12→10 requantize — out of scope, returns false).
export function isTenBitDecoderFormat(format: string | null): boolean {
  return format === "I420P10";
}

/// Wrap an already tightly-packed I420P10 buffer (the native export session's
/// transport format) as a TenBitFrame — ZERO-COPY: `data` is adopted as-is
/// (the transferred relay bytes), no plane copy. Offsets are computed exactly
/// as `copyToTenBit` lays them out, so both producers feed one consumer path.
///
/// LANDMINE: a byteLength mismatch means the Rust emitter and this layout have
/// drifted — throw, never truncate/pad, or the drift ships as silent corruption.
export function tenBitFrameFromBytes(init: {
  data: Uint8Array;
  width: number;
  height: number;
  timestamp: number;
  duration: number | null;
  colorSpace: VideoColorSpaceInit | null;
}): TenBitFrame {
  const { data, width, height, timestamp, duration, colorSpace } = init;
  const ySize = width * height * 2;
  const cSize = (width >> 1) * (height >> 1) * 2;
  const expected = ySize + 2 * cSize;
  if (data.byteLength !== expected) {
    throw new Error(
      `I420P10 layout drift: ${width}x${height} expects ${expected} bytes, got ${data.byteLength}`,
    );
  }
  return {
    kind: "p10",
    width,
    height,
    data,
    yOffset: 0,
    uOffset: ySize,
    vOffset: ySize + cSize,
    colorSpace,
    timestamp,
    duration,
    close() {},
  };
}

export async function copyToTenBit(frame: VideoFrame): Promise<TenBitFrame> {
  const rect = frame.visibleRect ?? new DOMRectReadOnly(0, 0, frame.codedWidth, frame.codedHeight);
  const w = rect.width;
  const h = rect.height;
  const ySize = w * h * 2;
  const cSize = (w >> 1) * (h >> 1) * 2;
  const data = new Uint8Array(ySize + 2 * cSize);
  await frame.copyTo(data, {
    rect,
    layout: [
      { offset: 0, stride: w * 2 },
      { offset: ySize, stride: w },
      { offset: ySize + cSize, stride: w },
    ],
  });
  const cs = frame.colorSpace;
  return {
    kind: "p10",
    width: w,
    height: h,
    data,
    yOffset: 0,
    uOffset: ySize,
    vOffset: ySize + cSize,
    colorSpace: cs
      ? { matrix: cs.matrix ?? null, primaries: cs.primaries ?? null,
          transfer: cs.transfer ?? null, fullRange: cs.fullRange ?? null }
      : null,
    timestamp: frame.timestamp,
    duration: frame.duration,
    close() {},
  };
}
