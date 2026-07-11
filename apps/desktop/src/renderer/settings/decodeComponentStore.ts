// Renderer mirror of the native-decode component's availability (level-0
// gate). Fetched once on mount — availability can't change within a process
// lifetime (the require is memoized in main).
import { create } from "zustand";
import type { DecodeComponentStatus } from "../../shared/ipc";

interface DecodeComponentState extends DecodeComponentStatus {
  loaded: boolean;
  hydrate: (s: DecodeComponentStatus) => void;
}

export const useDecodeComponentStore = create<DecodeComponentState>((set) => ({
  available: false,
  reason: null,
  version: null,
  loaded: false,
  hydrate: (s) => set({ ...s, loaded: true }),
}));

// Atomic selectors (feedback_zustand_composite_selector).
export const useDecodeComponentAvailable = (): boolean =>
  useDecodeComponentStore((s) => s.available);
export const useDecodeComponentReason = (): string | null =>
  useDecodeComponentStore((s) => s.reason);

export async function wireDecodeComponent(): Promise<void> {
  try {
    const status = await window.api.decodeComponent.status();
    useDecodeComponentStore.getState().hydrate(status);
  } catch (e) {
    console.warn("decodeComponent.status failed:", e);
  }
}
