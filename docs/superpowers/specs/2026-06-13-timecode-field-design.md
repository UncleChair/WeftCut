# AppTimecodeField — segmented timecode input

## Problem

Timecode is edited in three places — the transport bar (seeks the playhead),
the Export dialog's range in/out, and the Motif "insert at" field — each as a
**single free-text `<input>`** the user types a whole `HH:MM:SS:FF` string into.
After the input-unification work these are `AppInput`s, but typing a full
colon-delimited string is error-prone and inconsistent with how pro NLEs edit
timecode. We want one reusable **segmented** control: fixed `:` separators with
numeric-only segments.

## Goal

A single `AppTimecodeField` component, used at all three sites, that edits
`HH:MM:SS:FF` as four numeric segments with static separators — reusing the
existing frame-grid/NDF math so committed values stay frame-aligned.

## Non-goals (YAGNI)

- Cross-segment carry on `↑/↓` (segments clamp independently — explicit decision).
- Drop-frame (`;`) timecode — the app is NDF; `parseTimecode`/`formatTimecode`
  are NDF.
- A standalone duration/`MM:SS` short form — always render four segments.

## Look

One cohesive `.app-input`-skinned container (border, background, radius,
**`:focus-within` ring**) holding four borderless, transparent numeric segments
separated by static, unselectable `:` glyphs. Reads as a single field, not four
boxes. Width is content-sized (~`HH:MM:SS:FF`).

## API

```ts
interface AppTimecodeFieldProps {
  valueUs: number;                  // microseconds (matches every call site)
  fpsNum: number;
  fpsDen: number;
  onCommit: (us: number) => void;   // blur / Enter — frame-aligned via parseTimecode
  onChange?: (us: number) => void;  // optional live value, each valid edit
  onCancel?: () => void;            // Esc (transport abort); optional
  disabled?: boolean;
  autoFocus?: boolean;              // focus the HH segment on mount
  ariaLabel?: string;               // label for the group
  className?: string;
}
```

## Behavior

- **Segments & ranges:** `HH` 0–99, `MM` 0–59, `SS` 0–59, `FF` 0…`framesPerSec−1`
  where `framesPerSec = max(1, round(fpsNum/fpsDen))`. Numeric-only (non-digits
  rejected), max two chars, zero-padded on display.
- **Navigation:** typing the second digit auto-advances to the next segment;
  `←` / `→`, `Tab`, and pressing `:` move between segments; `Backspace` on an
  empty segment moves to the previous one.
- **`↑` / `↓`:** increment/decrement the focused segment, **clamped** to its
  `[0, max]` (no carry).
- **Commit:** segment text is local editing state. When focus leaves the whole
  control (container `blur` whose `relatedTarget` is outside) or on `Enter`:
  clamp every segment, assemble `"HH:MM:SS:FF"`, run `parseTimecode(str, fpsNum,
  fpsDen)`, and call `onCommit(us)`. The result is frame-aligned because
  `parseTimecode` quantises to the frame grid.
- **`Esc`:** revert segments to `formatTimecode(valueUs, …)` and call `onCancel`.
- **External value sync:** re-derive segments from `valueUs` only while the
  control is **not focused** — so a prop change (e.g. the playhead advancing)
  never clobbers an in-progress edit.

## Internals & reuse

Derives segments by splitting `formatTimecode(valueUs, fpsNum, fpsDen)` on `:`,
and reassembles through `parseTimecode(...)`. **No new timecode math** — same
NDF/frame-grid behavior as today. Four input refs drive focus
management. One focused file: `apps/desktop/src/components/AppTimecodeField.tsx`.

## Call-site integration

- **Transport** (`App.tsx`): keep the read-only `span.preview-timecode` +
  click-to-edit toggle; in edit mode render `AppTimecodeField` (`autoFocus`,
  `onCommit` → seek, `onCancel` → exit edit) in place of the current single
  input. Removes the hand-rolled `parseTimecode` in `commitTimecode` (the field
  hands back `us`).
- **Export** (`ExportSettingsDialog`): replace the in/out `AppInput`s with
  `AppTimecodeField` (`onCommit` → `setRangeStartUs` / `setRangeEndUs`).
- **Motif** (`MotifPicker`): replace the insert-at `AppInput` with
  `AppTimecodeField` (`onCommit` → set insert-at). The old onBlur reformat is
  no longer needed (the field always shows canonical segments).

## Testing

jsdom component tests (no pointer-lock dependency):
- digit entry + auto-advance between segments;
- per-segment clamp on blur, incl. fps-dependent `FF` max (e.g. 30 fps → `FF`
  clamps at 29; type 45 → 29);
- `↑/↓` clamp at boundaries;
- `valueUs → segments` round-trip via formatTimecode;
- assemble → `onCommit(us)` returns a frame-aligned microsecond value;
- `Esc` reverts and calls `onCancel`.

CSS-only bits (focus-within ring, separator styling) verified by `vite build` +
the eventual visual pass.

## Open questions

None — scope (all three sites), clamp-only overflow, and the cohesive single-box
look were settled during brainstorming.
