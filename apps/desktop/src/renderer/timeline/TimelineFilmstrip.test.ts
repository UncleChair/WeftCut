// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineThumbnailManifest } from "../ipc";
import {
  TimelineFilmstrip,
  selectFilmstripFrames,
  type TimelineFilmstripFrame,
} from "./TimelineFilmstrip";

const mocks = vi.hoisted(() => ({
  getMediaThumbnails: vi.fn(),
  jobCompleteCallbacks: [] as Array<
    (event: { payload?: { media_id: string; kind: string } }) => void
  >,
  listen: vi.fn(),
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

const frames: TimelineFilmstripFrame[] = Array.from({ length: 10 }, (_, index) => ({
  index,
  tUs: index * 1_000_000,
  path: `${index}.jpg`,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function manifestWithPath(path: string): TimelineThumbnailManifest {
  return {
    frames: [{ index: 0, tUs: 0, path }],
  };
}

beforeEach(() => {
  mocks.getMediaThumbnails.mockReset();
  mocks.jobCompleteCallbacks.length = 0;
  mocks.listen.mockReset();
  mocks.listen.mockImplementation(async (_event, callback) => {
    mocks.jobCompleteCallbacks.push(callback);
    return () => {};
  });
});

afterEach(cleanup);

describe("selectFilmstripFrames", () => {
  it("uses frames from the layer source window", () => {
    expect(
      selectFilmstripFrames(frames, 3_000_000, 7_000_000).map((frame) => frame.index),
    ).toEqual([3, 4, 5, 6]);
  });

  it("uses the nearest representative frame for source windows between cached frames", () => {
    expect(
      selectFilmstripFrames(frames, 3_250_000, 3_750_000).map((frame) => frame.index),
    ).toEqual([3]);
  });
});

describe("TimelineFilmstrip", () => {
  it("ignores stale thumbnail responses after a job-complete refetch starts", async () => {
    const first = deferred<TimelineThumbnailManifest>();
    const second = deferred<TimelineThumbnailManifest>();
    mocks.getMediaThumbnails
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { getByTestId } = render(
      createElement(TimelineFilmstrip, {
        mediaId: "filmstrip-race",
        srcInUs: 0,
        srcOutUs: 1_000_000,
        layerWidthPx: 100,
        colorHint: "#446688",
        enabled: true,
      }),
    );

    await waitFor(() => {
      expect(mocks.getMediaThumbnails).toHaveBeenCalledTimes(1);
      expect(mocks.jobCompleteCallbacks.length).toBeGreaterThan(0);
    });

    act(() => {
      mocks.jobCompleteCallbacks.at(-1)?.({
        payload: { media_id: "filmstrip-race", kind: "thumbnails" },
      });
    });

    await waitFor(() => {
      expect(mocks.getMediaThumbnails).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      second.resolve(manifestWithPath("new.jpg"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByTestId("timeline-filmstrip").getAttribute("data-state")).toBe(
        "ready",
      );
      expect(getByTestId("timeline-filmstrip").innerHTML).toContain("new.jpg");
    });

    await act(async () => {
      first.resolve(manifestWithPath("old.jpg"));
      await Promise.resolve();
    });

    expect(getByTestId("timeline-filmstrip").innerHTML).toContain("new.jpg");
    expect(getByTestId("timeline-filmstrip").innerHTML).not.toContain(
      "old.jpg",
    );
  });
});
