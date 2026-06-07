// Per-template-layer L2 bake status, surfaced to the timeline dot + property
// panel. Written by the Compositor (which maps active template layers →
// cacheKey → status); read via ATOMIC selectors only (per
// `feedback_zustand_composite_selector` — never select the whole map object).
//
// An ABSENT layerId means idle (not baking, nothing on disk) — selectors
// return null for it, and the dot renders nothing.

import { create } from "zustand";

export interface LayerBakeStatus {
  phase: "warming" | "baking" | "ready" | "error";
  done: number;
  total: number;
}

interface State {
  byLayer: Record<string, LayerBakeStatus>;
  replace: (next: Record<string, LayerBakeStatus>) => void;
}

export const useTemplateBakeStatusStore = create<State>((set) => ({
  byLayer: {},
  replace: (next) => set({ byLayer: next }),
}));

/// Replace the whole map. The Compositor recomputes the full (small) map each
/// time, so per-key diffing isn't worth it.
export function setLayerBakeStatuses(next: Record<string, LayerBakeStatus>): void {
  useTemplateBakeStatusStore.getState().replace(next);
}

// Pure lookups (unit-tested); the hooks wrap them so the dot's selector returns
// a primitive (phase string) and doesn't re-render on `done` ticks.
export const selectLayerBakePhase = (
  byLayer: Record<string, LayerBakeStatus>,
  layerId: string,
): LayerBakeStatus["phase"] | null => byLayer[layerId]?.phase ?? null;

export const selectLayerBakeStatus = (
  byLayer: Record<string, LayerBakeStatus>,
  layerId: string,
): LayerBakeStatus | null => byLayer[layerId] ?? null;

/// Dot: phase only (primitive → re-renders only on phase change).
export const useLayerBakePhase = (layerId: string): LayerBakeStatus["phase"] | null =>
  useTemplateBakeStatusStore((s) => selectLayerBakePhase(s.byLayer, layerId));

/// Panel: full status (object → re-renders the one selected panel on progress).
export const useLayerBakeStatus = (layerId: string): LayerBakeStatus | null =>
  useTemplateBakeStatusStore((s) => selectLayerBakeStatus(s.byLayer, layerId));

/// Reduce a layer's (optional live bake status, L0 coverage, baked-on-disk flag)
/// to the single status the timeline/panel shows. Bake takes precedence (it is
/// the stronger "persisted to disk" guarantee). Otherwise L0 coverage drives a
/// `warming`→`ready` bar; zero coverage with nothing on disk is idle (null).
export function motifWarmPhase(
  bake: LayerBakeStatus | null,
  covered: number,
  total: number,
  bakedOnDisk = false,
): LayerBakeStatus | null {
  if (bake) return bake;
  if (covered >= total && total > 0) return { phase: "ready", done: total, total };
  if (covered > 0) return { phase: "warming", done: covered, total };
  if (bakedOnDisk) return { phase: "ready", done: total, total };
  return null;
}
