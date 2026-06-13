# Timeline-owned Envelope Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move layer envelope editing (label / enabled / timing) off the right-side `PropertyPanel` and onto the timeline — inline rename on the block, per-layer Enable/Disable in the context menu — leaving the inspector with per-kind params only.

**Architecture:** Delete `EnvelopeFields` from `PropertyPanel`. Add a tiny zustand `renameStore` holding `editingLayerId`; `LayerBlock` enters an inline `<input>` when its id matches (triggered by double-click or the context-menu "Rename"). The label commit drills one `onCommitLabel` callback Timeline→TrackLane→LayerBlock that runs `updateLayer + onMutated` (mirroring the existing drag-commit pattern in `useLayerDrag.ts:283`). Enable/Disable is a Timeline-level handler wired into `LayerContextMenu`. The per-track eye in `TrackHeader` is untouched.

**Tech Stack:** React 19 + TypeScript, zustand, `@base-ui/react` Menu, react-i18next, Tauri IPC (`updateLayer`). Verification: `npm run typecheck` (`tsc -b`) + live checks in real WebView2 via the dev MCP bridge (no DOM-component test harness exists — no `@testing-library/react`/jsdom).

**Spec:** `docs/superpowers/specs/2026-06-13-timeline-envelope-editing-design.md`

**Conventions for every task:**
- Run typecheck from the `apps/desktop/` directory: `npm run typecheck`.
- Stage commits by explicit path only (the checkout may be edited from other sessions concurrently). Re-run `git status --short` before each commit and confirm only the listed files are staged.
- End commit messages with the `Co-Authored-By` trailer used by this repo.

---

### Task 1: Remove `EnvelopeFields` from PropertyPanel

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx`

- [ ] **Step 1: Remove the `updateLayer` import**

`EnvelopeFields` is the only consumer of `updateLayer` in this file (`KindFields` uses `updateLayerParams`; the Motif lifecycle uses `installMotif`/`deleteMotif`/etc.). In the import block at lines 9–23, delete the `updateLayer,` line so it reads:

```tsx
import {
  updateLayerParams,
  installMotif,
  deleteMotif,
  getMotifSource,
  amendMotifDraft,
  createEditDraft,
  type GroupSummary,
  type LayerParamsPatch,
  type LayerSummary,
  type Rgba,
  type TrackSummary,
  trackStatic,
} from "../ipc";
```

- [ ] **Step 2: Delete the `EnvelopeFields` function**

Delete the entire `EnvelopeFields` function (currently lines 100–197 — from `function EnvelopeFields({` through its closing `}` just before `function KindFields({`).

- [ ] **Step 3: Remove the render call + divider**

In the `PropertyPanel` return (lines 75–85), delete the `<EnvelopeFields .../>` line and the `<hr />` immediately after it. The return becomes:

```tsx
  return (
    <aside className="property-panel">
      <h2>
        {t("property_panel.heading")} —{" "}
        {t(`kinds.${layer.kind.toLowerCase()}`, { defaultValue: layer.kind })}
      </h2>
      <KindFields layer={layer} onMutated={onMutated} fpsNum={fpsNum} fpsDen={fpsDen} />
    </aside>
  );
```

- [ ] **Step 4: Typecheck**

From `apps/desktop/`: `npm run typecheck`
Expected: PASS, no errors. (If `tsc` flags any other now-unused import such as `parseTimecode`/`formatTimecode`/`AppSwitch`, do NOT remove them — they are still used by `VideoClipFields`/`ImageOverlayFields`/`AudioFields`. Only `updateLayer` should have become unused. If typecheck reports an unexpected unused symbol, re-check Step 2 was a clean deletion.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx
git commit -m "refactor(panel): drop EnvelopeFields — timeline owns the envelope"
```

---

### Task 2: Add context-menu i18n keys

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add English keys**

In `en-US.ts`, the `timeline` section has `prebake_now: "Pre-bake now",` (line ~195). Immediately after that line add:

```ts
    rename: "Rename",
    enable_layer: "Enable layer",
    disable_layer: "Disable layer",
```

- [ ] **Step 2: Add Chinese keys**

In `zh-CN.ts`, the `timeline` section has `prebake_now: "立即预烘焙",` (line ~193). Immediately after that line add:

```ts
    rename: "重命名",
    enable_layer: "启用图层",
    disable_layer: "禁用图层",
```

- [ ] **Step 3: Typecheck**

From `apps/desktop/`: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "i18n(timeline): add rename / enable / disable layer strings"
```

---

### Task 3: Inline rename on the timeline block (double-click)

**Files:**
- Create: `apps/desktop/src/timeline/renameStore.ts`
- Modify: `apps/desktop/src/timeline/LayerBlock.tsx`
- Modify: `apps/desktop/src/timeline/TrackLane.tsx`
- Modify: `apps/desktop/src/timeline/Timeline.tsx`

- [ ] **Step 1: Create the rename store**

Create `apps/desktop/src/timeline/renameStore.ts`:

```ts
import { create } from "zustand";

/// Ephemeral "which layer is being renamed inline" focus state. Lives in a
/// store (not Timeline state) so both the double-click handler in LayerBlock
/// and the context-menu "Rename" item can drive it without prop-drilling the
/// trigger through TrackLane. Atomic selector only — never select a composite
/// object (feedback_zustand_composite_selector).
interface RenameState {
  editingLayerId: string | null;
  beginRename: (layerId: string) => void;
  endRename: () => void;
}

export const useRenameStore = create<RenameState>((set) => ({
  editingLayerId: null,
  beginRename: (layerId) => set({ editingLayerId: layerId }),
  endRename: () => set({ editingLayerId: null }),
}));

export const useEditingLayerId = (): string | null =>
  useRenameStore((s) => s.editingLayerId);

export const beginRename = (layerId: string): void =>
  useRenameStore.getState().beginRename(layerId);

export const endRename = (): void => useRenameStore.getState().endRename();
```

- [ ] **Step 2: Verify the zustand `create` import path**

Run: `npm ls zustand` (from `apps/desktop/`), and confirm an existing store uses the bare `import { create } from "zustand";` form.
Check: `grep -rn "from \"zustand\"" apps/desktop/src` — match the exact import style the codebase already uses (e.g. `apps/desktop/src/state/projectStore.ts`). If it uses `create` from `"zustand"`, the import above is correct; otherwise mirror the existing form.

- [ ] **Step 3: Wire the inline editor into LayerBlock**

In `apps/desktop/src/timeline/LayerBlock.tsx`:

(a) Change the React import (line 1) from:
```tsx
import { useState } from "react";
```
to:
```tsx
import { useEffect, useRef, useState } from "react";
```

(b) Add the store import after the existing imports near the top of the file (after line 10 `import type { LayerSummary } from "../ipc";`):
```tsx
import { useEditingLayerId, beginRename, endRename } from "./renameStore";
```

(c) Add `onCommitLabel` to the destructured props (after `onContextMenu,` at line 74):
```tsx
  onContextMenu,
  onCommitLabel,
```
and to the props type (after the `onContextMenu` type block ending at line 112, before `fpsNum: number;`):
```tsx
  /// Persist an inline-rename edit. `label` may be empty (clears the custom
  /// label → block falls back to the kind name). Wired by Timeline to
  /// `updateLayer({label}) + onMutated`, matching the drag-commit pattern.
  onCommitLabel: (layerId: string, label: string) => void;
```

(d) Inside the component body, after `const isPendingPlacement = ...` (line 118), add editing state:
```tsx
  const editingLayerId = useEditingLayerId();
  const isEditing = editingLayerId === layer.id;
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (isEditing) {
      setDraft(layer.label ?? "");
      // focus + select on the next tick once the input is mounted
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing, layer.id, layer.label]);

  const commitRename = () => {
    const next = draft.trim();
    if (next !== (layer.label ?? "")) onCommitLabel(layer.id, next);
    endRename();
  };
```

(e) Change the label fallback (line 152) so an empty/whitespace label shows the kind name (lets "clear to revert" work):
```tsx
  const label =
    layer.label && layer.label.trim() !== "" ? layer.label : kindLabel;
```

(f) Add a double-click handler on the block container. In the root `<div>` (the one with `onClick={...}` at line 315 and `onPointerDown={onLayerPointerDown}` at line 328), add after the `onClick` handler:
```tsx
      onDoubleClick={(e) => {
        if (layer.locked || trackLocked || bladeMode) return;
        e.stopPropagation();
        beginRename(layer.id);
      }}
```

(g) Replace the label `<span>` (lines 340–342) with a conditional editor:
```tsx
      {isEditing ? (
        <input
          ref={inputRef}
          className="relative z-[2] min-w-0 flex-1 rounded-sm border border-blue-400 bg-black/60 px-1 text-inherit outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              endRename();
            }
          }}
        />
      ) : (
        <span className="relative z-[1] flex-1 overflow-hidden text-ellipsis whitespace-nowrap [text-shadow:0_1px_0_rgba(255,255,255,0.4)]">
          {label}
        </span>
      )}
```

- [ ] **Step 4: Thread `onCommitLabel` through TrackLane**

In `apps/desktop/src/timeline/TrackLane.tsx`:

(a) Add `onCommitLabel,` to the destructured props (after `onContextMenu,` at line 41):
```tsx
  onContextMenu,
  onCommitLabel,
```

(b) Add to the props type (after the `onContextMenu` type block ending at line 79):
```tsx
  onCommitLabel: (layerId: string, label: string) => void;
```

(c) Pass it to `<LayerBlock>` (after `onContextMenu={onContextMenu}` at line 241):
```tsx
            onContextMenu={onContextMenu}
            onCommitLabel={onCommitLabel}
```

- [ ] **Step 5: Define the commit handler in Timeline and pass it down**

In `apps/desktop/src/timeline/Timeline.tsx`:

(a) Add `updateLayer` to the `../ipc` import. Find the existing import from `"../ipc"` and add `updateLayer,` to it. (If there is no value import from `"../ipc"` yet — only type imports — add a new line: `import { updateLayer } from "../ipc";` near the other imports.)

(b) Add the import for `beginRename` (used in Task 4 too) near the top:
```tsx
import { beginRename } from "./renameStore";
```
(Leave it imported now; Task 4 consumes it. If `tsc` complains it is unused at this step, instead add it in Task 4 Step (c) and skip it here.)

(c) Define the handler alongside the other `useCallback`s (e.g. just after the `onContextMenu` callback at lines 359–369):
```tsx
  const onCommitLabel = useCallback(
    async (layerId: string, label: string) => {
      try {
        await updateLayer(layerId, { label });
        await onMutated();
      } catch (e) {
        console.warn("update_layer (label) failed:", e);
      }
    },
    [onMutated],
  );
```

(d) Pass it to `<TrackLane>` (after `onContextMenu={onContextMenu}` at line 543):
```tsx
                onContextMenu={onContextMenu}
                onCommitLabel={onCommitLabel}
```

- [ ] **Step 6: Typecheck**

From `apps/desktop/`: `npm run typecheck`
Expected: PASS. (If `beginRename` in Step 5b is reported unused, move that import into Task 4 instead and re-run.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/timeline/renameStore.ts apps/desktop/src/timeline/LayerBlock.tsx apps/desktop/src/timeline/TrackLane.tsx apps/desktop/src/timeline/Timeline.tsx
git commit -m "feat(timeline): inline rename layers via double-click"
```

---

### Task 4: Context menu — Rename + Enable/Disable for every layer

**Files:**
- Modify: `apps/desktop/src/timeline/LayerContextMenu.tsx`
- Modify: `apps/desktop/src/timeline/Timeline.tsx`
- Modify: `apps/desktop/src/timeline/TrackLane.tsx`
- Modify: `apps/desktop/src/timeline/LayerBlock.tsx`

- [ ] **Step 1: Extend `onContextMenu` to carry the layer's enabled flag**

The menu needs the current `enabled` to label the toggle. Thread one extra arg through the existing `onContextMenu` chain.

(a) `LayerBlock.tsx` — update the `onContextMenu` prop type (lines 108–112):
```tsx
  onContextMenu: (
    e: React.MouseEvent,
    layerId: string,
    layerKind: string,
    layerEnabled: boolean,
  ) => void;
```
and the call site (line 336):
```tsx
        onContextMenu(e, layer.id, layer.kind, layer.enabled);
```

(b) `TrackLane.tsx` — update the `onContextMenu` prop type (lines 75–79):
```tsx
  onContextMenu: (
    e: React.MouseEvent,
    layerId: string,
    layerKind: string,
    layerEnabled: boolean,
  ) => void;
```

(c) `Timeline.tsx` — extend the `contextMenu` state shape (lines 135–140):
```tsx
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    layerId: string;
    layerKind: string;
    layerEnabled: boolean;
  } | null>(null);
```
and the `onContextMenu` callback (lines 359–369):
```tsx
  const onContextMenu = useCallback(
    (
      e: React.MouseEvent,
      layerId: string,
      layerKind: string,
      layerEnabled: boolean,
    ) => {
      setContextMenu({ x: e.clientX, y: e.clientY, layerId, layerKind, layerEnabled });
    },
    [],
  );
```

- [ ] **Step 2: Add the Rename + Toggle handlers in Timeline**

In `Timeline.tsx`, after the `onCommitLabel` handler from Task 3, add:

```tsx
  const onRename = useCallback((layerId: string) => {
    setContextMenu(null);
    beginRename(layerId);
  }, []);

  const onToggleEnabled = useCallback(
    async (layerId: string, enabled: boolean) => {
      setContextMenu(null);
      try {
        await updateLayer(layerId, { enabled });
        await onMutated();
      } catch (e) {
        console.warn("update_layer (enabled) failed:", e);
      }
    },
    [onMutated],
  );
```

(Ensure `beginRename` is imported from `./renameStore` — added in Task 3 Step 5b; if it was skipped there, add `import { beginRename } from "./renameStore";` now.)

- [ ] **Step 3: Pass the new props to `<LayerContextMenu>`**

In `Timeline.tsx`, the render block (lines 565–575) becomes:

```tsx
    {contextMenu && (
      <LayerContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        layerId={contextMenu.layerId}
        layerKind={contextMenu.layerKind}
        layerEnabled={contextMenu.layerEnabled}
        onClose={() => setContextMenu(null)}
        onRename={onRename}
        onToggleEnabled={onToggleEnabled}
        onSeparateAudio={onSeparateAudio}
        onPrebakeNow={onPrebakeNow}
      />
    )}
```

- [ ] **Step 4: Rework `LayerContextMenu` items**

Replace `apps/desktop/src/timeline/LayerContextMenu.tsx` props signature and the `<MenuPrimitive.Popup>` body.

(a) Props (lines 15–31) become:
```tsx
export function LayerContextMenu({
  x,
  y,
  layerId,
  layerKind,
  layerEnabled,
  onClose,
  onRename,
  onToggleEnabled,
  onSeparateAudio,
  onPrebakeNow,
}: {
  x: number;
  y: number;
  layerId: string;
  layerKind: string;
  layerEnabled: boolean;
  onClose: () => void;
  onRename: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onSeparateAudio: (id: string) => void;
  onPrebakeNow: (id: string) => void;
}) {
```

(b) The `<MenuPrimitive.Popup className="menu-list">…</MenuPrimitive.Popup>` block (lines 66–90) becomes:
```tsx
          <MenuPrimitive.Popup className="menu-list">
            <MenuPrimitive.Item
              className="menu-item"
              onClick={() => onRename(layerId)}
            >
              {t("timeline.rename", { defaultValue: "Rename" })}
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              className="menu-item"
              onClick={() => onToggleEnabled(layerId, !layerEnabled)}
            >
              {layerEnabled
                ? t("timeline.disable_layer", { defaultValue: "Disable layer" })
                : t("timeline.enable_layer", { defaultValue: "Enable layer" })}
            </MenuPrimitive.Item>
            {layerKind === "Audio" && (
              <>
                <MenuPrimitive.Separator className="menu-separator" />
                <MenuPrimitive.Item
                  className="menu-item"
                  onClick={() => onSeparateAudio(layerId)}
                >
                  {t("timeline.separate_audio", {
                    defaultValue: "Separate audio to new track",
                  })}
                </MenuPrimitive.Item>
              </>
            )}
            {layerKind === "Motif" && (
              <>
                <MenuPrimitive.Separator className="menu-separator" />
                <MenuPrimitive.Item
                  className="menu-item"
                  onClick={() => onPrebakeNow(layerId)}
                >
                  {t("timeline.prebake_now", { defaultValue: "Pre-bake now" })}
                </MenuPrimitive.Item>
              </>
            )}
          </MenuPrimitive.Popup>
```

(`menu-separator` is an existing class — `styles.css:167`; `MenuPrimitive.Separator` is already used in `apps/desktop/src/menu/Menu.tsx:112`. The old `timeline.no_actions_here` key is now unreferenced; leave it in the locale files.)

- [ ] **Step 5: Typecheck**

From `apps/desktop/`: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/timeline/LayerContextMenu.tsx apps/desktop/src/timeline/Timeline.tsx apps/desktop/src/timeline/TrackLane.tsx apps/desktop/src/timeline/LayerBlock.tsx
git commit -m "feat(timeline): context-menu rename + per-layer enable/disable"
```

---

### Task 5: Live verification in real WebView2

No DOM-component test harness exists for these interactions; verify behaviorally in the running app. Use the dev MCP bridge (`mcp___hypothesi_tauri-mcp-server__webview_*` tools) or drive by hand.

**Files:** none (verification only).

- [ ] **Step 1: Build + launch**

From `apps/desktop/`: start the app with `npm run tauri:dev` (rebuilds the WebView2). Open a project that has at least one Video, one Audio, and (if available) one Motif layer.

- [ ] **Step 2: Verify the panel no longer shows envelope fields**

Select a layer. Confirm the right panel shows ONLY the kind-specific section (no Label / Enabled / Start / End fields), and that editing a kind param (e.g. opacity) still commits and re-renders.

- [ ] **Step 3: Verify double-click rename**

Double-click a layer block → an input appears with the current name selected.
- Type a new name + Enter → block shows the new label; re-select the layer and confirm it persists.
- Double-click again, clear the text + Enter → block reverts to the kind name (e.g. "Video").
- Double-click, type, then press Escape → no change committed.
- Confirm a plain single click still selects (no input), and dragging the block edges still trims start/end with frame snapping (the zero-delta click that precedes a double-click must NOT alter timing — watch the Start/End in the block tooltip).

- [ ] **Step 4: Verify context menu**

Right-click each of a Video, Audio, and Motif layer:
- Every layer shows **Rename** and **Enable/Disable layer** at the top (no `(no actions for this layer)` placeholder).
- Audio additionally shows **Separate audio…**; Motif additionally shows **Pre-bake now** (below a separator).
- Click **Rename** → the correct block enters inline edit.
- Click **Disable layer** → the block dims (opacity ~0.45) and the item now reads **Enable layer**; click it again → undims. Confirm the per-track eye icon in the track header is unaffected (toggling layer-enabled does not change the track eye, and vice-versa).

- [ ] **Step 5: Record the result**

Note pass/fail per check in the task hand-back. If any check fails, stop and debug before declaring done (superpowers:verification-before-completion).

---

## Self-Review

**Spec coverage:**
- Remove `EnvelopeFields` (label/enabled/timing) → Task 1. ✓
- Inline rename, double-click + context-menu, Enter/blur commit, Esc cancel, empty→fallback → Task 3 (+ Task 4 menu trigger). ✓
- Per-layer Enable/Disable in context menu, distinct from track eye → Task 4 + Task 5 Step 4. ✓
- Timing keeps drag-only; typed-timecode dropped → covered by Task 1 removal; no timeline timecode entry added (out of scope). ✓
- i18n en-US + zh-CN → Task 2. ✓
- Verification (tsc + live WebView2) → per-task typecheck + Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `onCommitLabel(layerId: string, label: string)` is identical in LayerBlock prop, TrackLane prop, and the Timeline handler. `onContextMenu(e, layerId, layerKind, layerEnabled)` is identical across LayerBlock / TrackLane / Timeline state + callback. `beginRename`/`endRename`/`useEditingLayerId` signatures match the store. `onRename(id)` / `onToggleEnabled(id, enabled)` match between Timeline handlers and LayerContextMenu props. ✓

**Risk note:** The "clear-to-revert" behavior depends on the actor accepting `updateLayer({label: ""})`; the display-side fallback (Task 3 Step 3e) treats empty/whitespace as no-label regardless of how the backend stores it, so the UX holds even if the backend persists `""`. Verified behaviorally in Task 5 Step 3.
