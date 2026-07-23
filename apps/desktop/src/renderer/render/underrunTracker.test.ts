import { describe, expect, it } from "vitest";

import {
  judgeFrameSelection,
  UnderrunTracker,
  type UnderrunSnapshot,
} from "./underrunTracker";

const FRAME_US = 33_333; // 30 fps comp grid used throughout

describe("judgeFrameSelection", () => {
  it("flags a starved painter (no paintable frame) as late", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: null,
        selectedDurationUs: 0,
        srcTUs: 1_000_000,
        mediaDurationUs: null,
      }),
    ).toBe("late");
  });

  it("is fresh while srcTUs sits inside the bound frame's window", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: 1_000_000,
        selectedDurationUs: FRAME_US,
        srcTUs: 1_000_000 + FRAME_US - 1,
        mediaDurationUs: null,
      }),
    ).toBe("fresh");
  });

  it("flags a frame whose presentation window has passed", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: 1_000_000,
        selectedDurationUs: FRAME_US,
        srcTUs: 1_000_000 + 3 * FRAME_US,
        mediaDurationUs: null,
      }),
    ).toBe("late");
  });

  it("tolerates rational-rounding jitter past the window edge", () => {
    // 1 µs past pts+duration is grid jitter, not decoder lag.
    expect(
      judgeFrameSelection({
        selectedPtsUs: 1_000_000,
        selectedDurationUs: FRAME_US,
        srcTUs: 1_000_000 + FRAME_US + 1,
        mediaDurationUs: null,
      }),
    ).toBe("fresh");
  });

  it("treats a forward-clamped (CTS offset) selection as fresh", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: 40_000,
        selectedDurationUs: FRAME_US,
        srcTUs: 10_000,
        mediaDurationUs: null,
      }),
    ).toBe("fresh");
  });

  it("falls back to the 100 ms gap when duration is unreported", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: 1_000_000,
        selectedDurationUs: 0,
        srcTUs: 1_090_000,
        mediaDurationUs: null,
      }),
    ).toBe("fresh");
    expect(
      judgeFrameSelection({
        selectedPtsUs: 1_000_000,
        selectedDurationUs: 0,
        srcTUs: 1_150_000,
        mediaDurationUs: null,
      }),
    ).toBe("late");
  });

  it("exempts source times at/past media EOS — a held tail frame is not a drop", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: 9_966_667,
        selectedDurationUs: FRAME_US,
        srcTUs: 10_500_000, // clip trimmed past a 10 s media
        mediaDurationUs: 10_000_000,
      }),
    ).toBe("fresh");
    // Even a starved ring is exempt past EOS.
    expect(
      judgeFrameSelection({
        selectedPtsUs: null,
        selectedDurationUs: 0,
        srcTUs: 10_500_000,
        mediaDurationUs: 10_000_000,
      }),
    ).toBe("fresh");
  });
});

/// Tracker with a hand-cranked clock. All timing behavior (hold decay,
/// grace deadline, emit throttle) is asserted against this fake now().
function makeTracker(opts: { holdMs?: number; graceMaxMs?: number; minEmitIntervalMs?: number } = {}) {
  let nowMs = 0;
  const emissions: UnderrunSnapshot[] = [];
  const tracker = new UnderrunTracker({
    onChange: (s) => emissions.push(s),
    holdMs: opts.holdMs ?? 1_500,
    graceMaxMs: opts.graceMaxMs ?? 1_000,
    minEmitIntervalMs: opts.minEmitIntervalMs ?? 250,
    now: () => nowMs,
  });
  return {
    tracker,
    emissions,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("UnderrunTracker", () => {
  it("activates immediately on the first late sweep and counts the frame", () => {
    const { tracker, emissions } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    expect(tracker.snapshot()).toEqual({ active: true, droppedFrames: 1 });
    expect(emissions.at(-1)).toEqual({ active: true, droppedFrames: 1 });
  });

  it("counts a comp frame once across repeated rAF ticks", () => {
    const { tracker } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    tracker.judgeSweep(true, 0); // same comp frame, second rAF tick
    tracker.judgeSweep(true, FRAME_US);
    expect(tracker.snapshot().droppedFrames).toBe(2);
  });

  it("throttles count-growth emissions but not edge flips", () => {
    const { tracker, emissions, advance } = makeTracker({ minEmitIntervalMs: 250 });
    tracker.beginPlay();
    tracker.judgeSweep(true, 0); // edge → emit
    advance(50);
    tracker.judgeSweep(true, FRAME_US); // growth within 250 ms → suppressed
    expect(emissions.at(-1)!.droppedFrames).toBe(1);
    advance(250);
    tracker.judgeSweep(true, 2 * FRAME_US); // past the interval → emitted
    expect(emissions.at(-1)!.droppedFrames).toBe(3);
  });

  it("decays active after holdMs of clean sweeps; the count survives", () => {
    const { tracker, emissions, advance } = makeTracker({ holdMs: 1_500 });
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    advance(1_499);
    tracker.tickDecay();
    expect(tracker.snapshot().active).toBe(true);
    advance(2);
    tracker.tickDecay();
    expect(tracker.snapshot()).toEqual({ active: false, droppedFrames: 1 });
    expect(emissions.at(-1)).toEqual({ active: false, droppedFrames: 1 });
  });

  it("suppresses late sweeps during the post-seek grace window", () => {
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.beginPlay();
    tracker.noteSeekWhilePlaying();
    tracker.judgeSweep(true, 0);
    advance(500);
    tracker.judgeSweep(true, FRAME_US);
    expect(tracker.snapshot()).toEqual({ active: false, droppedFrames: 0 });
  });

  it("clears grace on the first clean sweep, then judges normally", () => {
    const { tracker } = makeTracker();
    tracker.beginPlay();
    tracker.noteSeekWhilePlaying();
    tracker.judgeSweep(false, 0); // re-primed
    tracker.judgeSweep(true, FRAME_US);
    expect(tracker.snapshot().droppedFrames).toBe(1);
  });

  it("expires grace after graceMaxMs even without a clean sweep", () => {
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.beginPlay();
    tracker.noteSeekWhilePlaying();
    tracker.judgeSweep(true, 0); // suppressed
    advance(1_001);
    tracker.judgeSweep(true, FRAME_US); // wedged decoder can't hide forever
    expect(tracker.snapshot().droppedFrames).toBe(1);
  });

  it("beginPlay resets counters and notifies the store", () => {
    const { tracker, emissions } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    tracker.beginPlay();
    expect(tracker.snapshot()).toEqual({ active: false, droppedFrames: 0 });
    expect(emissions.at(-1)).toEqual({ active: false, droppedFrames: 0 });
  });

  it("reports the session summary exactly once", () => {
    const { tracker } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    expect(tracker.takeSessionSummary()).toBe(1);
    // pause-during-warmup fires setMasterPlayState(false) without a new
    // beginPlay — the latch keeps the stale count from re-logging.
    expect(tracker.takeSessionSummary()).toBe(0);
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    expect(tracker.takeSessionSummary()).toBe(1);
  });

  it("never emits when nothing changed", () => {
    const { tracker, emissions, advance } = makeTracker();
    tracker.beginPlay();
    const baseline = emissions.length;
    tracker.judgeSweep(false, 0);
    tracker.tickDecay();
    advance(5_000);
    tracker.tickDecay();
    expect(emissions.length).toBe(baseline);
  });
});
