# mediabunny Migration — Plan A: reading foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone, tested module that opens an `asset://` media file through mediabunny — reading lazily over HTTP Range — and exposes the primary video track's WebCodecs decoder config + an `EncodedPacketSink`, proven to read MP4 *and* MKV without loading the whole file.

**Architecture:** A `CustomSource` adapter (`AssetRangeSource`) maps mediabunny's `read(start,end)`/`getSize()` onto Tauri `asset://` HTTP-Range fetches. `openMediaInput()` builds a mediabunny `Input` with an explicit format list and resolves the primary video track. Additive only — the live preview/export path keeps using the mp4box `Demuxer` until Plan B.

**Tech Stack:** TypeScript, Vitest (node), mediabunny.

**Spec:** `docs/superpowers/specs/2026-05-30-mediabunny-migration-design.md` (Phase A section).

**Pinned mediabunny API (verified against `node_modules/mediabunny/dist/mediabunny.d.ts`):**
- `new CustomSource({ getSize: () => MaybePromise<number>, read: (start, end) => MaybePromise<Uint8Array | ReadableStream<Uint8Array>>, dispose?: () => unknown, maxCacheSize?: number, prefetchProfile?: 'none'|'fileSystem'|'network' })`. Guarantee: `0 <= start < end < fileSize`. `read` range is treated as half-open `[start, end)`.
- `new Input({ formats: InputFormat[], source })`; format singletons `MP4`, `QTFF`, `MATROSKA`, `WEBM` (WebM subclasses Matroska).
- `await input.getPrimaryVideoTrack(): Promise<InputVideoTrack | null>`; `input.dispose(): void`.
- `await videoTrack.getDecoderConfig(): Promise<VideoDecoderConfig>` (has `codec`, `description`, `codedWidth`, `codedHeight`).
- `new EncodedPacketSink(videoTrack)`; `await sink.getFirstPacket()` / `getKeyPacket(ts)` / `getNextPacket(packet)` → `EncodedPacket | null`. `EncodedPacket`: `.data: Uint8Array`, `.type: 'key'|'delta'`, `.timestamp`/`.duration` (seconds), `.toEncodedVideoChunk()` (Plan B only).

---

## Task 1: Commit the mediabunny dependency

**Files:**
- Modify: `apps/desktop/package.json`, `apps/desktop/package-lock.json`

> mediabunny is already installed (`npm install mediabunny --prefix apps/desktop`). This task just commits it.

- [ ] **Step 1: Confirm it resolved**

Run: `npm --prefix apps/desktop ls mediabunny`
Expected: a single `mediabunny@<version>` line, no `UNMET`/`invalid`.

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "chore(deps): add mediabunny (Plan A reading foundation)"
```

---

## Task 2: Test fixtures + a Range-serving mock fetch

**Files:**
- Create: `apps/desktop/fixtures/media/tiny.mp4`, `apps/desktop/fixtures/media/tiny.mkv`
- Create: `apps/desktop/fixtures/media/README.md` (regeneration commands)
- Create: `apps/desktop/src/render/decoder/testing/rangeFetchMock.ts`
- Test: `apps/desktop/src/render/decoder/testing/rangeFetchMock.test.ts`

- [ ] **Step 1: Generate the two tiny clips**

Run (system ffmpeg, or the ffmpeg-sidecar binary under the app cache):

```bash
mkdir -p apps/desktop/fixtures/media
ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=30 -c:v libx264 -pix_fmt yuv420p -g 15 -movflags +faststart apps/desktop/fixtures/media/tiny.mp4
ffmpeg -y -i apps/desktop/fixtures/media/tiny.mp4 -c copy apps/desktop/fixtures/media/tiny.mkv
```

Write `apps/desktop/fixtures/media/README.md` containing exactly those two commands under a `## Regenerating` heading, so the binaries are reproducible.

- [ ] **Step 2: Write the Range-serving mock**

Create `rangeFetchMock.ts`:

```ts
// Test helper: serves HTTP Range requests against an in-memory buffer, so
// AssetRangeSource / mediabunny can read a fixture lazily in node vitest
// without a real asset:// server. Tracks total bytes served for laziness
// assertions.

export interface RangeFetchMock {
  /// Drop-in for global `fetch`. Honors `Range: bytes=a-b` (inclusive), 206.
  fetch: (input: string | URL, init?: { headers?: Record<string, string> }) => Promise<Response>;
  /// Sum of body bytes returned across all calls.
  bytesServed: () => number;
}

export function makeRangeFetchMock(buffer: Uint8Array): RangeFetchMock {
  let served = 0;
  const fetchImpl = async (
    _input: string | URL,
    init?: { headers?: Record<string, string> },
  ): Promise<Response> => {
    const range = init?.headers?.["Range"] ?? init?.headers?.["range"];
    if (!range) {
      served += buffer.byteLength;
      return new Response(buffer, {
        status: 200,
        headers: { "Content-Length": String(buffer.byteLength) },
      });
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) throw new Error(`mock: bad Range ${range}`);
    const start = Number(m[1]);
    const end = m[2] === "" ? buffer.byteLength - 1 : Number(m[2]); // inclusive
    const slice = buffer.subarray(start, end + 1);
    served += slice.byteLength;
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${buffer.byteLength}`,
        "Content-Length": String(slice.byteLength),
      },
    });
  };
  return { fetch: fetchImpl, bytesServed: () => served };
}
```

- [ ] **Step 3: Write the mock's self-test**

Create `rangeFetchMock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeRangeFetchMock } from "./rangeFetchMock";

const buf = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

describe("makeRangeFetchMock", () => {
  it("serves an inclusive byte range as 206 with Content-Range", async () => {
    const m = makeRangeFetchMock(buf);
    const res = await m.fetch("asset://x", { headers: { Range: "bytes=2-4" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4]));
    expect(m.bytesServed()).toBe(3);
  });

  it("serves the whole file as 200 when no Range", async () => {
    const m = makeRangeFetchMock(buf);
    const res = await m.fetch("asset://x");
    expect(res.status).toBe(200);
    expect(m.bytesServed()).toBe(10);
  });
});
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd apps/desktop && npx vitest run src/render/decoder/testing/rangeFetchMock.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/fixtures/media apps/desktop/src/render/decoder/testing
git commit -m "test(decoder): tiny mp4/mkv fixtures + Range-serving fetch mock"
```

---

## Task 3: `AssetRangeSource` (CustomSource over asset:// Range)

**Files:**
- Create: `apps/desktop/src/render/decoder/AssetRangeSource.ts`
- Test: `apps/desktop/src/render/decoder/AssetRangeSource.test.ts`

- [ ] **Step 1: Write the failing test**

Create `AssetRangeSource.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeRangeFetchMock } from "./testing/rangeFetchMock";
import { AssetRangeSource } from "./AssetRangeSource";

const buf = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));

describe("AssetRangeSource", () => {
  it("getSize reads total from Content-Range of a bytes=0-0 probe", async () => {
    vi.stubGlobal("fetch", makeRangeFetchMock(buf).fetch);
    const src = new AssetRangeSource("asset://clip");
    expect(await src.options.getSize()).toBe(1000);
    vi.unstubAllGlobals();
  });

  it("read returns the half-open [start,end) byte range", async () => {
    vi.stubGlobal("fetch", makeRangeFetchMock(buf).fetch);
    const src = new AssetRangeSource("asset://clip");
    const out = await src.options.read(10, 15); // bytes 10..14
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out as Uint8Array).toEqual(buf.subarray(10, 15));
    vi.unstubAllGlobals();
  });

  it("dispose aborts; subsequent read rejects with AbortError", async () => {
    vi.stubGlobal("fetch", (_u: string, init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
    );
    const src = new AssetRangeSource("asset://clip");
    const p = src.options.read(0, 10);
    src.dispose();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `cd apps/desktop && npx vitest run src/render/decoder/AssetRangeSource.test.ts`
Expected: FAIL — cannot find `./AssetRangeSource`.

- [ ] **Step 3: Implement `AssetRangeSource`**

Create `AssetRangeSource.ts`:

```ts
// mediabunny CustomSource adapter over the Tauri `asset://` protocol. Maps
// mediabunny's read(start,end) / getSize() onto HTTP Range requests so the
// whole file is never loaded — preserving the long-video heap budget. Owns an
// AbortController so disposing the Input cancels in-flight reads.
//
// mediabunny's read range is half-open [start, end) (0 <= start < end <
// fileSize); HTTP Range is inclusive, hence `bytes=start-(end-1)`. The Plan A
// fixture-parse test confirms this off-by-one empirically.

import { CustomSource, type CustomSourceOptions } from "mediabunny";

export class AssetRangeSource {
  private readonly assetUrl: string;
  private readonly abort = new AbortController();
  /// The mediabunny CustomSource — pass `.source` to `new Input({ source })`.
  readonly source: CustomSource;
  /// Exposed for unit tests; production code uses `.source`.
  readonly options: CustomSourceOptions;

  constructor(assetUrl: string) {
    this.assetUrl = assetUrl;
    this.options = {
      getSize: () => this.getSize(),
      read: (start, end) => this.read(start, end),
      dispose: () => this.dispose(),
      // Match the resident budget of the legacy GOP-block LRU (~a few source
      // seconds). Network-style prefetch suits asset:// latency.
      maxCacheSize: 16 * 1024 * 1024,
      prefetchProfile: "network",
    };
    this.source = new CustomSource(this.options);
  }

  dispose(): void {
    if (!this.abort.signal.aborted) this.abort.abort();
  }

  private async getSize(): Promise<number> {
    const res = await fetch(this.assetUrl, {
      headers: { Range: "bytes=0-0" },
      signal: this.abort.signal,
    });
    const cr = res.headers.get("Content-Range"); // "bytes 0-0/<total>"
    const total = cr?.split("/")[1];
    if (total && total !== "*") return Number.parseInt(total, 10);
    const cl = res.headers.get("Content-Length");
    if (cl) return Number.parseInt(cl, 10);
    throw new Error(`AssetRangeSource: no size for ${this.assetUrl}`);
  }

  private async read(start: number, end: number): Promise<Uint8Array> {
    const res = await fetch(this.assetUrl, {
      headers: { Range: `bytes=${start}-${end - 1}` }, // inclusive HTTP range
      signal: this.abort.signal,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    // 200 → server ignored Range and returned the whole file; slice the window.
    if (res.status === 200) return bytes.slice(start, end);
    return bytes;
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd apps/desktop && npx vitest run src/render/decoder/AssetRangeSource.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/decoder/AssetRangeSource.ts apps/desktop/src/render/decoder/AssetRangeSource.test.ts
git commit -m "feat(decoder): AssetRangeSource — mediabunny CustomSource over asset:// Range"
```

---

## Task 4: `openMediaInput` + MP4/MKV parity + laziness

**Files:**
- Create: `apps/desktop/src/render/decoder/mediaInput.ts`
- Test: `apps/desktop/src/render/decoder/mediaInput.test.ts`

- [ ] **Step 1: Write the failing test (the core proof)**

Create `mediaInput.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeRangeFetchMock } from "./testing/rangeFetchMock";
import { openMediaInput } from "./mediaInput";

function fixture(name: string): Uint8Array {
  const p = fileURLToPath(new URL(`../../../fixtures/media/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(p));
}

describe.each([["tiny.mp4"], ["tiny.mkv"]])("openMediaInput(%s)", (name) => {
  it("yields a decodable video track + first key packet, reading lazily", async () => {
    const buf = fixture(name);
    const mock = makeRangeFetchMock(buf);
    vi.stubGlobal("fetch", mock.fetch);

    const opened = await openMediaInput("asset://clip");
    const config = await opened.videoTrack.getDecoderConfig();
    expect(config).not.toBeNull();
    expect(config!.codec).toMatch(/^avc1\./); // H.264 in both containers

    const first = await opened.packetSink.getKeyPacket(0);
    expect(first).not.toBeNull();
    expect(first!.type).toBe("key");
    expect(first!.data.byteLength).toBeGreaterThan(0);

    // Laziness: opening + config + first key packet must not pull the whole
    // file. (tiny fixtures are small; assert we read strictly less than all
    // of it — the behavioral proxy for the heap invariant.)
    expect(mock.bytesServed()).toBeLessThan(buf.byteLength);

    opened.dispose();
    vi.unstubAllGlobals();
  });
});

describe("openMediaInput error handling", () => {
  it("throws when the source has no video track", async () => {
    // 4 bytes of garbage → no recognized video track.
    vi.stubGlobal("fetch", makeRangeFetchMock(new Uint8Array([1, 2, 3, 4])).fetch);
    await expect(openMediaInput("asset://bad")).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `cd apps/desktop && npx vitest run src/render/decoder/mediaInput.test.ts`
Expected: FAIL — cannot find `./mediaInput`.

- [ ] **Step 3: Implement `openMediaInput`**

Create `mediaInput.ts`:

```ts
// Opens an asset:// media file through mediabunny, lazily, and exposes the
// primary video track + an EncodedPacketSink for it. Explicit format list
// (MP4/MOV/Matroska/WebM) — NOT ALL_FORMATS — to keep the bundle lean.
// Replaces the mp4box `Demuxer`'s open/read role in later phases; additive
// for now.

import {
  Input,
  EncodedPacketSink,
  MP4,
  QTFF,
  MATROSKA,
  WEBM,
  type InputVideoTrack,
} from "mediabunny";
import { AssetRangeSource } from "./AssetRangeSource";

export interface OpenedMedia {
  /// The primary video track; `getDecoderConfig()` gives the WebCodecs config.
  videoTrack: InputVideoTrack;
  /// Packet source for seek + forward decode (Plan B/C consume this).
  packetSink: EncodedPacketSink;
  /// Release the Input + abort in-flight Range reads.
  dispose: () => void;
}

export async function openMediaInput(assetUrl: string): Promise<OpenedMedia> {
  const assetSource = new AssetRangeSource(assetUrl);
  const input = new Input({
    formats: [MP4, QTFF, MATROSKA, WEBM],
    source: assetSource.source,
  });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    input.dispose();
    throw new Error(`openMediaInput: no video track in ${assetUrl}`);
  }
  return {
    videoTrack,
    packetSink: new EncodedPacketSink(videoTrack),
    dispose: () => input.dispose(),
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd apps/desktop && npx vitest run src/render/decoder/mediaInput.test.ts`
Expected: 3 passed (MP4 + MKV parity + error case). If the parity tests fail to parse, the `read` off-by-one is wrong — flip `AssetRangeSource`'s Range to `bytes=${start}-${end}` and re-run (see the comment in `AssetRangeSource.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/decoder/mediaInput.ts apps/desktop/src/render/decoder/mediaInput.test.ts
git commit -m "feat(decoder): openMediaInput — mediabunny Input over asset://, MP4+MKV"
```

---

## Final verification

- [ ] `cd apps/desktop && npx vitest run src/render/decoder` — all Plan A tests green (mock, AssetRangeSource, mediaInput MP4+MKV+error).
- [ ] `cd apps/desktop && npx vitest run` — full suite still green (Plan A is additive; nothing else should change).
- [ ] TS: no new type errors vs `main` (Plan-1 method: `npx tsc --noEmit -p tsconfig.json`, compare error set — confirm none mention `AssetRangeSource`/`mediaInput`/`mediabunny`).
- [ ] **Runtime acceptance (manual, REQUIRES the app — carry to Plan B if not done here):** in `tauri:dev`, call `openMediaInput` against a *long* real clip and iterate packets via `sink.packets()` while watching PerfHUD heap. Heap must stay flat (low hundreds of MB) regardless of duration — the hard invariant the unit laziness test only approximates. Tune `AssetRangeSource`'s `maxCacheSize` if it climbs.

---

## Self-review

**Spec coverage:** `AssetRangeSource` CustomSource over asset:// (Task 3) ✓; `openMediaInput` explicit-format Input + primary track + packet sink + getDecoderConfig (Task 4) ✓; MP4+MKV parity (Task 4) ✓; laziness behavioral proof (Task 4) ✓; fixtures (Task 2) ✓; additive/not-wired (no pool/encoder edits anywhere) ✓; runtime PerfHUD gate carried as manual acceptance ✓; bundle-lean explicit formats ✓. The "known unknown" (CustomSourceOptions shape) was resolved during planning and is encoded in Task 3's real code.

**Placeholder scan:** none. The one conditional ("if parity fails, flip the off-by-one") is a specified, bounded empirical check with the exact alternative given — not a placeholder.

**Type consistency:** `AssetRangeSource.source` (a `CustomSource`) feeds `new Input({ source })`; `.options` (a `CustomSourceOptions`) is what the unit tests exercise. `openMediaInput → OpenedMedia { videoTrack: InputVideoTrack, packetSink: EncodedPacketSink, dispose }`. Format singletons `MP4/QTFF/MATROSKA/WEBM` match the pinned API header. `read` half-open `[start,end)` → `bytes=${start}-${end-1}` is consistent between `AssetRangeSource` and the mock's inclusive serving.
