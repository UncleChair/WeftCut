import { create } from "zustand";

/// Renderer-global Layer selection. `primaryLayerId` drives contextual tools;
/// `selectedLayerIds` is the complete selection used by Timeline group
/// operations and every other selection-aware surface.
export interface LayerSelectionState {
  primaryLayerId: string | null;
  selectedLayerIds: ReadonlySet<string>;
}

const EMPTY_SELECTED_LAYER_IDS: ReadonlySet<string> = new Set();

export const useSelectionStore = create<LayerSelectionState>(() => ({
  primaryLayerId: null,
  selectedLayerIds: EMPTY_SELECTED_LAYER_IDS,
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
): void {
  const nextIds = new Set(requestedIds);
  if (requestedPrimaryId !== null) nextIds.add(requestedPrimaryId);

  const nextPrimaryId =
    nextIds.size === 0
      ? null
      : requestedPrimaryId !== null
        ? requestedPrimaryId
        : (nextIds.values().next().value ?? null);
  const current = useSelectionStore.getState();
  if (
    current.primaryLayerId === nextPrimaryId &&
    equalIds(current.selectedLayerIds, nextIds)
  ) {
    return;
  }

  useSelectionStore.setState({
    primaryLayerId: nextPrimaryId,
    selectedLayerIds:
      nextIds.size === 0 ? EMPTY_SELECTED_LAYER_IDS : nextIds,
  });
}

/// Replace the complete selection atomically. A non-null requested primary is
/// included automatically; a non-empty set without a requested primary uses
/// its first Layer as primary. The resulting state therefore always satisfies
/// `primary === null ⇔ selected.size === 0` and `selected.has(primary)`.
export function setLayerSelection(
  primaryLayerId: string | null,
  selectedLayerIds: Iterable<string>,
): void {
  commitSelection(primaryLayerId, selectedLayerIds);
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
  commitSelection(primaryLayerId, nextIds);
}

export function clearLayerSelection(): void {
  commitSelection(null, EMPTY_SELECTED_LAYER_IDS);
}

/// Drop selections that no longer resolve in the current Project snapshot.
/// If the former primary disappeared while another selected Layer remains,
/// the first surviving Layer becomes primary.
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
  commitSelection(retainedPrimary, retained);
}

/// Compatibility entry point for existing single-Layer surfaces. This is a
/// replacement selection, never a primary-only mutation.
export function setSelectedLayerId(id: string | null): void {
  if (id === null) clearLayerSelection();
  else commitSelection(id, [id]);
}

export function selectedLayerId(): string | null {
  return useSelectionStore.getState().primaryLayerId;
}

export function selectedLayerIds(): ReadonlySet<string> {
  return useSelectionStore.getState().selectedLayerIds;
}

export const usePrimaryLayerId = (): string | null =>
  useSelectionStore((state) => state.primaryLayerId);

export const useSelectedLayerIds = (): ReadonlySet<string> =>
  useSelectionStore((state) => state.selectedLayerIds);

/// Compatibility hook while existing contextual components still call their
/// primary prop `selectedLayerId`.
export const useSelectedLayerId = usePrimaryLayerId;
