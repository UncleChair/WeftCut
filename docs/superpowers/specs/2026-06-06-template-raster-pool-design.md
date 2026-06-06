# Off-Main-Thread Template Rasterizer Pool Design

## Problem

Template preview rasterization is **main-thread-bound and serial**. Each
template frame goes through three stages in `rasterTemplateFrame`:

1. `harnessFor(templateId).renderFrameSvg(...)` — `render(t)` + reflow +
   serialize, inside the per-`templateId` sandboxed iframe (its own process,
   **off** the main thread).
2. postMessage the SVG string back to the main thread.
3. `rasterizeSvg(svg)` — `<img>` decode + `createImageBitmap`, **on the main
   thread**.

Measured in real WebView2 (480×480 countdown): stage 1 ≈ **2.24 ms** (~20%),
stage 3 ≈ **9.22 ms** (~80%), total ≈ 11.46 ms/frame → ~87 fps single-stream.
Firing rasters concurrently on the main thread gives only **1.21×** — stage 3 is
effectively serial on the main thread.

So under multi-template load (the stress repro: 8 overlapping countdowns / 4
distinct configs sharing one `templateId`), demand is 4 distinct contents ×
30 fps = 120 raster/s, but the main thread serves ~one 9 ms raster at a time
(~100/s ceiling, less under contention). The L1 prewarmer shifts work to
idle/pause time and eliminates the freeze for the pre-warmed prefix, but once
the warm window drains, sustained playback falls back to the serial main-thread
rasterizer and the tail degrades.

Workers cannot rasterize SVG in WebView2: they have no DOM (the required `<img>`
indirection), and `createImageBitmap(svgBlob)` fails directly.

## Goal

Move the ~80% rasterization stage **off the main thread**, parallelized, so
multi-template preview stops contending on one serial main-thread rasterizer.
Keep the existing main-thread implementation as an automatic fallback so no
WebView2 environment can regress.

## Feasibility (already verified, real WebView2)

A throwaway POC confirmed the load-bearing risks, on the real countdown SVG:

- A sandboxed iframe (`allow-scripts`, **no** `allow-same-origin`) blob-loads and
  rasterizes a plain SVG, and its canvas is **not tainted** (`getImageData`
  succeeds inside the iframe).
- The resulting `ImageBitmap` **transfers** across the sandbox→parent
  postMessage boundary.
- The transferred bitmap is **clean and usable on the main thread** (`drawImage`
  + `getImageData` both succeed — the same taint gate as
  `copyExternalImageToTexture`, so it is texture-uploadable).
- The iframe raster is **pixel-identical** to the current main-thread path
  (17.27% colored / mean-alpha 17.9, both paths) — `createImageBitmap(img)` at
  the SVG's intrinsic size, matching today's `rasterizeSvg`.
- 4 iframes vs 1 doing 4 rasters: **1.75×** (real cross-process parallelism,
  sublinear).

## Approach

Add a **generic rasterizer-iframe pool** and route `rasterizeSvg` through it
with a main-thread fallback. The pool iframes carry **no template HTML** — they
are pure "SVG string → `ImageBitmap`" workers. The per-`templateId` render
harness is **unchanged** (it already runs off-main and is only ~20%; serializing
it per-iframe is a one-DOM correctness requirement). We parallelize only the
~80% rasterization.

Because `rasterizeSvg` is the single rasterization primitive, routing it through
the pool transparently benefits **all** callers: the preview on-demand path
(`rasterTemplateFrame`), the prewarmer, export bake (`exportBake.ts`), and the
picker animated preview (`TemplatePicker.tsx`).

## Components

### 1. `RasterPool` (new — `src/render/templates/rasterPool.ts`)

Manages **N generic sandboxed rasterizer iframes**. Public surface:

```
rasterize(svg: string): Promise<ImageBitmap>
dispose(): void   // teardown (tests / shutdown)
```

- **Iframe**: `sandbox="allow-scripts"` (no `allow-same-origin`), offscreen
  (`position:fixed;left:-9999px`), `srcdoc` = a small inline script that, on
  `{type:"raster", id, svg}`, does `blob → <img> → createImageBitmap(img)` and
  posts `{type:"rastered", id, bitmap}` back **with the bitmap transferred**
  (or `{type:"rastered", id, error}` on failure). Posts `{type:"ready"}` once.
  No backtick / `${` inside the inline script body (bundle hazard — same lesson
  as `HARNESS_FRAME`).
- **Correlation**: monotonic request id + `ev.source === iframe.contentWindow`
  check (mirrors `TemplateHarness`).
- **Dispatch**: each iframe handles **one** in-flight raster at a time (its
  `createImageBitmap` is its own process; multiple in-flight in one iframe only
  contend). `rasterize` picks the next free iframe; if all N are busy, the
  request **queues FIFO** and dispatches when an iframe frees. Effective
  concurrency = N.
- **Process-global lazy singleton**: a module-level `getRasterPool()` creates the
  pool (and its iframes) on first use, reused for the session — same pattern as
  the `harnessByTemplateId` render harnesses. No idle teardown (N ≤ 4 iframes is
  bounded memory; YAGNI).

### 2. `svgRaster.ts` (modified)

Rename the current implementation to `rasterizeSvgInline(svg)` (unchanged body:
`<img>` + `createImageBitmap`). New `rasterizeSvg` keeps the same signature and
routes through the pool with a fallback:

```
export async function rasterizeSvg(svg: string): Promise<ImageBitmap> {
  const pool = getRasterPool();          // null when no document / pool disabled
  if (pool) {
    try { return await pool.rasterize(svg); }
    catch { /* fall through to inline */ }
  }
  return rasterizeSvgInline(svg);
}
```

### 3. `TemplatePrewarmer.drainBatch` (modified — approach 3a)

Today `drainBatch` awaits one `rasterTemplateFrame` at a time, so the prewarmer
fills at 1× even with the pool. Change it to **dispatch its existing `batchSize`
targets concurrently** (`Promise.all`; `batchSize` defaults to 3 ≈ N, so the
prewarmer stays decoupled from the pool — no need to import the pool size), then
yield and reschedule. The renders still serialize through the per-`templateId`
harness
(safe — concurrent `renderFrameSvg` on one iframe are microtask-serialized: each
`render(t)` + capture runs atomically in its microtask), but the rasters overlap
across the pool. This also yields the "render(N+1) under raster(N)" pipelining.

The on-demand path needs **no change** — N sprites missing simultaneously
already fire N concurrent `rasterizeSvg`, which the pool parallelizes.

## Pool sizing, lifecycle, fallback

- **Size**: `N = clamp(navigator.hardwareConcurrency - 2, 2, 4)` (a module
  constant). POC shows 4 iframes give 1.75× (sublinear), so capping at ~4 avoids
  spending memory on diminishing returns.
- **Lifecycle**: lazy, process-global, lives the session; `dispose()` for tests.
- **Fallback (three tiers)**:
  - **Pool init failure** (an iframe never signals `ready` within a load
    timeout) → mark the pool **unavailable for the session** → every
    `rasterizeSvg` uses `rasterizeSvgInline`. Log once.
  - **Single-raster timeout/error** (~5 s timeout, matching the render harness;
    or an `{error}` reply / img-load failure) → that one call rejects, so
    `rasterizeSvg` falls back to inline for that frame. The pool stays available;
    the suspect iframe is torn down and recreated on next use (lightweight
    self-heal).
  - **No DOM** (`typeof document === "undefined"`, the export Worker) → the pool
    never initializes. The Worker never calls `rasterizeSvg` anyway (bake is
    main-thread; the Worker uses injected frames) — same assumption as
    `harnessFor`.

## Invariants

- **Pixel parity**: the pool rasters via `createImageBitmap(img)` at the SVG's
  intrinsic size — identical to `rasterizeSvgInline`. POC-verified pixel-equal.
  This matters because both paths write the **same** `(cacheKey, frame)` in the
  shared cache; a pooled bitmap must be the exact image the inline path would
  produce.
- **Bitmap ownership**: the pool transfers the bitmap to the caller; the cache
  owns lifetime thereafter (idempotent `setFrame`). Late-resolving rasters after
  `dispose()` must `close()` their bitmaps (extends the existing
  dispose-mid-raster close in the prewarmer).

## Out of scope

- Speeding up a single raster (~9 ms is WebView2's SVG-via-`<img>` cost; the win
  is parallelism + main-thread relief, not per-raster speedup).
- Parallelizing the **render** stage (per-`templateId` harness pooling) — render
  is ~20%, already off-main, and stateful-DOM-serial by requirement.
- Adaptive pool sizing / idle teardown / disk cache (L2).
- Reworking the render harness to return bitmaps directly (rejected approach 2 —
  doesn't parallelize same-`templateId` distinct configs, and couples render +
  raster).

## Testing / verification

- **Unit (vitest, node)** — inject the "send to iframe / receive bitmap"
  transport as a `RasterPool` dependency (like `TemplatePrewarmer`'s deps), so
  the **dispatch logic** is testable without real iframes, using fake bitmaps:
  - picks a free iframe; concurrency cap = N; all-busy → FIFO queue → drains as
    iframes free;
  - id correlation; single timeout → reject; single error → reject (caller
    falls back); pool-init failure → marked unavailable; wedged iframe recycled
    after timeout.
  - `rasterizeSvg` fallback: a throwing fake pool → falls back to inline; null
    pool → inline.
  - prewarmer 3a: `drainBatch` reaches the concurrency cap (assert a
    high-water-mark via a fake render); dispose mid-batch closes late bitmaps.
- **Real-WebView2 regression (the gate)** — the real iframe raster + transfer +
  no-taint is not unit-testable in node; covered by the POC and a real-WebView2
  run:
  - re-run the 8-overlapping-countdown stress project; compare against the stored
    pre-pool baseline (the hit→miss flip at ~2.8 s): expect steady-play misses →
    ~0, no tail degradation, composite stable, cache bounded;
  - spot-check pixel parity (pool vs inline) — POC-proven, re-confirm once.
- **Follow-up (not in this spec)**: a template that bundles a custom `@font-face`
  — none exists in the catalog yet (only `countdown`, no fonts); inlined
  data-URL fonts should carry into the rasterizer iframe self-contained, but
  verify when the first font-bundling template lands.
