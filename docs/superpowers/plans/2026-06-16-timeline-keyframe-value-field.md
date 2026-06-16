# Shared KeyframeField + Timeline Expanded-Row Value Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the inspector's duplicated auto-key value field into one shared `KeyframeField` component (shared-draft, multi-widget binding), centralize per-param metadata into `ParamDescriptor` + an `autoKeyTrack` helper, then add an editable value to the expanded keyframe sub-lane row in the timeline.

**Architecture:** One behavior truth (`keyframe/autoKey.ts`) + one metadata truth (extended `ParamDescriptor`) + one UI component (`components/KeyframeField.tsx`) consumed by two thin adapters — `InspectorAnimField` (inside `PropertyPanel`, with stopwatch) and `KeyframeValueField` (timeline, no stopwatch, compact). Purely frontend; same `update_layer_param_track` write path; no engine/IPC/schema change → no engine-pair drift risk.

**Tech Stack:** TypeScript, React, Zustand, Base UI (`AppNumberField`/`AppSlider`), i18next, Vitest + Testing Library (jsdom). Build/typecheck: `npm --prefix apps/desktop run` scripts; typecheck via `npx tsc -b`.

**Spec:** `docs/superpowers/specs/2026-06-16-timeline-keyframe-value-field-design.md`

**Pre-flight (run once before Task 1):**
- This repo has parallel sessions on the same checkout — stage by **explicit path** in every commit (never `git add -A`), and the project commits to local `main` (do not branch).
- Confirm the test runner command: `cd apps/desktop` then `npx vitest run <path>` runs a single file; `npx tsc -b` typechecks. (If `apps/desktop` has a `package.json` test script, either works — the plan uses `npx vitest run`.)

---

### Task 1: `autoKeyTrack` pure helper

The single source of the "commit a scalar to an animatable param" rule (today copy-pasted ~10× in `PropertyPanel`).

**Files:**
- Create: `apps/desktop/src/keyframe/autoKey.ts`
- Test: `apps/desktop/src/keyframe/autoKey.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/keyframe/autoKey.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { AnimTrack } from "../ipc";
import { autoKeyTrack } from "./autoKey";

describe("autoKeyTrack", () => {
  it("upserts a new key at tInLayerUs on a Keyframed track", () => {
    const track: AnimTrack<number> = {
      mode: "Keyframed",
      value: [{ id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } }],
    };
    const next = autoKeyTrack(track, 500_000, 0.5);
    expect(next.mode).toBe("Keyframed");
    if (next.mode !== "Keyframed") throw new Error("unreachable");
    expect(next.value.some((k) => k.t_us === 500_000 && k.value === 0.5)).toBe(true);
    expect(next.value).toHaveLength(2);
  });

  it("updates the value of an existing key at the same time in place", () => {
    const track: AnimTrack<number> = {
      mode: "Keyframed",
      value: [{ id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } }],
    };
    const next = autoKeyTrack(track, 0, 0.9);
    if (next.mode !== "Keyframed") throw new Error("unreachable");
    expect(next.value).toHaveLength(1);
    expect(next.value[0]).toMatchObject({ id: "a", t_us: 0, value: 0.9 });
  });

  it("writes a Static value when the track is Static", () => {
    const track: AnimTrack<number> = { mode: "Static", value: 1 };
    const next = autoKeyTrack(track, 123, 0.25);
    expect(next).toEqual({ mode: "Static", value: 0.25 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/keyframe/autoKey.test.ts`
Expected: FAIL — "Failed to resolve import './autoKey'" (module not found).

- [ ] **Step 3: Write minimal implementation**

`apps/desktop/src/keyframe/autoKey.ts`:

```ts
// The single source of the "commit a scalar to an animatable param" rule,
// shared by the inspector and the timeline value field. Pure: Keyframed →
// upsert a key at the playhead-local time; Static → a plain value write.
// Pairs with `displayValue` (the read side) in components/AnimatableField.ts.
import type { AnimTrack } from "../ipc";
import { upsertKeyframe } from "./edits";

export function autoKeyTrack(
  track: AnimTrack<number>,
  tInLayerUs: number,
  val: number,
): AnimTrack<number> {
  return track.mode === "Keyframed"
    ? upsertKeyframe(track, tInLayerUs, val)
    : { mode: "Static", value: val };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/keyframe/autoKey.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/keyframe/autoKey.ts apps/desktop/src/keyframe/autoKey.test.ts
git commit -m "feat(keyframe): add autoKeyTrack — shared auto-key commit rule"
```

---

### Task 2: Extend `ParamDescriptor` with widgets + domain metadata

Pull the per-param `step`/`min`/`max` (today hardcoded in `PropertyPanel`) and a `widgets` presentation list into the descriptor — the single metadata truth for both surfaces. Export the descriptor constants so `PropertyPanel` can reference them directly.

**Files:**
- Modify: `apps/desktop/src/keyframe/descriptors.ts:6-36`
- Test: `apps/desktop/src/keyframe/descriptors.test.ts` (create)

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/keyframe/descriptors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { animatableParams } from "./descriptors";

const byKey = (kind: string, key: string) =>
  animatableParams(kind).find((d) => d.paramKey === key)!;

describe("ParamDescriptor metadata", () => {
  it("opacity is a slider+readout, 0..1 step 0.01", () => {
    const d = byKey("VideoClip", "opacity");
    expect(d.step).toBe(0.01);
    expect(d.min).toBe(0);
    expect(d.max).toBe(1);
    expect(d.widgets).toEqual(["slider", "readout"]);
  });

  it("x/y are plain number fields, step 1", () => {
    const d = byKey("Text", "x");
    expect(d.step).toBe(1);
    expect(d.widgets).toEqual(["number"]);
  });

  it("scale is a number field, step 0.05", () => {
    expect(byKey("Motif", "scale_x").step).toBe(0.05);
    expect(byKey("Motif", "scale_x").widgets).toEqual(["number"]);
  });

  it("gain_db is a number field -30..20 step 0.5; pan is a slider -1..1 step 0.05", () => {
    const g = byKey("Audio", "gain_db");
    expect([g.step, g.min, g.max]).toEqual([0.5, -30, 20]);
    expect(g.widgets).toEqual(["number"]);
    const p = byKey("Audio", "pan");
    expect([p.step, p.min, p.max]).toEqual([0.05, -1, 1]);
    expect(p.widgets).toEqual(["slider"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/keyframe/descriptors.test.ts`
Expected: FAIL — `d.step` is `undefined` / `d.widgets` is `undefined`.

- [ ] **Step 3: Edit `descriptors.ts`**

Replace lines 6-21 (the `ParamDescriptor` interface and the seven `const X … PAN` declarations) with:

```ts
export type KfWidget = "slider" | "number" | "readout";

export interface ParamDescriptor {
  /// Wire key understood by `updateLayerParamTrack` and the Rust resolver.
  paramKey: string;
  /// Existing i18n key (reuse the property-panel labels).
  labelKey: string;
  /// Static fallback used when a Keyframed track is empty / before its first key.
  fallback: number;
  /// Number-field / slider step (absent ⇒ default 1).
  step?: number;
  /// Optional domain bounds.
  min?: number;
  max?: number;
  /// Default inspector presentation, rendered in order, all bound to one value.
  /// Consumers (e.g. the timeline) may override per call.
  widgets?: KfWidget[];
}

export const X: ParamDescriptor = { paramKey: "x", labelKey: "property_panel.x", fallback: 0, step: 1, widgets: ["number"] };
export const Y: ParamDescriptor = { paramKey: "y", labelKey: "property_panel.y", fallback: 0, step: 1, widgets: ["number"] };
export const SCALE_X: ParamDescriptor = { paramKey: "scale_x", labelKey: "property_panel.scale_x", fallback: 1, step: 0.05, widgets: ["number"] };
export const SCALE_Y: ParamDescriptor = { paramKey: "scale_y", labelKey: "property_panel.scale_y", fallback: 1, step: 0.05, widgets: ["number"] };
export const OPACITY: ParamDescriptor = { paramKey: "opacity", labelKey: "property_panel.opacity", fallback: 1, step: 0.01, min: 0, max: 1, widgets: ["slider", "readout"] };
export const GAIN_DB: ParamDescriptor = { paramKey: "gain_db", labelKey: "property_panel.gain_db", fallback: 0, step: 0.5, min: -30, max: 20, widgets: ["number"] };
export const PAN: ParamDescriptor = { paramKey: "pan", labelKey: "property_panel.pan", fallback: 0, step: 0.05, min: -1, max: 1, widgets: ["slider"] };
```

(Leave `animatableParams` and `readParamTrack` below unchanged — they already reference `X … PAN`.)

- [ ] **Step 4: Run test + typecheck**

Run: `cd apps/desktop && npx vitest run src/keyframe/descriptors.test.ts && npx tsc -b`
Expected: vitest PASS (4 passed); `tsc -b` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/keyframe/descriptors.ts apps/desktop/src/keyframe/descriptors.test.ts
git commit -m "feat(keyframe): centralize step/min/max/widgets into ParamDescriptor"
```

---

### Task 3: `KeyframeField` shared component

The shared value editor: one internal draft + one commit, a configurable `widgets` list (all bound to that draft → multi-widget live sync), optional stopwatch chrome, optional compact density.

**Files:**
- Create: `apps/desktop/src/components/KeyframeField.tsx`
- Test: `apps/desktop/src/components/KeyframeField.test.tsx`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/components/KeyframeField.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { AnimTrack } from "../ipc";
import { KeyframeField } from "./KeyframeField";

afterEach(cleanup);

const keyed = (t_us: number, value: number): AnimTrack<number> => ({
  mode: "Keyframed",
  value: [{ id: "a", t_us, value, interp: { kind: "Linear" } }],
});

describe("KeyframeField (no stopwatch / timeline mode)", () => {
  it("commits an upserted key at tInLayerUs on blur", async () => {
    const onCommitTrack = vi.fn();
    render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 0)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={onCommitTrack}
        widgets={["number"]} step={1} showStopwatch={false}
      />,
    );
    await userEvent.type(screen.getByLabelText("x"), "120");
    await userEvent.click(document.body); // blur → commit
    expect(onCommitTrack).toHaveBeenCalledTimes(1);
    const [paramKey, next] = onCommitTrack.mock.calls[0]!;
    expect(paramKey).toBe("x");
    expect(next.mode === "Keyframed" && next.value[0].value).toBe(120);
  });

  it("disables the input off-span when there is no stopwatch", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 0)} fallback={0}
        tInLayerUs={-100} playheadInSpan={false} onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch={false}
      />,
    );
    expect((screen.getByLabelText("x") as HTMLInputElement).disabled).toBe(true);
  });

  it("idle display follows the evaluated value (shown) when not editing", () => {
    const { rerender } = render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 10)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch={false}
      />,
    );
    expect((screen.getByLabelText("x") as HTMLInputElement).value).toBe("10");
    rerender(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 42)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch={false}
      />,
    );
    expect((screen.getByLabelText("x") as HTMLInputElement).value).toBe("42");
  });
});

describe("KeyframeField widget composition", () => {
  it("renders a readout span next to a slider", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="opacity" label="opacity" track={keyed(0, 0.5)} fallback={1}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["slider", "readout"]} step={0.01} min={0} max={1} showStopwatch={false}
      />,
    );
    expect(screen.getByRole("slider")).toBeTruthy();
    expect(screen.getByText("0.50")).toBeTruthy();
  });

  it("renders a slider AND a number field bound to the same value", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="opacity" label="opacity" track={keyed(0, 0.5)} fallback={1}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["slider", "number"]} step={0.01} min={0} max={1} showStopwatch={false}
      />,
    );
    expect(screen.getByRole("slider")).toBeTruthy();
    expect((screen.getByLabelText("opacity") as HTMLInputElement).value).toBe("0.5");
  });
});

describe("KeyframeField (stopwatch / inspector mode)", () => {
  it("renders the stopwatch toggle when showStopwatch is set", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 0)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch onMutated={async () => {}}
      />,
    );
    // AnimatableField renders the .anim-stopwatch button (aria-pressed reflects Keyframed).
    expect(document.querySelector(".anim-stopwatch")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npx vitest run src/components/KeyframeField.test.tsx`
Expected: FAIL — "Failed to resolve import './KeyframeField'".

- [ ] **Step 3: Write the component**

`apps/desktop/src/components/KeyframeField.tsx`:

```tsx
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AnimTrack } from "../ipc";
import type { KfWidget } from "../keyframe/descriptors";
import { autoKeyTrack } from "../keyframe/autoKey";
import { AppNumberField } from "./AppNumberField";
import { AppSlider } from "./AppSlider";
import { AnimatableField, displayValue } from "./AnimatableField";

// Sliders fire onValueChange continuously; debounce the recorded commit so a
// drag doesn't flood the actor (same 250ms the inspector used pre-consolidation).
const SLIDER_COMMIT_DEBOUNCE_MS = 250;

export interface KeyframeFieldProps {
  layerId: string;
  paramKey: string;
  label: string;
  track: AnimTrack<number>;
  fallback: number;
  /// Playhead time relative to the layer's t_start (may be <0 / > duration).
  tInLayerUs: number;
  /// Within the layer's span — gates keyframe creation (inspector stopwatch) and
  /// disables the inputs in no-stopwatch mode (can't author off-clip).
  playheadInSpan: boolean;
  /// Commit sink — decouples the component from the transport. The inspector
  /// calls updateLayerParamTrack; the timeline routes through onCommitParamTrack.
  onCommitTrack: (paramKey: string, next: AnimTrack<number>) => void | Promise<void>;
  /// Which controls to render, in order — all bound to one shared draft value.
  widgets: KfWidget[];
  step?: number;
  min?: number;
  max?: number;
  /// Inspector: true (wraps in AnimatableField's stopwatch). Timeline: false.
  showStopwatch?: boolean;
  /// Timeline density.
  compact?: boolean;
  /// Required when showStopwatch — AnimatableField's toggle refreshes through it.
  onMutated?: () => Promise<void>;
}

export function KeyframeField({
  layerId,
  paramKey,
  label,
  track,
  fallback,
  tInLayerUs,
  playheadInSpan,
  onCommitTrack,
  widgets,
  step,
  min,
  max,
  showStopwatch = true,
  compact = false,
  onMutated,
}: KeyframeFieldProps) {
  const shown = displayValue(track, tInLayerUs, fallback);
  // Shared draft: null = idle (display `shown`, which tracks playhead/undo);
  // a number while a widget is mid-interaction. Every widget reads `value` and
  // writes the draft, so a slider drag and a sibling number field stay in sync.
  const [draft, setDraft] = useState<number | null>(null);
  // A new bound param/layer must not inherit the previous field's draft.
  useEffect(() => setDraft(null), [layerId, paramKey]);
  const value = draft ?? shown;

  const commit = (val: number) => {
    setDraft(null);
    void onCommitTrack(paramKey, autoKeyTrack(track, tInLayerUs, val));
  };

  // Closure-stable timer slot for the slider debounce (mirrors the inspector's
  // useDebouncedCommit; ref-free to avoid an extra import).
  const slot = useMemo<{ current: ReturnType<typeof setTimeout> | null }>(
    () => ({ current: null }),
    [],
  );
  const commitDebounced = (val: number) => {
    setDraft(val);
    if (slot.current) clearTimeout(slot.current);
    slot.current = setTimeout(() => {
      void onCommitTrack(paramKey, autoKeyTrack(track, tInLayerUs, val));
      setDraft(null);
    }, SLIDER_COMMIT_DEBOUNCE_MS);
  };

  // No-stopwatch mode (timeline) can't author off-clip → disable the inputs.
  // With the stopwatch, AnimatableField owns its own disabled logic and the
  // widgets stay enabled (the inspector allows editing a keyed param off-span).
  const inputsDisabled = !showStopwatch && !playheadInSpan;

  const controls: ReactNode[] = widgets.map((w, i) => {
    switch (w) {
      case "number":
        return (
          <AppNumberField
            key={`num-${i}`}
            value={value}
            step={step}
            min={min}
            max={max}
            disabled={inputsDisabled}
            ariaLabel={label}
            // No-op live change: let Base UI self-buffer the typed text and
            // commit on blur/Enter (the inspector-proven pattern). A sibling
            // slider drives `draft`, so this field still reflects it live.
            onValueChange={() => {}}
            onCommit={commit}
          />
        );
      case "slider":
        return (
          <AppSlider
            key={`sld-${i}`}
            value={value}
            min={min ?? 0}
            max={max ?? 1}
            step={step}
            disabled={inputsDisabled}
            ariaLabel={label}
            onValueChange={commitDebounced}
          />
        );
      case "readout":
        return (
          <span key={`ro-${i}`} className="prop-range-value">
            {value.toFixed(2)}
          </span>
        );
    }
  });

  if (showStopwatch) {
    return (
      <AnimatableField
        layerId={layerId}
        paramKey={paramKey}
        label={label}
        track={track}
        fallback={fallback}
        tInLayerUs={tInLayerUs}
        playheadInSpan={playheadInSpan}
        onMutated={onMutated ?? (async () => {})}
      >
        {controls}
      </AnimatableField>
    );
  }

  return (
    <div className={compact ? "kf-value-field kf-value-field--compact" : "kf-value-field"}>
      {controls}
    </div>
  );
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/desktop && npx vitest run src/components/KeyframeField.test.tsx && npx tsc -b`
Expected: vitest PASS (6 passed); `tsc -b` clean.

(If `getByText("0.50")` is split across nodes, use `screen.getByText((_, el) => el?.className === "prop-range-value" && el.textContent === "0.50")`.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/KeyframeField.tsx apps/desktop/src/components/KeyframeField.test.tsx
git commit -m "feat(keyframe): add shared KeyframeField (draft binding, multi-widget)"
```

---

### Task 4: Inspector adapter `InspectorAnimField` (plumbing, not yet wired)

A thin per-(layer, descriptor) adapter that renders `KeyframeField` with the stopwatch and the inspector commit path. Added but unused this task (zero behavior change) so the migration tasks that follow are one-liners.

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx` (imports near top + new helper component)

- [ ] **Step 1: Add imports**

In `PropertyPanel.tsx`, add to the existing import block:

```tsx
import { KeyframeField } from "../components/KeyframeField";
import { type ParamDescriptor } from "../keyframe/descriptors";
```

The file already imports `readParamTrack` from `../keyframe/descriptors` and `updateLayerParamTrack` from `../ipc` — keep those. The `displayValue` / `upsertKeyframe` / `AnimatableField` imports become unused as sections migrate; remove them only in the final migration task (Task 9) to keep each intermediate commit `tsc`-clean.

- [ ] **Step 2: Add the adapter component**

Add near the bottom of `PropertyPanel.tsx` (beside `Field`):

```tsx
/// Inspector adapter: maps a (layer, ParamDescriptor) pair onto the shared
/// KeyframeField with the stopwatch + the inspector commit path. Replaces the
/// ~10 hand-rolled value-field IIFEs; widgets/step/min/max come from the
/// descriptor (keyframe/descriptors.ts).
function InspectorAnimField({
  layer,
  params,
  desc,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  params: LayerSummary["params"];
  desc: ParamDescriptor;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const track = readParamTrack(params, desc.paramKey) ?? { mode: "Static" as const, value: desc.fallback };
  return (
    <KeyframeField
      layerId={layer.id}
      paramKey={desc.paramKey}
      label={t(desc.labelKey)}
      track={track}
      fallback={desc.fallback}
      tInLayerUs={tInLayerUs}
      playheadInSpan={playheadInSpan}
      onCommitTrack={(k, next) =>
        updateLayerParamTrack(layer.id, k, next).then(onMutated).catch((e) => console.warn(e))
      }
      onMutated={onMutated}
      widgets={desc.widgets ?? ["number"]}
      step={desc.step}
      min={desc.min}
      max={desc.max}
    />
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean (the helper is unused, but defined and well-typed; `ParamDescriptor`/`KeyframeField` resolve).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx
git commit -m "feat(inspector): add InspectorAnimField adapter over KeyframeField"
```

---

### Task 5: Migrate `AudioFields` (gain_db number, pan slider)

Smallest section — proves the slider migration too.

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx` (`AudioFields`, ~lines 1348-1435)

- [ ] **Step 1: Import the descriptor constants**

Extend the `../keyframe/descriptors` import to include the constants used in this and later tasks:

```tsx
import {
  readParamTrack,
  type ParamDescriptor,
  X, Y, SCALE_X, SCALE_Y, OPACITY, GAIN_DB, PAN,
} from "../keyframe/descriptors";
```

- [ ] **Step 2: Replace the two IIFEs**

In `AudioFields`, delete the `commitTrack` + `debouncedCommitTrack` definitions and the two `{(() => { … })()}` blocks for `gain_db` and `pan`, replacing them with:

```tsx
<InspectorAnimField layer={layer} params={v} desc={GAIN_DB} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={PAN} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
```

Keep the `<h3>…media…</h3>` header and the `mute` `<Field>` switch unchanged. The `commit` prop (for `mute`) stays.

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean. (If `commitTrack`/`debouncedCommitTrack` are now unused and flagged, confirm they are fully removed from `AudioFields`.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx
git commit -m "refactor(inspector): migrate AudioFields to InspectorAnimField"
```

---

### Task 6: Migrate `TextFields` (x, y, opacity)

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx` (`TextFields`, ~lines 162-313)

- [ ] **Step 1: Replace the three animatable IIFEs**

In `TextFields`, replace the three `{(() => { … })()}` blocks (`x`, `y`, `opacity`) — in that order — with:

```tsx
<InspectorAnimField layer={layer} params={v} desc={X} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={Y} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={OPACITY} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
```

- [ ] **Step 2: Trim now-unused locals**

`TextFields` uses `debouncedCommit` for the **color** field (`AppColorField`) — KEEP it. Remove only `commitTrack` and `debouncedCommitTrack` (they served the migrated animatable fields). Leave `content`/`family`/`size`/`color` state and their fields untouched.

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx
git commit -m "refactor(inspector): migrate TextFields to InspectorAnimField"
```

---

### Task 7: Migrate `VideoClipFields` (opacity, scale_x, scale_y, x, y)

Preserve the existing **opacity-first** order.

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx` (`VideoClipFields`, ~lines 315-531)

- [ ] **Step 1: Replace the five animatable IIFEs**

Replace the five blocks (`opacity`, `scale_x`, `scale_y`, `x`, `y` — keep this order) with:

```tsx
<InspectorAnimField layer={layer} params={v} desc={OPACITY} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={SCALE_X} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={SCALE_Y} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={X} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={Y} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
```

- [ ] **Step 2: Remove now-unused locals**

`VideoClipFields` uses `commitTrack`/`debouncedCommitTrack` only for the migrated fields — remove both. Keep `speed`/`fadeInTc`/`fadeOutTc` state, the `commit`-based speed/fade/flip fields, and the `useEffect` that seeds them.

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx
git commit -m "refactor(inspector): migrate VideoClipFields to InspectorAnimField"
```

---

### Task 8: Migrate `ImageOverlayFields` (opacity, x, y)

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx` (`ImageOverlayFields`, ~lines 533-674)

- [ ] **Step 1: Replace the three animatable IIFEs**

Replace the `opacity`, `x`, `y` blocks (this order) with:

```tsx
<InspectorAnimField layer={layer} params={v} desc={OPACITY} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={X} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={Y} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
```

- [ ] **Step 2: Remove now-unused locals**

Remove `commitTrack`/`debouncedCommitTrack`. Keep `fadeInTc`/`fadeOutTc` state and the `commit`-based fade fields.

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx
git commit -m "refactor(inspector): migrate ImageOverlayFields to InspectorAnimField"
```

---

### Task 9: Migrate `MotifFields` (x, y, scale_x, scale_y, opacity) + remove dead imports

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx` (`MotifFields`, ~lines 692-884; import block at top)

- [ ] **Step 1: Replace the five animatable IIFEs**

Replace the `x`, `y`, `scale_x`, `scale_y`, `opacity` blocks (this order) with:

```tsx
<InspectorAnimField layer={layer} params={v} desc={X} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={Y} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={SCALE_X} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={SCALE_Y} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
<InspectorAnimField layer={layer} params={v} desc={OPACITY} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
```

- [ ] **Step 2: Remove now-unused locals + dead imports**

In `MotifFields`, remove `commitTrack` and `debouncedCommitTrack`. KEEP `debouncedCommit` (used by `MotifPropField` color/props). Then, at the top of the file, remove imports that are now unused across the whole file:
- `AnimatableField` and `displayValue` from `../components/AnimatableField` (the adapter uses `KeyframeField`, which imports them itself).
- `upsertKeyframe` from `../keyframe/edits`.

Do NOT remove `readParamTrack` (still used by the adapter + `MotifFields` motif lookups), `updateLayerParamTrack`, `trackStatic`, or `AppSlider`/`AppNumberField` (still used by non-animatable rows — e.g. `font_size_px`, `speed`, `Color` width/height, motif number props).

- [ ] **Step 3: Typecheck (no unused-symbol errors)**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean — no "declared but never used" for the removed imports/locals.

- [ ] **Step 4: Visual smoke (manual checkpoint)**

Launch the app (see the `run` skill or the project's `tauri dev`). For a VideoClip, an Audio clip, a Text, and a Motif layer: confirm each animatable row shows the same control as before (opacity slider + numeric readout, x/y/scale number fields, gain number field, pan slider), values match the playhead, editing creates/updates a keyframe (stopwatch lit), and field order is unchanged. This is the regression gate for the inspector (no automated `PropertyPanel` test exists).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx
git commit -m "refactor(inspector): migrate MotifFields + drop dead value-field imports"
```

---

### Task 10: Timeline `KeyframeValueField` + wire into the expanded sub-lane header

**Files:**
- Create: `apps/desktop/src/timeline/KeyframeValueField.tsx`
- Test: `apps/desktop/src/timeline/KeyframeValueField.test.tsx`
- Modify: `apps/desktop/src/timeline/KeyframeLane.tsx` (`KeyframeLaneHeaders`, lines 37-76)

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/timeline/KeyframeValueField.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { AnimTrack, TrackSummary } from "../ipc";
import { OPACITY } from "../keyframe/descriptors";
import { KeyframeValueField } from "./KeyframeValueField";
import { clearKeyframeFocus } from "../keyframe/focusStore";

afterEach(() => {
  cleanup();
  clearKeyframeFocus();
  vi.clearAllMocks();
});

const opacityTrack: AnimTrack<number> = {
  mode: "Keyframed",
  value: [{ id: "a", t_us: 0, value: 0.5, interp: { kind: "Linear" } }],
};
const oneClip = (params: Record<string, AnimTrack<number>>): TrackSummary =>
  ({ layers: [{ id: "L1", t_start_us: 0, t_end_us: 2_000_000, params }] }) as unknown as TrackSummary;

function renderField(currentTimeUs: number, onCommit = vi.fn()) {
  render(
    <KeyframeValueField
      track={oneClip({ opacity: opacityTrack })}
      desc={OPACITY}
      currentTimeUs={currentTimeUs}
      fpsNum={30}
      fpsDen={1}
      onCommitParamTrack={onCommit}
    />,
  );
  return onCommit;
}

describe("KeyframeValueField", () => {
  it("renders a number field (not a slider) showing the value at the playhead", () => {
    renderField(0);
    expect((screen.getByLabelText("Opacity") as HTMLInputElement).value).toBe("0.5");
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("commits an upserted key at the snapped playhead through onCommitParamTrack", async () => {
    const onCommit = renderField(0);
    const el = screen.getByLabelText("Opacity");
    await userEvent.clear(el);
    await userEvent.type(el, "0.8");
    await userEvent.click(document.body);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [layerId, paramKey, next] = onCommit.mock.calls[0]!;
    expect(layerId).toBe("L1");
    expect(paramKey).toBe("opacity");
    expect(next.mode === "Keyframed" && next.value[0].value).toBe(0.8);
  });

  it("disables the field off the clip span", () => {
    renderField(3_000_000); // beyond t_end_us
    expect((screen.getByLabelText("Opacity") as HTMLInputElement).disabled).toBe(true);
  });

  it("renders nothing when the target clip is ambiguous (two keyframed, none focused)", () => {
    const tr = {
      layers: [
        { id: "L1", t_start_us: 0, t_end_us: 2_000_000, params: { opacity: opacityTrack } },
        { id: "L2", t_start_us: 0, t_end_us: 2_000_000, params: { opacity: opacityTrack } },
      ],
    } as unknown as TrackSummary;
    const { container } = render(
      <KeyframeValueField track={tr} desc={OPACITY} currentTimeUs={0} fpsNum={30} fpsDen={1} onCommitParamTrack={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
```

(The label resolves to "Opacity" from the en-US `property_panel.opacity` key. If the test locale differs, assert with the resolved label via `i18n.t`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/timeline/KeyframeValueField.test.tsx`
Expected: FAIL — "Failed to resolve import './KeyframeValueField'".

- [ ] **Step 3: Write the component**

`apps/desktop/src/timeline/KeyframeValueField.tsx`:

```tsx
import type { SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TrackSummary } from "../ipc";
import type { AnimTrack } from "../ipc";
import { readParamTrack, type ParamDescriptor } from "../keyframe/descriptors";
import { resolveNavLayer } from "../keyframe/nav";
import { snapFrameRound } from "../frames";
import { useKeyframeFocusStore } from "../keyframe/focusStore";
import { KeyframeField } from "../components/KeyframeField";

/// The editable value for one expanded sub-lane row: the property's value at
/// the frame-snapped playhead, as a compact number field with no stopwatch.
/// Acts on the same resolved clip as the row's navigator (resolveNavLayer →
/// focused clip / sole keyframed clip / none). Editing creates/updates a key
/// at the playhead through the timeline's onCommitParamTrack (one undo step).
export function KeyframeValueField({
  track,
  desc,
  currentTimeUs,
  fpsNum,
  fpsDen,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  desc: ParamDescriptor;
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const { t } = useTranslation();
  const focusedLayerId = useKeyframeFocusStore((s) => s.layerId);
  const layer = resolveNavLayer(track, desc.paramKey, focusedLayerId);
  const trk = layer ? readParamTrack(layer.params, desc.paramKey) : null;
  if (!layer || !trk || trk.mode !== "Keyframed") return null;

  const tLocalUs = snapFrameRound(currentTimeUs - layer.t_start_us, fpsNum, fpsDen);
  const inSpan = tLocalUs >= 0 && tLocalUs <= layer.t_end_us - layer.t_start_us;

  // The timeline root's onClick clears the layer selection; stop the bubble so
  // editing the value doesn't deselect (same guard as KeyframeNavigator).
  const stop = (e: SyntheticEvent) => e.stopPropagation();

  return (
    <div className="kf-value-row mt-0.5 max-w-[7rem]" onClick={stop} onPointerDown={stop}>
      <KeyframeField
        layerId={layer.id}
        paramKey={desc.paramKey}
        label={t(desc.labelKey, { defaultValue: desc.paramKey })}
        track={trk}
        fallback={desc.fallback}
        tInLayerUs={tLocalUs}
        playheadInSpan={inSpan}
        onCommitTrack={(k, next) => onCommitParamTrack(layer.id, k, next)}
        widgets={["number"]}
        step={desc.step}
        min={desc.min}
        max={desc.max}
        showStopwatch={false}
        compact
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/timeline/KeyframeValueField.test.tsx`
Expected: PASS (4 passed).

- [ ] **Step 5: Wire into `KeyframeLaneHeaders`**

In `apps/desktop/src/timeline/KeyframeLane.tsx`, add the import:

```tsx
import { KeyframeValueField } from "./KeyframeValueField";
```

Then replace the row `<div>` body inside `KeyframeLaneHeaders` (the `props.map((d) => …)` return, lines ~56-72) with a fixed-height nav+label line plus the value field only when the row is expanded:

```tsx
{props.map((d) => {
  const expanded = d.paramKey === focusedParamKey;
  return (
    <div
      key={d.paramKey}
      className="border-b border-border-soft px-1.5 text-[10px] text-muted-foreground/80"
      style={{ height: expanded ? KF_SUBLANE_EXPANDED_H : KF_SUBLANE_H }}
    >
      <div className="flex items-center justify-between gap-1" style={{ height: KF_SUBLANE_H }}>
        <KeyframeNavigator
          track={track}
          paramKey={d.paramKey}
          fallback={d.fallback}
          currentTimeUs={currentTimeUs}
          fpsNum={fpsNum}
          fpsDen={fpsDen}
          onCommitParamTrack={onCommitParamTrack}
        />
        <span className="truncate">{t(d.labelKey, { defaultValue: d.paramKey })}</span>
      </div>
      {expanded && (
        <KeyframeValueField
          track={track}
          desc={d}
          currentTimeUs={currentTimeUs}
          fpsNum={fpsNum}
          fpsDen={fpsDen}
          onCommitParamTrack={onCommitParamTrack}
        />
      )}
    </div>
  );
})}
```

The collapsed row is now an inner `h-{KF_SUBLANE_H}` flex line, visually identical to before; the expanded row adds the value field below it in the spare vertical space. `KeyframeLaneHeaders` already receives `currentTimeUs`/`fpsNum`/`fpsDen`/`onCommitParamTrack` — no new props from `Timeline.tsx`.

- [ ] **Step 6: Typecheck + run both timeline test files**

Run: `cd apps/desktop && npx tsc -b && npx vitest run src/timeline/KeyframeValueField.test.tsx src/timeline/KeyframeNavigator.test.tsx`
Expected: `tsc -b` clean; vitest PASS (navigator suite still green — its rendering is unchanged since it's the inner line).

- [ ] **Step 7: Visual smoke (manual checkpoint)**

In the app: keyframe a clip's opacity, expand its sub-lane (click the property/a diamond to focus). Confirm the expanded header shows an editable number field under the navigator; collapsed rows show only nav+label; stepping with `◄ ►` updates the shown value; typing a new value + Enter/blur creates or updates a key at the playhead; off-clip playhead disables the field.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/timeline/KeyframeValueField.tsx apps/desktop/src/timeline/KeyframeValueField.test.tsx apps/desktop/src/timeline/KeyframeLane.tsx
git commit -m "feat(timeline): editable value field in expanded keyframe sub-lane header"
```

---

### Task 11: Docs + full-suite gate

**Files:**
- Modify: the timeline keyframe doc (evergreen). Find it: `cd apps/desktop && ls ../../docs | grep -i timeline` or grep the docs for the keyframe navigator section: `grep -rl "keyframe navigator" ../../docs`. Update that section.

- [ ] **Step 1: Update the doc**

In the timeline keyframe section (evergreen tone — no dates/phase numbers/commit hashes per `feedback_evergreen_docs`), add a sentence to the expanded-sub-lane description: the focused property row shows an editable value field beside the navigator that reads the property's value at the playhead and writes a keyframe there on edit; note `KeyframeField` is the shared inspector/timeline value control. If a "shared input components" doc lists `AppNumberField`/`AppSlider`, add `KeyframeField` as the keyframe-aware composite over them.

- [ ] **Step 2: Full gate**

Run: `cd apps/desktop && npx tsc -b && npx vitest run`
Expected: `tsc -b` clean; entire vitest suite green (new `autoKey`, `descriptors`, `KeyframeField`, `KeyframeValueField` suites pass; existing `KeyframeNavigator` + all others unaffected).

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs(timeline): document the expanded-row keyframe value field + KeyframeField"
```

---

## Self-Review

**Spec coverage:**
- §1 `autoKeyTrack` → Task 1. ✓
- §2 `ParamDescriptor` extension (step/min/max/widgets, the table) → Task 2. ✓
- §3 `KeyframeField` (shared draft, widget list, stopwatch/compact, commit sink, slider debounce, off-span disable, idle-follows-shown, draft reset) → Task 3 (+ tests for each). ✓
- §4 Inspector full consolidation incl. sliders, order preserved → Tasks 4-9 (adapter + per-section migration in original order; VideoClip/ImageOverlay opacity-first preserved). ✓
- §5 Timeline expanded-row value field (resolveNavLayer, snapped playhead, onCommitParamTrack, off-span disable, collapsed unchanged, no new Timeline props) → Task 10. ✓
- §6 determinism/migration/i18n (no new keys)/docs → Task 11 + noted throughout (reuses labelKey, same write path). ✓
- §7 testing (autoKey unit, KeyframeField component incl. multi-widget, inspector regression via tsc+visual, timeline RTL) → Tasks 1-3,10 + manual checkpoints in 9 & 10. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; manual checkpoints (no PropertyPanel test exists) are explicit and labeled, not hand-waved.

**Type consistency:** `KeyframeFieldProps.onCommitTrack: (paramKey, next) => void | Promise<void>` is used identically by `InspectorAnimField` (Task 4) and `KeyframeValueField` (Task 10). `widgets: KfWidget[]` (defined Task 2, imported Task 3) matches `desc.widgets ?? ["number"]` (Task 4) and `["number"]` (Task 10). `autoKeyTrack(track, tInLayerUs, val)` signature (Task 1) matches its call in `KeyframeField.commit`/`commitDebounced` (Task 3). `displayValue`/`upsertKeyframe` reused from existing modules with verified signatures. Descriptor constants `X…PAN` exported in Task 2, consumed in Tasks 5-9.

## Execution Handoff

(see below)
