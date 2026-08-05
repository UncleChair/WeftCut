// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerSummary } from "../ipc";
import { LAYER_PREVIEW_MIN_PX } from "./geometry";
import { FILMSTRIP_KIND } from "./tileEngine/FilmstripTileProducer";
import { tileEngine } from "./tileEngine/TileEngine";
import { TimelineVisualPreview } from "./TimelineVisualPreview";

const mocks = vi.hoisted(() => ({
  getFilmstripTile: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@/bridge/events", () => ({
  listen: mocks.listen,
}));

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

// TimelineFilmstrip's tile engine reads these globals directly (not
// injected) — stub them as in FilmstripTileProducer.test.ts / B4.
vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob() }) as unknown as Response));
vi.stubGlobal(
  "createImageBitmap",
  vi.fn(async () => ({ width: 8, height: 8, close: vi.fn() }) as unknown as ImageBitmap),
);

const staticNum = (value: number) => ({ mode: "Static" as const, value });

type MutableIntersectionObserverGlobal = typeof globalThis & {
  IntersectionObserver?: typeof globalThis.IntersectionObserver;
};

const intersectionObserverGlobal =
  globalThis as MutableIntersectionObserverGlobal;

const videoLayer: LayerSummary = {
  id: "video-1",
  label: "Video",
  t_start_us: 0,
  t_end_us: 2_000_000,
  kind: "VideoClip",
  color_hint: "#446688",
  enabled: true,
  locked: false,
  params: {
    kind: "VideoClip",
    media_id: "media-1",
    media_label: "media.mov",
    src_in_us: 0,
    src_out_us: 2_000_000,
    x: staticNum(0),
    y: staticNum(0),
    scale_x: staticNum(1),
    scale_y: staticNum(1),
    scale_linked: true,
    rotation_deg: staticNum(0),
    anchor_x: 0.5, anchor_y: 0.5,
    opacity: staticNum(1),
    speed: 1,
    flip_h: false,
    flip_v: false,
    fade_in_us: 0,
    fade_out_us: 0,
  },
  effects: [],
};

const colorLayer: LayerSummary = {
  id: "color-1",
  label: "Color",
  t_start_us: 0,
  t_end_us: 2_000_000,
  kind: "Color",
  color_hint: "#0a141e",
  enabled: true,
  locked: false,
  params: {
    kind: "Color",
    color: { mode: "Static", value: { r: 10, g: 20, b: 30, a: 1 } },
    width: 1920,
    height: 1080,
  },
  effects: [],
};

describe("TimelineVisualPreview", () => {
  let observerCallback: IntersectionObserverCallback | null = null;
  let observedElement: Element | null = null;
  let observerOptions: IntersectionObserverInit | undefined;
  let originalIntersectionObserver:
    | typeof globalThis.IntersectionObserver
    | undefined;

  beforeEach(() => {
    mocks.getFilmstripTile.mockReset();
    mocks.getFilmstripTile.mockRejectedValue("not_ready");
    mocks.listen.mockClear();
    // The tile engine is a module-level singleton, and every test here reuses
    // the same videoLayer media id — clear its filmstrip slots so a rejected
    // ("not_ready") tile from one test can't block the next test's request.
    tileEngine.invalidateMedia("media-1", FILMSTRIP_KIND);
    observerCallback = null;
    observedElement = null;
    observerOptions = undefined;
    originalIntersectionObserver =
      intersectionObserverGlobal.IntersectionObserver;
    class FakeIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "";
      readonly scrollMargin = "";
      readonly thresholds: ReadonlyArray<number> = [];
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        observerCallback = callback;
        observerOptions = options;
      }
      observe(element: Element) {
        observedElement = element;
      }
      unobserve(_element: Element) {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    intersectionObserverGlobal.IntersectionObserver = FakeIntersectionObserver;
  });

  afterEach(() => {
    cleanup();
    if (originalIntersectionObserver) {
      intersectionObserverGlobal.IntersectionObserver =
        originalIntersectionObserver;
    } else {
      delete intersectionObserverGlobal.IntersectionObserver;
    }
  });

  it("does not request video thumbnails until the preview is near the viewport", async () => {
    render(
      <TimelineVisualPreview
        layer={videoLayer}
        layerWidthPx={160}
        layerHeightPx={32}
        pxPerSec={80}
      />,
    );

    await waitFor(() => {
      expect(observedElement).not.toBeNull();
    });
    expect(observerOptions).toMatchObject({
      root: null,
      rootMargin: "256px 512px",
    });
    expect(mocks.getFilmstripTile).not.toHaveBeenCalled();

    act(() => {
      observerCallback?.(
        [
          {
            isIntersecting: true,
            intersectionRatio: 1,
            target: observedElement,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });

    // Enabling the preview mounted the filmstrip's segment canvas, which is
    // itself gated behind a per-segment IntersectionObserver — the shared
    // fake's captured callback/element now point at that observer and canvas.
    // Still nothing fetched until the segment too reports visible.
    expect(mocks.getFilmstripTile).not.toHaveBeenCalled();
    act(() => {
      observerCallback?.(
        [
          {
            isIntersecting: true,
            intersectionRatio: 1,
            target: observedElement,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });

    await waitFor(() => {
      expect(mocks.getFilmstripTile).toHaveBeenCalledWith("media-1", expect.any(Number), expect.any(Number));
    });
  });

  it("requests video thumbnails immediately when IntersectionObserver is unavailable and width allows", async () => {
    delete intersectionObserverGlobal.IntersectionObserver;

    render(
      <TimelineVisualPreview
        layer={videoLayer}
        layerWidthPx={160}
        layerHeightPx={32}
        pxPerSec={80}
      />,
    );

    await waitFor(() => {
      expect(mocks.getFilmstripTile).toHaveBeenCalledWith("media-1", expect.any(Number), expect.any(Number));
    });
  });

  it("renders no preview and makes no thumbnail request below the preview width threshold", () => {
    const { queryByTestId } = render(
      <TimelineVisualPreview
        layer={videoLayer}
        layerWidthPx={LAYER_PREVIEW_MIN_PX - 1}
        layerHeightPx={32}
        pxPerSec={80}
      />,
    );

    expect(queryByTestId("timeline-visual-preview")).toBeNull();
    expect(mocks.getFilmstripTile).not.toHaveBeenCalled();
  });

  it("uses the semantic video surface instead of the UUID color hint", () => {
    const { getByTestId } = render(
      <TimelineVisualPreview
        layer={videoLayer}
        layerWidthPx={160}
        layerHeightPx={32}
        pxPerSec={80}
      />,
    );

    expect(getByTestId("timeline-visual-preview").getAttribute("style")).toContain(
      "background-color: rgb(26, 34, 45)",
    );
  });

  it("treats color alpha as the same 0-255 channel used by the compositor", () => {
    const { getByTestId } = render(
      <TimelineVisualPreview
        layer={colorLayer}
        layerWidthPx={160}
        layerHeightPx={32}
        pxPerSec={80}
      />,
    );

    const fill = getByTestId("timeline-visual-preview").firstElementChild as HTMLElement;

    // jsdom's CSSOM serializes alpha the way browsers do: 1/255 rounds to
    // 0.004 — distinct from 0 and from a 0-1-channel misread (1.0), which is
    // all this test needs to pin.
    expect(fill.getAttribute("style")).toContain("rgba(10, 20, 30, 0.004)");
  });
});
