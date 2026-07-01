// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerSummary } from "../ipc";
import { LAYER_PREVIEW_MIN_PX } from "./geometry";
import { TimelineVisualPreview } from "./TimelineVisualPreview";

const mocks = vi.hoisted(() => ({
  getMediaThumbnails: vi.fn(),
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
    getMediaThumbnails: mocks.getMediaThumbnails,
  };
});

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
    opacity: staticNum(1),
    speed: 1,
    flip_h: false,
    flip_v: false,
    fade_in_us: 0,
    fade_out_us: 0,
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
    mocks.getMediaThumbnails.mockReset();
    mocks.getMediaThumbnails.mockRejectedValue("not_ready");
    mocks.listen.mockClear();
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
      />,
    );

    await waitFor(() => {
      expect(observedElement).not.toBeNull();
    });
    expect(observerOptions).toMatchObject({
      root: null,
      rootMargin: "256px 512px",
    });
    expect(mocks.getMediaThumbnails).not.toHaveBeenCalled();

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
      expect(mocks.getMediaThumbnails).toHaveBeenCalledWith("media-1");
    });
  });

  it("requests video thumbnails immediately when IntersectionObserver is unavailable and width allows", async () => {
    delete intersectionObserverGlobal.IntersectionObserver;

    render(
      <TimelineVisualPreview
        layer={videoLayer}
        layerWidthPx={160}
        layerHeightPx={32}
      />,
    );

    await waitFor(() => {
      expect(mocks.getMediaThumbnails).toHaveBeenCalledWith("media-1");
    });
  });

  it("renders no preview and makes no thumbnail request below the preview width threshold", () => {
    const { queryByTestId } = render(
      <TimelineVisualPreview
        layer={videoLayer}
        layerWidthPx={LAYER_PREVIEW_MIN_PX - 1}
        layerHeightPx={32}
      />,
    );

    expect(queryByTestId("timeline-visual-preview")).toBeNull();
    expect(mocks.getMediaThumbnails).not.toHaveBeenCalled();
  });
});
