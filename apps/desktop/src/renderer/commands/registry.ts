import { useEffect, useLayoutEffect, useRef } from "react";
import type { ActionId } from "../shortcuts/defs";

/// The unified user-invocable command surface: providers registered here are
/// the one catalog the search palette reads. Module-level, playbackStore-style:
/// readers don't thread props; components register providers on mount.
export interface CommandDef {
  /// Unique id. Shortcut-backed commands reuse their ActionId string so
  /// ids stay one namespace.
  id: string;
  labelKey: string;
  /// Set for shortcut-backed commands — the palette shows the effective
  /// binding via useEffectiveBindings(actionId).
  actionId?: ActionId;
  /// Evaluated at palette render time; absent = always enabled.
  enabled?: () => boolean;
  /// Current state of a checkable command (armed tool, active mode).
  /// Evaluated at render time, like `enabled`; absent = not checkable.
  checked?: () => boolean;
  run: () => void | Promise<void>;
}

type Provider = () => CommandDef[];

const providers = new Set<Provider>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version++;
  for (const l of listeners) l();
}

/// Monotonic registry version — `useSyncExternalStore` snapshot for consumers
/// that must re-render when providers mount/unmount (the command menus).
/// `listCommands()` itself can't be the snapshot: it builds a fresh array per
/// call, which useSyncExternalStore would read as "changed every render".
export function commandRegistryVersion(): number {
  return version;
}

export function registerCommandProvider(p: Provider): () => void {
  providers.add(p);
  notify();
  return () => {
    if (providers.delete(p)) notify();
  };
}

/// Registry-change signal — the search index re-snapshots command labels
/// when providers mount/unmount (App mount lands after wireSearchIndex).
export function subscribeCommandRegistry(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function listCommands(): CommandDef[] {
  const out: CommandDef[] = [];
  const seen = new Set<string>();
  for (const p of providers) {
    for (const d of p()) {
      if (seen.has(d.id)) {
        console.warn(`commands: duplicate id "${d.id}" ignored`);
        continue;
      }
      seen.add(d.id);
      out.push(d);
    }
  }
  return out;
}

export function getCommand(id: string): CommandDef | undefined {
  return listCommands().find((c) => c.id === id);
}

/// React binding: register a provider for this component's lifetime.
/// `getDefs` is read through a ref so handler identities may churn per
/// render without re-registering (same pattern as useShortcuts).
export function useCommandProvider(getDefs: () => CommandDef[]): void {
  const ref = useRef(getDefs);
  useLayoutEffect(() => {
    ref.current = getDefs;
  }, [getDefs]);
  useEffect(() => registerCommandProvider(() => ref.current()), []);
}
