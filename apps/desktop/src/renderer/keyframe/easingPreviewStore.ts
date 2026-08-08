// Transient bridge from the easing popover's Elastic sliders to whichever
// curve graph renders the owning keyframe: while a slider drags, the graph
// substitutes this interp for the committed one, so the curve redraws live
// without a per-move actor commit (one commit per gesture, same as a tangent
// handle drag). Keyed by kfId alone — keyframe ids are UUIDs, globally unique
// across layers/params, so the preview routes to exactly one segment. The
// menu owns the lifecycle (set while dragging, cleared on unmount); graphs
// only read. Transient — not persisted, not undo. Atomic selectors only — a
// composite object selector built in the selector body re-renders forever
// under zustand; `preview` is replaced wholesale, so selecting it is
// reference-stable.
import { create } from "zustand";
import type { Interpolation } from "../ipc";

export interface EasingPreview {
  kfId: string;
  interp: Interpolation;
}

interface State {
  preview: EasingPreview | null;
}

export const useEasingPreviewStore = create<State>(() => ({ preview: null }));

export function setEasingPreview(kfId: string, interp: Interpolation): void {
  useEasingPreviewStore.setState({ preview: { kfId, interp } });
}

/// Scoped clear: an unmounting menu passes its kfId so it can never wipe a
/// preview a newer menu (another keyframe) has already claimed.
export function clearEasingPreview(kfId?: string): void {
  const p = useEasingPreviewStore.getState().preview;
  if (!p) return;
  if (kfId !== undefined && p.kfId !== kfId) return;
  useEasingPreviewStore.setState({ preview: null });
}

export function getEasingPreview(): EasingPreview | null {
  return useEasingPreviewStore.getState().preview;
}
