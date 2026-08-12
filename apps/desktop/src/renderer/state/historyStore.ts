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
  /// True once the first fetch has settled — the Panel's only cue to draw a
  /// placeholder rather than a bare list on its very first render.
  ///
  /// `view === null` therefore means exactly one thing: the seed fetch has not
  /// landed yet. There is no "fetched but empty" state to tell it apart from —
  /// the read is served straight off a live actor whose stack always holds at
  /// least the `Initial` seed.
  ready: boolean;
}

interface HistoryStoreActions {
  /// Non-nullable on purpose: `null` is reachable only through `reset()`, which
  /// means "not fetched", and nothing else can put the store back there.
  apply: (view: HistoryStackView) => void;
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

/// A failure here drives NO Panel state. `project_history_view` routes to a read
/// that returns `actor.historyView(cap)` off a live actor and cannot refuse, so
/// there is no pre-workspace / no-project branch to render — a "couldn't load"
/// state would be one no test could ever reach.
///
/// It is still caught, because the IPC TRANSPORT can fail even when the handler
/// cannot (a torn-down main process, a serialization error). Every caller either
/// discards this promise (`void fetchView()` in the event listener) or awaits it
/// from a click handler, so an escaping rejection would be an unhandled one. The
/// last-known view stays on screen instead: stale rows are recoverable — the
/// next `project:changed` refetches — where a thrown renderer is not.
async function fetchView(): Promise<void> {
  const coordinator = requests;
  if (!coordinator) return;
  try {
    await coordinator.run(
      () => projectHistoryView(),
      (view) => useHistoryStore.getState().apply(view),
    );
  } catch (err) {
    console.warn("[historyStore] history view fetch failed; keeping the last view", err);
  }
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
