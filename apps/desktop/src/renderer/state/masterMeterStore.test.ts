import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearMasterMeter,
  publishMasterMeter,
  useMasterMeterStore,
} from "./masterMeterStore";

describe("masterMeterStore", () => {
  beforeEach(() => clearMasterMeter());

  it("publishes one real master RMS/peak sample to renderer subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = useMasterMeterStore.subscribe(listener);

    publishMasterMeter({ rmsDb: -18.25, peakDb: -2.5 }, 42);

    expect(useMasterMeterStore.getState()).toEqual({
      rmsDb: -18.25,
      peakDb: -2.5,
      sampledAtMs: 42,
    });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("normalizes analyser silence and clears a disposed owner", () => {
    publishMasterMeter({ rmsDb: -Infinity, peakDb: Number.NaN }, 9);
    expect(useMasterMeterStore.getState()).toEqual({
      rmsDb: -120,
      peakDb: -120,
      sampledAtMs: 9,
    });

    clearMasterMeter();
    expect(useMasterMeterStore.getState()).toEqual({
      rmsDb: -120,
      peakDb: -120,
      sampledAtMs: null,
    });
  });
});
