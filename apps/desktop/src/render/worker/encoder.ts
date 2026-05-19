// VideoEncoder + mp4box.js mux of the encoded chunks into a temp
// video.mp4 buffer (no audio — audio export stays on the existing
// Rust ffmpeg path; P9 final mux combines them).
//
// Plan: docs/pixi-renderer-plan.md (P8)

import { DataStream, MP4BoxBuffer, createFile, type ISOFile } from "mp4box";

export interface EncoderInit {
  config: VideoEncoderConfig;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
}

/// Wraps `VideoEncoder` + an mp4box.js muxer. Frames flow in via
/// `encodeFrame(frame, ptsUs, isKey)`; the muxer accumulates an
/// in-memory MP4 buffer that `finalize()` returns. Backpressure is
/// applied by `encodeQueueSize` — callers `await` when the queue
/// climbs to keep memory bounded.
export class EncoderSink {
  private encoder: VideoEncoder;
  private mp4: ISOFile;
  /// Track ID returned by mp4box.addTrack — populated on the first
  /// `output` callback once the config description is available.
  private trackId: number | null = null;
  /// Buffer concatenation. mp4box writes initialization + sample
  /// data into discrete chunks; we accumulate them and return one
  /// concatenated `ArrayBuffer` on finalize.
  private chunks: Uint8Array[] = [];
  private framesEncoded = 0;
  private width: number;
  private height: number;
  private fpsNum: number;
  private fpsDen: number;
  /// VideoEncoder.output's `description` carries the avcC payload
  /// (for H.264). We need it to call `mp4.addTrack`. The first
  /// chunk's metadata supplies it.
  private addingTrack = false;

  constructor(init: EncoderInit) {
    this.width = init.width;
    this.height = init.height;
    this.fpsNum = init.fpsNum;
    this.fpsDen = init.fpsDen;

    this.mp4 = createFile();
    // mp4box writes initialization segment + media data into
    // chunks via this callback.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.mp4 as any).onSegment = (
      _trackId: number,
      _user: unknown,
      buffer: ArrayBuffer,
    ): void => {
      this.chunks.push(new Uint8Array(buffer));
    };

    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => this.onEncodedChunk(chunk, metadata),
      error: (e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[weftcut/export] encoder error:", e);
      },
    });
    this.encoder.configure(init.config);
  }

  /// Encode one frame. Caller transfers `frame` ownership — we
  /// close it after encoder.encode returns.
  encodeFrame(frame: VideoFrame, isKey: boolean): void {
    this.encoder.encode(frame, { keyFrame: isKey });
    this.framesEncoded += 1;
    frame.close();
  }

  /// Block until the encoder's pending queue drains below `threshold`.
  /// Use to bound memory while feeding frames faster than encode.
  async awaitQueueBelow(threshold: number): Promise<void> {
    while (this.encoder.encodeQueueSize > threshold) {
      await new Promise<void>((r) => setTimeout(r, 1));
    }
  }

  /// Flush the encoder + close the mp4 + return the muxed bytes.
  async finalize(): Promise<ArrayBuffer> {
    await this.encoder.flush();
    this.encoder.close();
    // mp4box flush — emit final mdat / moov.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.mp4 as any).flush?.();

    // Concatenate all accumulated chunks into one buffer.
    let total = 0;
    for (const c of this.chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    // Detach the underlying buffer so we can transfer it to the
    // main thread without a copy.
    return out.buffer;
  }

  dispose(): void {
    try {
      this.encoder.close();
    } catch {
      // ignore
    }
    this.chunks = [];
  }

  private onEncodedChunk(
    chunk: EncodedVideoChunk,
    metadata?: EncodedVideoChunkMetadata,
  ): void {
    if (this.trackId === null) {
      // Configure the mp4box track using the encoder's reported
      // description (avcC for H.264, hvcC for HEVC, etc).
      const description = metadata?.decoderConfig?.description;
      const desc =
        description instanceof ArrayBuffer
          ? new Uint8Array(description)
          : description instanceof Uint8Array
            ? description
            : description
              ? new Uint8Array(description as ArrayBufferLike)
              : new Uint8Array(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.trackId = (this.mp4 as any).addTrack({
        type: "avc1",
        width: this.width,
        height: this.height,
        timescale: 1_000_000,
        avcDecoderConfigRecord: desc.buffer.slice(
          desc.byteOffset,
          desc.byteOffset + desc.byteLength,
        ),
      }) as number;
      if (this.trackId == null) {
        // eslint-disable-next-line no-console
        console.error("[weftcut/export] mp4box.addTrack returned null");
        return;
      }
      this.addingTrack = true;
      // mp4box needs onSegment subscribed before samples flow.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.mp4 as any).setSegmentOptions?.(this.trackId, null, {
        nbSamples: 1,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const initSeg = (this.mp4 as any).initializeSegmentation?.();
      if (Array.isArray(initSeg)) {
        for (const seg of initSeg) {
          if (seg.buffer instanceof ArrayBuffer) {
            this.chunks.push(new Uint8Array(seg.buffer));
          }
        }
      }
      this.addingTrack = false;
    }

    if (this.trackId == null) return;

    // Convert EncodedVideoChunk to an mp4box sample.
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const buf = MP4BoxBuffer.fromArrayBuffer(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      0,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.mp4 as any).addSample(this.trackId, buf, {
      duration: chunk.duration ?? Math.round(1_000_000 * this.fpsDen / this.fpsNum),
      cts: chunk.timestamp,
      dts: chunk.timestamp,
      is_sync: chunk.type === "key",
    });
    // Silence the unused-private warning about `addingTrack`.
    void this.addingTrack;
    // Silence unused import (DataStream is exported by mp4box and
    // pulled into the closure for typing parity with the demuxer).
    void DataStream;
  }
}
