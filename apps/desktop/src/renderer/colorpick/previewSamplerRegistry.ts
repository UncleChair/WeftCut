// The one handshake between the color picker and the preview: PixiPreview
// registers a sampling surface on mount (same lifecycle pattern as
// registerTransport in state/playbackStore.ts); the pick session and overlay
// consume it without knowing Pixi exists.

import type { FrameBuffer } from "./pixel";

export interface PreviewSampler {
  /// One full-frame working-space freeze (composition resolution).
  /// `excludeEffectId` disables that effect's filter for the freeze so the
  /// sample matches the shader's INPUT (the chromakey feedback-loop fix).
  captureFrame(opts?: { excludeEffectId?: string }): Promise<FrameBuffer>;
  /// CSS-px client point → composition pixel (letterbox-aware), or null when
  /// the point is outside the composition content.
  mapClientToComposition(clientX: number, clientY: number): { x: number; y: number } | null;
  /// The canvas element's CSS-px bounds for region hit-testing, null pre-mount.
  canvasRect(): DOMRect | null;
}

let sampler: PreviewSampler | null = null;

export function registerPreviewSampler(s: PreviewSampler): void {
  sampler = s;
}

/// Identity-guarded: a stale unmount can't tear down a newer mount's sampler.
export function clearPreviewSampler(s: PreviewSampler): void {
  if (sampler === s) sampler = null;
}

export function getPreviewSampler(): PreviewSampler | null {
  return sampler;
}
