// The single seam between FfmpegSource and a concrete native decode transport.
// Frames arrive as ready-to-ring ImageBitmaps; the transport hides IPC shape,
// color-space derivation, and per-frame coalescing.
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
  onFrame(cb: (bitmap: ImageBitmap, ptsUs: number, durUs: number) => void): void;
  /// Terminal transport failure (GPU decode error / device loss / budget reject;
  /// SW: open failure only). FfmpegSource decides whether this is recoverable.
  onError(cb: (reason: string) => void): void;
  onEof(cb: () => void): void;
  dispose(): void;
}
