# Template Lookahead Prewarm (L1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background, budget-paced prewarmer fills the existing template frame cache ahead of the playhead so multi-template playback hits the cache instead of freezing on async raster misses.

**Architecture:** Factor the per-frame identity + raster primitives into shared modules; add a pure target-planner; add a `TemplatePrewarmer` (dependency-injected, idle-scheduled) that the Compositor drives with the playhead + active template contents. The on-demand `captureAndBind` path stays as fallback. In-RAM only; no new cache tier.

**Tech Stack:** TypeScript, PixiJS compositor, `requestIdleCallback`, vitest, real-WebView2 verification.

**Branch:** `feat/template-prewarm` (created; spec committed).

**Spec:** `docs/superpowers/specs/2026-06-06-template-lookahead-prewarm-design.md`

**Test commands:** from `apps/desktop` → `npm test -- <path>` (vitest), `npm run typecheck`.

---

## Task 1: Shared `templateFrameDescriptor` + refactor `TemplateSprite.update`

Extract the frame-identity computation so the sprite and the prewarmer can never disagree.

**Files:**
- Create: `apps/desktop/src/render/templates/templateFrameDescriptor.ts`
- Test: `apps/desktop/src/render/templates/templateFrameDescriptor.test.ts`
- Modify: `apps/desktop/src/render/sprite/TemplateSprite.ts` (preview path ~221-278)

- [ ] **Step 1: Write the helper + failing test**

Create `apps/desktop/src/render/templates/templateFrameDescriptor.ts`:

```ts
import type { TemplateView } from "../../ipc";
import { canonicalizeProps } from "./Rasterizer";
import { resolveTemplateContentDurationUs, type Template } from "./catalog";
import { frameTimeSec, templateContentFrame, templateFrameCacheKey } from "../sprite/TemplateSprite";

const US_PER_SEC = 1_000_000;

/// The cache identity + render inputs for one template frame at `tInLayerUs`.
/// Single source of truth shared by the on-demand sprite path and the
/// prewarmer, so they can never disagree on `(cacheKey, contentFrame)`.
/// `durationUs` is the LAYER width (used only for uncapped templates, which
/// have no content cap). Returns `null` when props canonicalization fails.
export interface TemplateFrameDescriptor {
  cacheKey: string;
  contentFrame: number;
  contentDurationFrames: number;
  contentDurationUs: number;
  srcInUs: number;
  renderW: number;
  renderH: number;
  canonicalProps: Record<string, unknown>;
  tSec: number;
  durationSec: number;
}

export function templateFrameDescriptor(
  view: TemplateView,
  tInLayerUs: number,
  durationUs: number,
  fpsNum: number,
  fpsDen: number,
  template: Template,
): TemplateFrameDescriptor | null {
  let canonicalProps: Record<string, unknown>;
  try {
    canonicalProps = canonicalizeProps(view.props, template.manifest);
  } catch {
    return null;
  }
  const cap = resolveTemplateContentDurationUs(template.manifest, view.props);
  const contentDurationUs = cap ?? durationUs;
  const srcInUs = cap == null ? 0 : view.src_in_us;
  const { frame, contentDurationFrames } = templateContentFrame(
    tInLayerUs,
    srcInUs,
    contentDurationUs,
    fpsNum,
    fpsDen,
  );
  const [renderW, renderH] = template.manifest.size;
  const cacheKey = templateFrameCacheKey({
    templateId: template.manifest.id,
    version: template.manifest.version,
    canonicalProps,
    renderW,
    renderH,
    fpsNum,
    fpsDen,
    durationFrames: contentDurationFrames,
  });
  return {
    cacheKey,
    contentFrame: frame,
    contentDurationFrames,
    contentDurationUs,
    srcInUs,
    renderW,
    renderH,
    canonicalProps,
    tSec: frameTimeSec(frame, fpsNum, fpsDen),
    durationSec: contentDurationUs / US_PER_SEC,
  };
}
```

Create `apps/desktop/src/render/templates/templateFrameDescriptor.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { getTemplate } from "./catalog";
import { templateFrameDescriptor } from "./templateFrameDescriptor";
import { templateContentFrame, templateFrameCacheKey } from "../sprite/TemplateSprite";
import { canonicalizeProps } from "./Rasterizer";
import { resolveTemplateContentDurationUs } from "./catalog";

function view(props: Record<string, unknown>, srcInUs = 0) {
  return { template_id: "countdown", x: 0, y: 0, scale_x: 1, scale_y: 1, opacity: 1, src_in_us: srcInUs, props } as any;
}

describe("templateFrameDescriptor", () => {
  const tpl = getTemplate("countdown")!;
  it("matches the inline cacheKey + contentFrame computation (capped countdown)", () => {
    const v = view({ seconds: 6, color: "#ff3366" });
    const tInLayerUs = 2_000_000;
    const durationUs = 5_000_000; // layer width (irrelevant for capped)
    const d = templateFrameDescriptor(v, tInLayerUs, durationUs, 30, 1, tpl)!;
    // Recompute the way TemplateSprite does:
    const canonical = canonicalizeProps(v.props, tpl.manifest);
    const cap = resolveTemplateContentDurationUs(tpl.manifest, v.props)!;
    const { frame, contentDurationFrames } = templateContentFrame(tInLayerUs, 0, cap, 30, 1);
    const expectedKey = templateFrameCacheKey({
      templateId: "countdown", version: tpl.manifest.version, canonicalProps: canonical,
      renderW: tpl.manifest.size[0], renderH: tpl.manifest.size[1], fpsNum: 30, fpsDen: 1,
      durationFrames: contentDurationFrames,
    });
    expect(d.cacheKey).toBe(expectedKey);
    expect(d.contentFrame).toBe(frame);
    expect(d.contentDurationFrames).toBe(contentDurationFrames);
  });
  it("applies src_in for a windowed layer", () => {
    const d = templateFrameDescriptor(view({ seconds: 6 }, 1_000_000), 0, 6_000_000, 30, 1, tpl)!;
    expect(d.srcInUs).toBe(1_000_000);
    expect(d.contentFrame).toBe(30); // src_in 1s @30fps
  });
});
```

NOTE: adapt the `view(...)` cast to the real `TemplateView` shape if fields differ (check `ipc/index.ts`). `getTemplate("countdown")` is a sync catalog lookup; if the catalog isn't populated in the node test env, check how `catalog.test.ts` accesses templates and mirror it (it imports from `./catalog`).

- [ ] **Step 2: Run the test — expect FAIL (module missing), then PASS after creating it**

Run (from `apps/desktop`): `npm test -- src/render/templates/templateFrameDescriptor.test.ts`

- [ ] **Step 3: Refactor `TemplateSprite.update` to use the descriptor**

In `TemplateSprite.ts`, replace the preview-path block (the `let canonical … ` through the `cacheKey` construction, ~lines 221-262) with a call to `templateFrameDescriptor`. Keep the `targetCacheKey`/`targetFrame` no-op guard, the cache-hit bind, and the `captureAndBind` fallback. The replacement:

```ts
    const desc = templateFrameDescriptor(
      view,
      tInLayerUs,
      durationUs,
      this.fpsNum,
      this.fpsDen,
      this.template,
    );
    if (!desc) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] TemplateSprite ${this.layerId}: canonicalize failed`);
      return;
    }
    const { cacheKey, contentFrame: frame, tSec, durationSec, canonicalProps: canonical } = desc;

    if (cacheKey === this.targetCacheKey && frame === this.targetFrame) return;
    this.targetCacheKey = cacheKey;
    this.targetFrame = frame;

    const cached = sharedTemplateFrameCache.getFrame(cacheKey, frame);
    if (cached) {
      this.bindBitmap(cached);
      return;
    }
    void this.captureAndBind(cacheKey, frame, tSec, durationSec, canonical);
```

Add the import at the top of `TemplateSprite.ts`:
```ts
import { templateFrameDescriptor } from "../templates/templateFrameDescriptor";
```
WATCH for an import cycle: `templateFrameDescriptor.ts` imports `templateContentFrame`/`templateFrameCacheKey`/`frameTimeSec` from `TemplateSprite.ts`, and `TemplateSprite.ts` now imports `templateFrameDescriptor` from it. ES module cycles are tolerated by the bundler when the imports are only used inside function bodies (not at module top-level eval) — both sides here use them only inside functions, so it's fine. If typecheck/runtime complains, move `templateContentFrame`/`templateFrameCacheKey`/`frameTimeSec`/`templateDurationFrames` into a small `templateFrames.ts` that both import (no cycle). Prefer the no-cycle split if there's any doubt.

- [ ] **Step 4: Verify no behavior change**

Run (from `apps/desktop`): `npm test` (full suite — `TemplateSprite.test.ts` + others still pass) and `npm run typecheck` (clean).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/templates/templateFrameDescriptor.ts apps/desktop/src/render/templates/templateFrameDescriptor.test.ts apps/desktop/src/render/sprite/TemplateSprite.ts
git commit -m "refactor(templates): shared templateFrameDescriptor for sprite + prewarmer"
```

---

## Task 2: Shared raster primitives (`templateRaster.ts`) + `cache.hasFrame`

Move the cache singleton + harness accessor into a shared module so the prewarmer uses the SAME cache + harness as the sprites, and add a recency-neutral presence check.

**Files:**
- Create: `apps/desktop/src/render/templates/templateRaster.ts`
- Modify: `apps/desktop/src/render/sprite/TemplateSprite.ts` (use the shared primitives)
- Modify: `apps/desktop/src/render/templates/frameCache.ts` (add `hasFrame`)
- Test: `apps/desktop/src/render/templates/frameCache.test.ts` (add a `hasFrame` test)

- [ ] **Step 1: Add `hasFrame` to the cache (failing test first)**

In `frameCache.test.ts` add:
```ts
  it("hasFrame peeks without changing recency", () => {
    const cache = new TemplateFrameCache(2);
    const a = makeBmp(); const b = makeBmp(); const c = makeBmp();
    cache.setFrame("k", 0, a); // [k#0]
    cache.setFrame("k", 1, b); // [k#0, k#1]
    expect(cache.hasFrame("k", 0)).toBe(true);
    expect(cache.hasFrame("k", 2)).toBe(false);
    // hasFrame(k#0) must NOT have refreshed recency, so adding k#2 evicts k#0 (LRU).
    cache.setFrame("k", 2, c); // cap 2 → evicts LRU (k#0)
    expect(cache.hasFrame("k", 0)).toBe(false);
    expect(cache.hasFrame("k", 1)).toBe(true);
    expect(cache.hasFrame("k", 2)).toBe(true);
  });
```
(Use the file's existing `makeBmp` stub.)

Run: `npm test -- src/render/templates/frameCache.test.ts` → FAIL (`hasFrame` undefined).

In `frameCache.ts` add (near `getFrame`):
```ts
  /// True when (cacheKey, frameIndex) is held, WITHOUT touching recency
  /// (unlike getFrame). The prewarmer uses this to skip already-cached targets
  /// so a peek can't reorder the LRU.
  hasFrame(cacheKey: string, frameIndex: number): boolean {
    return this.store.has(frameMapKey(cacheKey, frameIndex));
  }
```
Run again → PASS.

- [ ] **Step 2: Create `templateRaster.ts` (move cache + harness + a raster primitive)**

Create `apps/desktop/src/render/templates/templateRaster.ts`:
```ts
import { TemplateFrameCache } from "./frameCache";
import { TemplateHarness } from "./harness";
import { rasterizeSvg } from "./svgRaster";
import type { Template } from "./catalog";

/// Process-wide per-frame cache shared by every TemplateSprite AND the
/// prewarmer, so identical (template, props, dims, fps, frame) rasters resolve
/// from one bitmap. Single instance — import this, never `new`.
export const sharedTemplateFrameCache = new TemplateFrameCache();

interface HarnessEntry {
  harness: TemplateHarness;
  ready: Promise<void>;
}
const harnessByTemplateId = new Map<string, HarnessEntry>();

/// Get (or lazily mount) the shared harness for `template`. Touches the DOM
/// (iframe + listener) — main thread only, never the export Worker.
export function harnessFor(template: Template): HarnessEntry {
  let entry = harnessByTemplateId.get(template.manifest.id);
  if (!entry) {
    const harness = new TemplateHarness();
    entry = { harness, ready: harness.load(template) };
    harnessByTemplateId.set(template.manifest.id, entry);
  }
  return entry;
}

/// Render one template frame to an ImageBitmap via the shared harness. Shared
/// by the on-demand sprite path and the prewarmer. Does NOT touch the cache —
/// callers `setFrame` the result (idempotent).
export async function rasterTemplateFrame(
  template: Template,
  tSec: number,
  durationSec: number,
  canonicalProps: Record<string, unknown>,
): Promise<ImageBitmap> {
  const entry = harnessFor(template);
  await entry.ready;
  const svg = await entry.harness.renderFrameSvg(tSec, durationSec, canonicalProps);
  return rasterizeSvg(svg);
}
```

- [ ] **Step 3: Point `TemplateSprite` at the shared primitives**

In `TemplateSprite.ts`:
- Delete the local `const sharedTemplateFrameCache = new TemplateFrameCache();`, the `HarnessEntry` interface, the `harnessByTemplateId` map, and the local `harnessFor` function.
- Import from the new module:
  ```ts
  import { harnessFor, rasterTemplateFrame, sharedTemplateFrameCache } from "../templates/templateRaster";
  ```
  (Drop now-unused imports of `TemplateFrameCache`, `TemplateHarness`, `rasterizeSvg` if they're no longer referenced in this file.)
- In `captureAndBind`, replace the inline `harnessFor(...) → ready → renderFrameSvg → rasterizeSvg` with:
  ```ts
      const bitmap = await rasterTemplateFrame(this.template, tSec, durationSec, canonicalProps);
      const canonical = sharedTemplateFrameCache.setFrame(cacheKey, frame, bitmap);
      if (this.disposed) return;
      if (this.targetCacheKey !== cacheKey || this.targetFrame !== frame) return;
      this.bindBitmap(canonical);
      this.onLoaded?.();
  ```

- [ ] **Step 4: Verify refactor is behavior-preserving**

`npm test` (full suite green — frameCache + TemplateSprite tests) and `npm run typecheck` (clean). The shared cache must remain a single instance (one `new` in `templateRaster.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/templates/templateRaster.ts apps/desktop/src/render/templates/frameCache.ts apps/desktop/src/render/templates/frameCache.test.ts apps/desktop/src/render/sprite/TemplateSprite.ts
git commit -m "refactor(templates): shared templateRaster (cache+harness+raster) and cache.hasFrame"
```

---

## Task 3: `planPrewarmTargets` pure planner

**Files:**
- Create: `apps/desktop/src/render/templates/prewarmPlan.ts`
- Test: `apps/desktop/src/render/templates/prewarmPlan.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/render/templates/prewarmPlan.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { planPrewarmTargets } from "./prewarmPlan";

describe("planPrewarmTargets", () => {
  it("warms the whole content when it fits the budget, playhead-first then forward then backfill", () => {
    const plan = planPrewarmTargets([{ cacheKey: "a", contentFrame: 2, contentDurationFrames: 5 }], 240);
    // current → forward → earlier
    expect(plan).toEqual([
      { cacheKey: "a", frame: 2 },
      { cacheKey: "a", frame: 3 },
      { cacheKey: "a", frame: 4 },
      { cacheKey: "a", frame: 0 },
      { cacheKey: "a", frame: 1 },
    ]);
  });
  it("windows to the per-content budget when content exceeds it (forward from current)", () => {
    // cap 4, one content of 100 frames → budget 4, window [10..13]
    const plan = planPrewarmTargets([{ cacheKey: "a", contentFrame: 10, contentDurationFrames: 100 }], 4);
    expect(plan).toEqual([
      { cacheKey: "a", frame: 10 },
      { cacheKey: "a", frame: 11 },
      { cacheKey: "a", frame: 12 },
      { cacheKey: "a", frame: 13 },
    ]);
  });
  it("splits the budget across contents and round-robins (union <= cap)", () => {
    const plan = planPrewarmTargets(
      [
        { cacheKey: "a", contentFrame: 0, contentDurationFrames: 100 },
        { cacheKey: "b", contentFrame: 0, contentDurationFrames: 100 },
      ],
      4, // budget 2 each
    );
    expect(plan).toEqual([
      { cacheKey: "a", frame: 0 },
      { cacheKey: "b", frame: 0 },
      { cacheKey: "a", frame: 1 },
      { cacheKey: "b", frame: 1 },
    ]);
    expect(plan.length).toBeLessThanOrEqual(4);
  });
  it("dedups contents by cacheKey", () => {
    const plan = planPrewarmTargets(
      [
        { cacheKey: "a", contentFrame: 0, contentDurationFrames: 3 },
        { cacheKey: "a", contentFrame: 0, contentDurationFrames: 3 },
      ],
      240,
    );
    expect(plan).toEqual([
      { cacheKey: "a", frame: 0 },
      { cacheKey: "a", frame: 1 },
      { cacheKey: "a", frame: 2 },
    ]);
  });
});
```

Run: `npm test -- src/render/templates/prewarmPlan.test.ts` → FAIL.

- [ ] **Step 2: Implement**

Create `apps/desktop/src/render/templates/prewarmPlan.ts`:
```ts
export interface PrewarmContent {
  cacheKey: string;
  /// Content frame at the current playhead (0-based; clamped to the content).
  contentFrame: number;
  contentDurationFrames: number;
}

export interface PrewarmTarget {
  cacheKey: string;
  frame: number;
}

/// Plan which (cacheKey, frame) to ensure cached, in priority order. Dedups
/// contents by cacheKey; each content gets a per-content budget = floor(cap /
/// uniqueContentCount) (>= 1), or the WHOLE content when it fits. Per content
/// the order is playhead-first: contentFrame, then forward to the budget edge,
/// then the earlier frames (backfill for small backward scrubs). Contents are
/// ROUND-ROBINED so one long content can't starve others. The union never
/// exceeds `cap`, so the LRU can't evict a still-targeted frame.
export function planPrewarmTargets(
  contents: PrewarmContent[],
  cap: number,
): PrewarmTarget[] {
  // Dedup by cacheKey (keep first occurrence).
  const seen = new Set<string>();
  const uniq: PrewarmContent[] = [];
  for (const c of contents) {
    if (seen.has(c.cacheKey)) continue;
    seen.add(c.cacheKey);
    uniq.push(c);
  }
  if (uniq.length === 0) return [];
  const budget = Math.max(1, Math.floor(cap / uniq.length));

  // Per content, the ordered frame list (playhead-first → forward → backfill),
  // truncated to min(budget, contentDurationFrames).
  const perContent: number[][] = uniq.map((c) => {
    const n = c.contentDurationFrames;
    const want = Math.min(budget, n);
    const start = Math.max(0, Math.min(c.contentFrame, n - 1));
    const order: number[] = [];
    // current → forward
    for (let f = start; f < n && order.length < want; f++) order.push(f);
    // backfill earlier frames
    for (let f = 0; f < start && order.length < want; f++) order.push(f);
    return order;
  });

  // Round-robin interleave across contents.
  const out: PrewarmTarget[] = [];
  const maxLen = perContent.reduce((m, a) => Math.max(m, a.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (let c = 0; c < uniq.length; c++) {
      const frames = perContent[c]!;
      if (i < frames.length) out.push({ cacheKey: uniq[c]!.cacheKey, frame: frames[i]! });
    }
  }
  return out;
}
```

- [ ] **Step 3: Run → PASS.** `npm test -- src/render/templates/prewarmPlan.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/render/templates/prewarmPlan.ts apps/desktop/src/render/templates/prewarmPlan.test.ts
git commit -m "feat(templates): planPrewarmTargets (whole-or-window, playhead-first, round-robin)"
```

---

## Task 4: `TemplatePrewarmer` + Compositor integration

**Files:**
- Create: `apps/desktop/src/render/templates/TemplatePrewarmer.ts`
- Test: `apps/desktop/src/render/templates/TemplatePrewarmer.test.ts`
- Modify: `apps/desktop/src/render/Compositor.ts`

- [ ] **Step 1: Write the prewarmer (dependency-injected for testability)**

Create `apps/desktop/src/render/templates/TemplatePrewarmer.ts`:
```ts
import { planPrewarmTargets, type PrewarmContent } from "./prewarmPlan";

/// One active template content the prewarmer can rasterize. The planning fields
/// (cacheKey, contentFrame, contentDurationFrames) come from
/// `templateFrameDescriptor`; the render fields let the prewarmer raster any
/// frame of the content (durationSec + canonicalProps are frame-independent;
/// tSec is derived per frame by the renderer).
export interface PrewarmContentSpec extends PrewarmContent {
  render: (frame: number) => Promise<ImageBitmap>;
}

export interface TemplatePrewarmerDeps {
  cap: number;
  hasFrame: (cacheKey: string, frame: number) => boolean;
  setFrame: (cacheKey: string, frame: number, bmp: ImageBitmap) => void;
  /// Schedule a callback for "later" (idle). Returns a cancel token. Real impl:
  /// requestIdleCallback with a setTimeout fallback. Tests inject a manual one.
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  /// Max frames to raster per scheduled batch before yielding. Keeps the loop
  /// off the play tick's back.
  batchSize?: number;
}

/// Budget-paced background filler. `setTargets` (re)plans; an idle loop rasters
/// missing frames in priority order until the plan is fully cached, yielding
/// between batches. Never owns bitmaps (the cache does). Preview-only.
export class TemplatePrewarmer {
  private specsByKey = new Map<string, PrewarmContentSpec>();
  private queue: { cacheKey: string; frame: number }[] = [];
  private scheduled: number | null = null;
  private running = false;
  private disposed = false;
  private readonly batchSize: number;

  constructor(private readonly deps: TemplatePrewarmerDeps) {
    this.batchSize = deps.batchSize ?? 3;
  }

  /// Replace the active contents (deduped by cacheKey by the planner) and the
  /// playhead-relative plan, then (re)arm the loop.
  setTargets(specs: PrewarmContentSpec[]): void {
    if (this.disposed) return;
    this.specsByKey = new Map(specs.map((s) => [s.cacheKey, s]));
    this.queue = planPrewarmTargets(specs, this.deps.cap);
    this.arm();
  }

  private arm(): void {
    if (this.disposed || this.running || this.scheduled != null) return;
    if (this.queue.length === 0) return;
    this.scheduled = this.deps.schedule(() => {
      this.scheduled = null;
      void this.drainBatch();
    });
  }

  private async drainBatch(): Promise<void> {
    if (this.disposed) return;
    this.running = true;
    try {
      let done = 0;
      while (done < this.batchSize && this.queue.length > 0) {
        const target = this.queue.shift()!;
        if (this.deps.hasFrame(target.cacheKey, target.frame)) continue; // already cached
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) continue; // content no longer active
        try {
          const bmp = await spec.render(target.frame);
          if (this.disposed) return;
          this.deps.setFrame(target.cacheKey, target.frame, bmp);
        } catch {
          // Raster failed (e.g. harness disposed) — drop this target, keep going.
        }
        done++;
      }
    } finally {
      this.running = false;
      this.arm(); // more to do? reschedule. else idle.
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled != null) {
      this.deps.cancel(this.scheduled);
      this.scheduled = null;
    }
    this.queue = [];
    this.specsByKey.clear();
  }
}
```

Create `apps/desktop/src/render/templates/TemplatePrewarmer.test.ts` (manual scheduler, fake raster — no DOM):
```ts
import { describe, expect, it, vi } from "vitest";
import { TemplatePrewarmer, type PrewarmContentSpec } from "./TemplatePrewarmer";

function makeBmp(): ImageBitmap { return { close() {} } as unknown as ImageBitmap; }

describe("TemplatePrewarmer", () => {
  it("rasters missing targets in plan order, skips cached, stops when done", async () => {
    const cached = new Set<string>();
    const setSpy = vi.fn((k: string, f: number) => cached.add(`${k}#${f}`));
    const renderSpy = vi.fn(async (_f: number) => makeBmp());
    // Manual scheduler: collect callbacks, run them on demand.
    const pending: (() => void)[] = [];
    const prewarmer = new TemplatePrewarmer({
      cap: 240,
      hasFrame: (k, f) => cached.has(`${k}#${f}`),
      setFrame: setSpy,
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: () => {},
      batchSize: 2,
    });
    const spec: PrewarmContentSpec = {
      cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render: renderSpy,
    };
    prewarmer.setTargets([spec]);
    // Drain batches until the scheduler stops arming.
    let guard = 0;
    while (pending.length > 0 && guard++ < 20) {
      const cb = pending.shift()!;
      cb();
      await Promise.resolve(); await Promise.resolve(); // let async drainBatch settle
    }
    expect(renderSpy).toHaveBeenCalledTimes(3); // frames 0,1,2
    expect(cached.has("a#0") && cached.has("a#1") && cached.has("a#2")).toBe(true);
  });

  it("dispose cancels and stops rastering", async () => {
    const pending: (() => void)[] = [];
    const renderSpy = vi.fn(async () => makeBmp());
    const prewarmer = new TemplatePrewarmer({
      cap: 240, hasFrame: () => false, setFrame: () => {},
      schedule: (cb) => { pending.push(cb); return pending.length; }, cancel: () => {}, batchSize: 1,
    });
    prewarmer.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 5, render: renderSpy }]);
    prewarmer.dispose();
    while (pending.length) { pending.shift()!(); await Promise.resolve(); }
    expect(renderSpy).not.toHaveBeenCalled();
  });
});
```
NOTE: the manual-drain test is timing-ish; if the `await Promise.resolve()` count is fragile, drain by flushing microtasks (`await new Promise(r => setTimeout(r, 0))`) between scheduler callbacks. Keep the asserted INTENT: all 3 frames rastered once, cached ones skipped, dispose prevents rasters.

- [ ] **Step 2: Run the prewarmer tests → iterate to PASS.** `npm test -- src/render/templates/TemplatePrewarmer.test.ts`

- [ ] **Step 3: Wire the prewarmer into the Compositor**

In `Compositor.ts`:
- Import:
  ```ts
  import { TemplatePrewarmer } from "./templates/TemplatePrewarmer";
  import { templateFrameDescriptor } from "./templates/templateFrameDescriptor";
  import { harnessFor, rasterTemplateFrame, sharedTemplateFrameCache } from "./templates/templateRaster";
  import { getTemplate } from "./templates/catalog";
  ```
- Add a field + lazy creation (DOM-gated — the export Worker has no DOM and uses injected frames, so it must NOT create a prewarmer):
  ```ts
  private prewarmer: TemplatePrewarmer | null =
    typeof document !== "undefined"
      ? new TemplatePrewarmer({
          cap: sharedTemplateFrameCache.capacity(),
          hasFrame: (k, f) => sharedTemplateFrameCache.hasFrame(k, f),
          setFrame: (k, f, b) => { sharedTemplateFrameCache.setFrame(k, f, b); },
          schedule: (cb) => scheduleIdle(cb),
          cancel: (t) => cancelIdle(t),
        })
      : null;
  private lastPrewarmFrame = -1;
  ```
  Add `capacity(): number { return this.maxFrames; }` to `TemplateFrameCache` (returns the cap) for the prewarmer's budget. And add module-level `scheduleIdle`/`cancelIdle` helpers in Compositor.ts (or a tiny `idle.ts`):
  ```ts
  function scheduleIdle(cb: () => void): number {
    const g = globalThis as any;
    if (typeof g.requestIdleCallback === "function") return g.requestIdleCallback(cb, { timeout: 200 });
    return g.setTimeout(cb, 16) as unknown as number;
  }
  function cancelIdle(token: number): void {
    const g = globalThis as any;
    if (typeof g.cancelIdleCallback === "function") g.cancelIdleCallback(token);
    else g.clearTimeout(token);
  }
  ```
- In `setProject`, after rebuilding `layerById`, push targets (covers the on-load / paused-warm case):
  ```ts
  this.updatePrewarmTargets(this.lastTUs);
  ```
- In `compositeFrame`, after computing `tUsSnapped`, throttle by snapped frame and refresh targets:
  ```ts
  if (this.prewarmer) {
    const frameIdx = Math.round((tUsSnapped * this.fpsNum) / (1_000_000 * this.fpsDen));
    if (frameIdx !== this.lastPrewarmFrame) {
      this.lastPrewarmFrame = frameIdx;
      this.updatePrewarmTargets(tUsSnapped);
    }
  }
  ```
- Add the private builder that maps the project's template layers → `PrewarmContentSpec[]` at `tUsSnapped`:
  ```ts
  private updatePrewarmTargets(tUs: number): void {
    if (!this.prewarmer || !this.projectSummary) return;
    const specs: import("./templates/TemplatePrewarmer").PrewarmContentSpec[] = [];
    for (const track of this.projectSummary.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (!layer.enabled || layer.params.kind !== "Template") continue;
        const template = getTemplate(layer.params.template_id);
        if (!template) continue;
        const tInLayerUs = tUs - layer.t_start_us;
        const durationUs = layer.t_end_us - layer.t_start_us;
        const view = layer.params;
        const desc = templateFrameDescriptor(view, tInLayerUs, durationUs, this.fpsNum, this.fpsDen, template);
        if (!desc) continue;
        specs.push({
          cacheKey: desc.cacheKey,
          contentFrame: desc.contentFrame,
          contentDurationFrames: desc.contentDurationFrames,
          render: (frame: number) =>
            rasterTemplateFrame(
              template,
              // tSec for an arbitrary content frame:
              (frame * this.fpsDen) / this.fpsNum,
              desc.durationSec,
              desc.canonicalProps,
            ),
        });
      }
    }
    this.prewarmer.setTargets(specs);
  }
  ```
  (`(frame * fpsDen) / fpsNum` is `frameTimeSec(frame, …)` — import and use `frameTimeSec` for clarity if preferred.)
- In `dispose`, after disposing template sprites:
  ```ts
  this.prewarmer?.dispose();
  this.prewarmer = null;
  ```

WATCH: `harnessFor` import may be unused in Compositor (only `rasterTemplateFrame` is used) — drop unused imports to keep typecheck clean. Confirm `this.maxFrames`/`this.lastTUs` exist (lastTUs is set at the top of compositeFrame; if not present before setProject runs, default the prewarm call to 0). If `lastTUs` isn't initialized, add `private lastTUs = 0;`.

- [ ] **Step 4: Typecheck + full suite**

`npm run typecheck` → clean. `npm test` → green (no regressions; new prewarm + descriptor + plan tests pass).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/templates/TemplatePrewarmer.ts apps/desktop/src/render/templates/TemplatePrewarmer.test.ts apps/desktop/src/render/templates/frameCache.ts apps/desktop/src/render/Compositor.ts
git commit -m "feat(templates): lookahead prewarmer wired into the compositor"
```

---

## Task 5: Real-WebView2 stress verification + docs

- [ ] **Step 1: Launch + connect**

`npm run tauri:dev` (background) from `apps/desktop`; driver session on 9223; confirm backend state.

- [ ] **Step 2: Reproduce the stress scenario, confirm the fix**

Open a project; add several template layers (e.g. 4–6 countdowns across a few tracks, overlapping the playhead). Then:
1. Play from the start: templates should NOT freeze (no held-frame-while-playhead-advances). Capture screenshots at a few playhead positions showing the numerals advancing on every layer.
2. Console: confirm no miss-storm (the prewarmer fills ahead — sample `sharedTemplateFrameCache` size growth, or instrument that on-demand `captureAndBind` is rarely hit during steady play).
3. Pause mid-clip, wait ~1s, then seek elsewhere and play: should be smooth (cache pre-warmed around the playhead).
4. PerfHUD: composite time stable, heap bounded (the plan caps the warm set at the cache cap).

- [ ] **Step 3: Update docs (evergreen)**

In `docs/templates.md` "Raster cache and escalation", mark **L1 implemented**: a background prewarmer fills the shared cache ahead of the playhead (whole content when it fits, else a forward window), deduped by cacheKey, time-sliced via idle callbacks, continuous (play + paused). L2/disk + measurement-driven escalation remain design-only. Keep evergreen (present tense, no dates).

```bash
git add docs/templates.md
git commit -m "docs(templates): L1 lookahead prewarmer is implemented"
```

- [ ] **Step 4: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`.

---

## Self-Review

**Spec coverage:**
- Shared frame-descriptor (no drift): Task 1. ✓
- Warm the existing L0 cache; on-demand stays fallback: Task 2 (shared cache/raster) + Task 4 (prewarmer fills cache; sprite path untouched as fallback). ✓
- Dedup by cacheKey; whole-or-window; union ≤ cap; playhead-first + round-robin: Task 3 (`planPrewarmTargets`). ✓
- Continuous (play + paused/load); idle-scheduled, time-sliced, yields: Task 4 (`setProject` + throttled `compositeFrame` + `scheduleIdle` batches). ✓
- DOM-gated (skip export Worker): Task 4 (`typeof document !== "undefined"`). ✓
- Cap = budget, default unchanged: Task 4 (`cache.capacity()`). ✓
- Lifecycle/dispose: Task 4 (`prewarmer.dispose()` in Compositor.dispose). ✓
- Tests: descriptor (T1), hasFrame (T2), plan (T3), prewarmer loop (T4), WebView2 stress (T5). ✓

**Placeholder scan:** No TBD/TODO; full code in each step. NOTES flag where to confirm against real signatures (TemplateView shape, catalog access in node, lastTUs/maxFrames existence, import-cycle fallback) — explicit "verify against the file" instructions, not placeholders.

**Type consistency:** `templateFrameDescriptor(view, tInLayerUs, durationUs, fpsNum, fpsDen, template) → TemplateFrameDescriptor | null` used in T1 sprite refactor + T4 Compositor. `PrewarmContent{cacheKey,contentFrame,contentDurationFrames}` (T3) extended by `PrewarmContentSpec{…,render}` (T4). `planPrewarmTargets(contents, cap) → {cacheKey,frame}[]` consumed by the prewarmer. `sharedTemplateFrameCache`/`harnessFor`/`rasterTemplateFrame` (T2) imported by sprite + Compositor. `cache.hasFrame`/`cache.capacity` added in T2/T4.
