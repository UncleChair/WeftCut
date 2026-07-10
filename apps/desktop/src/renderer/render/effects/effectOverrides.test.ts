import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTransientOverrides,
  isEffectDisabled,
  overrideFor,
  resetEffectOverrides,
  setEffectDisabled,
  setTransientOverrides,
  subscribeEffectOverrides,
} from "./effectOverrides";

afterEach(resetEffectOverrides);

describe("effectOverrides", () => {
  it("set/clear round-trips per effect id", () => {
    setTransientOverrides("E1", { keyR: 0.5, keyG: 0.25 });
    expect(overrideFor("E1", "keyR")).toBe(0.5);
    expect(overrideFor("E1", "keyB")).toBeUndefined();
    expect(overrideFor("E2", "keyR")).toBeUndefined();
    clearTransientOverrides("E1");
    expect(overrideFor("E1", "keyR")).toBeUndefined();
  });
  it("disabled flag round-trips", () => {
    expect(isEffectDisabled("E1")).toBe(false);
    setEffectDisabled("E1", true);
    expect(isEffectDisabled("E1")).toBe(true);
    setEffectDisabled("E1", false);
    expect(isEffectDisabled("E1")).toBe(false);
  });
  it("notifies subscribers on every change; unsubscribe stops it", () => {
    const fn = vi.fn();
    const unsub = subscribeEffectOverrides(fn);
    setTransientOverrides("E1", { a: 1 });
    setEffectDisabled("E1", true);
    clearTransientOverrides("E1");
    expect(fn).toHaveBeenCalledTimes(3);
    unsub();
    setTransientOverrides("E1", { a: 2 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
