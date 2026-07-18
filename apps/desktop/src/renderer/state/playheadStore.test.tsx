// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  setPlayheadTimeUs,
  usePlayheadTimeUsThrottled,
} from "./playheadStore";

beforeEach(() => setPlayheadTimeUs(0));

describe("usePlayheadTimeUsThrottled", () => {
  it("catches up immediately when a hidden consumer becomes visible", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => usePlayheadTimeUsThrottled(100, enabled),
      { initialProps: { enabled: false } },
    );

    act(() => setPlayheadTimeUs(750_000));
    expect(result.current).toBe(0);

    rerender({ enabled: true });
    expect(result.current).toBe(750_000);
  });
});
