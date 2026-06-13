# Timeline-owned envelope editing — design

## Goal

Move layer **envelope** editing (identity + timing + per-layer visibility) out of
the right-side `PropertyPanel` and onto the timeline, where direct manipulation
already lives. After this change the inspector holds **only** per-kind parameters;
the timeline owns the envelope.

Concretely:

1. Remove the `EnvelopeFields` section from `PropertyPanel` entirely (`label`,
   `enabled`, `t_start_us`, `t_end_us`).
2. Add **inline rename** of a layer's `label` on its timeline block (double-click)
   plus a **Rename** item in the layer context menu (same editor).
3. Add a per-layer **Enable / Disable** toggle to the layer context menu
   (`updateLayer({enabled})`). This is distinct from the per-track eye icon in
   `TrackHeader`, which stays as-is.
4. Timing (`t_start_us` / `t_end_us`) keeps only its existing drag-to-resize +
   frame-snap path. Typed precise-timecode entry is intentionally dropped.

## Conceptual boundary (the payoff)

> **Timeline = envelope** (identity, timing, visibility).
> **Inspector = per-kind params** (text/video/audio/color/motif fields).

`EnvelopeFields` was exactly `{label, enabled, t_start_us, t_end_us}`, so removing
timing + enabled and relocating `label` deletes the whole section and its `<hr/>`
divider — the panel collapses to a clean kind-params-only surface.

## Current state (verified)

- **Panel envelope:** `apps/desktop/src/properties/PropertyPanel.tsx`
  - `EnvelopeFields` fn (lines 100–197); rendered at line 81 with `<hr/>` at 82.
  - Commits via `updateLayer(layer.id, patch)` (line 129). `KindFields` uses
    `updateLayerParams` instead, so `updateLayer` becomes an unused import here
    after removal.
- **Timeline block:** `apps/desktop/src/timeline/LayerBlock.tsx`
  - Label rendered read-only as `<span>` (lines 340–342); `label = layer.label ?? kindLabel`.
  - Handlers: `onClick` (315) select, `onPointerDown` (328 → `onLayerPointerDown`)
    drag/trim, `onContextMenu` (331 → Timeline `onContextMenu`). **No** double-click.
  - Disabled layers already dim to `opacity: 0.45` (line 308).
- **Context menu:** `apps/desktop/src/timeline/LayerContextMenu.tsx`
  - Audio → "Separate audio to new track"; Motif → "Pre-bake now"; every other
    kind → a disabled `(no actions for this layer)` placeholder (lines 67–89).
- **Context-menu plumbing:** `apps/desktop/src/timeline/Timeline.tsx`
  - `contextMenu` state `{x, y, layerId, layerKind}` (lines 135–140); opened by
    `onContextMenu(e, layerId, layerKind)` (359–369); rendered at 565–575.
- **Track eye (unchanged):** `apps/desktop/src/timeline/TrackHeader.tsx` lines 72–81,
  per-track `updateTrackFlags`. Independent of per-layer `enabled`.
- **IPC:** `apps/desktop/src/ipc/index.ts` — `updateLayer(layerId, patch)` (line 789);
  `LayerPatch = {label?, t_start_us?, t_end_us?, enabled?, locked?}` (280–286).
- **i18n:** `apps/desktop/src/i18n/locales/en-US.ts` + `zh-CN.ts`.

## Design

### A. Remove `EnvelopeFields` from the panel

- Delete the `EnvelopeFields` function and its `<EnvelopeFields .../>` render call
  plus the following `<hr/>`. Keep the `<h2>` heading and `KindFields`.
- Remove the now-unused `updateLayer` import (verify with typecheck; `formatTimecode`/
  `parseTimecode`/`AppSwitch`/`Field` stay — used by kind fields).
- The i18n keys `property_panel.{envelope,label,enabled,t_start,t_end,t_start_hint,
  t_end_hint}` become unused. Pruning them is optional cleanup, not required.

### B. Inline rename on the timeline block

State is **lifted to `Timeline`** so the context-menu "Rename" item can drive the
correct block:

- New `Timeline` state: `editingLayerId: string | null`.
- `LayerBlock` gains props: `isEditing: boolean` (`editingLayerId === layer.id`),
  `onStartEditing(layerId)`, `onStopEditing()`, and a commit path
  `onCommitLabel(layerId, label: string | null)` that calls
  `updateLayer(layerId, {label})` + `onMutated()` (centralised in Timeline).
- **Trigger:** `onDoubleClick` on the block sets editing (guard: ignore when
  `layer.locked || trackLocked || bladeMode`; `stopPropagation`). The first click
  of a double-click starts a zero-delta "move" drag, which is already a no-op
  (nothing commits without movement), so timing is unaffected.
- **Editing UI:** when `isEditing`, replace the label `<span>` with an autofocused,
  select-all `<input>` that `stopPropagation`s pointer/click events so typing
  doesn't re-trigger select/drag.
  - **Enter** or **blur** → commit: empty string → `onCommitLabel(id, null)` (reverts
    to `kindLabel` fallback); otherwise `onCommitLabel(id, value)`. Then `onStopEditing()`.
  - **Escape** → `onStopEditing()` with no commit.

### C. Context menu: Rename + Enable/Disable for every layer

Rework `LayerContextMenu` so **all** kinds get common actions first, then
kind-specific ones; drop the `(no actions...)` placeholder:

1. **Rename** → `onRename(layerId)` → Timeline sets `editingLayerId = layerId`.
2. **Enable layer / Disable layer** (single item, label driven by current
   `enabled`) → `onToggleEnabled(layerId, !enabled)` → `updateLayer` + `onMutated`.
3. separator, then existing: Audio → Separate audio; Motif → Pre-bake now.

Plumbing:

- Extend `contextMenu` state + `onContextMenu` to carry `layerEnabled: boolean`
  (read from `layer.enabled` at right-click time in `LayerBlock`).
- `LayerContextMenu` gains props `layerEnabled`, `onRename`, `onToggleEnabled`.
- `Timeline` provides `onRename` (sets `editingLayerId`) and `onToggleEnabled`
  (`updateLayer(id, {enabled}) → onMutated`). Confirm/add `updateLayer` import in
  `Timeline.tsx`.

### D. i18n

Add to both `en-US.ts` and `zh-CN.ts` under `timeline`:

- `rename` — "Rename" / "重命名"
- `enable_layer` — "Enable layer" / "启用图层"
- `disable_layer` — "Disable layer" / "禁用图层"

`timeline.no_actions_here` is no longer referenced (leave or remove).

## Out of scope (YAGNI)

- Typed precise-timecode entry anywhere (drag + frame-snap is the only timing path).
- Per-layer eye icon directly on the block (context-menu toggle is enough; revisit
  only if discoverability proves poor).
- Track renaming (no UI exists today; not part of this change).
- Pruning unused `property_panel.*` i18n keys (optional).

## Verification

1. `tsc -b` clean (catches the dropped `updateLayer` import + new props).
2. Live in real WebView2 (MCP bridge / `webview_execute_js`):
   - Panel shows no envelope fields; kind params still edit and commit.
   - Double-click a block → rename input; Enter commits (block + reselect shows new
     label), Esc cancels, empty reverts to kind label.
   - Right-click any layer → Rename (enters edit on that block) + Enable/Disable
     (toggles `layer.enabled`; block dims/undims; track eye unaffected).
   - Drag block edges still changes start/end with frame snapping.
