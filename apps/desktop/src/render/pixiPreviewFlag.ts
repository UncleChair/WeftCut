// Activation flag + handle type for the PixiJS preview surface,
// kept in a non-component module so Vite's React Fast Refresh
// doesn't bail on `PixiPreview.tsx` ("component file exports
// non-component values").
//
// Plan: docs/pixi-renderer-plan.md (P2)

/// Decides whether the user has opted into the new PixiJS preview.
/// True if either:
///   - URL has `?pixi=1` (or `?pixi=true`), OR
///   - `localStorage.weftcut.preview.pixi === "1"`.
export function isPixiPreviewEnabled(): boolean {
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get("pixi");
    if (q === "1" || q === "true") return true;
  } catch {
    // not a browser
  }
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("weftcut.preview.pixi") === "1";
    }
  } catch {
    // storage disabled
  }
  return false;
}

/// Transport interface exposed by `<PixiPreview ref={...}>`. Mirrors
/// `PreviewSurfaceHandle` so the parent's imperative handle can
/// forward play/pause/seek straight through to the underlying PIXI
/// `PlaybackEngine` when the flag is on.
export interface PixiPreviewHandle {
  play(): void;
  pause(): void;
  seek(tUs: number): void;
  paused(): boolean;
}
