// VideoEncoder + mp4box.js mux of the encoded chunks into a regular
// (non-fragmented) MP4 buffer. No audio — audio export rides the
// existing Rust ffmpeg path; P9 final mux combines them.
//
// Plan: docs/pixi-renderer-plan.md (P8)
//
// mp4box mux pattern (per `isofile-advanced-creation.js`):
//   1. `createFile()` — ISOFile with no boxes.
//   2. `addTrack({ type, width, height, timescale, avcDecoderConfigRecord })`
//      — creates moov/trak/mdia/.../stsd entries. Returns trackId.
//      Internally calls `init({...})` first to add ftyp + moov.
//   3. For each encoded chunk: `addSample(trackId, data, { duration,
//      cts, dts, is_sync })`.
//   4. `file.write(stream)` — serialize everything to a DataStream.
//      The stream's `buffer` is the final MP4 byte buffer.
//
// We deliberately do NOT use `setSegmentOptions` / `onSegment` —
// those configure fragmented-MP4 (CMAF / DASH) output, which
// requires `info.fragment_duration` from the demux side that
// doesn't exist when we're MUXing from scratch. That mismatch was
// the source of the prior "fragment_duration undefined" crash.

import { DataStream, createFile, type ISOFile } from "mp4box";

export interface EncoderInit {
  config: VideoEncoderConfig;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
}

export class EncoderSink {
  private encoder: VideoEncoder;
  private mp4: ISOFile;
  private trackId: number | null = null;
  private framesEncoded = 0;
  private width: number;
  private height: number;
  private fpsNum: number;
  private fpsDen: number;

  constructor(init: EncoderInit) {
    this.width = init.width;
    this.height = init.height;
    this.fpsNum = init.fpsNum;
    this.fpsDen = init.fpsDen;
    this.mp4 = createFile();

    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => this.onEncodedChunk(chunk, metadata),
      error: (e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[weftcut/export] encoder error:", e);
      },
    });
    this.encoder.configure(init.config);
  }

  encodeFrame(frame: VideoFrame, isKey: boolean): void {
    this.encoder.encode(frame, { keyFrame: isKey });
    this.framesEncoded += 1;
    frame.close();
  }

  /// Yield until the encoder's internal queue drains below `threshold`.
  /// Caller uses this between frames to bound memory.
  async awaitQueueBelow(threshold: number): Promise<void> {
    while (this.encoder.encodeQueueSize > threshold) {
      await new Promise<void>((r) => setTimeout(r, 1));
    }
  }

  /// Drain the encoder, serialize the ISOFile to a single MP4 byte
  /// buffer, and return it.
  async finalize(): Promise<ArrayBuffer> {
    await this.encoder.flush();
    this.encoder.close();

    // Serialize moov + mdat into one DataStream. mp4box's
    // ISOFile.write walks every accumulated box.
    const stream = new DataStream();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.mp4 as any).write(stream);
    // mp4box's DataStream uses an internal growing buffer; the
    // current valid byte length is `position` after write.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const written = (stream as any).position as number | undefined;
    const totalBytes = written ?? stream.buffer.byteLength;
    // Return a fresh ArrayBuffer slice covering exactly the
    // written bytes so the main thread can transfer it without
    // dragging any extra capacity.
    return stream.buffer.slice(0, totalBytes);
  }

  dispose(): void {
    try {
      this.encoder.close();
    } catch {
      // already closed
    }
  }

  private onEncodedChunk(
    chunk: EncodedVideoChunk,
    metadata?: EncodedVideoChunkMetadata,
  ): void {
    if (this.trackId === null) {
      // Build the avc1 track using the encoder's reported codec
      // description (the avcC payload for H.264).
      const description = metadata?.decoderConfig?.description;
      const descBytes =
        description instanceof Uint8Array
          ? description
          : description instanceof ArrayBuffer
            ? new Uint8Array(description)
            : description
              ? new Uint8Array(description as ArrayBufferLike)
              : new Uint8Array(0);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = (this.mp4 as any).addTrack({
        type: "avc1",
        width: this.width,
        height: this.height,
        // Timescale = 1e6 → sample CTS/DTS are microseconds (matches
        // EncodedVideoChunk.timestamp).
        timescale: 1_000_000,
        // mp4box looks for `avcDecoderConfigRecord` on the options to
        // populate the stsd's avcC payload. Pass as ArrayBuffer (slice
        // off any offset).
        avcDecoderConfigRecord: descBytes.buffer.slice(
          descBytes.byteOffset,
          descBytes.byteOffset + descBytes.byteLength,
        ),
      }) as number;
      this.trackId = id;
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/export] mp4 track added id=${id} ${this.width}×${this.height} ` +
          `desc=${descBytes.byteLength}B`,
      );
    }

    if (this.trackId == null) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const sampleDurationUs =
      chunk.duration ?? Math.round((1_000_000 * this.fpsDen) / this.fpsNum);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.mp4 as any).addSample(this.trackId, data, {
      duration: sampleDurationUs,
      cts: chunk.timestamp,
      dts: chunk.timestamp,
      is_sync: chunk.type === "key",
    });
    void this.framesEncoded;
  }
}
