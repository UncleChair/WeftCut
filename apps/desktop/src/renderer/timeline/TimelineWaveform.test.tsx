// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineWaveform } from "./TimelineWaveform";
import { ensureWaveformWindow } from "./tileEngine/WaveformTileProducer";

vi.mock("./tileEngine/WaveformTileProducer", () => ({
  registerWaveformProducer: vi.fn(),
  ensureWaveformWindow: vi.fn(async () => "pending" as const),
}));

vi.mock("./tileEngine/TileEngine", () => ({
  tileEngine: { subscribe: vi.fn(() => () => {}) },
}));

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
  });
});
