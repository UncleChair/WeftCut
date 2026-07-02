// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeLanes,
  mergeStereo,
  TimelineWaveform,
  WAVEFORM_REFETCH_DEBOUNCE_MS,
} from "./TimelineWaveform";
import {
  ensureWaveformWindow,
  getWaveformChannelCount,
  type WaveformWindow,
} from "./tileEngine/WaveformTileProducer";

vi.mock("./tileEngine/WaveformTileProducer", () => ({
  registerWaveformProducer: vi.fn(),
  ensureWaveformWindow: vi.fn(async () => "pending" as const),
  getWaveformChannelCount: vi.fn(async () => 1),
}));

vi.mock("./tileEngine/TileEngine", () => ({
  tileEngine: { subscribe: vi.fn(() => () => {}) },
}));

/// Drains a bounded number of microtask turns under `act`, so chained
/// promises (channel-count fetch -> ensure-window fetch -> setState) that
/// aren't gated by any timer still settle before the next assertion. Needed
/// because "immediate" (mount / mediaId change / engine notification) fetches
/// intentionally involve no `setTimeout` for `vi.advanceTimersByTimeAsync` to
/// hook into.
async function flushMicrotasks(turns = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < turns; i++) {
      await Promise.resolve();
    }
  });
}

describe("computeLanes", () => {
  it("returns two lanes at exactly the stereo threshold height", () => {
    expect(computeLanes(28, 2)).toEqual([
      { channel: 0, midY: 7, ampPx: 6 },
      { channel: 1, midY: 21, ampPx: 6 },
    ]);
  });

  it("falls back to a merged lane one pixel under the threshold", () => {
    expect(computeLanes(27, 2)).toEqual([
      { channel: "merged", midY: 13.5, ampPx: 12.5 },
    ]);
  });

  it("forces a merged lane for mono regardless of height", () => {
    expect(computeLanes(100, 1)).toEqual([
      { channel: "merged", midY: 50, ampPx: 49 },
    ]);
  });
});

describe("mergeStereo", () => {
  const a: WaveformWindow = {
    // All literals below are exact sums of a few powers of two so they
    // round-trip through Float32Array without precision drift against the
    // hand-typed expectations (mirrors WaveformTileProducer.test.ts).
    peaksPerSecond: 1000,
    startPeak: 5,
    min: new Float32Array([-0.5, -0.25, -0.875]),
    max: new Float32Array([0.375, 0.25, 0.125]),
    rms: new Float32Array([0.125, 0.375, 0.25]),
  };
  const b: WaveformWindow = {
    // Deliberately different from `a`'s metadata: mergeStereo must keep a's.
    peaksPerSecond: 2000,
    startPeak: 9,
    min: new Float32Array([-0.375, -0.625, -0.0625]),
    max: new Float32Array([0.625, 0.125, 0.25]),
    rms: new Float32Array([0.25, 0.0625, 0.875]),
  };

  it("takes the element-wise min/max envelope and max rms, keeping a's metadata", () => {
    const merged = mergeStereo(a, b);
    expect(merged.peaksPerSecond).toBe(1000);
    expect(merged.startPeak).toBe(5);
    expect(Array.from(merged.min)).toEqual([-0.5, -0.625, -0.875]);
    expect(Array.from(merged.max)).toEqual([0.625, 0.25, 0.25]);
    expect(Array.from(merged.rms)).toEqual([0.25, 0.375, 0.875]);
  });

  it("uses the shorter length when the windows differ in size", () => {
    const shortB: WaveformWindow = {
      peaksPerSecond: 2000,
      startPeak: 9,
      min: new Float32Array([-0.375, -0.625]),
      max: new Float32Array([0.625, 0.125]),
      rms: new Float32Array([0.25, 0.0625]),
    };
    const merged = mergeStereo(a, shortB);
    expect(merged.min.length).toBe(2);
    expect(Array.from(merged.min)).toEqual([-0.5, -0.625]);
    expect(Array.from(merged.max)).toEqual([0.625, 0.25]);
    expect(Array.from(merged.rms)).toEqual([0.25, 0.375]);
  });
});

describe("TimelineWaveform", () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let fakeContext: {
    beginPath: ReturnType<typeof vi.fn>;
    clearRect: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    moveTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
    setTransform: ReturnType<typeof vi.fn>;
    fillStyle: string;
    lineWidth: number;
    strokeStyle: string;
  };

  beforeEach(() => {
    vi.mocked(ensureWaveformWindow).mockReset();
    vi.mocked(ensureWaveformWindow).mockResolvedValue("pending");
    vi.mocked(getWaveformChannelCount).mockReset();
    vi.mocked(getWaveformChannelCount).mockResolvedValue(1);
    fakeContext = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      stroke: vi.fn(),
      setTransform: vi.fn(),
      fillStyle: "",
      lineWidth: 1,
      strokeStyle: "",
    };
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = ((contextId: string) =>
      contextId === "2d" ? fakeContext : null) as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    cleanup();
  });

  it("renders center-line placeholder while not ready", async () => {
    const { getByTestId } = render(
      <TimelineWaveform
        mediaId="media-1"
        srcInUs={0}
        srcOutUs={1_000_000}
        layerWidthPx={100}
        layerHeightPx={24}
        colorHint="#446688"
        enabled
        pxPerSec={80}
      />,
    );

    await waitFor(() => {
      expect(ensureWaveformWindow).toHaveBeenCalledWith(
        "media-1",
        0,
        0,
        1_000_000,
        80,
      );
    });
    const wrapper = getByTestId("timeline-waveform");
    await waitFor(() => {
      expect(wrapper.getAttribute("data-state")).toBe("pending");
    });
    expect(fakeContext.moveTo).toHaveBeenCalledWith(0, 12);
    expect(fakeContext.lineTo).toHaveBeenCalledWith(100, 12);
    expect(fakeContext.stroke).toHaveBeenCalled();
  });

  it("exposes data-state=ready once the engine resolves a window", async () => {
    vi.mocked(ensureWaveformWindow).mockResolvedValue({
      peaksPerSecond: 1000,
      startPeak: 0,
      min: new Float32Array([-0.5, -0.7]),
      max: new Float32Array([0.5, 0.7]),
      rms: new Float32Array([0.2, 0.3]),
    });

    const { findByTestId } = render(
      <TimelineWaveform
        mediaId="m"
        srcInUs={0}
        srcOutUs={2_000_000}
        layerWidthPx={200}
        layerHeightPx={40}
        colorHint="#123"
        enabled
        pxPerSec={80}
      />,
    );
    const el = await findByTestId("timeline-waveform");
    await waitFor(() => expect(el.getAttribute("data-state")).toBe("ready"));
  });

  it("does not create a canvas wider than the tile width", async () => {
    vi.mocked(ensureWaveformWindow).mockResolvedValue({
      peaksPerSecond: 125,
      startPeak: 0,
      min: new Float32Array(1000),
      max: new Float32Array(1000),
      rms: new Float32Array(1000),
    });

    const { getAllByTestId, getByTestId } = render(
      <TimelineWaveform
        mediaId="m"
        srcInUs={0}
        srcOutUs={600_000_000}
        layerWidthPx={200000}
        layerHeightPx={40}
        colorHint="#123"
        enabled
        pxPerSec={800}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("timeline-waveform").getAttribute("data-state")).toBe(
        "ready",
      );
    });
    const tiles = getAllByTestId("timeline-waveform-tile") as HTMLCanvasElement[];
    expect(tiles.length).toBeGreaterThan(1);
    for (const c of tiles) {
      expect(c.width).toBeLessThanOrEqual(2048 * window.devicePixelRatio);
    }
  });

  it("exposes data-state=not_ready when the engine reports the source isn't ready", async () => {
    vi.mocked(ensureWaveformWindow).mockResolvedValueOnce("not_ready");

    const { getByTestId } = render(
      <TimelineWaveform
        mediaId="m"
        srcInUs={0}
        srcOutUs={1_000_000}
        layerWidthPx={100}
        layerHeightPx={24}
        colorHint="#123"
        enabled
        pxPerSec={80}
      />,
    );

    const wrapper = getByTestId("timeline-waveform");
    await waitFor(() => {
      expect(wrapper.getAttribute("data-state")).toBe("not_ready");
    });
  });

  it("scales tile canvases by devicePixelRatio", async () => {
    const originalDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    try {
      vi.mocked(ensureWaveformWindow).mockResolvedValue({
        peaksPerSecond: 1000,
        startPeak: 0,
        min: new Float32Array([-0.5, -0.7]),
        max: new Float32Array([0.5, 0.7]),
        rms: new Float32Array([0.2, 0.3]),
      });

      const { getByTestId, getAllByTestId } = render(
        <TimelineWaveform
          mediaId="m"
          srcInUs={0}
          srcOutUs={2_000_000}
          layerWidthPx={200}
          layerHeightPx={40}
          colorHint="#123"
          enabled
          pxPerSec={80}
        />,
      );

      await waitFor(() => {
        expect(getByTestId("timeline-waveform").getAttribute("data-state")).toBe(
          "ready",
        );
      });

      const tiles = getAllByTestId("timeline-waveform-tile") as HTMLCanvasElement[];
      expect(tiles.length).toBe(1);
      for (const tile of tiles) {
        expect(tile.width).toBe(Math.round(200 * 2));
      }
      expect(fakeContext.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    } finally {
      if (originalDpr) {
        Object.defineProperty(window, "devicePixelRatio", originalDpr);
      } else {
        Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
      }
    }
  });

  it("gates data-state=ready on BOTH stereo channel windows resolving", async () => {
    vi.mocked(getWaveformChannelCount).mockResolvedValue(2);
    vi.mocked(ensureWaveformWindow).mockImplementation(async (_mediaId, channel) => ({
      peaksPerSecond: 1000,
      startPeak: 0,
      min: new Float32Array(channel === 0 ? [-0.5, -0.6] : [-0.3, -0.4]),
      max: new Float32Array(channel === 0 ? [0.5, 0.6] : [0.3, 0.4]),
      rms: new Float32Array(channel === 0 ? [0.2, 0.25] : [0.1, 0.15]),
    }));

    const { getByTestId } = render(
      <TimelineWaveform
        mediaId="stereo-1"
        srcInUs={0}
        srcOutUs={2_000_000}
        layerWidthPx={200}
        layerHeightPx={40}
        colorHint="#123"
        enabled
        pxPerSec={80}
      />,
    );

    await waitFor(() => {
      expect(getByTestId("timeline-waveform").getAttribute("data-state")).toBe(
        "ready",
      );
    });
    expect(ensureWaveformWindow).toHaveBeenCalledWith("stereo-1", 0, 0, 2_000_000, 80);
    expect(ensureWaveformWindow).toHaveBeenCalledWith("stereo-1", 1, 0, 2_000_000, 80);
  });

  it("does not query the engine while disabled", () => {
    const { getByTestId } = render(
      <TimelineWaveform
        mediaId="wide-media"
        srcInUs={0}
        srcOutUs={1_000_000}
        layerWidthPx={20_000}
        layerHeightPx={24}
        colorHint="#446688"
        enabled={false}
        pxPerSec={80}
      />,
    );

    expect(getByTestId("timeline-waveform").getAttribute("data-state")).toBe(
      "disabled",
    );
    expect(ensureWaveformWindow).not.toHaveBeenCalled();
    expect(getWaveformChannelCount).not.toHaveBeenCalled();
  });

  describe("stale-while-revalidate zoom + DPR redraw", () => {
    const readyWindow: WaveformWindow = {
      peaksPerSecond: 1000,
      startPeak: 0,
      min: new Float32Array([-0.5, -0.7]),
      max: new Float32Array([0.5, 0.7]),
      rms: new Float32Array([0.2, 0.3]),
    };

    it("keeps the stale window on a pxPerSec change and re-fetches once after the debounce", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(ensureWaveformWindow).mockResolvedValue(readyWindow);

        const { getByTestId, rerender } = render(
          <TimelineWaveform
            mediaId="m"
            srcInUs={0}
            srcOutUs={2_000_000}
            layerWidthPx={200}
            layerHeightPx={40}
            colorHint="#123"
            enabled
            pxPerSec={80}
          />,
        );
        // Flush the immediate mount fetch (no timer involved) to reach ready.
        await flushMicrotasks();
        const wrapper = getByTestId("timeline-waveform");
        expect(wrapper.getAttribute("data-state")).toBe("ready");
        expect(ensureWaveformWindow).toHaveBeenCalledTimes(1);

        rerender(
          <TimelineWaveform
            mediaId="m"
            srcInUs={0}
            srcOutUs={2_000_000}
            layerWidthPx={200}
            layerHeightPx={40}
            colorHint="#123"
            enabled
            pxPerSec={160}
          />,
        );
        // Immediately after the prop change: still "ready" (stale window
        // kept) and no new fetch has fired yet.
        expect(wrapper.getAttribute("data-state")).toBe("ready");
        expect(ensureWaveformWindow).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(WAVEFORM_REFETCH_DEBOUNCE_MS - 1);
        expect(ensureWaveformWindow).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(ensureWaveformWindow).toHaveBeenCalledTimes(2);
        expect(ensureWaveformWindow).toHaveBeenLastCalledWith("m", 0, 0, 2_000_000, 160);
        expect(wrapper.getAttribute("data-state")).toBe("ready");
      } finally {
        vi.useRealTimers();
      }
    });

    it("coalesces rapid pxPerSec churn into a single post-debounce re-fetch", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(ensureWaveformWindow).mockResolvedValue(readyWindow);

        const { rerender } = render(
          <TimelineWaveform
            mediaId="m"
            srcInUs={0}
            srcOutUs={2_000_000}
            layerWidthPx={200}
            layerHeightPx={40}
            colorHint="#123"
            enabled
            pxPerSec={80}
          />,
        );
        await flushMicrotasks();
        expect(ensureWaveformWindow).toHaveBeenCalledTimes(1);

        rerender(
          <TimelineWaveform
            mediaId="m"
            srcInUs={0}
            srcOutUs={2_000_000}
            layerWidthPx={200}
            layerHeightPx={40}
            colorHint="#123"
            enabled
            pxPerSec={160}
          />,
        );
        await vi.advanceTimersByTimeAsync(50);
        expect(ensureWaveformWindow).toHaveBeenCalledTimes(1);

        rerender(
          <TimelineWaveform
            mediaId="m"
            srcInUs={0}
            srcOutUs={2_000_000}
            layerWidthPx={200}
            layerHeightPx={40}
            colorHint="#123"
            enabled
            pxPerSec={240}
          />,
        );
        // The first pxPerSec=160 timer must have been cancelled by this
        // second churn, not merely raced.
        await vi.advanceTimersByTimeAsync(50);
        expect(ensureWaveformWindow).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(WAVEFORM_REFETCH_DEBOUNCE_MS);
        await flushMicrotasks();
        expect(ensureWaveformWindow).toHaveBeenCalledTimes(2);
        expect(ensureWaveformWindow).toHaveBeenLastCalledWith("m", 0, 0, 2_000_000, 240);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fetches immediately and drops the stale window on a mediaId change", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(ensureWaveformWindow).mockResolvedValue(readyWindow);

        const { getByTestId, rerender } = render(
          <TimelineWaveform
            mediaId="media-a"
            srcInUs={0}
            srcOutUs={2_000_000}
            layerWidthPx={200}
            layerHeightPx={40}
            colorHint="#123"
            enabled
            pxPerSec={80}
          />,
        );
        await flushMicrotasks();
        const wrapper = getByTestId("timeline-waveform");
        expect(wrapper.getAttribute("data-state")).toBe("ready");
        expect(ensureWaveformWindow).toHaveBeenCalledTimes(1);

        vi.mocked(ensureWaveformWindow).mockClear();
        // A different media never resolves in this assertion window — the
        // stale window from "media-a" must not keep showing "ready".
        vi.mocked(ensureWaveformWindow).mockImplementation(() => new Promise(() => {}));

        rerender(
          <TimelineWaveform
            mediaId="media-b"
            srcInUs={0}
            srcOutUs={2_000_000}
            layerWidthPx={200}
            layerHeightPx={40}
            colorHint="#123"
            enabled
            pxPerSec={80}
          />,
        );
        // The stale window is dropped synchronously (no window at all until
        // media-b resolves) before any timer or microtask has to run.
        expect(wrapper.getAttribute("data-state")).not.toBe("ready");
        // Called without advancing any timers: mediaId changes are immediate.
        await flushMicrotasks();
        expect(ensureWaveformWindow).toHaveBeenCalledWith("media-b", 0, 0, 2_000_000, 80);
        expect(wrapper.getAttribute("data-state")).not.toBe("ready");
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders without crashing when window.matchMedia is unavailable", () => {
      expect(window.matchMedia).toBeUndefined();
      const { getByTestId } = render(
        <TimelineWaveform
          mediaId="m"
          srcInUs={0}
          srcOutUs={1_000_000}
          layerWidthPx={100}
          layerHeightPx={24}
          colorHint="#123"
          enabled
          pxPerSec={80}
        />,
      );
      expect(getByTestId("timeline-waveform")).toBeTruthy();
    });

    it("re-arms the DPR change listener with a fresh matchMedia query after each firing", async () => {
      const queries: string[] = [];
      const listenersByQuery = new Map<string, Set<() => void>>();
      const fakeMatchMedia = vi.fn((query: string) => {
        queries.push(query);
        const listeners = new Set<() => void>();
        listenersByQuery.set(query, listeners);
        return {
          matches: true,
          media: query,
          addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
          removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
        } as unknown as MediaQueryList;
      });
      const original = window.matchMedia;
      Object.defineProperty(window, "matchMedia", { value: fakeMatchMedia, configurable: true });

      try {
        vi.mocked(ensureWaveformWindow).mockResolvedValue(readyWindow);
        render(
          <TimelineWaveform
            mediaId="m"
            srcInUs={0}
            srcOutUs={2_000_000}
            layerWidthPx={200}
            layerHeightPx={40}
            colorHint="#123"
            enabled
            pxPerSec={80}
          />,
        );
        await waitFor(() => expect(queries.length).toBe(1));
        const firstQuery = queries[0]!;
        // Capture the Set object itself: the re-arm must create a new query
        // string built from the current window.devicePixelRatio, not reuse the
        // stale query.
        const firstListenerSet = listenersByQuery.get(firstQuery)!;

        // Override devicePixelRatio before firing the listener.
        const originalDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
        Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
        try {
          // Fire the listener as if the dpr just changed.
          for (const cb of firstListenerSet) cb();

          await waitFor(() => expect(queries.length).toBe(2));
          const secondQuery = queries[1]!;
          // The re-armed query must be a DIFFERENT string built from the NEW DPR.
          expect(secondQuery).not.toBe(firstQuery);
          expect(secondQuery).toContain("3dppx");
          // The old listener must have been torn down (re-arm, not accumulate).
          expect(firstListenerSet.size).toBe(0);
        } finally {
          if (originalDpr) {
            Object.defineProperty(window, "devicePixelRatio", originalDpr);
          } else {
            Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
          }
        }
      } finally {
        if (original) {
          Object.defineProperty(window, "matchMedia", { value: original, configurable: true });
        } else {
          Reflect.deleteProperty(window, "matchMedia");
        }
      }
    });
  });
});
