import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ACTION_DEFS, type ActionId } from "../shortcuts/defs";
import {
  bindingsEqual,
  eventToBinding,
  resolveAccelerator,
} from "../shortcuts/match";

interface ConflictInfo {
  /// The action that already owns the chord the user just pressed.
  /// Resolved against the *effective* binding map (defaults + overrides)
  /// so the message names whichever action is currently bound, not
  /// whichever one shipped the default.
  ownerId: ActionId;
}

interface CaptureProps {
  /// Effective binding map (defaults + overrides resolved) used for
  /// conflict detection. Passing this in keeps the chip dumb — it
  /// doesn't refetch on every keypress.
  effective: Record<ActionId, string[]>;
  /// The action the captured chord is being added to. We allow the
  /// user to "re-add" a chord they already own (no-op) so they don't
  /// see a misleading conflict against themselves.
  ownerId: ActionId;
  onCommit: (binding: string) => void;
  onCancel: () => void;
  /// Capture-active signal: `true` on mount, `false` on unmount. Nothing
  /// has to act on it — the chip's capture-phase listener already consumes
  /// the chord before the global dispatcher — so the only consumer today
  /// no-ops it; it's here for a surface that needs to suspend something.
  onActiveChange: (active: boolean) => void;
}

/// Inline "press a key…" chip. Captures the next non-modifier
/// keypress, checks for conflicts, and either commits (no conflict —
/// or conflict only with the owner action itself) or surfaces a red
/// "bound to X — unset there first" message and dismisses on the
/// next click outside / Escape.
export function KeybindingCapture({
  effective,
  ownerId,
  onCommit,
  onCancel,
  onActiveChange,
}: CaptureProps) {
  const { t } = useTranslation();
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const onCommitEvent = useEffectEvent(onCommit);
  const onCancelEvent = useEffectEvent(onCancel);

  useEffect(() => {
    onActiveChange(true);
    return () => onActiveChange(false);
  }, [onActiveChange]);

  // Focus the chip so screen readers + keyboard nav work; also makes
  // `:focus-visible` styling kick in.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Escape always cancels — this capture-phase window listener sees
      // the key before any bound shortcut, so it can't conflict with one.
      // stopPropagation: the same listener runs before the Settings
      // dialog's Escape-close; without it one Escape would cancel the
      // capture AND close the whole dialog.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancelEvent();
        return;
      }
      const binding = eventToBinding(e);
      if (binding === null) return; // modifier-only press — keep waiting
      e.preventDefault();
      e.stopPropagation();

      // Conflict check against effective bindings. Re-adding a chord
      // the owner already has is a no-op rather than a conflict.
      let ownerOfConflict: ActionId | null = null;
      for (const [id, keys] of Object.entries(effective) as [
        ActionId,
        string[],
      ][]) {
        if (id === ownerId) continue;
        if (keys.some((k) => bindingsEqual(k, binding))) {
          ownerOfConflict = id;
          break;
        }
      }
      if (ownerOfConflict) {
        setConflict({ ownerId: ownerOfConflict });
        return;
      }
      onCommitEvent(binding);
    }
    // `capture: true` so we beat any local input that might also listen,
    // and the global shortcut dispatcher, which runs on the bubble phase.
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [effective, ownerId]);

  // Click outside dismisses the chip when a conflict is showing. While
  // we're still waiting for a keypress, clicks pass through — the
  // user might be reaching for a different row.
  useEffect(() => {
    if (!conflict) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) onCancelEvent();
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [conflict]);

  if (conflict) {
    const ownerLabelKey = ACTION_DEFS[conflict.ownerId].labelKey;
    return (
      <span
        ref={containerRef}
        className="kbd-capture kbd-capture-conflict"
        tabIndex={-1}
      >
        {t("keybindings.conflict", { action: t(ownerLabelKey) })}
      </span>
    );
  }

  return (
    <span
      ref={containerRef}
      className="kbd-capture kbd-capture-waiting"
      tabIndex={-1}
    >
      {t("keybindings.press_a_key")}
    </span>
  );
}

/// Helper: format a binding for display in a chip.
export function bindingLabel(binding: string): string {
  return resolveAccelerator(binding);
}
