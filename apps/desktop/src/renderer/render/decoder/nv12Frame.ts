// CPU-plane NV12 frame from the NATIVE export-decode relay, stored in the
// export ring in place of a VideoFrame. Exists because Chromium's software
// VideoFrame→RGB conversion (drawImage / createImageBitmap of a BUFFER-defined
// NV12 frame) applies BT.601 coefficients regardless of the stamped
// `colorSpace` — so these frames must convert in our own shader (`Nv12Ingest`),
// which selects the matrix from `colorSpace`. WebCodecs-DECODED frames are
// unaffected and never take this type. Policy: ADR 0032.

export interface NativeNv12Frame {
  readonly kind: "nv12";
  readonly width: number;
  readonly height: number;
  /// Tightly packed NV12: Y at 0 (stride width), interleaved CbCr at uvOffset
  /// (stride width, height/2 rows).
  readonly data: Uint8Array;
  readonly uvOffset: number;
  readonly colorSpace: VideoColorSpaceInit | null;
  readonly timestamp: number;
  readonly duration: number | null;
  /// Uniform-shape no-op so ring eviction code treats all frame kinds alike.
  close(): void;
}

export function isNativeNv12Frame(f: unknown): f is NativeNv12Frame {
  return !!f && typeof f === "object" && (f as { kind?: string }).kind === "nv12";
}

/// Wrap an already tightly-packed NV12 buffer (the native export session's
/// 8-bit transport format) as a NativeNv12Frame — ZERO-COPY: `data` is adopted
/// as-is (the transferred relay bytes), no plane copy.
///
/// LANDMINE: a byteLength mismatch means the Rust emitter and this layout have
/// drifted — throw, never truncate/pad, or the drift ships as silent corruption.
export function nv12FrameFromBytes(init: {
  data: Uint8Array;
  width: number;
  height: number;
  timestamp: number;
  duration: number | null;
  colorSpace: VideoColorSpaceInit | null;
}): NativeNv12Frame {
  const { data, width, height, timestamp, duration, colorSpace } = init;
  const ySize = width * height;
  const uvSize = width * (height >> 1);
  const expected = ySize + uvSize;
  if (data.byteLength !== expected) {
    throw new Error(
      `NV12 layout drift: ${width}x${height} expects ${expected} bytes, got ${data.byteLength}`,
    );
  }
  return {
    kind: "nv12",
    width,
    height,
    data,
    uvOffset: ySize,
    colorSpace,
    timestamp,
    duration,
    close() {},
  };
}
