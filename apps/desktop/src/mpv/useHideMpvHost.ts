import { useEffect, type RefObject } from "react";

import { mpvSetHostClip, mpvSetHostVisible } from "../ipc";

// Refcount of overlays that need the libmpv host hidden. The host HWND
// sits on top of WebView2 in HWND z-order, so any DOM overlay (dropdown
// menus, modal panels) whose rect intersects the preview area would be
// painted under the host AND have its mouse events intercepted by the
// host. We hide the host whenever ANY overlay is mounted and re-show it
// when the last one unmounts. A counter (not a boolean) avoids races
// when one overlay closes as another opens — the visible state only
// flips at the transitions to/from zero.
let count = 0;

function increment() {
  count += 1;
  if (count === 1) {
    mpvSetHostVisible(false).catch((err) => {
      console.warn("hide mpv host failed:", err);
    });
  }
}

function decrement() {
  count = Math.max(0, count - 1);
  if (count === 0) {
    mpvSetHostVisible(true).catch((err) => {
      console.warn("show mpv host failed:", err);
    });
  }
}

/// Hide the libmpv embed host HWND while the calling component is
/// mounted. Use for **full-screen overlays** (modal panels) where the
/// entire preview disappearing is the right UX. For partial overlays
/// (dropdown menus), use `useMpvHostClip` instead so the preview keeps
/// showing in the area around the overlay.
export function useHideMpvHost() {
  useEffect(() => {
    increment();
    return () => decrement();
  }, []);
}

/// Punch a rectangular hole in the libmpv embed host HWND so this
/// component (measured via its DOM ref) shows through the preview area
/// while it's mounted. Restores the full host on unmount. Use for
/// **partial overlays** (dropdown menus, popovers) where hiding the
/// whole preview would be excessive.
///
/// The element's rect is measured once on mount; if your overlay can
/// change size while mounted, pass a `version` dep that bumps on resize.
export function useMpvHostClip(
  ref: RefObject<HTMLElement | null>,
  version: unknown = null,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    mpvSetHostClip({
      x: Math.round(r.left * dpr),
      y: Math.round(r.top * dpr),
      w: Math.round(r.width * dpr),
      h: Math.round(r.height * dpr),
    }).catch((err) => {
      console.warn("set mpv host clip failed:", err);
    });
    return () => {
      mpvSetHostClip(null).catch((err) => {
        console.warn("clear mpv host clip failed:", err);
      });
    };
    // `version` is intentionally a re-measure trigger — callers bump it
    // when the element they passed has resized or moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, version]);
}
