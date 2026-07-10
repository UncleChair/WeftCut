# Global Color Picker (Eyedropper) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global eyedropper: every `AppColorField` swatch and the chromakey key color can pick from the composited preview (working-space-true), any in-app pixel, or the whole screen.

**Architecture:** Frozen dual-buffer in-app pick session (one `extract.pixels` composition freeze + one `capturePage()` window snapshot at session start; all hover sampling is CPU reads) + native `EyeDropper` as the screen fallback. Hover live-apply flows through a transient `effectOverrides` store consulted by `EffectChain.sync()`. Spec: `docs/superpowers/specs/2026-07-11-color-picker-design.md`.

**Tech Stack:** React 19 + TypeScript (strict, `exactOptionalPropertyTypes`), zustand, PixiJS v8 (`extract.pixels`), Electron 42 (`webContents.capturePage`, `window.EyeDropper`), vitest + @testing-library/react (jsdom), Playwright `_electron`.

## Global Constraints

- All commands run from `apps/desktop/` (the npm workspace with the scripts).
- TypeScript strict + `exactOptionalPropertyTypes`: never pass an explicit `undefined` to an optional prop — spread conditionally (`...(x !== undefined ? { x } : {})`).
- Comments follow `docs/comment-style.md`: summary / why / landmine / pointer only. No narration.
- Icons come from `lucide-react` only (ADR 0020). The eyedropper icon is `Pipette`.
- Every user-visible string goes through i18next with keys in BOTH `en-US.ts` and `zh-CN.ts`.
- Playhead-gate discipline: pointer-move-rate work must NEVER write React state — imperative DOM via refs only.
- Transient overrides must never enter project state or undo history.
- Commit after each task; stage by EXPLICIT file paths only (the user edits this checkout concurrently — never `git add -A`).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Pure pixel math (`pixel.ts`)

**Files:**
- Create: `apps/desktop/src/renderer/colorpick/pixel.ts`
- Test: `apps/desktop/src/renderer/colorpick/pixel.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (used by Tasks 3, 6, 7, 9):
  - `interface FrameBuffer { pixels: Uint8Array | Uint8ClampedArray; width: number; height: number; }`
  - `rgbToHex(r: number, g: number, b: number): string` — bytes → `"#rrggbb"`
  - `hexToRgb01(hex: string): [number, number, number]` — `"#rrggbb"` → 0–1 floats
  - `sampleHex(buf: FrameBuffer, x: number, y: number): string` — clamped read
  - `samplePatch(buf: FrameBuffer, cx: number, cy: number, radius: number): FrameBuffer` — clamped square patch for the magnifier
  - `containMap(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, contentW: number, contentH: number): { x: number; y: number } | null` — `object-fit: contain` letterbox mapping

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/colorpick/pixel.test.ts
import { describe, expect, it } from "vitest";
import { containMap, hexToRgb01, rgbToHex, sampleHex, samplePatch } from "./pixel";

const buf2x2 = {
  // (0,0)=red (1,0)=green (0,1)=blue (1,1)=white
  pixels: new Uint8Array([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   255, 255, 255, 255,
  ]),
  width: 2,
  height: 2,
};

describe("hex conversion", () => {
  it("rgbToHex zero-pads and lowercases", () => {
    expect(rgbToHex(255, 0, 10)).toBe("#ff000a");
  });
  it("hexToRgb01 round-trips", () => {
    expect(hexToRgb01("#ff0000")).toEqual([1, 0, 0]);
    const [r, g, b] = hexToRgb01("#336699");
    expect(r).toBeCloseTo(0x33 / 255);
    expect(g).toBeCloseTo(0x66 / 255);
    expect(b).toBeCloseTo(0x99 / 255);
  });
});

describe("sampleHex", () => {
  it("reads the addressed pixel", () => {
    expect(sampleHex(buf2x2, 0, 0)).toBe("#ff0000");
    expect(sampleHex(buf2x2, 1, 1)).toBe("#ffffff");
  });
  it("clamps out-of-range coordinates", () => {
    expect(sampleHex(buf2x2, -5, 0)).toBe("#ff0000");
    expect(sampleHex(buf2x2, 99, 99)).toBe("#ffffff");
  });
});

describe("samplePatch", () => {
  it("returns a (2r+1)² patch with edge clamping", () => {
    const p = samplePatch(buf2x2, 0, 0, 1);
    expect(p.width).toBe(3);
    expect(p.height).toBe(3);
    // Center = (0,0) red; corner (-1,-1) clamps to (0,0) red too.
    expect(sampleHex(p, 1, 1)).toBe("#ff0000");
    expect(sampleHex(p, 0, 0)).toBe("#ff0000");
    // (2,2) of the patch = source (1,1) white.
    expect(sampleHex(p, 2, 2)).toBe("#ffffff");
  });
});

describe("containMap", () => {
  // 16:9 content (1920×1080) inside a 1000×1000 rect at (0,0):
  // scale=1000/1920, content displays 1000×562.5, top offset 218.75.
  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  it("maps the rect center to the content center", () => {
    expect(containMap(500, 500, rect, 1920, 1080)).toEqual({ x: 960, y: 540 });
  });
  it("returns null in the letterbox bars", () => {
    expect(containMap(500, 100, rect, 1920, 1080)).toBeNull();
    expect(containMap(500, 950, rect, 1920, 1080)).toBeNull();
  });
  it("returns null for degenerate rects", () => {
    expect(containMap(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 1920, 1080)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/colorpick/pixel.test.ts`
Expected: FAIL — `Cannot find module './pixel'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/renderer/colorpick/pixel.ts
// CPU-side sampling math for the color-pick session. Pure — the overlay and
// the preview sampler both build on these, so every coordinate rule is
// testable without a renderer. Spec:
// docs/superpowers/specs/2026-07-11-color-picker-design.md

export interface FrameBuffer {
  pixels: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/// Clamped single-pixel read → "#rrggbb". Alpha is deliberately ignored
/// (design: samples take RGB; transparent regions show whatever the buffer holds).
export function sampleHex(buf: FrameBuffer, x: number, y: number): string {
  const px = Math.max(0, Math.min(buf.width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(buf.height - 1, Math.floor(y)));
  const i = (py * buf.width + px) * 4;
  return rgbToHex(buf.pixels[i] ?? 0, buf.pixels[i + 1] ?? 0, buf.pixels[i + 2] ?? 0);
}

/// (2·radius+1)² patch around (cx,cy) for the magnifier, edge-clamped so the
/// cursor can ride the buffer border without the patch shrinking.
export function samplePatch(buf: FrameBuffer, cx: number, cy: number, radius: number): FrameBuffer {
  const size = radius * 2 + 1;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const sx = Math.max(0, Math.min(buf.width - 1, Math.floor(cx) + dx));
      const sy = Math.max(0, Math.min(buf.height - 1, Math.floor(cy) + dy));
      const si = (sy * buf.width + sx) * 4;
      const di = ((dy + radius) * size + (dx + radius)) * 4;
      out[di] = buf.pixels[si] ?? 0;
      out[di + 1] = buf.pixels[si + 1] ?? 0;
      out[di + 2] = buf.pixels[si + 2] ?? 0;
      out[di + 3] = 255;
    }
  }
  return { pixels: out, width: size, height: size };
}

/// `object-fit: contain` inverse: client point → content pixel, or null when
/// the point lands in the letterbox bars (not content) or the rect is degenerate.
export function containMap(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  contentW: number,
  contentH: number,
): { x: number; y: number } | null {
  const scale = Math.min(rect.width / contentW, rect.height / contentH);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const offX = rect.left + (rect.width - contentW * scale) / 2;
  const offY = rect.top + (rect.height - contentH * scale) / 2;
  const x = Math.floor((clientX - offX) / scale);
  const y = Math.floor((clientY - offY) / scale);
  if (x < 0 || y < 0 || x >= contentW || y >= contentH) return null;
  return { x, y };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/colorpick/pixel.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/colorpick/pixel.ts src/renderer/colorpick/pixel.test.ts
git commit -m "feat(colorpick): pure pixel sampling math (hex, patch, contain-map)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Transient effect overrides + `EffectChain` consultation

**Files:**
- Create: `apps/desktop/src/renderer/render/effects/effectOverrides.ts`
- Modify: `apps/desktop/src/renderer/render/effects/EffectChain.ts`
- Test: `apps/desktop/src/renderer/render/effects/effectOverrides.test.ts`
- Test: `apps/desktop/src/renderer/render/effects/EffectChain.test.ts` (new)

**Interfaces:**
- Consumes: `EffectChain.sync(views: EffectView[], tInLayerUs: number): Filter[]` (existing), `getDescriptor(kind)` (existing).
- Produces (used by Tasks 3, 9):
  - `setTransientOverrides(effectId: string, values: Record<string, number>): void`
  - `clearTransientOverrides(effectId: string): void`
  - `overrideFor(effectId: string, param: string): number | undefined`
  - `setEffectDisabled(effectId: string, disabled: boolean): void`
  - `isEffectDisabled(effectId: string): boolean`
  - `subscribeEffectOverrides(fn: () => void): () => void`
  - `resetEffectOverrides(): void` (test/session-safety helper)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/renderer/render/effects/effectOverrides.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTransientOverrides,
  isEffectDisabled,
  overrideFor,
  resetEffectOverrides,
  setEffectDisabled,
  setTransientOverrides,
  subscribeEffectOverrides,
} from "./effectOverrides";

afterEach(resetEffectOverrides);

describe("effectOverrides", () => {
  it("set/clear round-trips per effect id", () => {
    setTransientOverrides("E1", { keyR: 0.5, keyG: 0.25 });
    expect(overrideFor("E1", "keyR")).toBe(0.5);
    expect(overrideFor("E1", "keyB")).toBeUndefined();
    expect(overrideFor("E2", "keyR")).toBeUndefined();
    clearTransientOverrides("E1");
    expect(overrideFor("E1", "keyR")).toBeUndefined();
  });
  it("disabled flag round-trips", () => {
    expect(isEffectDisabled("E1")).toBe(false);
    setEffectDisabled("E1", true);
    expect(isEffectDisabled("E1")).toBe(true);
    setEffectDisabled("E1", false);
    expect(isEffectDisabled("E1")).toBe(false);
  });
  it("notifies subscribers on every change; unsubscribe stops it", () => {
    const fn = vi.fn();
    const unsub = subscribeEffectOverrides(fn);
    setTransientOverrides("E1", { a: 1 });
    setEffectDisabled("E1", true);
    clearTransientOverrides("E1");
    expect(fn).toHaveBeenCalledTimes(3);
    unsub();
    setTransientOverrides("E1", { a: 2 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
```

```ts
// apps/desktop/src/renderer/render/effects/EffectChain.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { EffectView } from "../../ipc";
import { EffectChain } from "./EffectChain";
import {
  resetEffectOverrides,
  setEffectDisabled,
  setTransientOverrides,
} from "./effectOverrides";

afterEach(resetEffectOverrides);

const chromaView = (id: string): EffectView => ({
  id,
  kind: "chromakey",
  enabled: true,
  params: { keyR: { mode: "Static", value: 0.1 } },
});

// Uniform layout per ChromaKeyFilter.ts:67-68.
function uKey(filter: unknown): Float32Array {
  return (filter as { resources: { chromaUniforms: { uniforms: { uKey: Float32Array } } } })
    .resources.chromaUniforms.uniforms.uKey;
}

describe("EffectChain × effectOverrides", () => {
  it("transient override wins over the resolved param value", () => {
    const chain = new EffectChain();
    const filters = chain.sync([chromaView("E1")], 0);
    expect(filters).toHaveLength(1);
    expect(uKey(filters[0]!)[0]).toBeCloseTo(0.1);
    setTransientOverrides("E1", { keyR: 0.9 });
    const again = chain.sync([chromaView("E1")], 0);
    expect(uKey(again[0]!)[0]).toBeCloseTo(0.9);
    chain.dispose();
  });
  it("disabled effect is excluded from the returned filter list without a rebuild", () => {
    const chain = new EffectChain();
    const before = chain.sync([chromaView("E1")], 0);
    setEffectDisabled("E1", true);
    expect(chain.sync([chromaView("E1")], 0)).toHaveLength(0);
    setEffectDisabled("E1", false);
    const after = chain.sync([chromaView("E1")], 0);
    // Same instance — exclusion is a return-filter, not a structural rebuild.
    expect(after[0]).toBe(before[0]);
    chain.dispose();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/render/effects/effectOverrides.test.ts src/renderer/render/effects/EffectChain.test.ts`
Expected: FAIL — `Cannot find module './effectOverrides'`

- [ ] **Step 3: Write `effectOverrides.ts`**

```ts
// apps/desktop/src/renderer/render/effects/effectOverrides.ts
// Transient, NON-recorded per-effect param overrides + disable flags for the
// color-pick session. EffectChain.sync() consults this AFTER resolveAnimated —
// sync rewrites every uniform from resolved params each frame, so writing
// filter uniforms directly gets clobbered on the next composite. Never enters
// React state or undo. Spec:
// docs/superpowers/specs/2026-07-11-color-picker-design.md

const overrides = new Map<string, Record<string, number>>();
const disabled = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setTransientOverrides(effectId: string, values: Record<string, number>): void {
  overrides.set(effectId, values);
  emit();
}

export function clearTransientOverrides(effectId: string): void {
  const had = overrides.delete(effectId);
  if (had) emit();
}

export function overrideFor(effectId: string, param: string): number | undefined {
  return overrides.get(effectId)?.[param];
}

export function setEffectDisabled(effectId: string, value: boolean): void {
  if (value) disabled.add(effectId);
  else disabled.delete(effectId);
  emit();
}

export function isEffectDisabled(effectId: string): boolean {
  return disabled.has(effectId);
}

/// PixiPreview subscribes to re-composite on change — paused playback renders
/// the stage every tick but only compositeFrame re-runs EffectChain.sync.
export function subscribeEffectOverrides(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetEffectOverrides(): void {
  overrides.clear();
  disabled.clear();
  emit();
}
```

- [ ] **Step 4: Wire `EffectChain.sync`**

In `apps/desktop/src/renderer/render/effects/EffectChain.ts`, add the import:

```ts
import { isEffectDisabled, overrideFor } from "./effectOverrides";
```

Change the param-apply loop body (currently `const v = resolveAnimated(...); paramSpec.apply(inst.filter, v);`) to:

```ts
      for (const [key, paramSpec] of Object.entries(spec)) {
        const v = resolveAnimated(view.params[key], tInLayerUs, paramSpec.default);
        // Color-pick hover live-apply: a transient override (never recorded)
        // wins over the resolved track value for this frame only.
        paramSpec.apply(inst.filter, overrideFor(inst.id, key) ?? v);
      }
```

Change the final return (currently `return this.instances.map((i) => i.filter);`) to:

```ts
    // Color-pick freeze: an override-disabled effect is excluded from THIS
    // frame's filter list but keeps its instance (no destroy/recompile churn).
    return this.instances.filter((i) => !isEffectDisabled(i.id)).map((i) => i.filter);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/render/effects/effectOverrides.test.ts src/renderer/render/effects/EffectChain.test.ts`
Expected: PASS. If the `uKey` helper in the test fails on the real resources shape, simplify it to match `ChromaKeyFilter`'s actual layout (`filter.resources.chromaUniforms.uniforms.uKey`, see `ChromaKeyFilter.ts:67-68`) — fix the TEST, not the filter.

- [ ] **Step 6: Run the neighboring effect tests for regressions**

Run: `npx vitest run src/renderer/render/effects`
Expected: PASS (registry + ChromaKeyFilter suites untouched)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/render/effects/effectOverrides.ts src/renderer/render/effects/effectOverrides.test.ts src/renderer/render/effects/EffectChain.ts src/renderer/render/effects/EffectChain.test.ts
git commit -m "feat(colorpick): transient effect overrides consulted by EffectChain.sync

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Preview sampler registry + PixiPreview registration

**Files:**
- Create: `apps/desktop/src/renderer/colorpick/previewSamplerRegistry.ts`
- Modify: `apps/desktop/src/renderer/render/PixiPreview.tsx`
- Test: `apps/desktop/src/renderer/colorpick/previewSamplerRegistry.test.ts`

**Interfaces:**
- Consumes: `FrameBuffer` (Task 1), `setEffectDisabled` / `subscribeEffectOverrides` (Task 2), PixiPreview's `compositor` / `engine` / `app` (existing, inside `handleInit`).
- Produces (used by Tasks 6, 7):
  - `interface PreviewSampler { captureFrame(opts?: { excludeEffectId?: string }): Promise<FrameBuffer>; mapClientToComposition(clientX: number, clientY: number): { x: number; y: number } | null; canvasRect(): DOMRect | null; }`
  - `registerPreviewSampler(s: PreviewSampler): void`
  - `clearPreviewSampler(s: PreviewSampler): void` (identity-guarded)
  - `getPreviewSampler(): PreviewSampler | null`

- [ ] **Step 1: Write the failing registry test**

```ts
// apps/desktop/src/renderer/colorpick/previewSamplerRegistry.test.ts
import { describe, expect, it } from "vitest";
import {
  clearPreviewSampler,
  getPreviewSampler,
  registerPreviewSampler,
  type PreviewSampler,
} from "./previewSamplerRegistry";

const fake = (): PreviewSampler => ({
  captureFrame: async () => ({ pixels: new Uint8Array(4), width: 1, height: 1 }),
  mapClientToComposition: () => null,
  canvasRect: () => null,
});

describe("previewSamplerRegistry", () => {
  it("register/get/clear; clear is identity-guarded", () => {
    const a = fake();
    const b = fake();
    registerPreviewSampler(a);
    expect(getPreviewSampler()).toBe(a);
    registerPreviewSampler(b); // re-register replaces (StrictMode re-mount)
    clearPreviewSampler(a);    // stale unmount must NOT tear down the live one
    expect(getPreviewSampler()).toBe(b);
    clearPreviewSampler(b);
    expect(getPreviewSampler()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/colorpick/previewSamplerRegistry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the registry**

```ts
// apps/desktop/src/renderer/colorpick/previewSamplerRegistry.ts
// The one handshake between the color picker and the preview: PixiPreview
// registers a sampling surface on mount (same lifecycle pattern as
// registerTransport in state/playbackStore.ts); the pick session and overlay
// consume it without knowing Pixi exists.

import type { FrameBuffer } from "./pixel";

export interface PreviewSampler {
  /// One full-frame working-space freeze (composition resolution).
  /// `excludeEffectId` disables that effect's filter for the freeze so the
  /// sample matches the shader's INPUT (the chromakey feedback-loop fix).
  captureFrame(opts?: { excludeEffectId?: string }): Promise<FrameBuffer>;
  /// CSS-px client point → composition pixel (letterbox-aware), or null when
  /// the point is outside the composition content.
  mapClientToComposition(clientX: number, clientY: number): { x: number; y: number } | null;
  /// The canvas element's CSS-px bounds for region hit-testing, null pre-mount.
  canvasRect(): DOMRect | null;
}

let sampler: PreviewSampler | null = null;

export function registerPreviewSampler(s: PreviewSampler): void {
  sampler = s;
}

/// Identity-guarded: a stale unmount can't tear down a newer mount's sampler.
export function clearPreviewSampler(s: PreviewSampler): void {
  if (sampler === s) sampler = null;
}

export function getPreviewSampler(): PreviewSampler | null {
  return sampler;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/colorpick/previewSamplerRegistry.test.ts`
Expected: PASS

- [ ] **Step 5: Register from PixiPreview**

In `apps/desktop/src/renderer/render/PixiPreview.tsx`:

Add imports (near the other `../` imports):

```ts
import { containMap } from "../colorpick/pixel";
import {
  clearPreviewSampler,
  registerPreviewSampler,
  type PreviewSampler,
} from "../colorpick/previewSamplerRegistry";
import {
  setEffectDisabled,
  subscribeEffectOverrides,
} from "./effects/effectOverrides";
```

Add two refs next to `meterTimerRef`:

```ts
  const samplerRef = useRef<PreviewSampler | null>(null);
  const unsubOverridesRef = useRef<(() => void) | null>(null);
```

In `handleInit`, immediately after `registerTransport(engine);`, add:

```ts
      // Color picker: register the sampling surface (same replace-on-remount
      // lifecycle as the transport registration above). captureFrame reuses the
      // compositeFrame→render→extract discipline the e2e sampleComposite path
      // proved; excludeEffectId freezes the PRE-key frame the chromakey
      // eyedropper samples. Spec: docs/superpowers/specs/2026-07-11-color-picker-design.md
      unsubOverridesRef.current?.();
      const previewSampler: PreviewSampler = {
        captureFrame: async (opts) => {
          const excludeId = opts?.excludeEffectId;
          if (excludeId) setEffectDisabled(excludeId, true);
          try {
            compositor.compositeFrame(engine.positionUs());
            app.renderer.render(app.stage);
            const out = app.renderer.extract.pixels({
              target: app.stage,
              frame: new Rectangle(0, 0, app.renderer.width, app.renderer.height),
            });
            return { pixels: out.pixels, width: out.width, height: out.height };
          } finally {
            if (excludeId) {
              setEffectDisabled(excludeId, false);
              compositor.compositeFrame(engine.positionUs());
            }
          }
        },
        mapClientToComposition: (clientX, clientY) => {
          const rect = (app.canvas as HTMLCanvasElement).getBoundingClientRect();
          return containMap(clientX, clientY, rect, app.renderer.width, app.renderer.height);
        },
        canvasRect: () => (app.canvas as HTMLCanvasElement).getBoundingClientRect(),
      };
      registerPreviewSampler(previewSampler);
      samplerRef.current = previewSampler;
      // Hover live-apply while paused: sync() only runs inside compositeFrame,
      // so poke one on every transient-override change.
      unsubOverridesRef.current = subscribeEffectOverrides(() => {
        compositor.compositeFrame(engine.positionUs());
      });
```

In the unmount cleanup effect (the one that calls `releaseTransport`), add before `engineRef.current?.dispose();`:

```ts
      if (samplerRef.current) clearPreviewSampler(samplerRef.current);
      samplerRef.current = null;
      unsubOverridesRef.current?.();
      unsubOverridesRef.current = null;
```

- [ ] **Step 6: Typecheck + effect tests**

Run: `npm run typecheck && npx vitest run src/renderer/colorpick src/renderer/render/effects`
Expected: PASS (the PixiPreview glue is runtime-verified by Task 10's e2e)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/colorpick/previewSamplerRegistry.ts src/renderer/colorpick/previewSamplerRegistry.test.ts src/renderer/render/PixiPreview.tsx
git commit -m "feat(colorpick): preview sampler registry + PixiPreview registration

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Window snapshot IPC (`capturePage`)

**Files:**
- Modify: `apps/desktop/src/main/index.ts` (after the `window:setTitle` handler, ~line 510)
- Modify: `apps/desktop/src/preload/index.ts` (the `window` group)
- Modify: `apps/desktop/src/shared/ipc.ts` (the `WeftcutApi` `window` group type)
- Create: `apps/desktop/src/renderer/colorpick/snapshot.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 6):
  - IPC channel `window:captureSnapshot` → PNG bytes (`Uint8Array`)
  - `interface WindowSnapshot { data: ImageData; scaleX: number; scaleY: number; }`
  - `captureWindowSnapshot(): Promise<WindowSnapshot>`

- [ ] **Step 1: Main-process handler**

In `apps/desktop/src/main/index.ts`, directly after the `window:setTitle` handler line, add:

```ts
  // Color picker: freeze the invoking window for in-app (non-canvas) sampling.
  // PNG keeps the IPC payload small; the renderer derives the CSS→device pixel
  // scale from the decoded bitmap size vs window.innerWidth (robust across
  // display scale factors).
  ipcMain.handle('window:captureSnapshot', async (e) => {
    const img = await e.sender.capturePage()
    return img.toPNG()
  })
```

- [ ] **Step 2: Preload + shared type**

In `apps/desktop/src/preload/index.ts`, add to the `window` group (after `setTitle`):

```ts
    captureSnapshot: (): Promise<Uint8Array> =>
      ipcRenderer.invoke('window:captureSnapshot') as Promise<Uint8Array>,
```

In `apps/desktop/src/shared/ipc.ts`, find the `WeftcutApi` interface's `window` group and add after its `setTitle` member:

```ts
    captureSnapshot(): Promise<Uint8Array>
```

- [ ] **Step 3: Renderer decode wrapper**

```ts
// apps/desktop/src/renderer/colorpick/snapshot.ts
// Frozen window snapshot for in-app non-canvas sampling. One capturePage IPC +
// one PNG decode per pick session; every hover read afterwards is a CPU array
// access. scaleX/scaleY convert CSS-px client coords → snapshot device pixels.

export interface WindowSnapshot {
  data: ImageData;
  scaleX: number;
  scaleY: number;
}

export async function captureWindowSnapshot(): Promise<WindowSnapshot> {
  const png = await window.api.window.captureSnapshot();
  const bmp = await createImageBitmap(new Blob([png as unknown as BlobPart], { type: "image/png" }));
  const w = bmp.width;
  const h = bmp.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    throw new Error("captureWindowSnapshot: no 2d context");
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return {
    data: ctx.getImageData(0, 0, w, h),
    scaleX: w / window.innerWidth,
    scaleY: h / window.innerHeight,
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (No unit test — this is pure wiring around `capturePage`/canvas APIs jsdom can't host; Task 10's e2e and the manual checklist exercise it. If `window.api` typing fails, mirror how an existing renderer module reaches `window.api.window.*` — see `src/renderer/bridge/window.ts:8`.)

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/preload/index.ts src/shared/ipc.ts src/renderer/colorpick/snapshot.ts
git commit -m "feat(colorpick): window:captureSnapshot IPC + renderer decode wrapper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Native EyeDropper wrapper (`screenPick.ts`)

**Files:**
- Create: `apps/desktop/src/renderer/colorpick/screenPick.ts`
- Test: `apps/desktop/src/renderer/colorpick/screenPick.test.ts`

**Interfaces:**
- Produces (used by Task 7):
  - `eyeDropperAvailable(): boolean`
  - `screenPick(): Promise<string | null>` — `"#rrggbb"` or null (cancel/unavailable)

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/colorpick/screenPick.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { eyeDropperAvailable, screenPick } from "./screenPick";

type W = { EyeDropper?: unknown };
afterEach(() => {
  delete (window as W).EyeDropper;
  vi.restoreAllMocks();
});

describe("screenPick", () => {
  it("unavailable without window.EyeDropper", async () => {
    expect(eyeDropperAvailable()).toBe(false);
    expect(await screenPick()).toBeNull();
  });
  it("resolves the lowercased sRGBHex", async () => {
    (window as W).EyeDropper = class {
      open() { return Promise.resolve({ sRGBHex: "#AABBCC" }); }
    };
    expect(eyeDropperAvailable()).toBe(true);
    expect(await screenPick()).toBe("#aabbcc");
  });
  it("maps AbortError (user Esc) to null", async () => {
    (window as W).EyeDropper = class {
      open() { return Promise.reject(new DOMException("aborted", "AbortError")); }
    };
    expect(await screenPick()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/colorpick/screenPick.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/renderer/colorpick/screenPick.ts
// Native Chromium eyedropper = the SCREEN half of the hybrid design. It
// returns only { sRGBHex } — no coordinates, no hover events — which is why it
// cannot carry the in-app session (spec §"Why the native EyeDropper cannot
// carry the whole feature"). open() requires transient activation: call it
// from a click/keydown handler only.

interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>;
}
type EyeDropperCtor = new () => EyeDropperLike;

function ctor(): EyeDropperCtor | null {
  const w = window as unknown as { EyeDropper?: EyeDropperCtor };
  return typeof w.EyeDropper === "function" ? w.EyeDropper : null;
}

export function eyeDropperAvailable(): boolean {
  return ctor() !== null;
}

/// "#rrggbb", or null on cancel (AbortError) / unavailable API. Never throws.
export async function screenPick(): Promise<string | null> {
  const ED = ctor();
  if (!ED) return null;
  try {
    const r = await new ED().open();
    return r.sRGBHex.toLowerCase();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/colorpick/screenPick.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/colorpick/screenPick.ts src/renderer/colorpick/screenPick.test.ts
git commit -m "feat(colorpick): native EyeDropper wrapper with abort-to-null mapping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Pick session core (`pickColor.ts`)

**Files:**
- Create: `apps/desktop/src/renderer/colorpick/pickColor.ts`
- Test: `apps/desktop/src/renderer/colorpick/pickColor.test.ts`

**Interfaces:**
- Consumes: `getPreviewSampler` (Task 3), `captureWindowSnapshot`/`WindowSnapshot` (Task 4), `FrameBuffer` (Task 1), `transportPause` (`../state/playbackStore`), `logEmit` (`../ipc`).
- Produces (used by Tasks 7, 8, 9):
  - `interface PickOptions { excludeEffectId?: string; onHover?: (hex: string) => void; }`
  - `interface PickResult { hex: string; source: "composition" | "ui" | "screen"; }`
  - `interface PickSession { opts: PickOptions; comp: FrameBuffer | null; snap: WindowSnapshot | null; settle(result: PickResult | null): void; }`
  - `usePickSessionStore` (zustand, `{ session: PickSession | null }`)
  - `pickColor(opts?: PickOptions): Promise<PickResult | null>` — null = cancelled

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/renderer/colorpick/pickColor.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { logEmit } = vi.hoisted(() => ({ logEmit: vi.fn(async () => {}) }));
vi.mock("../ipc", () => ({ logEmit }));
const { captureWindowSnapshot } = vi.hoisted(() => ({
  captureWindowSnapshot: vi.fn(async () => ({
    data: { data: new Uint8ClampedArray(4), width: 1, height: 1 } as unknown as ImageData,
    scaleX: 1,
    scaleY: 1,
  })),
}));
vi.mock("./snapshot", () => ({ captureWindowSnapshot }));

import { pickColor, usePickSessionStore } from "./pickColor";
import {
  clearPreviewSampler,
  getPreviewSampler,
  registerPreviewSampler,
  type PreviewSampler,
} from "./previewSamplerRegistry";

const goodSampler = (): PreviewSampler => ({
  captureFrame: vi.fn(async () => ({ pixels: new Uint8Array([1, 2, 3, 255]), width: 1, height: 1 })),
  mapClientToComposition: () => ({ x: 0, y: 0 }),
  canvasRect: () => null,
});

afterEach(() => {
  usePickSessionStore.getState().session?.settle(null);
  const s = getPreviewSampler();
  if (s) clearPreviewSampler(s);
  vi.clearAllMocks();
});

describe("pickColor", () => {
  it("opens a session and resolves through settle", async () => {
    registerPreviewSampler(goodSampler());
    const p = pickColor();
    await vi.waitFor(() => expect(usePickSessionStore.getState().session).not.toBeNull());
    usePickSessionStore.getState().session!.settle({ hex: "#010203", source: "composition" });
    await expect(p).resolves.toEqual({ hex: "#010203", source: "composition" });
    expect(usePickSessionStore.getState().session).toBeNull();
  });
  it("forwards excludeEffectId into captureFrame", async () => {
    const s = goodSampler();
    registerPreviewSampler(s);
    const p = pickColor({ excludeEffectId: "E9" });
    await vi.waitFor(() => expect(usePickSessionStore.getState().session).not.toBeNull());
    expect(s.captureFrame).toHaveBeenCalledWith({ excludeEffectId: "E9" });
    usePickSessionStore.getState().session!.settle(null);
    await expect(p).resolves.toBeNull();
  });
  it("a new call preempts the old session with null", async () => {
    registerPreviewSampler(goodSampler());
    const first = pickColor();
    await vi.waitFor(() => expect(usePickSessionStore.getState().session).not.toBeNull());
    const second = pickColor();
    await expect(first).resolves.toBeNull();
    await vi.waitFor(() => expect(usePickSessionStore.getState().session).not.toBeNull());
    usePickSessionStore.getState().session!.settle(null);
    await expect(second).resolves.toBeNull();
  });
  it("resolves null with no session when BOTH buffers fail", async () => {
    // No sampler registered; snapshot rejects.
    captureWindowSnapshot.mockRejectedValueOnce(new Error("nope"));
    await expect(pickColor()).resolves.toBeNull();
    expect(usePickSessionStore.getState().session).toBeNull();
    expect(logEmit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/colorpick/pickColor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/renderer/colorpick/pickColor.ts
// The global pick-session state machine (singleton — a new call preempts the
// old). Freezes BOTH sample buffers up front: every hover afterwards is a CPU
// read, and live-apply re-renders can never pollute the sample source (the
// chromakey feedback-loop fix). The overlay (PickOverlayHost) renders whenever
// the store holds a session and calls settle() to finish it.
// Spec: docs/superpowers/specs/2026-07-11-color-picker-design.md

import { create } from "zustand";
import { logEmit } from "../ipc";
import { transportPause } from "../state/playbackStore";
import type { FrameBuffer } from "./pixel";
import { getPreviewSampler } from "./previewSamplerRegistry";
import { captureWindowSnapshot, type WindowSnapshot } from "./snapshot";

export interface PickOptions {
  /// Chromakey: freeze the composition WITHOUT this effect's filter, so
  /// samples are the pixels its shader actually compares against.
  excludeEffectId?: string;
  /// rAF-throttled by the overlay; in-app sessions only (screen mode has none).
  onHover?: (hex: string) => void;
}

export interface PickResult {
  hex: string;
  source: "composition" | "ui" | "screen";
}

export interface PickSession {
  opts: PickOptions;
  /// Frozen composition buffer; null ⇒ canvas-region sampling unavailable.
  comp: FrameBuffer | null;
  /// Frozen window snapshot; null ⇒ non-canvas sampling unavailable.
  snap: WindowSnapshot | null;
  /// Idempotent; clears the store session and resolves the pickColor promise.
  settle(result: PickResult | null): void;
}

interface PickState {
  session: PickSession | null;
}

export const usePickSessionStore = create<PickState>(() => ({ session: null }));

function warn(message: string): void {
  void logEmit({
    level: "warn",
    category: { kind: "System" },
    source: { kind: "User" },
    message: `colorpick: ${message}`,
  });
}

export async function pickColor(opts: PickOptions = {}): Promise<PickResult | null> {
  usePickSessionStore.getState().session?.settle(null);
  transportPause();

  const sampler = getPreviewSampler();
  const [comp, snap] = await Promise.all([
    sampler
      ? sampler
          .captureFrame(opts.excludeEffectId ? { excludeEffectId: opts.excludeEffectId } : {})
          .catch((e: unknown) => {
            warn(`composition freeze failed: ${String(e)}`);
            return null;
          })
      : Promise.resolve(null),
    captureWindowSnapshot().catch((e: unknown) => {
      warn(`window snapshot failed: ${String(e)}`);
      return null;
    }),
  ]);

  if (!comp && !snap) {
    void logEmit({
      level: "error",
      category: { kind: "System" },
      source: { kind: "User" },
      message: "colorpick: no sample source (preview and window snapshot both failed)",
    });
    return null;
  }

  return new Promise<PickResult | null>((resolve) => {
    let settled = false;
    const session: PickSession = {
      opts,
      comp,
      snap,
      settle(result) {
        if (settled) return;
        settled = true;
        if (usePickSessionStore.getState().session === session) {
          usePickSessionStore.setState({ session: null });
        }
        resolve(result);
      },
    };
    usePickSessionStore.setState({ session });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/colorpick/pickColor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/colorpick/pickColor.ts src/renderer/colorpick/pickColor.test.ts
git commit -m "feat(colorpick): singleton pick-session state machine with frozen dual buffers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Overlay UI (`PickOverlayHost`) + App mount + i18n

**Files:**
- Create: `apps/desktop/src/renderer/colorpick/PickOverlayHost.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx` (render `<PickOverlayHost />` after `<AppNotices />`, ~line 650)
- Modify: `apps/desktop/src/renderer/i18n/locales/en-US.ts` (new top-level `colorpick` key, next to `effects`)
- Modify: `apps/desktop/src/renderer/i18n/locales/zh-CN.ts` (same position)
- Test: `apps/desktop/src/renderer/colorpick/PickOverlayHost.test.tsx`

**Interfaces:**
- Consumes: `usePickSessionStore` / `PickSession` (Task 6), `getPreviewSampler` (Task 3), `sampleHex` / `samplePatch` / `FrameBuffer` (Task 1), `eyeDropperAvailable` / `screenPick` (Task 5).
- Produces: `PickOverlayHost(): JSX.Element | null` (mounted once in App). Overlay root carries `data-testid="colorpick-overlay"` (Task 10 depends on it).

- [ ] **Step 1: i18n keys**

In `en-US.ts`, add a top-level key directly above `effects:`:

```ts
  colorpick: {
    pick: "Pick color",
    hint_cancel: "Esc — cancel",
    hint_screen: "S — pick from screen",
  },
```

In `zh-CN.ts`, same position:

```ts
  colorpick: {
    pick: "取色",
    hint_cancel: "Esc — 取消",
    hint_screen: "S — 从屏幕取色",
  },
```

- [ ] **Step 2: Write the failing component test**

```tsx
// apps/desktop/src/renderer/colorpick/PickOverlayHost.test.tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// pickColor (imported for its store) transitively imports ../ipc — stub the
// one symbol it uses so jsdom never loads the real bridge.
vi.mock("../ipc", () => ({ logEmit: vi.fn(async () => {}) }));
const { screenPick, eyeDropperAvailable } = vi.hoisted(() => ({
  screenPick: vi.fn(async () => "#123456"),
  eyeDropperAvailable: vi.fn(() => true),
}));
vi.mock("./screenPick", () => ({ screenPick, eyeDropperAvailable }));

import { PickOverlayHost } from "./PickOverlayHost";
import { usePickSessionStore, type PickSession } from "./pickColor";
import {
  clearPreviewSampler,
  getPreviewSampler,
  registerPreviewSampler,
  type PreviewSampler,
} from "./previewSamplerRegistry";

// rAF → run-now so hover sampling is synchronous under test.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  usePickSessionStore.setState({ session: null });
  const s = getPreviewSampler();
  if (s) clearPreviewSampler(s);
  vi.clearAllMocks();
});

// Canvas occupies client [100,100)–[200,200); composition is 10×10 all-green.
const green = new Uint8Array(10 * 10 * 4);
for (let i = 0; i < green.length; i += 4) { green[i + 1] = 255; green[i + 3] = 255; }
const sampler: PreviewSampler = {
  captureFrame: async () => ({ pixels: green, width: 10, height: 10 }),
  mapClientToComposition: (x, y) =>
    x >= 100 && x < 200 && y >= 100 && y < 200
      ? { x: Math.floor((x - 100) / 10), y: Math.floor((y - 100) / 10) }
      : null,
  canvasRect: () =>
    ({ left: 100, top: 100, right: 200, bottom: 200, width: 100, height: 100 } as DOMRect),
};

// Snapshot: 1×1 red; scale 1 (any outside-canvas point samples it, clamped).
const snap = {
  data: { data: new Uint8ClampedArray([255, 0, 0, 255]), width: 1, height: 1 } as unknown as ImageData,
  scaleX: 1,
  scaleY: 1,
};

function seedSession(overrides: Partial<PickSession> = {}): { settle: ReturnType<typeof vi.fn>; onHover: ReturnType<typeof vi.fn> } {
  const settle = vi.fn();
  const onHover = vi.fn();
  usePickSessionStore.setState({
    session: {
      opts: { onHover },
      comp: { pixels: green, width: 10, height: 10 },
      snap,
      settle,
      ...overrides,
    },
  });
  return { settle, onHover };
}

describe("PickOverlayHost", () => {
  it("renders nothing without a session", () => {
    render(<PickOverlayHost />);
    expect(screen.queryByTestId("colorpick-overlay")).toBeNull();
  });

  it("click inside the canvas commits the composition sample", () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.click(screen.getByTestId("colorpick-overlay"), { clientX: 150, clientY: 150 });
    expect(settle).toHaveBeenCalledWith({ hex: "#00ff00", source: "composition" });
  });

  it("click outside the canvas commits the snapshot sample", () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.click(screen.getByTestId("colorpick-overlay"), { clientX: 10, clientY: 10 });
    expect(settle).toHaveBeenCalledWith({ hex: "#ff0000", source: "ui" });
  });

  it("hover fires onHover with the sampled hex", () => {
    registerPreviewSampler(sampler);
    const { onHover } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.pointerMove(screen.getByTestId("colorpick-overlay"), { clientX: 150, clientY: 150 });
    expect(onHover).toHaveBeenCalledWith("#00ff00");
  });

  it("Escape settles null", () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(settle).toHaveBeenCalledWith(null);
  });

  it("S hands off to the native dropper and settles its result", async () => {
    registerPreviewSampler(sampler);
    const { settle } = seedSession();
    render(<PickOverlayHost />);
    fireEvent.keyDown(window, { key: "s" });
    // Overlay torn down first, then the native result settles the session.
    expect(usePickSessionStore.getState().session).toBeNull();
    await vi.waitFor(() =>
      expect(settle).toHaveBeenCalledWith({ hex: "#123456", source: "screen" }),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/renderer/colorpick/PickOverlayHost.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 4: Write the overlay**

```tsx
// apps/desktop/src/renderer/colorpick/PickOverlayHost.tsx
// Full-window pick overlay + magnifier. ALL hover-rate work is imperative DOM
// through refs — pointer-move-rate React state is banned (playhead-gate
// discipline); the only React state is the store's session presence.
// Spec: docs/superpowers/specs/2026-07-11-color-picker-design.md

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { sampleHex, samplePatch, type FrameBuffer } from "./pixel";
import { getPreviewSampler } from "./previewSamplerRegistry";
import { usePickSessionStore, type PickSession } from "./pickColor";
import { eyeDropperAvailable, screenPick } from "./screenPick";

const MAG_RADIUS = 5; // 11×11 source patch
const MAG_SCALE = 10; // → 110×110 magnifier canvas

export function PickOverlayHost() {
  const session = usePickSessionStore((s) => s.session);
  if (!session) return null;
  return <PickOverlay session={session} />;
}

interface Hit {
  hex: string;
  source: "composition" | "ui";
  patchBuf: FrameBuffer;
  px: number;
  py: number;
}

function PickOverlay({ session }: { session: PickSession }) {
  const { t } = useTranslation();
  const magRef = useRef<HTMLDivElement | null>(null);
  const magCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hexRef = useRef<HTMLSpanElement | null>(null);
  const raf = useRef<number | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  const sampleAt = (x: number, y: number): Hit | null => {
    const sampler = getPreviewSampler();
    if (session.comp && sampler) {
      const rect = sampler.canvasRect();
      if (rect && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
        const m = sampler.mapClientToComposition(x, y);
        if (m) {
          return {
            hex: sampleHex(session.comp, m.x, m.y),
            source: "composition",
            patchBuf: session.comp,
            px: m.x,
            py: m.y,
          };
        }
        // Letterbox bars inside the canvas element are painted chrome, not
        // composition content — fall through to the window snapshot.
      }
    }
    if (session.snap) {
      const buf: FrameBuffer = {
        pixels: session.snap.data.data,
        width: session.snap.data.width,
        height: session.snap.data.height,
      };
      const sx = Math.floor(x * session.snap.scaleX);
      const sy = Math.floor(y * session.snap.scaleY);
      return { hex: sampleHex(buf, sx, sy), source: "ui", patchBuf: buf, px: sx, py: sy };
    }
    return null;
  };

  const update = () => {
    raf.current = null;
    const p = last.current;
    if (!p) return;
    const hit = sampleAt(p.x, p.y);
    const mag = magRef.current;
    if (mag) {
      mag.style.transform = `translate(${p.x + 16}px, ${p.y + 16}px)`;
      mag.style.visibility = hit ? "visible" : "hidden";
    }
    if (!hit) return;
    if (hexRef.current) hexRef.current.textContent = hit.hex;
    const canvas = magCanvasRef.current;
    const ctx = canvas?.getContext("2d"); // jsdom: null — magnifier draw is best-effort
    if (canvas && ctx) {
      const patch = samplePatch(hit.patchBuf, hit.px, hit.py, MAG_RADIUS);
      const img = new ImageData(new Uint8ClampedArray(patch.pixels), patch.width, patch.height);
      // putImageData can't scale: stage 1:1, then blit with smoothing off.
      const stage = document.createElement("canvas");
      stage.width = patch.width;
      stage.height = patch.height;
      const sctx = stage.getContext("2d");
      if (sctx) {
        sctx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(stage, 0, 0, canvas.width, canvas.height);
      }
    }
    session.opts.onHover?.(hit.hex);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    last.current = { x: e.clientX, y: e.clientY };
    if (raf.current === null) raf.current = requestAnimationFrame(update);
  };

  const onClick = (e: React.MouseEvent) => {
    const hit = sampleAt(e.clientX, e.clientY);
    if (hit) session.settle({ hex: hit.hex, source: hit.source });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        session.settle(null);
      } else if ((e.key === "s" || e.key === "S") && eyeDropperAvailable()) {
        e.preventDefault();
        // Native handoff: drop the overlay FIRST (the session object keeps the
        // promise open), then settle from the native result. keydown carries
        // the transient activation EyeDropper.open() requires.
        usePickSessionStore.setState({ session: null });
        void screenPick().then((hex) =>
          session.settle(hex ? { hex, source: "screen" } : null),
        );
      }
    };
    const onBlur = () => session.settle(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [session]);

  return (
    <div
      data-testid="colorpick-overlay"
      onPointerMove={onPointerMove}
      onClick={onClick}
      style={{ position: "fixed", inset: 0, zIndex: 1000, cursor: "crosshair" }}
    >
      <div
        ref={magRef}
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          visibility: "hidden",
          pointerEvents: "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
        }}
      >
        <canvas
          ref={magCanvasRef}
          width={(MAG_RADIUS * 2 + 1) * MAG_SCALE}
          height={(MAG_RADIUS * 2 + 1) * MAG_SCALE}
          style={{ border: "2px solid var(--border)", borderRadius: 6, background: "#000" }}
        />
        <span
          ref={hexRef}
          style={{
            font: "12px ui-monospace, monospace",
            color: "#e5e7eb",
            background: "rgba(0,0,0,0.7)",
            padding: "1px 6px",
            borderRadius: 3,
          }}
        />
      </div>
      <div
        style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          font: "12px system-ui",
          color: "#e5e7eb",
          background: "rgba(0,0,0,0.7)",
          padding: "4px 10px",
          borderRadius: 4,
          pointerEvents: "none",
        }}
      >
        {t("colorpick.hint_cancel")}
        {eyeDropperAvailable() ? ` · ${t("colorpick.hint_screen")}` : ""}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Mount in App**

In `apps/desktop/src/renderer/App.tsx`:
- Add import: `import { PickOverlayHost } from "./colorpick/PickOverlayHost";`
- Render `<PickOverlayHost />` on the line directly after `<AppNotices />`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/renderer/colorpick/PickOverlayHost.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/colorpick/PickOverlayHost.tsx src/renderer/colorpick/PickOverlayHost.test.tsx src/renderer/App.tsx src/renderer/i18n/locales/en-US.ts src/renderer/i18n/locales/zh-CN.ts
git commit -m "feat(colorpick): pick overlay with magnifier, Esc/S keys, App mount, locales

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `AppColorField` eyedropper button

**Files:**
- Modify: `apps/desktop/src/renderer/components/AppColorField.tsx`
- Modify: `apps/desktop/src/renderer/components/AppColorField.test.tsx`
- Modify: `apps/desktop/src/renderer/styles/controls.css` (after `.app-color-swatch:disabled`, ~line 291)

**Interfaces:**
- Consumes: `pickColor` (Task 6).
- Produces: `AppColorFieldProps` gains `withEyeDropper?: boolean` (default `true`). Existing consumers (PropertyPanel, CaptionsPanel, MotifPicker) change behavior only by gaining the button.

- [ ] **Step 1: Extend the tests (write failing first)**

Replace `apps/desktop/src/renderer/components/AppColorField.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { pickColor } = vi.hoisted(() => ({
  pickColor: vi.fn(async () => ({ hex: "#00ff00", source: "composition" as const })),
}));
vi.mock("../colorpick/pickColor", () => ({ pickColor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { AppColorField } from "./AppColorField";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AppColorField", () => {
  it("emits the picked hex via onValueChange (no internal debounce)", () => {
    const onValueChange = vi.fn();
    render(<AppColorField value="#000000" onValueChange={onValueChange} ariaLabel="c" />);
    fireEvent.input(screen.getByLabelText("c"), { target: { value: "#ff0000" } });
    expect(onValueChange).toHaveBeenCalledWith("#ff0000");
  });

  it("applies the swatch skin and is disableable", () => {
    render(<AppColorField value="#fff" onValueChange={() => {}} disabled ariaLabel="c" />);
    const el = screen.getByLabelText("c") as HTMLInputElement;
    expect(el.className).toContain("app-color-swatch");
    expect(el.disabled).toBe(true);
  });

  it("eyedropper button commits a pick through onValueChange", async () => {
    const onValueChange = vi.fn();
    render(<AppColorField value="#000000" onValueChange={onValueChange} ariaLabel="c" />);
    fireEvent.click(screen.getByLabelText("colorpick.pick"));
    expect(pickColor).toHaveBeenCalled();
    await vi.waitFor(() => expect(onValueChange).toHaveBeenCalledWith("#00ff00"));
  });

  it("cancelled pick (null) commits nothing", async () => {
    pickColor.mockResolvedValueOnce(null as never);
    const onValueChange = vi.fn();
    render(<AppColorField value="#000000" onValueChange={onValueChange} ariaLabel="c" />);
    fireEvent.click(screen.getByLabelText("colorpick.pick"));
    await Promise.resolve();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("withEyeDropper=false renders the bare input", () => {
    render(
      <AppColorField value="#000000" onValueChange={() => {}} ariaLabel="c" withEyeDropper={false} />,
    );
    expect(screen.queryByLabelText("colorpick.pick")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify the new cases fail**

Run: `npx vitest run src/renderer/components/AppColorField.test.tsx`
Expected: FAIL — no element labelled `colorpick.pick`

- [ ] **Step 3: Implement the button**

Replace `apps/desktop/src/renderer/components/AppColorField.tsx` with:

```tsx
import { Pipette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { pickColor } from "../colorpick/pickColor";

export interface AppColorFieldProps {
  /// Hex string, e.g. "#aabbcc". The native picker edits the RGB triplet only.
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  /// Global eyedropper button next to the swatch (default on). Opt out only
  /// where the extra 24px genuinely cannot fit.
  withEyeDropper?: boolean;
}

/// The one color swatch for every WeftCut form. A skinned native
/// `<input type="color">` — keeps the OS picker (no custom popover). Does NOT
/// debounce: callers whose commit triggers an expensive re-render (e.g. PropertyPanel
/// CDP re-capture) must keep their own debounce. The eyedropper commits through
/// the same onValueChange, so caller debounce policy applies to picks too.
export function AppColorField({
  value,
  onValueChange,
  disabled,
  ariaLabel,
  className,
  withEyeDropper = true,
}: AppColorFieldProps) {
  const { t } = useTranslation();
  const input = (
    <input
      type="color"
      className={cn("app-color-swatch", className)}
      value={value}
      disabled={disabled ?? false}
      aria-label={ariaLabel}
      onChange={(e) => onValueChange(e.target.value)}
    />
  );
  if (!withEyeDropper) return input;
  return (
    <span className="app-color-field">
      {input}
      <button
        type="button"
        className="app-color-pick"
        disabled={disabled ?? false}
        aria-label={t("colorpick.pick")}
        onClick={() => {
          void pickColor().then((r) => {
            if (r) onValueChange(r.hex);
          });
        }}
      >
        <Pipette size={12} />
      </button>
    </span>
  );
}
```

- [ ] **Step 4: CSS**

In `apps/desktop/src/renderer/styles/controls.css`, after the `.app-color-swatch:disabled` rule, add:

```css
/* Swatch + eyedropper pairing (AppColorField withEyeDropper). */
.app-color-field {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.app-color-pick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--muted-foreground);
  cursor: pointer;
}
.app-color-pick:hover {
  color: var(--foreground);
}
.app-color-pick:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 5: Run tests + consumer suites**

Run: `npx vitest run src/renderer/components/AppColorField.test.tsx src/renderer/panels/CaptionsPanel.test.tsx && npm run typecheck`
Expected: PASS. If a consumer test breaks on the new wrapper span, fix that TEST's selector (the input keeps its aria-label) — not the component.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/AppColorField.tsx src/renderer/components/AppColorField.test.tsx src/renderer/styles/controls.css
git commit -m "feat(colorpick): eyedropper button on AppColorField (default on)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Chromakey eyedropper (registry `colorGroups` + EffectsSection)

**Files:**
- Modify: `apps/desktop/src/renderer/render/effects/effectRegistry.ts`
- Modify: `apps/desktop/src/renderer/render/effects/effectRegistry.test.ts`
- Modify: `apps/desktop/src/renderer/properties/EffectsSection.tsx`
- Modify: `apps/desktop/src/renderer/properties/EffectsSection.test.tsx`

**Interfaces:**
- Consumes: `pickColor` (Task 6), `hexToRgb01` (Task 1), `setTransientOverrides`/`clearTransientOverrides` (Task 2), `autoKeyTrack` (`../keyframe/autoKey`, existing), `updateLayerParamTracks` (`../ipc`, existing), `getDescriptor` (existing).
- Produces: `EffectDescriptor.colorGroups?: Array<{ params: [string, string, string] }>`; chromakey declares `[{ params: ["keyR", "keyG", "keyB"] }]`; the button carries `data-testid="effect-colorpick-<rowIndex>"` (Task 10 depends on it).

- [ ] **Step 1: Registry — failing test first**

Append to `effectRegistry.test.ts` inside the `describe("chromakey", ...)` block:

```ts
  it("declares the key color as an eyedropper color group", () => {
    const d = getDescriptor("chromakey")!;
    expect(d.colorGroups).toEqual([{ params: ["keyR", "keyG", "keyB"] }]);
  });
```

Run: `npx vitest run src/renderer/render/effects/effectRegistry.test.ts` — expected FAIL.

- [ ] **Step 2: Registry — implement**

In `effectRegistry.ts`, add to `EffectDescriptor` (after `params`):

```ts
  /// RGB triplets of 0–1 scalar params that get an inspector eyedropper
  /// (docs/superpowers/specs/2026-07-11-color-picker-design.md). Names must
  /// exist in `params`.
  colorGroups?: Array<{ params: [string, string, string] }>;
```

In the `chromakey` entry, after `params: (...)()`, add:

```ts
    colorGroups: [{ params: ["keyR", "keyG", "keyB"] }],
```

Run: `npx vitest run src/renderer/render/effects/effectRegistry.test.ts` — expected PASS.

- [ ] **Step 3: EffectsSection — extend the mock, then failing test**

In `EffectsSection.test.tsx`:

1. The existing registry mock replaces the WHOLE module; the new code imports `getDescriptor` from it, so the mock MUST now provide it or every existing test crashes. Extend the hoisted block and mock:

```ts
const { addEffect, updateEffect, moveEffect, removeEffect, getDescriptor } = vi.hoisted(() => ({
  addEffect: vi.fn(async () => "new-id"),
  updateEffect: vi.fn(async () => {}),
  moveEffect: vi.fn(async () => {}),
  removeEffect: vi.fn(async () => {}),
  getDescriptor: vi.fn((): unknown => null),
}));
vi.mock("../ipc", () => ({ addEffect, updateEffect, moveEffect, removeEffect, updateLayerParamTracks }));
vi.mock("../render/effects/effectRegistry", () => ({
  listEffects: () => [{ kind: "blur", nameI18nKey: "effects.blur.name" }],
  getDescriptor,
}));
```

2. Add the new hoisted mocks next to the existing ones:

```ts
const { updateLayerParamTracks } = vi.hoisted(() => ({
  updateLayerParamTracks: vi.fn(async () => {}),
}));
const { pickColor } = vi.hoisted(() => ({
  pickColor: vi.fn(async () => ({ hex: "#0000ff", source: "composition" as const })),
}));
vi.mock("../colorpick/pickColor", () => ({ pickColor }));
const { setTransientOverrides, clearTransientOverrides } = vi.hoisted(() => ({
  setTransientOverrides: vi.fn(),
  clearTransientOverrides: vi.fn(),
}));
vi.mock("../render/effects/effectOverrides", () => ({ setTransientOverrides, clearTransientOverrides }));
```

3. Append a new describe block:

```tsx
describe("effect color pick", () => {
  const chroma = (id: string): EffectView => ({
    id,
    kind: "chromakey",
    enabled: true,
    params: {},
  });
  const chromaDescriptor = {
    kind: "chromakey",
    colorGroups: [{ params: ["keyR", "keyG", "keyB"] }],
    params: {
      keyR: { default: 0 },
      keyG: { default: 1 },
      keyB: { default: 0 },
    },
  };

  it("commits a pick as ONE batched three-track write", async () => {
    getDescriptor.mockReturnValue(chromaDescriptor);
    render(<EffectsSection layer={layerWith([chroma("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-colorpick-0"));
    expect(pickColor).toHaveBeenCalledWith(
      expect.objectContaining({ excludeEffectId: "E1" }),
    );
    expect(clearTransientOverrides).toHaveBeenCalledWith("E1");
    expect(updateLayerParamTracks).toHaveBeenCalledTimes(1);
    const [layerId, entries] = updateLayerParamTracks.mock.calls[0]!;
    expect(layerId).toBe("L1");
    expect(entries).toEqual([
      ["effects[E1].params[keyR]", { mode: "Static", value: 0 }],
      ["effects[E1].params[keyG]", { mode: "Static", value: 0 }],
      ["effects[E1].params[keyB]", { mode: "Static", value: 1 }],
    ]);
  });

  it("hover routes through transient overrides", async () => {
    getDescriptor.mockReturnValue(chromaDescriptor);
    pickColor.mockImplementationOnce(async (opts?: { onHover?: (hex: string) => void }) => {
      opts?.onHover?.("#ff0000");
      return null; // then cancel
    });
    render(<EffectsSection layer={layerWith([chroma("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-colorpick-0"));
    expect(setTransientOverrides).toHaveBeenCalledWith("E1", { keyR: 1, keyG: 0, keyB: 0 });
    expect(clearTransientOverrides).toHaveBeenCalledWith("E1");
    expect(updateLayerParamTracks).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run src/renderer/properties/EffectsSection.test.tsx` — expected FAIL (`effect-colorpick-0` missing).

- [ ] **Step 4: EffectsSection — implement**

In `EffectsSection.tsx`:

Add imports:

```tsx
import { Pipette } from "lucide-react";
import { updateLayerParamTracks, type AnimTrack } from "../ipc";
import { getDescriptor } from "../render/effects/effectRegistry";
import { autoKeyTrack } from "../keyframe/autoKey";
import { hexToRgb01 } from "../colorpick/pixel";
import { pickColor } from "../colorpick/pickColor";
import {
  clearTransientOverrides,
  setTransientOverrides,
} from "../render/effects/effectOverrides";
```

(Merge with the existing `../ipc` import line rather than duplicating it.)

Inside `EffectRow`, in the `prop-effect-head` div AFTER the effect name span, add:

```tsx
        {getDescriptor(effect.kind)?.colorGroups?.map((group, gi) => (
          <button
            key={`cg-${gi}`}
            type="button"
            className="app-color-pick"
            data-testid={`effect-colorpick-${index}`}
            aria-label={t("colorpick.pick")}
            onClick={() => void pickColorGroup(group.params)}
          >
            <Pipette size={12} />
          </button>
        ))}
```

Add the handler inside `EffectRow` (above `return`):

```tsx
  // Chromakey (and any future color-triplet effect): one eyedropper writes the
  // three scalars as ONE undo entry via the batch API. Hover live-applies
  // through transient overrides (never recorded); pickColor resolving — commit
  // OR cancel — is followed by clearing them, so Esc restores the pre-pick
  // matte. Keyframe semantics per param = autoKeyTrack, identical to a manual
  // number edit.
  const pickColorGroup = async (params: [string, string, string]) => {
    setErr(null);
    const result = await pickColor({
      excludeEffectId: effect.id,
      onHover: (hex) => {
        const [r, g, b] = hexToRgb01(hex);
        setTransientOverrides(effect.id, {
          [params[0]]: r,
          [params[1]]: g,
          [params[2]]: b,
        });
      },
    });
    clearTransientOverrides(effect.id);
    if (!result) return;
    const rgb = hexToRgb01(result.hex);
    const spec = getDescriptor(effect.kind)?.params ?? {};
    const entries: [string, AnimTrack<number>][] = params.map((p, i) => [
      `effects[${effect.id}].params[${p}]`,
      autoKeyTrack(
        effect.params[p] ?? { mode: "Static", value: spec[p]?.default ?? 0 },
        tInLayerUs,
        rgb[i]!,
      ),
    ]);
    try {
      await updateLayerParamTracks(layer.id, entries);
      await onMutated();
    } catch (e) {
      setErr(String(e));
    }
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/properties/EffectsSection.test.tsx src/renderer/render/effects/effectRegistry.test.ts && npm run typecheck`
Expected: PASS (including all pre-existing EffectsSection cases against the extended mock)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/render/effects/effectRegistry.ts src/renderer/render/effects/effectRegistry.test.ts src/renderer/properties/EffectsSection.tsx src/renderer/properties/EffectsSection.test.tsx
git commit -m "feat(colorpick): chromakey eyedropper via declarative colorGroups + batched commit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: e2e — chromakey eyedropper closed loop

**Files:**
- Create: `apps/desktop/e2e/electron/colorpick.spec.ts`

**Interfaces:**
- Consumes: `launchApp, newProject, invokeCmd, summary` from `./helpers/driver` (existing; open that file first and match its exact signatures if they differ from the usage below), testids `effect-colorpick-0` (Task 9) and `colorpick-overlay` (Task 7), e2e hook `revealLayer` (existing).

- [ ] **Step 1: Write the spec**

```ts
// apps/desktop/e2e/electron/colorpick.spec.ts
// Chromakey eyedropper closed loop: pick a BLUE canvas → keyR/G/B land as one
// batched write → ONE undo reverts all three. Blue (not green) because the
// chroma defaults ARE green — a green pick would assert nothing.
import { test, expect } from '@playwright/test'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { launchApp, newProject, invokeCmd, summary, waitForHook } from './helpers/driver'

interface ParamTrack { mode: string; value?: number }
interface LayerLite { id: string; effects?: Array<{ id: string; params: Record<string, ParamTrack> }> }

function chromaParams(s: { tracks: Array<{ layers: LayerLite[] }> }, layerId: string): Record<string, ParamTrack> {
  for (const t of s.tracks) {
    for (const l of t.layers) {
      if (l.id === layerId) return l.effects?.[0]?.params ?? {}
    }
  }
  throw new Error(`layer ${layerId} not in summary`)
}

test('colorpick: chromakey eyedropper picks canvas blue; one undo reverts', async () => {
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'needs a real-GL extract.pixels readback; verified locally',
  )
  test.setTimeout(120_000)
  const { app, page } = await launchApp()

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-colorpick-'))
  await newProject(page, {
    parentFolder: parent,
    name: 'colorpick',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  const layerId = await invokeCmd<string>(page, 'add_color_layer', {
    tStartUs: 0,
    durationUs: 2_000_000,
    color: { r: 0, g: 0, b: 255, a: 255 },
  })
  await invokeCmd<string>(page, 'add_effect', { layerId, kind: 'chromakey' })

  // Select the layer so PropertyPanel mounts the effects section.
  await waitForHook(page, 'revealLayer')
  await page.evaluate(
    (id) => (window as unknown as { __weftcutTest: { revealLayer(a: { layerId: string }): void } }).__weftcutTest.revealLayer({ layerId: id }),
    layerId,
  )
  const pickBtn = page.getByTestId('effect-colorpick-0')
  await pickBtn.waitFor({ state: 'visible', timeout: 15_000 })
  await pickBtn.click()

  const overlay = page.getByTestId('colorpick-overlay')
  await overlay.waitFor({ state: 'visible', timeout: 15_000 })

  const box = await page.locator('canvas').first().boundingBox()
  if (!box) throw new Error('preview canvas not found')

  // Hover across the canvas first: live-apply must stay TRANSIENT — the
  // project's chromakey params record nothing until the click commits.
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(300)
  const during = chromaParams(await summary(page), layerId)
  expect(during.keyB?.value).toBeUndefined()

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await overlay.waitFor({ state: 'hidden', timeout: 10_000 })

  const near = (v: number | undefined, want: number) => {
    expect(v).toBeDefined()
    expect(Math.abs((v as number) - want)).toBeLessThan(0.02)
  }
  // The batched write lands async after the overlay settles; poll the summary.
  await expect
    .poll(async () => chromaParams(await summary(page), layerId).keyB?.value, { timeout: 10_000 })
    .toBeDefined()
  let p = chromaParams(await summary(page), layerId)
  near(p.keyR?.value, 0)
  near(p.keyG?.value, 0)
  near(p.keyB?.value, 1)

  // ONE undo reverts all three (single batched entry). Lazily-created tracks
  // disappear (undefined) OR revert to the green defaults — accept either.
  await invokeCmd(page, 'project_undo', {})
  p = chromaParams(await summary(page), layerId)
  const g = p.keyG?.value
  const b = p.keyB?.value
  expect(b === undefined || Math.abs(b) < 0.02).toBe(true)
  expect(g === undefined || Math.abs(g - 1) < 0.02).toBe(true)

  await app.close()
})
```

- [ ] **Step 2: Driver signatures (verified at plan time)**

`launchApp() → { app, page }`, `newProject(page, { parentFolder, name, canvas })`, `invokeCmd<T>(page, cmd, args)`, `summary(page)`, `waitForHook(page, name)` all match `e2e/electron/helpers/driver.ts` as of this plan; `add_color_layer` takes `{ trackId?, color?, width?, height?, tStartUs, durationUs? }` with `Rgba` in 0–255. If the driver has drifted, adapt the SPEC to the driver — never the reverse.

- [ ] **Step 3: Run the spec locally**

Run: `npm run e2e:electron -- colorpick`
Expected: PASS on this machine (real GPU). If the e2e build is stale, the driver's `launchApp` handles the `VITE_WEFTCUT_E2E=1` build — follow whatever the other specs' README/driver comments prescribe.

- [ ] **Step 4: Commit**

```bash
git add e2e/electron/colorpick.spec.ts
git commit -m "test(e2e): chromakey eyedropper closed loop — batched write + single undo

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Full gates, manual native-dropper checklist, evergreen doc

**Files:**
- Create: `docs/color-picker.md`

- [ ] **Step 1: Full gates**

Run: `npm run typecheck && npm test`
Expected: PASS across the workspace (not just the new suites).

- [ ] **Step 2: Manual verification checklist (native EyeDropper cannot be automated)**

Launch the dev app (`npm run dev`) and verify by hand:

1. Text-layer color swatch → eyedropper → hover moves the magnifier, hex readout tracks; click inside the preview canvas commits that color.
2. Chromakey on a clip → eyedropper → hovering the preview LIVE-updates the matte; Esc fully restores; click commits; ONE Ctrl+Z reverts all three key params.
3. During a pick session press `S` → the native Chromium dropper appears; pick a color from a NON-WeftCut window; the hex commits. Esc inside the native dropper cancels cleanly.
4. Close the preview panel (if the layout allows) → eyedropper still works for UI-region picks; canvas region degrades silently.
5. Start playback, then open a pick session → playback pauses (NLE convention).

Record any failures as bugs; do not ship with a failing line.

- [ ] **Step 3: Evergreen doc**

```markdown
<!-- docs/color-picker.md -->
# Color Picker (Eyedropper)

One global pick session serves every color surface. `pickColor()`
(`src/renderer/colorpick/pickColor.ts`) freezes two buffers at session start —
the composited preview via `extract.pixels` (working-space-true, composition
resolution) and a `capturePage()` window snapshot — then every hover sample is
a CPU read. The native `EyeDropper` API handles whole-screen picks (`S` during
a session); it returns only a color (no coordinates, no hover), which is why it
cannot carry the in-app session.

## Why the sample source is frozen

Chromakey hover live-applies the key color while you move. Sampling the LIVE
composite would read the keyed result (the background), not the source pixel —
a feedback loop. The session therefore freezes a PRE-key frame
(`excludeEffectId` disables that filter for the freeze) and sampling never
touches the live pipeline.

## Integration seams

- `previewSamplerRegistry` — PixiPreview registers capture/mapping on mount;
  the picker never imports Pixi.
- `effectOverrides` — transient per-effect param overrides + disable flags,
  consulted by `EffectChain.sync()` after track resolution. Never recorded,
  never in React state. PixiPreview re-composites on every change so hover
  edits render while paused.
- `AppColorField` — eyedropper button by default (`withEyeDropper={false}` to
  opt out); commits through the caller's `onValueChange`.
- Effect descriptors declare `colorGroups` (RGB scalar triplets); the inspector
  renders an eyedropper per group and commits all three tracks as one undo
  entry via `updateLayerParamTracks`.

## Limits

- Screen picks have no hover preview or custom magnifier (platform API limit);
  `screenPick.ts` is the seam to replace with a full-screen custom overlay.
- The composition buffer is an 8-bit extract — HDR/10-bit picks read the
  tone-mapped value.
- The window snapshot is frozen at session start; UI changes mid-session are
  not reflected.
```

- [ ] **Step 4: Commit**

```bash
git add docs/color-picker.md
git commit -m "docs: color picker evergreen page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
