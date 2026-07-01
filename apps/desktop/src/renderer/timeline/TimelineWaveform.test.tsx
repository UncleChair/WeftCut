// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineWaveform } from "./TimelineWaveform";

const mocks = vi.hoisted(() => ({
  getWaveformPeaks: vi.fn(),
  listen: vi.fn(async () => () => {}),
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

  beforeEach(() => {
    mocks.getWaveformPeaks.mockReset();
    mocks.getWaveformPeaks.mockRejectedValue("not_ready");
    mocks.listen.mockClear();
    const fakeContext = {
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
  });
});
