# Motifs Stage 4 — export baker → CDP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make exported Motif frames pixel-identical to the live preview by redirecting the export-time baker (`exportBake.ts`) from the SVG harness to the same CDP capture the preview uses — preserving the preview==export invariant and carrying the transparent backdrop into export. Add an L2-disk fast path so a pre-baked Motif exports without re-capturing.

**Architecture:** `exportBakeTemplates` runs on the MAIN thread, bakes every Motif layer's frames to an `ImageBitmap[]` (indexed by composition frame), and transfers them into the DOM-less export Worker, where `MotifSprite` binds them by index. Stage 4 swaps the per-frame producer from `TemplateHarness.renderFrameSvg` + `rasterizeSvg` (SVG) to `bakeMotifFrame` (CDP capture of the hidden Motif host — the exact call the preview prewarmer/baker already use). The pure frame-selection math (`bakeContentFrameFor`, `templateLayersToBake`), the canonicalize, the sparse-array indexing, the progress callback, and the "preparing" panel all carry over unchanged.

**Tech Stack:** TypeScript (Vitest), Tauri `invoke` (CDP via the hidden host), the real-WebView2 WebdriverIO e2e harness.

**Out of scope (Stage 5):** deleting the SVG machinery (`harness.ts`/`svgRaster.ts`/`Rasterizer.ts` etc. — Stage 4 stops *export* using them but the preview deletion is Stage 5), unifying the two catalogs, renaming the `templates/`/`bake_*` internals.

---

## Pre-flight

Current state (confirmed 2026-06-08):
- `exportBake.ts` → `exportBakeTemplates` loops per layer: `new TemplateHarness()` → `harness.load` → per content-frame `harness.renderFrameSvg(tSec, durationSec, canonical)` + `rasterizeSvg(svg)` → `frames[frame] = bitmap`. **This is the only SVG path left in export.**
- `bakeMotifFrame(template, frame, fpsNum, fpsDen, canonicalProps)` (in `render/motifs/motifRaster.ts`) computes `tSec = frame*fpsDen/fpsNum`, captures at `template.manifest.size`, and forwards `template.manifest.settle_rafs` — exactly what the per-frame export needs (pass the **content frame** as `frame`).
- Caller `App.tsx:926` calls `exportBakeTemplates(summary, startUs, endUs, comp.fps_num, comp.fps_den, onProgress)` behind a `{kind:"preparing"}` panel. **Signature unchanged by this plan → no caller change.**
- The preview L2 baker (`TemplateBaker` in `Compositor.ts`) writes PNGs via `sharedTemplateFrameCache.writePng(cacheKey, contentFrame, png)` and `sharedBakedKeyIndex.add(cacheKey)`; `cacheKey` from `templateFrameDescriptor(view, tInLayerUs, durationUs, fpsNum, fpsDen, template)` is playhead-independent (folds props/size/fps/content-duration), so it can be computed once per layer with `tInLayerUs=0`. PNGs are keyed by **content frame index** — the same index `bakeContentFrameFor` produces.
- Existing regression guard: `apps/desktop/e2e/specs/template_export.e2e.js` exports a 2 s countdown via `exportTemplateClip` and asserts two frames in different seconds differ (self-SSIM < 0.99 ⇒ the Motif animates in export, not static/black).

Baseline green before starting:
```
cd apps/desktop && npm run typecheck && npm test
cd apps/desktop/src-tauri && cargo test
```

---

## Task 1: Redirect the export baker to CDP capture

**Files:**
- Modify: `apps/desktop/src/render/exportBake.ts` (swap the raster source; drop the harness; update imports + header)
- Test: `apps/desktop/src/render/exportBake.test.ts` (add a mocked-source integration test for the bake loop)

- [ ] **Step 1: Write the failing integration test**

The raster half is now a single injectable call (`bakeMotifFrame`), so the loop wiring is Node-testable by mocking it. Append to `apps/desktop/src/render/exportBake.test.ts`:

```ts
import { vi } from "vitest";

// Mock the CDP producer so the bake loop is Node-testable (no host/DOM). The
// fake returns a tagged object per (motifId, contentFrame) so we can assert
// which content frame landed in which comp-frame slot.
vi.mock("../motifs/motifRaster", () => ({
  bakeMotifFrame: vi.fn(
    async (template, frame) =>
      ({ tag: `${template.manifest.id}#${frame}` }) as unknown as ImageBitmap,
  ),
}));

import { bakeMotifFrame } from "../motifs/motifRaster";
import { exportBakeTemplates } from "./exportBake";

describe("exportBakeTemplates → CDP (bakeMotifFrame)", () => {
  beforeEach(() => (bakeMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear());

  it("bakes a countdown layer's frames via bakeMotifFrame, indexed by comp frame", async () => {
    // 2 s countdown at 30 fps = 60 content frames [0..59], full range.
    const summary = summaryWith([templateLayer("L1", 0, 2_000_000)]);
    const out = await exportBakeTemplates(summary, 0, 2_000_000, 30, 1);

    // Per-layer array length = lastFrame+1 = 60; every slot filled by the CDP
    // producer; comp-frame slot 0 holds content frame 0, slot 59 holds 59
    // (this layer starts at t=0 with no src_in, so comp frame == content frame).
    expect(out.L1).toBeDefined();
    expect(out.L1.length).toBe(60);
    expect((out.L1[0] as unknown as { tag: string }).tag).toBe("countdown#0");
    expect((out.L1[59] as unknown as { tag: string }).tag).toBe("countdown#59");

    // The producer was called per baked frame at the manifest size implicitly
    // (bakeMotifFrame reads template.manifest.size); assert it got the content
    // frame + comp fps, and was NOT handed an SVG duration.
    expect(bakeMotifFrame).toHaveBeenCalledTimes(60);
    expect(bakeMotifFrame).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: expect.objectContaining({ id: "countdown" }) }),
      0,
      30,
      1,
      expect.any(Object),
    );
  });
});
```

(Reuse the file's existing `templateLayer` + `summaryWith` helpers. Put the `vi.mock` at the top of the file with the other imports — `vi.mock` is hoisted, so its placement among imports is fine, but keep it above the first use.)

- [ ] **Step 2: Run it — expect FAIL**

```
cd apps/desktop && npx vitest run src/render/exportBake.test.ts
```

Expected: FAIL — `exportBakeTemplates` still imports/uses `TemplateHarness` (the mock targets `bakeMotifFrame`, which isn't called yet), so `out.L1[0]` is not the tagged object / `bakeMotifFrame` called 0 times.

- [ ] **Step 3: Swap the raster source in `exportBake.ts`**

(a) Imports — remove the SVG-only ones, add the CDP producer. Change:

```ts
import { getTemplate, resolveTemplateContentDurationUs, type Template } from "./templates/catalog";
import { TemplateHarness } from "./templates/harness";
import { canonicalizeProps } from "./templates/Rasterizer";
import { rasterizeSvg } from "./templates/svgRaster";
import {
  frameTimeSec,
  templateDurationFrames,
} from "./templates/templateFrames";
```

to:

```ts
import { getTemplate, resolveTemplateContentDurationUs, type Template } from "./templates/catalog";
import { canonicalizeProps } from "./templates/Rasterizer";
import { bakeMotifFrame } from "./motifs/motifRaster";
import { templateDurationFrames } from "./templates/templateFrames";
```

(b) In `exportBakeTemplates`, replace the per-layer body. The current body opens a harness, computes `durationSec`, loops rasterizing SVG, and disposes the harness in `finally`. Replace the whole `for (const spec of specs) { ... }` body with:

```ts
  for (const spec of specs) {
    // Canonicalize props once per layer (identical across the layer's frames;
    // only the content frame varies). Mirrors the preview path's per-tick
    // canonicalize against the same manifest, so export pixels == preview.
    const canonical = canonicalizeProps(spec.view.props, spec.template.manifest);
    // Content-window model: src_in offset + intrinsic content duration. Uncapped
    // templates fall back to layer-width content with src_in=0 (legacy).
    const cap = resolveTemplateContentDurationUs(spec.template.manifest, spec.view.props);
    const contentDurationUs = cap ?? spec.durationUs;
    const srcInUs = cap == null ? 0 : spec.view.src_in_us;

    // Allocate up to lastFrame; leave [0, firstFrame) holes for a mid-layer
    // export start. Bitmaps land at their comp-frame index so the Worker's
    // frames[frameIndexInLayer(...)] is a direct hit.
    const frames: ImageBitmap[] = new Array(spec.lastFrame + 1);
    for (let frame = spec.firstFrame; frame <= spec.lastFrame; frame++) {
      const contentFrame = bakeContentFrameFor(
        frame,
        spec.tStartUs,
        srcInUs,
        contentDurationUs,
        fpsNum,
        fpsDen,
      );
      // CDP capture of the hidden Motif host — the SAME producer the preview
      // prewarmer/baker use (manifest size + manifest settle_rafs), so the
      // exported bitmap is pixel-identical to preview AND carries the Motif's
      // transparent backdrop. tSec is derived inside bakeMotifFrame as
      // contentFrame*fpsDen/fpsNum (== the old frameTimeSec(contentFrame)).
      // eslint-disable-next-line no-await-in-loop
      const bitmap = await bakeMotifFrame(spec.template, contentFrame, fpsNum, fpsDen, canonical);
      frames[frame] = bitmap;
      baked++;
      onProgress?.(baked, total);
    }
    result[spec.layerId] = frames;
  }
```

(No more `new TemplateHarness()` / `harness.load` / `harness.dispose` / `try…finally`, no `durationSec`, no `renderFrameSvg`/`rasterizeSvg`/`frameTimeSec`.)

(c) Update the module header (top of file). Replace the first two paragraphs (the "export Worker has no DOM, so the SVG capture harness…" + "CACHE HYGIENE… per-layer TemplateHarness…") with:

```ts
// Main-thread Motif pre-capture for export.
//
// The export Worker has no DOM and no Tauri `invoke`, so it can't capture
// Motif frames itself. Instead the MAIN thread captures EVERY frame of each
// Motif layer in the export range to an `ImageBitmap[]` (indexed by
// composition-frame) via the SAME CDP path the preview uses (`bakeMotifFrame`
// → `captureMotifFrame` → the hidden Motif host), and the bitmaps are
// TRANSFERRED into the Worker, where `MotifSprite` binds them by index
// synchronously. Export pixels are therefore identical to preview (one
// producer) and carry the Motif's transparent backdrop.
//
// The bake runs on the COMPOSITION fps grid — the same grid the Worker's
// Compositor uses when it constructs each `MotifSprite`. The export OUTPUT fps
// may differ; the Worker maps each output-frame time back to a composition
// frame index via `frameIndexInLayer(..., compFps)`, so the bake MUST be keyed
// on comp fps or the indices diverge.
//
// CACHE HYGIENE: this bake produces FRESH bitmaps (a CDP capture, or — Task 2 —
// a `createImageBitmap` of an on-disk L2 PNG) and never reads the in-RAM
// `sharedTemplateFrameCache` (L0). Transfer NEUTERS the source ImageBitmap;
// pulling L0 bitmaps would neuter preview's cached frames and break live
// preview after an export. (L2 *disk* reads are safe — they decode to a fresh
// bitmap, not a shared one.)
```

- [ ] **Step 4: Run the unit test — expect PASS**

```
cd apps/desktop && npx vitest run src/render/exportBake.test.ts
```

Expected: PASS (the new integration test + the existing pure-function tests).

- [ ] **Step 5: Typecheck + full unit suite**

```
cd apps/desktop && npm run typecheck && npm test
```

Expected: green. (Confirm no leftover import of `TemplateHarness`/`rasterizeSvg`/`frameTimeSec` in `exportBake.ts` trips `noUnusedLocals`.)

- [ ] **Step 6: Commit**

```
git add apps/desktop/src/render/exportBake.ts apps/desktop/src/render/exportBake.test.ts
git commit -m "feat(motifs): export baker captures via CDP (preview==export, transparent) (Stage 4)"
```

---

## Task 2: L2-disk fast path — skip re-capture for already-baked frames

**Why:** CDP capture is ~11–17 fps, so re-capturing a pre-baked Motif at export time wastes seconds. The preview L2 baker already persists the identical frames (same `cacheKey`, keyed by content frame). Reading them off disk is instant and safe (a fresh decode, not an L0 bitmap). This realizes spec §6 ("when a Motif is already L2-persisted, read the PNGs directly").

**Files:**
- Modify: `apps/desktop/src/render/exportBake.ts` (per-layer cacheKey; per-frame disk-first read, CDP fallback)
- Test: `apps/desktop/src/render/exportBake.test.ts` (disk-hit skips the CDP producer)

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/render/exportBake.test.ts`. Mock the shared cache's disk reads + the baked-key index alongside the existing `bakeMotifFrame` mock:

```ts
vi.mock("./templates/templateRaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./templates/templateRaster")>();
  return {
    ...actual,
    sharedBakedKeyIndex: { has: vi.fn(() => true) },
    sharedTemplateFrameCache: {
      readPng: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
    },
  };
});
```

Add a `createImageBitmap` stub for Node (vitest has no DOM) near the top of the file:

```ts
// jsdom/node has no createImageBitmap; stub it so the L2-read path is testable.
(globalThis as unknown as { createImageBitmap: (b: Blob) => Promise<ImageBitmap> }).createImageBitmap =
  vi.fn(async () => ({ tag: "from-disk" }) as unknown as ImageBitmap);
```

Then the test:

```ts
it("reads L2 PNGs off disk and does NOT re-capture when the key is baked", async () => {
  const summary = summaryWith([templateLayer("L1", 0, 2_000_000)]);
  const out = await exportBakeTemplates(summary, 0, 2_000_000, 30, 1);
  expect(out.L1.length).toBe(60);
  expect((out.L1[0] as unknown as { tag: string }).tag).toBe("from-disk");
  // Disk hit ⇒ the CDP producer is never called.
  expect(bakeMotifFrame).toHaveBeenCalledTimes(0);
});
```

(Note: the Task 1 test asserts `bakeMotifFrame` IS called; this one asserts it is NOT, under a baked key. Keep both — they exercise the two branches. The Task 1 test's `sharedBakedKeyIndex.has` must return false there; since the mock above returns `true` globally, give the Task 1 test its own describe with the index mocked to `false`, OR — simpler — set `has` per-test: in the Task 1 describe `beforeEach`, do `(sharedBakedKeyIndex.has as ReturnType<typeof vi.fn>).mockReturnValue(false)`, and in the Task 2 test set it to `true`. Import `sharedBakedKeyIndex` from `./templates/templateRaster` in the test to drive it.)

- [ ] **Step 2: Run it — expect FAIL** (`bakeMotifFrame` still called; no disk read wired)

```
cd apps/desktop && npx vitest run src/render/exportBake.test.ts
```

- [ ] **Step 3: Wire the disk-first read in `exportBake.ts`**

(a) Imports — add:

```ts
import { sharedBakedKeyIndex, sharedTemplateFrameCache } from "./templates/templateRaster";
import { templateFrameDescriptor } from "./templates/templateFrameDescriptor";
```

(b) In the per-layer loop, compute the cacheKey once (playhead-independent → `tInLayerUs = 0`), then prefer disk inside the frame loop:

```ts
    // L2 fast path: this layer's content cacheKey (window/time-independent), so
    // a per-frame on-disk PNG can be read instead of re-capturing. tInLayerUs=0
    // is fine — only desc.cacheKey is used (mirrors hydrateBakedIndexAndGc).
    const desc = templateFrameDescriptor(
      spec.view, 0, spec.durationUs, fpsNum, fpsDen, spec.template,
    );
    const cacheKey = desc?.cacheKey ?? null;
```

and inside the `for (let frame …)` loop, before the `bakeMotifFrame` call:

```ts
      const contentFrame = bakeContentFrameFor( /* …unchanged… */ );
      // Disk-first: a pre-baked Motif's PNGs are keyed by (cacheKey, content
      // frame); read + decode (a FRESH bitmap, safe to transfer) instead of a
      // ~80 ms CDP re-capture. Gated by the in-RAM baked-key index so an
      // un-baked Motif never pays a per-frame fs probe. Any read error falls
      // through to a live capture, so a disk hiccup can't blank an export.
      if (cacheKey && sharedBakedKeyIndex.has(cacheKey)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const png = await sharedTemplateFrameCache.readPng(cacheKey, contentFrame);
          if (png) {
            // eslint-disable-next-line no-await-in-loop
            frames[frame] = await createImageBitmap(png);
            baked++;
            onProgress?.(baked, total);
            continue;
          }
        } catch {
          // fall through to a live CDP capture
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const bitmap = await bakeMotifFrame(spec.template, contentFrame, fpsNum, fpsDen, canonical);
```

(Keep the rest of the loop — `frames[frame] = bitmap; baked++; onProgress?…` — unchanged for the capture branch.)

- [ ] **Step 4: Run the unit test — expect PASS**

```
cd apps/desktop && npx vitest run src/render/exportBake.test.ts
```

Expected: both branch tests pass (capture when not baked; disk-read when baked).

- [ ] **Step 5: Typecheck + full unit suite**

```
cd apps/desktop && npm run typecheck && npm test
```

Expected: green.

- [ ] **Step 6: Commit**

```
git add apps/desktop/src/render/exportBake.ts apps/desktop/src/render/exportBake.test.ts
git commit -m "feat(motifs): export reads L2 PNGs off disk, skipping CDP re-capture (Stage 4)"
```

---

## Task 3: Real-WebView2 verification (existing export e2e guard)

**Why:** `template_export.e2e.js` is the end-to-end gate that a countdown ANIMATES in the exported file. Post-redirect it proves the CDP export path produces a real, animating, non-black file. (It builds the app with the e2e hooks, exports a 2 s countdown, and self-SSIM-compares frames in different seconds.)

**Files:** none to write — run the existing spec. (Optionally extend it, Step 3.)

- [ ] **Step 1: Ensure no dev app holds the build lock**

The e2e does `tauri build --debug` and can't overwrite a running `weftcut.exe`. Confirm none is running:
```
powershell -Command "Get-Process weftcut -ErrorAction SilentlyContinue | Stop-Process -Force"
```

- [ ] **Step 2: Run the export e2e**

```
cd apps/desktop/e2e && npx wdio run ./wdio.conf.mjs --spec ./specs/template_export.e2e.js
```

Expected: `1 passing`; the `[e2e] template self-ssim report` shows `differ:true` (ssim well below 0.99). This confirms the countdown renders + animates in export via CDP. (msedgedriver must match the installed WebView2 — verified 148.0.3967.96 = 148.0.3967.96 on 2026-06-08.)

- [ ] **Step 3 (optional, recommended): add a transparency guard to the export e2e**

The self-SSIM "differ" test would still pass on a white-box regression (a white box with a changing numeral still differs). The transparent backdrop is already guarded at the capture layer (`motif_live_preview.e2e.js`), and export uses the identical capture — but a cheap export-side guard is worth it IF the analyzer can sample a pixel. If `analyzeSelf`/`media_conformance` exposes a corner-pixel readback, assert a transparent-region pixel of an exported countdown frame equals the composition background (black), not white. If it does not expose pixel sampling, SKIP this step (do not expand the Rust analyzer in Stage 4) and note that export transparency is covered transitively by the capture-layer guard.

- [ ] **Step 4: No commit** (verification only; any optional spec edit in Step 3 commits with message `test(motifs): export e2e asserts transparent backdrop (Stage 4)`).

---

## Completion

Use **superpowers:finishing-a-development-branch**. Final gate:
```
cd apps/desktop && npm run typecheck && npm test
cd apps/desktop/src-tauri && cargo test
```
plus the `template_export.e2e.js` pass (Task 3). Then merge to local `main` (ff, delete branch, unpushed — the Stage 1/2/3 norm).

**Update memory** on completion: Stage 4 done in `project_template_webview_engine.md` + the `MEMORY.md` hook; next = Stage 5 (delete SVG machinery + unify catalogs + rename internals).

---

## Self-review (author)

- **Spec coverage:** §6 export → Task 1 (CDP capture) + Task 2 (L2 disk-read "read the PNGs directly"). §9 staging item 4 (export baker redirect) → Task 1.
- **Invariant:** export==preview holds because both go through `bakeMotifFrame`→`captureMotifFrame` (same producer, manifest size, same `settle_rafs`, same canonicalize). Transparency carries over (Stage 3 fix is in the shared capture path).
- **No caller change:** `exportBakeTemplates` signature is unchanged; the "preparing" panel + `onProgress` already absorb the slower CDP bake.
- **Cache hygiene preserved:** still never reads L0; L2-disk reads decode fresh bitmaps (safe to transfer).
- **Risk:** the L2 cacheKey (Task 2) MUST byte-match the preview L2 baker's `templateFrameDescriptor` key, or the read misses (falls back to capture — correct but slow) or, worse, hits a stale key (can't: the key folds props/size/fps/content-duration, so a mismatch never collides). A miss is safe (capture fallback); only a *wrong hit* would be a bug, and the key construction is shared code.
- **Type consistency:** `bakeMotifFrame(template, contentFrame, fpsNum, fpsDen, canonical)` matches its Stage 2/3 signature; `templateFrameDescriptor`/`sharedBakedKeyIndex`/`sharedTemplateFrameCache`/`readPng` match their existing signatures.
