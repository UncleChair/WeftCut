// The single fallback form generator for motif props: one switch on
// `PropSpec.type`, consumed by BOTH the property panel (per-key commits to the
// state actor) and the motif picker (continuous edits into parent-buffered
// form state). The two surfaces keep their distinct commit models — see
// `MotifPropCommit` — but share the type switch, the exhaustiveness guard,
// and the number-step heuristic, so a new PropSpec variant is wired exactly
// once.
import { useEffect, useRef, useState } from "react";
import { AppColorField } from "../components/AppColorField";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import type { PropSpec } from "../render/motifs/catalog";
import { Field } from "./Field";

/// The two commit models the fallback form serves — parameterized, not
/// unified:
/// - `commit`: the property panel. Each gesture becomes one backend command:
///   string/number fire `onCommit` once, on blur/Enter; enum on pick. The
///   color field takes `onCommitDebounced` because `<input type="color">`
///   fires `onChange` continuously while the OS color dialog is dragged, and
///   each commit triggers a CDP re-capture (~80-100ms, serialized) — an
///   undebounced drag floods the capture queue and stutters the preview.
/// - `buffer`: the motif picker. Every change flows into parent-owned form
///   state via `onChange`; nothing reaches the backend until the form submits
///   the whole props object.
export type MotifPropCommit =
  | {
      mode: "commit";
      onCommit: (next: unknown) => void;
      onCommitDebounced: (next: unknown) => void;
    }
  | {
      mode: "buffer";
      onChange: (next: unknown) => void;
    };

/// Cosmetic label for a bare prop key: snake_case → Title Case
/// (`bg_color` → "Bg Color"). Deliberately NOT localized — user/agent motifs
/// carry arbitrary on-disk keys the host cannot enumerate in advance, so
/// there is nothing to register centrally.
export function propKeyLabel(key: string): string {
  return key
    .split("_")
    .map((word) => (word === "" ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
}

/// One editable motif prop, switched on `PropSpec.type`. The commit-model
/// string/number variants delegate to dedicated sub-components so each can
/// hold its local-state hooks at the top of its body (rules-of-hooks; the
/// color variant needs no local state).
/// Props colors are plain hex strings (e.g. `#ff3366`), NOT `Rgba` — handled
/// as strings, not via the panel's `rgbaToHex` / `hexToRgba` helpers.
export function MotifPropField({
  propKey,
  spec,
  value,
  commit,
}: {
  propKey: string;
  spec: PropSpec;
  value: unknown;
  commit: MotifPropCommit;
}) {
  const label = propKeyLabel(propKey);
  switch (spec.type) {
    case "string":
      if (commit.mode === "commit") {
        return (
          <StringPropField label={label} spec={spec} value={value} onCommit={commit.onCommit} />
        );
      }
      return (
        <PickerField label={label}>
          {spec.multiline ? (
            // Multi-line strings (e.g. a text block split on \n) need a
            // textarea; the single-line AppInput can't hold newlines.
            <textarea
              className="app-input"
              rows={3}
              value={typeof value === "string" ? value : ""}
              maxLength={spec.max_length}
              aria-label={label}
              onChange={(e) => commit.onChange(e.target.value)}
            />
          ) : (
            <AppInput
              value={typeof value === "string" ? value : ""}
              maxLength={spec.max_length}
              ariaLabel={label}
              onValueChange={(v) => commit.onChange(v)}
            />
          )}
        </PickerField>
      );
    case "color":
      if (commit.mode === "commit") {
        return (
          <ColorPropField label={label} spec={spec} value={value} onCommit={commit.onCommitDebounced} />
        );
      }
      return (
        <PickerField label={label} bare>
          <ColorInput
            value={typeof value === "string" ? value : spec.default}
            ariaLabel={label}
            onChange={commit.onChange}
          />
        </PickerField>
      );
    case "number":
      if (commit.mode === "commit") {
        return (
          <NumberPropField label={label} spec={spec} value={value} onCommit={commit.onCommit} />
        );
      }
      return (
        <PickerField label={label} bare>
          <AppNumberField
            value={typeof value === "number" ? value : spec.default}
            step={stepFor(spec)}
            ariaLabel={label}
            onValueChange={(v) => commit.onChange(v)}
            {...(spec.min !== undefined ? { min: spec.min } : {})}
            {...(spec.max !== undefined ? { max: spec.max } : {})}
          />
        </PickerField>
      );
    case "enum": {
      // Enum → dropdown. A discrete pick = one re-capture, so both models
      // take it immediately (no debounce even on the panel side).
      const pick = commit.mode === "commit" ? commit.onCommit : commit.onChange;
      const select = (
        <AppSelect
          value={typeof value === "string" ? value : spec.default}
          ariaLabel={label}
          onValueChange={(v) => pick(v)}
          options={spec.options.map((o) => ({ value: o, label: o }))}
        />
      );
      return commit.mode === "commit" ? (
        <Field label={label}>{select}</Field>
      ) : (
        <PickerField label={label}>{select}</PickerField>
      );
    }
    default: {
      // Exhaustiveness: a new PropSpec variant makes this a compile error until
      // MotifPropField renders it.
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}

/// Step heuristic shared by both surfaces: small ranges (≤10 wide, e.g. a
/// 0..4 speed) get a 0.1 step; everything else (percent-style 0..100,
/// unbounded) steps by 1.
function stepFor(spec: Extract<PropSpec, { type: "number" }>): number {
  return spec.max !== undefined && spec.max - (spec.min ?? 0) <= 10 ? 0.1 : 1;
}

/// `<input type="color">` holds a 6-char RGB triplet only — reduce an 8-digit
/// (alpha-bearing) hex value to its leading 7 chars for the swatch.
function toRgb(value: string): string {
  return value.length >= 7 ? value.slice(0, 7) : value;
}

/// Picker-side row chrome. String/enum wrap in a `<label>` so clicking the
/// caption focuses the control; `bare` keeps the color/number rows on a plain
/// `<div>` — their controls carry their own buttons (eyedropper, steppers).
function PickerField({
  label,
  bare,
  children,
}: {
  label: string;
  bare?: boolean;
  children: React.ReactNode;
}) {
  const body = (
    <>
      <span>{label}</span>
      {children}
    </>
  );
  return bare ? (
    <div className="motif-picker-field motif-picker-field--code">{body}</div>
  ) : (
    <label className="motif-picker-field motif-picker-field--code">{body}</label>
  );
}

/// Color input that preserves any trailing alpha bits in the original default
/// even though `<input type="color">` only edits the RGB triplet. This keeps
/// a motif's translucent default (e.g. `#000000cc`) intact unless the user
/// changes the color — at which point alpha is lost. The `<code>` readout
/// shows the full buffered value.
function ColorInput({
  value,
  ariaLabel,
  onChange,
}: {
  value: string;
  ariaLabel: string;
  onChange: (v: string) => void;
}) {
  return (
    <span className="motif-picker-color">
      <AppColorField value={toRgb(value)} ariaLabel={ariaLabel} onValueChange={onChange} />
      <code>{value}</code>
    </span>
  );
}

function ColorPropField({
  label,
  spec,
  value,
  onCommit,
}: {
  label: string;
  spec: Extract<PropSpec, { type: "color" }>;
  value: unknown;
  /// Debounced commit (see MotifPropCommit).
  onCommit: (next: unknown) => void;
}) {
  // Local state drives the swatch so it tracks the drag live; the actual commit
  // (and the CDP re-capture it triggers) is debounced by the caller. `<input
  // type="color">` only edits the 6-char RGB triplet — show the leading 7 chars
  // but commit the raw value it returns. (Trailing alpha in a default like
  // `#000000cc` is dropped on first pick — same tradeoff as the picker.)
  const [color, setColor] = useState(
    () => toRgb(typeof value === "string" ? value : spec.default),
  );
  useEffect(() => {
    setColor(toRgb(typeof value === "string" ? value : spec.default));
  }, [value, spec.default]);
  return (
    <Field label={label}>
      <AppColorField
        value={color}
        ariaLabel={label}
        onValueChange={(v) => {
          setColor(v);
          onCommit(v);
        }}
      />
    </Field>
  );
}

export function StringPropField({
  label,
  spec,
  value,
  onCommit,
}: {
  label: string;
  spec: Extract<PropSpec, { type: "string" }>;
  value: unknown;
  onCommit: (next: unknown) => void;
}) {
  const pristine = typeof value === "string" ? value : spec.default;
  const [text, setText] = useState(pristine);
  useEffect(() => {
    setText(typeof value === "string" ? value : spec.default);
  }, [value, spec.default]);
  // Escape = discard (ADR 0041). Set BEFORE the release blur so the single
  // onBlur commit path stands down — the same shape `AppTimecodeField` uses.
  const cancelling = useRef(false);
  const cancel = () => {
    cancelling.current = true;
    setText(pristine);
  };
  const commitOnBlur = () => {
    if (cancelling.current) {
      cancelling.current = false;
      return;
    }
    onCommit(text);
  };
  return (
    <Field label={label}>
      {spec.multiline ? (
        // Multi-line strings (a text block split on \n) need a textarea. Enter
        // inserts a newline (don't blur-commit on it); commit on blur only.
        <textarea
          className="app-input"
          rows={3}
          value={text}
          aria-label={label}
          maxLength={spec.max_length}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitOnBlur}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            cancel();
          }}
        />
      ) : (
        <AppInput
          value={text}
          ariaLabel={label}
          maxLength={spec.max_length}
          onValueChange={setText}
          onBlur={commitOnBlur}
          onCancel={cancel}
          // Enter = commit safeguard: blur the field so the single onBlur path
          // commits (no separate commit call → no double undo entry).
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      )}
    </Field>
  );
}

export function NumberPropField({
  label,
  spec,
  value,
  onCommit,
}: {
  label: string;
  spec: Extract<PropSpec, { type: "number" }>;
  value: unknown;
  onCommit: (next: unknown) => void;
}) {
  const [num, setNum] = useState<number>(
    typeof value === "number" ? value : spec.default,
  );
  // Don't resync from props while editing — the debounced auto-commit's
  // round-trip would otherwise clobber an in-progress edit (see AppNumberField
  // onFocus/onBlur). Resync resumes once focus leaves.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    setNum(typeof value === "number" ? value : spec.default);
  }, [value, spec.default]);
  return (
    <Field label={label}>
      <AppNumberField
        value={num}
        ariaLabel={label}
        {...(spec.min !== undefined ? { min: spec.min } : {})}
        {...(spec.max !== undefined ? { max: spec.max } : {})}
        step={stepFor(spec)}
        onValueChange={setNum}
        onCommit={(v) => onCommit(v)}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; }}
      />
    </Field>
  );
}
