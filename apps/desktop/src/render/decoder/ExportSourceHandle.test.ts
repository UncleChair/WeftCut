// Control-flow half of the export EOS tail-deadlock fix, tested with a fake
// decoder + scripted packet sink (no WebCodecs in node).
//
// The export worker is strictly "6a dispatch (decodeRange) → 6b consume
// (waitForPts)" per chunk, and only 6b frees VideoFrame pool slots. So
// `decodeRange` must NEVER block on anything that needs consumer progress to
// complete — above all a floated EOS `decoder.flush()` stalled on pool
// exhaustion (the observed export freeze at 12660/12731 with ~71 tail frames
// spanning the last two chunks).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceHandleInit } from "./SourceDecoderPool";
import { ExportSourceHandle } from "./ExportDecoderPool";
import { openMediaInput } from "./mediaInput";

vi.mock("./mediaInput", () => ({ openMediaInput: vi.fn() }));

interface FakePacket {
  timestamp: number; // seconds — mediabunny's EncodedPacket unit
  type: "key" | "delta";
  toEncodedVideoChunk: () => EncodedVideoChunk;
}

function pkt(tSec: number, type: "key" | "delta"): FakePacket {
  return { timestamp: tSec, type, toEncodedVideoChunk: () => ({}) as EncodedVideoChunk };
}

function makeSink(packets: FakePacket[]) {
  return {
    async getKeyPacket(tSec: number): Promise<FakePacket | null> {
      let found: FakePacket | null = null;
      for (const p of packets) {
        if (p.type === "key" && p.timestamp <= tSec) found = p;
      }
      return found;
    },
    async getFirstPacket(): Promise<FakePacket | null> {
      return packets[0] ?? null;
    },
    async getNextPacket(p: FakePacket): Promise<FakePacket | null> {
      const i = packets.indexOf(p);
      return i >= 0 && i + 1 < packets.length ? packets[i + 1]! : null;
    },
  };
}

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  readonly output: (frame: VideoFrame) => void;
  decoded: unknown[] = [];
  flushCalls = 0;
  closed = false;
  decodeQueueSize = 0;
  private flushResolvers: Array<() => void> = [];

  constructor(init: { output: (frame: VideoFrame) => void; error: (e: unknown) => void }) {
    this.output = init.output;
    FakeVideoDecoder.instances.push(this);
  }
  configure(_cfg: VideoDecoderConfig): void {}
  decode(chunk: unknown): void {
    this.decoded.push(chunk);
  }
  flush(): Promise<void> {
    this.flushCalls += 1;
    // Stays PENDING until the test resolves it — models a drain stalled on
    // VideoFrame-pool exhaustion (no consumer freeing slots yet).
    return new Promise((resolve) => this.flushResolvers.push(resolve));
  }
  resolveFlush(): void {
    for (const r of this.flushResolvers.splice(0)) r();
  }
  close(): void {
    this.closed = true;
  }
}

/// Decoder OUTPUT frame stub (what `ring.push` receives) — distinct from the
/// store tests' fakeFrame only in that the diag path reads colorSpace/format.
function decodedFrame(ptsUs: number, durationUs: number): VideoFrame {
  return { timestamp: ptsUs, duration: durationUs, close: () => {} } as unknown as VideoFrame;
}

/// Race a promise against a short timer. All fakes settle in microtasks, so
/// "blocked" reliably means "would park forever", not "was slow".
function settledWithin(p: Promise<unknown>, ms = 150): Promise<"settled" | "blocked"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), ms)),
  ]);
}

let sink: ReturnType<typeof makeSink>;

function makeHandle(): ExportSourceHandle {
  const init: SourceHandleInit = {
    layerId: "layer-1",
    mediaId: "media-1",
    proxyAssetUrl: "asset://localhost/test.mp4",
  };
  return new ExportSourceHandle(init);
}

beforeEach(() => {
  FakeVideoDecoder.instances = [];
  vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
  vi.mocked(openMediaInput).mockImplementation(async () =>
    ({
      videoTrack: {
        getDecoderConfig: async () =>
          ({ codec: "avc1.640028", codedWidth: 1920, codedHeight: 1080 }) as VideoDecoderConfig,
      },
      packetSink: sink,
      dispose: () => {},
    }) as unknown as Awaited<ReturnType<typeof openMediaInput>>,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ExportSourceHandle EOS tail", () => {
  it("does not block a forward tail range on a stalled EOS flush (export-freeze regression)", async () => {
    // Single trailing GOP: key@0 + deltas to 0.98s, nothing after — chunk A's
    // dispatch runs straight into EOS and floats the flush.
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 49; i++) packets.push(pkt(i * 0.02, "delta"));
    sink = makeSink(packets);
    const h = makeHandle();

    await h.decodeRange(0, 500_000);
    const dec = FakeVideoDecoder.instances[0]!;
    expect(dec.flushCalls).toBe(1);
    expect(dec.decoded.length).toBe(50);

    // The flush is STALLED (never resolved here). Chunk B's range lies fully
    // inside the already-dispatched tail: it must return promptly so the worker
    // can reach `waitForPts` (the only thing that frees pool slots). Awaiting
    // the stalled flush here IS the deadlock.
    await expect(settledWithin(h.decodeRange(500_000, 1_000_000))).resolves.toBe("settled");
    expect(dec.decoded.length).toBe(50); // no packets were re-dispatched
  });

  it("issues the EOS flush even when the discovering range dispatched zero packets", async () => {
    // The stream's LAST packet is a key just past chunk A's range end: chunk A
    // dispatches it via the stop-after-key rule and exits WITHOUT seeing EOS.
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 24; i++) packets.push(pkt(i * 0.02, "delta")); // ..0.48s
    packets.push(pkt(0.5, "key"));
    sink = makeSink(packets);
    const h = makeHandle();

    await h.decodeRange(0, 480_000);
    const dec = FakeVideoDecoder.instances[0]!;
    expect(dec.flushCalls).toBe(0);

    // Chunk B continues from the cursor and finds nothing: true EOS with
    // dispatched === 0. Without a flush the final GOP's frames stay parked in
    // the reorder buffer and the consumer hangs (the lone-IDR shape).
    await h.decodeRange(500_000, 980_000);
    expect(dec.flushCalls).toBe(1);
  });

  it("rebuilds the decoder for a backward clip-reuse range instead of awaiting a stalled flush", async () => {
    // Two GOPs (key@0, key@1.0), EOS after 1.48s.
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 49; i++) packets.push(pkt(i * 0.02, "delta")); // ..0.98s
    packets.push(pkt(1.0, "key"));
    for (let i = 1; i <= 24; i++) packets.push(pkt(1.0 + i * 0.02, "delta")); // ..1.48s
    sink = makeSink(packets);
    const h = makeHandle();

    await h.decodeRange(0, 990_000); // ends on the key@1.0 stop-after-key break
    await h.decodeRange(1_000_000, 1_500_000); // runs to EOS → flush floated
    const first = FakeVideoDecoder.instances[0]!;
    expect(first.flushCalls).toBe(1);

    // A later clip reuses this media from t=0 while the flush is still in
    // flight. A re-seek needs a fresh keyframe start anyway — rebuild and go;
    // awaiting the (possibly pool-stalled) flush deadlocks the export.
    await expect(settledWithin(h.decodeRange(0, 200_000))).resolves.toBe("settled");
    expect(FakeVideoDecoder.instances.length).toBe(2);
    const second = FakeVideoDecoder.instances[1]!;
    expect(second.decoded.length).toBeGreaterThan(0); // re-seeked into the fresh decoder
    expect(first.closed).toBe(true);
  });

  it("finalizes the ring when the EOS flush completes so grid-overhang waits clamp", async () => {
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 10; i++) packets.push(pkt(i * 0.02, "delta")); // ..0.2s
    sink = makeSink(packets);
    const h = makeHandle();

    await h.decodeRange(0, 500_000); // runs to EOS → flush floated
    const dec = FakeVideoDecoder.instances[0]!;
    expect(dec.flushCalls).toBe(1);

    // The drain emits the true-last frame, then the flush completes. A consumer
    // target past the last frame (composition grid longer than the video track)
    // must then clamp instead of parking forever.
    dec.output(decodedFrame(200_000, 20_000));
    const wait = h.ring.waitForPts(300_000);
    dec.resolveFlush();
    await expect(settledWithin(wait)).resolves.toBe("settled");
    expect(h.ring.frameAt(300_000)).not.toBeNull();
  });
});
