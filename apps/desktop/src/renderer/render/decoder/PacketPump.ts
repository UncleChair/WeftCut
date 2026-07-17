// The async packet pump for preview decode: a single-flight async loop
// driven by mediabunny's EncodedPacketSink (getKeyPacket / getNextPacket).
// Control-flow invariants live on the fields that enforce them: `pumping`
// (single-flight), `generation` (the mid-await race guard), and the pure
// `decideReset` (synchronous, key-packet-free reset DECISION — only the
// reset ACTION fetches a key packet).
// See docs/render.md#byte-handling.

import { packetToSourceUs, sourceToContainerUs } from "./ptsOffset";

/// Forward-seek threshold (µs). A target more than one lookahead window
/// (≈1 s, matching FrameRing's DEFAULT_LOOKAHEAD_US) past the pump's
/// decoded frontier triggers a reset+seek instead of a forward slog
/// through the intervening delta packets. See ADR 0003.
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
  /// Container PTS (µs) that corresponds to source-time 0. Preview callers
  /// speak normalized source time (`src_in_us` / layer-local), while mediabunny
  /// packets and WebCodecs frames carry container PTS. Keeping the offset here
  /// hides edit-list / trimmed-source starts from the Compositor and FrameRing.
  sourceStartPtsUs?: number;
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
  private seekResolvedForTargetUs: number | null = null;
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
    // target the OLD decoder already resolved.
    this.seekResolvedForTargetUs = null;
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
        const needsSeek =
          this.cursor === null ||
          (target !== this.seekResolvedForTargetUs &&
            decideReset({
              targetUs: target,
              lastDecodedPtsUs: this.lastDecodedPtsUs,
              ringFirstPtsUs: this.deps.ring.firstPtsUs(),
            }));
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
          if (isReset && this.deps.decoder.state === "configured") {
            this.deps.decoder.reset();
            this.deps.decoder.configure();
            this.deps.ring.flush();
          }
          if (this.deps.decoder.state === "configured") {
            this.deps.decoder.decode(key.toEncodedVideoChunk());
            this.cursor = key;
            this.lastDecodedPtsUs = this.toSourcePtsUs(key);
            this.flushedThisRun = false;
            this.seekResolvedForTargetUs = target;
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
          this.deps.decoder.decode(next.toEncodedVideoChunk());
          this.cursor = next;
          this.lastDecodedPtsUs = this.toSourcePtsUs(next);
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

  private toContainerPtsUs(sourceUs: number): number {
    return sourceToContainerUs(sourceUs, this.deps.sourceStartPtsUs ?? 0);
  }

  private toSourcePtsUs(packet: PumpPacket): number {
    return packetToSourceUs(packet.timestamp, this.deps.sourceStartPtsUs ?? 0);
  }
}
