import { create } from "zustand";

/// The "name your checkpoint" prompt, as module-level state.
///
/// It cannot be owned by the History Panel: the create-checkpoint command
/// (Edit menu + palette) has to work with the Panel CLOSED, and a dialog owned
/// by an unmounted Panel would simply never render. So App renders the dialog
/// and both entry points — the Panel's section header and the command — only
/// flip this flag. Same module-level-registry shape `state/navigation.ts` uses
/// to let two unconnected surfaces reach one implementation.
///
/// Deliberately NOT part of `historyStore`: that store mirrors the wire, and a
/// transient piece of dialog chrome has no business in it.

interface CheckpointPromptState {
  open: boolean;
}

export const useCheckpointPromptStore = create<CheckpointPromptState>(() => ({
  open: false,
}));

export function openCheckpointPrompt(): void {
  useCheckpointPromptStore.setState({ open: true });
}

export function closeCheckpointPrompt(): void {
  useCheckpointPromptStore.setState({ open: false });
}
