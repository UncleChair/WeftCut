import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ACTION_DEFS,
  type ActionId,
  bindingsEqual,
  eventToBinding,
  resolveAccelerator,
} from "../shortcuts";

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
  /// Lets the parent suspend the global keydown dispatcher while a
  /// capture is active. The chip mounts, sets `true`; unmounts, sets
  /// `false`. Without this the user's chord would also fire the
  /// currently-bound action mid-rebind.
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
      // Escape always cancels — the dispatcher is suspended via
      // `onActiveChange(true)` so this can't conflict with any bound
      // shortcut.
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
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
      onCommit(binding);
    }
    // `capture: true` so we beat any local input that might also
    // listen — but the global dispatcher is already suspended so
    // there's nothing else to fight in practice.
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [effective, ownerId, onCommit, onCancel]);

  // Click outside dismisses the chip when a conflict is showing. While
  // we're still waiting for a keypress, clicks pass through — the
  // user might be reaching for a different row.
  useEffect(() => {
    if (!conflict) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) onCancel();
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [conflict, onCancel]);

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
