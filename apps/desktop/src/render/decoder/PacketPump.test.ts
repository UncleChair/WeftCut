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
