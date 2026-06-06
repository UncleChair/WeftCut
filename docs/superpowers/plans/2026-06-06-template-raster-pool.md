# Off-Main-Thread Template Rasterizer Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the ~80% main-thread SVG rasterization off-thread, parallelized across a pool of sandboxed iframes, with an automatic main-thread fallback, so multi-template preview stops contending on one serial rasterizer.

**Architecture:** A pure `RasterPool` scheduler (dependency-injected slots, node-tested) drives N generic sandboxed rasterizer iframes (`rasterSlot.ts`, DOM, verified in WebView2). `rasterizeSvg` becomes a thin drop-in that routes through the pool and falls back to the existing inline path. The prewarmer's `drainBatch` dispatches its batch concurrently so it fills at pool speed.

**Tech Stack:** TypeScript, sandboxed `<iframe>` + transferable `ImageBitmap`, vitest, real-WebView2 verification.

**Branch:** `feat/template-raster-pool` (created; spec committed).

**Spec:** `docs/superpowers/specs/2026-06-06-template-raster-pool-design.md`

**Test commands:** from `apps/desktop` → `npm test -- <path>` (vitest), `npm test` (full suite), `npm run typecheck`.

---

## Task 1: `RasterPool` scheduling core (pure, DI'd, node-tested)

The scheduler: dispatch over N slots, FIFO-queue when all busy, recycle a slot on failure, fast-fail after too many consecutive failures, reject pending on dispose. No DOM — slots are injected, so this is fully unit-testable.

**Files:**
- Create: `apps/desktop/src/render/templates/rasterPool.ts`
- Test: `apps/desktop/src/render/templates/rasterPool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/render/templates/rasterPool.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RasterPool, type RasterSlot } from "./rasterPool";

function makeBmp(): ImageBitmap {
  return { close() {} } as unknown as ImageBitmap;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/// Fake slot factory: every `rasterize` call parks a deferred the test resolves
/// or rejects on demand, so dispatch/queue/recycle behavior is observable.
function fakeSlots() {
  const calls: { svg: string; slotId: number; d: ReturnType<typeof deferred<ImageBitmap>> }[] = [];
  const disposed: number[] = [];
  let seq = 0;
  const createSlot = (): RasterSlot => {
    const slotId = seq++;
    return {
      rasterize(svg: string) {
        const d = deferred<ImageBitmap>();
        calls.push({ svg, slotId, d });
        return d.promise;
      },
      dispose() {
        disposed.push(slotId);
      },
    };
  };
  return { createSlot, calls, disposed };
}

const tick = () => Promise.resolve();

describe("RasterPool", () => {
  it("dispatches a job to a free slot and resolves with its bitmap", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 2, createSlot: f.createSlot });
    const p = pool.rasterize("a");
    await tick();
    expect(f.calls.length).toBe(1);
    const bmp = makeBmp();
    f.calls[0]!.d.resolve(bmp);
    expect(await p).toBe(bmp);
  });

  it("caps concurrency at the pool size and FIFO-queues the rest", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 2, createSlot: f.createSlot });
    pool.rasterize("a");
    pool.rasterize("b");
    pool.rasterize("c");
    await tick();
    expect(f.calls.map((c) => c.svg)).toEqual(["a", "b"]); // only 2 in flight
    f.calls[0]!.d.resolve(makeBmp()); // free a slot
    await tick();
    await tick();
    expect(f.calls.map((c) => c.svg)).toEqual(["a", "b", "c"]); // c dispatched next
  });

  it("recycles a slot and rejects the call when a raster fails", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 1, createSlot: f.createSlot });
    const p = pool.rasterize("a");
    await tick();
    f.calls[0]!.d.reject(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
    expect(f.disposed).toContain(0); // wedged slot torn down
    pool.rasterize("b"); // next call builds a fresh slot
    await tick();
    expect(f.calls.length).toBe(2);
  });

  it("disables itself (fast-fail) after maxConsecutiveFailures", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 1, createSlot: f.createSlot, maxConsecutiveFailures: 2 });
    const p1 = pool.rasterize("a");
    await tick();
    f.calls[0]!.d.reject(new Error("x"));
    await p1.catch(() => {});
    const p2 = pool.rasterize("b");
    await tick();
    f.calls[1]!.d.reject(new Error("y"));
    await p2.catch(() => {});
    expect(pool.disabled).toBe(true);
    await expect(pool.rasterize("c")).rejects.toThrow(/disabled/);
    expect(f.calls.length).toBe(2); // c never reached a slot
  });

  it("resets the failure counter on a success", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 1, createSlot: f.createSlot, maxConsecutiveFailures: 2 });
    const p1 = pool.rasterize("a");
    await tick();
    f.calls[0]!.d.reject(new Error("x"));
    await p1.catch(() => {});
    const p2 = pool.rasterize("b");
    await tick();
    f.calls[1]!.d.resolve(makeBmp());
    await p2;
    expect(pool.disabled).toBe(false);
  });

  it("rejects queued jobs and disposes slots on dispose()", async () => {
    const f = fakeSlots();
    const pool = new RasterPool({ size: 1, createSlot: f.createSlot });
    pool.rasterize("a"); // in flight
    const p2 = pool.rasterize("b"); // queued
    await tick();
    pool.dispose();
    await expect(p2).rejects.toThrow(/disposed/);
    expect(f.disposed).toContain(0);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (module missing)**

Run (from `apps/desktop`): `npm test -- src/render/templates/rasterPool.test.ts`
Expected: FAIL — cannot find `./rasterPool`.

- [ ] **Step 3: Implement `rasterPool.ts`**

Create `apps/desktop/src/render/templates/rasterPool.ts`:

```ts
// Pure scheduler for off-main-thread SVG rasterization. It owns no DOM — slots
// are injected (`createSlot`), so the dispatch / queue / recycle / fast-fail
// logic is fully unit-testable. The real slots (sandboxed iframes) live in
// `rasterSlot.ts`. The pool never speeds a single raster; it parallelizes them
// across slots and keeps the work off the main thread.

/// One rasterizer backend. `rasterize` resolves with a transferred ImageBitmap
/// or rejects on timeout/error. `dispose` tears down the backing resource and
/// MUST reject any in-flight `rasterize` (so the pool's callers fall back).
export interface RasterSlot {
  rasterize(svg: string): Promise<ImageBitmap>;
  dispose(): void;
}

export interface RasterPoolDeps {
  size: number;
  /// Factory for a fresh slot. Real impl: an iframe-backed slot. Tests inject a fake.
  createSlot: () => RasterSlot;
  /// After this many CONSECUTIVE failures the pool disables itself: `rasterize`
  /// then rejects immediately (fast-fail) so callers fall back without paying a
  /// per-raster timeout. Reset to 0 on any success. Default 3.
  maxConsecutiveFailures?: number;
}

interface SlotState {
  slot: RasterSlot;
  busy: boolean;
}

interface QueuedJob {
  svg: string;
  resolve: (b: ImageBitmap) => void;
  reject: (e: unknown) => void;
}

export class RasterPool {
  private slots: SlotState[] = [];
  private queue: QueuedJob[] = [];
  private consecutiveFailures = 0;
  private disposed = false;
  private readonly size: number;
  private readonly createSlot: () => RasterSlot;
  private readonly maxConsecutiveFailures: number;

  constructor(deps: RasterPoolDeps) {
    this.size = Math.max(1, deps.size);
    this.createSlot = deps.createSlot;
    this.maxConsecutiveFailures = deps.maxConsecutiveFailures ?? 3;
  }

  /// True once the pool has fast-failed; callers should fall back permanently.
  get disabled(): boolean {
    return this.consecutiveFailures >= this.maxConsecutiveFailures;
  }

  /// Queue a raster; resolves with a transferred ImageBitmap. Rejects
  /// immediately when disposed or disabled (so the caller falls back to inline).
  rasterize(svg: string): Promise<ImageBitmap> {
    if (this.disposed) return Promise.reject(new Error("rasterPool: disposed"));
    if (this.disabled) {
      return Promise.reject(new Error("rasterPool: disabled (too many failures)"));
    }
    return new Promise<ImageBitmap>((resolve, reject) => {
      this.queue.push({ svg, resolve, reject });
      this.pump();
    });
  }

  private ensureSlots(): void {
    while (this.slots.length < this.size) {
      this.slots.push({ slot: this.createSlot(), busy: false });
    }
  }

  private pump(): void {
    if (this.disposed || this.queue.length === 0) return;
    this.ensureSlots();
    for (const state of this.slots) {
      if (this.queue.length === 0) break;
      if (state.busy) continue;
      const job = this.queue.shift()!;
      state.busy = true;
      state.slot
        .rasterize(job.svg)
        .then(
          (bmp) => {
            this.consecutiveFailures = 0;
            job.resolve(bmp);
          },
          (err) => {
            // The slot may be wedged — tear it down and replace it so the next
            // job gets a fresh iframe. The call still rejects → caller falls back.
            this.consecutiveFailures++;
            try {
              state.slot.dispose();
            } catch {
              // ignore
            }
            state.slot = this.createSlot();
            job.reject(err);
          },
        )
        .finally(() => {
          state.busy = false;
          this.pump();
        });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.slots) {
      try {
        s.slot.dispose();
      } catch {
        // ignore
      }
    }
    this.slots = [];
    const err = new Error("rasterPool: disposed");
    for (const j of this.queue) j.reject(err);
    this.queue = [];
  }
}
```

- [ ] **Step 4: Run the test — expect PASS (6/6)**

Run: `npm test -- src/render/templates/rasterPool.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` → clean.

```bash
git add apps/desktop/src/render/templates/rasterPool.ts apps/desktop/src/render/templates/rasterPool.test.ts
git commit -m "feat(templates): RasterPool scheduler (DI'd slots, queue, recycle, fast-fail)"
```

---

## Task 2: Real iframe raster slot + `getRasterPool` singleton

The DOM transport: a sandboxed iframe that rasterizes an SVG string to an `ImageBitmap` and transfers it back. Not node-unit-testable (real iframe messaging) — verified by the POC + the WebView2 run in Task 5. Only the document-gated singleton accessor gets a thin test.

**Files:**
- Create: `apps/desktop/src/render/templates/rasterSlot.ts`
- Test: `apps/desktop/src/render/templates/rasterSlot.test.ts`

- [ ] **Step 1: Implement `rasterSlot.ts`**

Create `apps/desktop/src/render/templates/rasterSlot.ts`:

```ts
// The DOM half of the rasterizer pool: a sandboxed iframe that turns an SVG
// string into a transferred ImageBitmap, plus the process-global pool singleton.
// Feasibility (untainted raster + cross-boundary transfer + pixel-parity) was
// verified in real WebView2; see the spec. Main-thread only — the export Worker
// has no `document`, so `getRasterPool()` returns null there and callers fall
// back to the inline rasterizer.
import { RasterPool, type RasterSlot } from "./rasterPool";

const READY_TIMEOUT_MS = 5000;
const RASTER_TIMEOUT_MS = 5000;

// Inline script injected into each rasterizer iframe. Plain, dependency-free JS.
// Protocol: parent -> iframe { type:"raster", id, svg }; iframe -> parent
// { type:"rastered", id, bitmap } (transferred) or { type:"rastered", id, error }.
// BUILD HAZARD: this is a single template literal — do NOT put a backtick or a
// `${` sequence in the body (same lesson as HARNESS_FRAME / ENGINE_SOURCE).
export const RASTER_FRAME = `
(function () {
  function handle(ev) {
    var d = ev.data;
    if (!d || d.type !== "raster") return;
    var id = d.id;
    var url = URL.createObjectURL(new Blob([d.svg], { type: "image/svg+xml" }));
    var img = new Image();
    img.onload = function () {
      createImageBitmap(img).then(function (b) {
        parent.postMessage({ type: "rastered", id: id, bitmap: b }, "*", [b]);
      }).catch(function (e) {
        parent.postMessage({ type: "rastered", id: id, error: String(e) }, "*");
      }).finally(function () { URL.revokeObjectURL(url); });
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      parent.postMessage({ type: "rastered", id: id, error: "raster: img failed to load SVG" }, "*");
    };
    img.src = url;
  }
  window.addEventListener("message", handle);
  parent.postMessage({ type: "ready" }, "*");
})();
`;

interface PendingRaster {
  resolve: (b: ImageBitmap) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/// Create one iframe-backed rasterizer slot. The iframe is sandboxed
/// (`allow-scripts`, no `allow-same-origin`) and offscreen; it rasterizes its
/// own blob-loaded SVG to an ImageBitmap (untainted) and transfers it back.
export function createIframeRasterSlot(): RasterSlot {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.title = "template-raster-slot";
  iframe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0";
  document.body.appendChild(iframe);

  let disposed = false;
  let nextId = 1;
  const pending = new Map<number, PendingRaster>();

  let readyResolve: (() => void) | null = null;
  let readyReject: ((e: Error) => void) | null = null;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  const readyTimer = setTimeout(() => {
    if (readyReject) readyReject(new Error("rasterSlot: iframe never readied"));
    readyResolve = null;
    readyReject = null;
  }, READY_TIMEOUT_MS);

  const onMessage = (ev: MessageEvent): void => {
    if (ev.source !== iframe.contentWindow) return;
    const d = ev.data as { type?: string; id?: number; bitmap?: ImageBitmap; error?: string } | null;
    if (!d || typeof d.type !== "string") return;
    if (d.type === "ready") {
      clearTimeout(readyTimer);
      const r = readyResolve;
      readyResolve = null;
      readyReject = null;
      if (r) r();
      return;
    }
    if (d.type === "rastered" && typeof d.id === "number") {
      const entry = pending.get(d.id);
      if (!entry) return;
      pending.delete(d.id);
      clearTimeout(entry.timer);
      if (typeof d.error === "string") entry.reject(new Error("rasterSlot: " + d.error));
      else if (d.bitmap) entry.resolve(d.bitmap);
      else entry.reject(new Error("rasterSlot: reply had no bitmap"));
    }
  };
  window.addEventListener("message", onMessage);
  iframe.srcdoc =
    "<!doctype html><html><body><scr" + "ipt>" + RASTER_FRAME + "</scr" + "ipt></body></html>";

  return {
    async rasterize(svg: string): Promise<ImageBitmap> {
      if (disposed) throw new Error("rasterSlot: disposed");
      await ready; // rejects on ready-timeout/dispose → pool recycles + caller falls back
      const win = iframe.contentWindow;
      if (!win) throw new Error("rasterSlot: no contentWindow");
      const id = nextId++;
      return new Promise<ImageBitmap>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("rasterSlot: raster timed out"));
        }, RASTER_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        win.postMessage({ type: "raster", id, svg }, "*");
      });
    },
    dispose(): void {
      disposed = true;
      clearTimeout(readyTimer);
      if (readyReject) {
        readyReject(new Error("rasterSlot: disposed"));
        readyResolve = null;
        readyReject = null;
      }
      for (const e of pending.values()) {
        clearTimeout(e.timer);
        e.reject(new Error("rasterSlot: disposed"));
      }
      pending.clear();
      window.removeEventListener("message", onMessage);
      iframe.remove();
    },
  };
}

/// Pool size: leave the main thread + a render-harness core headroom, cap at 4
/// (POC: 4 iframes give ~1.75x — sublinear past that).
const RASTER_POOL_SIZE = (() => {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(2, Math.min(4, cores - 2));
})();

let poolSingleton: RasterPool | null = null;
let poolInitTried = false;

/// The process-wide rasterizer pool, or null when there is no DOM (export
/// Worker) — callers fall back to the inline main-thread rasterizer. Lazily
/// constructed; slots (iframes) are created on first raster, not here.
export function getRasterPool(): RasterPool | null {
  if (typeof document === "undefined") return null;
  if (!poolInitTried) {
    poolInitTried = true;
    poolSingleton = new RasterPool({
      size: RASTER_POOL_SIZE,
      createSlot: createIframeRasterSlot,
    });
  }
  return poolSingleton;
}
```

- [ ] **Step 2: Write the singleton test**

Create `apps/desktop/src/render/templates/rasterSlot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getRasterPool, RASTER_FRAME } from "./rasterSlot";

describe("getRasterPool", () => {
  it("returns a stable singleton (same instance / both null)", () => {
    // Real iframe rasterization is verified in WebView2 (Task 5); here we only
    // assert the accessor is a stable singleton. With a DOM it is a RasterPool;
    // without one (node) it is null. Either way the accessor is idempotent.
    expect(getRasterPool()).toBe(getRasterPool());
  });

  it("RASTER_FRAME has no backtick or interpolation (bundle hazard)", () => {
    expect(RASTER_FRAME.includes("`")).toBe(false);
    expect(RASTER_FRAME.includes("${")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test — expect PASS (2/2)**

Run: `npm test -- src/render/templates/rasterSlot.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck` → clean.

```bash
git add apps/desktop/src/render/templates/rasterSlot.ts apps/desktop/src/render/templates/rasterSlot.test.ts
git commit -m "feat(templates): iframe raster slot + document-gated pool singleton"
```

---

## Task 3: Route `rasterizeSvg` through the pool (drop-in + fallback)

Keep the current implementation as `rasterizeSvgInline` (the fallback), and make `rasterizeSvg` route through the pool. A pure `rasterizeSvgVia(pool, inline, svg)` makes the routing/fallback logic node-testable without a DOM. All four callers (`rasterTemplateFrame`, prewarmer, export bake, picker) benefit transparently — none of them change.

**Files:**
- Modify: `apps/desktop/src/render/templates/svgRaster.ts`
- Test: `apps/desktop/src/render/templates/svgRaster.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/render/templates/svgRaster.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { rasterizeSvgVia } from "./svgRaster";
import type { RasterPool } from "./rasterPool";

function makeBmp(tag: string): ImageBitmap {
  return { tag, close() {} } as unknown as ImageBitmap;
}

describe("rasterizeSvgVia", () => {
  it("uses the pool when it resolves", async () => {
    const poolBmp = makeBmp("pool");
    const pool = { rasterize: vi.fn(async () => poolBmp) } as unknown as RasterPool;
    const inline = vi.fn(async () => makeBmp("inline"));
    const out = await rasterizeSvgVia(pool, inline, "<svg/>");
    expect(out).toBe(poolBmp);
    expect(inline).not.toHaveBeenCalled();
  });

  it("falls back to inline when the pool rejects", async () => {
    const inlineBmp = makeBmp("inline");
    const pool = {
      rasterize: vi.fn(async () => {
        throw new Error("pool down");
      }),
    } as unknown as RasterPool;
    const inline = vi.fn(async () => inlineBmp);
    const out = await rasterizeSvgVia(pool, inline, "<svg/>");
    expect(out).toBe(inlineBmp);
    expect(inline).toHaveBeenCalledWith("<svg/>");
  });

  it("uses inline when there is no pool", async () => {
    const inlineBmp = makeBmp("inline");
    const inline = vi.fn(async () => inlineBmp);
    const out = await rasterizeSvgVia(null, inline, "<svg/>");
    expect(out).toBe(inlineBmp);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `npm test -- src/render/templates/svgRaster.test.ts`
Expected: FAIL — `rasterizeSvgVia` is not exported yet.

- [ ] **Step 3: Rewrite `svgRaster.ts`**

Replace the entire contents of `apps/desktop/src/render/templates/svgRaster.ts` with:

```ts
// Rasterize a plain-SVG string to an ImageBitmap. Prefers the off-main-thread
// RasterPool (parallel, keeps the work off the main thread); falls back to the
// inline main-thread path on any pool failure or when there is no DOM.
import { getRasterPool, type RasterPool } from "./rasterSlot";

// Inline main-thread rasterizer (the fallback + the original implementation).
// NOTE: createImageBitmap(blob) directly fails for SVG in WebView2 — the
// <img> indirection is REQUIRED. foreignObject taints; plain SVG is clean.
export async function rasterizeSvgInline(svg: string): Promise<ImageBitmap> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("svgRaster: <img> failed to load SVG"));
      img.src = url;
    });
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/// Pure routing: pool first (parallel/off-main), inline on any pool rejection
/// or when there is no pool. Injected `pool`/`inline` make it DOM-free testable.
export async function rasterizeSvgVia(
  pool: RasterPool | null,
  inline: (svg: string) => Promise<ImageBitmap>,
  svg: string,
): Promise<ImageBitmap> {
  if (pool) {
    try {
      return await pool.rasterize(svg);
    } catch {
      // Pool unavailable / disabled / this raster failed — fall back to inline.
    }
  }
  return inline(svg);
}

/// Rasterize a plain-SVG string to an ImageBitmap (pooled, with inline fallback).
export function rasterizeSvg(svg: string): Promise<ImageBitmap> {
  return rasterizeSvgVia(getRasterPool(), rasterizeSvgInline, svg);
}
```

- [ ] **Step 4: Run the test — expect PASS (3/3)**

Run: `npm test -- src/render/templates/svgRaster.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Full suite + typecheck (no caller changed signature)**

Run: `npm test` (the existing `rasterTemplateFrame` / export-bake / picker callers still compile + pass — `rasterizeSvg(svg)` signature is unchanged) and `npm run typecheck` (clean).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/render/templates/svgRaster.ts apps/desktop/src/render/templates/svgRaster.test.ts
git commit -m "feat(templates): route rasterizeSvg through the pool with inline fallback"
```

---

## Task 4: Prewarmer 3a — concurrent `drainBatch`

Today `drainBatch` awaits one raster at a time, so the prewarmer fills at 1x even with the pool. Pull up to `batchSize` fresh targets and raster them concurrently (`Promise.all`). Renders still serialize through the per-`templateId` harness (microtask-serialized — safe); rasters parallelize across the pool.

**Files:**
- Modify: `apps/desktop/src/render/templates/TemplatePrewarmer.ts` (`drainBatch`, ~lines 57-86)
- Test: `apps/desktop/src/render/templates/TemplatePrewarmer.test.ts` (add 2 tests)

- [ ] **Step 1: Add the failing tests**

Append these two tests inside the `describe("TemplatePrewarmer", ...)` block in `apps/desktop/src/render/templates/TemplatePrewarmer.test.ts` (before its closing `});`):

```ts
  it("dispatches up to batchSize rasters concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release: (() => void)[] = [];
    const render = vi.fn(
      (_f: number) =>
        new Promise<ImageBitmap>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          release.push(() => {
            inFlight--;
            resolve(makeBmp());
          });
        }),
    );
    const pending: (() => void)[] = [];
    const prewarmer = new TemplatePrewarmer({
      cap: 240,
      hasFrame: () => false,
      setFrame: () => {},
      schedule: (cb) => {
        pending.push(cb);
        return pending.length;
      },
      cancel: () => {},
      batchSize: 3,
    });
    prewarmer.setTargets([
      { cacheKey: "a", contentFrame: 0, contentDurationFrames: 10, render },
    ]);
    pending.shift()!(); // run the first scheduled batch
    await Promise.resolve();
    await Promise.resolve();
    expect(maxInFlight).toBe(3); // batchSize rasters in flight at once
    release.forEach((r) => r());
  });

  it("closes bitmaps that resolve after dispose (mid-batch)", async () => {
    const closed: number[] = [];
    let n = 0;
    const release: (() => void)[] = [];
    const render = vi.fn(
      () =>
        new Promise<ImageBitmap>((resolve) => {
          const id = n++;
          release.push(() =>
            resolve({
              close() {
                closed.push(id);
              },
            } as unknown as ImageBitmap),
          );
        }),
    );
    const setFrame = vi.fn();
    const pending: (() => void)[] = [];
    const prewarmer = new TemplatePrewarmer({
      cap: 240,
      hasFrame: () => false,
      setFrame,
      schedule: (cb) => {
        pending.push(cb);
        return pending.length;
      },
      cancel: () => {},
      batchSize: 2,
    });
    prewarmer.setTargets([
      { cacheKey: "a", contentFrame: 0, contentDurationFrames: 5, render },
    ]);
    pending.shift()!(); // start the batch (2 renders in flight, gated)
    await Promise.resolve();
    prewarmer.dispose();
    release.forEach((r) => r()); // resolve after dispose
    await new Promise((r) => setTimeout(r, 0));
    expect(setFrame).not.toHaveBeenCalled();
    expect(closed.length).toBe(2); // both late bitmaps closed, not leaked
  });
```

- [ ] **Step 2: Run — expect the new tests to FAIL**

Run: `npm test -- src/render/templates/TemplatePrewarmer.test.ts`
Expected: the "dispatches up to batchSize rasters concurrently" test FAILS (current code is sequential → `maxInFlight` is 1, not 3). The dispose test may pass already.

- [ ] **Step 3: Rewrite `drainBatch` for concurrent dispatch**

In `apps/desktop/src/render/templates/TemplatePrewarmer.ts`, replace the whole `drainBatch` method (currently ~lines 57-86) with:

```ts
  private async drainBatch(): Promise<void> {
    if (this.disposed) return;
    this.running = true;
    try {
      // Pull up to batchSize FRESH targets (skip already-cached / inactive),
      // then raster them CONCURRENTLY. Renders serialize through the per-
      // templateId harness (microtask-serialized — safe), but rasters parallelize
      // across the RasterPool, so the prewarmer fills at pool speed instead of 1x.
      const batch: { cacheKey: string; frame: number; spec: PrewarmContentSpec }[] = [];
      while (batch.length < this.batchSize && this.queue.length > 0) {
        const target = this.queue.shift()!;
        if (this.deps.hasFrame(target.cacheKey, target.frame)) continue; // already cached
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) continue; // content no longer active
        batch.push({ cacheKey: target.cacheKey, frame: target.frame, spec });
      }
      await Promise.all(
        batch.map(async ({ cacheKey, frame, spec }) => {
          try {
            const bmp = await spec.render(frame);
            if (this.disposed) {
              // Disposed mid-raster: this bitmap will never be cached, so close
              // it to avoid leaking the decoded image.
              bmp.close();
              return;
            }
            this.deps.setFrame(cacheKey, frame, bmp);
          } catch {
            // Raster failed (e.g. harness/pool disposed) — drop, keep going.
          }
        }),
      );
    } finally {
      this.running = false;
      this.arm(); // more to do? reschedule. else idle.
    }
  }
```

NOTE: `PrewarmContentSpec` is already declared+exported in this file (used by `setTargets`), so the `batch` element type resolves with no new import.

- [ ] **Step 4: Run — expect all prewarmer tests PASS (4/4)**

Run: `npm test -- src/render/templates/TemplatePrewarmer.test.ts`
Expected: PASS, 4 tests (the original 2 still pass — they assert call-count + cached, not strict order).

- [ ] **Step 5: Full suite + typecheck + commit**

Run: `npm test` (full suite green) and `npm run typecheck` (clean).

```bash
git add apps/desktop/src/render/templates/TemplatePrewarmer.ts apps/desktop/src/render/templates/TemplatePrewarmer.test.ts
git commit -m "feat(templates): prewarmer drains its batch concurrently (pool-parallel fill)"
```

---

## Task 5: Real-WebView2 regression + docs + finish branch

The iframe raster + transfer + no-taint is not node-testable; this is the acceptance gate.

- [ ] **Step 1: Launch + connect**

`npm run tauri:dev` (background) from `apps/desktop`; reload the webview to load the new bundle (a fresh Compositor + the pooled `rasterizeSvg`); confirm the driver session (port 9223) and reopen the stress project.

- [ ] **Step 2: Confirm the pool is live + parallel**

In the webview, dynamic-import the modules and assert: `getRasterPool()` returns a `RasterPool` (not null); after playing the 8-overlapping-countdown stress project, instrument cache `getFrame` hits/misses (same technique as the prewarmer verification) and compare against the stored **pre-pool baseline** (the hit→miss flip at ~2:24 / ~2.8 s). Expected: steady-play **misses → ~0** (the pool keeps the prewarmer ahead), no tail degradation, composite time stable in the PerfHUD, cache bounded at cap.

- [ ] **Step 3: Confirm pixel parity (pool vs inline)**

Spot-check: rasterize one real countdown SVG via the pool and via `rasterizeSvgInline`, draw both to a canvas, and compare non-transparent / colored pixel ratios — expect a match (POC already proved this; reconfirm once on the live build). Also confirm a template **export** still produces correct output (the export-bake path now rasterizes through the pool): export a short template clip and verify the output file renders the numerals correctly.

- [ ] **Step 4: Update docs (evergreen)**

In `docs/templates.md`, the **L1** bullet currently says rasterization is main-thread and one harness serializes, so heavy multi-distinct-content falls back to L0 for the tail. Update that to reflect the pool. Replace the sentence:

> It **fills ahead of time rather than speeding the harness** (one harness per `templateId`, serialized), so sustained load with many distinct heavy contents at once still falls back to the L0 on-demand path for the tail — which remains the fallback for any not-yet-warmed frame (e.g. immediately after a seek).

with:

> Rasterization itself runs **off the main thread**: a small pool of sandboxed rasterizer iframes turns each frame's SVG into a transferred bitmap in parallel (the per-`templateId` render harness stays serial, but it is only the cheap render stage), with an automatic fall-back to a main-thread raster if the pool is unavailable. This keeps the cache filling ahead even under many simultaneous templates. The L0 on-demand path remains the fall-back for any not-yet-warmed frame (e.g. immediately after a seek).

```bash
git add docs/templates.md
git commit -m "docs(templates): L1 rasterization runs off-main via a pool"
```

- [ ] **Step 5: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`.

---

## Self-Review

**Spec coverage:**
- Generic rasterizer-iframe pool, drop-in behind `rasterizeSvg`: Task 1 (scheduler) + Task 2 (iframe slot + singleton) + Task 3 (routing). ✓
- Pool size `clamp(hardwareConcurrency-2, 2, 4)`, lazy process-global singleton: Task 2 (`RASTER_POOL_SIZE`, `getRasterPool`). ✓
- Next-free dispatch + FIFO queue; one in-flight per slot: Task 1 (`pump`). ✓
- Three-tier fallback — init-fail/disabled → fast-fail (Task 1 `disabled` + Task 3 catch); per-raster timeout/error → inline + recycle slot (Task 1 recycle + Task 2 timeouts + Task 3 catch); no-DOM → null pool → inline (Task 2 `getRasterPool` + Task 3). ✓
- Prewarmer 3a concurrent `drainBatch` (renders serial, rasters parallel; dispose-close late bitmaps): Task 4. ✓
- Pixel-parity + bitmap-ownership invariants: Task 5 step 3 (parity) + Task 4 (dispose-close) + Task 3 (inline parity preserved). ✓
- Testing: DI'd transport node units (Tasks 1, 3, 4) + real-WebView2 regression vs baseline (Task 5). ✓
- Font follow-up: out of this plan (noted in spec; catalog has no font-bundling template). ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; exact paths + commands throughout.

**Type consistency:** `RasterSlot { rasterize(svg): Promise<ImageBitmap>; dispose() }` (Task 1) is what `createIframeRasterSlot` returns (Task 2) and what the fake slots implement (Task 1 test). `RasterPool` (Task 1) is imported by `rasterSlot.ts` (Task 2) and typed in `svgRaster.ts` (Task 3) + its test. `getRasterPool(): RasterPool | null` (Task 2) is consumed by `rasterizeSvg` (Task 3). `rasterizeSvgVia(pool, inline, svg)` (Task 3) signature matches its test. `PrewarmContentSpec` (existing) reused in Task 4's `batch` type. `rasterizeSvg(svg)` signature unchanged, so `rasterTemplateFrame`/export-bake/picker callers are untouched.
