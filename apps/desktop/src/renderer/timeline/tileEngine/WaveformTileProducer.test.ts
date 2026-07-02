import { describe, it, expect, vi } from "vitest";
import {
  chooseLevel,
  tileRangeForWindow,
  TILE_PEAKS,
  WAVEFORM_KIND,
  registerWaveformProducer,
  ensureWaveformWindow,
  getWaveformChannelCount,
} from "./WaveformTileProducer";
import { TileEngine } from "./TileEngine";
import { getWaveformLevels, getWaveformTile } from "../../ipc";

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../ipc", () => ({
  MEDIA_JOB_EVENTS: {
    started: "media:job_started",
    complete: "media:job_complete",
    error: "media:job_error",
  },
  getWaveformLevels: vi.fn(),
  getWaveformTile: vi.fn(),
}));

describe("chooseLevel", () => {
  const levels = [
    { level: 0, peaksPerSecond: 1000, peakCount: 60000 },
    { level: 1, peaksPerSecond: 500, peakCount: 30000 },
    { level: 2, peaksPerSecond: 250, peakCount: 15000 },
    { level: 3, peaksPerSecond: 125, peakCount: 7500 },
  ];
  it("picks the coarsest level still >= desired density", () => {
    // pxPerSec 80 -> desired ≈ 80/1.5 ≈ 53 pps -> coarsest >= 53 is 125 (idx 3)
    expect(chooseLevel(levels, 80)).toBe(3);
  });
  it("picks a finer level as zoom increases", () => {
    // pxPerSec 800 -> desired ≈ 533 pps -> coarsest >= 533 is 1000 (idx 0)
    expect(chooseLevel(levels, 800)).toBe(0);
    // pxPerSec 400 -> desired ≈ 266 -> coarsest >= 266 is 500 (idx 1)
    expect(chooseLevel(levels, 400)).toBe(1);
  });
  it("clamps to finest when desired exceeds all levels", () => {
    expect(chooseLevel(levels, 100000)).toBe(0);
  });
});

describe("tileRangeForWindow", () => {
  it("maps a src window to peak indices and tile indices", () => {
    // 1000 pps, window [1.0s, 3.0s) -> peaks [1000, 3000)
    const r = tileRangeForWindow(1000, 1_000_000, 3_000_000);
    expect(r.startPeak).toBe(1000);
    expect(r.endPeak).toBe(3000);
    expect(r.firstTile).toBe(Math.floor(1000 / TILE_PEAKS)); // 0
    expect(r.lastTile).toBe(Math.floor((3000 - 1) / TILE_PEAKS)); // 1
  });
});

// `registerWaveformProducer` has a module-level "only the first call ever
// registers" guard (real production behavior: one producer per engine, and
// production code only ever builds one `tileEngine`). All tests below that
// need a registered producer therefore share this single engine + single
// registration call, keyed apart by distinct mediaIds.
describe("waveform tile producer (shared engine)", () => {
  const engine = new TileEngine(1024 * 1024);
  registerWaveformProducer(engine);

  it("re-fetches the level table after invalidateMedia (regenerated waveform)", async () => {
    vi.mocked(getWaveformLevels).mockResolvedValue({
      channels: 2,
      levels: [{ level: 0, peaksPerSecond: 1000, peakCount: 10_000 }],
    });
    vi.mocked(getWaveformTile).mockResolvedValue({ peaksPerSecond: 1000, min: [], max: [], rms: [] });

    await ensureWaveformWindow("m1", 0, 0, 1_000_000, 100, engine);
    expect(vi.mocked(getWaveformLevels)).toHaveBeenCalledTimes(1);

    // Waveform regenerated (media:job_complete) -> tile slots are dropped; the
    // level table must be re-fetched too, not served from the pinned cache.
    engine.invalidateMedia("m1", WAVEFORM_KIND);
    await ensureWaveformWindow("m1", 0, 0, 1_000_000, 100, engine);
    expect(vi.mocked(getWaveformLevels)).toHaveBeenCalledTimes(2);
  });

  it("assembles the rms slice for [startPeak, endPeak) from the covering tile", async () => {
    vi.mocked(getWaveformLevels).mockResolvedValue({
      channels: 1,
      levels: [{ level: 0, peaksPerSecond: 1000, peakCount: 100_000 }],
    });
    // 0.5 and 0.25 are exactly representable in float32, so the assembled
    // Float32Array round-trips without precision drift against the literals
    // in the assertion below.
    const rms = new Array(TILE_PEAKS).fill(0);
    rms[1500] = 0.5;
    rms[1501] = 0.25;
    vi.mocked(getWaveformTile).mockResolvedValue({
      peaksPerSecond: 1000,
      min: new Array(TILE_PEAKS).fill(-1),
      max: new Array(TILE_PEAKS).fill(1),
      rms,
    });

    const mediaId = "m-rms";
    // 1000 pps, window [1.5s, 1.502s) -> peaks [1500, 1502): a nonzero
    // startPeak so the slice math (globalPeak - firstTile*TILE_PEAKS) is
    // actually exercised, not just the degenerate startPeak === 0 case.
    const first = await ensureWaveformWindow(mediaId, 0, 1_500_000, 1_502_000, 800, engine);
    expect(first).toBe("pending");

    // Flush the mocked async fetch chain (fetch's internal await plus the
    // engine's own `.then`) past a macrotask boundary so the tile lands.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await ensureWaveformWindow(mediaId, 0, 1_500_000, 1_502_000, 800, engine);
    if (second === "pending" || second === "not_ready") {
      throw new Error(`expected a ready window, got ${second}`);
    }
    expect(second.startPeak).toBe(1500);
    expect(Array.from(second.rms)).toEqual([0.5, 0.25]);
  });
});

describe("getWaveformChannelCount", () => {
  it("resolves the channel count from the levels response, served from the shared cache", async () => {
    vi.mocked(getWaveformLevels).mockResolvedValue({
      channels: 3,
      levels: [{ level: 0, peaksPerSecond: 1000, peakCount: 1000 }],
    });
    // The mock's call history is cumulative across this whole test file (no
    // global mock-reset config), so clear it to isolate this test's own count.
    vi.mocked(getWaveformLevels).mockClear();

    const mediaId = "m-channels";
    const [a, b] = await Promise.all([
      getWaveformChannelCount(mediaId),
      getWaveformChannelCount(mediaId),
    ]);
    expect(a).toBe(3);
    expect(b).toBe(3);
    expect(vi.mocked(getWaveformLevels)).toHaveBeenCalledTimes(1);
  });
});
