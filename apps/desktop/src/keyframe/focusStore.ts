// Which (layer, param) the inspector last focused — drives which property's
// diamonds the collapsed clip renders. Atomic selectors only (per
// feedback_zustand_composite_selector — never select a composite object).
import { create } from "zustand";

interface State {
  layerId: string | null;
  paramKey: string | null;
}

export const useKeyframeFocusStore = create<State>(() => ({ layerId: null, paramKey: null }));

export function setKeyframeFocus(layerId: string, paramKey: string): void {
  useKeyframeFocusStore.setState({ layerId, paramKey });
}

export function clearKeyframeFocus(): void {
  useKeyframeFocusStore.setState({ layerId: null, paramKey: null });
}

/// The focused param FOR a given layer, or null when another layer is focused.
export function useFocusedParamFor(layerId: string): string | null {
  return useKeyframeFocusStore((s) => (s.layerId === layerId ? s.paramKey : null));
}

/// The focused paramKey IF the focused layer belongs to `layerIds`, else null.
/// Atomic primitive return (string|null) — safe under useSyncExternalStore
/// (per the zustand composite-selector rule). `layerIds` must be a stable Set.
export function useFocusedParamKeyForTrackLayers(layerIds: Set<string>): string | null {
  return useKeyframeFocusStore((s) => (s.layerId && layerIds.has(s.layerId) ? s.paramKey : null));
}
