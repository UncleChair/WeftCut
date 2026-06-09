// VideoEncoder + mediabunny mux of encoded chunks into a fragmented MP4 stream.
// No audio — audio export rides the Rust ffmpeg final mux/transcode path.
//
// We keep our own VideoEncoder (config, GOP cadence, MessageChannel
// backpressure) and hand only the CONTAINER to mediabunny: an
// EncodedVideoPacketSource fed the encoder's output chunks, muxed by an
// Output + fragmented Mp4OutputFormat into an AppendOnlyStreamTarget.
// (Replaces the prior mp4box createFile/addTrack/addSample/write path.)
//
// The encoder's `output` callback is synchronous, but `source.add` is async
// (it returns a backpressure Promise). We serialize adds through a promise
// chain headed by `output.start()`, capture the first error into `muxError`,
// and rethrow it at `finalize()`.

import {
  AppendOnlyStreamTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { webCodecsToMediabunnyVideoCodec } from "./muxCodec";

export interface EncoderInit {
  config: VideoEncoderConfig;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  /// Sink for each sequential slice of the output file. Returns a promise that
  /// resolves once the slice is durably written (e.g. appended to disk on the
  /// main thread); the mux applies backpressure on it, so the encoder throttles
  /// to the write speed and the whole MP4 is never held in memory. Fragmented
  /// MP4 + AppendOnlyStreamTarget guarantee these slices are sequential.
  onChunk: (data: Uint8Array) => Promise<void>;
}

export class EncoderSink {
  private encoder: VideoEncoder;
  private output: Output<Mp4OutputFormat, AppendOnlyStreamTarget>;
  private videoSource: EncodedVideoPacketSource;
  /// Serializes the async `source.add` calls in encode/output order. Headed
  /// by `output.start()` so the first add waits for the output to be ready.
  private addChain: Promise<void>;
  /// First mux error (from `source.add`), rethrown at finalize. Once set, we
  /// stop adding so we don't pile errors.
  private muxError: Error | null = null;
  /// The encoder's decoder config rides the FIRST add only.
  private firstAdd = true;
  private framesEncoded = 0;
  private yieldChannel: MessageChannel;
  private yieldWaiters: Array<() => void> = [];

  constructor(init: EncoderInit) {
    // Fragmented MP4 writes strictly sequentially (moof+mdat fragments, no
    // back-patching), so an append-only stream works — each slice is posted to
    // the main thread (which appends it to the temp file) and the WritableStream
    // backpressure throttles the encoder. The Rust mux re-containers this fMP4
    // into the user's chosen container, so it's an invisible intermediate.
    // Batch the muxer's many small box-level writes into ~8 MB slices before
    // posting to the main thread — far fewer worker→main→disk round-trips on
    // long exports (each `onChunk` is a postMessage + Tauri writeFile).
    const FLUSH_BYTES = 8 * 1024 * 1024;
    let batch: Uint8Array[] = [];
    let batched = 0;
    const flushBatch = async (): Promise<void> => {
      if (batched === 0) return;
      const merged = new Uint8Array(batched);
      let off = 0;
      for (const slice of batch) {
        merged.set(slice, off);
        off += slice.byteLength;
      }
      batch = [];
      batched = 0;
      await init.onChunk(merged);
    };
    const writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        // Copy: mediabunny may reuse the chunk's buffer after write() resolves.
        batch.push(chunk.slice());
        batched += chunk.byteLength;
        if (batched >= FLUSH_BYTES) await flushBatch();
      },
      async close() {
        await flushBatch();
      },
    });
    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: "fragmented" }),
      target: new AppendOnlyStreamTarget(writable),
    });
    this.videoSource = new EncodedVideoPacketSource(
      webCodecsToMediabunnyVideoCodec(init.config.codec),
    );
    this.output.addVideoTrack(this.videoSource);
    // Head the add-chain with start(); the first `source.add` awaits it.
    this.addChain = this.output.start();

    this.yieldChannel = new MessageChannel();
    this.yieldChannel.port1.onmessage = () => {
      const waiters = this.yieldWaiters;
      this.yieldWaiters = [];
      for (const r of waiters) r();
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

  encodeFrame(frame: VideoFrame, isKey: boolean): void {
    this.encoder.encode(frame, { keyFrame: isKey });
    this.framesEncoded += 1;
    frame.close();
  }

  /// Yield until the encoder's internal queue drains below `threshold`.
  /// MessageChannel (not setTimeout) to dodge the 4 ms clamp.
  async awaitQueueBelow(threshold: number): Promise<void> {
    while (this.encoder.encodeQueueSize > threshold) {
      await new Promise<void>((resolve) => {
        this.yieldWaiters.push(resolve);
        this.yieldChannel.port2.postMessage(null);
      });
    }
  }

  /// Drain the encoder, flush the mux add-chain, and finalize the Output. The
  /// bytes were already streamed to the main thread via `onChunk` (finalize
  /// flushes the trailing fragments through the same path), so nothing is
  /// returned.
  async finalize(): Promise<void> {
    await this.encoder.flush();
    this.encoder.close();
    // Wait for every queued `source.add` to complete.
    await this.addChain;
    if (this.muxError) throw this.muxError;
    await this.output.finalize();
  }

  dispose(): void {
    try {
      this.encoder.close();
    } catch {
      // already closed
    }
    // Cancel the output if it never finalized, so internal resources free.
    if (this.output.state !== "finalized" && this.output.state !== "canceled") {
      void this.output.cancel();
    }
    this.yieldChannel.port1.close();
    this.yieldChannel.port2.close();
    this.yieldWaiters = [];
  }

  private onEncodedChunk(
    chunk: EncodedVideoChunk,
    metadata?: EncodedVideoChunkMetadata,
  ): void {
    // Build the packet synchronously (fromEncodedChunk copies the bytes), so
    // the transient chunk can be released; the decoder config rides the first
    // add only.
    const packet = EncodedPacket.fromEncodedChunk(chunk);
    const meta = this.firstAdd ? metadata : undefined;
    this.firstAdd = false;
    this.addChain = this.addChain.then(async () => {
      if (this.muxError) return;
      try {
        await this.videoSource.add(packet, meta);
      } catch (e) {
        this.muxError ??= e instanceof Error ? e : new Error(String(e));
      }
    });
    void this.framesEncoded;
  }
}
