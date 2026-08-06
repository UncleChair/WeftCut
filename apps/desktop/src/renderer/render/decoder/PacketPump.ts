// The async packet pump for preview decode: a single-flight async loop
// driven by mediabunny's EncodedPacketSink (getKeyPacket / getNextPacket).
// Control-flow invariants live on the fields that enforce them: `pumping`
// (single-flight), `generation` (the mid-await race guard), and the pure
// `decideReset` (synchronous, key-packet-free reset DECISION — only the
// reset ACTION fetches a key packet).
// See docs/render.md#byte-handling.

import { DecodeClock, type DecodeClockPacket } from "./decodeClock";

/// Forward-seek threshold (µs). A target more than one lookahead window
/// (≈1 s, matching FrameRing's DEFAULT_LOOKAHEAD_US) past the pump's
/// decoded frontier triggers a reset+seek instead of a forward slog
/// through the intervening delta packets. See ADR 0003.
export const FORWARD_SEEK_RESET_US = 1_000_000;

/// Decoder-queue backpressure cap. `VideoDecoder.decode()` queues
/// internally; the OUTPUT callback fires async, so the ring stays empty
/// within a single pump burst. We cap on the decoder's own queue depth.
/// 24 is the typical decoder soft limit; it keeps the queue fed across scrub
/// pauses where the pump runs only ~every 50ms.
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

/// Pure ADR-0003 reset decision, in µs.
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
export function resetReason(s: ResetDecisionInput): ResetReason | null {
  if (s.ringFirstPtsUs !== null && s.targetUs < s.ringFirstPtsUs)
    return "backward-beyond-ring";
  if (s.targetUs - s.lastDecodedPtsUs > FORWARD_SEEK_RESET_US) return "far-forward";
  return null;
}

/// WHICH of the two conditions above fired. The two are not interchangeable and
/// the pump treats them differently:
///
///   - `backward-beyond-ring` — the cached frames are from the WRONG REGION of
///     the timeline and must go, so the reset flushes the ring, and re-seeking to
///     a key we are already past is mandatory (the pump only moves forward).
///   - `far-forward` — the cached frames are not wrong, merely early or already
///     trimmed by `setAnchor`, so the reset must NOT flush; and re-seeking to a
///     key the frontier has already advanced past is not just useless but
///     harmful (see `seekedKeyTimestamp`).
export type ResetReason = "backward-beyond-ring" | "far-forward";

export function decideReset(s: ResetDecisionInput): boolean {
  return resetReason(s) !== null;
}

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
export interface PumpPacket extends DecodeClockPacket {
  /// Presentation timestamp in **seconds** (mediabunny's unit).
  readonly timestamp: number;
}

/// Minimal view of a mediabunny `EncodedPacketSink`. `EncodedPacketSink`
/// satisfies this structurally (its extra optional `options` params are
/// compatible under TS method bivariance). If a strict-mode assignability
/// error surfaces at the wiring site, wrap the sink in a thin adapter there.
export interface PumpPacketSink {
  getKeyPacket(tsSeconds: number): Promise<PumpPacket | null>;
  getFirstPacket(): Promise<PumpPacket | null>;
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
  /// One clock per opened decode source. It owns the container↔source mapping
  /// used by seek, packet dispatch, and decoder output; callers must not
  /// reconstruct packet microseconds independently from floating-point seconds.
  decodeClock?: DecodeClock;
  /// Optional diagnostic sink (EOS-flush failures, etc.).
  log?: (msg: string) => void;
}

export class PacketPump {
  private readonly deps: PumpDeps;
  private readonly clock: DecodeClock;
  /// The last packet dispatched to the decoder. `null` means "not
  /// positioned" — the next pump pass cold-starts by seeking to a key.
  private cursor: PumpPacket | null = null;
  /// Latest requested playhead/scrub target (µs). Updated synchronously
  /// by every requestFrameAt; read at the top of each pump pass + each
  /// fill iteration so a mid-flight seek is picked up immediately.
  private targetUs = 0;
  /// PTS (µs) of `cursor`. Sentinel until cold start positions the cursor;
  /// never read by `decideReset` while the sentinel holds (the pump
  /// short-circuits cold start via `cursor === null`).
  private lastDecodedPtsUs = Number.NEGATIVE_INFINITY;
  /// The `targetUs` the pump last successfully seeked for, or `null` if no
  /// seek has landed since cold start / the last cursor invalidation.
  /// LANDMINE: `decideReset`'s far-forward arm stays true after a long-GOP
  /// seek, because the key packet can sit well over a second before the
  /// target — that's inherent to the GOP structure, not something the seek
  /// can fix. Without this latch, every subsequent pass (including the
  /// mid-fill re-check and the next `requestFrameAt` for the SAME target)
  /// reads that same "true" and re-seeks the identical key, forever —
  /// the pump never advances past it. The latch scopes the reset decision
  /// to "have I already seeked for this exact target", so decideReset only
  /// gets to fire a fresh reset when the target actually changes.
  ///
  /// This is a FAST PATH ONLY, and on its own it is not sufficient — see
  /// `seekedKeyTimestamp`. It saves a key-packet lookup while the target holds
  /// still; it cannot protect a target that moves.
  private seekResolvedForTargetUs: number | null = null;
  /// Container timestamp (seconds — the packet's own identity) of the key packet
  /// the pump last seeked to, or `null` before any seek / after an invalidation.
  ///
  /// LANDMINE, and the reason this exists alongside `seekResolvedForTargetUs`:
  /// that latch is keyed on the TARGET, and **during playback the target changes
  /// every single frame**. So it only ever protected a stationary playhead (a
  /// held position, a settled scrub) and gave zero protection under playback.
  /// Once a clip falls behind under load, every pump pass sees a fresh target,
  /// re-fires the far-forward arm, resets, flushes the ring, and re-seeks to the
  /// SAME key up to a whole GOP back — throwing away the prefix it just decoded,
  /// so the ring never fills and falling behind is what makes it fall further
  /// behind.
  ///
  /// Keyed on the KEY PACKET instead, the check holds for a moving target: if the
  /// seek would land on the key we are already decoding forward from, it is a
  /// no-op and must be skipped rather than performed. Scoped to `far-forward`
  /// only — a BACKWARD target inside the same GOP genuinely needs the re-seek,
  /// because the pump cannot reach it by moving forward.
  ///
  /// Deliberately key IDENTITY and not "is the key at or before the frontier",
  /// which would be the more general rule (it would also cover a key the pump
  /// crossed in-stream under ADR 0003, where a forward GOP boundary needs no
  /// reset). The general form has to convert `key.timestamp` seconds into source
  /// µs to compare against `lastDecodedPtsUs`, and that conversion is the exact
  /// ±1 µs rounding trap the non-zero-origin frontier test guards: the pump's
  /// frontier comes from `chunk.timestamp`, not from `round(seconds * 1e6)`.
  /// Comparing a packet's own `timestamp` to itself has no rounding at all.
  private seekedKeyTimestamp: number | null = null;
  /// Single-flight guard: at most one runPump() loop is live.
  private pumping = false;
  /// Set by requestFrameAt while a loop is live; the loop re-runs its
  /// body for the new target instead of a second loop starting.
  private wakeRequested = false;
  /// True once the current decode run has issued its end-of-stream flush.
  /// Cleared on any reset / cursor invalidation. Prevents re-flushing the
  /// DPB every pass once the pump has settled at EOS.
  private flushedThisRun = false;
  /// Bumped by `invalidateCursor` (decoder rebuild) and `dispose` — the two
  /// things that interleave across the pump's awaits (the WebCodecs error
  /// callback fires as a queued event-loop task and runs
  /// `SourceHandle.nullForRebuild → invalidateCursor()` on
  /// software-downgrade / inactivity-rebuild). Every await captures the
  /// generation before it and bails after it if it moved (or `_disposed`).
  /// Without this guard, an in-flight getNextPacket continuation resurrects
  /// `cursor` to a delta packet after a rebuild nulled it, feeding the fresh
  /// decoder a delta → decode error → recovery never completes. NOT bumped
  /// by in-loop resets (those are serialized inside runPump; nothing else
  /// interleaves with them).
  private generation = 0;
  private _disposed = false;

  constructor(deps: PumpDeps) {
    this.deps = deps;
    this.clock = deps.decodeClock ?? DecodeClock.fromOrigin(0);
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
    // The fresh decoder has never been seeked; let it re-seek even for a
    // target the OLD decoder already resolved, and even to the same key.
    this.seekResolvedForTargetUs = null;
    this.seekedKeyTimestamp = null;
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
        // The `target !== seekResolvedForTargetUs` guard is the livelock
        // fix: decideReset alone would re-fire every pass for a far target
        // whose key sits >1s before it, even though the seek already
        // landed there (see the field doc on seekResolvedForTargetUs).
        const reason =
          target !== this.seekResolvedForTargetUs
            ? resetReason({
                targetUs: target,
                lastDecodedPtsUs: this.lastDecodedPtsUs,
                ringFirstPtsUs: this.deps.ring.firstPtsUs(),
              })
            : null;
        const needsSeek = this.cursor === null || reason !== null;
        if (needsSeek) {
          const isReset = this.cursor !== null; // cold start is not a reset
          const myGen = this.generation;
          let key = await this.deps.packetSink.getKeyPacket(
            this.toContainerPtsUs(target) / 1e6,
          );
          // A rebuild (invalidateCursor) or dispose during the await bumps
          // generation — bail rather than seed a stale decoder.
          if (this.generation !== myGen || this._disposed) return;
          if (!key) {
            // If source-time 0 maps before the container's first key packet
            // (trimmed / edit-list sources), start from the opening packet
            // instead of wedging. Export has the same fallback.
            key = await this.deps.packetSink.getFirstPacket();
            if (this.generation !== myGen || this._disposed) return;
          }
          if (!key) break; // no key packet (empty/bad source) — give up this pass
          // The seek would land on the key we are ALREADY decoding forward
          // from, for a target that merely drifted ahead. Performing it would
          // rewind the frontier to that key and discard the prefix already
          // decoded — and since the target keeps moving, do so again every pass.
          // That is the livelock; see `seekedKeyTimestamp`. Backward resets are
          // excluded deliberately: the pump only moves forward, so a backward
          // target inside this same GOP can only be reached by re-seeking.
          const alreadyDecodingFromKey =
            reason === "far-forward" &&
            this.cursor !== null &&
            key.timestamp === this.seekedKeyTimestamp;
          if (alreadyDecodingFromKey) {
            // Adopt the target into the fast path so the next pass skips the
            // key lookup too, and fall through to the forward fill.
            this.seekResolvedForTargetUs = target;
          } else {
            if (isReset && this.deps.decoder.state === "configured") {
              this.deps.decoder.reset();
              this.deps.decoder.configure();
              // Flush ONLY when the cached frames are from the wrong region.
              // On a far-forward reset they are not wrong — `requestFrameAt`
              // already called `setAnchor(target)`, which evicted everything
              // outside the new window, so what remains is either useful or
              // about to age out on its own. Flushing it was how a clip that
              // fell behind under load threw away the very frames that would
              // have served the playhead.
              if (reason === "backward-beyond-ring") this.deps.ring.flush();
            }
            if (this.deps.decoder.state === "configured") {
              const prepared = this.clock.prepare(key);
              this.deps.decoder.decode(prepared.chunk);
              this.cursor = key;
              this.lastDecodedPtsUs = prepared.sourcePtsUs;
              this.flushedThisRun = false;
              this.seekResolvedForTargetUs = target;
              this.seekedKeyTimestamp = key.timestamp;
            }
          }
        }

        // --- Fill forward to the lookahead window / queue cap ---
        while (
          this.deps.decoder.state === "configured" &&
          this.deps.decoder.decodeQueueSize < MAX_QUEUE &&
          !this.deps.ring.isLookaheadFull()
        ) {
          // A seek that arrived mid-fill is caught here synchronously (no
          // key fetch) — break and re-seek on the next pass. Same latch as
          // the pass-start check: once `targetUs` matches the target this
          // pump already seeked for, decideReset's far-forward arm is
          // expected to still read true (the key sits >1s before it) and
          // must NOT re-trigger a break/re-seek — that's the livelock.
          //
          // Left keyed on the TARGET rather than the key packet (unlike the
          // pass-start check) because this arm cannot afford the async key
          // lookup that identifying the key requires. The cost of that is
          // bounded and not a livelock: while a clip is lagging, every new
          // target breaks the fill once, the pass-start check then recognises
          // the key and declines to re-seek, and the fill resumes — so the
          // frontier still advances by at least one packet per tick and the
          // ring is never flushed. Progress, just not at full fill speed.
          if (
            this.targetUs !== this.seekResolvedForTargetUs &&
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
          const prepared = this.clock.prepare(next);
          this.deps.decoder.decode(prepared.chunk);
          this.cursor = next;
          this.lastDecodedPtsUs = prepared.sourcePtsUs;
        }
      } while (this.wakeRequested && !this._disposed);
    } finally {
      this.pumping = false;
      // Late-kick guard: a requestFrameAt that set `wakeRequested` between
      // the do/while check and `pumping = false` would otherwise be lost.
      // In the FINALLY, not after it: the generation-bail returns above exit
      // with `pumping` cleared but skipped a kick placed after the block, so
      // a target that landed during their await was dropped for one tick.
      if (this.wakeRequested && !this._disposed) void this.runPump();
    }
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

  private toContainerPtsUs(sourceUs: number): number {
    return this.clock.containerUs(sourceUs);
  }
}
