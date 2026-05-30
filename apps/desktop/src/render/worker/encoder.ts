// VideoEncoder + mediabunny mux of the encoded chunks into a non-fragmented
// MP4 buffer. No audio — audio export rides the Rust ffmpeg final-mux path.
//
// We keep our own VideoEncoder (config, GOP cadence, MessageChannel
// backpressure) and hand only the CONTAINER to mediabunny: an
// EncodedVideoPacketSource fed the encoder's output chunks, muxed by an
// Output + Mp4OutputFormat into an in-memory BufferTarget. (Replaces the
// prior mp4box createFile/addTrack/addSample/write path.)
//
// The encoder's `output` callback is synchronous, but `source.add` is async
// (it returns a backpressure Promise). We serialize adds through a promise
// chain headed by `output.start()`, capture the first error into `muxError`,
// and rethrow it at `finalize()`.

import {
  BufferTarget,
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
}

export class EncoderSink {
  private encoder: VideoEncoder;
  private output: Output<Mp4OutputFormat, BufferTarget>;
  private target: BufferTarget;
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
    this.target = new BufferTarget();
    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: this.target,
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

  /// Drain the encoder, flush the mux add-chain, finalize the Output, and
  /// return the MP4 byte buffer.
  async finalize(): Promise<ArrayBuffer> {
    await this.encoder.flush();
    this.encoder.close();
    // Wait for every queued `source.add` to complete.
    await this.addChain;
    if (this.muxError) throw this.muxError;
    await this.output.finalize();
    const buf = this.target.buffer;
    if (!buf) throw new Error("[weftcut/export] mux produced no buffer");
    return buf;
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
