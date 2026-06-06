# Template Bake-Status Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface per-template-layer L2 bake status in the UI — a phase-only timeline status dot + a property-panel status line — so the user can see when a template is baking, baked, or errored.

**Architecture:** `TemplateBaker` gains a per-cacheKey `{phase,done,total}` counter and an `onStatus` callback. The Compositor translates that (plus `sharedBakedKeyIndex` for prior-session bakes) into a `layerId→status` map and writes a small Zustand store. The timeline `LayerBlock` and the property panel's `TemplateFields` read the store through atomic selectors (phase-only for the dot, so no per-frame churn).

**Tech Stack:** TypeScript, React, Zustand (atomic selectors per `feedback_zustand_composite_selector`), PixiJS-side Compositor, vitest (Node units), tauri-driver + WebdriverIO (real-WebView2 e2e).

---

## File Structure

- **modify** `apps/desktop/src/render/templates/TemplateBaker.ts` — per-cacheKey status tracking + `onStatus` dep.
- **modify** `apps/desktop/src/render/templates/TemplateBaker.test.ts` — status-emission tests.
- **new** `apps/desktop/src/timeline/templateBakeStatusStore.ts` — Zustand `layerId→status` + pure selectors.
- **new** `apps/desktop/src/timeline/templateBakeStatusStore.test.ts` — pure-selector + store-set tests.
- **modify** `apps/desktop/src/render/Compositor.ts` — pass `onStatus`; recompute `layerId→status` (with index fallback) on status/re-plan/setProject; clear on dispose & `setProject(null)`.
- **modify** `apps/desktop/src/timeline/Timeline.tsx` — `TemplateBakeDot` component + render it in `LayerBlock` for Template layers.
- **modify** `apps/desktop/src/properties/PropertyPanel.tsx` — status line in `TemplateFields`.
- **modify** `apps/desktop/src/i18n/locales/en-US.ts`, `zh-CN.ts` — status strings.
- **modify** `apps/desktop/src/styles.css` — dot + spinner styles.
- **new** `apps/desktop/e2e/specs/template_bake_status.e2e.js` — real-WebView2 dot-transition check.

All commands run from `apps/desktop` unless noted. Windows/PowerShell; a Bash tool is also available. Stay on branch `template-bake-status`.

---

## Task 1: TemplateBaker per-cacheKey status + `onStatus`

**Files:**
- Modify: `apps/desktop/src/render/templates/TemplateBaker.ts`
- Test: `apps/desktop/src/render/templates/TemplateBaker.test.ts`

- [ ] **Step 1: Write the failing tests** — append to the existing `describe("TemplateBaker", …)` in `TemplateBaker.test.ts` (it already has a `makeFakeBitmap()` and a `drain(pending)` settle helper; reuse them):

```ts
  it("emits baking on setTargets then ready when all frames complete", async () => {
    const pending: (() => void)[] = [];
    const emits: { k: string; phase: string; done: number; total: number }[] = [];
    const baker = new TemplateBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist: async () => {},
      warm: vi.fn(),
      onStatus: (k, s) => emits.push({ k, ...s }),
      batchSize: 2,
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render: async () => makeFakeBitmap() }]);
    // setTargets announces baking synchronously.
    expect(emits[0]).toEqual({ k: "a", phase: "baking", done: 0, total: 3 });
    await drain(pending);
    expect(emits[emits.length - 1]).toEqual({ k: "a", phase: "ready", done: 3, total: 3 });
  });

  it("reaches ready via skips when every frame is already on disk (no render)", async () => {
    const pending: (() => void)[] = [];
    const emits: { phase: string; done: number; total: number }[] = [];
    const render = vi.fn(async () => makeFakeBitmap());
    const baker = new TemplateBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => true, // all on disk
      persist: async () => {},
      warm: vi.fn(),
      onStatus: (_k, s) => emits.push(s),
      batchSize: 2,
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render }]);
    await drain(pending);
    expect(render).not.toHaveBeenCalled();
    expect(emits[emits.length - 1]).toEqual({ phase: "ready", done: 3, total: 3 });
  });

  it("emits error when a frame's persist throws, with counts frozen", async () => {
    const pending: (() => void)[] = [];
    const emits: { phase: string; done: number; total: number }[] = [];
    const baker = new TemplateBaker({
      schedule: (cb) => { pending.push(cb); return pending.length; },
      cancel: vi.fn(),
      isOnDisk: async () => false,
      persist: async () => { throw new Error("disk full"); },
      warm: vi.fn(),
      onStatus: (_k, s) => emits.push(s),
      batchSize: 2,
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 3, render: async () => makeFakeBitmap() }]);
    await drain(pending);
    expect(emits[emits.length - 1].phase).toBe("error");
    expect(emits[emits.length - 1].done).toBe(0);
  });
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `npx vitest run src/render/templates/TemplateBaker.test.ts`
Expected: FAIL — `onStatus` isn't a recognized dep / no emissions captured.

- [ ] **Step 3: Implement the status tracking**

In `TemplateBaker.ts`, add the exported types above `BakeContentSpec`:

```ts
export type BakePhase = "baking" | "ready" | "error";
export interface BakeStatus { phase: BakePhase; done: number; total: number; }
```

Add to `TemplateBakerDeps` (after `warm`):

```ts
  /// Report coarse per-content status. Called immediately on setTargets
  /// (baking) and once per drain batch for touched keys (progress / ready /
  /// error). Never throws. Optional so existing callers/tests don't need it.
  onStatus?: (cacheKey: string, status: BakeStatus) => void;
```

Add a field to the class (after `specsByKey`):

```ts
  /// Per-cacheKey bake progress. total = contentDurationFrames; done counts
  /// frames persisted OR skipped-as-already-on-disk. Reset each setTargets.
  private status = new Map<string, BakeStatus>();
```

Replace `setTargets` body's tail so it seeds + announces status:

```ts
  setTargets(specs: BakeContentSpec[]): void {
    if (this.disposed) return;
    this.specsByKey = new Map(specs.map((s) => [s.cacheKey, s]));
    this.queue = planBakeTargets(specs, () => false);
    this.status = new Map(
      specs.map((s) => [s.cacheKey, { phase: "baking" as BakePhase, done: 0, total: s.contentDurationFrames }]),
    );
    for (const [k, st] of this.status) this.deps.onStatus?.(k, { ...st });
    this.arm();
  }
```

In `drainBatch`, track touched keys, bump on skip/persist, error on catch, and emit once per batch in `finally`:

```ts
  private async drainBatch(): Promise<void> {
    if (this.disposed) return;
    this.running = true;
    const touched = new Set<string>();
    try {
      const batch: { cacheKey: string; frame: number; spec: BakeContentSpec }[] = [];
      while (batch.length < this.batchSize && this.queue.length > 0) {
        const target = this.queue.shift()!;
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) continue;
        batch.push({ cacheKey: target.cacheKey, frame: target.frame, spec });
      }
      await Promise.all(
        batch.map(async ({ cacheKey, frame, spec }) => {
          try {
            if (await this.deps.isOnDisk(cacheKey, frame)) { this.bump(cacheKey, touched); return; }
            const bmp = await spec.render(frame);
            if (this.disposed) { bmp.close(); return; }
            await this.deps.persist(cacheKey, frame, bmp);
            this.deps.warm(cacheKey, frame, bmp);
            this.bump(cacheKey, touched);
          } catch {
            this.markError(cacheKey, touched);
          }
        }),
      );
    } finally {
      for (const k of touched) {
        const st = this.status.get(k);
        if (st) this.deps.onStatus?.(k, { ...st });
      }
      this.running = false;
      this.arm();
    }
  }

  /// A frame completed (persisted or already-on-disk). Advance done; flip to
  /// ready at the end. No-op if the content errored.
  private bump(cacheKey: string, touched: Set<string>): void {
    const st = this.status.get(cacheKey);
    if (!st || st.phase === "error") return;
    st.done++;
    if (st.done >= st.total) st.phase = "ready";
    touched.add(cacheKey);
  }

  private markError(cacheKey: string, touched: Set<string>): void {
    const st = this.status.get(cacheKey);
    if (!st) return;
    st.phase = "error";
    touched.add(cacheKey);
  }
```

In `dispose`, add `this.status.clear();` after `this.specsByKey.clear();`.

- [ ] **Step 4: Run, confirm PASS**

Run: `npx vitest run src/render/templates/TemplateBaker.test.ts`
Expected: PASS — the 3 existing tests + the 3 new ones (6 total).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run -s typecheck
git add src/render/templates/TemplateBaker.ts src/render/templates/TemplateBaker.test.ts
git commit -m "feat(templates): TemplateBaker emits per-content bake status"
```

---

## Task 2: `templateBakeStatusStore` (Zustand + pure selectors)

**Files:**
- Create: `apps/desktop/src/timeline/templateBakeStatusStore.ts`
- Test: `apps/desktop/src/timeline/templateBakeStatusStore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import {
  selectLayerBakePhase,
  selectLayerBakeStatus,
  setLayerBakeStatuses,
  useTemplateBakeStatusStore,
  type LayerBakeStatus,
} from "./templateBakeStatusStore";

const baking: LayerBakeStatus = { phase: "baking", done: 1, total: 3 };

describe("templateBakeStatusStore", () => {
  beforeEach(() => setLayerBakeStatuses({}));

  it("pure phase selector: present → phase, absent → null", () => {
    const byLayer = { a: baking };
    expect(selectLayerBakePhase(byLayer, "a")).toBe("baking");
    expect(selectLayerBakePhase(byLayer, "missing")).toBe(null);
  });

  it("pure status selector: present → object, absent → null", () => {
    const byLayer = { a: baking };
    expect(selectLayerBakeStatus(byLayer, "a")).toEqual(baking);
    expect(selectLayerBakeStatus(byLayer, "missing")).toBe(null);
  });

  it("setLayerBakeStatuses replaces the whole map", () => {
    setLayerBakeStatuses({ a: baking });
    expect(useTemplateBakeStatusStore.getState().byLayer.a).toEqual(baking);
    setLayerBakeStatuses({ b: { phase: "ready", done: 3, total: 3 } });
    expect(useTemplateBakeStatusStore.getState().byLayer.a).toBeUndefined();
    expect(useTemplateBakeStatusStore.getState().byLayer.b?.phase).toBe("ready");
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `npx vitest run src/timeline/templateBakeStatusStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`templateBakeStatusStore.ts`):

```ts
// Per-template-layer L2 bake status, surfaced to the timeline dot + property
// panel. Written by the Compositor (which maps active template layers →
// cacheKey → status); read via ATOMIC selectors only (per
// `feedback_zustand_composite_selector` — never select the whole map object).
//
// An ABSENT layerId means idle (not baking, nothing on disk) — selectors
// return null for it, and the dot renders nothing.

import { create } from "zustand";

export interface LayerBakeStatus {
  phase: "baking" | "ready" | "error";
  done: number;
  total: number;
}

interface State {
  byLayer: Record<string, LayerBakeStatus>;
  replace: (next: Record<string, LayerBakeStatus>) => void;
}

export const useTemplateBakeStatusStore = create<State>((set) => ({
  byLayer: {},
  replace: (next) => set({ byLayer: next }),
}));

/// Replace the whole map. The Compositor recomputes the full (small) map each
/// time, so per-key diffing isn't worth it.
export function setLayerBakeStatuses(next: Record<string, LayerBakeStatus>): void {
  useTemplateBakeStatusStore.getState().replace(next);
}

// Pure lookups (unit-tested); the hooks wrap them so the dot's selector returns
// a primitive (phase string) and doesn't re-render on `done` ticks.
export const selectLayerBakePhase = (
  byLayer: Record<string, LayerBakeStatus>,
  layerId: string,
): LayerBakeStatus["phase"] | null => byLayer[layerId]?.phase ?? null;

export const selectLayerBakeStatus = (
  byLayer: Record<string, LayerBakeStatus>,
  layerId: string,
): LayerBakeStatus | null => byLayer[layerId] ?? null;

/// Dot: phase only (primitive → re-renders only on phase change).
export const useLayerBakePhase = (layerId: string): LayerBakeStatus["phase"] | null =>
  useTemplateBakeStatusStore((s) => selectLayerBakePhase(s.byLayer, layerId));

/// Panel: full status (object → re-renders the one selected panel on progress).
export const useLayerBakeStatus = (layerId: string): LayerBakeStatus | null =>
  useTemplateBakeStatusStore((s) => selectLayerBakeStatus(s.byLayer, layerId));
```

- [ ] **Step 4: Run, confirm PASS**

Run: `npx vitest run src/timeline/templateBakeStatusStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run -s typecheck
git add src/timeline/templateBakeStatusStore.ts src/timeline/templateBakeStatusStore.test.ts
git commit -m "feat(templates): templateBakeStatusStore (layerId->status, atomic selectors)"
```

---

## Task 3: Compositor wiring (onStatus → recompute → store)

**Files:**
- Modify: `apps/desktop/src/render/Compositor.ts`

Read the existing `baker` field initializer, `updateBakeTargets`, `hydrateBakedIndexAndGc`, `setProject` (both the null branch and the main flow), and `dispose` first — you'll mirror their shapes.

- [ ] **Step 1: Import the store setter**

Add near the other template imports:

```ts
import { setLayerBakeStatuses, type LayerBakeStatus } from "../timeline/templateBakeStatusStore";
```

- [ ] **Step 2: Add the status cache field + the baker's `onStatus`**

Add a field next to the baker:

```ts
  /// Latest per-cacheKey bake status from the baker. Fanned out to per-layer
  /// entries in `recomputeBakeStatuses`.
  private bakeStatusByCacheKey = new Map<string, LayerBakeStatus>();
```

In the `new TemplateBaker({ … })` deps object, add:

```ts
          onStatus: (cacheKey, status) => {
            this.bakeStatusByCacheKey.set(cacheKey, status);
            this.recomputeBakeStatuses();
          },
```

- [ ] **Step 3: Add `recomputeBakeStatuses`**

Mirror the loop/descriptor shape in `hydrateBakedIndexAndGc` (iterate enabled tracks/layers, resolve each Template layer's cacheKey with `templateFrameDescriptor(view, /*tInLayerUs*/ 0, durationUs, fpsNum, fpsDen, template)`). For each layer pick: live baker status → else `sharedBakedKeyIndex.has(key)` ready → else omit.

```ts
  /// Build the per-layer bake-status map and publish it to the store. A layer
  /// shows: its baker status if live; else "ready" if its frames are already on
  /// disk (sharedBakedKeyIndex — e.g. baked last session, toggle off); else it
  /// is omitted (idle → no dot). O(template layers); called on every onStatus,
  /// updateBakeTargets, and setProject.
  private recomputeBakeStatuses(): void {
    if (!this.projectSummary) {
      setLayerBakeStatuses({});
      return;
    }
    const byLayer: Record<string, LayerBakeStatus> = {};
    for (const track of this.projectSummary.tracks) {
      for (const layer of track.layers) {
        if (layer.params.kind !== "Template") continue;
        const template = getTemplate(layer.params.template_id);
        if (!template) continue;
        const durationUs = layer.t_end_us - layer.t_start_us;
        const desc = templateFrameDescriptor(layer.params, 0, durationUs, this.fpsNum, this.fpsDen, template);
        if (!desc) continue;
        const live = this.bakeStatusByCacheKey.get(desc.cacheKey);
        if (live) {
          byLayer[layer.id] = live;
        } else if (sharedBakedKeyIndex.has(desc.cacheKey)) {
          byLayer[layer.id] = { phase: "ready", done: desc.contentDurationFrames, total: desc.contentDurationFrames };
        }
      }
    }
    setLayerBakeStatuses(byLayer);
  }
```

(`sharedBakedKeyIndex`, `getTemplate`, `templateFrameDescriptor` are already imported in Compositor.ts.)

- [ ] **Step 4: Call recompute on re-plan + project load**

At the end of `updateBakeTargets` (after `this.baker.setTargets(specs);`) add `this.recomputeBakeStatuses();`. In `setProject`'s main flow, after `hydrateBakedIndexAndGc` is kicked / prewarm+bake targets are set, add `this.recomputeBakeStatuses();` (so a freshly-loaded project with on-disk frames shows "ready" immediately).

- [ ] **Step 5: Clear on close + dispose**

In `setProject`'s NULL branch (alongside `this.baker?.setTargets([])` etc. added for L2), add:

```ts
    this.bakeStatusByCacheKey.clear();
    setLayerBakeStatuses({});
```

In `dispose`, after the baker teardown, add the same two lines.

- [ ] **Step 6: Typecheck + render units + commit**

```bash
npm run -s typecheck
npx vitest run src/render
git add src/render/Compositor.ts
git commit -m "feat(templates): Compositor publishes per-layer bake status (baker + index fallback)"
```
Expected: typecheck exit 0; render units green.

---

## Task 4: Timeline status dot

**Files:**
- Modify: `apps/desktop/src/timeline/Timeline.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`, `zh-CN.ts`

- [ ] **Step 1: Add the i18n dot labels**

In both locale files, under the `timeline` object, add (zh shown; mirror in en):

en-US.ts `timeline`:
```ts
    bake_dot_baking: "Pre-baking…",
    bake_dot_ready: "Pre-baked",
    bake_dot_error: "Pre-bake failed",
```
zh-CN.ts `timeline`:
```ts
    bake_dot_baking: "预烘焙中…",
    bake_dot_ready: "已预烘焙",
    bake_dot_error: "预烘焙失败",
```

- [ ] **Step 2: Add the `TemplateBakeDot` component**

In `Timeline.tsx`, add a small component (place it near `DisplayModePill`/`LayerContextMenu`). Import the selector at the top:

```ts
import { useLayerBakePhase } from "./templateBakeStatusStore";
```

```tsx
/// Small status dot on a Template layer block. Phase-only (no count) so it
/// re-renders only on phase change. Hidden when idle (selector returns null).
function TemplateBakeDot({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const phase = useLayerBakePhase(layerId);
  if (!phase) return null;
  const label =
    phase === "baking"
      ? t("timeline.bake_dot_baking", { defaultValue: "Pre-baking…" })
      : phase === "ready"
        ? t("timeline.bake_dot_ready", { defaultValue: "Pre-baked" })
        : t("timeline.bake_dot_error", { defaultValue: "Pre-bake failed" });
  return <span className={`template-bake-dot is-${phase}`} title={label} aria-label={label} />;
}
```

- [ ] **Step 3: Render it in `LayerBlock`**

In `LayerBlock`'s returned JSX, change the label line (currently `<span className="layer-label">{label}</span>`) to also render the dot for Template layers:

```tsx
      <span className="layer-label">{label}</span>
      {layer.kind === "Template" && <TemplateBakeDot layerId={layer.id} />}
```

- [ ] **Step 4: Add CSS**

In `styles.css`, add:

```css
.template-bake-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  pointer-events: none;
}
.template-bake-dot.is-ready { background: #46c46a; }
.template-bake-dot.is-error { background: #e5534b; }
.template-bake-dot.is-baking {
  background: transparent;
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  border-top-color: transparent;
  animation: template-bake-spin 0.8s linear infinite;
}
@keyframes template-bake-spin { to { transform: rotate(360deg); } }
```

(The `.timeline-layer` block is already `position: relative`-ish via its absolute layout; if the dot isn't positioned correctly, confirm `.timeline-layer` establishes a positioning context — it's rendered with `position: absolute` so it's its own containing block for the absolutely-positioned dot.)

- [ ] **Step 5: Typecheck + commit**

```bash
npm run -s typecheck
git add src/timeline/Timeline.tsx src/styles.css src/i18n/locales/en-US.ts src/i18n/locales/zh-CN.ts
git commit -m "feat(timeline): per-template-layer pre-bake status dot"
```

---

## Task 5: Property-panel status line

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx`
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`, `zh-CN.ts`

- [ ] **Step 1: Add the i18n strings**

In both locale files, under `property_panel`, add (with `{{done}}`/`{{total}}` interpolation per i18next):

en-US.ts:
```ts
    bake_idle: "Not pre-baked — enable Pre-bake in Settings, or right-click → Pre-bake now",
    bake_baking: "Pre-baking… {{done}}/{{total}}",
    bake_ready: "Pre-baked ({{total}} frames)",
    bake_error: "Pre-bake failed",
```
zh-CN.ts:
```ts
    bake_idle: "未烘焙 — 在设置中开启预烘焙，或右键『立即预烘焙』",
    bake_baking: "预烘焙中 {{done}}/{{total}}",
    bake_ready: "已预烘焙（{{total}} 帧）",
    bake_error: "预烘焙失败",
```

- [ ] **Step 2: Add a `BakeStatusLine` component + render it**

In `PropertyPanel.tsx`, import the selector:

```ts
import { useLayerBakeStatus } from "../timeline/templateBakeStatusStore";
```

Add the component (near `TemplateFields`):

```tsx
function BakeStatusLine({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const status = useLayerBakeStatus(layerId);
  const text = !status
    ? t("property_panel.bake_idle")
    : status.phase === "baking"
      ? t("property_panel.bake_baking", { done: status.done, total: status.total })
      : status.phase === "ready"
        ? t("property_panel.bake_ready", { total: status.total })
        : t("property_panel.bake_error");
  const cls = `prop-bake-status is-${status?.phase ?? "idle"}`;
  return <p className={cls}>{text}</p>;
}
```

In `TemplateFields`, render it just after the section `<h3>` (line ~620, `<h3>{t("property_panel.template")}</h3>`):

```tsx
      <h3>{t("property_panel.template")}</h3>
      <BakeStatusLine layerId={layer.id} />
```

- [ ] **Step 3: (optional) CSS for the status line**

In `styles.css` add a subtle style (reuse existing muted-text class if one exists; otherwise):

```css
.prop-bake-status { margin: 0 0 8px; font-size: 12px; opacity: 0.8; }
.prop-bake-status.is-error { color: #e5534b; }
.prop-bake-status.is-ready { color: #46c46a; }
```

- [ ] **Step 4: Typecheck + commit**

```bash
npm run -s typecheck
git add src/properties/PropertyPanel.tsx src/i18n/locales/en-US.ts src/i18n/locales/zh-CN.ts src/styles.css
git commit -m "feat(properties): template bake-status line in the property panel"
```

---

## Task 6: Real-WebView2 e2e — dot reflects baking → ready

**Files:**
- Create: `apps/desktop/e2e/specs/template_bake_status.e2e.js`

Follow `template_prebake.e2e.js` for harness setup (it already uses `newProjectAndEnter` + `addTemplateLayer` + `prebakeLayerAndWait` hooks under `VITE_WEFTCUT_E2E=1`). This test asserts the DOM dot class transitions.

- [ ] **Step 1: Write the spec**

```js
import os from "node:os";
import path from "node:path";

const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-bakestatus-proj");
const TEMPLATE_ID = "countdown";
const DURATION_US = 5_000_000;
const CONTENT_FRAMES = 150;

describe("template bake-status dot (real WebView2)", function () {
  let layerId = null;

  before(async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000 },
    );
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.__weftcutTest?.newProjectAndEnter === "function"),
      { timeout: 30000 },
    );
    const r1 = await browser.executeAsync((parent, done) => {
      window.__weftcutTest.newProjectAndEnter({
        parentFolder: parent, name: "e2e-bakestatus-" + Date.now(),
        canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
      }).then(() => done({ ok: true })).catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter: " + r1.error);
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.__weftcutTest?.addTemplateLayer === "function"),
      { timeout: 30000 },
    );
    const r2 = await browser.executeAsync((tid, dur, done) => {
      window.__weftcutTest.addTemplateLayer({ templateId: tid, durationUs: dur })
        .then((id) => done({ ok: true, id })).catch((e) => done({ ok: false, error: String(e) }));
    }, TEMPLATE_ID, DURATION_US);
    if (!r2.ok) throw new Error("addTemplateLayer: " + r2.error);
    layerId = r2.id;
  });

  it("shows no dot before pre-bake, then a ready dot after baking", async () => {
    // Idle: no dot rendered for the template layer.
    const before = await browser.execute(() => document.querySelectorAll(".template-bake-dot").length);
    expect(before).toBe(0);

    // Trigger a full bake via the same bus the context menu uses, wait for disk.
    const r = await browser.executeAsync((id, frames, done) => {
      window.__weftcutTest.prebakeLayerAndWait({ layerId: id, expectedFrames: frames, timeoutMs: 90000 })
        .then((res) => done({ ok: true, ...res })).catch((e) => done({ ok: false, error: String(e) }));
    }, layerId, CONTENT_FRAMES);
    if (!r.ok) throw new Error("prebakeLayerAndWait: " + r.error);

    // The dot should settle to ready (the recompute runs on each onStatus).
    await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector(".template-bake-dot.is-ready")),
      { timeout: 15000, timeoutMsg: "ready dot never appeared" },
    );
    const errCount = await browser.execute(() => document.querySelectorAll(".template-bake-dot.is-error").length);
    expect(errCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it**

Run (derive exact invocation from `e2e/wdio.conf.mjs`, same as the prebake spec):
`cd e2e && node_modules/.bin/wdio run wdio.conf.mjs --spec specs/template_bake_status.e2e.js`
Expected: 1/1 pass in real WebView2 — no dot before, a `.is-ready` dot after.

- [ ] **Step 3: No-regression + commit**

Run the existing template specs to confirm nothing broke:
`cd e2e && node_modules/.bin/wdio run wdio.conf.mjs --spec specs/template_prebake.e2e.js`
Then:
```bash
git add e2e/specs/template_bake_status.e2e.js
git commit -m "test(templates): e2e — bake-status dot goes idle→ready"
```

---

## Task 7: Reconcile docs

**Files:**
- Modify: `docs/templates.md`

- [ ] **Step 1: Note the UI status surface**

In `docs/templates.md`'s agent-surface / status discussion, add a sentence (evergreen, present tense — no dates) that per-layer bake status (`baking | ready | error`, idle when neither) is surfaced in the UI as a status dot on the template's timeline block and a line in its property panel, driven by the baker's status events plus the baked-key index (so a layer baked in a prior session reads as ready). Keep it brief; don't introduce the deferred MCP/events surface as if it exists.

- [ ] **Step 2: Commit**

```bash
git add docs/templates.md
git commit -m "docs(templates): note the per-layer bake-status UI surface"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** baker status emission (T1), store + atomic selectors (T2), Compositor fan-out + index-derived ready (T3), timeline dot phase-only (T4), property-panel line with count + idle/neutral text (T5), live verification (T6), docs (T7). The four states, default-off-neutral, shared-cacheKey fan-out, prior-session "ready", and error-coarse are all covered.
- **Out of scope honored:** no MCP/events bridge, no export gating, no numeric on the dot.
- **Type consistency:** `BakeStatus`/`BakePhase` (baker) and `LayerBakeStatus` (store) share the same shape `{phase,done,total}`; `onStatus(cacheKey, BakeStatus)` matches the Compositor's handler; `setLayerBakeStatuses(Record<string,LayerBakeStatus>)`, `useLayerBakePhase`, `useLayerBakeStatus` names are consistent across T2/T3/T4/T5.
