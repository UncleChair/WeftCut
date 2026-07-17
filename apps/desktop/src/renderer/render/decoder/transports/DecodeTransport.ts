// The single seam between FfmpegSource and a concrete native decode transport.
// Frames arrive ready-to-ring; the transport hides IPC shape, color-space
// derivation, and per-frame coalescing. The GPU lane delivers ImageBitmaps
// (decoder-produced conversion — trustworthy); the SW lane delivers
// NativeNv12Frames (CPU planes convert in OUR shader, never the browser's —
// see nv12Frame.ts / ADR 0032).
import type { NativeNv12Frame } from "../nv12Frame";

/// What a transport can push into the preview `FrameRing`.
export type TransportFrame = ImageBitmap | NativeNv12Frame;

export interface DecodeTransportOpen {
  streamId: string;
  path: string;
  /// Source ffprobe color tags; each transport derives its own wire shape
  /// (GPU: PreviewGpuColorSpace, SW: VideoColorSpaceInit), defaulting bt709/limited.
  sourceColor?: VideoColorSpaceInit;
  /// Native GPU pool size (GPU transport only; SW ignores). Default 3.
  poolSize?: number;
}

export interface DecodeTransport {
  open(o: DecodeTransportOpen): Promise<void>;
  requestFrameAt(tUs: number): void;
  onFrame(cb: (frame: TransportFrame, ptsUs: number, durUs: number) => void): void;
  /// Terminal transport failure (GPU decode error / device loss / budget reject;
  /// SW: open failure only). FfmpegSource decides whether this is recoverable.
  onError(cb: (reason: string) => void): void;
  onEof(cb: () => void): void;
  dispose(): void;
}
