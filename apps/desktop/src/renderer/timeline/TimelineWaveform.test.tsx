// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WaveformPeaks } from "../ipc";
import { TimelineWaveform } from "./TimelineWaveform";

const mocks = vi.hoisted(() => ({
  getWaveformPeaks: vi.fn(),
  jobCompleteCallbacks: [] as Array<
    (event: { payload?: { media_id: string; kind: string } }) => void
  >,
  listen: vi.fn(),
}));

vi.mock("@/bridge/events", () => ({
  listen: mocks.listen,
}));

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    getWaveformPeaks: mocks.getWaveformPeaks,
  };
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
    fillStyle: string;
    lineWidth: number;
    strokeStyle: string;
  };

  beforeEach(() => {
    mocks.getWaveformPeaks.mockReset();
    mocks.getWaveformPeaks.mockRejectedValue("not_ready");
    mocks.jobCompleteCallbacks.length = 0;
    mocks.listen.mockClear();
    mocks.listen.mockImplementation(async (_event, callback) => {
      mocks.jobCompleteCallbacks.push(callback);
      return () => {};
    });
    fakeContext = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      stroke: vi.fn(),
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

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("ignores stale waveform errors after a job-complete refetch succeeds", async () => {
    const first = deferred<WaveformPeaks>();
    const second = deferred<WaveformPeaks>();
    mocks.getWaveformPeaks
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { getByTestId } = render(
      <TimelineWaveform
        mediaId="waveform-race"
        srcInUs={0}
        srcOutUs={1_000_000}
        layerWidthPx={100}
        layerHeightPx={24}
        colorHint="#446688"
        enabled
      />,
    );

    await waitFor(() => {
      expect(mocks.getWaveformPeaks).toHaveBeenCalledTimes(1);
      expect(mocks.jobCompleteCallbacks.length).toBeGreaterThan(0);
    });

    act(() => {
      mocks.jobCompleteCallbacks.at(-1)?.({
        payload: { media_id: "waveform-race", kind: "waveform" },
      });
    });

    await waitFor(() => {
      expect(mocks.getWaveformPeaks).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      second.resolve({ peaks: [0.4, 0.2, 0.7], peaks_per_second: 10 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByTestId("timeline-waveform").getAttribute("data-state")).toBe(
        "ready",
      );
    });

    await act(async () => {
      first.reject("not_ready");
      await Promise.resolve();
    });

    expect(getByTestId("timeline-waveform").getAttribute("data-state")).toBe(
      "ready",
    );
  });

  it("renders the stable fallback when peaks are not ready", async () => {
    const { getByTestId } = render(
      <TimelineWaveform
        mediaId="media-1"
        srcInUs={0}
        srcOutUs={1_000_000}
        layerWidthPx={100}
        layerHeightPx={24}
        colorHint="#446688"
        enabled
      />,
    );

    await waitFor(() => {
      expect(mocks.getWaveformPeaks).toHaveBeenCalledWith("media-1");
    });
    const canvas = getByTestId("timeline-waveform");
    await waitFor(() => {
      expect(canvas.getAttribute("data-state")).toBe("not_ready");
    });
    expect(fakeContext.moveTo).toHaveBeenCalledWith(0, 12);
    expect(fakeContext.lineTo).toHaveBeenCalledWith(100, 12);
    expect(fakeContext.stroke).toHaveBeenCalled();
  });

  it("caps the canvas backing width for very long clips", () => {
    const { getByTestId } = render(
      <TimelineWaveform
        mediaId="wide-media"
        srcInUs={0}
        srcOutUs={1_000_000}
        layerWidthPx={20_000}
        layerHeightPx={24}
        colorHint="#446688"
        enabled={false}
      />,
    );

    expect(getByTestId("timeline-waveform").getAttribute("width")).toBe(
      "4096",
    );
    expect(fakeContext.lineTo).toHaveBeenCalledWith(4096, 12);
  });
});
