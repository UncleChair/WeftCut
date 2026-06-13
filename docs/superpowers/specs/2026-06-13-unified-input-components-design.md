# Unified input components — design

## Problem

WeftCut already has a clean `App*`-wrapper convention over Base UI primitives,
each backed by one shared CSS skin: `AppSwitch`, `AppSelect`, `AppSlider`,
`AppDialog` (plus `ui/button`, `ui/dialog`). **Input fields were never given
this treatment.** ~80 raw `<input>` elements are scattered across 12 files
(`type="text" / number / color / search / password`), each restyled locally
with its own CSS scope:

- `.prop-field-control input[type=…]` (PropertyPanel)
- `.settings-input` (+ `-narrow`, `.is-invalid`) (SettingsPanel)
- `.media-pool-search-input` (App.tsx media pool)
- `.motif-picker-field input`, `.motif-picker-color input` (MotifPicker)
- `.export-path-input`, `.export-filename-input` (ExportSettingsDialog)
- `.new-project-row input` (StartupScreen)
- `.log-search` (LogConsole)
- inline rename inputs (App.tsx, Timeline/LayerBlock)

These share the same DNA (card/popover background, border, ~12px, rounded,
`--ring` focus, `--destructive` invalid) but drift on padding, width,
alignment, and font-family. The duplication is the problem; visual
inconsistency is the symptom.

## Goals

1. **Visual consistency** — one input skin, applied everywhere, replacing the
   ~8 duplicated CSS scopes.
2. **Enhanced number editing** — adopt Base UI `NumberField` (steppers +
   drag-scrub) so the property panel's X / Y / scale / rotation behave like a
   real NLE (After Effects / Premiere).
3. **Near drop-in migration** — preserve each call site's value contract,
   commit timing, and undo behavior exactly.

## Non-goals (YAGNI)

- Full Base UI `Field` / `Form` + validation framework (call sites keep their
  existing label/row markup — `Field`, `.settings-row`, etc.).
- Custom color popover (keep the native OS `<input type="color">` picker).
- A dedicated `AppTextarea` — the single real `<textarea>` (PropertyPanel)
  folds into the shared `.app-input` skin.

## Components

Three **control-only** wrappers in `apps/desktop/src/components/`, following
the existing `App*` convention. Each wraps the control element only; the call
site keeps its surrounding label/row markup.

### `AppInput` — text / password / search

Backed by Base UI `Input` (`@base-ui/react/input`). Replaces `type="text"`,
`type="password"`, `type="search"` (~20 sites).

```ts
interface AppInputProps {
  value: string;
  onValueChange: (value: string) => void;
  type?: "text" | "password" | "search"; // default "text"
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  invalid?: boolean;          // → .is-invalid ring
  mono?: boolean;             // → .app-input--mono (API key, paths, timecode)
  align?: "left" | "center";  // default "left"
  clearable?: boolean;        // search: show ✕ when non-empty, clears to ""
  ariaLabel?: string;
  className?: string;
  // passthrough for call-site behavior that must survive migration:
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}
```

The `search` variant with `clearable` is canonicalized by LogConsole's search
box. The ✕ button reuses existing icon-button chrome (lucide `XIcon`).

### `AppNumberField` — numeric

Backed by Base UI `NumberField` (`@base-ui/react/number-field`). Replaces
`type="number"` (~45 sites, the bulk in PropertyPanel).

```ts
interface AppNumberFieldProps {
  value: number;
  /// Live value (every keystroke / scrub tick) — drives local state.
  onValueChange: (value: number) => void;
  /// Fires once per edit, on blur / Enter / scrub-end. Maps to today's
  /// commit-on-blur so undo stays "one entry per edit". Optional: call sites
  /// that already commit on every change just use onValueChange.
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  align?: "left" | "center";
  ariaLabel?: string;
  className?: string;
}
```

Implementation detail: Base UI `NumberField.Root` exposes `value`,
`onValueChange`, and **`onValueCommitted`** (fires later, on blur/scrub-end).
`onValueChange` → `props.onValueChange`; `onValueCommitted` → `props.onCommit`.
`value` may be `null` (empty field) — coerce to the last good value (matching
the current `parseFloat(e.target.value) || prev` guard).

**Steppers hidden by default, scrub always on.** The increment/decrement
buttons are revealed on hover (the property panel is narrow; AE shows no
steppers, just scrub + type). A `ScrubArea` wraps the value so dragging
left/right changes it.

### `AppColorField` — color swatch

A skinned native `<input type="color">`. Replaces `type="color"` (~7 sites).

```ts
interface AppColorFieldProps {
  value: string;          // hex, e.g. "#aabbcc"
  onValueChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}
```

Keeps the OS picker (no custom popover). The wrapper does **not** debounce —
callers keep their existing `debouncedCommit` (PropertyPanel's CDP-recapture
flooding note stays valid). Call sites that pair the swatch with a hex text box
(MotifPicker) compose `AppColorField` + `AppInput` themselves.

## Behavior-preservation contract

This is the migration's real risk surface. Per migrated field:

- **Value shape unchanged** — controlled `value` in, `onValueChange` out;
  same string/number the old `e.target.value` / `parseFloat(...)` produced.
- **Commit timing preserved** — text/number commit on blur today → keep using
  `onBlur` / `onCommit`. Color commits debounced → caller keeps its debounce.
- **Undo granularity preserved** — one undo entry per edit, via `onCommit`.
- **Refs / keydown survive** — inputs with `ref` (rename autofocus, search
  focus) or `onKeyDown` (Enter-to-submit, Esc-to-cancel) pass through.

## CSS plan

One `.app-input` base class in `styles.css`, consolidating the shared DNA:

```css
.app-input {
  background: var(--card);
  border: 1px solid var(--border-soft);
  color: var(--foreground);
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 4px;
  font-family: inherit;
  width: 100%;
}
.app-input:focus { outline: none; border-color: var(--ring); }
.app-input:disabled { opacity: 0.5; cursor: not-allowed; }
.app-input--invalid { border-color: var(--destructive); }
.app-input--mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.app-input--center { text-align: center; }
```

Plus `.app-number-field` (group + scrub-area + hover-reveal steppers) and
`.app-color-swatch`. Per-context width/quirks stay as thin modifier classes
layered on top (e.g. `.settings-input` becomes width-only). As each phase
migrates, the per-scope input rules it replaces are **deleted**.

## Migration — full, phased, reviewable

Each phase is an independent, reviewable commit. Each ends with: `tsc -b`
clean + a visual/behavior smoke on the affected panel (edit → commit → **undo**
still works).

- **Phase 0** — build `AppInput`, `AppNumberField`, `AppColorField` + the
  `.app-input` skin. Migrate one representative field (PropertyPanel font-size
  number) to prove the API end-to-end. No other call-site changes.
- **Phase 1** — PropertyPanel (densest; number-field scrub payoff; ~40 inputs).
- **Phase 2** — SettingsPanel (number/text/password + `is-invalid`).
- **Phase 3** — ExportSettingsDialog (text/number).
- **Phase 4** — MotifPicker (text/number/color, incl. swatch+hex composition).
- **Phase 5** — remainder: StartupScreen/new-project (text), App.tsx rename +
  media-pool search, Timeline/LayerBlock rename, LogConsole search (clearable).

## Testing

- **Per phase:** `tsc -b` typecheck; visual smoke via the Tauri MCP bridge /
  screenshot on the migrated panel; manual edit→commit→undo on the affected
  fields (commit timing + undo granularity are the behaviors most at risk).
- **No new E2E** — this is UI-skin/refactor work; the existing real-WebView2
  export/conformance gates already cover the data paths these fields feed.

## Open questions

None blocking. (Steppers hidden-by-default and textarea-folded-into-skin both
confirmed during brainstorming.)
