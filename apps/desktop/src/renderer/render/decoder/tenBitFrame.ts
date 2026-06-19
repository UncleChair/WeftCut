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
