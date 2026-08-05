// The one handshake between the on-canvas gizmo and the preview: PixiPreview
// registers a geometry probe on mount, the overlay consumes it without knowing
// Pixi exists. Same lifecycle pattern as `colorpick/previewSamplerRegistry.ts`
// (register on init, identity-guarded clear on unmount).
//
// Deliberately separate from PreviewSampler: that interface is the colour
// picker's read-back contract, and a gizmo needs no pixels at all.

export interface GizmoProbe {
  /// The canvas element's CSS-px bounds, null pre-mount. The overlay maps
  /// composition→client through this box, so it must be the CANVAS rect and not
  /// the panel's — the canvas is contain-sized inside the panel.
  canvasRect(): DOMRect | null;
  /// The layer's untransformed content size in composition pixels, or null when
  /// nothing is staged for it yet (`Compositor.naturalSizeOf`).
  naturalSizeOf(layerId: string): { w: number; h: number } | null;
}

let probe: GizmoProbe | null = null;

export function registerGizmoProbe(p: GizmoProbe): void {
  probe = p;
}

/// Identity-guarded: a stale unmount can't tear down a newer mount's probe.
export function clearGizmoProbe(p: GizmoProbe): void {
  if (probe === p) probe = null;
}

export function getGizmoProbe(): GizmoProbe | null {
  return probe;
}
