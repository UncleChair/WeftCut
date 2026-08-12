import { create } from "zustand";
import { listen, type UnlistenFn } from "@/bridge/events";

import { projectHistoryView, type HistoryStackView } from "../ipc";
import { LatestRequestCoordinator } from "./latestRequest";

/// Renderer mirror of the FULL edit stack (`project_history_view`) — rows and
/// checkpoints, everything the History Panel draws.
///
/// Deliberately separate from `projectStore`: folding `ops` into
/// `ProjectSummary.history` would strap up to 200 entries (with their
/// `entity_labels`) onto the full-summary refetch that runs on EVERY edit,
/// whether the panel is open or not. Here the Panel owns the subscription, so
/// a closed Panel issues no IPC at all (spec decision 5).

export interface HistoryStoreState {
  view: HistoryStackView | null;
  /// True once the first fetch has settled. Distinguishes "no project / read
  /// refused" (`view === null`, `ready === true`) from "haven't fetched yet"
  /// (`view === null`, `ready === false`) — the Panel shows a spinner-ish
  /// placeholder for the second and an empty state for the first.
  ready: boolean;
}

interface HistoryStoreActions {
  apply: (view: HistoryStackView | null) => void;
  /// Back to the pre-fetch state, so a reopened Panel never flashes the stack
  /// as it stood when it was last closed.
  reset: () => void;
}

export const useHistoryStore = create<HistoryStoreState & HistoryStoreActions>(
  (set) => ({
    view: null,
    ready: false,
    apply: (view) => set({ view, ready: true }),
    reset: () => set({ view: null, ready: false }),
  }),
);

/// Non-null only between `wireHistoryStore` and its teardown, i.e. only while
/// the Panel is open. Every fetch path goes through it, so "closed Panel issues
/// no IPC" is enforced in ONE place rather than at each call site.
let requests: LatestRequestCoordinator | null = null;

async function fetchView(): Promise<void> {
  const coordinator = requests;
  if (!coordinator) return;
  await coordinator.run(
    () => projectHistoryView(),
    (view) => useHistoryStore.getState().apply(view),
    () => {
      // Pre-workspace / no project: the read rejects. Mark ready so the Panel
      // renders its empty state instead of a permanent placeholder.
      useHistoryStore.getState().apply(null);
    },
  );
}

/// Explicit refetch for the actions that change the view WITHOUT emitting
/// `project:changed` — checkpoint create and delete both change no project
/// state, so nothing broadcasts and this store would otherwise never hear
/// about them (ticket 02's constraint on 03/04). No-op while the Panel is
/// closed.
export async function refreshHistoryView(): Promise<void> {
  await fetchView();
}

/// One-shot mount wiring: subscribe to `project:changed`, then seed. Returns
/// the teardown the Panel stores and invokes on unmount.
///
/// Subscribe BEFORE the seed fetch, for the reason `wireProjectStore`
/// documents: an event emitted between the seed resolving and the listener
/// registering would be lost, and the stack would sit stale until some
/// unrelated later edit. An event landing DURING the seed just runs a second
/// fetch, which the coordinator serializes newest-wins.
export async function wireHistoryStore(): Promise<UnlistenFn> {
  const coordinator = new LatestRequestCoordinator();
  requests = coordinator;
  const unlisten = await listen("project:changed", () => {
    void fetchView();
  });
  await fetchView();
  return () => {
    coordinator.invalidate();
    unlisten();
    // Identity guard: a stale teardown from an old mount (StrictMode's
    // double-invoke, HMR) must neither disarm a newer mount's coordinator nor
    // wipe the stack it has already fetched.
    if (requests !== coordinator) return;
    requests = null;
    useHistoryStore.getState().reset();
  };
}

// ===== Atomic selector helpers ============================================

export const useHistoryView = (): HistoryStackView | null =>
  useHistoryStore((s) => s.view);

export const useHistoryReady = (): boolean => useHistoryStore((s) => s.ready);
