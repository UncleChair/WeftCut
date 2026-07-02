// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILMSTRIP_KIND, filmstripTileKey } from "./tileEngine/FilmstripTileProducer";
import { tileEngine } from "./tileEngine/TileEngine";
import {
  FILMSTRIP_FETCH_DEBOUNCE_MS,
  TimelineFilmstrip,
  tileDrawRect,
} from "./TimelineFilmstrip";

const mocks = vi.hoisted(() => ({
  getFilmstripTile: vi.fn(),
}));

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));

vi.mock("@/bridge/ipc", () => ({
  convertFileSrc: (path: string) => `weftcut-media://test/${path}`,
}));

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    getFilmstripTile: mocks.getFilmstripTile,
  };
});

// The producer's fetch pipeline reads the ambient `fetch`/`createImageBitmap`
// globals directly (not injected) — stub them once for the whole file, as in
// FilmstripTileProducer.test.ts.
const fetchMock = vi.fn(async () => ({ blob: async () => new Blob() }) as unknown as Response);
const createImageBitmapMock = vi.fn(
  async () => ({ width: 8, height: 8, close: vi.fn() }) as unknown as ImageBitmap,
);
vi.stubGlobal("fetch", fetchMock);
vi.stubGlobal("createImageBitmap", createImageBitmapMock);

// Fixed geometry shared by most tests: layerHeightPx=54 with the default
// 16:9 fallback gives thumbWidthPx=96 (54 * 16/9), and pxPerSec=130 keeps
// chooseFilmstripLod(96, 130) at lod 2 (spacing 1_000_000us) — hand-verified
// against FilmstripTileProducer's own chooseFilmstripLod/visibleTileRange
// fixtures. srcInUs/srcOutUs=[2s,5s) then resolves to visible indices
// [2, 3, 4] at that lod.
const GEOMETRY = {
  srcInUs: 2_000_000,
  srcOutUs: 5_000_000,
  layerWidthPx: 300,
  layerHeightPx: 54,
  pxPerSec: 130,
  colorHint: "#446688",
  enabled: true,
};

function renderFilmstrip(mediaId: string, overrides: Partial<typeof GEOMETRY> = {}) {
  return render(
    <TimelineFilmstrip mediaId={mediaId} {...GEOMETRY} {...overrides} />,
  );
}

beforeEach(() => {
  mocks.getFilmstripTile.mockReset();
  mocks.getFilmstripTile.mockResolvedValue({ path: "tile.jpg", widthPx: 96, heightPx: 54 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("tileDrawRect", () => {
  it("positions a tile at its true source time at natural aspect", () => {
    // clip 500px wide over src [2s, 12s); tile at t=7s, bitmap 455x256, lane 54px:
    // x = (7-2)/10 * 500 = 250; h = 54; w = 54 * 455/256 ~= 95.98
    const r = tileDrawRect(7_000_000, 2_000_000, 12_000_000, 500, 54, 455, 256);
    expect(r.x).toBeCloseTo(250);
    expect(r.h).toBe(54);
    expect(r.w).toBeCloseTo((54 * 455) / 256);
    expect(tileDrawRect(0, 5_000_000, 5_000_000, 500, 54, 455, 256)).toEqual({ x: 0, w: 0, h: 0 });
  });
});

describe("TimelineFilmstrip", () => {
  it("renders disabled without touching the engine", () => {
    const { getByTestId, queryAllByTestId } = renderFilmstrip("m-disabled", { enabled: false });
    expect(getByTestId("timeline-filmstrip").getAttribute("data-state")).toBe("disabled");
    expect(queryAllByTestId("timeline-filmstrip-tile")).toHaveLength(0);
    expect(mocks.getFilmstripTile).not.toHaveBeenCalled();
  });

  it("requests only the target lod's visible tiles, immediately on mount", () => {
    const requestSpy = vi.spyOn(tileEngine, "request");
    renderFilmstrip("m-mount");
    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(requestSpy.mock.calls.map((c) => c[0])).toEqual([
      filmstripTileKey("m-mount", 2, 2),
      filmstripTileKey("m-mount", 2, 3),
      filmstripTileKey("m-mount", 2, 4),
    ]);
  });

  it("debounces param-churn requests and keeps drawing (no placeholder flash)", async () => {
    const mediaId = "m-debounce";
    const requestSpy = vi.spyOn(tileEngine, "request");
    const { getByTestId, rerender } = renderFilmstrip(mediaId);
    expect(requestSpy).toHaveBeenCalledTimes(3);

    // Drive index 3 (lod 2) to ready so the component has already painted.
    await waitFor(() => {
      expect(tileEngine.get(filmstripTileKey(mediaId, 2, 3))?.state).toBe("ready");
    });
    await waitFor(() => {
      expect(getByTestId("timeline-filmstrip").getAttribute("data-state")).toBe("ready");
    });
    const callsBeforeChurn = requestSpy.mock.calls.length;

    vi.useFakeTimers();
    try {
      // Two rapid geometry changes; the second (pxPerSec=70) widens the
      // request reach enough to bring index 1 into view, but the already-
      // ready index 3 stays inside both windows, so "ready" never drops.
      rerender(<TimelineFilmstrip mediaId={mediaId} {...GEOMETRY} pxPerSec={110} />);
      rerender(<TimelineFilmstrip mediaId={mediaId} {...GEOMETRY} pxPerSec={70} />);

      expect(requestSpy.mock.calls.length).toBe(callsBeforeChurn);
      expect(getByTestId("timeline-filmstrip").getAttribute("data-state")).toBe("ready");

      act(() => {
        vi.advanceTimersByTime(FILMSTRIP_FETCH_DEBOUNCE_MS);
      });

      expect(requestSpy.mock.calls.length).toBe(callsBeforeChurn + 1);
      expect(requestSpy).toHaveBeenLastCalledWith(filmstripTileKey(mediaId, 2, 1));
      expect(getByTestId("timeline-filmstrip").getAttribute("data-state")).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-runs the pass immediately on an engine subscribe notification", () => {
    // Uses the default (quickly-resolving) mock from beforeEach rather than a
    // permanently-pending one: FilmstripTileProducer's concurrency gate
    // (FILMSTRIP_MAX_CONCURRENT_FETCHES) is a module-level singleton, and a
    // fetch that never settles would never release its slot, starving every
    // later test in this file of in-flight capacity.
    const mediaId = "m-subscribe";
    const requestSpy = vi.spyOn(tileEngine, "request");
    renderFilmstrip(mediaId);
    expect(requestSpy).toHaveBeenCalledTimes(3);

    act(() => {
      tileEngine.invalidateMedia(mediaId, FILMSTRIP_KIND);
    });

    // No timer advance, no waitFor: invalidateMedia's notify is synchronous.
    expect(requestSpy.mock.calls.length).toBe(6);
    expect(requestSpy.mock.calls.slice(3)).toEqual([
      [filmstripTileKey(mediaId, 2, 2)],
      [filmstripTileKey(mediaId, 2, 3)],
      [filmstripTileKey(mediaId, 2, 4)],
    ]);
  });

  it("keeps painting across a zoom in EITHER direction before the debounced fetch lands", async () => {
    const mediaId = "m-zoom-bidi";
    const { getByTestId, rerender } = renderFilmstrip(mediaId); // pxPerSec 130 -> target lod 2
    await waitFor(() => {
      expect(tileEngine.get(filmstripTileKey(mediaId, 2, 3))?.state).toBe("ready");
    });
    await waitFor(() => {
      expect(getByTestId("timeline-filmstrip").getAttribute("data-state")).toBe("ready");
    });

    vi.useFakeTimers();
    try {
      // Zoom OUT: pxPerSec 48 raises the target to lod 3 (thumb 96px ->
      // desired spacing 2_000_000us = exactly lod 3), making the ready lod-2
      // tiles FINER than target. The debounce timer has not advanced, so no
      // coarser tile exists yet — only the finer backfill can keep the strip
      // lit, and data-state must not blank to "pending".
      rerender(<TimelineFilmstrip mediaId={mediaId} {...GEOMETRY} pxPerSec={48} />);
      expect(getByTestId("timeline-filmstrip").getAttribute("data-state")).toBe("ready");

      // Zoom IN: pxPerSec 260 lowers the target to lod 1; the same lod-2
      // tiles are now COARSER than target and the coarse fallback keeps them
      // painting (inverse direction of the same rule).
      rerender(<TimelineFilmstrip mediaId={mediaId} {...GEOMETRY} pxPerSec={260} />);
      expect(getByTestId("timeline-filmstrip").getAttribute("data-state")).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports not_ready while the proxy-wait rule holds", async () => {
    const mediaId = "m-not-ready";
    mocks.getFilmstripTile.mockRejectedValue("not_ready");
    const { getByTestId } = renderFilmstrip(mediaId);

    await waitFor(() => {
      expect(getByTestId("timeline-filmstrip").getAttribute("data-state")).toBe("not_ready");
    });

    mocks.getFilmstripTile.mockReset();
    mocks.getFilmstripTile.mockResolvedValue({ path: "ready.jpg", widthPx: 96, heightPx: 54 });
    act(() => {
      tileEngine.invalidateMedia(mediaId, FILMSTRIP_KIND);
    });

    await waitFor(() => {
      expect(getByTestId("timeline-filmstrip").getAttribute("data-state")).toBe("ready");
    });
  });
});
