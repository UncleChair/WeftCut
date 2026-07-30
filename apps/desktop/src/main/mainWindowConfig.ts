export const MAIN_WINDOW_MINIMUM_SIZE = {
  minWidth: 960,
  minHeight: 640,
} as const;

/// Size for a first launch, or whenever the saved geometry is unusable (stale
/// monitor, shrunken resolution, corrupt file — see windowGeometry.ts). No x/y:
/// Chromium centers a window whose position is absent.
export const MAIN_WINDOW_DEFAULT_SIZE = {
  width: 1440,
  height: 900,
} as const;

/// Key under which the main window's geometry is persisted in
/// <userData>/window_geometry.json. A COMPATIBILITY SURFACE — renaming it
/// silently discards every existing user's saved position.
export const MAIN_WINDOW_LABEL = "main";

/// Combined defaults for the geometry sanitizer, which clamps a restored rect
/// against both the fallback size and the window's own minimums.
export const MAIN_WINDOW_GEOMETRY_DEFAULTS = {
  ...MAIN_WINDOW_DEFAULT_SIZE,
  ...MAIN_WINDOW_MINIMUM_SIZE,
} as const;
