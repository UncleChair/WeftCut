# Shared Keyframe Value Field + Timeline Expanded-Row Value Editing

**Date:** 2026-06-16
**Status:** Draft — brainstormed and approved; implementation plan pending.

## Goal

Two intertwined changes:

1. **Add an editable value to the timeline keyframe sub-lanes.** Today the expanded
   sub-lane header (`KeyframeLaneHeaders`) shows, per animated property, only the
   navigator `◄ ◆ ►` and a right-aligned label. There is no way to read or set the
   property's value at the playhead without switching to the inspector. Add a compact
   editable number field — the property's value evaluated at the frame-snapped
   playhead — to the **expanded (focused) row only**. Typing a value (or stepping with
   ↑/↓) creates/updates a keyframe at the playhead, exactly like the inspector. This
   lets the user step between keys with `◄ ►` and retune the value in place.

2. **Consolidate the duplicated "auto-key value field" into one shared component.**
   The inspector (`PropertyPanel`) currently repeats the same value-editing block ~10
   times — each an IIFE that reads the track, computes `displayValue`, wraps an
   `AnimatableField`, and wires an `onCommit` closure that does
   `upsertKeyframe`-or-static. The per-param `step`/`min`/`max` are hardcoded inline at
   each call site. The timeline value field needs the *same* behavior, so rather than
   copy it a third time (and risk drift — a recurring WeftCut hazard, cf. snap-math and
   engine-source twins), extract it into one `KeyframeField` component used by **both**
   the inspector and the timeline, backed by one behavior helper (`autoKeyTrack`) and
   one metadata source (the extended `ParamDescriptor`).

Scope is **purely frontend**. Same `update_layer_param_track` write path, same
`resolveAnimated` evaluation, same pure transforms in `keyframe/edits.ts`. No backend,
IPC, Rust, engine, schema, or export change — therefore **no engine-pair drift risk**.

## Relationship to the keyframe arc

This sits on top of the shipped keyframe stack and the unified input components:

- `2026-06-14-keyframe-authoring-design.md` — the stopwatch (`AnimatableField`,
  `displayValue`) and the `update_layer_param_track` write path the value field reuses.
- `2026-06-14-keyframe-sublanes-design.md` — the `KeyframeLane` /
  `KeyframeLaneHeaders` surface the value field is added to.
- `2026-06-16-keyframe-navigator-design.md` — the `◄ ◆ ►` navigator that already
  resolves the target clip, `tLocalUs`, and the in-span gate; the value field reuses
  `resolveNavLayer` and sits beside it in the expanded row.
- `2026-06-13-unified-input-components-design.md` — `AppNumberField` / `AppSlider`,
  both fully `value`-controlled (the property that makes multi-widget binding sound).

## Decisions (settled during brainstorming)

- **Timeline shows the property's value at the playhead, editable** (not a read-only
  readout, not the playhead's timecode). Editing creates/updates a key at the
  frame-snapped playhead.
- **Expanded-row only.** Collapsed rows (24px) keep their current navigator+label
  layout unchanged; the value field appears only when a property is focused/expanded
  to 72px, where there is vertical room. One property editable at a time.
- **Timeline uses a number field for every param** — including `opacity`/`pan`, which
  are sliders in the inspector. Rationale: the 160px header column is narrow, a number
  field is compact and uniform, and it sidesteps the WebView2 slider quirk (Base UI
  ScrubArea needs Pointer Lock, absent in WebView2 — sliders/scrub only ever drag up).
  The **value representation matches the inspector** (e.g. `opacity` is `0..1` shown as
  `0.75`, not a percentage).
- **Full consolidation (B).** `KeyframeField` replaces *all* animated-param rows in the
  inspector — both the number-field params (x/y/scale/gain) and the slider params
  (opacity/pan). Field order and grouping per kind stay byte-identical (explicit
  per-field placement, not a `.map`, so e.g. VideoClip keeps opacity-first).
- **Multi-widget binding is a first-class design constraint.** `KeyframeField` must
  support an *arbitrary combination* of controls bound to one value (e.g. a slider and
  an editable number field side by side, both editing `opacity`). It is built around
  one shared draft value + one commit, with a configurable `widgets` list — never
  "one param ⇒ one hardcoded control."

## 1. Behavior helper — `keyframe/autoKey.ts` (new, unit-tested)

The single source of the "commit a scalar to an animatable param" rule, today
copy-pasted at every inspector call site:

```ts
// Pure. Keyframed → upsert a key at the playhead-local time; Static → plain write.
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

Pairs with the existing `displayValue(track, tInLayerUs, fallback)` (the read side,
already in `components/AnimatableField.tsx`). `displayValue` stays where it is (or moves
next to `autoKeyTrack`; either is fine — flag for the plan). These two are the only
behavioral truths the value field needs.

## 2. Metadata — extend `ParamDescriptor` (`keyframe/descriptors.ts`)

Pull the per-param presentation/domain constants — today hardcoded inline in
`PropertyPanel` — into the descriptor, so the inspector and timeline share one table:

```ts
type KfWidget = "slider" | "number" | "readout";

interface ParamDescriptor {
  paramKey: string;
  labelKey: string;
  fallback: number;
  // domain (optional; absent ⇒ unbounded / default step 1)
  step?: number;
  min?: number;
  max?: number;
  // default presentation in the inspector, rendered in order, all bound to one value
  widgets?: KfWidget[];
}
```

| param            | step | min | max | widgets               |
|------------------|------|-----|-----|-----------------------|
| `x`, `y`         | 1    | —   | —   | `["number"]`          |
| `scale_x`, `scale_y` | 0.05 | — | — | `["number"]`          |
| `opacity`        | 0.01 | 0   | 1   | `["slider","readout"]`|
| `gain_db`        | 0.5  | −30 | 20  | `["number"]`          |
| `pan`            | 0.05 | −1  | 1   | `["slider"]`          |

`widgets` defaults are exactly today's inspector controls (so the inspector is visually
unchanged). They are extensible with zero component changes: to give `opacity` a slider
*and* an editable number, change its `widgets` to `["slider","number"]` (or add
`"readout"`). The timeline overrides `widgets` per §4.

## 3. Shared component — `components/KeyframeField.tsx` (new)

One component, used by both surfaces. Composes (does not replace) the existing
`AnimatableField` for the stopwatch chrome.

**Props:**

```ts
{
  layerId: string;
  paramKey: string;
  label: string;
  track: AnimTrack<number>;
  fallback: number;
  tInLayerUs: number;        // playhead − layer.t_start (may be <0 / > duration)
  playheadInSpan: boolean;   // gates keyframe creation / disables off-clip
  // commit sink — decouples the component from the transport:
  onCommitTrack: (paramKey: string, next: AnimTrack<number>) => void | Promise<void>;
  // presentation:
  widgets?: KfWidget[];      // overrides desc default (timeline forces ["number"])
  showStopwatch?: boolean;   // inspector: true (default); timeline: false
  compact?: boolean;         // timeline density
  onMutated?: () => Promise<void>; // only needed when showStopwatch (AnimatableField toggle)
}
```

**Internals — the shared-draft binding (this is the extensibility mechanism):**

- Holds one `draft: number | null` state. Idle (`null`) ⇒ widgets display
  `shown = displayValue(track, tInLayerUs, fallback)` (so the value tracks the playhead
  / undo / selection live). During interaction ⇒ widgets display `draft`.
- Every widget's live change calls `setDraft(v)` → **all widgets in the row re-render to
  the same value**, giving live slider↔number sync.
- Commit (number: blur/Enter via `onCommit`; slider: debounced `onValueChange`, the
  existing 250ms `COMMIT_DEBOUNCE_MS`, preserving today's opacity/pan behavior) →
  `onCommitTrack(paramKey, autoKeyTrack(track, tInLayerUs, val))`, then `setDraft(null)`.
- An effect resets `draft = null` when `layerId`/`paramKey` changes (selection switch),
  so a new selection doesn't show the previous field's stale draft.

**Rendering:**

- `widgets` rendered in order, each bound to `draft ?? shown` + the shared change/commit
  handlers:
  - `"number"` → `AppNumberField` (`step`/`min`/`max` from the descriptor, `ariaLabel`
    from `label`, commit on blur/Enter).
  - `"slider"` → `AppSlider` (`min`/`max`/`step` from the descriptor, debounced commit).
  - `"readout"` → `<span className="prop-range-value">{(draft ?? shown).toFixed(2)}</span>`
    (today's opacity readout).
- `showStopwatch` ⇒ wrap the widgets in `<AnimatableField …>` (its existing stopwatch
  toggles Static↔Keyframed via its own `updateLayerParamTrack` + `onMutated` path,
  untouched). `showStopwatch === false` ⇒ render the widgets in a compact wrapper with
  no stopwatch; **disable the inputs when `!playheadInSpan`** (can't author off-clip,
  matching the navigator `◆` gate).

`AnimatableField` itself is **unchanged** — `KeyframeField` is the new thing that builds
its `children` and owns the draft.

## 4. Inspector migration — `PropertyPanel.tsx`

Each repeated value-field IIFE (in `TextFields`, `VideoClipFields`,
`ImageOverlayFields`, `MotifFields`, `AudioFields`) collapses to one line, **in the same
position** so field order/grouping is preserved exactly:

```tsx
<KeyframeField
  layerId={layer.id} paramKey={X.paramKey} label={t(X.labelKey)}
  track={readParamTrack(v, X.paramKey) ?? { mode: "Static", value: X.fallback }}
  fallback={X.fallback} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan}
  onCommitTrack={(k, next) => commitTrack(k, next)} onMutated={onMutated}
  // widgets omitted ⇒ uses descriptor default
/>
```

- The `commitTrack` / `debouncedCommitTrack` closures defined per-section today are
  replaced by the component's internal debounce; each section keeps only a single
  `commitTrack(paramKey, next) => updateLayerParamTrack(layer.id, paramKey, next).then(onMutated)`
  passed as `onCommitTrack`.
- The hardcoded `step={0.05}`, `min={-30}`, slider `min/max/step`, and the
  `{shown.toFixed(2)}` readout all move into the descriptor (§2) / component (§3).
- Non-animatable rows (fades, flip, mute, speed, content, font, color, Motif props) are
  **out of scope** — they keep their current `commit → updateLayerParams` path.

This is the bulk of the LOC reduction and the drift fix.

## 5. Timeline integration — `KeyframeLaneHeaders` (`timeline/KeyframeLane.tsx`)

A new small `KeyframeValueField` (timeline) wraps `KeyframeField` for the expanded row:

- Resolve the target clip with the existing `resolveNavLayer(track, paramKey,
  focusedLayerId)` (same rule the navigator uses — focused clip, else sole keyframed
  clip, else none).
- Compute `tLocalUs = snapFrameRound(currentTimeUs − layer.t_start_us, fpsNum, fpsDen)`
  and `inSpan` exactly as `KeyframeNavigator` does.
- Render `<KeyframeField showStopwatch={false} compact widgets={["number"]}
  playheadInSpan={inSpan} onCommitTrack={(k, next) => onCommitParamTrack(layer.id, k,
  next)} … />`. The track is always `Keyframed` here (sub-lanes only exist for
  keyframed params), so `autoKeyTrack` always upserts; off-span ⇒ disabled.

`KeyframeLaneHeaders` already receives `currentTimeUs`, `fpsNum`, `fpsDen`, and
`onCommitParamTrack` (threaded for the navigator) — **no new props from `Timeline.tsx`**.
Render the value field only when `d.paramKey === focusedParamKey` (the row is expanded),
below the existing nav+label line, left-aligned under the nav. Collapsed rows render
nothing new.

Commit = one `onCommitParamTrack` = one `update_layer_param_track` = one undo step
(same guarantee as the navigator `◆`).

## 6. Determinism, migration, docs, i18n

- **Determinism/export:** untouched. Same `update_layer_param_track`, same
  `resolveAnimated`; the value field authors exactly the keys the inspector/diamonds
  already author, via a different gesture. Existing golden vectors and
  `keyframe_authoring.e2e.js` stay the gate.
- **Migration:** none — no stored shape changes.
- **i18n:** no new keys — labels/aria reuse the existing `property_panel.*` keys via
  `labelKey`.
- **Docs:** update the timeline keyframe section (evergreen tone) to mention the
  expanded-row value field, and note `KeyframeField` as the shared inspector/timeline
  value control.

## 7. Testing

- **Pure unit (vitest)** — `autoKey.ts`: Keyframed track upserts a key at `tInLayerUs`;
  a key already at that time is updated in place (not duplicated); Static track returns
  `{mode:"Static"}`. Round-trip against `edits.ts`.
- **Component (RTL)** — `KeyframeField`:
  - widget composition: `["number"]`, `["slider","readout"]`, and the
    multi-widget `["slider","number"]` case — a change on one widget updates the other
    (shared-draft sync);
  - commit payload: `onCommitTrack` receives `autoKeyTrack(...)` output; number commits
    on blur, slider debounced;
  - `showStopwatch={false}` + `!playheadInSpan` ⇒ inputs disabled;
  - idle display follows `shown` (playhead/undo), draft resets on `layerId`/`paramKey`
    change.
- **Inspector regression** — existing `PropertyPanel` tests stay green after migration
  (value display + auto-key commit per param, slider debounce).
- **Timeline (RTL)** — expanded row renders the number field; collapsed row does not;
  editing dispatches `onCommitParamTrack` with an upserted key at the snapped playhead;
  off-span disables the field; ambiguous multi-clip (no `resolveNavLayer` target) hides
  / disables it.
- **Gate:** `npx tsc -b` clean (always, per the keyframe-authoring lesson — vitest
  transpiles without full typecheck) + vitest green.
- **e2e:** optional — the value field re-drives the already-gated
  `update_layer_param_track` path; `keyframe_authoring.e2e.js` remains the e2e gate.

## Out of scope (this round) / future

- **Slider + editable number for `opacity` in the inspector** — the component supports
  it (just flip `opacity.widgets`); not enabled this round to keep the inspector
  visually unchanged. This is the headline extensibility payoff.
- **Non-animatable inspector rows** — fades/flip/mute/speed/content/font/color/Motif
  props keep their `updateLayerParams` path; `KeyframeField` is for animatable scalars.
- **`Animated<Rgba>` color rows** — no f64 sub-lane yet (needs the Rust `Rgba::value_at`
  twin); the value field inherits that gap.
- **Value field in collapsed rows / in-clip `LayerBlock`** — expanded sub-lane only.
- **Per-param display formatting** (units, percentage, dB suffix) — out of scope; the
  field shows raw values matching today's inspector. A `format?` hook on the descriptor
  is a clean future addition.

## Related

- `docs/superpowers/specs/2026-06-14-keyframe-authoring-design.md` — stopwatch,
  `AnimatableField`/`displayValue`, `update_layer_param_track`.
- `docs/superpowers/specs/2026-06-16-keyframe-navigator-design.md` — `resolveNavLayer`,
  `tLocalUs`/in-span gate, the navigator the value field sits beside.
- `docs/superpowers/specs/2026-06-13-unified-input-components-design.md` —
  `AppNumberField` / `AppSlider` (both fully `value`-controlled).
- `docs/data-model.md` — `Animated<T>` / `Keyframe`, frame-snap storage invariant.
