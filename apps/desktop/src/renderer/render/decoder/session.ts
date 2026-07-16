// Neutral decode-contract module. Extracted from SourceDecoderPool.ts so the
// preview pool file no longer owns the shared vocabulary alongside SourceMedia,
// the WebCodecs SourceHandle, and the pool. Defines the surface the Compositor
// composites through (DecodeSession) plus the two role interfaces. Both imports
// below are `import type` (erased), so the session <-> ExportDecoderPool
// reference (ExportDecodeSession.ring) is not a runtime cycle.
import type { NativeNv12Frame } from "./nv12Frame";
import type { TenBitFrame } from "./tenBitFrame";
import type { ExportColorDiag, ExportFrameStore } from "./ExportDecoderPool";

export interface SourceHandleInit {
  /// Per-clip identity. The preview pool keys decoder + ring instances
  /// by this so that overlapping clips of the same source don't share
  /// (and thrash) a single decoder. The export pool keys by `handleKey`
  /// instead and ignores this.
  layerId: string;
  /// Optional pool-key override. The EXPORT pool keys handles by this when
  /// present — the export Worker and the export-mode Compositor both pass
  /// the shared `exportHandleKey(mediaId, srcInUs, tStartUs)` so clips of
  /// one media that march through source time in lockstep share one decode
  /// pipeline while clips at a different timeline→source offset get their
  /// own. The preview pool keys by `layerId` and ignores it.
  handleKey?: string;
  mediaId: string;
  /// `weftcut-media://` URL of the source's 1080p master proxy.
  proxyAssetUrl: string;
  /// Source color tags mapped from ffprobe (matrix/range/primaries/transfer),
  /// applied to ANY decode target for this media — the original trivially,
  /// and proxies too (a proxy preserves the source's colorimetry; the recipe
  /// asserts the tags outright since proxy v7). Threaded into
  /// `withDefaultColorSpace` as the middle-priority layer (below the decode
  /// target's own mediabunny colr tag, above the resolution default).
  /// Undefined ⇒ untagged source ⇒ resolution default applies. The preview
  /// pool carries it onto the shared `SourceMedia` (per-mediaId) so the once-
  /// per-source config build at `SourceMedia.ensureReady` tags the decode.
  sourceColor?: VideoColorSpaceInit | undefined;
  /// Export-only: copy >8-bit decoder output to CPU planes (TenBitFrame)
  /// instead of holding VideoFrames. Implies the 10-bit export lane.
  tenBitLane?: boolean;
  /// Export-only: configure the decoder prefer-software up front. For Hi10P
  /// this skips a doomed HW attempt (no HW path exists); for AV1-10 it is a
  /// CORRECTNESS requirement — the HW decoder succeeds but emits opaque
  /// format=null frames with no copyTo, so the error-fallback never fires.
  preferSoftware?: boolean;
  /// Import-time container start PTS for the ORIGINAL file. Timeline/duration
  /// normalization uses this from metadata; the decoder derives its offset from
  /// the opened decode target's first packet instead (re-encoded proxies start
  /// at PTS 0). Kept as a fallback when the target has no packets.
  sourceStartPtsUs?: number | null;
  /// The ORIGINAL file path for an `engine: 'ffmpeg'` handle to decode
  /// directly (bypasses the shared, proxy-backed `SourceMedia` entirely).
  /// Ignored by the WebCodecs path, which decodes `proxyAssetUrl` instead.
  sourcePath?: string;
  /// Bench-only: native pool size (slot count) for an `engine: 'ffmpeg'`
  /// handle. Decode-bench Stage 3 varies this to sweep pipeline depth; the
  /// product default (3) applies when unset — production handles never set
  /// it. Ignored by the WebCodecs path.
  poolSize?: number;
  /// Resolved engine (collapsed decode-engine model, `resolveDecodeEngine`).
  /// Export ignores it. Absent ⇒ falls through to the WebCodecs default.
  engine?: import("./decodeEngine").DecodeEngine;
  /// Source codec/pixFmt — `FfmpegSource` needs them for lane selection.
  codec?: string | null;
  pixFmt?: string | null;
  /// Media dimensions — threaded into `FfmpegSource`'s HW-probe classKey
  /// resolution class (see `FfmpegSourceInit.width`/`height`).
  width?: number | null;
  height?: number | null;
  /// FFmpeg native-decode component DLLs loaded on this machine. Gates the
  /// FFmpeg HW lane (`FfmpegSource`/`pickInitialLane`).
  componentAvailable?: boolean;
  /// Bench-only lane pin, forwarded to `FfmpegSource` (decode-bench Stage 3).
  forceLane?: import("./decodeEngine").FfmpegLane;
  /// Export-only: route this handle through the native `NativeExportSourceHandle`
  /// (decode the ORIGINAL via the main-process napi `NativeDecode` session over
  /// the frame relay) instead of WebCodecs on the proxy. When present the export
  /// pool builds a `NativeExportSourceHandle`; the WebCodecs path never reads it.
  /// `sourcePath` is the absolute ORIGINAL file path (the napi opens a filesystem
  /// path, not a `weftcut-media://` asset URL); `outFormat` is the CPU transport
  /// format from the routing table (exportDecodeRouting.ts); `creditWindow`
  /// sizes the in-flight flow-control window.
  nativeExport?: {
    sourcePath: string;
    outFormat: import("../exportDecodeRouting").ExportTransportFormat;
    creditWindow: number;
  };
}

/// Decoded-frame surface as exposed to the Compositor / VideoClipSprite.
/// Preview returns `ImageBitmap` (decoupled from the WebCodecs decoder's buffer
/// pool); export returns `VideoFrame` (evicted after each composited output);
/// 10-bit export returns `TenBitFrame` (CPU-plane copy); the native 8-bit
/// export lane returns `NativeNv12Frame` (relay CPU planes). PixiJS v8
/// `ImageSource` accepts VideoFrame and ImageBitmap; TenBitFrame and
/// NativeNv12Frame are routed through their ingest shaders to
/// `bindExternalTexture` instead.
export type DecodedFrame = VideoFrame | ImageBitmap | TenBitFrame | NativeNv12Frame;

/// Minimal frame-by-PTS surface the Compositor reads through. Implemented by
/// `FrameRing` (preview) and `ExportFrameStore` (export).
export interface FrameStore {
  frameAt(tUs: number): DecodedFrame | null;
  containsPts(tUs: number): boolean;
  /// PTS (µs) of the earliest cached frame, or null if empty.
  firstPtsUs(): number | null;
  /// PTS (µs) of the latest cached frame, or null if empty.
  lastPtsUs(): number | null;
  /// Number of cached entries, for the dev `PerfHUD`.
  size(): number;
}

/// The surface the Compositor composites through (the minimal decode contract).
/// requestFrameAt/onFirstFrame stay here: a synchronous, pre-staged source
/// (export) satisfies them as documented no-ops (Null Object). The trailing
/// members are honestly optional — an engine that cannot provide a value simply
/// omits the method (WebCodecs has decodeQueueSize/decodedFrameCount, FfmpegSource
/// does not; onFatalError is FfmpegSource-only, WebCodecs self-heals internally).
export interface DecodeSession {
  readonly mediaId: string;
  readonly ring: FrameStore;
  readonly disposed: boolean;
  ensureReady(): Promise<void>;
  dispose(): void;
  /// Preview nudges the decoder's lookahead each tick; export no-ops (frames
  /// are pre-staged by its own driver).
  requestFrameAt(tUs: number): Promise<void>;
  /// Preview repaints on the first decoded frame; export no-ops (its composite
  /// runs synchronously).
  onFirstFrame(cb: () => void): void;
  /// Dev `PerfHUD` diagnostics — best-effort, engine-varying.
  decodeQueueSize?(): number;
  decodedFrameCount?(): number;
  isDowngraded?(): boolean;
  isLookaheadFull?(): boolean;
  /// Terminal ffmpeg-engine failure (after in-place HW→SW fallback also fails).
  /// FfmpegSource-only; the Compositor wires it to `markFfmpegUnusable`.
  onFatalError?(cb: (reason: string) => void): void;
}

/// Names preview's role. Structurally equal to `DecodeSession` under this bite;
/// its job is intent + being the type the preview implementers declare, so a
/// future preview-only divergence has a home.
export type PreviewDecodeSession = DecodeSession;

/// Export's extension: a named, compiler-checked contract for the driving
/// surface the export Worker uses. `ring` narrows to `ExportFrameStore` (adds
/// `waitForPts` / `isReadyFor` / `fail`).
export interface ExportDecodeSession extends DecodeSession {
  readonly ring: ExportFrameStore;
  decodeRange(aUs: number, bUs: number): Promise<void>;
  evictBefore(cutoffUs: number): void;
  /// Cumulative decode-work counter — packets fed (WebCodecs) or frames
  /// received (native). Aggregated into the export `done` perf payload as the
  /// re-seek-redundancy signal. Both concrete handles expose it as a field.
  dispatchedTotal: number;
  /// Color diagnostic captured off the FIRST decoded frame (config vs stamped
  /// colorSpace + format), forwarded in the perf payload for the E2E harness.
  firstFrameDiag: ExportColorDiag | null;
}

/// Pool surface used by the Compositor. Concrete pools may expose extra surface
/// (preview's idle sweeper, export's `handles` map) but the Compositor needs
/// only these.
export interface DecoderPool {
  acquire(init: SourceHandleInit): DecodeSession;
  release(key: string): void;
  dispose(): void;
}
