# Template SVG Render Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead foreignObject HTML/CSS template raster with a pure-SVG + `render(t)` pipeline that animates correctly and composites in both preview and export.

**Architecture:** A template is `manifest.json` + `index.html` (markup + an inline `render(tSec, durationSec, props)` script); `manifest.engine` (`"svg"` for v1) selects the capture pipeline. A sandboxed iframe runs `render` to mutate the document, serializes the post-render `<svg>` subtree (scripts stripped, data-URL `@font-face` injected), and the main thread rasterizes it via `<img>` → `createImageBitmap` — a clean, uploadable bitmap (foreignObject taints; see ADR 0015). Preview rasters on demand; export pre-rasters every template frame on the main thread and feeds PNGs to the worker (a worker cannot decode SVG). See `docs/templates.md`.

**Tech Stack:** TypeScript (Vite + PixiJS v8 + WebGPU), Rust (Tauri 2, `include_str!` embedding), vitest (Node unit), WebdriverIO + tauri-driver + msedgedriver (real-WebView2 e2e).

---

## Decisions taken (the 5 gating questions, resolved with the recommended defaults)

1. **v1 caching = L0 on-demand + L2 manual per-layer persist.** The in-RAM lookahead ring (L1) and measurement-driven auto-escalation are **deferred to v2** — real-WebView2 playback showed on-demand holds (~2 ms p50), and auto-thresholds can't be tuned without real heavy projects.
2. **Export = main-thread pre-raster → transient PNG → worker reads.** Folded into the existing "preparing" gate. (Spike S1 may later let the worker self-rasterize via resvg-wasm; not on the v1 critical path.)
3. **Variable-length text = a small greedy `<tspan>` wrap helper** in the harness, using `getComputedTextLength`.
4. **Fonts = a manifest `fonts` field + a subset `.woff2` per built-in.** woff2 is fine for the `<img>` raster path (verified). Stored font-free; the `@font-face` is injected at raster time.
5. **Generic file shape + `render` contract.** A template is `manifest.json` + `index.html` (+ optional `assets/`); `manifest.engine` declares capture (`"svg"` now; `"webview"`/`"satori"` reserved — a future HTML+JS template needs no SVG file). `index.html` holds the markup + an inline `<script>` defining a global `render(tSec, durationSec, props)` [+ `ready()`]. The harness serializes **only the `<svg>` element with `<script>` descendants stripped**.

**Fidelity tier:** v1 ships Tier 1 (hand-SVG). Tier 2 (satori) and Tier 3 (hidden-webview full-HTML baker) are specs at the end, not v1 tasks.

---

## File structure

**Create**
- `apps/desktop/src/render/templates/harness.ts` — the iframe harness driver: mount, `renderFrameSvg(t)`, serialize-`<svg>`-only, postMessage protocol.
- `apps/desktop/src/render/templates/harnessFrame.ts` — the string of the harness script injected into the iframe `srcdoc` (defines the message loop, calls `render`, serializes, injects `@font-face`).
- `apps/desktop/src/render/templates/svgRaster.ts` — `rasterizeSvg(svgString) → ImageBitmap` via `<img>` (replaces foreignObject path).
- `apps/desktop/src/render/templates/fontFace.ts` — `buildFontFaceStyle(fonts) → string`, `injectFontFace(svg, style) → string` (pure, Node-testable).
- `apps/desktop/src/render/templates/wrapText.ts` — `wrapTspans(text, maxWidth, measure) → string[]` greedy wrapper (pure, measure injected).
- `apps/desktop/src/render/templates/frameCache.ts` — `TemplateFrameCache` (L0 in-RAM per-frame bitmaps + optional L2 disk PNG read/write).
- `apps/desktop/src/render/templates/builtin/countdown/index.html` (+ optional `assets/`) — **only `countdown` is kept**; the other 9 starters were deleted from both `src/render/templates/builtin/` and `src-tauri/src/templates/`.
- `apps/desktop/src/render/templates/exportBake.ts` — main-thread "pre-raster all template frames" pass for export.
- `apps/desktop/e2e/specs/templates.e2e.js` — real-WebView2 e2e for render(t)/raster/animation/font/export.

**Modify**
- `apps/desktop/src/render/templates/catalog.ts` — `Template`/`TemplateManifest` types (`html` + `engine` + `fonts`), `index.html` glob loader.
- `apps/desktop/src/frames.ts` — add `frameIndexInLayer(tInLayerUs, fpsNum, fpsDen)`.
- `apps/desktop/src/render/sprite/TemplateSprite.ts` — rewrite to bind frame bitmaps from the cache, keyed by frame index.
- `apps/desktop/src/render/Compositor.ts` — `updateTemplate` passes `tInLayerUs`/`durationUs`; export bake hook.
- `apps/desktop/src/ipc/index.ts` — `TemplateSummary` (add `engine` + `fonts`; keep `html`, drop `style`).
- `apps/desktop/src-tauri/src/templates/mod.rs` — `Manifest` gains `engine`+`fonts`; `Template` drops `style`; macro includes `index.html` only (drop `style.css`); content hash. (Already trimmed to the single `countdown` built-in.)
- `apps/desktop/src-tauri/src/commands.rs` — `list_templates` payload.
- `apps/desktop/src/render/worker/{protocol.ts,exportWorker.ts,runExport.ts}` — carry pre-rasterized template frames to the worker; composite them.
- `apps/desktop/src/App.tsx` — extend the "preparing" gate to await template bakes.

**Delete**
- `buildForeignObjectSvg`, `substituteTemplate`, `rasterizeForeignObject`, the `{{key}}`/`__STYLE__` mechanism in `Rasterizer.ts`; the HTML-oriented `assetEmbed.ts` (replaced by `fontFace.ts`); old `Cache.ts` single-bitmap cache; `style.css` in `countdown/` (markup + style now live inside `index.html`). The 9 non-countdown starter dirs are already deleted.

---

## Phase 1 — Template format + Rust embedding + types

### Task 1: Manifest `fonts` field + catalog types (TS)

**Files:**
- Modify: `apps/desktop/src/render/templates/catalog.ts`
- Test: `apps/desktop/src/render/templates/catalog.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { describe, test, expect } from "vitest";
import { getTemplate } from "./catalog";

describe("catalog index.html format", () => {
  test("countdown: engine svg, html holds <svg> + render()", () => {
    const t = getTemplate("countdown");
    expect(t).not.toBeNull();
    expect(t!.manifest.engine).toBe("svg");
    expect(t!.html).toContain("<svg");
    expect(t!.html).toContain("function render");
    expect((t as unknown as { css?: string }).css).toBeUndefined();
  });
});
```
- [ ] **Step 2: Run test to verify it fails** — `cd apps/desktop && npm run test -- catalog` → FAIL (`svg` undefined; templates still html/css).
- [ ] **Step 3: Implement** — change the types and glob loaders:
```ts
export type TemplateEngine = "svg" | "webview" | "satori";
export interface TemplateFont { family: string; weight?: number; style?: string; file: string; }
export interface TemplateManifest {
  id: string; name: string; version: number;
  size: [number, number]; default_duration_s: number;
  props_schema: Record<string, PropSpec>;
  engine?: TemplateEngine;        // defaults to "svg"
  fonts?: TemplateFont[];
}
export interface Template { manifest: TemplateManifest; html: string; fonts: Record<string, Uint8Array>; }

const htmlModules = import.meta.glob("./builtin/*/index.html", { eager: true, query: "?raw", import: "default" });
const manifestModules = import.meta.glob("./builtin/*/manifest.json", { eager: true });
const fontModules = import.meta.glob("./builtin/*/assets/*.woff2", { eager: true, query: "?arraybuffer", import: "default" });
// buildCatalog: index html by dir; manifest.engine ??= "svg"; map fonts[].file → fontModules[dir+"/assets/"+file].
```
(Keep `getTemplate(id)` and the `id`-keyed map unchanged.)
- [ ] **Step 4: Run test to verify it passes** — depends on Task 4 fixtures existing; run after Task 4. Mark blocked-on-Task-4.
- [ ] **Step 5: Commit** — `git add apps/desktop/src/render/templates/catalog.ts apps/desktop/src/render/templates/catalog.test.ts && git commit -m "feat(templates): index.html + engine catalog types"`

### Task 2: Rust `Manifest` engine/fonts + `Template` drops `style`

**Files:**
- Modify: `apps/desktop/src-tauri/src/templates/mod.rs` (Manifest/Template structs, `builtin_template!` macro, content hash).

- [ ] **Step 1: Update the structs**
```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String, pub name: String, pub version: u32,
    pub size: [u32; 2], pub default_duration_s: f64,
    pub props_schema: BTreeMap<String, PropSpec>,
    #[serde(default = "default_engine")] pub engine: String,   // "svg"
    #[serde(default)] pub fonts: Vec<FontDecl>,
}
fn default_engine() -> String { "svg".into() }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FontDecl { pub family: String, #[serde(default)] pub weight: Option<u32>, #[serde(default)] pub style: Option<String>, pub file: String }
#[derive(Clone, Debug)]
pub struct Template { pub manifest: Manifest, pub html: String }
```
- [ ] **Step 2: Update the macro** — keep `include_str!(concat!($dir, "/index.html"))`, **drop the `style.css` include + `Template.style`**; build `Template { manifest, html }`. Fonts load webview-side (Vite glob, Task 1).
- [ ] **Step 3: Update content hash** (`:74-87`) to hash `manifest || html`; fix `.style` reads (`commands.rs` list_templates — Task 3).
- [ ] **Step 4: Build** — `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` → PASS (countdown still has `index.html`; new manifest fields default; its `style.css` is deleted in Task 4).
- [ ] **Step 5: Commit** — `git commit -am "feat(templates): manifest engine/fonts, Template drops style"`

### Task 3: `list_templates` payload + IPC `TemplateSummary`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs:1913-1933`; `apps/desktop/src/ipc/index.ts:985-1000`.

- [ ] **Step 1: Rust payload** — emit `html` + `engine` + `fonts` (drop `style`).
- [ ] **Step 2: TS type**
```ts
export interface TemplateSummary {
  id: string; name: string; version: number; size: [number, number];
  default_duration_s: number; props_schema: Record<string, PropSpec>;
  engine: TemplateEngine; html: string; fonts: TemplateFont[];
}
```
- [ ] **Step 3: Typecheck** — `cd apps/desktop && npm run typecheck` → fix call-sites referencing `.style`.
- [ ] **Step 4: Commit** — `git commit -am "feat(templates): list_templates returns html + engine"`

### Task 4: Convert `countdown/index.html` to SVG + inline render (the exemplar)

**Files (mirror EVERY change to both copies — TS `src/render/templates/builtin/countdown/` and Rust `src-tauri/src/templates/countdown/`):**
- Modify: `countdown/index.html`, `countdown/manifest.json` (add `"engine": "svg"`)
- Delete: `countdown/style.css`

- [ ] **Step 1: `index.html`** — markup (`<svg>`) + an inline `render` script (the `<script>` is a sibling of `<svg>`, so serialize-only-`<svg>` excludes it):
```html
<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0">
  <svg xmlns="http://www.w3.org/2000/svg" width="480" height="480">
    <circle cx="240" cy="240" r="200" fill="none" stroke="#ffffff" stroke-width="24" opacity="0.25"/>
    <circle id="arc" cx="240" cy="240" r="200" fill="none" stroke="#33ff99" stroke-width="24"
            stroke-linecap="round" transform="rotate(-90 240 240)"
            stroke-dasharray="1256.637" stroke-dashoffset="1256.637"/>
    <text id="num" x="240" y="300" text-anchor="middle" font-family="Arial, sans-serif"
          font-size="200" font-weight="700" fill="#ffffff">5</text>
  </svg>
  <script>
    var CIRC = 2 * Math.PI * 200;
    function render(tSec, durationSec, props) {
      var remaining = Math.max(0, Math.ceil(durationSec - tSec));
      document.getElementById("num").textContent = String(remaining);
      var frac = Math.min(1, Math.max(0, tSec / durationSec));
      var arc = document.getElementById("arc");
      arc.setAttribute("stroke-dashoffset", String(CIRC * (1 - frac)));
      if (props && props.color) arc.setAttribute("stroke", props.color);
    }
    function ready() { return Promise.resolve(); }
  </script>
</body></html>
```
- [ ] **Step 2: `manifest.json`** — add `"engine": "svg"` (no `fonts`; countdown uses system Arial). Both copies.
- [ ] **Step 3: Delete** `style.css` (both copies): `git rm apps/desktop/src/render/templates/builtin/countdown/style.css apps/desktop/src-tauri/src/templates/countdown/style.css`
- [ ] **Step 4: Verify** — `cd apps/desktop && npm run test -- catalog` → PASS; `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(templates): countdown as SVG + inline render in index.html"`

---

## Phase 2 — Pure helpers (Node-unit, TDD)

### Task 5: `frameIndexInLayer` (exact-rational, clamped)

**Files:** Modify `apps/desktop/src/frames.ts`; Test `apps/desktop/src/frames.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { frameIndexInLayer } from "./frames";
test("frame index is exact-rational and clamped", () => {
  // 30000/1001 fps, 5s layer → 149 displayable frames (0..149)
  expect(frameIndexInLayer(0, 30000, 1001)).toBe(0);
  expect(frameIndexInLayer(33_366, 30000, 1001)).toBe(1); // ~1 frame
  expect(frameIndexInLayer(-50, 30000, 1001)).toBe(0);     // clamp low
});
```
- [ ] **Step 2: Run** — `npm run test -- frames` → FAIL (not exported).
- [ ] **Step 3: Implement**
```ts
export function frameIndexInLayer(tInLayerUs: number, fpsNum: number, fpsDen: number): number {
  if (fpsNum <= 0 || fpsDen <= 0) return 0;
  if (tInLayerUs <= 0) return 0;
  return Math.floor((tInLayerUs * fpsNum) / (US_PER_SEC * fpsDen));
}
```
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `git commit -am "feat(frames): frameIndexInLayer"`

### Task 6: `fontFace.ts` — build + inject `@font-face`

**Files:** Create `fontFace.ts` + `fontFace.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { buildFontFaceStyle, injectFontFace } from "./fontFace";
test("injects a data-URL @font-face into the svg defs", () => {
  const style = buildFontFaceStyle([{ family: "Inter", file: "x", bytes: new Uint8Array([1,2,3]) }]);
  expect(style).toContain("@font-face");
  expect(style).toContain("font-family:'Inter'");
  expect(style).toContain("data:font/woff2;base64,");
  const svg = injectFontFace('<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>', style);
  expect(svg).toMatch(/<defs><style>@font-face/);
});
```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (base64 via chunked `String.fromCharCode`; `injectFontFace` inserts `<defs><style>…</style></defs>` right after the opening `<svg …>` tag). **Step 4:** PASS. **Step 5: Commit.**

### Task 7: `wrapText.ts` — greedy `<tspan>` wrap

**Files:** Create `wrapText.ts` + `wrapText.test.ts`.

- [ ] **Step 1: Failing test** (measure injected so it's Node-pure):
```ts
import { wrapTspans } from "./wrapText";
const measure = (s: string) => s.length * 10; // 10px/char fake
test("greedy-wraps to maxWidth", () => {
  expect(wrapTspans("aaa bbb ccc", 75, measure)).toEqual(["aaa bbb", "ccc"]);
});
```
- [ ] **Step 2:** FAIL. **Step 3: Implement** greedy line accumulation. **Step 4:** PASS. **Step 5: Commit.**

---

## Phase 3 — Capture harness + SVG rasterizer (real-WebView2 e2e)

> These touch `<iframe>` / `createImageBitmap` and only run in a real browser, so they are verified by an **e2e spec in real WebView2** (`templates.e2e.js`), not vitest. Pattern: gate test helpers behind `window.__weftcutTest` (set when `VITE_WEFTCUT_E2E=1`).

### Task 8: SVG rasterizer (`svgRaster.ts`)

**Files:** Create `svgRaster.ts`; wire a `window.__weftcutTest.rasterizeSvg` hook.

- [ ] **Step 1: Implement**
```ts
export async function rasterizeSvg(svg: string): Promise<ImageBitmap> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("svg img load fail")); img.src = url; });
    return await createImageBitmap(img); // NOTE: createImageBitmap(blob) directly fails; <img> is required
  } finally { URL.revokeObjectURL(url); }
}
```
- [ ] **Step 2: e2e** — in `templates.e2e.js`, raster a plain SVG with text+alpha, draw to OffscreenCanvas, assert `getImageData` does NOT throw (clean, not tainted) and a transparent corner has `alpha === 0`.
- [ ] **Step 3: Run** — `cd apps/desktop/e2e && npm test -- --spec specs/templates.e2e.js` → PASS.
- [ ] **Step 4: Commit.**

### Task 9: Harness (`harnessFrame.ts` + `harness.ts`)

**Files:** Create both; `harness.ts` exposes `class TemplateHarness { load(t: Template): Promise<void>; renderFrameSvg(tSec, durSec, props): Promise<string>; dispose() }`.

- [ ] **Step 1: `harnessFrame.ts`** — the srcdoc-injected harness script: stub `Date.now`/`performance.now`/`requestAnimationFrame`; on `{type:"render", t, dur, props}`, `await ready?.()`, call `render(t, dur, props)`, force reflow, clone `document.querySelector("svg")`, **remove any `<script>` descendants from the clone**, serialize via `XMLSerializer`, and `postMessage({type:"rendered", id, svg})`. On load, `postMessage({type:"ready"})`.
- [ ] **Step 2: `harness.ts`** — create iframe `sandbox="allow-scripts"` (no `allow-same-origin`); `srcdoc` = the template's `index.html` with the `@font-face` `<style>` injected (`injectFontFace`) and `<script>${HARNESS_FRAME}</script>` appended to the `<body>`. The template's own inline `render` script runs as-is; the harness script calls it. `await ready`; `renderFrameSvg` posts `render` and resolves with the returned SVG string. Reuse one iframe across templates (re-`srcdoc` on `load(t)`).
- [ ] **Step 3: e2e** — render countdown at t=0.5 and t=2.5; assert the two SVG strings differ (script ran) and contain `>5<` and `>3<` respectively; assert two renders at the same t are byte-identical (determinism).
- [ ] **Step 4: Point the picker at the harness** — update the catalog picker preview to drive `TemplateHarness.renderFrameSvg` (scrub) instead of any free-running iframe, so picker/timeline/export agree pixel-for-pixel.
- [ ] **Step 5: Run e2e** → PASS. **Step 6: Commit.**

### Task 10: Font injection through the harness (e2e)

- [ ] **Step 1:** Add a built-in (or test fixture) with a `fonts` entry + a subset `.woff2`; `harness.ts` calls `buildFontFaceStyle`/`injectFontFace` before mounting.
- [ ] **Step 2: e2e** — render with the custom font vs a forced-fallback variant; raster both; assert pixel hashes differ (font applied at `img.onload`, no fallback).
- [ ] **Step 3: Run** → PASS. **Step 4: Commit.**

---

## Phase 4 — Cache + sprite + compositor wiring

### Task 11: `TemplateFrameCache` (L0 in-RAM; L2 disk read/write)

**Files:** Create `frameCache.ts`; delete old `Cache.ts`.

- [ ] **Step 1:** `class TemplateFrameCache` keyed by `(templateId, version, canonicalPropsJSON, renderW, renderH, fpsNum, fpsDen, durationFrames)` → per-frame-index `ImageBitmap` (bounded LRU). `getFrame(key, i)`, `setFrame(key, i, bmp)`, `clearKey(key)`. L2 methods `readPng(key, i)`/`writePng(key, i, blob)` go through Tauri fs to `Cache/raster/<hash>/<i>.png` (manual per-layer enable only in v1). Plus `gcUnreferenced(activeKeys: string[])` — on project load, prune `Cache/raster/<hash>/` dirs whose key isn't referenced by any current Template layer.
- [ ] **Step 2: e2e** — set/get a frame round-trips; an unknown key/index returns null. **Step 3:** PASS. **Step 4: Commit.**

### Task 12: Rewrite `TemplateSprite` to use harness + cache + frame index

**Files:** Modify `sprite/TemplateSprite.ts`; signature change `update(view, tInLayerUs, durationUs)`.

- [ ] **Step 1:** On `update`, compute `frame = frameIndexInLayer(tInLayerUs, fpsNum, fpsDen)` clamped to `durationFrames-1`; look up `cache.getFrame(key, frame)`; on miss, `harness.renderFrameSvg(frame/fps, durSec, props)` → `rasterizeSvg` → `cache.setFrame` → `bindBitmap` + `onLoaded()`. Reuse the existing `bindBitmap`/dispose texture lifecycle.
- [ ] **Step 2:** The sprite needs `fpsNum/fpsDen` — pass via the constructor (Compositor already knows them).
- [ ] **Step 3: e2e** — drive the compositor over a template layer at 5 timestamps; assert the bound texture changes (animation) and the playhead frame paints within budget. **Step 4: Commit.**

### Task 13: Compositor passes layer-relative time

**Files:** Modify `Compositor.ts` `updateTemplate` (`:1183`) + `ensureTemplate` (`:1164`).

- [ ] **Step 1:** Mirror `updateImage`/`updateSubtitles`: compute `const tInLayerUs = tUs - layer.t_start_us; const durationUs = layer.t_end_us - layer.t_start_us;` and call `tmpl.sprite.update(layer.params, tInLayerUs, durationUs)`. Pass `tUs` (snapped) into `updateTemplate` from `compositeFrame`. Provide `fpsNum/fpsDen` to `ensureTemplate`'s `new TemplateSprite`.
- [ ] **Step 2: Typecheck** → fix the `updateTemplate(tmpl, layer, z)` callsite to thread `tUs`. **Step 3: e2e** — a template trimmed to start at 2s shows its t=0 frame at playhead 2s (resets at layer start). **Step 4: Commit.**

---

## Phase 5 — Export integration

### Task 14: `exportBake.ts` — main-thread pre-raster pass

**Files:** Create `exportBake.ts`; modify `worker/protocol.ts`, `runExport.ts`, `exportWorker.ts`, `App.tsx`.

- [ ] **Step 1:** `exportBake(summary, range, fps, harness, cache) → Map<layerId, ImageBitmap[]>` — for each Template layer in range, raster every frame `0..durationFrames` on the main thread (reusing the harness + cache); report progress.
- [ ] **Step 2: protocol** — add `templateFrames: Record<layerId, ImageBitmap[]>` (transferred) to `ExportRequest.start` (or a preceding `template-frames` message). The worker's Compositor `TemplateSprite` reads from an injected frame array instead of harness/`<img>` (which it cannot use).
- [ ] **Step 3: worker** — in export mode, `TemplateSprite` binds `injectedFrames[layerId][frameIndex]`; never calls the harness. Remove the "templates absent in export" gate (`activeVideoLayers`/Compositor template skip).
- [ ] **Step 4: App.tsx** — run `exportBake` inside the existing `kind:"preparing"` gate (alongside `waitForProxies`) before launching the worker; surface progress in the preparing panel.
- [ ] **Step 5: e2e** — export a 1s project with a countdown layer; extract frames via the Rust `extract_video_frame`; assert the numeral changes across frames (template animates in the exported file). **Step 6: Commit.**

---

## Phase 6 — Delete dead code

### Task 15: (none for v1 — the other 9 starters were already deleted)

v1 ships **only `countdown`** as the built-in; the other 9 starter dirs were removed from `builtin/`, `src-tauri/src/templates/`, and `mod.rs`. No mass conversion. The table below is a **post-v1 backlog** — author each as a new `index.html` (engine `"svg"`) following the Task 4 exemplar when wanted:

| id | render(t) animates | notes |
|---|---|---|
| `progress_bar` | rect width = `props.percent` × (t/dur) sweep | normalized pacing; `<rect>` width attr |
| `lower_third_simple` | slide-in x over first 0.5s, hold | `transform="translate(x,0)"` |
| `lower_third_bar` | bar scaleX 0→1 reveal, then text fade | clip via `<clipPath>` |
| `lower_third_glow` | opacity pulse; SVG `<filter>` blur for glow | static filter, animated opacity |
| `title_card` | title fade/scale-in; subtitle delayed | manual `<tspan>` wrap (Task 7) for long titles |
| `captions_strip` | text = `props.text`, wrapped; bg sized to lines | `wrapTspans` + `getComputedTextLength` |
| `callout` | pointer line draw (`stroke-dashoffset`) + label fade | |
| `logo_bug` | fade-in, hold | likely embeds an `<image>` (data-URL) prop |
| `slate` | static fields | mostly static |

### Task 16: Delete the foreignObject path + final sweep

**Files:** `Rasterizer.ts`, `assetEmbed.ts`, `Cache.ts` (+ their tests).

- [ ] **Step 1:** Delete `buildForeignObjectSvg`, `substituteTemplate`, `rasterizeForeignObject`, `assetEmbed.ts`, old `Cache.ts`. Remove now-dead imports.
- [ ] **Step 2:** `npm run typecheck` + `npm run test` → green. `cargo build` → green.
- [ ] **Step 3:** Full e2e suite `cd apps/desktop/e2e && npm test` → green (incl. `templates.e2e.js`).
- [ ] **Step 4: Commit** — `git commit -am "chore(templates): remove dead foreignObject raster path"`

---

## Spikes (parallel, optional — may simplify, not block, v1)

- **S1 — resvg-wasm in the worker.** POC `@resvg/resvg-wasm` rasterizing our hand-SVG → PNG inside the export worker (and main thread). If it works at acceptable latency, **Task 14 collapses**: the worker self-rasterizes (no main-thread pre-raster / transfer), and preview+export share one Rust rasterizer. Verify in real WebView2 before adopting. Needs `npm install @resvg/resvg-wasm` (touches package.json — get approval).
- **S2 — satori (Tier 2 eval).** POC `satori` + resvg-wasm in real WebView2: clean uploadable bitmap, per-frame latency, bundle cost. Only pursue if authors need HTML/CSS flexbox layout. satori needs woff/otf/ttf (not woff2) and JSX/VDOM input, and is likely too slow for on-demand (bake-only).

## v2 spec — Tier 3 full-fidelity baker (hidden webview)

Not a v1 task. For full HTML+CSS+JS+GSAP/Lottie/WebGL templates (the HyperFrames model): render the template in a **hidden Tauri `WebviewWindow`**, override the clock (`Date.now`/`performance.now`/`rAF`) and seek by frame index, capture per frame via `CoreWebView2.CapturePreview` (or CDP `Page.captureScreenshot`) → PNG → feed the L2 cache. Bake-only (capture is tens of ms); animation must be seekable (expose `window.__timelines`, drive GSAP/etc. by frame). This is the ADR-0015 fallback; HyperFrames is the proven blueprint.

---

## Self-review

- **Spec coverage:** authoring contract (Task 4) · SVG-only/no-foreignObject (Task 8) · sandbox iframe + render(t) + serialize-svg-only (Task 9) · font-free store + raster-time inject (Tasks 6,10) · `<tspan>` wrap (Task 7) · frame-index exact-rational + clamp (Tasks 5,12) · layer-relative time / no src-in (Task 13) · L0 + L2 cache (Task 11) · export main-thread raster feeding worker (Task 14) · picker drives the same harness (Task 9 Step 4) · delete dead path (Task 16). **Resolved inline:** picker preview wiring (Task 9 Step 4); L2 disk **GC** (`gcUnreferenced` on load) in Task 11 Step 1.
- **Placeholder scan:** Task 15 is a no-op for v1 (the 9 starters were deleted); its table is a labeled post-v1 backlog, not executable steps. The exemplar (Task 4) is complete code. No "TBD"/"add error handling" steps.
- **Type consistency:** `Template { manifest, html, fonts }` (TS) / `Template { manifest, html }` (Rust) / `TemplateSummary { engine, html, fonts }` (IPC) — consistent (markup is `index.html`; `manifest.engine` selects capture). `TemplateSprite.update(view, tInLayerUs, durationUs)` used identically in Tasks 12/13. `frameIndexInLayer(tInLayerUs, fpsNum, fpsDen)` consistent across Tasks 5/12.
