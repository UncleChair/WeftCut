# Template Animated Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The template picker's right-column large preview of the selected template plays its animation on a continuous real-time loop; cards stay static.

**Architecture:** Add an `animate` prop to `TemplatePreview`. When true, replace the single static `renderFrameSvg(0, …)` with a `requestAnimationFrame` loop that advances `t` over `[0, duration)` (looping) at ~20 fps via the same `TemplateHarness`, converting each frame's SVG to an object URL bound to the existing `<img>`. A pure helper computes the loop time. Reduced-motion falls back to the static frame.

**Tech Stack:** React (hooks, refs, rAF), TypeScript, `TemplateHarness` (existing), vitest, real-WebView2 verification.

**Branch:** `feat/template-animated-preview` (already created; spec committed there).

**Spec:** `docs/superpowers/specs/2026-06-06-template-animated-preview-design.md`

**Test commands:** from `apps/desktop` → `npm test -- <path>` (vitest), `npm run typecheck` (tsc -b).

---

## Task 1: `previewLoopTimeSec` pure helper

A tiny pure module (no React/DOM imports) so it's unit-testable in the node vitest env. The picker component imports it.

**Files:**
- Create: `apps/desktop/src/templates/previewLoop.ts`
- Test: `apps/desktop/src/templates/previewLoop.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/templates/previewLoop.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { previewLoopTimeSec } from "./previewLoop";

describe("previewLoopTimeSec", () => {
  it("is 0 at the start", () => {
    expect(previewLoopTimeSec(0, 5000)).toBe(0);
  });
  it("maps elapsed ms to seconds within the first cycle", () => {
    expect(previewLoopTimeSec(2500, 5000)).toBeCloseTo(2.5, 6);
    expect(previewLoopTimeSec(4999, 5000)).toBeCloseTo(4.999, 6);
  });
  it("wraps at the duration boundary (loops)", () => {
    expect(previewLoopTimeSec(5000, 5000)).toBe(0); // exactly one cycle → back to 0
    expect(previewLoopTimeSec(6000, 5000)).toBeCloseTo(1.0, 6); // into 2nd cycle
    expect(previewLoopTimeSec(12500, 5000)).toBeCloseTo(2.5, 6); // 3rd cycle
  });
  it("guards against a non-positive duration", () => {
    expect(previewLoopTimeSec(1234, 0)).toBe(0);
    expect(previewLoopTimeSec(1234, -10)).toBe(0);
  });
  it("clamps negative elapsed to 0", () => {
    expect(previewLoopTimeSec(-100, 5000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing)**

Run (from `apps/desktop`): `npm test -- src/templates/previewLoop.test.ts`
Expected: FAIL — cannot resolve `./previewLoop`.

- [ ] **Step 3: Implement the helper**

Create `apps/desktop/src/templates/previewLoop.ts`:

```ts
/// Map wall-clock elapsed milliseconds to a looping template time in SECONDS.
/// The preview plays the template's content in real time and repeats: at
/// `elapsedMs == durationMs` the loop wraps back to 0. Pure + unit-tested; the
/// picker's animation loop calls this each frame. Guards a non-positive
/// `durationMs` (→ 0) and negative `elapsedMs` (→ 0).
export function previewLoopTimeSec(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  const e = Math.max(0, elapsedMs);
  return (e % durationMs) / 1000;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run (from `apps/desktop`): `npm test -- src/templates/previewLoop.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

Run (from `apps/desktop`): `npm run typecheck` → clean.

```bash
git add apps/desktop/src/templates/previewLoop.ts apps/desktop/src/templates/previewLoop.test.ts
git commit -m "feat(templates): previewLoopTimeSec helper for looping picker preview"
```

---

## Task 2: Animate the selected large preview

Add the `animate` prop to `TemplatePreview` and an rAF loop that drives the harness. The card thumbnails (default `animate` falsey) keep the existing single-frame behavior.

**Files:**
- Modify: `apps/desktop/src/templates/TemplatePicker.tsx` (the `TemplatePreview` component, ~lines 324-432; the form call site, line 233)

- [ ] **Step 1: Import the helper + add the `animate` prop to the signature**

In `apps/desktop/src/templates/TemplatePicker.tsx`, add to the imports near the top (with the other local imports):

```ts
import { previewLoopTimeSec } from "./previewLoop";
```

Add `animate` to the `TemplatePreview` props (the destructure at ~line 324 and its type at ~line 329):

```ts
function TemplatePreview({
  template,
  props,
  width,
  large,
  animate,
}: {
  template: TemplateSummary;
  props: Record<string, unknown>;
  width: number;
  large?: boolean;
  animate?: boolean;
}) {
```

- [ ] **Step 2: Add the preview frame rate constant**

Just below the existing `const PREVIEW_T_SEC = 0;` (~line 312), add:

```ts
/// Frame rate for the looping picker preview (the selected template's large
/// preview). ~20 fps is smooth enough for the arc sweep while keeping the live
/// re-render loop cheap (one preview animates at a time).
const PREVIEW_FPS = 20;
```

- [ ] **Step 3: Replace the static render effect with a branch (static OR loop)**

Replace the ENTIRE existing render effect (currently ~lines 372-397, the `useEffect` that begins `let cancelled = false;` ... ends `}, [template.id, template.default_duration_s, props]);`) with the following. Leave the harness-load effect (~349-367) and the unmount-revoke effect (~400-406) UNCHANGED.

```ts
  // Bind one frame's SVG (string) to the <img> as an object URL, revoking the
  // previous URL. Shared by the static and animated paths.
  const bindSvg = (svg: string) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setSvgUrl(url);
    setError(null);
  };

  // Render the current frame. When `animate` is true (the selected large
  // preview) and the user hasn't asked for reduced motion, run a real-time
  // loop: advance t over [0, duration) at ~PREVIEW_FPS via rAF, re-rendering
  // each frame through the same harness. Otherwise render a single static frame
  // at t=0 (cards, reduced-motion). Awaits the in-flight load so the first
  // render after a template switch doesn't race the iframe mount.
  useEffect(() => {
    const harness = harnessRef.current;
    const loaded = loadedRef.current;
    if (!harness || !loaded) return;
    const durSec = template.default_duration_s;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Static path: one frame at t=0 (existing behavior).
    if (!animate || prefersReducedMotion) {
      let cancelled = false;
      loaded
        .then(() => harness.renderFrameSvg(PREVIEW_T_SEC, durSec, props))
        .then((svg) => {
          if (!cancelled) bindSvg(svg);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
      return () => {
        cancelled = true;
      };
    }

    // Animated path: real-time loop.
    let cancelled = false;
    let rafId = 0;
    let rendering = false;
    let lastRenderMs = Number.NEGATIVE_INFINITY;
    const startMs = performance.now();
    const durMs = Math.max(1, durSec * 1000);
    const frameInterval = 1000 / PREVIEW_FPS;

    const tick = (now: number) => {
      if (cancelled) return;
      if (!rendering && now - lastRenderMs >= frameInterval) {
        lastRenderMs = now;
        rendering = true;
        const tSec = previewLoopTimeSec(now - startMs, durMs);
        loaded
          .then(() => harness.renderFrameSvg(tSec, durSec, props))
          .then((svg) => {
            rendering = false;
            if (!cancelled) bindSvg(svg);
          })
          .catch((e) => {
            rendering = false;
            if (!cancelled) setError(String(e));
          });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
    // `props` identity changes on each edit; the parent debounces it. Including
    // it here restarts the loop (from t=0) with the new props on each debounced
    // edit — acceptable and keeps the preview truthful to the current props.
  }, [template.id, template.default_duration_s, props, animate]);
```

NOTE: confirm `urlRef`, `setSvgUrl`, `setError`, `harnessRef`, `loadedRef` are the existing refs/state in the component (they are — used by the code you're replacing). `bindSvg` is a new local function defined inside the component body, BEFORE this effect. If the existing render effect already defines a `cancelled` or similar, you're replacing it wholesale so there's no clash.

- [ ] **Step 4: Pass `animate` at the form (large) call site**

At line ~233, change:

```tsx
      <TemplatePreview template={template} props={debouncedProps} width={480} large />
```
to:
```tsx
      <TemplatePreview template={template} props={debouncedProps} width={480} large animate />
```

Leave `TemplateCardThumbnail` (~line 439) unchanged — it passes no `animate`, so cards stay static.

- [ ] **Step 5: Typecheck**

Run (from `apps/desktop`): `npm run typecheck`
Expected: clean (no new errors).

- [ ] **Step 6: Run the full TS suite (no regressions)**

Run (from `apps/desktop`): `npm test`
Expected: all pass (the new `previewLoop` test included; nothing else affected).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/templates/TemplatePicker.tsx
git commit -m "feat(templates): selected large preview loops its animation in real time"
```

---

## Task 3: Real-WebView2 verification + docs

The animation loop (rAF + DOM + harness iframe) can't be meaningfully unit-tested — verify it live (the project's established path).

**Files:**
- Modify: `docs/templates.md` (the "Picker" section — keep evergreen)

- [ ] **Step 1: Launch + connect**

Ensure `npm run tauri:dev` is running (from `apps/desktop`); start a driver session on port 9223; confirm `ipc_get_backend_state` returns `dev.weftcut.desktop`.

- [ ] **Step 2: Open the picker and observe the loop**

Open a project (so the editor mounts), then open the template picker (Insert menu → Templates, or set `templatePickerOpen`). Observe the right-column large preview of the selected countdown:
- It loops 5→1 with the arc sweeping, repeating continuously (real-time, ~5 s/cycle).
- Capture 2-3 screenshots at different loop phases (e.g. showing "5", "3", "1") to evidence motion.
- The left-column card thumbnail stays a static single frame.

- [ ] **Step 3: Probe edits + reduced-motion + leak**

- Edit the `seconds` prop (e.g. → 8): the loop length grows to ~8 s and the preview reflects the new content (restarts from the first frame after the debounce). Edit `color`: the arc color changes in the loop.
- Switch the selected template (if >1 exists) / re-open the picker: the loop restarts from the first frame.
- Sustained-loop leak check: let it loop for ~30 s and confirm the PerfHUD heap is stable (no steady growth) — the object-URL revoke-on-bind keeps URLs bounded. If you see flicker on frame swaps, note it (fallback: revoke on the `<img>` onLoad, or double-buffer two `<img>`s — out of scope unless it actually flickers).
- Close the picker: the loop stops (no further renders).

- [ ] **Step 4: Update the docs "Picker" section (evergreen)**

In `docs/templates.md`, the "Picker" section currently says the picker drives `render(t)` "as a scrubbable preview". Update it to describe the actual behavior: the selected template's large preview plays its animation on a continuous real-time loop (~20 fps) through the same harness; card thumbnails stay static; reduced-motion falls back to the static first frame. Keep it evergreen (present tense, no dates/history).

```bash
git add docs/templates.md
git commit -m "docs(templates): picker large preview loops in real time"
```

- [ ] **Step 5: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`.

---

## Self-Review

**Spec coverage:**
- Only the large (selected) preview animates; cards static: Task 2 (Step 4 passes `animate` only at the form call site; `TemplateCardThumbnail` unchanged). ✓
- Continuous real-time loop, wraps `[0, duration)`: Task 1 (`previewLoopTimeSec`) + Task 2 loop. ✓
- ~20 fps sample: Task 2 `PREVIEW_FPS = 20` + throttle. ✓
- Loop period = template duration (`default_duration_s`): Task 2 `durMs`. ✓
- Reset on selection change / stop on close: Task 2 effect deps (`template.id`) + cleanup (`cancelAnimationFrame`); verified in Task 3 Step 3. ✓
- Prop edits reflect live: Task 2 (`props` in deps → loop restarts with new props). ✓
- Object-URL hygiene (revoke previous): Task 2 `bindSvg` revokes `urlRef.current`; unmount-revoke effect unchanged. ✓
- Sequential render guard: Task 2 `rendering` flag. ✓
- Reduced-motion fallback to static: Task 2 `prefersReducedMotion` branch. ✓
- Unit test for `previewLoopTimeSec`: Task 1. ✓
- Real-WebView2 verification: Task 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one NOTE flags a "confirm the existing refs" check (not a placeholder — an integration safety note).

**Type consistency:** `previewLoopTimeSec(elapsedMs: number, durationMs: number): number` defined in Task 1, called in Task 2 with `(now - startMs, durMs)`. `animate?: boolean` added to the prop type and passed as a bare `animate` (true) at the call site. `PREVIEW_FPS`/`PREVIEW_T_SEC` constants referenced consistently. `bindSvg` defined once, used by both branches.
