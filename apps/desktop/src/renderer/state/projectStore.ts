import { create } from "zustand";
import { listen, type UnlistenFn } from "@/bridge/events";

import {
  projectSummary,
  type LayerSummary,
  type MarkerSummary,
  type MediaSummary,
  type ProjectSummary,
  type RoleMixView,
} from "../ipc";
import {
  retainLayerSelection,
  retainTransitionSelection,
} from "./selectionStore";
import { LatestRequestCoordinator } from "./latestRequest";

/// Frontend mirror of the main-process TS state actor's project, kept in sync
/// via `project:changed` backend events. The PixiJS preview consumes this
/// directly; there is no separate IR emit target for the preview
/// (see `docs/preview.md`).
///
/// Atomic selectors only — composite-object selectors infinite-loop
/// `useSyncExternalStore` per `feedback_zustand_composite_selector`.
/// Helpers below select a single field at a time; for derived combos
/// use `useShallow` from `zustand/shallow` at the call site.
///
/// Pre-workspace: `summary` is `null`; consumers should guard.

export interface ProjectStoreState {
  summary: ProjectSummary | null;
  /// `media_id → MediaSummary`. Rebuilt on every `summary` change.
  mediaById: Map<string, MediaSummary>;
  /// `layer_id → LayerSummary`. Rebuilt on every `summary` change.
  layerById: Map<string, LayerSummary>;
  /// `layer_id → track_id` reverse index — handy for z-order
  /// (track order) lookups without iterating tracks each time.
  trackIdByLayerId: Map<string, string>;
  /// True after the initial `project_summary` fetch + subscription is
  /// wired. Distinguishes "no project loaded" (`summary === null`,
  /// `ready === true`) from "haven't fetched yet"
  /// (`summary === null`, `ready === false`).
  ready: boolean;
}

interface ProjectStoreActions {
  /// Apply a fresh summary snapshot, rebuilding lookup indices and dropping
  /// globally selected Layers that no longer exist in the Project.
  /// Idempotent; safe to call from a debounced refresher.
  apply: (summary: ProjectSummary | null) => void;
}

function buildIndices(summary: ProjectSummary | null): {
  mediaById: Map<string, MediaSummary>;
  layerById: Map<string, LayerSummary>;
  trackIdByLayerId: Map<string, string>;
} {
  const mediaById = new Map<string, MediaSummary>();
  const layerById = new Map<string, LayerSummary>();
  const trackIdByLayerId = new Map<string, string>();
  if (!summary) return { mediaById, layerById, trackIdByLayerId };
  for (const m of summary.media) mediaById.set(m.id, m);
  for (const t of summary.tracks) {
    for (const l of t.layers) {
      layerById.set(l.id, l);
      trackIdByLayerId.set(l.id, t.id);
    }
  }
  return { mediaById, layerById, trackIdByLayerId };
}

export const useProjectStore = create<
  ProjectStoreState & ProjectStoreActions
>((set) => ({
  summary: null,
  mediaById: new Map(),
  layerById: new Map(),
  trackIdByLayerId: new Map(),
  ready: false,

  apply: (summary) => {
    const indices = buildIndices(summary);
    set({
      summary,
      ...indices,
      ready: true,
    });
    retainLayerSelection(indices.layerById.keys());
    // Transitions are optional on the wire (older snapshots omit them);
    // absent == empty, so a missing field also clears a stale chip selection.
    retainTransitionSelection(
      (summary?.transitions ?? []).map((tr) => tr.id),
    );
  },
}));

/// One-shot mount wiring: fetch the initial summary, then subscribe to
/// `project:changed`. Returns a teardown function the caller stores
/// + invokes on unmount.
///
/// Idempotent for HMR: a second call replaces the subscription; the
/// initial fetch is harmless re-work.
///
/// Pre-workspace: `project_summary` returns an Err which we treat as
/// "no project loaded" — the store sits with `summary: null, ready: true`
/// and the listener catches the eventual `project:changed` that arrives
/// once a workspace opens.
export async function wireProjectStore(): Promise<UnlistenFn> {
  // `project:changed` fires a re-fetch, and `project_summary` is an async IPC
  // whose responses can resolve out of order. A newly issued request
  // invalidates every earlier request immediately, including while the new
  // response is pending. Otherwise the older snapshot can still publish in
  // that gap and temporarily regress clip geometry or media export routing.
  const requests = new LatestRequestCoordinator();
  const refresh = async () => {
    await requests.run(
      () => projectSummary(),
      (summary) => useProjectStore.getState().apply(summary),
      () => {
        // No project loaded — leave summary null but mark ready so
        // consumers can distinguish from the pre-fetch state.
        useProjectStore.getState().apply(null);
      },
    );
  };
  // Subscribe BEFORE the seed fetch: a `project:changed` emitted between the
  // seed resolving and the listener registering would otherwise be lost, and
  // the store would sit on a stale snapshot until some unrelated later event.
  // An event landing during the seed just runs a second refresh, which the
  // coordinator already serializes newest-wins.
  const unlisten = await listen("project:changed", () => {
    void refresh();
  });
  await refresh();
  return () => {
    requests.invalidate();
    unlisten();
  };
}

// ===== Atomic selector helpers ============================================
// Each returns ONE field (or a value derived from one field) so React's
// `useSyncExternalStore` doesn't infinite-loop on referential equality.

export const useProjectSummary = (): ProjectSummary | null =>
  useProjectStore((s) => s.summary);

export const useAudioRoles = (): RoleMixView[] =>
  useProjectStore((s) => s.summary?.audio_roles ?? EMPTY_ROLES);

/// The project's markers. Absent on stub summaries and pre-workspace, which is
/// why this reads through the empty sentinel rather than asserting the field.
export const useProjectMarkers = (): MarkerSummary[] =>
  useProjectStore((s) => s.summary?.markers ?? EMPTY_MARKERS);

/// Resolve a media item by id without forcing the caller to subscribe
/// to the whole media array. The selector reads from `mediaById`, which
/// only changes when a `summary` apply runs.
export const useMediaById = (id: string | null | undefined): MediaSummary | undefined =>
  useProjectStore((s) => (id ? s.mediaById.get(id) : undefined));

// Reused empty sentinels so `?? []` doesn't allocate a fresh array on
// every render (which would defeat referential-equality short-circuits
// in any caller doing `useShallow` over derived combinations).
const EMPTY_ROLES: RoleMixView[] = [];
const EMPTY_MARKERS: MarkerSummary[] = [];
