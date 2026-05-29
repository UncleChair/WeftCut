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
