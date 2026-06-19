import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ACTION_DEFS, ACTION_IDS, type ActionId } from "./defs";
import type { OverrideMap } from "./useShortcuts";

// Read-only view of the effective bindings (defaults overlaid with
// user overrides) for every action. Consumers — `<MenuItem>` for the
// accelerator hint, future toolbar tooltips — read through
// `useEffectiveBindings(id)` so the displayed shortcut and the bound
// key cannot drift.

interface BindingsContextValue {
  effective: Record<ActionId, string[]>;
}

const BindingsContext = createContext<BindingsContextValue | null>(null);

function resolve(overrides: OverrideMap): Record<ActionId, string[]> {
  const out = {} as Record<ActionId, string[]>;
  for (const id of ACTION_IDS) {
    out[id] = overrides[id] ?? ACTION_DEFS[id].defaultKeys;
  }
  return out;
}

interface ProviderProps {
  overrides: OverrideMap;
  children: ReactNode;
}

export function ShortcutBindingsProvider({
  overrides,
  children,
}: ProviderProps) {
  const value = useMemo<BindingsContextValue>(
    () => ({ effective: resolve(overrides) }),
    [overrides],
  );
  return (
    <BindingsContext.Provider value={value}>
      {children}
    </BindingsContext.Provider>
  );
}

/// Returns the *first* effective binding for an action, or `null` if
/// the action is currently unbound. Menus render only the first chord
/// — multi-binding lists belong in the Settings → Keyboard panel.
/// When no provider is mounted (e.g. tests), falls back to defaults
/// so menu hints stay reasonable instead of rendering blank.
///
/// Accepts `undefined` to keep the call unconditional from a component
/// that conditionally has an `actionId` — the hook always runs; the
/// caller drops the result when the id is absent.
export function useEffectiveBindings(id: ActionId | undefined): string | null {
  const ctx = useContext(BindingsContext);
  if (!id) return null;
  const keys = ctx?.effective[id] ?? ACTION_DEFS[id].defaultKeys;
  return keys[0] ?? null;
}
