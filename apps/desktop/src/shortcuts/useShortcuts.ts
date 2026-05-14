import { useEffect, useMemo, useRef } from "react";
import { ACTION_DEFS, type ActionId } from "./defs";
import {
  isChord,
  isEditableTarget,
  matchEvent,
  parseBinding,
  type ParsedBinding,
} from "./match";

export type Handler = () => void | Promise<void>;
export type HandlerMap = Partial<Record<ActionId, Handler>>;
export type OverrideMap = Partial<Record<ActionId, string[]>>;

interface ResolvedEntry {
  id: ActionId;
  parsed: ParsedBinding;
  fireWhenEditing: boolean;
  repeatable: boolean;
}

function resolveEntries(overrides: OverrideMap): ResolvedEntry[] {
  const out: ResolvedEntry[] = [];
  for (const id of Object.keys(ACTION_DEFS) as ActionId[]) {
    const def = ACTION_DEFS[id];
    const keys = overrides[id] ?? def.defaultKeys;
    for (const k of keys) {
      try {
        const parsed = parseBinding(k);
        const chord = isChord(parsed);
        out.push({
          id,
          parsed,
          // Default: chords fire while editing, bare keys don't. The
          // per-action override (rare) wins when present.
          fireWhenEditing: def.fireWhenEditing ?? chord,
          repeatable: def.repeatable ?? false,
        });
      } catch (e) {
        console.warn(
          `shortcuts: ignoring invalid binding "${k}" for ${id}:`,
          e,
        );
      }
    }
  }
  return out;
}

interface UseShortcutsOptions {
  handlers: HandlerMap;
  /// Per-user remappings, loaded from the backend. Missing entries fall
  /// back to `ACTION_DEFS[id].defaultKeys`. Pass a stable identity
  /// (state / memoized) so the listener doesn't churn each render.
  overrides?: OverrideMap;
  /// Suspend the global dispatcher. The Keyboard Shortcuts panel sets
  /// this while a "press a key…" capture chip is active so the user's
  /// chord doesn't accidentally fire the bound action mid-rebind.
  disabled?: boolean;
}

const EMPTY_OVERRIDES: OverrideMap = {};

/// Call **exactly once** at the top of `App.tsx`. Mounts a single
/// `window` keydown listener for the app's lifetime; handler identities
/// are read through a ref each event so React's render churn doesn't
/// force the listener to reattach.
///
/// Dispatch rules:
/// - Always `preventDefault` + `stopPropagation` on a matched event.
/// - Skip `e.repeat === true` unless the action declared `repeatable`.
/// - When focus is inside an editable element, fire only if the action
///   declared `fireWhenEditing` (auto-derived: chord = yes, bare = no).
export function useShortcuts({
  handlers,
  overrides = EMPTY_OVERRIDES,
  disabled,
}: UseShortcutsOptions): void {
  const handlersRef = useRef<HandlerMap>(handlers);
  handlersRef.current = handlers;

  const disabledRef = useRef<boolean>(!!disabled);
  disabledRef.current = !!disabled;

  const entries = useMemo(() => resolveEntries(overrides), [overrides]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (disabledRef.current) return;
      const editing = isEditableTarget(e.target);
      for (const entry of entries) {
        if (e.repeat && !entry.repeatable) continue;
        if (!matchEvent(entry.parsed, e)) continue;
        if (editing && !entry.fireWhenEditing) return;
        const fn = handlersRef.current[entry.id];
        if (!fn) return;
        e.preventDefault();
        e.stopPropagation();
        void fn();
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entries]);
}
