# Motifs Stage 5a+5b — picker→CDP + delete the SVG machinery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Retire the SVG capture path entirely. (5a) Migrate the last live SVG consumer — the MotifPicker hover-preview — to a static CDP capture. (5b) Delete the now-dead SVG machinery (harness/svgRaster/rasterPool/rasterSlot/fontFace/wrapText + the dead `rasterTemplateFrame`), the dead Plan-1 `motifs/catalog.ts`/`interpolate.ts`, and the SVG-only e2e hooks/spec.

**Architecture:** After Stages 2–4, preview AND export both render Motifs via CDP (`captureMotifFrame`/`bakeMotifFrame`). The only remaining SVG users are the picker preview and two SVG-harness e2e hooks. 5a swaps the picker to a single CDP still (the picker's job is "show what this Motif looks like" — animation lives in the editor preview with the warming bar). 5b then deletes the orphaned SVG modules. `Rasterizer.canonicalizeProps`, `templateFrameDescriptor`, `frameCache`, the prewarmer/baker, and `renderTemplateSpriteFrames` (CDP MotifSprite e2e hook) all STAY — they're not SVG. The big `templates/`→`motifs/` rename + catalog field-unification is **Stage 5c (separate plan)**.

**Tech Stack:** TypeScript (Vitest), React, Tauri `invoke` (CDP).

**Out of scope (Stage 5c):** renaming `templates/`→`motifs/` dirs/files, `Template*`→`Motif*` type names, `bake_*` i18n, the Rust `templates::` module. 5a/5b only DELETE + migrate; they leave the legacy names in place (the Frankenstein shrinks but isn't renamed yet).

---

## Pre-flight (dependency findings, 2026-06-08)

- **Live SVG consumers:** `MotifPicker.tsx` `TemplatePreview` (`TemplateHarness.renderFrameSvg`→`<img>`); e2e hooks `renderTemplateFrameSvg`/`renderTestFixtureSvg` (`installTemplateHarnessHook`) + the `templates.e2e.js` spec.
- **Dead now (after Stage 4):** `rasterTemplateFrame` + `harnessFor`/`harnessByTemplateId` in `templateRaster.ts` (no callers); the Plan-1 `motifs/catalog.ts` + `motifs/interpolate.ts` (only their own tests import them); `wrapText.ts` (only its test).
- **KEEP:** `Rasterizer.ts` (`canonicalizeProps` — used by `exportBake` + `templateFrameDescriptor`); `templateFrameDescriptor`/`templateFrames`/`frameCache`/`templateRaster`(minus `rasterTemplateFrame`)/`prewarmPlan`/`bakePlan`/`bakedKeyIndex`/`pngEncode`/`prebakeBus`/`TemplatePrewarmer`/`TemplateBaker`; `renderTemplateSpriteFrames` (drives the real `MotifSprite`, CDP); `template_prebake.e2e.js` (L2 cache round-trip — CDP-backed now, no SVG).
- **Picker preview usage:** `<TemplatePreview>` at `MotifPicker.tsx:234` (large form preview, `animate`+`canvasFps`) and `:594` (`TemplateCardThumbnail`, static, width 240). `PREVIEW_T_SEC = 0`. Animated path uses `previewLoopTimeSec` (from `./previewLoop`) + `previewFps` state + the fps `<input>` (lines 568–584).

Baseline green before starting:
```
cd apps/desktop && npm run typecheck && npm test
cd apps/desktop/src-tauri && cargo test
```

---

## Task 1 (5a): Expose the captured PNG as a Blob from the host

**Why:** the picker displays an `<img>`; the cleanest CDP source is the PNG Blob (the bytes already exist pre-decode). Extract a Blob-returning helper that `captureMotifFrame` also reuses.

**Files:**
- Modify: `apps/desktop/src/render/motifs/host.ts`
- Test: `apps/desktop/src/render/motifs/__tests__/host.test.ts` (new — small)

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/render/motifs/__tests__/host.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { captureMotifFramePngBlob } from "../host";

describe("captureMotifFramePngBlob", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes motif_capture_frame and returns a PNG Blob of the decoded base64", async () => {
    // base64 of bytes [1,2,3] is "AQID"
    invokeMock.mockResolvedValue("AQID");
    const blob = await captureMotifFramePngBlob("countdown", 2.5, { seconds: 5 }, 480, 480, 1);
    expect(invokeMock).toHaveBeenCalledWith("motif_capture_frame", {
      motifId: "countdown",
      tSec: 2.5,
      propsJson: JSON.stringify({ seconds: 5 }),
      width: 480,
      height: 480,
      settleRafs: 1,
    });
    expect(blob.type).toBe("image/png");
    expect(await blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b)))).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`captureMotifFramePngBlob` not exported)

```
cd apps/desktop && npx vitest run src/render/motifs/__tests__/host.test.ts
```

- [ ] **Step 3: Refactor `host.ts`**

Replace the body so `captureMotifFrame` delegates to a new exported `captureMotifFramePngBlob`:

```ts
import { invoke } from "@tauri-apps/api/core";

/**
 * Render a Motif to a single frame and return the raw PNG as a `Blob`.
 * Drives the Rust `motif_capture_frame` command (CDP `Page.captureScreenshot`).
 * The PNG is taint-free (CDP screenshot, not a canvas readback).
 */
export async function captureMotifFramePngBlob(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
): Promise<Blob> {
  const b64: string = await invoke("motif_capture_frame", {
    motifId,
    tSec,
    propsJson: JSON.stringify(props),
    width,
    height,
    settleRafs: settleRafs ?? null,
  });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

/**
 * As `captureMotifFramePngBlob`, decoded to an `ImageBitmap` for GPU upload.
 */
export async function captureMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
): Promise<ImageBitmap> {
  const blob = await captureMotifFramePngBlob(motifId, tSec, props, width, height, settleRafs);
  return createImageBitmap(blob);
}
```

(Keep the file's existing top doc comment.)

- [ ] **Step 4: Run — expect PASS**

```
cd apps/desktop && npx vitest run src/render/motifs/__tests__/host.test.ts
```

- [ ] **Step 5: Typecheck + commit**

```
cd apps/desktop && npm run typecheck
```
then from repo root:
```
git add apps/desktop/src/render/motifs/host.ts apps/desktop/src/render/motifs/__tests__/host.test.ts
git commit -m "feat(motifs): expose captureMotifFramePngBlob for non-GPU consumers (Stage 5a)"
```

---

## Task 2 (5a): MotifPicker preview → static CDP still

**Why:** the picker preview is the last live SVG-harness consumer. Replace it with a single CDP capture at t=0; drop the animated hover loop (CDP is ~80ms/frame — a still is the right call; the editor preview owns animation).

**Files:**
- Modify: `apps/desktop/src/templates/MotifPicker.tsx`

- [ ] **Step 1: Rewrite `TemplatePreview` to a static CDP still**

Read the current `TemplatePreview` (≈ lines 320–587). Replace the harness machinery with one capture effect. Concretely:

- Remove imports: `TemplateHarness` (from `../render/templates/harness`), `getTemplate` (from `../render/templates/catalog`), `previewLoopTimeSec` (from `./previewLoop`). Add: `import { captureMotifFramePngBlob } from "../render/motifs/host";`
- Remove the constants `PREVIEW_FPS`, `PREVIEW_FPS_MIN` and the `previewLoop` usage.
- Change the `TemplatePreview` props: drop `animate`, `large`-stays, `canvasFps` — keep `template`, `props`, `width`, `large`. (Update the two call sites in Step 2.)
- Replace ALL of: `harnessRef`/`loadedRef`/the harness `useEffect` (≈395–423), the render `useEffect` (≈444–511), `hovered`/`previewFps` state, the fps `<input>` block (≈568–584), and the mouse-enter/leave handlers — with:
  - keep `urlRef`/`svgUrl` (rename to `pngUrl`/`setPngUrl` for clarity) + `error`,
  - a single effect on `[template.id, props, w, h]` that captures + binds:
    ```tsx
    useEffect(() => {
      let cancelled = false;
      setError(null);
      captureMotifFramePngBlob(template.id, PREVIEW_T_SEC, props, w, h)
        .then((blob) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = url;
          setPngUrl(url);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
      return () => {
        cancelled = true;
      };
    }, [template.id, props, w, h]);
    ```
  - keep the unmount URL-revoke effect.
- The `<img>` stays (src = `pngUrl`); the host `<div>` loses the `animate`/hover/pointer-events bits (it's always a static still now; cards already had `pointerEvents:none` via the host class — keep that).
- Keep the loading/`error` spans + the contain-scale transform on the `<img>`.

If `props` identity churns each render (the parent passes a fresh object), the parent already debounces prop edits (see the existing comment); a re-capture per debounced edit is correct (the preview should reflect current props). That's acceptable at the picker's low frequency.

- [ ] **Step 2: Update the two `<TemplatePreview>` call sites**

- `TemplateCardThumbnail` (≈594): `<TemplatePreview template={template} props={defaults} width={240} />` — already static; just confirm it no longer passes `animate`/`canvasFps` (it didn't).
- The large form preview (≈234): remove the `animate`/`canvasFps` props from the `<TemplatePreview …>` usage (the preview is static now). Keep `large` if it's used for sizing.

- [ ] **Step 3: Typecheck**

```
cd apps/desktop && npm run typecheck
```

Expected: clean. Fix any now-unused symbols the rewrite orphaned (e.g. `previewFps`, `PREVIEW_FPS`, the `template_picker.preview_fps` i18n key usage — remove the label; the i18n KEY itself can stay unused or be removed in 5c).

- [ ] **Step 4: Run the unit suite + manual check**

```
cd apps/desktop && npm test
```
Expected: green (no test targets the picker component directly). Manual (real app, optional now / will be re-checked in Task 6): open the Motif picker → the countdown card + the large preview show a still countdown frame (not blank, not a white box — transparent backdrop from the Stage-4 fix).

- [ ] **Step 5: Commit**

```
git add apps/desktop/src/templates/MotifPicker.tsx
git commit -m "feat(motifs): MotifPicker preview renders a static CDP still (drops SVG harness) (Stage 5a)"
```

---

## Task 3 (5b): Remove the dead `rasterTemplateFrame` + the SVG e2e hooks/spec

**Why:** with the picker on CDP, `rasterTemplateFrame` and the SVG-harness e2e hooks have no remaining callers. Removing them frees the harness/svgRaster files for deletion in Task 4.

**Files:**
- Modify: `apps/desktop/src/render/templates/templateRaster.ts`
- Modify: `apps/desktop/src/testhook/e2eHook.ts`
- Modify: `apps/desktop/src/main.tsx`
- Delete: `apps/desktop/e2e/specs/templates.e2e.js`

- [ ] **Step 1: Strip `templateRaster.ts` of the SVG path**

In `apps/desktop/src/render/templates/templateRaster.ts`:
- Remove imports `TemplateHarness` (`./harness`) and `rasterizeSvg` (`./svgRaster`).
- Delete the `harnessByTemplateId` map, the `HarnessEntry` interface, the `harnessFor(...)` function, and the `rasterTemplateFrame(...)` function (the SVG one).
- KEEP `sharedTemplateFrameCache`, `sharedBakedKeyIndex`, and `resolveTemplateFrame` (the CDP path). Keep the `Template`/`rasterMotifFrame`/`BakedKeyIndex`/`TemplateFrameCache` imports it still uses.
- Update the module header comment (drop the harness mention).

- [ ] **Step 2: Remove the SVG-harness e2e hooks**

In `apps/desktop/src/testhook/e2eHook.ts`:
- Remove imports `TemplateHarness` (`../render/templates/harness`) and `rasterizeSvg` (`../render/templates/svgRaster`).
- Remove the interface members `renderTemplateFrameSvg(...)` and `renderTestFixtureSvg(...)` (the type declarations, ≈87–123).
- Remove the `installTemplateHarnessHook()` export and any fixture-harness install function that wires `renderTemplateFrameSvg`/`renderTestFixtureSvg` (the impls ≈267–305 + the fixture HTML helper they use). 
- KEEP `renderTemplateSpriteFrames` (it drives the real `MotifSprite` — CDP, not SVG) and all other hooks.
- If a `renderTemplateFrameSvg`/`renderTestFixtureSvg` helper (e.g. the inline fixture SVG string) becomes orphaned, remove it too.

In `apps/desktop/src/main.tsx`:
- Remove the `installTemplateHarnessHook` import + its call (≈75–77). Keep `installBootstrapHook`/`installMotifHook`.

- [ ] **Step 3: Delete the SVG-rasterizer e2e spec**

```
git rm apps/desktop/e2e/specs/templates.e2e.js
```
(It pins the plain-SVG-raster platform behavior the product no longer uses. `template_prebake.e2e.js` STAYS — it tests the L2 cache via the CDP `renderTemplateSpriteFrames`/prebake hooks.)

- [ ] **Step 4: Typecheck + full suite**

```
cd apps/desktop && npm run typecheck && npm test
```

Expected: green. (Removing `rasterTemplateFrame` + the SVG hooks should leave no broken imports; if vitest complains a deleted hook is referenced by a kept test, that test was SVG-specific — confirm and remove it.)

- [ ] **Step 5: Commit**

```
git add apps/desktop/src/render/templates/templateRaster.ts apps/desktop/src/testhook/e2eHook.ts apps/desktop/src/main.tsx
git rm --cached apps/desktop/e2e/specs/templates.e2e.js 2>/dev/null; git add -A apps/desktop/e2e/specs/
git commit -m "refactor(motifs): drop dead rasterTemplateFrame + SVG-harness e2e hooks/spec (Stage 5b)"
```

---

## Task 4 (5b): Delete the orphaned SVG modules + dead Plan-1 motif files

**Why:** with Tasks 2–3 done, these files have no importers (verify, then delete).

**Files to delete (each with its `.test.ts` if present):**
- `apps/desktop/src/render/templates/harness.ts`
- `apps/desktop/src/render/templates/harnessFrame.ts`
- `apps/desktop/src/render/templates/svgRaster.ts` (+ `svgRaster.test.ts`)
- `apps/desktop/src/render/templates/rasterPool.ts` (+ `rasterPool.test.ts`)
- `apps/desktop/src/render/templates/rasterSlot.ts` (+ `rasterSlot.test.ts`)
- `apps/desktop/src/render/templates/fontFace.ts` (+ `fontFace.test.ts`)
- `apps/desktop/src/render/templates/wrapText.ts` (+ `wrapText.test.ts`)
- `apps/desktop/src/templates/previewLoop.ts` (+ `previewLoop.test.ts` if present) — **only if** grep confirms no importer after Task 2
- `apps/desktop/src/render/motifs/catalog.ts` (+ `__tests__/catalog.test.ts`) — the dead Plan-1 Motif catalog
- `apps/desktop/src/render/motifs/interpolate.ts` (+ `__tests__/interpolate.test.ts`) — the dead Plan-1 author primitive

- [ ] **Step 1: Verify each is orphaned**

```
cd apps/desktop && for f in harness harnessFrame svgRaster rasterPool rasterSlot fontFace wrapText; do echo "== $f =="; grep -rEn "from \"[^\"]*/$f\"|from \"\./$f\"" src | grep -v "/$f\.\(ts\|test\.ts\)"; done
```
(PowerShell-equivalent or just use the Grep tool.) Also grep `previewLoop`, `motifs/catalog`, `motifs/interpolate`, and `Rasterizer` is NOT in this list (it stays). Expect: no non-self importers for the listed files. If `previewLoop` still has an importer, leave it.

- [ ] **Step 2: Delete the files**

```
cd apps/desktop && git rm \
  src/render/templates/harness.ts \
  src/render/templates/harnessFrame.ts \
  src/render/templates/svgRaster.ts src/render/templates/svgRaster.test.ts \
  src/render/templates/rasterPool.ts src/render/templates/rasterPool.test.ts \
  src/render/templates/rasterSlot.ts src/render/templates/rasterSlot.test.ts \
  src/render/templates/fontFace.ts src/render/templates/fontFace.test.ts \
  src/render/templates/wrapText.ts src/render/templates/wrapText.test.ts \
  src/render/motifs/catalog.ts src/render/motifs/__tests__/catalog.test.ts \
  src/render/motifs/interpolate.ts src/render/motifs/__tests__/interpolate.test.ts
```
(Add `src/templates/previewLoop.ts` + its test only if Step 1 confirmed no importer. Adjust paths for any `.test.ts` that doesn't exist — `harness.ts`/`harnessFrame.ts` may have no standalone test.)

- [ ] **Step 3: Typecheck + full suite + grep-clean**

```
cd apps/desktop && npm run typecheck && npm test
```
Then confirm no dangling references:
```
cd apps/desktop && grep -rEn "harnessFrame|svgRaster|rasterPool|rasterSlot|TemplateHarness|rasterizeSvg|wrapTspans|HARNESS_FRAME" src | grep -v "\.test\.ts"
```
Expected: empty (or only incidental comments). `cargo test` is unaffected (no Rust change) but run it once for the gate.

- [ ] **Step 4: Commit**

```
git commit -m "refactor(motifs): delete orphaned SVG machinery + dead Plan-1 motif catalog/interpolate (Stage 5b)"
```

---

## Task 5: Verification (real WebView2)

- [ ] **Step 1: Confirm no running app holds the build lock**
```
powershell -Command "Get-Process weftcut -ErrorAction SilentlyContinue | Stop-Process -Force"
```

- [ ] **Step 2: Run the kept e2e (L2 prebake — proves the CDP-backed cache + sprite path still works end-to-end after the deletions)**
```
cd apps/desktop/e2e && npx wdio run ./wdio.conf.mjs --spec ./specs/template_prebake.e2e.js
```
Expected: passing. (msedgedriver matches WebView2 148.0.3967.96.)

- [ ] **Step 3: Manual picker check (real app)**

`npm run tauri:dev` (with the dev hooks), open the Motif picker, confirm the countdown card + large preview show a static countdown frame on a transparent backdrop (not blank, not a white box). If the dev MCP bridge is up, drive it via `webview_execute_js`.

- [ ] **Step 4: No commit** (verification only).

---

## Completion

Use **superpowers:finishing-a-development-branch**. Final gate:
```
cd apps/desktop && npm run typecheck && npm test
cd apps/desktop/src-tauri && cargo test
```
plus Task 5. Then merge to local `main` (ff, delete branch, unpushed).

**Update memory** on completion: 5a/5b done (SVG path gone; picker on static CDP); Stage 5c remains = unify catalog + `templates/`→`motifs/` rename + `bake_*`/Rust `templates::` module.

---

## Self-review (author)

- **Spec coverage (§7 cutover):** delete SVG machinery → Tasks 3–4; the §7 list said `Rasterizer.ts` deletable, but it still exports the live `canonicalizeProps` → KEEP (deferred to 5c's catalog unify). The picker preview was an unlisted live consumer → Tasks 1–2 migrate it (the honest addition).
- **Risk:** the picker rewrite is the only judgment-heavy task; everything else is delete + fix-imports with the compiler as the net. The grep-clean step (Task 4 Step 3) guards against a stranded reference.
- **Kept-vs-deleted is explicit:** Rasterizer/descriptor/frameCache/prewarmer/baker/`renderTemplateSpriteFrames`/`template_prebake.e2e.js` stay; harness/svgRaster/rasterPool/rasterSlot/fontFace/wrapText/`rasterTemplateFrame`/Plan-1 `motifs/catalog`+`interpolate`/`templates.e2e.js`/SVG e2e hooks go.
- **No rename in 5a/5b** — legacy `Template*`/`templates/`/`bake_*` names stay; Stage 5c renames. This keeps the diff a pure migrate+delete.
