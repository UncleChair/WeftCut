# Motif Live-Preview Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `countdown` layer renders **live in the editor preview** by capturing frames through the Motif webcap CDP path (`captureMotifFrame`) instead of the SVG harness — proving CDP-in-the-live-compositor and the real per-frame round-trip cost, before the broad rename/prewarm/export/delete work.

**Architecture:** Reuse the entire existing template render pipeline (`TemplateSprite` → `resolveTemplateFrame` → `sharedTemplateFrameCache` + descriptor + frame-grid math) and swap ONLY the live-frame *producer*: `rasterTemplateFrame` (iframe SVG raster) → `rasterMotifFrame` (the Plan-1 `captureMotifFrame` IPC → Rust → CDP → PNG → `ImageBitmap`). No rename, no prewarm tuning, no export, no deletion yet. Choppy (~11 fps cold) is expected and acceptable for this slice.

**Tech Stack:** TypeScript (Vitest), the merged Motif capture core (`apps/desktop/src/render/motifs/host.ts` `captureMotifFrame`, the `motif:` scheme + hidden host + `motif_capture_frame` command), PixiJS compositor.

**Spec:** `docs/superpowers/specs/2026-06-07-motifs-editor-integration-design.md` (this is its staging step 2). Clean break — no backward compat.

---

## Context the implementer needs

- The preview frame source is chosen in `apps/desktop/src/render/templates/templateRaster.ts`:
  - `rasterTemplateFrame(template, tSec, durationSec, canonicalProps)` (line 50) — the SVG producer (iframe harness + `rasterizeSvg`). **This is what we bypass for Motifs.**
  - `resolveTemplateFrame(template, cacheKey, frame, tSec, durationSec, canonicalProps)` (line 77) — disk-PNG (L2) first, else `rasterTemplateFrame`. `TemplateSprite.captureAndBind` calls this on a cache miss.
- `TemplateSprite` (`apps/desktop/src/render/sprite/TemplateSprite.ts`) preview path (line 145-162): builds a descriptor (`templateFrameDescriptor` → `{ cacheKey, contentFrame, tSec, durationSec, canonicalProps, renderW, renderH }`), checks `sharedTemplateFrameCache.getFrame`, and on miss calls `captureAndBind` → `resolveTemplateFrame`.
- The Motif capture entry is `captureMotifFrame(motifId, tSec, props, width, height): Promise<ImageBitmap>` in `apps/desktop/src/render/motifs/host.ts` (Plan-1; invokes `motif_capture_frame`). It currently supports only the `countdown` built-in (single-Motif host).
- The built-in **Motif** `countdown` (`src-tauri/src/motifs/builtin/countdown/`) and the legacy **SVG template** `countdown` (the TS catalog `getTemplate("countdown")`) both declare `size [480,480]` and props `seconds`/`label`/`accent`. For this slice a `countdown` **template** layer (added via the existing `add_template`) supplies the descriptor metadata (size, props, frame grid) while the *pixels* come from the **Motif** countdown via CDP. They align, so this Frankenstein is fine for the slice; the later rename unifies them.

---

## Task 1: `rasterMotifFrame` — the CDP live producer

**Files:**
- Create: `apps/desktop/src/render/motifs/motifRaster.ts`
- Test: `apps/desktop/src/render/motifs/__tests__/motifRaster.test.ts`

- [ ] **Step 1: Write the failing test** (mock the host so no real IPC; assert it delegates to `captureMotifFrame` and bumps the perf instrument)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../host", () => ({
  captureMotifFrame: vi.fn(async () => ({ width: 480, height: 480 }) as unknown as ImageBitmap),
}));
import { captureMotifFrame } from "../host";
import { rasterMotifFrame } from "../motifRaster";

describe("rasterMotifFrame", () => {
  beforeEach(() => {
    (captureMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear();
    delete (globalThis as Record<string, unknown>).window;
  });

  it("delegates to captureMotifFrame with id, tSec, props, dims", async () => {
    const bmp = await rasterMotifFrame("countdown", 2.5, { seconds: 5 }, 480, 480);
    expect(captureMotifFrame).toHaveBeenCalledWith("countdown", 2.5, { seconds: 5 }, 480, 480);
    expect(bmp).toEqual({ width: 480, height: 480 });
  });

  it("bumps window.__weftcutTemplatePerf.renders when present", async () => {
    (globalThis as Record<string, unknown>).window = { __weftcutTemplatePerf: { renders: 0 } };
    await rasterMotifFrame("countdown", 0, {}, 480, 480);
    expect(((globalThis as Record<string, unknown>).window as { __weftcutTemplatePerf: { renders: number } }).__weftcutTemplatePerf.renders).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/desktop`): `npx vitest run src/render/motifs/__tests__/motifRaster.test.ts`
Expected: FAIL — cannot resolve `../motifRaster`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/render/motifs/motifRaster.ts
// The live per-frame producer for Motifs: captures one frame through the
// webcap CDP path. Drop-in replacement for the SVG `rasterTemplateFrame`,
// same perf instrument so existing e2e render-count assertions keep working.
import { captureMotifFrame } from "./host";

export async function rasterMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  if (typeof window !== "undefined") {
    const perf = (window as unknown as { __weftcutTemplatePerf?: { renders: number } })
      .__weftcutTemplatePerf;
    if (perf) perf.renders++;
  }
  return captureMotifFrame(motifId, tSec, props, width, height);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/render/motifs/__tests__/motifRaster.test.ts`
Expected: PASS (2 tests). Also run `npx tsc -b` (from apps/desktop) → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/motifs/motifRaster.ts apps/desktop/src/render/motifs/__tests__/motifRaster.test.ts
git commit -m "feat(motifs): rasterMotifFrame — CDP live frame producer"
```

---

## Task 2: Redirect the live producer in `resolveTemplateFrame`

**Files:**
- Modify: `apps/desktop/src/render/templates/templateRaster.ts` (the `resolveTemplateFrame` fallback, line ~93)
- Test: `apps/desktop/src/render/templates/__tests__/resolveTemplateFrame.test.ts`

The L2 disk-PNG branch stays (it's empty for this slice — nothing bakes yet — so it falls through). Only the **live-raster fallback** changes from SVG (`rasterTemplateFrame`) to CDP (`rasterMotifFrame`), passing the template's natural size as the capture dims.

- [ ] **Step 1: Write the failing test** (mock both producers + the baked index; assert the CDP producer is used on a cache/disk miss, with id + dims from the template)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../motifs/motifRaster", () => ({ rasterMotifFrame: vi.fn(async () => ({ id: "cdp" }) as unknown as ImageBitmap) }));
vi.mock("../svgRaster", () => ({ rasterizeSvg: vi.fn() }));
vi.mock("../harness", () => ({ TemplateHarness: class { load() { return Promise.resolve(); } } }));
import { rasterMotifFrame } from "../../motifs/motifRaster";
import { resolveTemplateFrame, sharedBakedKeyIndex } from "../templateRaster";

const template = { manifest: { id: "countdown", size: [480, 480] } } as unknown as Parameters<typeof resolveTemplateFrame>[0];

describe("resolveTemplateFrame → Motif CDP", () => {
  beforeEach(() => (rasterMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear());

  it("on a non-baked key, produces the frame via rasterMotifFrame with id + manifest size", async () => {
    expect(sharedBakedKeyIndex.has("k-not-baked")).toBe(false);
    const bmp = await resolveTemplateFrame(template, "k-not-baked", 7, 2.5, 5, { seconds: 5 });
    expect(rasterMotifFrame).toHaveBeenCalledWith("countdown", 2.5, { seconds: 5 }, 480, 480);
    expect(bmp).toEqual({ id: "cdp" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/templates/__tests__/resolveTemplateFrame.test.ts`
Expected: FAIL — `resolveTemplateFrame` still calls `rasterTemplateFrame` (SVG), so `rasterMotifFrame` is not called.

- [ ] **Step 3: Make the change** — in `templateRaster.ts`, import `rasterMotifFrame` and replace the final `return rasterTemplateFrame(...)` in `resolveTemplateFrame` (line ~93) with the Motif producer using the template's natural size:

```ts
// at top, with the other imports:
import { rasterMotifFrame } from "../motifs/motifRaster";

// at the end of resolveTemplateFrame, replace:
//   return rasterTemplateFrame(template, tSec, durationSec, canonicalProps);
// with:
  const [w, h] = template.manifest.size;
  // durationSec is unused by the CDP path (duration is derived Rust-side from
  // props in v1); kept in the signature for parity with the SVG era.
  void durationSec;
  return rasterMotifFrame(template.manifest.id, tSec, canonicalProps, w, h);
```

Leave `rasterTemplateFrame` defined for now (the prewarmer still imports it; this slice doesn't touch the prewarmer). It becomes dead in a later plan that deletes the SVG path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/render/templates/__tests__/resolveTemplateFrame.test.ts`
Expected: PASS. Then `npx vitest run src/render/` (no regressions in the render suite) and `npx tsc -b` (from apps/desktop) → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/templates/templateRaster.ts apps/desktop/src/render/templates/__tests__/resolveTemplateFrame.test.ts
git commit -m "feat(motifs): resolveTemplateFrame live path captures via CDP (Motif) not SVG"
```

---

## Task 3: End-to-end verification — countdown renders live in preview (real WebView2)

**Files:**
- Create: `apps/desktop/e2e/specs/motif_live_preview.e2e.js`
- Possibly extend: `apps/desktop/src/testhook/e2eHook.ts` (a dev hook to add a countdown layer + read the composited pixel), mirroring the existing `installMotifHook` pattern.

This proves the integration end to end: a countdown template layer, rendered through the live compositor, gets its pixels from the CDP capture (not the SVG harness), and animates with the playhead.

- [ ] **Step 1: Add the dev hook(s)** (behind the existing e2e/debug guard, mirroring `e2eHook.ts`'s `installMotifHook`): expose `window.__motifAddCountdown()` (calls `add_template` with `template_id:"countdown"`, a 5 s span, default props) and reuse the compositor's existing seek + a center-pixel readback (the Task-7 e2e already samples the canvas at (240,240) for the accent color). If the existing `motif_capture` e2e's pixel-readback helper can be reused, do so.

- [ ] **Step 2: Write the e2e spec**

```js
// apps/desktop/e2e/specs/motif_live_preview.e2e.js
describe("motif live preview (CDP in compositor)", () => {
  it("a countdown layer renders accent-colored content in the live preview", async () => {
    await browser.execute(() => window.__motifAddCountdown());
    // seek the playhead to mid-countdown and let the async CDP capture + bind settle
    await browser.execute(() => window.__weftcutSeekUs(2_500_000));
    await browser.pause(1500); // ~11fps cold capture + bind
    const px = await browser.execute(() => window.__weftcutSampleComposite(240, 240)); // {r,g,b,a}
    // accent #ff4d4d at center (numeral): red-dominant, opaque
    expect(px.r).toBeGreaterThan(180);
    expect(px.g).toBeLessThan(150);
    expect(px.b).toBeLessThan(150);
    expect(px.a).toBe(255);
  });
});
```

If `window.__weftcutSeekUs` / `window.__weftcutSampleComposite` don't already exist as dev hooks, add minimal ones in `e2eHook.ts` (seek the compositor to a µs time; read a pixel from the composited canvas) — mirror existing hook style. Reuse whatever the Task-7 `motif_capture` e2e used for pixel readback.

- [ ] **Step 3: Run to verify it fails** (hooks/wiring not complete yet)

Run: `npm --prefix apps/desktop run e2e -- --spec e2e/specs/motif_live_preview.e2e.js` (the e2e runner builds with `VITE_WEFTCUT_E2E=1`; msedgedriver must match the WebView2 build — the existing e2e suite already satisfies this).
Expected: FAIL until the hooks are wired.

- [ ] **Step 4: Wire until green**

Implement the hooks; re-run. Expected: PASS — the center pixel is accent-red, i.e. the countdown rendered live in the compositor via CDP capture.

- [ ] **Step 5: Confirm the SVG harness was NOT used** (optional but valuable)

In the spec, before adding the layer, set `window.__weftcutTemplatePerf = { renders: 0 }`; after the seek, assert `renders > 0` (the CDP producer bumps the same instrument) AND that no SVG iframe harness was mounted (e.g. `document.querySelectorAll('iframe').length` did not increase for the template path — or simply that the countdown rendered, which on the redirected path can only come from CDP). Keep this lightweight.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/e2e/specs/motif_live_preview.e2e.js apps/desktop/src/testhook/e2eHook.ts
git commit -m "test(motifs): e2e — countdown renders live in preview via CDP"
```

---

## Self-Review

**Spec coverage (this slice = spec stage 2 only):** frame-source redirect SVG→CDP in the live preview path → Tasks 1+2; "countdown renders live in preview (choppy, no prewarm)" → Task 3. Explicitly DEFERRED to later plans (per spec staging): the broad `Template`→`Motif` rename (stage 1, intentionally inverted to after this de-risking slice), prewarm/persist redirect + throughput opts + warming UX (stage 3), export baker redirect (stage 4), SVG-machinery deletion + picker rename (stage 5). The cache (L0 hit/miss) is exercised as-is; L2 disk-PNG is inert (nothing bakes yet) and correctly falls through.

**Placeholder scan:** Task 3's hook names (`__motifAddCountdown`, `__weftcutSeekUs`, `__weftcutSampleComposite`) are concrete; the step says to reuse the Task-7 e2e's existing pixel-readback if present and only add minimal hooks if not — that's a "reuse-or-add" instruction with the exact shape given, not a placeholder. No TBD/TODO.

**Type consistency:** `rasterMotifFrame(motifId, tSec, props, width, height)` (Task 1) is called identically in the Task-2 redirect and asserted identically in both tests. `captureMotifFrame(motifId, tSec, props, width, height)` matches the Plan-1 `host.ts` signature. `template.manifest.size` is `[number, number]` (catalog type) → `[w, h]`.

**Risk note (carry into execution):** the host supports only `countdown` (single-Motif). This slice uses exactly `countdown`, so it's in-bounds; a second motif id would error (by the Plan-1 guard) — that's expected and handled by the later milestone. The ~1.5 s pause in Task 3 reflects the measured ~11 fps cold capture; if flaky, increase it (this is a real latency property, not a test smell).
