// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  disposers: new Map<string, ReturnType<typeof vi.fn>>(),
  emit: vi.fn<() => Promise<void>>(),
  getByLabel: vi.fn<() => Promise<unknown>>(),
  getSystemStats: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@/bridge/events", () => ({
  listen: vi.fn(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(event, handler);
      const dispose = vi.fn(() => mocks.listeners.delete(event));
      mocks.disposers.set(event, dispose);
      return dispose;
    },
  ),
  emit: mocks.emit,
}));

vi.mock("@/bridge/window", () => ({
  SecondaryWindow: { getByLabel: mocks.getByLabel },
}));

vi.mock("../ipc", () => ({
  getSystemStats: mocks.getSystemStats,
}));

import { PerfTelemetryBridge } from "./PerfHUD";
import type { Compositor } from "./Compositor";
import type { PlaybackEngine } from "./PlaybackEngine";
import {
  PERF_MONITOR_WINDOW_CLOSED_EVENT,
  PERF_MONITOR_WINDOW_LABEL,
  PERF_MONITOR_WINDOW_OPENED_EVENT,
} from "./performanceMonitorWindow";

describe("PerfTelemetryBridge", () => {
  const requestAnimationFrame = vi.fn<(callback: FrameRequestCallback) => number>();
  const cancelAnimationFrame = vi.fn<(handle: number) => void>();

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listeners.clear();
    mocks.disposers.clear();
    mocks.emit.mockReset().mockResolvedValue(undefined);
    mocks.getByLabel.mockReset().mockResolvedValue(null);
    mocks.getSystemStats.mockReset().mockResolvedValue({
      cpu_percent: 1,
      rss_bytes: 1024,
      process_count: 1,
      logical_cores: 8,
    });
    let nextRaf = 1;
    requestAnimationFrame.mockReset().mockImplementation(() => nextRaf++);
    cancelAnimationFrame.mockReset();
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders no inline chrome and stays idle until the monitor opens", async () => {
    const compositor = {
      getPerfSnapshot: vi.fn(() => ({ clips: [] })),
      getAudioGraph: vi.fn(() => null),
      resetPerfPeaks: vi.fn(),
    };
    const engine = {
      positionUs: vi.fn(() => 0),
      getWarmupStats: vi.fn(() => ({ lastMs: null, maxMs: 0, lastReason: null })),
      resetWarmupStats: vi.fn(),
    };
    const { container } = render(
      <PerfTelemetryBridge
        compositorRef={{ current: compositor as unknown as Compositor } as RefObject<Compositor>}
        engineRef={{ current: engine as unknown as PlaybackEngine } as RefObject<PlaybackEngine>}
      />,
    );
    await act(async () => Promise.resolve());

    expect(container.childElementCount).toBe(0);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(compositor.getPerfSnapshot).not.toHaveBeenCalled();
    expect(mocks.getSystemStats).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.listeners.has("weftcut://perf-hud-reset")).toBe(false);
  });

  it("starts every sampler on open and tears it down on close", async () => {
    const compositor = {
      getPerfSnapshot: vi.fn(() => ({ clips: [] })),
      getAudioGraph: vi.fn(() => null),
      resetPerfPeaks: vi.fn(),
    };
    const engine = {
      positionUs: vi.fn(() => 123),
      getWarmupStats: vi.fn(() => ({ lastMs: null, maxMs: 0, lastReason: null })),
      resetWarmupStats: vi.fn(),
    };
    render(
      <PerfTelemetryBridge
        compositorRef={{ current: compositor as unknown as Compositor } as RefObject<Compositor>}
        engineRef={{ current: engine as unknown as PlaybackEngine } as RefObject<PlaybackEngine>}
      />,
    );
    await act(async () => Promise.resolve());

    await act(async () => {
      mocks.listeners.get(PERF_MONITOR_WINDOW_OPENED_EVENT)?.({
        payload: { label: PERF_MONITOR_WINDOW_LABEL },
      });
      await Promise.resolve();
    });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(mocks.listeners.has("weftcut://perf-hud-reset")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(compositor.getPerfSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.getSystemStats).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledWith(
      "weftcut://perf-hud-snapshot",
      expect.objectContaining({ playheadUs: 123 }),
    );

    await act(async () => {
      mocks.listeners.get("weftcut://perf-hud-reset")?.({ payload: undefined });
      await Promise.resolve();
    });
    expect(compositor.resetPerfPeaks).toHaveBeenCalledOnce();
    expect(engine.resetWarmupStats).toHaveBeenCalledOnce();

    const compositorPolls = compositor.getPerfSnapshot.mock.calls.length;
    const systemPolls = mocks.getSystemStats.mock.calls.length;
    const broadcasts = mocks.emit.mock.calls.length;
    await act(async () => {
      mocks.listeners.get(PERF_MONITOR_WINDOW_CLOSED_EVENT)?.({
        payload: { label: PERF_MONITOR_WINDOW_LABEL },
      });
      await Promise.resolve();
    });
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(mocks.disposers.get("weftcut://perf-hud-reset")).toHaveBeenCalledOnce();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(compositor.getPerfSnapshot).toHaveBeenCalledTimes(compositorPolls);
    expect(mocks.getSystemStats).toHaveBeenCalledTimes(systemPolls);
    expect(mocks.emit).toHaveBeenCalledTimes(broadcasts);
  });
});
