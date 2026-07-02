import { describe, it, expect, vi } from "vitest";
import {
  spacingUs,
  chooseFilmstripLod,
  filmstripThumbWidthPx,
  visibleTileRange,
  filmstripTileKey,
  registerFilmstripProducer,
  FILMSTRIP_KIND,
  FILMSTRIP_INVALIDATE_ON,
  FILMSTRIP_MAX_CONCURRENT_FETCHES,
  type FilmstripTileValue,
} from "./FilmstripTileProducer";
import { TileEngine, type TileProducer } from "./TileEngine";
import { getFilmstripTile, type FilmstripTile } from "../../ipc";
import { convertFileSrc } from "@/bridge/ipc";

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../ipc", () => ({
  MEDIA_JOB_EVENTS: {
    started: "media:job_started",
    complete: "media:job_complete",
    error: "media:job_error",
  },
  getFilmstripTile: vi.fn(),
}));
vi.mock("@/bridge/ipc", () => ({
  convertFileSrc: vi.fn((path: string) => `weftcut-media://test/${path}`),
}));

// The producer's fetch pipeline reads the ambient `fetch`/`createImageBitmap`
// globals directly (not injected), so stub them once for the whole file and
// steer individual calls with mockResolvedValueOnce where a test cares about
// the exact bitmap it gets back.
const fetchMock = vi.fn(async () => ({ blob: async () => new Blob() }) as unknown as Response);
const createImageBitmapMock = vi.fn(
  async () => ({ width: 8, height: 8, close: vi.fn() }) as unknown as ImageBitmap,
);
vi.stubGlobal("fetch", fetchMock);
vi.stubGlobal("createImageBitmap", createImageBitmapMock);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("spacingUs", () => {
  it("pins the spacing grid (twin: native jobs/filmstrip.rs spacing_us)", () => {
    expect(spacingUs(0)).toBe(250_000);
    expect(spacingUs(1)).toBe(500_000);
    expect(spacingUs(12)).toBe(1_024_000_000);
  });
});

describe("chooseFilmstripLod", () => {
  it("chooses the lod whose spacing best matches one thumb width of screen time", () => {
    // thumbWidth 100px at 100 px/s -> desired 1_000_000us -> log2(4) = 2
    expect(chooseFilmstripLod(100, 100)).toBe(2);
    // extreme zoom-in clamps to 0; extreme zoom-out clamps to 12
    expect(chooseFilmstripLod(100, 1_000_000)).toBe(0);
    expect(chooseFilmstripLod(100, 0.000001)).toBe(12);
  });
});

describe("filmstripThumbWidthPx", () => {
  it("computes thumb width from natural aspect with a 16/9 fallback", () => {
    expect(filmstripThumbWidthPx(54, 1920, 1080)).toBe(96);
    expect(filmstripThumbWidthPx(54, null, null)).toBe(96); // 54 * 16/9 = 96
    expect(filmstripThumbWidthPx(54, 1080, 1920)).toBeCloseTo(30.375);
  });
});

describe("visibleTileRange", () => {
  it("covers exactly the tiles whose [t, t+thumbWidthUs) intersects the src window", () => {
    // spacing 1_000_000, thumbWidth 400_000us, window [1_200_000, 3_000_000):
    // tile 1 covers [1.0s,1.4s) -> intersects; tile 3 starts at 3.0s -> excluded
    expect(visibleTileRange(1_200_000, 3_000_000, 1_000_000, 400_000, null))
      .toEqual({ first: 1, last: 2 });
    // duration cap: 2.5s source cuts the last index to 2
    expect(visibleTileRange(0, 10_000_000, 1_000_000, 400_000, 2_500_000))
      .toEqual({ first: 0, last: 2 });
    // exact-boundary: window starting exactly at a tile's right edge excludes it
    expect(visibleTileRange(1_400_000, 3_000_000, 1_000_000, 400_000, null).first).toBe(2);
  });
});

// `registerFilmstripProducer` has a module-level "only the first call ever
// registers" guard (real production behavior: one producer per engine, and
// production code only ever builds one `tileEngine`). The tests below that
// need a registered producer therefore share this single engine + single
// registration call, keyed apart by distinct mediaIds.
describe("filmstrip tile producer (shared engine)", () => {
  const engine = new TileEngine(1024 * 1024 * 1024);
  // Capture the REAL producer object handed to engine.register so the tests
  // below exercise its callbacks directly instead of re-deriving the expected
  // behavior locally (which could never catch a broken bytes/dispose wiring).
  const registerSpy = vi.spyOn(engine, "register");
  registerFilmstripProducer(engine);
  const producer = registerSpy.mock.calls[0]![0] as TileProducer<FilmstripTileValue>;

  it("registers the producer contract: kind, invalidateOn, and the bytes formula", () => {
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(producer.kind).toBe(FILMSTRIP_KIND);
    expect(producer.invalidateOn).toEqual(FILMSTRIP_INVALIDATE_ON);
    const value: FilmstripTileValue = {
      bitmap: { width: 12, height: 34 } as unknown as ImageBitmap,
      tUs: 0,
    };
    expect(producer.bytes(value)).toBe(12 * 34 * 4);
  });

  it("caps in-flight fetches at FILMSTRIP_MAX_CONCURRENT_FETCHES", async () => {
    const mediaId = "m-concurrency";
    const deferreds = Array.from({ length: 6 }, () => deferred<FilmstripTile>());
    vi.mocked(getFilmstripTile).mockReset();
    vi.mocked(getFilmstripTile).mockImplementation(
      async (_mediaId: string, _lod: number, index: number) => deferreds[index]!.promise,
    );

    const keys = Array.from({ length: 6 }, (_, index) => filmstripTileKey(mediaId, 0, index));
    for (const key of keys) engine.request(key);

    // acquireFetchSlot()'s synchronous branch still needs one microtask hop
    // before its awaiter can call getFilmstripTile; flush it before counting.
    await Promise.resolve();
    expect(vi.mocked(getFilmstripTile)).toHaveBeenCalledTimes(FILMSTRIP_MAX_CONCURRENT_FETCHES);

    // Resolve one full chain: ipc -> fetch -> createImageBitmap. Its `finally`
    // releases the slot, waking the next queued waiter.
    deferreds[0]!.resolve({ path: "tile-0.jpg", widthPx: 8, heightPx: 8 });
    await vi.waitFor(() => {
      expect(vi.mocked(getFilmstripTile)).toHaveBeenCalledTimes(FILMSTRIP_MAX_CONCURRENT_FETCHES + 1);
    });

    // Drain the rest: `inFlight`/the waiter queue are module-level singletons,
    // so leaving fetches parked here would steal concurrency slots from the
    // next test in this file.
    for (let i = 1; i < deferreds.length; i++) {
      deferreds[i]!.resolve({ path: `tile-${i}.jpg`, widthPx: 8, heightPx: 8 });
    }
    await vi.waitFor(() => {
      for (const key of keys) expect(engine.get(key)?.state).toBe("ready");
    });
  });

  it("fetch resolves path -> convertFileSrc -> ImageBitmap and reports bytes/dispose", async () => {
    const mediaId = "m-fetch-dispose";
    const lod = 3;
    const index = 5;
    const key = filmstripTileKey(mediaId, lod, index);

    vi.mocked(getFilmstripTile).mockReset();
    vi.mocked(getFilmstripTile).mockResolvedValue({
      path: "/cache/tile-3-5.jpg",
      widthPx: 96,
      heightPx: 54,
    });
    const fakeBitmap = { width: 12, height: 34, close: vi.fn() } as unknown as ImageBitmap;
    createImageBitmapMock.mockResolvedValueOnce(fakeBitmap);

    engine.request(key);
    await vi.waitFor(() => {
      expect(engine.get<FilmstripTileValue>(key)?.state).toBe("ready");
    });

    const entry = engine.get<FilmstripTileValue>(key);
    if (entry?.state !== "ready") throw new Error(`expected a ready tile, got ${entry?.state}`);
    const value = entry.value;

    expect(vi.mocked(convertFileSrc)).toHaveBeenCalledWith("/cache/tile-3-5.jpg");
    // The composition matters: fetch must receive convertFileSrc's RETURN
    // value (the weftcut-media:// URL), not the raw ipc path.
    expect(fetchMock).toHaveBeenCalledWith("weftcut-media://test//cache/tile-3-5.jpg");
    expect(value.tUs).toBe(index * spacingUs(lod));
    expect(value.bitmap).toBe(fakeBitmap);
    // Assert the REGISTERED bytes callback, not a locally recomputed formula.
    expect(producer.bytes(value)).toBe(12 * 34 * 4);

    engine.invalidateMedia(mediaId, FILMSTRIP_KIND);
    expect((fakeBitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
  });

  it("releases the fetch slot when the ipc call rejects", async () => {
    vi.mocked(getFilmstripTile).mockReset();
    vi.mocked(getFilmstripTile).mockRejectedValue("not_ready");

    // Reject once per concurrency slot, sequentially. If any rejection leaked
    // its slot (finally not run), inFlight would hit the cap and the follow-up
    // fetch below would park forever on the waiter queue (test timeout).
    for (let i = 0; i < FILMSTRIP_MAX_CONCURRENT_FETCHES; i++) {
      await expect(producer.fetch(filmstripTileKey("m-reject", 0, i))).rejects.toBe("not_ready");
    }

    vi.mocked(getFilmstripTile).mockResolvedValue({ path: "after.jpg", widthPx: 8, heightPx: 8 });
    const value = await producer.fetch(filmstripTileKey("m-reject", 0, 9));
    expect(value.tUs).toBe(9 * spacingUs(0));
  });
});
