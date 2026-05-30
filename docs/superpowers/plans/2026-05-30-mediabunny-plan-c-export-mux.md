# mediabunny Migration — Plan C: export decode path + mux

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the export path off mp4box.js onto mediabunny — decode (`ExportSourceHandle` → `EncodedPacketSink`) and mux (`encoder.ts` → mediabunny `Output`) — then delete `Demuxer.ts` and the mp4box dependency entirely.

**Architecture:** Mux keeps our tuned `VideoEncoder` and swaps only the container (`Output` + `EncodedVideoPacketSource` + `BufferTarget` + `Mp4OutputFormat`), fed the encoder's chunks via a promise chain. Decode replaces the mp4box sample table with an async seek-and-forward loop over `getKeyPacket`/`getNextPacket`, deleting the byte pre-fault. The `ExportFrameStore` (waitForPts/evict-after-use) and the worker's encode loop are unchanged. Order: mux first (fixture-covered), then decode, then drop mp4box.

**Tech Stack:** TypeScript, Vitest (node), Vitest browser-mode (Playwright/Chromium) for fixtures, mediabunny, WebCodecs.

**Spec:** `docs/superpowers/specs/2026-05-30-mediabunny-plan-c-export-mux-design.md`. Depends on Plan A (`openMediaInput`) + Plan B (preview already off mp4box).

---

## Design notes (read before starting)

1. **Approach A (surgical mux).** We keep the `VideoEncoder` untouched — only the container changes. This is why the existing pixel-exact fixture-comparison stays a *valid* regression gate for the mux: same encoder → same encoded stream → only the wrapper differs.
2. **`source.add` is async; the encoder `output` callback is sync.** Serialize adds through a promise chain headed by `output.start()`; `finalize()` awaits the chain. Errors are captured into `muxError` (no unhandled rejection) and rethrown at finalize.
3. **Export fails loud.** Unlike preview (hold last frame), a packet-read or mux error aborts the export with a clear message — export is all-or-nothing.
4. **B-frame boundary (decode).** `decodeRange` decodes in *decode order* through the first key packet **strictly after** `bUs` (inclusive), so every frame with presentation PTS ≤ `bUs` — including open-GOP B-frames that reference the next GOP's key — is dispatched. For `-bf 0` proxies (the common case) this just decodes whole GOPs. Verify on a real B-frame original in manual acceptance.
5. **Verification posture (your choice):** mux is gated by the automated fixture-comparison; the decode path is **manual/carried** (export fixtures are synthetic/media-less). Same posture as Plan B's runtime acceptance.

**Verification commands** (learned during Plan B execution — the repo's `typecheck` npm script is broken):
- Type-check: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`, then **baseline-diff** — confirm no NEW errors mention the files you touched (the repo carries a pre-existing ~24-error baseline; capture it before each task and compare).
- Node suite: `npm --prefix apps/desktop test`
- Fixtures (mux gate): `npm --prefix apps/desktop run fixtures:render` then `npm --prefix apps/desktop run fixtures:check`. ⚠️ `fixtures:render` is Vitest browser-mode — first run needs `npx playwright install chromium` (~150 MB, one-time; the repo assigns this to the human, see `vitest.browser.config.ts`).

**Pinned mediabunny mux API** (verified against `node_modules/mediabunny/dist/mediabunny.d.ts`):
- `VIDEO_CODECS = ["avc","hevc","vp9","av1","vp8"]`; `type VideoCodec`.
- `new EncodedVideoPacketSource(codec: VideoCodec)`; `await source.add(packet: EncodedPacket, meta?: EncodedVideoChunkMetadata): Promise<void>` — packets in **decode order**, timestamp = presentation; **pass `meta` (the encoder's `decoderConfig`) on the first call only**.
- `EncodedPacket.fromEncodedChunk(chunk: EncodedVideoChunk): EncodedPacket` (copies the chunk's bytes).
- `new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })`; `output.addVideoTrack(source)` (metadata optional); `await output.start()` (before any add); `await output.finalize()`; `output.cancel()`; `output.state`; `target.buffer: ArrayBuffer | null` (non-null after finalize).
- Decode side (from Plan A/B): `openMediaInput(url) → { videoTrack, packetSink, dispose }`; `videoTrack.getDecoderConfig(): Promise<VideoDecoderConfig | null>`; `packetSink.getKeyPacket(tsSec)` / `getNextPacket(packet)` → `EncodedPacket | null`; `EncodedPacket.timestamp` (seconds), `.type` (`'key'|'delta'`), `.toEncodedVideoChunk()`.

---

## Task 1: `muxCodec` helper (WebCodecs codec string → mediabunny `VideoCodec`)

The one node-unit-testable piece. `EncodedVideoPacketSource` needs a mediabunny `VideoCodec` (`'avc'`…); our encoder config carries a WebCodecs codec string (`'avc1.640028'`).

**Files:**
- Create: `apps/desktop/src/render/worker/muxCodec.ts`
- Test: `apps/desktop/src/render/worker/muxCodec.test.ts`

- [ ] **Step 1: Pin the mux API**

Open `apps/desktop/node_modules/mediabunny/dist/mediabunny.d.ts` and confirm the "Pinned mediabunny mux API" block above (esp. `EncodedVideoPacketSource.add` signature, `EncodedPacket.fromEncodedChunk`, `Mp4OutputFormat` `fastStart` values, `BufferTarget.buffer`). If anything differs, update the block + the affected task before continuing.

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/render/worker/muxCodec.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { webCodecsToMediabunnyVideoCodec } from "./muxCodec";

describe("webCodecsToMediabunnyVideoCodec", () => {
  it("maps H.264 strings to 'avc'", () => {
    expect(webCodecsToMediabunnyVideoCodec("avc1.640028")).toBe("avc");
    expect(webCodecsToMediabunnyVideoCodec("avc3.42E01E")).toBe("avc");
  });
  it("maps HEVC strings to 'hevc'", () => {
    expect(webCodecsToMediabunnyVideoCodec("hev1.1.6.L93.B0")).toBe("hevc");
    expect(webCodecsToMediabunnyVideoCodec("hvc1.1.6.L93.B0")).toBe("hevc");
  });
  it("maps AV1 / VP9 / VP8", () => {
    expect(webCodecsToMediabunnyVideoCodec("av01.0.04M.08")).toBe("av1");
    expect(webCodecsToMediabunnyVideoCodec("vp09.00.10.08")).toBe("vp9");
    expect(webCodecsToMediabunnyVideoCodec("vp8")).toBe("vp8");
  });
  it("throws on an unrecognized codec", () => {
    expect(() => webCodecsToMediabunnyVideoCodec("mp4a.40.2")).toThrow(/unsupported/i);
  });
});
```

- [ ] **Step 3: Run — expect FAIL (module missing)**

Run: `cd apps/desktop && npx vitest run src/render/worker/muxCodec.test.ts`
Expected: FAIL — cannot find `./muxCodec`.

- [ ] **Step 4: Implement**

Create `apps/desktop/src/render/worker/muxCodec.ts`:

```ts
// Maps a WebCodecs codec string (the `codec` field of a VideoEncoderConfig,
// e.g. "avc1.640028") to the bare mediabunny VideoCodec ("avc") that
// `EncodedVideoPacketSource` is constructed with. The export encoder emits
// H.264 today; the others are mapped for completeness + a clear throw on
// anything we don't support, rather than a confusing failure deep in the mux.

import type { VideoCodec } from "mediabunny";

export function webCodecsToMediabunnyVideoCodec(codec: string): VideoCodec {
  const c = codec.toLowerCase();
  if (c.startsWith("avc1") || c.startsWith("avc3")) return "avc";
  if (c.startsWith("hev1") || c.startsWith("hvc1")) return "hevc";
  if (c.startsWith("av01")) return "av1";
  if (c.startsWith("vp09") || c === "vp9") return "vp9";
  if (c.startsWith("vp08") || c === "vp8") return "vp8";
  throw new Error(`muxCodec: unsupported video codec "${codec}"`);
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd apps/desktop && npx vitest run src/render/worker/muxCodec.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/render/worker/muxCodec.ts apps/desktop/src/render/worker/muxCodec.test.ts
git commit -m "feat(export): muxCodec — WebCodecs codec string → mediabunny VideoCodec"
```

---

## Task 2: Rewrite the mux in `encoder.ts` (mp4box → mediabunny `Output`)

Keep the `VideoEncoder` + `MessageChannel` backpressure; swap only the container. Verified by the existing fixture-comparison.

**Files:**
- Modify: `apps/desktop/src/render/worker/encoder.ts` (full rewrite of the file)

- [ ] **Step 1: Capture the typecheck baseline**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String "error TS" | Measure-Object` (PowerShell) — note the count + which files. (Expect the ~24-error pre-existing baseline; `encoder.ts` should NOT be among them.)

- [ ] **Step 2: Rewrite `encoder.ts`**

Replace the entire contents of `apps/desktop/src/render/worker/encoder.ts` with:

```ts
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
```

- [ ] **Step 3: Type-check (baseline-diff)**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`
Expected: same error set as Step 1 — **no new errors** mentioning `encoder.ts` or `muxCodec.ts`. (`init.width/height/fpsNum/fpsDen` are now unused fields of `EncoderInit`; that's fine — `noUnusedLocals` doesn't flag interface members, and the worker still passes them. Do NOT change `EncoderInit` — the worker constructs it.)

- [ ] **Step 4: Verify the mux via fixture-comparison**

```bash
# one-time, if not already installed:
cd apps/desktop && npx playwright install chromium
npm --prefix apps/desktop run fixtures:render   # browser export Worker → build/fixtures/*.mp4
npm --prefix apps/desktop run fixtures:check     # Rust fixture_compare, pixel-exact
```
Expected: `001_color` and `002_color_stack` PASS (pixel-exact). This proves the mediabunny-muxed MP4 is byte-compatible-enough that decoded pixels match — the mux swap is correct. If `fixtures:render` can't launch (no Chromium), install it first; this is the mux's only gate, so it must run.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/worker/encoder.ts
git commit -m "feat(export): mux on mediabunny Output (EncodedVideoPacketSource), drop mp4box mux"
```

---

## Task 3: Rewrite the export decode path (`ExportSourceHandle`)

Swap `Demuxer` for mediabunny `openMediaInput` + `EncodedPacketSink`; `decodeRange` becomes an async seek-and-forward loop. `ExportFrameStore` + the pool + the worker are untouched. Not node-unit-testable (WebCodecs) — verified by type-check + manual export acceptance (Task 5).

**Files:**
- Modify: `apps/desktop/src/render/decoder/ExportDecoderPool.ts`

- [ ] **Step 1: Swap imports**

Replace (lines ~19–21):
```ts
import { Demuxer, type VideoTrackMeta } from "./Demuxer";
import type { DecoderHandle, DecoderPool, FrameStore, SourceHandleInit } from "./SourceDecoderPool";
import { handleDecodeError } from "./decoderFallback";
```
with:
```ts
import type { EncodedPacket } from "mediabunny";
import type { DecoderHandle, DecoderPool, FrameStore, SourceHandleInit } from "./SourceDecoderPool";
import { handleDecodeError } from "./decoderFallback";
import { openMediaInput, type OpenedMedia } from "./mediaInput";
```

- [ ] **Step 2: Rewrite `ExportSourceHandle` fields + `ensureReady` + `buildConfig` + a `buildDecoder` helper**

Replace the field block + `ensureReady` + `_doEnsureReady` + `buildConfig` (currently lines ~149–282) with:

```ts
export class ExportSourceHandle implements DecoderHandle {
  readonly mediaId: string;
  private readonly proxyAssetUrl: string;
  readonly ring: ExportFrameStore;
  private opened: OpenedMedia | null = null;
  private config: VideoDecoderConfig | null = null;
  private decoder: VideoDecoder | null = null;
  private readyP: Promise<void> | null = null;
  /// Last packet dispatched to the decoder (decode order); null = unpositioned.
  private cursor: EncodedPacket | null = null;
  /// Presentation PTS (µs) of `cursor` — the dispatch frontier. Sentinel
  /// until the first dispatch; used to decide seek-vs-continue per range.
  private lastDispatchedPtsUs = Number.NEGATIVE_INFINITY;
  private outputFrameCount = 0;
  private downgraded = false;
  private _disposed = false;

  get disposed(): boolean {
    return this._disposed;
  }

  constructor(init: SourceHandleInit) {
    this.mediaId = init.mediaId;
    this.proxyAssetUrl = init.proxyAssetUrl;
    this.ring = new ExportFrameStore();
  }

  async ensureReady(): Promise<void> {
    if (this.config && this.decoder) return;
    if (this.readyP) return this.readyP;
    this.readyP = this._doEnsureReady();
    return this.readyP;
  }

  private async _doEnsureReady(): Promise<void> {
    this.opened = await openMediaInput(this.proxyAssetUrl);
    const config = await this.opened.videoTrack.getDecoderConfig();
    if (!config) {
      throw new Error(`[weftcut/export] ${this.mediaId}: no decoder config`);
    }
    this.config = config;
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] source ${this.mediaId} ready: codec=${config.codec} ` +
        `${config.codedWidth ?? "?"}x${config.codedHeight ?? "?"}`,
    );
    // Diagnostic: log whether HW decode is actually available in Worker scope
    // (Chrome sometimes silently lands on software; software 1080p ≈ 2 fps).
    if (typeof VideoDecoder.isConfigSupported === "function") {
      for (const hw of ["prefer-hardware", "prefer-software"] as const) {
        try {
          const supported = await VideoDecoder.isConfigSupported({
            ...config,
            hardwareAcceleration: hw,
          });
          // eslint-disable-next-line no-console
          console.log(
            `[weftcut/export] ${this.mediaId} isConfigSupported(${hw})=${supported.supported}`,
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[weftcut/export] isConfigSupported(${hw}) threw:`, e);
        }
      }
    }
    this.decoder = this.buildDecoder();
    this.decoder.configure(this.buildConfig());
  }

  /// Construct a fresh `VideoDecoder` with the identity-guarded output/error
  /// callbacks. Used by initial ready + the rebuild recovery paths.
  private buildDecoder(): VideoDecoder {
    let dec: VideoDecoder;
    dec = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (this.decoder !== dec) {
          frame.close();
          return;
        }
        this.outputFrameCount += 1;
        if (this.outputFrameCount === 1 || this.outputFrameCount % 30 === 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[weftcut/export] ${this.mediaId} output #${this.outputFrameCount}: ` +
              `pts=${frame.timestamp}us`,
          );
        }
        this.ring.push(frame);
      },
      error: (e: unknown) => {
        if (this.decoder !== dec) return;
        const err = e instanceof Error ? e : new Error(String(e));
        // eslint-disable-next-line no-console
        console.error(`[weftcut/export] decoder ${this.mediaId} error:`, err.message);
        const action = handleDecodeError({
          err,
          outputFrameCount: this.outputFrameCount,
          alreadyDowngraded: this.downgraded,
          mediaId: this.mediaId,
          // eslint-disable-next-line no-console
          log: (msg) => console.warn(`[weftcut/export] ${msg}`),
        });
        if (action.kind === "downgrade-to-software") {
          this.downgraded = true;
          this.rebuildDecoder();
        } else if (action.kind === "inactivity-rebuild") {
          this.rebuildDecoder();
        }
      },
    });
    return dec;
  }

  /// Build the decoder config, honoring `downgraded`. Spreads the full
  /// mediabunny config (colorSpace etc.) and overrides only hwAccel.
  private buildConfig(): VideoDecoderConfig {
    if (!this.config) {
      throw new Error(`[weftcut/export] ${this.mediaId}: buildConfig before ready`);
    }
    return {
      ...this.config,
      hardwareAcceleration: this.downgraded ? "prefer-software" : "prefer-hardware",
    };
  }

  /// Recovery: WebCodecs closes the codec before firing `error`, so
  /// reset()/configure() on the dead decoder throws — rebuild instead.
  /// Keeps the opened media; resets the cursor so the next decodeRange
  /// re-seeks a key packet into the fresh decoder. `downgraded` + in-store
  /// frames stay.
  private rebuildDecoder(): void {
    try {
      this.decoder?.close();
    } catch {
      // already closed
    }
    this.decoder = this.buildDecoder();
    this.decoder.configure(this.buildConfig());
    this.cursor = null;
    this.lastDispatchedPtsUs = Number.NEGATIVE_INFINITY;
  }
```

- [ ] **Step 3: Replace `downgradeToSoftware` / `rebuildAfterInactivity` / `requestFrameAt` / `onFirstFrame` / `decodeRange` / `evictBefore` / `dispose`**

Replace from the old `downgradeToSoftware` through the end of the class (currently lines ~284–486) with:

```ts
  /// Compositor's `setAnchorTime` reaches us here; export drives decoding via
  /// `decodeRange`, so this is a no-op.
  requestFrameAt(_tUs: number): Promise<void> {
    return Promise.resolve();
  }

  /// Export composites synchronously; no first-frame repaint needed.
  onFirstFrame(_cb: () => void): void {
    // intentional no-op
  }

  /// Decode every packet needed to cover the presentation range [aUs, bUs].
  /// Async: seeks to the GOP key at/before `aUs` (or continues from the
  /// cursor when the range moves forward of the dispatch frontier), then
  /// dispatches in DECODE order through the first key packet strictly after
  /// `bUs` (inclusive) — so every frame with presentation PTS ≤ bUs, incl.
  /// open-GOP B-frames referencing the next key, is fed. No flush (the
  /// worker awaits each frame via `ring.waitForPts`; flushing would deadlock
  /// against the held VideoFrame pool slots). Awaiting `getNextPacket`
  /// faults in uncached bytes natively — no pre-fault needed.
  async decodeRange(aUs: number, bUs: number): Promise<void> {
    if (!this.config || !this.decoder) await this.ensureReady();
    if (!this.config || !this.decoder) return;
    const packetSink = this.opened?.packetSink;
    if (!packetSink) return;

    // Position: continue from the cursor when aUs is at/ahead of the frontier
    // (the normal forward-export case); otherwise seek to aUs's GOP key.
    let pkt: EncodedPacket | null;
    if (this.cursor !== null && aUs >= this.lastDispatchedPtsUs) {
      pkt = await packetSink.getNextPacket(this.cursor);
    } else {
      pkt = await packetSink.getKeyPacket(aUs / 1e6);
    }
    if (this._disposed) return;

    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] ${this.mediaId} decodeRange pts=[${aUs}..${bUs}]us ` +
        `(start=${pkt ? Math.round(pkt.timestamp * 1e6) : "none"}us, ` +
        `frontier=${this.lastDispatchedPtsUs}us)`,
    );

    let dispatched = 0;
    while (pkt) {
      const ptsUs = Math.round(pkt.timestamp * 1e6);
      this.decoder.decode(pkt.toEncodedVideoChunk());
      this.cursor = pkt;
      this.lastDispatchedPtsUs = ptsUs;
      dispatched++;
      // Stop AFTER dispatching the first key strictly past bUs — that key
      // begins the GOP after bUs, so everything with PTS ≤ bUs (incl.
      // open-GOP B-refs) has now been fed.
      if (pkt.type === "key" && ptsUs > bUs) break;
      pkt = await packetSink.getNextPacket(pkt);
      if (this._disposed) return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] ${this.mediaId} decodeRange dispatched ${dispatched} ` +
        `(queue=${this.decoder.decodeQueueSize})`,
    );
  }

  evictBefore(cutoffUs: number): void {
    this.ring.evictBefore(cutoffUs);
  }

  dispose(): void {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // already closed
      }
      this.decoder = null;
    }
    this.ring.dispose();
    this.opened?.dispose();
    this.opened = null;
    this.config = null;
    this.readyP = null;
    this.cursor = null;
    this.lastDispatchedPtsUs = Number.NEGATIVE_INFINITY;
    this.outputFrameCount = 0;
    this.downgraded = false;
    this._disposed = true;
  }
}
```

- [ ] **Step 4: Fix the `ExportSourceHandle` top doc comment**

The class-level comment block still says "via the Demuxer sample table" etc. Update the file header comment (lines ~1–17) so it no longer references `Demuxer`/`sampleAt`/`ensureBlocksLoaded` — describe the mediabunny seek-and-forward `decodeRange`. (Cosmetic but keeps docs honest per the evergreen-docs convention.)

- [ ] **Step 5: Type-check (baseline-diff)**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`
Expected: baseline error set, **no new errors** in `ExportDecoderPool.ts`. In particular: `ExportSourceHandle` still `implements DecoderHandle` (its `ensureReady(): Promise<void>` satisfies the `Promise<unknown>` interface from Plan B); `ExportDecoderPool`/`ExportFrameStore` unchanged.

- [ ] **Step 6: Node suite (no regressions)**

Run: `npm --prefix apps/desktop test`
Expected: all green (no test imports `ExportDecoderPool` directly; this confirms the shared decoder/ring modules + types still resolve).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/render/decoder/ExportDecoderPool.ts
git commit -m "feat(export): decode on mediabunny packetSink (async decodeRange), drop demuxer sample table"
```

---

## Task 4: Drop mp4box + delete `Demuxer.ts`

After Tasks 2–3, nothing imports mp4box except `Demuxer.ts`, and nothing imports `Demuxer` except the `render/index.ts` re-export (and stale comments in `frames.ts`).

**Files:**
- Modify: `apps/desktop/src/render/index.ts`
- Modify: `apps/desktop/src/frames.ts` (comment hygiene)
- Delete: `apps/desktop/src/render/decoder/Demuxer.ts`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Grep-verify the importer set**

```bash
cd apps/desktop
grep -rln "from \"mp4box\"\|from 'mp4box'" src        # expect ONLY src/render/decoder/Demuxer.ts
grep -rln "decoder/Demuxer\|from \"./Demuxer\"" src    # expect render/index.ts + frames.ts (comments) only
```
If any OTHER file imports mp4box or `Demuxer`, stop — Tasks 2/3 missed a site; fix that first.

- [ ] **Step 2: Remove the `render/index.ts` re-export**

In `apps/desktop/src/render/index.ts`, delete line 15:
```ts
export { Demuxer } from "./decoder/Demuxer";
```
(If anything imported `Demuxer` from the `render` barrel, the type-check in Step 5 will surface it. Nothing should, post-Tasks 2–3.)

- [ ] **Step 3: De-stale the `frames.ts` comments**

`frames.ts` references `Demuxer.ts` in two doc comments (around lines 23 and 57) as the source-of-truth for PTS rounding. After deletion that file is gone. Edit both comments to describe the rounding rule inline (`Math.round((cts / timescale) * 1e6)`, half-up) without pointing at the deleted path — keep the *rule*, drop the dangling file reference.

- [ ] **Step 4: Delete `Demuxer.ts`**

```bash
git rm apps/desktop/src/render/decoder/Demuxer.ts
```
(No `Demuxer.test.ts` exists — confirmed.)

- [ ] **Step 5: Type-check (baseline-diff)**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`
Expected: baseline error set, **no new errors**, and specifically **no** "cannot find module './Demuxer'" or unresolved `VideoTrackMeta`/`IndexedSample`/`Demuxer` references anywhere. If one appears, a consumer was missed — resolve before removing the dep.

- [ ] **Step 6: Remove the mp4box dependency**

Edit `apps/desktop/package.json` — delete the `"mp4box": "..."` line from `dependencies`. Then:
```bash
npm --prefix apps/desktop install   # updates node_modules; package-lock is untracked by repo convention (don't commit it)
```

- [ ] **Step 7: Full verification**

```bash
cd apps/desktop && npx tsc --noEmit -p tsconfig.json   # baseline, no new errors
npm --prefix apps/desktop test                          # node suite green
grep -rn "mp4box" apps/desktop/src                      # expect ZERO matches
```

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/render/index.ts apps/desktop/src/frames.ts apps/desktop/package.json
git rm apps/desktop/src/render/decoder/Demuxer.ts
git commit -m "chore(decoder): delete mp4box Demuxer + drop the mp4box dependency"
```

---

## Task 5: Final verification + runtime acceptance

The mux is automated-gated; the decode path needs manual export acceptance (your choice). This task is the final sweep + the manual gate.

**Files:** none.

- [ ] **Step 1: Final automated sweep**

```bash
cd apps/desktop && npx tsc --noEmit -p tsconfig.json          # baseline error set, no NEW errors
npm --prefix apps/desktop test                                 # all green
npm --prefix apps/desktop run fixtures:render && npm --prefix apps/desktop run fixtures:check   # mux: pixel-exact
```

- [ ] **Step 2: Runtime acceptance — real exports in the app**

Launch the app (`npm --prefix apps/desktop run tauri:dev` or the project launcher). Export, and verify the output MP4 plays with correct content end-to-end:
- An **MP4** source (proxy path) — baseline.
- An **MKV** source — confirm export now succeeds (it broke on mp4box pre-Plan-C).
- A **B-frame original** routed through **DirectExport** (e.g. a standard camera/phone H.264 8-bit MP4 over the bypass/direct-export predicate) — confirm no dropped/duplicated/reordered frames around chunk boundaries (the decode-range B-frame boundary, design risk #4).
- **Heap** stays bounded across a long export (evict-after-use invariant) — watch the export Worker's memory.

- [ ] **Step 3: Record results**

Note pass/fail per check. A decode regression that can't be fixed in-session is a release blocker (export correctness), not a silent carry. With this, mp4box is fully gone and only Plan D (decide()/bypass widening + ADR 0002 accepted + docs) remains.

---

## Self-review

**Spec coverage:** decode rewrite `ExportSourceHandle` → `openMediaInput`/`packetSink`/`getDecoderConfig` (Task 3) ✓; `decodeRange` async seek-and-forward + delete `ensureBlocksLoaded`/sample-index API (Task 3 Step 3) ✓; B-frame boundary = decode through next key past `bUs` (Task 3 + design note 4) ✓; recovery keeps opened media, rebuilds decoder, resets cursor (Task 3 Step 2 `rebuildDecoder`) ✓; `ExportFrameStore`/pool/worker unchanged (untouched) ✓; mux keep-`VideoEncoder` + `Output`/`EncodedVideoPacketSource`/`BufferTarget`/`Mp4OutputFormat` (Task 2) ✓; async-`add` promise chain + `muxError` rethrow (Task 2) ✓; codec mapping (Task 1) ✓; drop mp4box + delete `Demuxer.ts` + grep-verify (Task 4) ✓; mux via fixture-comparison + decode manual (Tasks 2/5) ✓; export-fails-loud error handling (Task 3 decodeRange / Task 2 finalize) ✓; audio untouched ✓; non-goals (preview/Plan D) respected ✓.

**Placeholder scan:** none. The Task 1 Step 1 / pinned-API "if it differs, update" and Task 4 "if a consumer was missed" are bounded empirical checks with the exact remedy, not placeholders. The B-frame boundary is fully specified in code (Task 3 Step 3), not deferred.

**Type consistency:** `webCodecsToMediabunnyVideoCodec(string): VideoCodec` (Task 1) consumed in Task 2's `new EncodedVideoPacketSource(...)`. `EncoderInit` unchanged (worker compatibility). `ExportSourceHandle.ensureReady(): Promise<void>` satisfies `DecoderHandle.ensureReady(): Promise<unknown>` (Plan B). `cursor: EncodedPacket | null` + `lastDispatchedPtsUs` used consistently in `decodeRange`/`rebuildDecoder`/`dispose`. `opened: OpenedMedia` + `config: VideoDecoderConfig` + `buildConfig()`/`buildDecoder()` names consistent. `EncodedPacket.fromEncodedChunk` (mux) and `EncodedPacket` (decode) are the same mediabunny type.
