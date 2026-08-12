import { useMemo } from "react";

/// A zero-size virtual element at the cursor, for a floating context menu's
/// `anchor` (Base UI `Positioner`). Shared by the timeline's right-click menus
/// so a second one cannot drift into different popup geometry from the first.
export function useCursorAnchor(x: number, y: number) {
  return useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x,
        y,
        top: y,
        left: x,
        right: x,
        bottom: y,
        width: 0,
        height: 0,
      }),
    }),
    [x, y],
  );
}
