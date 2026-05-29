# mediabunny Migration — Plan B: preview decode path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the preview decode path (`SourceDecoderPool` → `SourceMedia` / `SourceHandle`) to drive WebCodecs from mediabunny's `EncodedPacketSink` (`getKeyPacket` / `getNextPacket`) instead of the mp4box `Demuxer`'s indexed sample table — fixing MKV/WebM preview at the root — while preserving ADR 0003 (no per-GOP reset) and ADR 0004 (ImageBitmap snapshot ring) verbatim.

**Architecture:** An injectable, single-flight **`PacketPump`** owns the async packet→decoder loop with a generation-free, `_disposed`-guarded control flow (the only thing that interleaves across an `await` is dispose). `SourceMedia` opens the proxy through `openMediaInput` (Plan A) and exposes the decoder config + `EncodedPacketSink`. `SourceHandle` wires a real `VideoDecoder` (with the **verbatim ADR-0004 output callback**) plus its `FrameRing` into a `PacketPump`. The reset decision is a pure, **synchronous** function (`decideReset`) keyed on microsecond PTS. Export (`ExportDecoderPool`) and mux stay on mp4box until Plan C — this plan only rewrites the preview pool and leaves the shared interfaces compatible.

**Tech Stack:** TypeScript, Vitest (node), mediabunny, WebCodecs.

**Spec:** `docs/superpowers/specs/2026-05-30-mediabunny-plan-b-preview-decode-design.md`. Depends on Plan A (`openMediaInput` / `AssetRangeSource`), committed on `feat/mediabunny-migration`.

---

## Design notes (read before starting)

These are decisions made during planning that **deviate from or sharpen the spec**. A fresh engineer diffing the plan against the spec will otherwise flag them as errors.

1. **Reset decision is synchronous and key-packet-free** (spec puts `await getKeyPacket` *in* the decision). We moved the key fetch from the *decision* to the *action*. The decision needs only PTS the pump already holds:
   - **backward beyond ring:** `targetUs < ringFirstPtsUs` — sync.
   - **far-forward seek:** `targetUs - lastDecodedPtsUs > FORWARD_SEEK_RESET_US` — sync. (Spec keyed this on `keyPtsUs`; `targetUs` is within ~1 GOP of its key, and far-forward reset is an *optimization* — decoding deltas forward is always correct — so a borderline misfire costs at most one extra reset, never correctness.)

   This makes the decision callable cheaply at the top of the fill loop (instant seek-during-fill detection) and means we **never fetch a key packet except when actually resetting** — neutralizing the spec's `getDecoderConfig`/scrub-latency concern about per-tick key reads.

   **Load-bearing invariant — preview decodes a ≤1s-GOP proxy.** After a far-forward reset seeks to the nearest key ≤ target, the fill loop re-evaluates `decideReset`. It must NOT re-fire, or the seek floods one reset per tick. It doesn't, *because* `target − keyPts < proxy GOP ≤ 1s ≤ FORWARD_SEEK_RESET_US` — so post-seek the far-forward arm is false and the pump forward-fills the GOP to the target. This holds today: preview only ever decodes the 1080p H.264 **1s-GOP proxy** (scope boundary 5; see `proxy.rs`). ⚠️ If preview is ever pointed at a source with GOP > 1s (e.g. a direct-path original), far-forward could re-fire per tick — at that point gate it on a "sought target" marker (record the target on reset-seek; suppress the far-forward arm until forward-fill catches up). Out of scope for Plan B; documented so a future GOP/source change doesn't reintroduce the ADR-0003 stall.

2. **Single async driver + generation guard** (spec implies the reset decision lives in `requestFrameAt`). The entire reset+fill lives inside one single-flight `runPump()`; `requestFrameAt` is sync (set anchor + target + kick). This collapses the spec's "dominant risk" (async concurrency) to one loop. But **two things still interleave across an `await`**: `dispose()` and — critically — the **WebCodecs error callback** (a queued event-loop task that runs `nullForRebuild → invalidateCursor` during software-downgrade / inactivity-rebuild). Both bump a `generation` counter that every await captures-and-rechecks; without it, an in-flight `getNextPacket` continuation resurrects `cursor` to a delta after a rebuild nulled it, feeding the fresh decoder a delta → decode error → recovery never completes (the legacy sync pump was immune; the async rewrite isn't). This is the spec's named race guard, kept verbatim in intent. The single-loop shape still makes the pump **unit-testable in node with fakes** (the highest-leverage change vs. the spec, which relegated the whole pump to manual testing) — including the rebuild race, since `invalidateCursor` is directly callable in a test.

3. **`decideReset` signature drops `keyPtsUs`, `queueEmpty`, `flushedThisRun`** (spec lists all of them). The two PTS conditions subsume `queueEmpty`; cold start is the pump's `cursor === null` branch; EOS is structural (`getNextPacket` returns `null` → one gated `flush()`), not a reset trigger.

4. **`DecoderHandle.ensureReady(): Promise<unknown>`** (was `Promise<VideoTrackMeta>`). The Compositor ignores the return value (`void source.ensureReady().catch(...)`); export consumes its meta only *internally*. Relaxing to `unknown` lets preview return `Promise<void>` and export keep `Promise<VideoTrackMeta>` — both assignable, **zero export edits**, respecting the Plan B/C boundary.

5. **Scope boundary:** preview still decodes the **`proxyAssetUrl`** (a 1080p H.264 MP4 proxy). Plan B swaps the *chunk source* (mp4box sample table → mediabunny `packetSink`) over the same opened media; it does **not** switch preview to MKV originals (that's the direct-path / Plan D). B-frame ordering stays a non-issue (proxy is `-bf 0`).

**Pinned mediabunny API** (from Plan A's header; **re-verify in Task 1** against the installed `.d.ts`):
- `new EncodedPacketSink(videoTrack)`; `await sink.getKeyPacket(tsSeconds): Promise<EncodedPacket | null>`; `await sink.getNextPacket(packet): Promise<EncodedPacket | null>` (returns `null` at end-of-stream, decode order).
- `EncodedPacket`: `.timestamp: number` (**seconds**), `.duration: number`, `.type: 'key' | 'delta'`, `.toEncodedVideoChunk(): EncodedVideoChunk`.
- `await videoTrack.getDecoderConfig(): Promise<VideoDecoderConfig | null>` — full config incl. `codec`, `description`, `codedWidth`, `codedHeight`, `colorSpace`.
- `openMediaInput(assetUrl): Promise<OpenedMedia>` where `OpenedMedia = { videoTrack: InputVideoTrack, packetSink: EncodedPacketSink, dispose(): void }` (Plan A, `mediaInput.ts`).

---

## Task 1: Install mediabunny, pin the Plan B API, confirm the Plan A baseline is green

mediabunny is in `apps/desktop/package.json` (`^1.45.4`) but **not present in `node_modules`** in a fresh checkout — Plan A's tests can't run until it is installed. This task establishes the regression baseline Plan B builds on. **No new code; verification + pinning only.**

**Files:** none created. Reads `apps/desktop/node_modules/mediabunny/dist/*.d.ts`.

- [ ] **Step 1: Install and confirm resolution**

Run: `npm --prefix apps/desktop install`
Then: `npm --prefix apps/desktop ls mediabunny`
Expected: a single `mediabunny@1.45.x` line, no `UNMET`/`invalid`.

- [ ] **Step 2: Pin the Plan B API surface against the bundled `.d.ts`**

Open the mediabunny type declarations (find with `npm --prefix apps/desktop exec -- node -p "require.resolve('mediabunny')"`, then the sibling `.d.ts`). Confirm — **do not guess**, these three drive Plan B's control flow:

1. `EncodedPacketSink.getNextPacket` at end-of-stream **returns `null`** (vs. throwing). Plan B's pump treats `null` as EOS; if it throws, the fill loop needs a try/catch instead.
2. `getNextPacket` yields packets in **decode order** (correct for feeding `VideoDecoder`; the `-bf 0` proxy makes this moot regardless, but confirm).
3. `getDecoderConfig()` returns a `VideoDecoderConfig` whose `description` is populated for H.264/HEVC (the field `VideoDecoder.configure` needs).

If any differs from the "Pinned mediabunny API" block above, update that block and the affected step before continuing.

- [ ] **Step 3: Run the Plan A baseline**

Run: `npm --prefix apps/desktop test -- src/render/decoder`
Expected: `rangeFetchMock`, `AssetRangeSource`, `decoderFallback`, `FrameRing`, and **`mediaInput` (MP4 + MKV parity + error case)** all green. This is the foundation Plan B sits on; if `mediaInput` is red, stop and fix Plan A before proceeding.

- [ ] **Step 4: Commit only if the lockfile moved**

If `npm install` changed `apps/desktop/package-lock.json`:
```bash
git add apps/desktop/package-lock.json
git commit -m "chore(deps): sync mediabunny lockfile for Plan B"
```
Otherwise no commit — this task is environment setup.

---

## Task 2: `decideReset` — the pure, synchronous ADR-0003 reset decision

**Files:**
- Create: `apps/desktop/src/render/decoder/PacketPump.ts` (this task adds the constants + `decideReset`; Task 3 adds the `PacketPump` class to the same file)
- Test: `apps/desktop/src/render/decoder/PacketPump.test.ts`

- [ ] **Step 1: Write the failing truth-table test**

Create `apps/desktop/src/render/decoder/PacketPump.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decideReset } from "./PacketPump";

// ADR 0003, re-keyed to microseconds. The decision is purely a function
// of the playhead target, the pump's decoded frontier, and the ring's
// oldest cached PTS. All times are µs.
describe("decideReset", () => {
  it("continuous forward play: no reset (frontier ahead of playhead)", () => {
    // playhead 500ms, decoded frontier 900ms, ring from 0.
    expect(
      decideReset({ targetUs: 500_000, lastDecodedPtsUs: 900_000, ringFirstPtsUs: 0 }),
    ).toBe(false);
  });

  it("forward GOP-crossing: no reset (the new GOP flows in-stream)", () => {
    // playhead 1.1s just past a 1s-GOP boundary; frontier 1.4s; ring from 600ms.
    expect(
      decideReset({ targetUs: 1_100_000, lastDecodedPtsUs: 1_400_000, ringFirstPtsUs: 600_000 }),
    ).toBe(false);
  });

  it("far-forward seek: reset (target > one lookahead window past frontier)", () => {
    // jump to 5s while the frontier is at 1s → 4s gap > 1s window.
    expect(
      decideReset({ targetUs: 5_000_000, lastDecodedPtsUs: 1_000_000, ringFirstPtsUs: 500_000 }),
    ).toBe(true);
  });

  it("backward beyond ring: reset (target older than oldest cached frame)", () => {
    // seek back to 100ms; lookbehind only still holds from 600ms.
    expect(
      decideReset({ targetUs: 100_000, lastDecodedPtsUs: 1_500_000, ringFirstPtsUs: 600_000 }),
    ).toBe(true);
  });

  it("paused lookahead-fill: no reset (the regression the comments warn about)", () => {
    // playhead HELD at 500ms; the pump advanced the frontier to 1.4s
    // filling lookahead; ring from 0. target - frontier is NEGATIVE.
    expect(
      decideReset({ targetUs: 500_000, lastDecodedPtsUs: 1_400_000, ringFirstPtsUs: 0 }),
    ).toBe(false);
  });

  it("backward check is skipped when the ring is empty", () => {
    // ringFirstPtsUs null → only the far-forward arm can fire.
    expect(
      decideReset({ targetUs: 100_000, lastDecodedPtsUs: 200_000, ringFirstPtsUs: null }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `cd apps/desktop && npx vitest run src/render/decoder/PacketPump.test.ts`
Expected: FAIL — cannot find `./PacketPump`.

- [ ] **Step 3: Implement the constants + `decideReset`**

Create `apps/desktop/src/render/decoder/PacketPump.ts`:

```ts
// The async packet pump for preview decode. Replaces the mp4box
// SourceHandle's synchronous, sample-index-based pump with a
// single-flight async loop driven by mediabunny's EncodedPacketSink
// (getKeyPacket / getNextPacket). See:
//   docs/superpowers/specs/2026-05-30-mediabunny-plan-b-preview-decode-design.md
//
// Control-flow invariants (the spec's "dominant risk"):
//   - SINGLE-FLIGHT: at most one runPump() loop is live at a time
//     (the `pumping` flag). Re-entrant requestFrameAt sets `wakeRequested`
//     instead of starting a second loop.
//   - TWO things interleave across an `await`: (1) dispose(), and (2) the
//     WebCodecs error callback, which fires as a queued event-loop task
//     and runs `SourceHandle.nullForRebuild → pump.invalidateCursor()`
//     (software-downgrade / inactivity-rebuild). Both bump a `generation`
//     counter; every await captures the generation before it and bails
//     after it if the generation moved (or `_disposed`). This is the
//     spec's named race guard — without it, an in-flight getNextPacket
//     continuation resurrects `cursor` to a delta packet after a rebuild
//     nulled it, feeding the fresh decoder a delta → decode error →
//     recovery never completes. (The legacy mp4box pump was immune only
//     because it was synchronous; the async rewrite reintroduces the
//     hazard, hence the guard.)
//   - The reset DECISION (decideReset) is synchronous and key-packet-free
//     (see the design note in the plan). Only the reset ACTION fetches a
//     key packet.

/// Forward-seek threshold (µs). A target more than one lookahead window
/// (≈1 s, matching FrameRing's DEFAULT_LOOKAHEAD_US) past the pump's
/// decoded frontier triggers a reset+seek instead of a forward slog
/// through the intervening delta packets. Replaces the legacy 60-sample
/// `FORWARD_SEEK_RESET_THRESHOLD`. See ADR 0003.
export const FORWARD_SEEK_RESET_US = 1_000_000;

/// Decoder-queue backpressure cap. `VideoDecoder.decode()` queues
/// internally; the OUTPUT callback fires async, so the ring stays empty
/// within a single pump burst. We cap on the decoder's own queue depth.
/// 24 matches the legacy pump (sized at the typical soft limit; keeps the
/// queue fed across scrub pauses where the pump runs only ~every 50ms).
export const MAX_QUEUE = 24;

export interface ResetDecisionInput {
  /// Playhead/scrub target in µs (the latest `requestFrameAt` argument).
  targetUs: number;
  /// PTS in µs of the last packet dispatched to the decoder (the pump
  /// frontier). `Number.NEGATIVE_INFINITY` before anything is decoded —
  /// but `decideReset` is only consulted once `cursor !== null`, so it
  /// never actually sees the sentinel (the pump short-circuits cold
  /// start via `cursor === null`).
  lastDecodedPtsUs: number;
  /// PTS in µs of the ring's earliest cached frame, or null if empty.
  ringFirstPtsUs: number | null;
}

/// Pure ADR-0003 reset decision, re-keyed from sample indices to µs.
/// Returns true only when the decoder cannot reach `targetUs` by
/// continuing to pump forward and must reset + seek to a key packet:
///
///   - backward beyond the ring: the target is older than the earliest
///     frame we still cache (lookbehind evicted it, or a backward seek
///     crossed a GOP). The pump only moves forward; in-flight packets
///     can't deliver it. One signal covers both within-GOP-beyond-
///     lookbehind AND backward-GOP-crossing — both manifest as "target's
///     PTS is older than what we still cache".
///   - far-forward seek: the target is more than one lookahead window
///     past the decoded frontier. The pump COULD catch up (delta packets
///     self-refresh forward), but slogging burns seconds; jump instead.
///
/// Everything else returns false — crucially BOTH continuous forward play
/// AND paused lookahead-fill (where the frontier advances *ahead* of a
/// held playhead, so `targetUs - lastDecodedPtsUs` is negative). Forward
/// GOP-crossings flow the next key packet in-stream without a reset
/// (ADR 0003 — an unconditional per-GOP reset reintroduces the playback
/// stall the ADR exists to prevent).
export function decideReset(s: ResetDecisionInput): boolean {
  if (s.ringFirstPtsUs !== null && s.targetUs < s.ringFirstPtsUs) return true;
  if (s.targetUs - s.lastDecodedPtsUs > FORWARD_SEEK_RESET_US) return true;
  return false;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd apps/desktop && npx vitest run src/render/decoder/PacketPump.test.ts`
Expected: 6 passed (`decideReset` describe block).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/decoder/PacketPump.ts apps/desktop/src/render/decoder/PacketPump.test.ts
git commit -m "feat(decoder): decideReset — pure µs-keyed ADR 0003 reset decision"
```

---

## Task 3: `PacketPump` — the single-flight async packet→decoder loop

Add the pump class + its narrow dependency interfaces to `PacketPump.ts`, and the concurrency tests to `PacketPump.test.ts`. The pump is injected with fakeable deps so the spec's dominant risk (async concurrency) is covered by **automated** tests, not just manual runtime acceptance.

**Files:**
- Modify: `apps/desktop/src/render/decoder/PacketPump.ts` (append the interfaces + `PacketPump`)
- Modify: `apps/desktop/src/render/decoder/PacketPump.test.ts` (append a `PacketPump` describe block)

- [ ] **Step 1: Write the failing concurrency tests**

Append to `apps/desktop/src/render/decoder/PacketPump.test.ts`:

```ts
import {
  PacketPump,
  type PumpDecoder,
  type PumpPacket,
  type PumpPacketSink,
  type PumpRing,
} from "./PacketPump";

// --- Test harness: fully synchronous fakes with manual await control ---

/// Drains the microtask queue (a real-timer macrotask flushes all pending
/// microtasks). One `await tick()` advances the pump past exactly one
/// `await` hop, since each hop resolves via microtasks.
const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

function makePacket(tsSeconds: number): PumpPacket {
  return {
    timestamp: tsSeconds,
    // The pump only passes this through to the (fake) decoder; the chunk
    // is never inspected, so a tagged stub stands in for EncodedVideoChunk.
    toEncodedVideoChunk: () => ({ _ts: tsSeconds } as unknown as EncodedVideoChunk),
  };
}

function makeFakeDecoder(): PumpDecoder & { decoded: PumpPacket[]; resets: number; configures: number } {
  let queue = 0;
  return {
    decoded: [] as PumpPacket[],
    resets: 0,
    configures: 0,
    state: "configured",
    decode(chunk: EncodedVideoChunk) {
      // Record the original packet via its tag for assertions.
      this.decoded.push(makePacket((chunk as unknown as { _ts: number })._ts));
      queue += 1;
    },
    reset() {
      this.resets += 1;
      queue = 0;
    },
    configure() {
      this.configures += 1;
    },
    flush() {
      queue = 0;
      return Promise.resolve();
    },
    get decodeQueueSize() {
      return queue;
    },
  };
}

/// A packet sink whose `getNextPacket` HANGS until the test releases it,
/// giving deterministic control over each await hop. `getKeyPacket`
/// resolves immediately to the single key at t=0.
class GatedSink implements PumpPacketSink {
  getKeyCalls: number[] = [];
  private pending: Array<(p: PumpPacket | null) => void> = [];
  private key = makePacket(0);

  async getKeyPacket(tsSeconds: number): Promise<PumpPacket | null> {
    this.getKeyCalls.push(tsSeconds);
    return this.key;
  }

  getNextPacket(_pkt: PumpPacket): Promise<PumpPacket | null> {
    return new Promise<PumpPacket | null>((resolve) => {
      this.pending.push(resolve);
    });
  }

  /// Number of getNextPacket calls currently awaiting resolution.
  inFlight(): number {
    return this.pending.length;
  }

  /// Resolve the oldest in-flight getNextPacket with the given packet
  /// (or null for end-of-stream).
  release(pkt: PumpPacket | null): void {
    const r = this.pending.shift();
    if (r) r(pkt);
  }
}

class FakeRing implements PumpRing {
  anchorUs = 0;
  full = false;
  flushes = 0;
  first: number | null = null;
  setAnchor(tUs: number): void {
    this.anchorUs = tUs;
  }
  isLookaheadFull(): boolean {
    return this.full;
  }
  flush(): void {
    this.flushes += 1;
    this.first = null;
  }
  firstPtsUs(): number | null {
    return this.first;
  }
}

describe("PacketPump", () => {
  it("is single-flight: re-entrant requestFrameAt never starts a 2nd loop", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0); // cold start: getKeyPacket → decode key → await getNextPacket
    await tick();
    expect(sink.inFlight()).toBe(1);

    // Two more ticks while the single pump is parked on getNextPacket.
    pump.requestFrameAt(33_000);
    pump.requestFrameAt(66_000);
    await tick();
    expect(sink.inFlight()).toBe(1); // still ONE — proves single-flight
  });

  it("cold start seeks to the key and decodes it without a reset", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick();
    expect(dec.decoded.length).toBe(1); // the key packet
    expect(dec.resets).toBe(0); // cold start ≠ reset
    expect(ring.flushes).toBe(0);
    expect(sink.getKeyCalls).toEqual([0]);
  });

  it("far-forward seek resets exactly once and re-seeks the key", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick(); // key decoded, frontier 0, awaiting getNextPacket
    sink.release(makePacket(0.5));
    await tick(); // delta @0.5s decoded, frontier 500ms, awaiting next
    expect(dec.resets).toBe(0);

    pump.requestFrameAt(5_000_000); // far-forward (5s)
    sink.release(makePacket(0.6)); // in-flight resolves → loop top sees the seek
    await tick();

    expect(dec.resets).toBe(1);
    expect(ring.flushes).toBe(1);
    expect(sink.getKeyCalls).toContain(5); // sought to 5s
  });

  it("backward seek beyond the ring resets", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    ring.first = 600_000; // ring only holds from 600ms
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(1_000_000); // cold start near 1s
    await tick();
    expect(dec.resets).toBe(0);

    pump.requestFrameAt(100_000); // backward to 100ms < ring.first(600ms)
    sink.release(makePacket(1.1)); // resolve in-flight; loop top sees the seek
    await tick();
    expect(dec.resets).toBe(1);
  });

  it("paused lookahead-fill never resets despite frontier >> playhead", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(500_000); // playhead held at 500ms
    await tick();
    sink.release(makePacket(0.7));
    await tick();
    sink.release(makePacket(1.0));
    await tick();
    sink.release(makePacket(1.4)); // frontier now 1.4s, far ahead of 500ms
    await tick();

    pump.requestFrameAt(500_000); // still 500ms (paused)
    sink.release(makePacket(1.5));
    await tick();

    expect(dec.resets).toBe(0);
    expect(ring.flushes).toBe(0);
  });

  it("dispose during an await drops further decodes", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick(); // key decoded, awaiting getNextPacket
    const before = dec.decoded.length;

    pump.dispose();
    sink.release(makePacket(0.1)); // resolve the in-flight await AFTER dispose
    await tick();

    expect(dec.decoded.length).toBe(before); // post-await `_disposed` guard bailed
  });

  it("rebuild (invalidateCursor) during an await does not resurrect the cursor", async () => {
    // The WebCodecs error callback fires mid-await and calls
    // invalidateCursor (decoder rebuild). The in-flight getNextPacket
    // continuation MUST NOT write the resolved packet back into `cursor`,
    // or the next pass feeds a delta into the fresh decoder instead of
    // cold-starting at a key — the bug that breaks software-downgrade
    // recovery. The generation guard makes the continuation bail.
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick(); // cold start: getKeyPacket(0), key decoded, awaiting getNextPacket
    sink.release(makePacket(0.1)); // cursor advances; re-park on getNextPacket
    await tick();
    expect(sink.getKeyCalls.length).toBe(1);

    pump.invalidateCursor(); // simulate the error-callback rebuild mid-await
    sink.release(makePacket(0.2)); // in-flight getNextPacket resolves AFTER invalidate
    await tick();

    // cursor must be null → the next request cold-starts (re-seeks a key).
    pump.requestFrameAt(0);
    await tick();
    expect(sink.getKeyCalls.length).toBe(2); // re-sought a key; cursor was NOT resurrected
  });
});
```

- [ ] **Step 2: Run — expect FAIL (`PacketPump` not exported)**

Run: `cd apps/desktop && npx vitest run src/render/decoder/PacketPump.test.ts`
Expected: FAIL — `PacketPump` / the `Pump*` types are not exported from `./PacketPump`.

- [ ] **Step 3: Implement the dep interfaces + `PacketPump`**

Append to `apps/desktop/src/render/decoder/PacketPump.ts`:

```ts
/// The decoder surface the pump drives. `SourceHandle` implements this as
/// a thin adapter over its live `VideoDecoder` so that error-recovery
/// rebuilds (which replace the decoder object) are transparent to the
/// pump. `configure()` is parameterless: the adapter builds the config
/// (codec + downgraded flag) — the pump stays ignorant of config details.
export interface PumpDecoder {
  decode(chunk: EncodedVideoChunk): void;
  reset(): void;
  configure(): void;
  flush(): Promise<void>;
  readonly decodeQueueSize: number;
  readonly state: CodecState;
}

/// Minimal view of a mediabunny `EncodedPacket`. `EncodedPacket` satisfies
/// this structurally (it has `.timestamp` in seconds + `.toEncodedVideoChunk()`).
export interface PumpPacket {
  /// Presentation timestamp in **seconds** (mediabunny's unit).
  readonly timestamp: number;
  toEncodedVideoChunk(): EncodedVideoChunk;
}

/// Minimal view of a mediabunny `EncodedPacketSink`. `EncodedPacketSink`
/// satisfies this structurally (its extra optional `options` params are
/// compatible under TS method bivariance). If a strict-mode assignability
/// error surfaces at the wiring site in Task 5, wrap the sink in a thin
/// adapter there.
export interface PumpPacketSink {
  getKeyPacket(tsSeconds: number): Promise<PumpPacket | null>;
  getNextPacket(packet: PumpPacket): Promise<PumpPacket | null>;
}

/// Minimal view of `FrameRing` the pump needs. `FrameRing` satisfies it.
export interface PumpRing {
  setAnchor(tUs: number): void;
  isLookaheadFull(): boolean;
  flush(): void;
  firstPtsUs(): number | null;
}

export interface PumpDeps {
  decoder: PumpDecoder;
  packetSink: PumpPacketSink;
  ring: PumpRing;
  /// Optional diagnostic sink (EOS-flush failures, etc.).
  log?: (msg: string) => void;
}

export class PacketPump {
  private readonly deps: PumpDeps;
  /// The last packet dispatched to the decoder. `null` means "not
  /// positioned" — the next pump pass cold-starts by seeking to a key.
  private cursor: PumpPacket | null = null;
  /// Latest requested playhead/scrub target (µs). Updated synchronously
  /// by every requestFrameAt; read at the top of each pump pass + each
  /// fill iteration so a mid-flight seek is picked up immediately.
  private targetUs = 0;
  /// PTS (µs) of `cursor`. Sentinel until cold start positions the cursor;
  /// never read by `decideReset` while the sentinel holds (the pump
  /// short-circuits via `cursor === null`).
  private lastDecodedPtsUs = Number.NEGATIVE_INFINITY;
  /// Single-flight guard: at most one runPump() loop is live.
  private pumping = false;
  /// Set by requestFrameAt while a loop is live; the loop re-runs its
  /// body for the new target instead of a second loop starting.
  private wakeRequested = false;
  /// True once the current decode run has issued its end-of-stream flush.
  /// Cleared on any reset / cursor invalidation. Prevents re-flushing the
  /// DPB every pass once the pump has settled at EOS.
  private flushedThisRun = false;
  /// Bumped by `invalidateCursor` (decoder rebuild) and `dispose`. Each
  /// await captures it beforehand and bails after if it moved — the race
  /// guard against the WebCodecs error callback firing mid-await (see the
  /// file-top comment). NOT bumped by in-loop resets (those are
  /// serialized inside runPump; nothing else interleaves with them).
  private generation = 0;
  private _disposed = false;

  constructor(deps: PumpDeps) {
    this.deps = deps;
  }

  /// Update the anchor + target and kick the pump. Synchronous: the
  /// Compositor calls this every tick and ignores the (void) result.
  requestFrameAt(tUs: number): void {
    if (this._disposed) return;
    this.deps.ring.setAnchor(tUs);
    this.targetUs = tUs;
    void this.runPump();
  }

  /// Reposition: drop the cursor so the next pass cold-starts from a key.
  /// `SourceHandle` calls this after rebuilding the `VideoDecoder`
  /// (software-downgrade / inactivity-rebuild) — the fresh decoder must
  /// start at a key packet, not mid-GOP.
  invalidateCursor(): void {
    this.generation += 1; // bail any await that's in flight against the old decoder
    this.cursor = null;
    this.lastDecodedPtsUs = Number.NEGATIVE_INFINITY;
    this.flushedThisRun = false;
  }

  dispose(): void {
    this._disposed = true;
    this.generation += 1;
    this.wakeRequested = false;
  }

  private async runPump(): Promise<void> {
    if (this.pumping) {
      this.wakeRequested = true;
      return;
    }
    if (this._disposed) return;
    this.pumping = true;
    try {
      do {
        this.wakeRequested = false;
        const target = this.targetUs;

        // --- Seek / cold-start: position the decoder at a key packet ---
        const needsSeek =
          this.cursor === null ||
          decideReset({
            targetUs: target,
            lastDecodedPtsUs: this.lastDecodedPtsUs,
            ringFirstPtsUs: this.deps.ring.firstPtsUs(),
          });
        if (needsSeek) {
          const isReset = this.cursor !== null; // cold start is not a reset
          const myGen = this.generation;
          const key = await this.deps.packetSink.getKeyPacket(target / 1e6);
          // A rebuild (invalidateCursor) or dispose during the await bumps
          // generation — bail rather than seed a stale decoder.
          if (this.generation !== myGen || this._disposed) return;
          if (!key) break; // no key packet (empty/bad source) — give up this pass
          if (isReset && this.deps.decoder.state === "configured") {
            this.deps.decoder.reset();
            this.deps.decoder.configure();
            this.deps.ring.flush();
          }
          if (this.deps.decoder.state === "configured") {
            this.deps.decoder.decode(key.toEncodedVideoChunk());
            this.cursor = key;
            this.lastDecodedPtsUs = Math.round(key.timestamp * 1e6);
            this.flushedThisRun = false;
          }
        }

        // --- Fill forward to the lookahead window / queue cap ---
        while (
          this.deps.decoder.state === "configured" &&
          this.deps.decoder.decodeQueueSize < MAX_QUEUE &&
          !this.deps.ring.isLookaheadFull()
        ) {
          // A seek that arrived mid-fill is caught here synchronously
          // (no key fetch) — break and re-seek on the next pass.
          if (
            decideReset({
              targetUs: this.targetUs,
              lastDecodedPtsUs: this.lastDecodedPtsUs,
              ringFirstPtsUs: this.deps.ring.firstPtsUs(),
            })
          ) {
            break;
          }
          const cur = this.cursor;
          if (cur === null) break;
          const myGen = this.generation;
          const next = await this.deps.packetSink.getNextPacket(cur);
          // Same race guard: a rebuild/dispose during the await must not
          // resurrect `cursor` to a delta packet on the continuation.
          if (this.generation !== myGen || this._disposed) return;
          if (!next) {
            this.eosFlushOnce();
            break;
          }
          this.deps.decoder.decode(next.toEncodedVideoChunk());
          this.cursor = next;
          this.lastDecodedPtsUs = Math.round(next.timestamp * 1e6);
        }
      } while (this.wakeRequested && !this._disposed);
    } finally {
      this.pumping = false;
    }
    // Late-kick guard: a requestFrameAt that set `wakeRequested` between
    // the do/while check and `pumping = false` would otherwise be lost.
    if (this.wakeRequested && !this._disposed) void this.runPump();
  }

  /// Drain the DPB once at end-of-stream. H.264/HEVC decoders hold
  /// trailing reorder frames waiting on a follow-up GOP that never comes
  /// at EOS; without this the ring stays short its final frame. Gated by
  /// `flushedThisRun` so we don't re-flush every pass once settled.
  private eosFlushOnce(): void {
    if (this.flushedThisRun) return;
    if (this.deps.decoder.state !== "configured") return;
    this.flushedThisRun = true;
    void this.deps.decoder.flush().then(undefined, (err: unknown) => {
      this.deps.log?.(`end-of-stream flush failed: ${String(err)}`);
    });
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd apps/desktop && npx vitest run src/render/decoder/PacketPump.test.ts`
Expected: 13 passed (6 `decideReset` + 7 `PacketPump`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/decoder/PacketPump.ts apps/desktop/src/render/decoder/PacketPump.test.ts
git commit -m "feat(decoder): PacketPump — single-flight async packet→decoder loop + concurrency tests"
```

---

## Task 4: Rewrite `SourceDecoderPool.ts` onto mediabunny + `PacketPump`

Rewrite `SourceMedia` (mediabunny-backed) and `SourceHandle` (pump-driven) in place. The `SourceDecoderPool` class, its refcount/sweeper logic, and the `FrameStore`/`DecoderPool`/`DecodedFrame` types are decoder-agnostic and stay byte-for-byte except where noted. The **`DecoderHandle.ensureReady` return type relaxes to `Promise<unknown>`**. Not unit-testable (needs WebCodecs + mediabunny `Input`); verified by `tsc` + the unchanged suite + runtime acceptance (Task 5).

**Files:**
- Modify: `apps/desktop/src/render/decoder/SourceDecoderPool.ts`

- [ ] **Step 1: Swap the imports**

Replace the import block (currently lines ~25–28):

```ts
import { logEmit } from "../../ipc";
import { Demuxer, type VideoTrackMeta } from "./Demuxer";
import { FrameRing } from "./FrameRing";
import { handleDecodeError } from "./decoderFallback";
```

with:

```ts
import type { EncodedPacketSink } from "mediabunny";
import { logEmit } from "../../ipc";
import { FrameRing } from "./FrameRing";
import { handleDecodeError } from "./decoderFallback";
import { openMediaInput, type OpenedMedia } from "./mediaInput";
import { PacketPump, type PumpDeps } from "./PacketPump";
```

Also delete the now-dead `FORWARD_SEEK_RESET_THRESHOLD` constant (the sample-index threshold; replaced by `FORWARD_SEEK_RESET_US` in `PacketPump.ts`). Keep `IDLE_DISPOSE_MS`.

- [ ] **Step 2: Relax the `DecoderHandle.ensureReady` return type**

In the `DecoderHandle` interface, change:

```ts
  ensureReady(): Promise<VideoTrackMeta>;
```

to:

```ts
  /// Build the decode pipeline. The return value is unused by the
  /// Compositor (it `void`s the call). Preview returns `Promise<void>`;
  /// export still returns `Promise<VideoTrackMeta>` (consumed internally).
  /// Both are assignable to `Promise<unknown>`, so this stays compatible
  /// with `ExportSourceHandle` without touching the export pool. Plan C
  /// re-unifies the meta shapes.
  ensureReady(): Promise<unknown>;
```

(`VideoTrackMeta` is no longer imported here — export's `ExportDecoderPool.ts` keeps its own `import { ..., type VideoTrackMeta } from "./Demuxer"`.)

- [ ] **Step 3: Rewrite `SourceMedia` (mediabunny-backed)**

Replace the entire `SourceMedia` class with:

```ts
/// Shared per-source state: the opened mediabunny `Input` (proxy fetched
/// lazily over asset:// Range) + the once-per-source decoder config. Every
/// `SourceHandle` for the same mediaId points at the same `SourceMedia`,
/// so the proxy is opened + parsed exactly once regardless of how many
/// overlapping clips reference it. Lifetime is refcounted by the pool —
/// disposed when the last referencing handle goes away.
export class SourceMedia {
  readonly mediaId: string;
  private readonly proxyAssetUrl: string;
  private opened: OpenedMedia | null = null;
  private config: VideoDecoderConfig | null = null;
  /// Cached in-flight `ensureReady` promise so concurrent handles share
  /// one open + getDecoderConfig. Cleared on dispose so a re-acquire
  /// after dispose re-opens rather than re-awaiting a stale resolved
  /// promise (whose `Input` is gone).
  private readyP: Promise<VideoDecoderConfig> | null = null;
  private _disposed = false;

  get disposed(): boolean {
    return this._disposed;
  }

  /// The packet source for this media's primary video track. Throws if
  /// read before `ensureReady` has resolved.
  get packetSink(): EncodedPacketSink {
    if (!this.opened) {
      throw new Error(`SourceMedia ${this.mediaId}: packetSink before ready`);
    }
    return this.opened.packetSink;
  }

  constructor(mediaId: string, proxyAssetUrl: string) {
    this.mediaId = mediaId;
    this.proxyAssetUrl = proxyAssetUrl;
  }

  /// Open the proxy through mediabunny and resolve the WebCodecs decoder
  /// config from the primary video track. Idempotent across concurrent
  /// callers. Replaces the mp4box `Demuxer.open()` + manual avcC/hvcC
  /// serialization — `getDecoderConfig()` produces `description` directly.
  async ensureReady(): Promise<VideoDecoderConfig> {
    if (this.config) return this.config;
    if (this.readyP) return this.readyP;
    this.readyP = (async () => {
      const opened = await openMediaInput(this.proxyAssetUrl);
      const config = await opened.videoTrack.getDecoderConfig();
      if (!config) {
        opened.dispose();
        throw new Error(`SourceMedia ${this.mediaId}: no decoder config`);
      }
      this.opened = opened;
      this.config = config;
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] source ${this.mediaId} ready: codec=${config.codec} ` +
          `${config.codedWidth ?? "?"}x${config.codedHeight ?? "?"} ` +
          `desc=${config.description ? `${(config.description as { byteLength: number }).byteLength}B` : "none"}`,
      );
      return config;
    })();
    return this.readyP;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.opened?.dispose(); // disposes the Input + aborts in-flight Range reads
    this.opened = null;
    this.config = null;
    this.readyP = null;
  }
}
```

- [ ] **Step 4: Rewrite the `SourceHandle` fields + `ensureReady`**

Replace the `SourceHandle` field block + `mediaId` getter + the `demuxer` getter + `onFirstFrame` + `ensureReady` + `_doEnsureReady` (currently lines ~168–389) with the following. The **`output` and `error` callbacks are preserved VERBATIM from the current code (ADR 0004 + the decoder-identity race guard) — do not modify them**:

```ts
export class SourceHandle {
  readonly layerId: string;
  readonly media: SourceMedia;
  readonly ring: FrameRing;
  private decoder: VideoDecoder | null = null;
  /// The WebCodecs config from `SourceMedia.ensureReady`, cached so
  /// `buildConfig` can re-issue it on reset / software-downgrade rebuild.
  private config: VideoDecoderConfig | null = null;
  /// The async pump. Created once on first `ensureReady`; survives decoder
  /// rebuilds (its decoder adapter reads `this.decoder` live).
  private pump: PacketPump | null = null;
  /// In-flight `ensureReady` promise, cached so concurrent callers don't
  /// each build a fresh `VideoDecoder`. Cleared on dispose / rebuild.
  private readyP: Promise<void> | null = null;
  /// True once the decoder is built + configured for the current run.
  /// Cleared by `nullForRebuild` so the next `ensureReady` rebuilds.
  private ready = false;
  private lastUseMs = 0;
  private onFirstFrameCb: (() => void) | null = null;
  private firedFirstFrame = false;
  /// Total frames the decoder has emitted since the last rebuild. Drives
  /// the first-frame software-fallback heuristic.
  private outputFrameCount = 0;
  /// True once reconfigured with `prefer-software`. Prevents repeated
  /// downgrade attempts when the software path also errors.
  private downgraded = false;
  /// Diagnostic throughput counters (logged once per ~1s window).
  private outputsInWindow = 0;
  private windowStartMs = 0;
  private _disposed = false;

  get disposed(): boolean {
    return this._disposed;
  }

  /// MediaId mirrors `this.media.mediaId`; kept on the handle for the
  /// `DecoderHandle` interface + log lines.
  get mediaId(): string {
    return this.media.mediaId;
  }

  constructor(layerId: string, media: SourceMedia) {
    this.layerId = layerId;
    this.media = media;
    this.ring = new FrameRing();
  }

  /// Subscribe to "first frame decoded". Fires exactly once. If the first
  /// frame already landed, fires synchronously.
  onFirstFrame(cb: () => void): void {
    if (this.firedFirstFrame) {
      cb();
      return;
    }
    this.onFirstFrameCb = cb;
  }

  /// Build this handle's decoder + pump on top of the shared media's
  /// readiness. Idempotent across concurrent callers. The heavy open +
  /// parse lives on `SourceMedia`, so extra handles only pay per-handle
  /// `VideoDecoder` construction. Returns void (see the `DecoderHandle`
  /// interface note — the value is unused by the Compositor).
  async ensureReady(): Promise<void> {
    if (this.ready && this.decoder) return;
    if (this.readyP) return this.readyP;
    this.readyP = this._doEnsureReady();
    return this.readyP;
  }

  private async _doEnsureReady(): Promise<void> {
    this.config = await this.media.ensureReady();
    // Capture the decoder identity so stale error/output callbacks from a
    // decoder we've since replaced (inactivity-rebuild) bail before
    // re-firing recovery or polluting the live ring.
    let dec: VideoDecoder;
    dec = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (this.decoder !== dec) {
          frame.close();
          return;
        }
        // Snapshot pixels into an ImageBitmap so the source VideoFrame can
        // be closed immediately — this returns the hardware decoder's
        // buffer slot to its pool. Without this, the ring pinned 8 +
        // decoder reorder buffer ~5 = 13 buffers, hitting the GPU
        // decoder's pool ceiling (~13 on common desktop GPUs) and stalling
        // decode until eviction freed a slot. The browser optimizes
        // `createImageBitmap(VideoFrame)` to keep pixels on the GPU side;
        // we pay a per-frame conversion but stop holding the decoder's
        // buffers across many ticks. (ADR 0004.)
        const ptsUs = frame.timestamp;
        const durationUs = frame.duration ?? 0;
        createImageBitmap(frame).then(
          (bitmap) => {
            frame.close();
            // Re-check decoder identity after the async hop. A rebuild
            // between output() and createImageBitmap resolution could have
            // replaced `this.decoder`; pushing into the new generation's
            // ring would mix frames from a dead decoder into the live store.
            if (this.decoder !== dec) {
              bitmap.close();
              return;
            }
            this.outputFrameCount += 1;
            this.ring.push(bitmap, ptsUs, durationUs);
            if (!this.firedFirstFrame) {
              this.firedFirstFrame = true;
              // eslint-disable-next-line no-console
              console.log(
                `[weftcut/pixi] layer ${this.layerId} (source ${this.mediaId}) first frame decoded`,
              );
              this.onFirstFrameCb?.();
              this.onFirstFrameCb = null;
            }
            const nowMs = performance.now();
            if (this.windowStartMs === 0) this.windowStartMs = nowMs;
            this.outputsInWindow += 1;
            if (nowMs - this.windowStartMs >= 1000) {
              const ringLastUs = this.ring.lastPtsUs();
              const ringLastMs =
                ringLastUs !== null ? (ringLastUs / 1000).toFixed(0) : "—";
              // eslint-disable-next-line no-console
              console.log(
                `[weftcut/pixi] decoder throughput: ${this.outputsInWindow} frames in ` +
                  `${(nowMs - this.windowStartMs).toFixed(0)}ms ` +
                  `(${((this.outputsInWindow * 1000) / (nowMs - this.windowStartMs)).toFixed(1)} fps) ` +
                  `[total=${this.outputFrameCount} queue=${dec.decodeQueueSize} ` +
                  `ring=${this.ring.size()}@${ringLastMs}ms]`,
              );
              this.outputsInWindow = 0;
              this.windowStartMs = nowMs;
            }
          },
          (err: unknown) => {
            try {
              frame.close();
            } catch {
              // Already closed; ignore.
            }
            // eslint-disable-next-line no-console
            console.warn(
              `[weftcut/pixi] createImageBitmap failed for source ${this.mediaId} ` +
                `(pts=${ptsUs}us):`,
              err,
            );
          },
        );
      },
      error: (e: unknown) => {
        if (this.decoder !== dec) return;
        const err = e instanceof Error ? e : new Error(String(e));
        // eslint-disable-next-line no-console
        console.error(`[weftcut/pixi] decoder ${this.mediaId} error:`, err.message);
        const action = handleDecodeError({
          err,
          outputFrameCount: this.outputFrameCount,
          alreadyDowngraded: this.downgraded,
          mediaId: this.mediaId,
          log: (msg) => {
            void logEmit({
              level: "warn",
              category: { kind: "Other", name: "Render" },
              source: { kind: "System" },
              message: msg,
            });
          },
        });
        if (action.kind === "downgrade-to-software") {
          this.downgradeToSoftware();
        } else if (action.kind === "inactivity-rebuild") {
          this.rebuildAfterInactivity();
        }
      },
    });
    this.decoder = dec;
    this.decoder.configure(this.buildConfig());
    if (!this.pump) this.pump = new PacketPump(this.makePumpDeps());
    this.ready = true;
  }

  /// Adapter wiring the live `VideoDecoder` + `FrameRing` + media
  /// packetSink into the pump's narrow deps. Reads `this.decoder` live so
  /// a rebuild (new VideoDecoder) is transparent to the pump.
  private makePumpDeps(): PumpDeps {
    const handle = this;
    return {
      decoder: {
        decode: (chunk: EncodedVideoChunk) => handle.decoder?.decode(chunk),
        reset: () => handle.decoder?.reset(),
        configure: () => {
          if (handle.decoder) handle.decoder.configure(handle.buildConfig());
        },
        flush: () => handle.decoder?.flush() ?? Promise.resolve(),
        get decodeQueueSize() {
          return handle.decoder?.decodeQueueSize ?? 0;
        },
        get state(): CodecState {
          return handle.decoder?.state ?? "unconfigured";
        },
      },
      packetSink: handle.media.packetSink,
      ring: handle.ring,
      log: (msg: string) => {
        // eslint-disable-next-line no-console
        console.warn(`[weftcut/pixi] pump ${handle.mediaId}: ${msg}`);
      },
    };
  }

  /// Build the decoder config, honoring `downgraded`. Spreads the full
  /// mediabunny config (preserving colorSpace etc. the mp4box path lacked)
  /// and only overrides `hardwareAcceleration`.
  private buildConfig(): VideoDecoderConfig {
    if (!this.config) {
      throw new Error(`SourceHandle ${this.mediaId}: buildConfig before ready`);
    }
    return {
      ...this.config,
      hardwareAcceleration: this.downgraded ? "prefer-software" : "prefer-hardware",
    };
  }
```

- [ ] **Step 5: Rewrite the recovery + request + lifecycle methods**

Replace everything from the old `buildConfig` through the end of the class (the old `nullForRebuild`, `downgradeToSoftware`, `rebuildAfterInactivity`, `requestFrameAt`, `pumpLookahead`, `isIdle`, `decodeQueueSize`, `flush`, `dispose` — currently lines ~391–717) with:

```ts
  /// Tear down the dead decoder + clear readiness so the next
  /// `ensureReady` rebuilds a fresh `VideoDecoder`. WebCodecs moves the
  /// codec to "closed" BEFORE firing the error callback, so
  /// reset()/configure() on the errored decoder always throw — rebuilding
  /// is the only legitimate recovery. The pump survives (it reads
  /// `this.decoder` live), but its cursor must be invalidated so the fresh
  /// decoder restarts at a key packet, not mid-GOP. We don't reset
  /// `outputFrameCount`/`downgraded`: a source that needed software before
  /// still does, and the first-frame heuristic shouldn't re-arm.
  private nullForRebuild(): void {
    try {
      this.decoder?.close();
    } catch {
      // Decoder may already be closed.
    }
    this.decoder = null;
    this.readyP = null;
    this.ready = false;
    this.pump?.invalidateCursor();
  }

  /// Software-fallback: flip the flag, drop the dead decoder so the next
  /// `ensureReady` rebuilds with `prefer-software`. Can't reset+reconfigure
  /// the errored decoder — WebCodecs has already closed it.
  private downgradeToSoftware(): void {
    if (this.downgraded) return;
    this.downgraded = true;
    this.nullForRebuild();
  }

  /// Inactivity recovery: same teardown — Chrome reclaimed the codec slot;
  /// only a fresh `VideoDecoder` is usable.
  private rebuildAfterInactivity(): void {
    this.nullForRebuild();
  }

  /// Nudge the decoder's lookahead toward `tUs`. Builds the pipeline lazily
  /// on first call, then delegates to the single-flight `PacketPump`.
  async requestFrameAt(tUs: number): Promise<void> {
    if (!this.ready || !this.decoder) await this.ensureReady();
    if (this._disposed || !this.pump) return;
    this.lastUseMs = performance.now();
    this.pump.requestFrameAt(tUs);
  }

  /// `nowMs` from the pool's sweep tick. True if idle past the threshold.
  isIdle(nowMs: number): boolean {
    return this.lastUseMs > 0 && nowMs - this.lastUseMs > IDLE_DISPOSE_MS;
  }

  /// Live decoder queue depth — for the dev `PerfHUD`. 0 when no decoder.
  decodeQueueSize(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  /// Drop the decode pipeline + cached frames. Safe to re-init via
  /// `ensureReady()`.
  flush(): void {
    try {
      this.decoder?.reset();
    } catch {
      // Decoder may be closed.
    }
    this.pump?.invalidateCursor();
    this.ring.flush();
  }

  dispose(): void {
    this.pump?.dispose();
    this.pump = null;
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // Decoder may already be in a closed state; ignore.
      }
      this.decoder = null;
    }
    this.ring.dispose();
    // The opened media lives on the shared `SourceMedia`; the pool releases
    // it (refcounted) when the last handle on this mediaId goes away. We
    // intentionally don't touch `this.media` here.
    this.config = null;
    this.readyP = null;
    this.ready = false;
    this.onFirstFrameCb = null;
    this.outputFrameCount = 0;
    this.downgraded = false;
    this._disposed = true;
  }
}
```

The `MediaEntry` interface + `SourceDecoderPool` class below this point are unchanged (decoder-agnostic refcount + sweeper). Leave them as-is.

- [ ] **Step 6: Type-check the whole app**

Run: `npm --prefix apps/desktop run typecheck`
Expected: PASS. In particular, no errors in `SourceDecoderPool.ts`, `ExportDecoderPool.ts` (it still implements the now-`Promise<unknown>` `DecoderHandle` via its `Promise<VideoTrackMeta>` `ensureReady`), `Compositor.ts`, or `index.ts`.

If a `PumpPacketSink` assignability error surfaces (real `EncodedPacketSink` not assignable to the structural interface — TS method bivariance usually allows it, but a strict config may reject), fix it by wrapping the sink in `makePumpDeps`:
```ts
packetSink: {
  getKeyPacket: (ts: number) => handle.media.packetSink.getKeyPacket(ts),
  getNextPacket: (p) => handle.media.packetSink.getNextPacket(p as never),
},
```
Re-run typecheck.

- [ ] **Step 7: Run the full node suite (no regressions)**

Run: `npm --prefix apps/desktop test`
Expected: all green. No test imports `SourceDecoderPool`/`Compositor` directly, so this confirms the rewrite didn't break the shared decoder/ring/fallback modules or anything downstream of the type changes. `PacketPump` + Plan A tests included.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/render/decoder/SourceDecoderPool.ts
git commit -m "feat(decoder): preview pool on mediabunny packetSink via PacketPump (Plan B)"
```

---

## Task 5: Runtime acceptance + final verification

The pump's logic is unit-covered, but the live WebCodecs path (ImageBitmap snapshot, real `getDecoderConfig` for HEVC, scrub latency, the long-video heap invariant) is only provable in the app. This task is the manual gate + the final automated sweep.

**Files:** none. Runs the app.

- [ ] **Step 1: Final automated sweep**

```bash
npm --prefix apps/desktop run typecheck   # PASS
npm --prefix apps/desktop test            # all green (Plan A + PacketPump + suite)
```

- [ ] **Step 2: Runtime acceptance in `tauri:dev` — MP4 source**

Launch the app (`npm --prefix apps/desktop run tauri:dev` or the project's dev launcher). Import an **MP4** clip, then verify on the timeline:
- First frame paints (no permanent blank).
- Smooth continuous play across **≥2 GOP boundaries** with no per-GOP stall (ADR 0003). Watch the console — `decoder reset:` must NOT fire on every GOP boundary during forward play.
- Forward seek: near (within ~1s → catches up by forward decode) and far (>1s → one reset+seek, frame appears promptly).
- Backward seek: within lookbehind (no reset) and beyond it (one reset+seek).
- Two overlapping clips of the same source: each stabilizes on its own frame, no decoder thrash / reset flood.
- Scrub latency comparable to the pre-Plan-B mp4box path (no obvious per-frame lag). If it regresses, see the spec's mitigation (pre-buffer a small packet queue ahead of the decoder).

- [ ] **Step 3: Runtime acceptance — MKV source (the bug this migration fixes)**

Import an **MKV** clip whose codec lands on the direct path (H.264). Confirm preview **works** (it was broken on mp4box — "moov not found"). Re-run the play / seek / scrub checks from Step 2 on the MKV source.

- [ ] **Step 4: HEVC config + heap soak**

- On a real **HEVC** source (if available), confirm `getDecoderConfig()` produces a `description` WebCodecs accepts (first frame paints; no `configure` throw in the console). This is the spec's flagged `getDecoderConfig` risk.
- Open a **long** clip and watch **PerfHUD heap** during sustained play + seeks: residency stays flat in the low-hundreds-of-MB regardless of duration (the cross-phase invariant from Plan A, now exercised through the live pump). If it climbs, tune `AssetRangeSource`'s `maxCacheSize`.

- [ ] **Step 5: Record results**

Note pass/fail per check in the PR / commit description. Any regression (scrub latency, HEVC config, heap) that can't be fixed in-session is a blocker for Plan C, not a silent carry.

---

## Self-review

**Spec coverage:**
- sync index pump → async packet pump → `PacketPump` (Task 3) ✓
- `SourceMedia` holds `OpenedMedia` + `getDecoderConfig()` instead of `Demuxer` + manual avcC/hvcC (Task 4 Step 3) ✓
- decoder meta open item (`nbSamples`/`timescale` consumers) → resolved: Compositor ignores the return; export consumes meta internally; interface relaxed to `Promise<unknown>`; `nbSamples` unneeded (EOS = `getNextPacket` null), `timescale` unneeded (mediabunny PTS in seconds) (Task 4 Steps 2–3) ✓
- packet cursor + `lastDecodedPtsUs` + `pumping` replacing `lastDecodedIndex`/`decodeFloor` (Task 3) ✓
- pump loop with post-await guard (Task 3 `runPump`) ✓ — `generation` counter (bumped by `invalidateCursor`/`dispose`) + `_disposed`, captured-and-rechecked around every await; guards the WebCodecs error-callback rebuild race (design note 2). The discriminating test ("rebuild during an await does not resurrect the cursor", Task 3 Step 1) fails without it.
- reset decision re-keyed to µs: far-forward + backward-beyond-ring (Task 2 `decideReset`) ✓ — synchronous + key-free per design note 1
- ADR 0004 output callback + FrameRing preserved verbatim (Task 4 Step 4) ✓
- per-clip handle / refcounted media / idle sweeper / recovery / EOS flush preserved (Tasks 4–5) ✓
- error handling: decode errors → unchanged `handleDecodeError`; packet rejection → pump `log` + frozen-frame (Task 3 `eosFlushOnce`/`runPump`); dispose mid-pump → `_disposed` guard (Task 3) ✓
- pure-unit `decideReset` truth table (Task 2) ✓; runtime acceptance MP4+MKV+HEVC+heap (Task 5) ✓
- non-goals respected: no `ExportDecoderPool`/`encoder.ts`/mp4box-removal/`decide()` edits ✓

**Placeholder scan:** none. Verbatim-copy instructions (ADR-0004 callbacks) include the full code rather than a "copy from old file" pointer. The two conditionals (Task 1 API-pin "if it differs"; Task 4 Step 6 "if assignability error") are bounded empirical checks with the exact remedy given — not placeholders.

**Type consistency:** `PacketPump` deps (`PumpDecoder`/`PumpPacket`/`PumpPacketSink`/`PumpRing`/`PumpDeps`) defined in Task 3, consumed by `SourceHandle.makePumpDeps` in Task 4 with matching shapes (`configure()` parameterless; `state: CodecState`; `decodeQueueSize` getter). `decideReset`/`FORWARD_SEEK_RESET_US`/`MAX_QUEUE` exported from `PacketPump.ts` (Task 2/3), used by `PacketPump` internally. `SourceMedia.packetSink: EncodedPacketSink` (Task 4 Step 3) feeds `PumpDeps.packetSink` (Task 4 Step 4). `SourceMedia.ensureReady(): Promise<VideoDecoderConfig>` → `SourceHandle.config` → `buildConfig()` spread. `DecoderHandle.ensureReady(): Promise<unknown>` satisfied by `SourceHandle`'s `Promise<void>` and `ExportSourceHandle`'s `Promise<VideoTrackMeta>`. `invalidateCursor` (Task 3) called by `nullForRebuild`/`flush` (Task 5 methods in Task 4 file). Method names consistent across tasks.
