import { create } from "zustand";
import { listCommands, subscribeCommandRegistry } from "../commands/registry";
import i18n from "../i18n";
import { useProjectStore } from "../state/projectStore";
import { buildEntries, type CommandInput, type LocaleInput } from "./buildEntries";
import type { SearchEntry } from "./types";

/// IDE-style background index (spec §Index): dirty signals (summary
/// change via projectStore, locale change, command-registry change) →
/// debounce → async FULL rebuild from the canonical snapshot → atomic
/// swap. Queries always read the last completed build — never a
/// half-built one. Full rebuild (not incremental diff) makes ghost
/// entries impossible by construction; pinyinHaystacks' content memo
/// makes rebuilds cheap. buildEntries is pure — the Worker escalation
/// seam if project sizes ever demand it.
interface State {
  entries: SearchEntry[];
  version: number;
}

export const useSearchIndexStore = create<State>(() => ({
  entries: [],
  version: 0,
}));

export const useSearchEntries = (): SearchEntry[] =>
  useSearchIndexStore((s) => s.entries);

const DEBOUNCE_MS = 300;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildSliceTimer: ReturnType<typeof setTimeout> | null = null;
let wired = false;

function commandInputs(): CommandInput[] {
  const tEn = i18n.getFixedT("en-US");
  return listCommands().map((c) => ({
    id: c.id,
    label: i18n.t(c.labelKey),
    enLabel: tEn(c.labelKey),
    // Spread only when set — CommandInput.actionId is `?: ActionId` (no
    // explicit `| undefined`), and exactOptionalPropertyTypes rejects an
    // object literal that assigns `undefined` to it directly.
    ...(c.actionId !== undefined ? { actionId: c.actionId } : {}),
  }));
}

/// Read fresh per rebuild, never cached: `languageChanged` marks the index dirty
/// (see wireSearchIndex), so the next build must see the NEW active locale.
function localeInput(): LocaleInput {
  const tEn = i18n.getFixedT("en-US");
  return {
    t: (key, values) => i18n.t(key, values),
    tEn: (key, values) => tEn(key, values),
  };
}

function rebuildNow(): void {
  const summary = useProjectStore.getState().summary;
  const entries = buildEntries(summary, commandInputs(), localeInput());
  useSearchIndexStore.setState((s) => ({ entries, version: s.version + 1 }));
}

export function markSearchIndexDirty(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Extra async slice keeps the rebuild off the dirty signal's own
    // stack — project:changed subscribers must stay cheap. Tracked so
    // teardown can cancel a scheduled-but-unfired rebuild too.
    if (rebuildSliceTimer !== null) clearTimeout(rebuildSliceTimer);
    rebuildSliceTimer = setTimeout(() => {
      rebuildSliceTimer = null;
      rebuildNow();
    }, 0);
  }, DEBOUNCE_MS);
}

/// One-shot wiring, called alongside wireProjectStore (useAppWiring).
/// Idempotent for HMR/StrictMode: a second call while wired only marks
/// dirty. Returns teardown.
export function wireSearchIndex(): () => void {
  if (wired) {
    markSearchIndexDirty();
    return () => {};
  }
  wired = true;
  const unsubProject = useProjectStore.subscribe((s, prev) => {
    if (s.summary !== prev.summary) markSearchIndexDirty();
  });
  const unsubRegistry = subscribeCommandRegistry(markSearchIndexDirty);
  const onLocale = () => markSearchIndexDirty();
  i18n.on("languageChanged", onLocale);
  rebuildNow();
  return () => {
    unsubProject();
    unsubRegistry();
    i18n.off("languageChanged", onLocale);
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (rebuildSliceTimer !== null) clearTimeout(rebuildSliceTimer);
    rebuildSliceTimer = null;
    wired = false;
  };
}
