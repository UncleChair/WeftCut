import { type LayerSummary, type TrackSummary } from "../ipc";

/** Resolve the primary Layer from the Project summary supplied to a tool Panel. */
export function findPanelLayer(
  tracks: TrackSummary[],
  layerId: string | null,
): LayerSummary | null {
  if (!layerId) return null;
  for (const track of tracks) {
    const layer = track.layers.find((candidate) => candidate.id === layerId);
    if (layer) return layer;
  }
  return null;
}

/**
 * Effects render on visual sprite kinds only. The allowlist keeps future
 * non-visual Layer kinds from accidentally inheriting a visual effect chain.
 */
export function isVisualKind(kind: string): boolean {
  return (
    kind === "Text" ||
    kind === "VideoClip" ||
    kind === "ImageOverlay" ||
    kind === "Color" ||
    kind === "Motif"
  );
}
