import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  projectSummary,
  type LayerSummary,
  type MediaSummary,
  type ProjectSummary,
  type TrackSummary,
} from "../ipc";

/// Frontend mirror of the Rust `Project` actor's state, kept in sync via
/// `project:changed` Tauri events. The DOM preview engine consumes this
/// directly (no `emit_dom` IR target per `docs/preview-dom.md` Q6).
///
/// Atomic selectors only — composite-object selectors infinite-loop
/// `useSyncExternalStore` per `feedback_zustand_composite_selector`.
/// Helpers below select a single field at a time; for derived combos
/// use `useShallow` from `zustand/shallow` at the call site.
///
/// Pre-workspace: `summary` is `null`; consumers should guard.
///
/// `App.tsx`'s existing local-state fetch coexists with this store for
/// the duration of the `feat/preview-dom` branch — both subscribe to
/// `project:changed`, both re-fetch, no cross-talk. App.tsx migrates to
/// the store at Phase F cutover.

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
  /// Apply a fresh summary snapshot, rebuilding lookup indices.
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

  apply: (summary) =>
    set({
      summary,
      ...buildIndices(summary),
      ready: true,
    }),
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
  const refresh = async () => {
    try {
      const s = await projectSummary();
      useProjectStore.getState().apply(s);
    } catch {
      // No project loaded — leave summary null but mark ready so
      // consumers can distinguish from the pre-fetch state.
      useProjectStore.getState().apply(null);
    }
  };
  await refresh();
  return await listen("project:changed", () => {
    void refresh();
  });
}

// ===== Atomic selector helpers ============================================
// Each returns ONE field (or a value derived from one field) so React's
// `useSyncExternalStore` doesn't infinite-loop on referential equality.

export const useProjectSummary = (): ProjectSummary | null =>
  useProjectStore((s) => s.summary);

export const useProjectReady = (): boolean =>
  useProjectStore((s) => s.ready);

export const useProjectMedia = (): MediaSummary[] =>
  useProjectStore((s) => s.summary?.media ?? EMPTY_MEDIA);

export const useProjectTracks = (): TrackSummary[] =>
  useProjectStore((s) => s.summary?.tracks ?? EMPTY_TRACKS);

export const useProjectDurationUs = (): number =>
  useProjectStore((s) => s.summary?.duration_us ?? 0);

/// Resolve a media item by id without forcing the caller to subscribe
/// to the whole media array. The selector reads from `mediaById`, which
/// only changes when a `summary` apply runs.
export const useMediaById = (id: string | null | undefined): MediaSummary | undefined =>
  useProjectStore((s) => (id ? s.mediaById.get(id) : undefined));

/// Resolve a layer by id. Used by the DOM preview's `<Layer>` component
/// to look up its own params each render without re-walking tracks.
export const useLayerById = (id: string | null | undefined): LayerSummary | undefined =>
  useProjectStore((s) => (id ? s.layerById.get(id) : undefined));

/// Returns the effective preview path for a media item. Preview may use a
/// quick proxy while the full proxy is still rendering; export must not.
export function previewPlaybackPathFor(media: MediaSummary | undefined): string | null {
  if (!media) return null;
  if (media.kind === "Video") {
    // Prefer the light quick proxy for preview. The full proxy is now a
    // source-resolution EXPORT master (heavy to scrub); it's a last-resort
    // preview source only if no quick proxy exists (ADR 0011).
    if (media.quick_proxy_path) return media.quick_proxy_path;
    if (media.proxy_path) return media.proxy_path;
    // Preview from the original ONLY for DirectBoth (proxy_bypassed = H.264);
    // a DirectExport source before its quick proxy lands stays null (blank).
    return media.proxy_bypassed ? media.path : null;
  }
  return media.path;
}

/// Returns the effective export path for a media item. Quick proxies are
/// intentionally excluded because they are low-quality preview artifacts.
export function exportPlaybackPathFor(media: MediaSummary | undefined): string | null {
  if (!media) return null;
  if (media.kind === "Video") {
    if (media.proxy_path) return media.proxy_path;
    return media.proxy_bypassed || media.export_uses_original
      ? media.path
      : null;
  }
  return media.path;
}

// Reused empty sentinels so `?? []` doesn't allocate a fresh array on
// every render (which would defeat referential-equality short-circuits
// in any caller doing `useShallow` over derived combinations).
const EMPTY_MEDIA: MediaSummary[] = [];
const EMPTY_TRACKS: TrackSummary[] = [];
