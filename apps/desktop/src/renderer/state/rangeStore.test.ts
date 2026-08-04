import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRange,
  hasMarkedRange,
  rangeInUs,
  rangeOutUs,
  resolveMarkedRange,
  setRangeIn,
  setRangeOut,
  useRangeStore,
} from "./rangeStore";

describe("rangeStore", () => {
  beforeEach(() => {
    useRangeStore.setState({ inUs: null, outUs: null });
  });

  it("starts unmarked", () => {
    expect(rangeInUs()).toBeNull();
    expect(rangeOutUs()).toBeNull();
    expect(hasMarkedRange()).toBe(false);
  });

  it("marks each end independently", () => {
    setRangeIn(1_000_000);
    expect(hasMarkedRange()).toBe(true);
    expect(rangeOutUs()).toBeNull();
    setRangeOut(5_000_000);
    expect(rangeInUs()).toBe(1_000_000);
    expect(rangeOutUs()).toBe(5_000_000);
  });

  it("clears both ends", () => {
    setRangeIn(1_000_000);
    setRangeOut(5_000_000);
    clearRange();
    expect(hasMarkedRange()).toBe(false);
  });

  // Clearing rather than clamping is the deliberate choice: a clamp would
  // invent a boundary the user never marked and then export it.
  describe("crossing the other end", () => {
    it("drops the out point when the in point passes it", () => {
      setRangeOut(3_000_000);
      setRangeIn(8_000_000);
      expect(rangeInUs()).toBe(8_000_000);
      expect(rangeOutUs()).toBeNull();
    });

    it("drops the in point when the out point falls before it", () => {
      setRangeIn(8_000_000);
      setRangeOut(3_000_000);
      expect(rangeOutUs()).toBe(3_000_000);
      expect(rangeInUs()).toBeNull();
    });

    // Equal is degenerate, not a zero-length range: an out point ON the in
    // point keeps no frames at all, since the end is exclusive.
    it("treats coincident points as a crossing", () => {
      setRangeIn(4_000_000);
      setRangeOut(4_000_000);
      expect(rangeInUs()).toBeNull();
    });
  });

  // The reveal flash keys off store writes, so re-marking the same point has to
  // still notify — it is the user re-confirming, and the flash is the answer.
  it("notifies on a re-mark of the same point", () => {
    let notifications = 0;
    setRangeIn(2_000_000);
    const unsubscribe = useRangeStore.subscribe(() => {
      notifications += 1;
    });
    setRangeIn(2_000_000);
    expect(notifications).toBe(1);
    unsubscribe();
  });
});

describe("resolveMarkedRange", () => {
  const DURATION = 10_000_000;

  it("is null when nothing is marked", () => {
    expect(resolveMarkedRange(null, null, DURATION)).toBeNull();
  });

  // One end alone is a complete instruction in every NLE — the missing side
  // resolves against the composition rather than voiding the range.
  it("runs an in-only mark to the end of the project", () => {
    expect(resolveMarkedRange(4_000_000, null, DURATION)).toEqual({
      startUs: 4_000_000,
      endUs: DURATION,
    });
  });

  it("runs an out-only mark from the start of the project", () => {
    expect(resolveMarkedRange(null, 4_000_000, DURATION)).toEqual({
      startUs: 0,
      endUs: 4_000_000,
    });
  });

  it("clamps both ends into the project", () => {
    expect(resolveMarkedRange(-5_000_000, 99_000_000, DURATION)).toEqual({
      startUs: 0,
      endUs: DURATION,
    });
  });

  // Same rule as `clampExportRange`: never widen a range the user narrowed.
  // A project that shrank under a mark yields nothing, not everything.
  it("is null when clamping collapses the span", () => {
    expect(resolveMarkedRange(60_000_000, 120_000_000, DURATION)).toBeNull();
  });

  it("is null for an empty project", () => {
    expect(resolveMarkedRange(0, 5_000_000, 0)).toBeNull();
  });
});
