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

function makeHandle(extra?: Partial<SourceHandleInit>): ExportSourceHandle {
  const init: SourceHandleInit = {
    layerId: "layer-1",
    mediaId: "media-1",
    proxyAssetUrl: "asset://localhost/test.mp4",
    ...extra,
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

  it("issues exactly one EOS flush when the stream ends on a stop-after-key boundary", async () => {
    // The stream's LAST packet is a key just past chunk A's range end. The
    // pre-fix code dispatched it via the stop-after-key rule, exited without
    // seeing EOS, and chunk B's continue then found nothing with dispatched
    // === 0 — no flush was EVER issued, parking the final GOP forever (the
    // lone-IDR shape). Whether EOS is discovered during A (leading-B peek) or
    // B (zero-dispatch probe), exactly one flush must be in flight after both.
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 24; i++) packets.push(pkt(i * 0.02, "delta")); // ..0.48s
    packets.push(pkt(0.5, "key"));
    sink = makeSink(packets);
    const h = makeHandle();

    await h.decodeRange(0, 480_000);
    await h.decodeRange(500_000, 980_000);
    const dec = FakeVideoDecoder.instances[0]!;
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

  // The stop-after-key rule overshoots the dispatch frontier to the NEXT GOP's
  // key pts. The continue-vs-seek decision must use COVERAGE semantics, not the
  // per-packet frontier: a forward range starting below the overshot key is NOT
  // a backward jump. Re-seeking from the range's GOP key re-feeds the whole
  // stream prefix BEHIND the consumer — the decoder then re-emits stale early
  // frames interleaved with the live tail and `frameAt` serves them into the
  // output (observed: source frame 12 composited at output 150 on a 5s-GOP
  // source; outputs 145..151 corrupted around the GOP boundary).
  it("treats a forward range under the overshot key frontier as covered/continuing, never a re-seek", async () => {
    // Two GOPs: key@0 (+49 deltas to 0.98s), key@1.0 (+25 deltas to 1.5s).
    const packets = [pkt(0, "key")];
    for (let i = 1; i <= 49; i++) packets.push(pkt(i * 0.02, "delta"));
    packets.push(pkt(1.0, "key"));
    for (let i = 1; i <= 25; i++) packets.push(pkt(1.0 + i * 0.02, "delta"));
    sink = makeSink(packets);
    const h = makeHandle();

    // Chunk 1 [0..0.4s): stop-after-key dispatches through key@1.0 — the
    // frontier overshoots to 1.0s while coverage is only "everything ≤ 1.0s".
    await h.decodeRange(0, 400_000);
    const dec = FakeVideoDecoder.instances[0]!;
    const fedAfterChunk1 = dec.decoded.length;
    expect(fedAfterChunk1).toBe(51); // key@0 + 49 deltas + key@1.0

    // Chunk 2 [0.4s..0.8s): fully covered by chunk 1's dispatch. Nothing to
    // feed — and CRUCIALLY no re-seek back to key@0 (the corruption source).
    await h.decodeRange(400_000, 800_000);
    expect(dec.decoded.length).toBe(fedAfterChunk1);

    // Chunk 3 [0.8s..1.2s): extends past the parked key — continues from the
    // cursor (packets after key@1.0), still without re-feeding the prefix.
    await h.decodeRange(800_000, 1_200_000);
    expect(dec.decoded.length).toBeGreaterThan(fedAfterChunk1);
    expect(dec.decoded.length).toBeLessThanOrEqual(packets.length);
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

// TenBitFrame reorder-margin: a SW 10-bit decoder holds trailing B-frames in its
// reorder tail internally (never emits them without seeing the next GOP key or a
// flush). The margin feeds up to TENBIT_REORDER_MARGIN extra packets past the
// stop key so those trailing frames drain without an explicit mid-export flush.
describe("ExportSourceHandle tenBitLane reorder margin", () => {
  it("dispatches a reorder margin past the stop key when tenBitLane is true", async () => {
    // Two GOPs. key@0 + 9 deltas, key@0.333 + 13 more deltas (24 total).
    // Range ends at 300_000 µs (before the second key), so the normal dispatch
    // exits at the stop key (key@0.333). With tenBitLane the margin keeps going.
    const packets: FakePacket[] = [pkt(0, "key")];
    for (let i = 1; i <= 9; i++) packets.push(pkt(i * 0.02, "delta")); // 0.02..0.18s
    packets.push(pkt(0.333, "key")); // stop key for a 300_000 µs bUs
    for (let i = 1; i <= 13; i++) packets.push(pkt(0.333 + i * 0.02, "delta")); // 13 more
    sink = makeSink(packets);

    // Baseline: no tenBitLane — dispatch stops right at the stop key.
    const hBase = makeHandle();
    await hBase.decodeRange(0, 300_000);
    const decBase = FakeVideoDecoder.instances[0]!;
    const dispatchedBase = decBase.decoded.length;
    // Should have dispatched key@0 + 9 deltas + key@0.333 = 11 packets.
    expect(dispatchedBase).toBe(11);

    // Reset instances for the next handle.
    FakeVideoDecoder.instances = [];

    // With tenBitLane: same range, but the margin adds more packets past the key.
    const hTenBit = makeHandle({ tenBitLane: true });
    await hTenBit.decodeRange(0, 300_000);
    const decTenBit = FakeVideoDecoder.instances[0]!;
    const dispatchedTenBit = decTenBit.decoded.length;

    // The margin adds up to min(16, remaining=13) = 13 more packets.
    // So total = 11 (base) + 13 (margin) = 24 — all packets in the stream.
    expect(dispatchedTenBit).toBeGreaterThan(dispatchedBase);
    // Margin is capped at 16; remaining is 13, so margin = 13.
    expect(dispatchedTenBit).toBe(dispatchedBase + 13);
  });
});

// preferSoftware: 10-bit decode has no HW path; pre-configure SW to skip the
// HW-error→fallback round-trip. Also verify the default stays prefer-hardware.
describe("ExportSourceHandle preferSoftware", () => {
  it("captures the hardwareAcceleration config via spy before ensureReady", async () => {
    const packets = [pkt(0, "key")];
    sink = makeSink(packets);

    // Capture configure calls by overriding FakeVideoDecoder's configure before
    // the handle calls ensureReady.
    const configuredWith: VideoDecoderConfig[] = [];
    const OrigFakeDecoder = FakeVideoDecoder;
    // Patch the class-level configure to capture calls.
    const OrigProto = FakeVideoDecoder.prototype as { configure: (cfg: VideoDecoderConfig) => void };
    const origConfigure = OrigProto.configure;
    OrigProto.configure = function (cfg: VideoDecoderConfig) {
      configuredWith.push(cfg);
      origConfigure.call(this, cfg);
    };

    try {
      // preferSoftware: true → hardwareAcceleration must be "prefer-software"
      FakeVideoDecoder.instances = [];
      const hSW = makeHandle({ preferSoftware: true });
      await hSW.ensureReady();
      expect(configuredWith.length).toBeGreaterThanOrEqual(1);
      expect(configuredWith[0]!.hardwareAcceleration).toBe("prefer-software");

      configuredWith.length = 0;
      FakeVideoDecoder.instances = [];

      // default (no preferSoftware) → hardwareAcceleration must be "prefer-hardware"
      const hDefault = makeHandle();
      await hDefault.ensureReady();
      expect(configuredWith.length).toBeGreaterThanOrEqual(1);
      expect(configuredWith[0]!.hardwareAcceleration).toBe("prefer-hardware");
    } finally {
      OrigProto.configure = origConfigure;
      void OrigFakeDecoder; // suppress unused warning
    }
  });
});
