import { create } from "zustand";

/// App-global single-selection (which layer the inspector shows). Lifted
/// out of App.tsx useState so non-React callers — search-palette
/// navigation, future MCP-driven UI — can select without threading the
/// component tree. Timeline's multi-select set for group ops stays
/// Timeline-local.
interface State {
  selectedLayerId: string | null;
}

export const useSelectionStore = create<State>(() => ({
  selectedLayerId: null,
}));

export function setSelectedLayerId(id: string | null): void {
  if (useSelectionStore.getState().selectedLayerId !== id) {
    useSelectionStore.setState({ selectedLayerId: id });
  }
}

export function selectedLayerId(): string | null {
  return useSelectionStore.getState().selectedLayerId;
}

export const useSelectedLayerId = (): string | null =>
  useSelectionStore((s) => s.selectedLayerId);
