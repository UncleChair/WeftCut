// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  setKeyframeFocus, clearKeyframeFocus, useFocusedParamKeyForTrackLayers,
} from "./focusStore";

beforeEach(() => clearKeyframeFocus());

describe("useFocusedParamKeyForTrackLayers", () => {
  it("returns the focused paramKey when the focused layer is in the set", () => {
    setKeyframeFocus("L1", "opacity");
    const { result } = renderHook(() => useFocusedParamKeyForTrackLayers(new Set(["L1", "L2"])));
    expect(result.current).toBe("opacity");
  });
  it("returns null when the focused layer is NOT in the set", () => {
    setKeyframeFocus("LX", "opacity");
    const { result } = renderHook(() => useFocusedParamKeyForTrackLayers(new Set(["L1"])));
    expect(result.current).toBeNull();
  });
});
