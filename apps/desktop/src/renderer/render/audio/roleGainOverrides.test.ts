import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearRoleGainOverride,
  resetRoleGainOverrides,
  roleGainOverrideDb,
  setRoleGainOverride,
  subscribeRoleGainOverrides,
} from "./roleGainOverrides";

afterEach(() => resetRoleGainOverrides());

describe("roleGainOverrides", () => {
  it("has no override for an idle Role", () => {
    expect(roleGainOverrideDb("dialogue")).toBeUndefined();
  });

  it("records and reads the auditioned dB per Role, independently", () => {
    setRoleGainOverride("dialogue", -6);
    setRoleGainOverride("music", 3);
    expect(roleGainOverrideDb("dialogue")).toBe(-6);
    expect(roleGainOverrideDb("music")).toBe(3);
    expect(roleGainOverrideDb("sfx")).toBeUndefined();
  });

  it("clears one Role's override back to idle", () => {
    setRoleGainOverride("dialogue", -6);
    clearRoleGainOverride("dialogue");
    expect(roleGainOverrideDb("dialogue")).toBeUndefined();
  });

  it("notifies subscribers on set and on a real clear, but not on a no-op clear", () => {
    const fn = vi.fn();
    const unsub = subscribeRoleGainOverrides(fn);

    setRoleGainOverride("dialogue", -6);
    expect(fn).toHaveBeenCalledTimes(1);

    clearRoleGainOverride("dialogue");
    expect(fn).toHaveBeenCalledTimes(2);

    // Clearing an already-idle Role changes nothing → no notification.
    clearRoleGainOverride("dialogue");
    expect(fn).toHaveBeenCalledTimes(2);

    unsub();
    setRoleGainOverride("music", 1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("resetRoleGainOverrides drops every override and notifies once when non-empty", () => {
    const fn = vi.fn();
    const unsub = subscribeRoleGainOverrides(fn);
    setRoleGainOverride("dialogue", -6);
    setRoleGainOverride("music", 3);
    fn.mockClear();

    resetRoleGainOverrides();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(roleGainOverrideDb("dialogue")).toBeUndefined();
    expect(roleGainOverrideDb("music")).toBeUndefined();

    // Reset from empty is a silent no-op.
    resetRoleGainOverrides();
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });
});
