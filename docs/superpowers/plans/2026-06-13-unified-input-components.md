# Unified Input Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse ~80 scattered raw `<input>` elements and ~8 duplicated CSS scopes into one reusable `App*` control family (`AppInput`, `AppNumberField`, `AppColorField`) sharing a single `.app-input` skin, then migrate every call site.

**Architecture:** Three control-only wrappers in `apps/desktop/src/components/`, following the existing `App*` convention (Base UI primitive + shared CSS skin, à la `AppSwitch`/`AppSelect`/`AppSlider`). `AppInput` wraps Base UI `Input`; `AppNumberField` wraps Base UI `NumberField` (steppers + drag-scrub); `AppColorField` skins the native `<input type="color">`. Call sites keep their existing label/row markup — these wrap the control only. Behavior contract (value shape, commit timing, undo granularity, ref/keydown passthrough) is preserved exactly and locked by component tests.

**Tech Stack:** React 19, TypeScript 6, Base UI (`@base-ui/react` ^1.5), Tailwind v4 + plain CSS in `styles.css`, lucide-react icons, Vitest 4. New dev deps for component TDD: `@testing-library/react`, `@testing-library/user-event`, `jsdom`.

---

## Spec

Full design: `docs/superpowers/specs/2026-06-13-unified-input-components-design.md`.

## File Structure

**Created:**
- `apps/desktop/src/components/AppInput.tsx` — text/password/search wrapper (+ clearable search)
- `apps/desktop/src/components/AppNumberField.tsx` — numeric wrapper (steppers + scrub)
- `apps/desktop/src/components/AppColorField.tsx` — skinned native color swatch
- `apps/desktop/src/components/AppInput.test.tsx` — component tests (jsdom)
- `apps/desktop/src/components/AppNumberField.test.tsx`
- `apps/desktop/src/components/AppColorField.test.tsx`

**Modified:**
- `apps/desktop/src/styles.css` — add `.app-input` skin + modifiers; delete per-scope input rules as each phase migrates
- `apps/desktop/package.json` — add 3 dev deps
- Migration targets (Phases 1–5): `properties/PropertyPanel.tsx`, `settings/SettingsPanel.tsx`, `panels/ExportSettingsDialog.tsx`, `motifs/MotifPicker.tsx`, `App.tsx`, `timeline/LayerBlock.tsx`, `startup/StartupScreen.tsx`, `logs/LogConsole.tsx`

## Conventions (read before any task)

- `cn(...)` lives in `@/lib/utils` (clsx + tailwind-merge). Import: `import { cn } from "@/lib/utils";`
- `@` aliases `apps/desktop/src` (see `vite.config.ts`).
- Existing wrappers to mirror: `apps/desktop/src/components/AppSwitch.tsx`, `AppSelect.tsx`.
- Component tests use the `// @vitest-environment jsdom` docblock (top of file). Existing pure-logic tests stay node-env — **do not** add a global `test.environment` to `vite.config.ts`.
- Run tests: `npm --workspace apps/desktop run test`. Typecheck: `npm run typecheck` (root) or `npm --workspace apps/desktop run typecheck`.
- Commit messages follow the repo style (`feat(ui):`, `refactor(ui):`).

---

## Phase 0 — Foundations (components + skin + harness)

### Task 1: Component-test harness

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Install dev deps**

Run (from repo root):
```bash
npm --workspace apps/desktop install -D @testing-library/react@^16 @testing-library/user-event@^14 jsdom@^25
```
Expected: three packages added under `devDependencies` in `apps/desktop/package.json`; no change to fnm/global Node.

- [ ] **Step 2: Verify the docblock jsdom env works**

Create a throwaway probe `apps/desktop/src/components/__harness_probe.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

describe("harness", () => {
  it("renders into jsdom", () => {
    const { container } = render(<button>hi</button>);
    expect(container.querySelector("button")?.textContent).toBe("hi");
  });
});
```

Run: `npm --workspace apps/desktop run test -- __harness_probe`
Expected: PASS (1 test).

- [ ] **Step 3: Delete the probe and commit**

```bash
rm apps/desktop/src/components/__harness_probe.test.tsx
git add apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "test(ui): add jsdom + testing-library harness for component tests"
```

---

### Task 2: AppInput component

**Files:**
- Create: `apps/desktop/src/components/AppInput.tsx`
- Test: `apps/desktop/src/components/AppInput.test.tsx`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/components/AppInput.test.tsx`:
```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppInput } from "./AppInput";

afterEach(cleanup);

describe("AppInput", () => {
  it("emits each keystroke via onValueChange", async () => {
    const onValueChange = vi.fn();
    render(<AppInput value="" onValueChange={onValueChange} ariaLabel="name" />);
    await userEvent.type(screen.getByLabelText("name"), "ab");
    expect(onValueChange).toHaveBeenCalledTimes(2);
    expect(onValueChange).toHaveBeenLastCalledWith("b"); // controlled value stays "" → last char only
  });

  it("applies the shared skin and modifier classes", () => {
    render(
      <AppInput value="x" onValueChange={() => {}} ariaLabel="f" invalid mono align="center" />,
    );
    const el = screen.getByLabelText("f");
    expect(el.className).toContain("app-input");
    expect(el.className).toContain("app-input--invalid");
    expect(el.className).toContain("app-input--mono");
    expect(el.className).toContain("app-input--center");
  });

  it("forwards onBlur and onKeyDown to the input", async () => {
    const onBlur = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <AppInput value="x" onValueChange={() => {}} ariaLabel="f" onBlur={onBlur} onKeyDown={onKeyDown} />,
    );
    const el = screen.getByLabelText("f");
    el.focus();
    await userEvent.keyboard("{Enter}");
    expect(onKeyDown).toHaveBeenCalled();
    el.blur();
    expect(onBlur).toHaveBeenCalled();
  });

  it("clearable search shows a clear button only when non-empty and clears to ''", async () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <AppInput type="search" clearable value="" onValueChange={onValueChange} ariaLabel="s" />,
    );
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
    rerender(<AppInput type="search" clearable value="hi" onValueChange={onValueChange} ariaLabel="s" />);
    await userEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onValueChange).toHaveBeenLastCalledWith("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace apps/desktop run test -- AppInput`
Expected: FAIL — "Cannot find module './AppInput'".

- [ ] **Step 3: Implement AppInput**

`apps/desktop/src/components/AppInput.tsx`:
```tsx
import { forwardRef } from "react";
import { Input } from "@base-ui/react/input";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type NativeInputProps = Omit<
  React.ComponentProps<"input">,
  "value" | "onChange" | "type" | "ref" | "className"
>;

export interface AppInputProps extends NativeInputProps {
  value: string;
  onValueChange: (value: string) => void;
  /// Defaults to "text". "search" pairs with `clearable`.
  type?: "text" | "password" | "search";
  invalid?: boolean;
  mono?: boolean;
  align?: "left" | "center";
  /// search only: render a ✕ that clears to "" when the value is non-empty.
  clearable?: boolean;
  ariaLabel?: string;
  className?: string;
}

/// The one text-like input for every WeftCut form. Replaces bare
/// `<input type="text|password|search">`: one `.app-input` skin (focus ring,
/// invalid/mono/center modifiers) instead of ~8 per-scope CSS rules. Spreads
/// remaining native input props (placeholder, maxLength, onBlur, onKeyDown,
/// id, spellCheck…) so it is a drop-in for the rename/search/timecode sites.
export const AppInput = forwardRef<HTMLInputElement, AppInputProps>(
  function AppInput(
    { value, onValueChange, type = "text", invalid, mono, align, clearable, ariaLabel, className, ...rest },
    ref,
  ) {
    const control = (
      <Input
        ref={ref}
        type={type}
        value={value}
        aria-label={ariaLabel}
        onValueChange={(next) => onValueChange(next)}
        className={cn(
          "app-input",
          invalid && "app-input--invalid",
          mono && "app-input--mono",
          align === "center" && "app-input--center",
          clearable && "app-input--clearable",
          className,
        )}
        {...rest}
      />
    );
    if (!clearable) return control;
    return (
      <span className="app-input-wrap">
        {control}
        {value !== "" ? (
          <button
            type="button"
            className="app-input-clear"
            aria-label="Clear"
            onClick={() => onValueChange("")}
          >
            <XIcon size={12} />
          </button>
        ) : null}
      </span>
    );
  },
);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace apps/desktop run test -- AppInput`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/AppInput.tsx apps/desktop/src/components/AppInput.test.tsx
git commit -m "feat(ui): add AppInput wrapper (text/password/search + clearable)"
```

---

### Task 3: AppNumberField component

**Files:**
- Create: `apps/desktop/src/components/AppNumberField.tsx`
- Test: `apps/desktop/src/components/AppNumberField.test.tsx`

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/components/AppNumberField.test.tsx`:
```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppNumberField } from "./AppNumberField";

afterEach(cleanup);

describe("AppNumberField", () => {
  it("emits live numeric changes via onValueChange", async () => {
    const onValueChange = vi.fn();
    render(<AppNumberField value={0} onValueChange={onValueChange} ariaLabel="x" />);
    await userEvent.type(screen.getByLabelText("x"), "5");
    expect(onValueChange).toHaveBeenLastCalledWith(5);
  });

  it("fires onCommit on blur, not on every keystroke", async () => {
    const onCommit = vi.fn();
    render(<AppNumberField value={0} onValueChange={() => {}} onCommit={onCommit} ariaLabel="x" />);
    const el = screen.getByLabelText("x");
    await userEvent.type(el, "12");
    expect(onCommit).not.toHaveBeenCalled();
    el.blur();
    expect(onCommit).toHaveBeenCalledWith(12);
  });

  it("does not emit null onValueChange when the field is cleared", async () => {
    const onValueChange = vi.fn();
    render(<AppNumberField value={3} onValueChange={onValueChange} ariaLabel="x" />);
    await userEvent.clear(screen.getByLabelText("x"));
    expect(onValueChange).not.toHaveBeenCalledWith(null);
  });

  it("disables the input", () => {
    render(<AppNumberField value={1} onValueChange={() => {}} disabled ariaLabel="x" />);
    expect((screen.getByLabelText("x") as HTMLInputElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace apps/desktop run test -- AppNumberField`
Expected: FAIL — "Cannot find module './AppNumberField'".

- [ ] **Step 3: Implement AppNumberField**

`apps/desktop/src/components/AppNumberField.tsx`:
```tsx
import { NumberField } from "@base-ui/react/number-field";
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AppNumberFieldProps {
  value: number;
  /// Live value (every keystroke / scrub tick). Drives the call site's local
  /// state, mirroring the old `parseFloat(e.target.value) || prev` onChange.
  onValueChange: (value: number) => void;
  /// Fires once per edit, on blur / Enter / scrub-end. Maps to the old
  /// commit-on-blur so undo stays one entry per edit. Omit for live-commit
  /// call sites (they use onValueChange only).
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  align?: "left" | "center";
  ariaLabel?: string;
  className?: string;
}

/// The one numeric input for every WeftCut form. Wraps Base UI NumberField:
/// keyboard arrows, drag-scrub (the left grip), and hover-revealed steppers.
/// `value` may go null mid-edit (empty field) — we drop nulls so the call
/// site keeps the last good number, matching the old `|| prev` guard.
export function AppNumberField({
  value,
  onValueChange,
  onCommit,
  min,
  max,
  step,
  disabled,
  align,
  ariaLabel,
  className,
}: AppNumberFieldProps) {
  return (
    <NumberField.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      onValueCommitted={(next) => {
        if (next !== null) onCommit?.(next);
      }}
      className={cn("app-number-field", className)}
    >
      <NumberField.Group className="app-number-group">
        <NumberField.ScrubArea className="app-number-scrub" direction="horizontal">
          <span className="app-number-grip" aria-hidden="true" />
        </NumberField.ScrubArea>
        <NumberField.Input
          aria-label={ariaLabel}
          className={cn("app-input", "app-number-input", align === "center" && "app-input--center")}
        />
        <div className="app-number-steppers" aria-hidden="true">
          <NumberField.Increment className="app-number-step">
            <ChevronUpIcon size={10} />
          </NumberField.Increment>
          <NumberField.Decrement className="app-number-step">
            <ChevronDownIcon size={10} />
          </NumberField.Decrement>
        </div>
      </NumberField.Group>
    </NumberField.Root>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace apps/desktop run test -- AppNumberField`
Expected: PASS (4 tests). (Scrub drag itself is verified later by visual smoke — pointer-lock drag is not reliably testable in jsdom.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/AppNumberField.tsx apps/desktop/src/components/AppNumberField.test.tsx
git commit -m "feat(ui): add AppNumberField wrapper (steppers + drag-scrub)"
```

---

### Task 4: AppColorField component

**Files:**
- Create: `apps/desktop/src/components/AppColorField.tsx`
- Test: `apps/desktop/src/components/AppColorField.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/components/AppColorField.test.tsx`:
```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppColorField } from "./AppColorField";

afterEach(cleanup);

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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace apps/desktop run test -- AppColorField`
Expected: FAIL — "Cannot find module './AppColorField'".

- [ ] **Step 3: Implement AppColorField**

`apps/desktop/src/components/AppColorField.tsx`:
```tsx
import { cn } from "@/lib/utils";

export interface AppColorFieldProps {
  /// Hex string, e.g. "#aabbcc". The native picker edits the RGB triplet only.
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

/// The one color swatch for every WeftCut form. A skinned native
/// `<input type="color">` — keeps the OS picker (no custom popover). Does NOT
/// debounce: callers whose commit triggers an expensive re-render (PropertyPanel
/// CDP re-capture) keep their own debounce, exactly as before.
export function AppColorField({
  value,
  onValueChange,
  disabled,
  ariaLabel,
  className,
}: AppColorFieldProps) {
  return (
    <input
      type="color"
      className={cn("app-color-swatch", className)}
      value={value}
      disabled={disabled ?? false}
      aria-label={ariaLabel}
      onChange={(e) => onValueChange(e.target.value)}
    />
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace apps/desktop run test -- AppColorField`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/AppColorField.tsx apps/desktop/src/components/AppColorField.test.tsx
git commit -m "feat(ui): add AppColorField wrapper (skinned native color swatch)"
```

---

### Task 5: The shared `.app-input` skin

**Files:**
- Modify: `apps/desktop/src/styles.css` (append a new section near the existing `.app-switch`/`.app-select` skins — search for `AppSlider` comment at ~line 220 for the neighborhood)

- [ ] **Step 1: Add the skin CSS**

Append to `apps/desktop/src/styles.css`:
```css
/* ── App input family ───────────────────────────────────────────────
 * One skin for AppInput / AppNumberField / AppColorField, replacing the
 * per-scope input rules (.settings-input, .media-pool-search-input,
 * .prop-field-control input, .motif-picker-field input, .export-*-input,
 * .new-project-row input, .log-search). Per-context width/quirks layer on
 * top via the call site's own class. */
.app-input {
  width: 100%;
  padding: 4px 8px;
  font-size: 12px;
  font-family: inherit;
  color: var(--foreground);
  background: var(--card);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
}
.app-input:focus {
  outline: none;
  border-color: var(--ring);
}
.app-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.app-input--invalid {
  border-color: var(--destructive);
}
.app-input--mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.app-input--center {
  text-align: center;
}

/* Clearable search: ✕ button overlaid on the right. */
.app-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.app-input--clearable {
  padding-right: 24px;
}
.app-input-clear {
  position: absolute;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  color: var(--muted-foreground);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
}
.app-input-clear:hover {
  color: var(--foreground);
}

/* Number field: grip (scrub) on the left, hover-revealed steppers on the
 * right. Steppers are absolutely positioned so they don't change layout
 * width in the narrow property panel. */
.app-number-field {
  width: 100%;
}
.app-number-group {
  position: relative;
  display: flex;
  align-items: center;
}
.app-number-input {
  /* leave room for the grip; steppers overlay so need no reserved width */
  padding-left: 14px;
}
.app-number-input--center {
  text-align: center;
}
.app-number-scrub {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ew-resize;
}
.app-number-grip {
  width: 2px;
  height: 12px;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
}
.app-number-steppers {
  position: absolute;
  right: 2px;
  top: 1px;
  bottom: 1px;
  display: none;
  flex-direction: column;
}
.app-number-group:hover .app-number-steppers {
  display: flex;
}
.app-number-step {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  padding: 0;
  color: var(--muted-foreground);
  background: var(--card);
  border: none;
  cursor: pointer;
}
.app-number-step:hover {
  color: var(--foreground);
}

/* Color swatch. */
.app-color-swatch {
  width: 32px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: pointer;
}
.app-color-swatch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

NOTE: confirm `--muted-foreground` exists in the theme tokens; if not, use `var(--foreground)` with reduced opacity. Search `styles.css`/theme for `--muted-foreground`.

- [ ] **Step 2: Typecheck + build the CSS (no test for raw CSS)**

Run: `npm --workspace apps/desktop run typecheck`
Expected: PASS (CSS isn't typechecked, but this confirms nothing else broke).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/styles.css
git commit -m "feat(ui): add shared .app-input skin for the input family"
```

---

### Task 6: Prove the API end-to-end (one field)

Migrate a single field — PropertyPanel's text **font-size** number input — to validate the components against the real `Field` + commit-on-blur pattern before the bulk migration.

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx:188-198`

- [ ] **Step 1: Add the import**

At the top of `PropertyPanel.tsx`, alongside the existing component imports, add:
```tsx
import { AppNumberField } from "@/components/AppNumberField";
```

- [ ] **Step 2: Replace the font-size input**

`PropertyPanel.tsx:188-198` — replace:
```tsx
      <Field label={t("property_panel.font_size_px")}>
        <input
          type="number"
          value={size}
          step={1}
          min={6}
          max={400}
          onChange={(e) => setSize(parseFloat(e.target.value) || size)}
          onBlur={() => commit({ kind: "Text", font_size_px: size })}
        />
      </Field>
```
with:
```tsx
      <Field label={t("property_panel.font_size_px")}>
        <AppNumberField
          value={size}
          step={1}
          min={6}
          max={400}
          ariaLabel={t("property_panel.font_size_px")}
          onValueChange={setSize}
          onCommit={(v) => commit({ kind: "Text", font_size_px: v })}
        />
      </Field>
```

- [ ] **Step 3: Typecheck**

Run: `npm --workspace apps/desktop run typecheck`
Expected: PASS.

- [ ] **Step 4: Visual + behavior smoke**

Launch the app (`npm run dev` or the Tauri MCP bridge). On a text layer: the font-size field shows the unified skin, accepts typed values, drag-scrub changes the value live, steppers appear on hover, and editing → blur produces exactly **one** undoable commit (Ctrl+Z reverts in one step). Screenshot the property panel.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx
git commit -m "refactor(ui): migrate PropertyPanel font-size to AppNumberField (API proof)"
```

---

## Migration recipe (applies to every field in Phases 1–5)

For each raw `<input>`, apply the transform for its `type`, **preserving that field's existing attributes and handlers** (min/max/step, placeholder, maxLength, ref, onKeyDown, disabled, the exact commit call):

**`type="number"` → `AppNumberField`:**
```tsx
// before
<input type="number" value={v} min={a} max={b} step={s}
  onChange={(e) => setV(parseFloat(e.target.value) || v)}
  onBlur={() => commit(v)} />
// after
<AppNumberField value={v} min={a} max={b} step={s} ariaLabel={label}
  onValueChange={setV} onCommit={() => commit(/* read latest via onCommit arg */)} />
// If the old onBlur committed local state `v`, switch to the committed value:
//   onCommit={(next) => commit(next)}  and drop the separate setV-then-commit dance.
```

**`type="text" | "password"` → `AppInput`:**
```tsx
// before
<input type="text" className="X" value={v} onChange={(e) => setV(e.target.value)}
  onBlur={onBlur} onKeyDown={onKeyDown} ref={r} />
// after
<AppInput value={v} onValueChange={setV} onBlur={onBlur} onKeyDown={onKeyDown} ref={r}
  ariaLabel={label} /* + mono / align="center" / invalid={...} as the old CSS implied */ />
```
Map the old per-scope class to modifiers: monospace font → `mono`; `text-align:center` → `align="center"`; `.is-invalid` toggle → `invalid={…}`. Keep any width-only class (e.g. `settings-input-narrow`) via `className`.

**`type="search"` → `AppInput type="search" clearable`:** replace the input **and** the adjacent manual clear `<button>` (the component renders the ✕). Keep the Esc-to-clear `onKeyDown` if present.

**`type="color"` → `AppColorField`:** keep the caller's debounced commit on `onValueChange`.

Each phase ends by **deleting the now-dead per-scope CSS** for that file and running typecheck + a visual/behavior smoke (edit → commit → **undo**) on the affected panel.

---

## Phase 1 — PropertyPanel

**Files:** Modify `apps/desktop/src/properties/PropertyPanel.tsx`; delete CSS at `apps/desktop/src/styles.css:2166-2193` (`.prop-field-control input[...]`, keep `.prop-field-control` layout rule itself).

Remaining raw inputs after Task 6 (line numbers from current `main`; re-grep `<input` in the file before editing as line numbers shift):
- **number:** 212, 220, 298, 307, 316, 324, 332, 436, 444, 557, 565, 573, 582, 1025, 1065, 1074, 1100
- **text:** 343, 358, 452, 467, 995
- **color:** 201, 951, 964, 1056
- **textarea:** (the one `<textarea>` — give it `className="app-input"`, no new component)

- [ ] **Step 1: Add imports**

Ensure these are imported (AppNumberField added in Task 6):
```tsx
import { AppInput } from "@/components/AppInput";
import { AppColorField } from "@/components/AppColorField";
```

- [ ] **Step 2: Migrate all number fields**

Apply the `type="number"` recipe to each numeric input listed above. For the transform/dimension fields (x/y/scale/rotation) the old pattern is `onChange={setX}` + `onBlur={() => commit(...)}` — convert to `onValueChange={setX}` + `onCommit={(v) => commit({ ...v })}`. Preserve each field's min/max/step.

- [ ] **Step 3: Migrate all text fields + textarea**

Apply the `type="text"` recipe (343, 358, 452, 467, 995). The textarea keeps `<textarea className="app-input" .../>` (the skin styles textarea too — verify the selector or add `textarea.app-input` if needed).

- [ ] **Step 4: Migrate all color fields**

Apply the `type="color"` recipe (201, 951, 964, 1056). Keep `debouncedCommit` / `onCommit` as the `onValueChange` target. Preserve the `toRgb`/7-char slice logic in `ColorPropField`.

- [ ] **Step 5: Delete dead CSS**

Remove `.prop-field-control input[type="text"]`, `input[type="number"]`, `input[type="color"]` rules (`styles.css:2166-2193`). Keep the `.prop-field-control` flex container rule and `textarea` if still referenced.

- [ ] **Step 6: Typecheck**

Run: `npm --workspace apps/desktop run typecheck`
Expected: PASS.

- [ ] **Step 7: Visual + behavior smoke**

On text/video/image/shape/motif layers: every field renders the unified skin; numbers scrub + commit-once-on-blur; colors live-update with debounced commit; undo is one step per edit. Screenshot.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx apps/desktop/src/styles.css
git commit -m "refactor(ui): migrate PropertyPanel inputs to App input family"
```

---

## Phase 2 — SettingsPanel

**Files:** Modify `apps/desktop/src/settings/SettingsPanel.tsx`; delete/trim CSS `.settings-input*` at `styles.css:2491-2519` (keep `.settings-input-narrow` width as a layered class, drop the base skin rules now in `.app-input`).

Inputs: number 234 (`settings-input settings-input-narrow`, mono+center, min/max, onChange+onBlur commit+onKeyDown); text 447 (`composition-duration`, mono+center, `.is-invalid` via `localError`); password 584 (API key, mono).

- [ ] **Step 1: Add imports**

```tsx
import { AppInput } from "@/components/AppInput";
import { AppNumberField } from "@/components/AppNumberField";
```

- [ ] **Step 2: Migrate the number field (234)**

```tsx
<AppNumberField
  value={draftStrengthPx}
  min={TAIL_SNAP_MIN_PX}
  max={TAIL_SNAP_MAX_PX}
  disabled={!enabled}
  align="center"
  className="settings-input-narrow"
  ariaLabel={t("settings.tail_snap_strength")}
  onValueChange={setDraftStrengthPx}
  onCommit={(v) => void commitStrength(v)}
/>
```
(Replaces both the `onChange` and `onBlur`/`onKeyDown` commit dance.)

- [ ] **Step 3: Migrate composition-duration text (447)**

```tsx
<AppInput
  id="composition-duration"
  value={draft ?? displayValue}
  disabled={disabled || !pinned}
  spellCheck={false}
  mono
  align="center"
  invalid={!!localError}
  className="settings-input"
  ariaLabel={t("settings.composition_duration_label")}
  onValueChange={(v) => { setDraft(v); setLocalError(validateDraft(v)); }}
  /* keep the existing onBlur/onKeyDown commit handlers */
/>
```

- [ ] **Step 4: Migrate the API-key password (584)**

Apply the `type="password"` recipe with `mono`. Keep its existing handlers.

- [ ] **Step 5: Trim dead CSS**

In `styles.css:2491-2519` delete `.settings-input` base/focus/disabled/`.is-invalid` rules (now in `.app-input*`); keep `.settings-input` as a width-only rule (`width: 132px`) and `.settings-input-narrow` (`width: 64px`).

- [ ] **Step 6: Typecheck + smoke + commit**

Run: `npm --workspace apps/desktop run typecheck` → PASS. Visual smoke on Settings (number/text/password, invalid-state border on bad duration). Commit:
```bash
git add apps/desktop/src/settings/SettingsPanel.tsx apps/desktop/src/styles.css
git commit -m "refactor(ui): migrate SettingsPanel inputs to App input family"
```

---

## Phase 3 — ExportSettingsDialog

**Files:** Modify `apps/desktop/src/panels/ExportSettingsDialog.tsx`; delete CSS `.export-path-input` (~`styles.css:3578`) and `.export-filename-input` (~3590).

Inputs: text 225, 243, 321, 345 (path/filename rows — **check `readOnly`**: path fields may be display-only with a Browse button; preserve `readOnly` via passthrough); number 490.

- [ ] **Step 1: Add imports** (`AppInput`, `AppNumberField`).
- [ ] **Step 2: Migrate text inputs (225, 243, 321, 345)** with the text recipe; preserve `readOnly`/placeholder. Keep `className` mapping to width as needed.
- [ ] **Step 3: Migrate number input (490)** with the number recipe; preserve min/max/step + commit handler.
- [ ] **Step 4: Delete `.export-path-input` / `.export-filename-input`** rules, re-add any width as a layered class if the layout needs it.
- [ ] **Step 5: Typecheck + smoke + commit**

Run typecheck → PASS. Smoke: open Export Settings, fields render unified, filename/number editing works, size-estimate still updates. Commit:
```bash
git add apps/desktop/src/panels/ExportSettingsDialog.tsx apps/desktop/src/styles.css
git commit -m "refactor(ui): migrate ExportSettingsDialog inputs to App input family"
```

---

## Phase 4 — MotifPicker

**Files:** Modify `apps/desktop/src/motifs/MotifPicker.tsx`; delete CSS `.motif-picker-field input[...]` (~`styles.css:2835-2854`) and `.motif-preview-fps input[type='number']` (~2731) and `.motif-picker-color input[type='color']`.

Inputs: text 175, 400, 612; number 634; color 652/663/669 (swatch + 6-char hex helper). The color block composes swatch + hex text — use `AppColorField` for the swatch and `AppInput` for the hex text box.

- [ ] **Step 1: Add imports** (`AppInput`, `AppNumberField`, `AppColorField`).
- [ ] **Step 2: Migrate text inputs (175, 400, 612).** Preserve the `type="submit"` sibling buttons and form submit (175 sits in a search/create form — keep its `onKeyDown`/form behavior).
- [ ] **Step 3: Migrate the number input (634).** Preserve min/max/step (the fps field is narrow, value 1–60).
- [ ] **Step 4: Migrate the color block (652–669)** to `AppColorField` (swatch) + `AppInput` (hex text). Preserve the 6-char hex display logic.
- [ ] **Step 5: Delete dead CSS** for the three motif input scopes.
- [ ] **Step 6: Typecheck + smoke + commit**

Run typecheck → PASS. Smoke: motif search/create, fps number, color swatch+hex in the draft editor. Commit:
```bash
git add apps/desktop/src/motifs/MotifPicker.tsx apps/desktop/src/styles.css
git commit -m "refactor(ui): migrate MotifPicker inputs to App input family"
```

---

## Phase 5 — Remainder (App.tsx, LayerBlock, StartupScreen, LogConsole)

**Files:** Modify `apps/desktop/src/App.tsx`, `apps/desktop/src/timeline/LayerBlock.tsx`, `apps/desktop/src/startup/StartupScreen.tsx`, `apps/desktop/src/logs/LogConsole.tsx`; delete CSS `.preview-timecode` (~`styles.css:1234`), `.media-pool-search-input` (~1677), `.new-project-row input` (~3241), `.log-search`.

- [ ] **Step 1: App.tsx preview-timecode (1770)** → `AppInput` with `mono`, `ref={timecodeInputRef}` (forwardRef), keep `onKeyDown` (Enter/Esc) + `onBlur={commitTimecode}`. `className="preview-timecode"` for any width/position not in the skin.

- [ ] **Step 2: App.tsx media-pool search (2362)** → `AppInput type="search" clearable`, keep `onKeyDown` (Esc clears). **Delete the manual clear `<button>` at 2376-2381** (the component renders ✕). Map `.media-pool-search-input` width to `className`.

- [ ] **Step 3: LayerBlock rename (375)** → `AppInput` with `ref={inputRef}`, keep all stopPropagation handlers (`onClick`/`onPointerDown`/`onDoubleClick`) + `onKeyDown` + `onBlur={commitRename}` via passthrough. The inline Tailwind classes move to `className` (the skin supplies bg/border/radius; keep `sticky z-[2] w-40 max-w-full` + the `left` style).

- [ ] **Step 4: StartupScreen new-project (404)** → `AppInput`, preserve validation/placeholder; map `.new-project-row input` width via `className`.

- [ ] **Step 5: LogConsole search (329)** → `AppInput type="search" clearable`, keep `ref={searchRef}` + `onKeyDown`. Map `.log-search` to `className` if width-specific.

- [ ] **Step 6: Delete the dead CSS scopes** listed above.

- [ ] **Step 7: Typecheck**

Run: `npm --workspace apps/desktop run typecheck`
Expected: PASS.

- [ ] **Step 8: Visual + behavior smoke**

Timecode edit (Enter commits, Esc cancels, autofocus); media-pool + log search clear button works and Esc clears; layer rename (double-click → edit → Enter/Esc/blur, no event leakage to the timeline); new-project name. Screenshot each. Commit:
```bash
git add apps/desktop/src/App.tsx apps/desktop/src/timeline/LayerBlock.tsx apps/desktop/src/startup/StartupScreen.tsx apps/desktop/src/logs/LogConsole.tsx apps/desktop/src/styles.css
git commit -m "refactor(ui): migrate remaining inputs (timecode/search/rename) to App input family"
```

---

## Final verification

- [ ] **No raw form inputs remain** (except inside the three wrappers):

Run (Grep): search `apps/desktop/src` for `<input` excluding `components/AppInput.tsx`, `components/AppColorField.tsx`, `components/AppSwitch.tsx`, `components/AppSlider.tsx`. Expected: zero `type="text|number|color|search|password"` hits outside the wrappers. Remaining allowed: `type="range"` (AppSlider), `type="checkbox"` (AppSwitch).

- [ ] **Full test + typecheck:**

Run: `npm --workspace apps/desktop run test` → all PASS. `npm --workspace apps/desktop run typecheck` → PASS.

- [ ] **Dead CSS swept:** grep `styles.css` for the deleted scope names — none should remain except width-only layered classes intentionally kept.

---

## Self-review notes

- **Spec coverage:** AppInput (text/password/search+clearable), AppNumberField (steppers+scrub, onCommit-on-blur), AppColorField (no internal debounce) — all in Tasks 2–4. Unified `.app-input` skin — Task 5. Full phased migration of all 12 files — Phases 1–5. Behavior-preservation contract — locked by Tasks 2–4 tests + per-phase undo smoke.
- **Steppers hidden-by-default / scrub-on:** Task 3 component + Task 5 CSS (`.app-number-steppers { display:none }` + `:hover` reveal; `.app-number-scrub` grip).
- **Textarea:** folded into `.app-input` (Phase 1 Step 3), no `AppTextarea` — per the brainstorming decision.
- **Risk:** the `onChange+onBlur` → `onValueChange+onCommit` rewrite is where commit-timing/undo regressions hide; every phase's smoke explicitly checks edit→commit→**undo**.
- **Line numbers** in Phases 1–5 are from current `main` and **will drift** as edits land — re-grep `<input` per file before editing.
