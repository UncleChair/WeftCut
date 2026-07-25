// Per-audio-layer sync offset, in SAMPLES, surfaced as the clip badge (ADR 0038 /
// spec R2-D7). Recomputed from project geometry whenever tracks/groups change, and
// read via ATOMIC selectors only (`feedback_zustand_composite_selector` — never
// select the whole map object).
//
// A store rather than a prop threaded Timeline → TrackLane → LayerBlock, following
// the `motifBakeStatusStore` precedent one file over: the badge is a per-clip
// annotation, so a store selector re-renders the ONE clip whose offset changed
// instead of every lane on every project update.
//
// An ABSENT layerId means "nothing to show" — either not audio, not grouped with a
// visual member, or genuinely in sync. The value is never stored in the project: it
// IS the geometry, so no field can disagree with it.

import { create } from "zustand";
import { syncOffsetSamples, type SlipLayer } from "./audioSlip";

interface State {
  byLayer: Record<string, number>;
  replace: (next: Record<string, number>) => void;
}

export const useAudioSyncOffsetStore = create<State>((set) => ({
  byLayer: {},
  replace: (next) => set({ byLayer: next }),
}));

/// Pure lookup (unit-tested); the hook wraps it so the badge's selector returns a
/// primitive and re-renders only when this clip's own offset moves.
export const selectAudioSyncOffset = (
  byLayer: Record<string, number>,
  layerId: string,
): number | null => byLayer[layerId] ?? null;

export const useAudioSyncOffset = (layerId: string): number | null =>
  useAudioSyncOffsetStore((s) => selectAudioSyncOffset(s.byLayer, layerId));

/// Derive every non-zero audio sync offset from the current geometry.
///
/// Only NON-ZERO entries are stored, which is what makes "absent ⇒ nothing to show"
/// true and keeps the map empty for the overwhelmingly common in-sync project.
export function deriveAudioSyncOffsets(
  layers: readonly SlipLayer[],
  groups: readonly { id: string; layer_ids: string[] }[],
): Record<string, number> {
  if (groups.length === 0) return {};
  const byId = new Map(layers.map((l) => [l.id, l]));
  const out: Record<string, number> = {};
  for (const g of groups) {
    const members = g.layer_ids
      .map((id) => byId.get(id))
      .filter((l): l is SlipLayer => l !== undefined);
    for (const m of members) {
      if (m.kind !== "Audio") continue;
      const offset = syncOffsetSamples(m, members);
      if (offset !== null && offset !== 0) out[m.id] = offset;
    }
  }
  return out;
}

/// Publish the derived map. Guarded on shallow equality so an unrelated project
/// update (a rename, a param edit) is not a store write — a write would re-render
/// every badge subscriber for nothing.
export function setAudioSyncOffsets(next: Record<string, number>): void {
  const cur = useAudioSyncOffsetStore.getState().byLayer;
  const curKeys = Object.keys(cur);
  const nextKeys = Object.keys(next);
  if (curKeys.length === nextKeys.length && nextKeys.every((k) => cur[k] === next[k])) return;
  useAudioSyncOffsetStore.getState().replace(next);
}
