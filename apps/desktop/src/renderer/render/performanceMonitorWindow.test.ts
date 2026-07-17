// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PERF_MONITOR_WINDOW_LABEL,
  openPerformanceMonitor,
} from "./performanceMonitorWindow";

describe("openPerformanceMonitor", () => {
  const exists = vi.fn<() => Promise<boolean>>();
  const create = vi.fn<() => Promise<void>>();
  const act = vi.fn<() => Promise<void>>();

  beforeEach(() => {
    exists.mockReset();
    create.mockReset().mockResolvedValue(undefined);
    act.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { win: { exists, create, act } },
    });
  });

  it("creates, shows, and focuses a missing singleton", async () => {
    exists.mockResolvedValue(false);

    await openPerformanceMonitor();

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      PERF_MONITOR_WINDOW_LABEL,
      expect.objectContaining({ url: "/?perfHud=1", decorations: false }),
    );
    expect(act.mock.calls).toEqual([
      [PERF_MONITOR_WINDOW_LABEL, "show"],
      [PERF_MONITOR_WINDOW_LABEL, "focus"],
    ]);
  });

  it("reuses and focuses an existing singleton without recreating it", async () => {
    exists.mockResolvedValue(true);

    await openPerformanceMonitor();

    expect(create).not.toHaveBeenCalled();
    expect(act.mock.calls).toEqual([
      [PERF_MONITOR_WINDOW_LABEL, "show"],
      [PERF_MONITOR_WINDOW_LABEL, "focus"],
    ]);
  });
});
