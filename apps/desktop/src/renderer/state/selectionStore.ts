import { create } from "zustand";

/// Renderer-global Layer selection. `primaryLayerId` drives contextual tools;
/// `selectedLayerIds` is the complete selection used by Timeline group
/// operations and every other selection-aware surface.
/// `selectedTransitionId` is the selected transition chip — mutually
/// exclusive with layer selection (selecting either deselects the other),
/// so Delete and the Attribute panel always have exactly one target.
export interface LayerSelectionState {
  primaryLayerId: string | null;
  selectedLayerIds: ReadonlySet<string>;
  selectedTransitionId: string | null;
}

const EMPTY_SELECTED_LAYER_IDS: ReadonlySet<string> = new Set();

export const useSelectionStore = create<LayerSelectionState>(() => ({
  primaryLayerId: null,
  selectedLayerIds: EMPTY_SELECTED_LAYER_IDS,
  selectedTransitionId: null,
}));

function equalIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function commitSelection(
  requestedPrimaryId: string | null,
  requestedIds: Iterable<string>,
  requestedTransitionId: string | null,
): void {
  const nextIds = new Set(requestedIds);
  if (requestedPrimaryId !== null) nextIds.add(requestedPrimaryId);

  const nextPrimaryId =
    nextIds.size === 0
      ? null
      : requestedPrimaryId !== null
        ? requestedPrimaryId
        : (nextIds.values().next().value ?? null);
  // Mutual exclusion: a non-empty layer selection always evicts the
  // transition chip selection, whatever the caller passed.
  const nextTransitionId = nextIds.size > 0 ? null : requestedTransitionId;
  const current = useSelectionStore.getState();
  if (
    current.primaryLayerId === nextPrimaryId &&
    current.selectedTransitionId === nextTransitionId &&
    equalIds(current.selectedLayerIds, nextIds)
  ) {
    return;
  }

  useSelectionStore.setState({
    primaryLayerId: nextPrimaryId,
    selectedLayerIds:
      nextIds.size === 0 ? EMPTY_SELECTED_LAYER_IDS : nextIds,
    selectedTransitionId: nextTransitionId,
  });
}

/// Replace the complete selection atomically. A non-null requested primary is
/// included automatically; a non-empty set without a requested primary uses
/// its first Layer as primary. The resulting state therefore always satisfies
/// `primary === null ⇔ selected.size === 0` and `selected.has(primary)`.
/// Any transition chip selection is dropped (mutual exclusion).
export function setLayerSelection(
  primaryLayerId: string | null,
  selectedLayerIds: Iterable<string>,
): void {
  commitSelection(primaryLayerId, selectedLayerIds, null);
}

/// Add Layers to the current selection and make `primaryLayerId` primary in
/// the same store update. Timeline uses this for its existing Shift+click
/// additive selection gesture.
export function extendLayerSelection(
  primaryLayerId: string,
  layerIds: Iterable<string>,
): void {
  const nextIds = new Set(useSelectionStore.getState().selectedLayerIds);
  for (const id of layerIds) nextIds.add(id);
  commitSelection(primaryLayerId, nextIds, null);
}

/// Deselect everything — layers AND the transition chip (background-click /
/// project-switch semantics).
export function clearLayerSelection(): void {
  commitSelection(null, EMPTY_SELECTED_LAYER_IDS, null);
}

/// Select a transition chip. Deselects all layers in the same store update
/// (the app's selection idiom: one selected entity kind at a time).
export function setTransitionSelection(transitionId: string): void {
  commitSelection(null, EMPTY_SELECTED_LAYER_IDS, transitionId);
}

export function clearTransitionSelection(): void {
  const current = useSelectionStore.getState();
  commitSelection(current.primaryLayerId, current.selectedLayerIds, null);
}

/// Drop selections that no longer resolve in the current Project snapshot.
/// If the former primary disappeared while another selected Layer remains,
/// the first surviving Layer becomes primary. The transition selection is
/// preserved — `retainTransitionSelection` owns its lifecycle.
export function retainLayerSelection(validLayerIds: Iterable<string>): void {
  const valid = new Set(validLayerIds);
  const current = useSelectionStore.getState();
  const retained = new Set<string>();
  for (const id of current.selectedLayerIds) {
    if (valid.has(id)) retained.add(id);
  }
  const retainedPrimary =
    current.primaryLayerId !== null && retained.has(current.primaryLayerId)
      ? current.primaryLayerId
      : null;
  commitSelection(retainedPrimary, retained, current.selectedTransitionId);
}

/// Drop a transition selection whose id vanished from the snapshot (removed,
/// reconcile-dropped, or undone away).
export function retainTransitionSelection(
  validTransitionIds: Iterable<string>,
): void {
  const current = useSelectionStore.getState();
  if (current.selectedTransitionId === null) return;
  for (const id of validTransitionIds) {
    if (id === current.selectedTransitionId) return;
  }
  clearTransitionSelection();
}

export const usePrimaryLayerId = (): string | null =>
  useSelectionStore((state) => state.primaryLayerId);

export const useSelectedLayerIds = (): ReadonlySet<string> =>
  useSelectionStore((state) => state.selectedLayerIds);

export const useSelectedTransitionId = (): string | null =>
  useSelectionStore((state) => state.selectedTransitionId);
