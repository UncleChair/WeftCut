import { create } from "zustand";

/// The "rename this marker" prompt, as module-level state — the
/// `checkpointPrompt.ts` shape plus the one parameter it lacked.
///
/// It cannot be owned by the ruler: the `M` command's same-frame branch has to
/// work with the timeline panel CLOSED, and a dialog owned by an unmounted
/// ruler would simply never render. So App renders the dialog and both entry
/// points — the marker context menu and the command — only set this id.

interface MarkerRenamePromptState {
  markerId: string | null;
}

export const useMarkerRenamePromptStore = create<MarkerRenamePromptState>(
  () => ({ markerId: null }),
);

export function openMarkerRenamePrompt(markerId: string): void {
  useMarkerRenamePromptStore.setState({ markerId });
}

export function closeMarkerRenamePrompt(): void {
  useMarkerRenamePromptStore.setState({ markerId: null });
}
