import { create } from "zustand";

/// Ephemeral "which layer is being renamed inline" focus state. Lives in a
/// store (not Timeline state) so both the double-click handler in LayerBlock
/// and the context-menu "Rename" item can drive it without prop-drilling the
/// trigger through TrackLane. Atomic selector only — never select a composite
/// object (feedback_zustand_composite_selector).
interface RenameState {
  editingLayerId: string | null;
  beginRename: (layerId: string) => void;
  endRename: () => void;
}

export const useRenameStore = create<RenameState>((set) => ({
  editingLayerId: null,
  beginRename: (layerId) => set({ editingLayerId: layerId }),
  endRename: () => set({ editingLayerId: null }),
}));

export const useEditingLayerId = (): string | null =>
  useRenameStore((s) => s.editingLayerId);

export const beginRename = (layerId: string): void =>
  useRenameStore.getState().beginRename(layerId);

export const endRename = (): void => useRenameStore.getState().endRename();
