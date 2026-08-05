// The focus-region driver: three window listeners that keep DOM focus, and
// therefore `activeRegion`, honest. Mounted ONCE, at the renderer root.
//
// NLE convention: a press anywhere outside the focused text editor releases
// it, and focus always lands on a real region rather than on `<body>`. Both
// halves matter. Every field in the app commits on blur, so "release" also
// means "commit" — clicking a gizmo handle mid-edit applies the typed value
// instead of leaving it parked and invisible. And landing focus on a region
// rather than nowhere is what lets a bare-key shortcut be scoped at all
// (`ActionDef.scope`) instead of fighting a parked control with
// `captureGlobal`.

import { useEffect } from "react";

import { isEditableTarget, isInTransientWidget } from "../shortcuts/match";
import { isPanelKind } from "../workspace/panelRegistry";
import {
  focusGroupOf,
  pressMovesFocus,
  regionNameOf,
  regionRootOf,
} from "./focusRegion";
import { setActiveRegion } from "./focusRegionStore";

export function useFocusRegions(): void {
  useEffect(() => {
    /// LANDMINE: this MUST stay a window CAPTURE-phase `pointerdown` listener.
    /// Gesture handlers cancel `pointerdown` to suppress native drag and text
    /// selection — the gizmo's four handles, the keyframe curve graph, the
    /// transition chip, the track-height splitter — and a canceled
    /// `pointerdown` suppresses the compatibility `mousedown` whose default
    /// action is what moves focus. Those `preventDefault()` calls are correct
    /// and stay; only the capture phase at `window` runs ahead of all of them
    /// (React attaches at the root container, a descendant of window, so even
    /// its capture handlers are later).
    const onPointerDownCapture = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      const region = regionRootOf(target);
      // Focus will move on its own; `onFocusIn` records where it landed.
      if (pressMovesFocus(target, region)) return;
      const active = document.activeElement;
      const editing = isEditableTarget(active);
      // A satellite control of the focused field — a stepper, a clearable ✕,
      // the next timecode segment — is not "outside" it.
      if (editing && focusGroupOf(active)?.contains(target)) return;
      if (region) region.focus({ preventScroll: true });
      else if (editing) active.blur();
    };

    /// `Escape` releases the field back to its region. The field's own handler
    /// does the REVERT (see `AppInput`'s `onCancel`); the two are deliberately
    /// separate concerns, so a field with no cancel semantics still gives the
    /// keyboard back.
    ///
    /// Capture phase, because a field may `stopPropagation()` on keydown (the
    /// timeline rename input does) and a bubble listener would never see it.
    /// Deferred one microtask, because focusing the region fires the field's
    /// `blur` — and a blur landing BEFORE the field's own Escape handler would
    /// commit the value Escape was supposed to discard. React dispatches the
    /// component handlers synchronously inside this native event, so by the
    /// time the microtask runs the field has already set its cancel flag.
    const onKeyDownCapture = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const target = e.target;
      if (!isEditableTarget(target)) return;
      // Inside a dialog / menu / listbox, Escape belongs to the widget: it
      // closes one level, and the widget restores focus itself.
      if (isInTransientWidget(target)) return;
      const region = regionRootOf(target);
      if (!region) return;
      queueMicrotask(() => {
        // A field whose Escape handler unmounted it (the rename input calls
        // `endRename()`) leaves focus on `<body>`; recover that to the region.
        // Anything else already holding focus made a deliberate choice.
        const active = document.activeElement;
        if (active && active !== target && active !== document.body) return;
        if (region.isConnected) region.focus({ preventScroll: true });
      });
    };

    const onFocusIn = (e: FocusEvent): void => {
      // Narrowed here rather than in `focusRegion.ts`, which must stay free of
      // the panel registry — see the LANDMINE there.
      const name = regionNameOf(e.target as Node | null);
      setActiveRegion(isPanelKind(name) ? name : null);
    };

    window.addEventListener("pointerdown", onPointerDownCapture, true);
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("pointerdown", onPointerDownCapture, true);
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("focusin", onFocusIn);
    };
  }, []);
}
