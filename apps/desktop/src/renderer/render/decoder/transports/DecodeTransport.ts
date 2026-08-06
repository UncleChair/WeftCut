// The single seam between FfmpegSource and a concrete native decode transport.
// Frames arrive ready-to-ring; the transport hides IPC shape, color-space
// derivation, and per-frame coalescing. The GPU lane delivers ImageBitmaps
// (decoder-produced conversion — trustworthy); the SW lane delivers CPU-plane
// frames — NativeNv12Frames, or TenBitFrames for a 10-bit VideoToolbox-lane
// session — which convert in OUR shaders, never the
// browser's (see nv12Frame.ts / tenBitFrame.ts / ADR 0032).
import type { NativeNv12Frame } from "../nv12Frame";
import type { TenBitFrame } from "../tenBitFrame";
import type { HandoffTimingSummary } from "./handoffTimings";

/// What a transport can push into the preview `FrameRing`.
export type TransportFrame = ImageBitmap | NativeNv12Frame | TenBitFrame;

export interface DecodeTransportOpen {
  streamId: string;
  path: string;
  /// Source ffprobe color tags; each transport derives its own wire shape
  /// (GPU: PreviewGpuColorSpace, SW: VideoColorSpaceInit), defaulting bt709/limited.
  sourceColor?: VideoColorSpaceInit;
  /// Native GPU pool size (GPU transport only; SW ignores). Default 3.
  poolSize?: number;
  /// Renderer-probed coded dimensions. The GPU transport sends them to main's
  /// admission budget before native open; SW transports ignore them.
  codedWidth?: number;
  codedHeight?: number;
}

export interface DecodeTransport {
  open(o: DecodeTransportOpen): Promise<void>;
  requestFrameAt(tUs: number): void;
  onFrame(cb: (frame: TransportFrame, ptsUs: number, durUs: number) => void): void;
  /// Terminal transport failure (GPU decode error / device loss / budget reject;
  /// SW: open failure only). FfmpegSource decides whether this is recoverable.
  onError(cb: (reason: string) => void): void;
  onEof(cb: () => void): void;
  /// Begins teardown. GPU transports resolve only after main has closed the
  /// native session and released its admission lease; callers that intend to
  /// open a replacement session must await it. Other call sites may ignore the
  /// returned promise.
  dispose(): void | Promise<void>;
  /// Diagnostics: per-frame preload handoff timings. Hardware lane only — the
  /// SW transport has no preload stage to stamp, so it does not implement this.
  handoffTimings?(): HandoffTimingSummary | null;
  /// Forget any same-target request dedup. FfmpegSource calls this when it
  /// flushes/re-arms its ring: a transport that swallowed an exact-repeat
  /// target as "already sent" would leave the just-emptied ring unfilled.
  /// Only transports that dedup (SW) implement it.
  resetRequestDedup?(): void;
}
