# Effects UI — per-layer effect chain in the inspector

**Date:** 2026-06-21
**Scope:** Small/medium feature. Give the editor a UI to add, remove, enable,
reorder, and edit (incl. keyframe) per-layer effects, reusing the existing
inspector and keyframe machinery. No render-engine, data-model, or undo change.

## Problem

The per-layer effects subsystem (ADR 0027) is complete on the backend and the
render path: Rust owns effect instances (`Layer.effects: Vec<Effect>`, 4
undoable actor commands, 4 MCP tools), the renderer owns the catalog
(`effectRegistry.ts`, one filter — Blur), and effects render on all five
visual sprite kinds in preview and export. But effects are **MCP-only**: there
is no editor UI. ADR 0027 lists "an effects UI (v1 is MCP-only)" as deferred.

The bridging is also only half-built. The *read* side exists — `LayerSummary`
carries `effects: Vec<Effect>` (serialized into the project summary), and the
renderer mirrors it as `EffectView` + `LayerSummary.effects` in
`ipc/index.ts`. The *command* side does not: the four effect commands are
reachable only through actor methods and MCP, not the renderer's
`invoke("<command>", args)` dispatch in `napi_backend.rs`. And the catalog
exposes only `getDescriptor(kind)` — no way to enumerate the available effects
for an "add" picker.

## Goal

A data-driven effects panel in the inspector that works against the registry,
so the catalog growing filter-by-filter is zero UI change. Specifically: list a
layer's effect chain in order; add (from a picker enumerating the catalog),
remove, enable/disable, and reorder effects; and edit each effect's parameters
with the same keyframe-capable field the transform/opacity rows use.

### Non-goals (hard boundary)

- **No new filters.** Blur stays the only catalog entry. Adding a filter is a
  separate registry + parity-gate task (ADR 0027), independent of this UI.
- **No new keyframe backend.** Effect-param keyframing reuses the existing
  recorded `update_layer_param_track` command (see Data flow below).
- **`preview_effects_enabled` stays backend/MCP-only.** Not surfaced in the UI
  in this pass.
- **No drag-to-reorder.** Up/down buttons only.
- **No `ParamValue` / animated-color params.** v1 params stay scalar
  `Animated<f64>`, per ADR 0027.
- Audio layers get no effects section (effects render on visual kinds only).

## Architecture

Five seams, backend → UI:

### 0. Backend — lazy effect-param slot creation

A freshly-added effect has an **empty** params map (`add_effect` creates
`params: {}`, matching the MCP contract). `apply_update_layer_param_track`
resolves the write slot via `resolve_animated_f64_mut_on_layer`, which uses
`BTreeMap::get_mut` — so writing a track to a param that isn't present yet
rejects with `UnknownKeyframeParam`. The param editor must be able to set a
value on a just-added effect, so `apply_update_layer_param_track` gains a
**lazy-insert**: when the slot is absent *and* the key parses as an
`effects[<id>].params[<key>]` path pointing at an existing effect, insert a
placeholder `Animated::Static(0.0)` into that effect's params, then write the
incoming track into it (the placeholder is immediately overwritten). Non-effect
unknown keys (e.g. `"bogus"`) still reject. This also fixes editing an
MCP-added empty-params effect from the UI, and keeps `add_effect` empty +
atomic (one undo step per add).

### 1. Backend command bridge (renderer path)

The actor already has `add_effect` / `update_effect` / `move_effect` /
`remove_effect` and broadcasts `project:changed` on each (the MCP smoke e2e
proves the UI refreshes). Only the renderer-facing command layer is missing.
Mirror the MCP tool bodies (`mcp/tools.rs:1051`) as thin command wrappers:

- `commands/mutations.rs`: `add_effect` / `update_effect` / `move_effect` /
  `remove_effect`. Each parses the UUID(s), calls the actor method with
  `Actor::User`, and maps `CommandError` to `String`. `add_effect` constructs
  `Effect { id: new_id(), kind, enabled: true, params: BTreeMap::new() }` and
  returns the new id as a string; `update_effect` deserializes the patch JSON
  into `EffectPatch`.
- `commands/mod.rs`: `AddEffectArgs { layer_id, kind }`,
  `UpdateEffectArgs { layer_id, effect_id, patch }`,
  `MoveEffectArgs { layer_id, effect_id, new_index }`,
  `RemoveEffectArgs { layer_id, effect_id }`.
- `napi_backend.rs`: four dispatch arms (`"add_effect"`, `"update_effect"`,
  `"move_effect"`, `"remove_effect"`) following the existing
  `update_layer_params` arm shape.

### 2. TS IPC wrappers

In `ipc/index.ts` (read-side types `EffectView` / `LayerSummary.effects`
already exist):

- `addEffect(layerId, kind): Promise<string>` → `invoke("add_effect", …)`
- `updateEffect(layerId, effectId, patch: EffectPatch): Promise<void>`
- `moveEffect(layerId, effectId, newIndex): Promise<void>`
- `removeEffect(layerId, effectId): Promise<void>`

`EffectPatch` (TS) = `{ enabled?: boolean; params?: Record<string,
AnimTrack<number>> }`, mirroring Rust `EffectPatch`. The UI uses only the
`enabled` field through this path; param edits go through the keyframe command
(Data flow below).

### 3. Catalog enumeration

`effectRegistry.ts`:

- `export function listEffects(): EffectDescriptor[]` → `Object.values(REGISTRY)`,
  for the add-picker and the param-row generator.
- Add optional `step?: number` to `EffectParamSpec` (Blur strength → `step: 1`).
  When absent, the param field derives a step from the range width (≤10 wide →
  0.1, else 1), matching `NumberPropField`'s heuristic.

### 4. The UI — `properties/EffectsSection.tsx`

A new module (keeps the 1224-line `PropertyPanel.tsx` from growing; effects is a
self-contained concern with its own enumeration + IPC). `PropertyPanel` renders
`<EffectsSection layer … tInLayerUs playheadInSpan onMutated />` for
Text / VideoClip / ImageOverlay / Color / Motif (not Audio).

Structure:

- **Heading** — `effects.heading`.
- **Chain** — one `EffectRow` per `layer.effects[i]`, in array order:
  - localized name (`effects.<kind>.name`, defaultValue = kind),
  - **enable** `AppSwitch` → `updateEffect(layerId, id, { enabled })`,
  - **▲ / ▼** buttons → `moveEffect(layerId, id, i∓1)`, disabled at the ends,
  - **✕** remove → `removeEffect(layerId, id)`,
  - the param rows (below).
- **Add control** — an `AppSelect` over `listEffects()` (value = kind, label =
  `t(desc.nameI18nKey)`) plus an Add button → `addEffect(layerId, kind)`. One
  entry today; data-driven, so the catalog growing needs no UI change.

All mutations call `onMutated()` after resolving, the standard inspector refresh
path. Reorder is index-based against the current `layer.effects` order.

### 5. Param editing — keyframable, via the shared `KeyframeField`

An `EffectParamField` adapter (sibling of `InspectorAnimField`) maps an
`(effect, paramKey, EffectParamSpec)` triple onto `KeyframeField`:

- `paramKey = effects[${effect.id}].params[${key}]`
- `track = effect.params[key] ?? { mode: "Static", value: spec.default }`
- `fallback = spec.default`, `min`/`max` from `spec.range`, `step` from spec,
  `label = t(effects.<kind>.params.<key>, { defaultValue: key })`,
  `widgets = ["number"]`.
- `onCommitTrack = (k, next) => updateLayerParamTrack(layer.id, k, next)`.

This reuses the exact stopwatch / auto-key behavior of the transform and opacity
rows. A freshly-added effect has empty `params`, so the field shows the registry
default (via the `?? fallback`) and the render `EffectChain` applies the filter
at its construct-time default until the first edit; that first edit's
`updateLayerParamTrack` write lazily creates the param slot (Section 0). All
param edits — scalar and keyframe — go through `updateLayerParamTrack`, which
normalizes keyframes (snap/sort/dedupe); `updateEffect` is used only for the
`enabled` toggle.

## Data flow

- **Structural edits** (add/remove/enable/reorder) → new renderer commands →
  actor → recorded + `project:changed` broadcast → summary re-read → UI
  re-renders from `layer.effects`.
- **Param edits** (incl. keyframes) → existing `update_layer_param_track`
  command with key `effects[<id>].params[<key>]` → `apply_update_layer_param_track`
  → `resolve_animated_f64_mut_on_layer` (already effect-path-aware), with the
  Section 0 lazy-insert for a not-yet-set param → recorded + broadcast. No new
  *command*, only the lazy-insert behavior on the existing one.

Both paths are undoable through the existing actor history; nothing in the UI
manages undo.

## Error handling

- Renderer command wrappers map actor `CommandError` to a string; IPC wrappers
  reject, and `EffectsSection` handlers `.catch` and surface a row-level error
  message (the `settings-error` pattern used by `MotifLifecycleRow`), matching
  the inspector's existing failure style. No optimistic UI — the summary
  re-read is the source of truth.
- Unknown `kind` is impossible from the UI (the picker only offers
  `listEffects()` kinds). The render path already skips + warns on unknown
  kinds, so a kind added by MCP but absent from the catalog renders nothing and
  shows its raw kind string as the row name — acceptable.
- `moveEffect` index is always in range (buttons disabled at the ends); the
  backend rejects out-of-range as a guard.

## Testing

- **Rust:** unit tests for the four `commands/mutations.rs` wrappers (happy path
  round-trips through a real actor + a bad-UUID / bad-patch error case each).
- **TS (vitest):** `EffectsSection` tests — renders the chain from a
  `LayerSummary.effects` fixture; add/remove/enable/reorder invoke the right IPC
  wrapper with the right args; the param row reads `effect.params[key]` and
  writes the nested `effects[<id>].params[<key>]` track. `effectRegistry`
  `listEffects` test.
- **Electron e2e:** extend `e2e/electron/effects-smoke.spec.ts` to drive the
  **UI** rather than MCP — add Blur via the panel, confirm the composite
  changes, edit strength, toggle enable, reorder (needs a 2nd effect; can add a
  second Blur), remove, and undo. Rebuild (`VITE_WEFTCUT_E2E=1 npm run build`)
  before running — the e2e launches the prebuilt bundle, and a stale build
  mimics a code bug.

## Files touched

- `apps/desktop/native/src/state/actor/mutations.rs` (lazy effect-param slot)
- `apps/desktop/native/src/commands/mutations.rs` (+ `mod.rs` Args)
- `apps/desktop/native/src/napi_backend.rs`
- `apps/desktop/src/renderer/ipc/index.ts`
- `apps/desktop/src/renderer/render/effects/effectRegistry.ts`
- `apps/desktop/src/renderer/properties/EffectsSection.tsx` (new) + test
- `apps/desktop/src/renderer/properties/PropertyPanel.tsx` (render the section)
- `apps/desktop/src/renderer/i18n/locales/{en-US,zh-CN}.ts` (i18n keys)
- `apps/desktop/e2e/electron/effects-smoke.spec.ts` (UI-driven case)
