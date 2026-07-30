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
/// grace deadline, emit throttle, late-tick threshold) is asserted against
/// this fake now().
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
    expect(tracker.snapshot()).toEqual({
      active: true,
      droppedFrames: 1,
      lateFrames: 0,
    });
    expect(emissions.at(-1)).toEqual({
      active: true,
      droppedFrames: 1,
      lateFrames: 0,
    });
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
    expect(tracker.snapshot()).toEqual({
      active: false,
      droppedFrames: 1,
      lateFrames: 0,
    });
    expect(emissions.at(-1)).toEqual({
      active: false,
      droppedFrames: 1,
      lateFrames: 0,
    });
  });

  it("suppresses late sweeps during the post-seek grace window", () => {
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.beginPlay();
    tracker.noteSeekWhilePlaying();
    tracker.judgeSweep(true, 0);
    advance(500);
    tracker.judgeSweep(true, FRAME_US);
    expect(tracker.snapshot()).toEqual({
      active: false,
      droppedFrames: 0,
      lateFrames: 0,
    });
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

  it("carries an unexpired grace across beginPlay into the session it was armed for", () => {
    // play() arms the warm-up gate up to 250 ms before the master clock is
    // released, so a seek inside that window arms grace for exactly the ring
    // rebuild this session opens with. beginPlay clearing it would let that
    // rebuild score dropped frames the grace was armed against.
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.noteSeekWhilePlaying(); // t=0 → grace deadline t=1000
    advance(100);
    tracker.beginPlay(); // inside the deadline — grace survives
    tracker.judgeSweep(true, 0); // the rebuild's stale sweep → suppressed
    expect(tracker.snapshot().droppedFrames).toBe(0);
    advance(16);
    tracker.judgeSweep(false, FRAME_US); // re-primed → grace clears
    advance(16);
    tracker.judgeSweep(true, 2 * FRAME_US); // judged normally again
    expect(tracker.snapshot().droppedFrames).toBe(1);
  });

  it("does not carry an expired grace into a new play session", () => {
    // The survival rule is the DEADLINE, not the armed flag: a grace whose
    // window already lapsed before the clock released would otherwise be an
    // eternal one for the session that follows.
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.noteSeekWhilePlaying(); // t=0 → grace deadline t=1000
    advance(1_001);
    tracker.beginPlay(); // deadline already passed — grace must not survive
    tracker.judgeSweep(true, 0);
    expect(tracker.snapshot().droppedFrames).toBe(1);
  });

  it("beginPlay resets counters and notifies the store", () => {
    const { tracker, emissions } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    tracker.beginPlay();
    expect(tracker.snapshot()).toEqual({
      active: false,
      droppedFrames: 0,
      lateFrames: 0,
    });
    expect(emissions.at(-1)).toEqual({
      active: false,
      droppedFrames: 0,
      lateFrames: 0,
    });
  });

  it("reports the session summary exactly once", () => {
    const { tracker, advance } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    advance(100); // one stalled tick, so both counts are exercised
    tracker.judgeSweep(true, FRAME_US);
    expect(tracker.takeSessionSummary()).toEqual({
      droppedFrames: 2,
      lateFrames: 1,
    });
    // pause-during-warmup fires setMasterPlayState(false) without a new
    // beginPlay — the latch keeps the stale count from re-logging.
    expect(tracker.takeSessionSummary()).toEqual({
      droppedFrames: 0,
      lateFrames: 0,
    });
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    expect(tracker.takeSessionSummary()).toEqual({
      droppedFrames: 1,
      lateFrames: 0,
    });
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

/// The late-tick half: judder a full ring hides. Every sweep below passes
/// `anyLate: false` unless it is specifically testing the interaction, so
/// a count here can only have come from the tick interval.
describe("UnderrunTracker late ticks", () => {
  it("trips at the measured judder interval, not the healthy one", () => {
    // Default 30 fps budget → 33.3 + 4 ms slack = 37.3 ms threshold.
    // Both intervals are measured playback-perf figures: 17.4 ms is the
    // p95 of the passing 1080p WebCodecs cell, 38.8 ms the p99 of the
    // 3-track 1080p ffmpeg-hw cell that reports 0.00 % drops.
    const { tracker, advance } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    advance(17.4);
    tracker.judgeSweep(false, FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(0);
    advance(38.8);
    tracker.judgeSweep(false, 2 * FRAME_US);
    expect(tracker.snapshot()).toEqual({
      active: true,
      droppedFrames: 0,
      lateFrames: 1,
    });
  });

  it("tolerates 60 Hz rAF jitter at a 60 fps composition", () => {
    const { tracker, advance } = makeTracker();
    tracker.bindFrameBudgetMs(1_000 / 60);
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    [14, 19, 17, 18].forEach((gapMs, i) => {
      advance(gapMs);
      tracker.judgeSweep(false, (i + 1) * FRAME_US);
    });
    expect(tracker.snapshot().lateFrames).toBe(0);
  });

  it("follows the bound composition frame budget", () => {
    const { tracker, advance } = makeTracker();
    tracker.bindFrameBudgetMs(1_000 / 24); // 41.7 ms budget → 45.7 threshold
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    advance(38.8); // late for a 30 fps comp, on time for a 24 fps one
    tracker.judgeSweep(false, FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(0);
    advance(50);
    tracker.judgeSweep(false, 2 * FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(1);
  });

  it("floors the budget at the rAF rate for above-refresh compositions", () => {
    const { tracker, advance } = makeTracker();
    tracker.bindFrameBudgetMs(1_000 / 120);
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    advance(19); // ordinary 60 Hz jitter — the loop can't beat the display
    tracker.judgeSweep(false, FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(0);
  });

  it("never counts the first tick of a play session", () => {
    const { tracker, advance } = makeTracker();
    advance(10_000); // idle since app start; nothing to difference against
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    expect(tracker.snapshot().lateFrames).toBe(0);
  });

  it("does not synthesise a late tick across a pause", () => {
    const { tracker, advance } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    advance(30_000); // paused, no composites
    tracker.beginPlay();
    tracker.judgeSweep(false, FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(0);
  });

  it("does not synthesise a late tick across a scrub", () => {
    // Compositor skips judgeSweep while scrubbing but still calls
    // tickDecay every composite — that is what carries the stamp.
    const { tracker, advance } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    for (let i = 0; i < 10; i += 1) {
      advance(16);
      tracker.tickDecay();
    }
    advance(16);
    tracker.judgeSweep(false, FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(0);
  });

  it("counts one late frame per snapped comp frame", () => {
    const { tracker, advance } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    advance(50);
    tracker.judgeSweep(false, FRAME_US);
    advance(50);
    tracker.judgeSweep(false, FRAME_US); // same comp frame, second rAF tick
    expect(tracker.snapshot().lateFrames).toBe(1);
    advance(50);
    tracker.judgeSweep(false, 2 * FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(2);
  });

  it("keeps the two causes on separate counters", () => {
    const { tracker, advance } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0); // decoder behind, tick on time
    advance(50);
    tracker.judgeSweep(false, FRAME_US); // ring fresh, loop stalled
    expect(tracker.snapshot()).toEqual({
      active: true,
      droppedFrames: 1,
      lateFrames: 1,
    });
  });

  it("suppresses late ticks during the post-seek grace window", () => {
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    tracker.noteSeekWhilePlaying();
    advance(100); // the ring rebuild stalls the loop
    tracker.judgeSweep(false, FRAME_US);
    expect(tracker.snapshot()).toEqual({
      active: false,
      droppedFrames: 0,
      lateFrames: 0,
    });
  });

  it("clears grace once a tick lands on time again", () => {
    const { tracker, advance } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    tracker.noteSeekWhilePlaying();
    advance(100);
    tracker.judgeSweep(false, FRAME_US); // still stalled → suppressed
    advance(16);
    tracker.judgeSweep(false, 2 * FRAME_US); // on time → re-primed
    advance(50);
    tracker.judgeSweep(false, 3 * FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(1);
  });

  it("expires grace after graceMaxMs even while ticks stay late", () => {
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    tracker.noteSeekWhilePlaying();
    advance(1_001);
    tracker.judgeSweep(false, FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(1);
  });

  it("decays active after a late tick; the count survives", () => {
    const { tracker, advance } = makeTracker({ holdMs: 1_500 });
    tracker.beginPlay();
    tracker.judgeSweep(false, 0);
    advance(50);
    tracker.judgeSweep(false, FRAME_US);
    expect(tracker.snapshot().active).toBe(true);
    advance(1_501);
    tracker.tickDecay();
    expect(tracker.snapshot()).toEqual({
      active: false,
      droppedFrames: 0,
      lateFrames: 1,
    });
  });
});
