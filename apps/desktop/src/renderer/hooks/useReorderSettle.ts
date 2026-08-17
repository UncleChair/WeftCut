import { useEffect, useLayoutEffect, useRef } from "react";

/// How long a dropped row is held at its release position while the reorder
/// op round-trips (the mutation is async IPC — the new order arrives renders
/// later). A landing after this window animates nothing: the drop was
/// rejected or lost, and the row glides back home instead.
const HOLD_MS = 300;

interface PendingSettle {
  /// The row to land, resolved to a live element per render.
  id: string;
  /// Visual top at release — the pointer-follow transform still applied.
  releaseTop: number;
  /// The row's layout top before the reorder lands. Measured on the first
  /// post-drop render (the drag transform is gone by then), so the effect
  /// can tell "old order still on screen" from "new order landed".
  fromTop: number | null;
  timer: number | null;
}

/// Landing glide for a pointer-reorder consumer. `arm` at drop with the
/// still-floating row element; on the render where the list's new order
/// actually lands, the row glides from where the user released it into its
/// new slot instead of teleporting. Until that render arrives, the row is
/// held at its release position so it never flashes back to the old slot.
/// Honors prefers-reduced-motion by never arming.
export function useReorderSettle(resolve: (id: string) => HTMLElement | null) {
  const pendingRef = useRef<PendingSettle | null>(null);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  // Inline-style glide from wherever the transform currently puts the row
  // into its resting slot; the styles clean themselves up at transition end.
  const glide = (el: HTMLElement) => {
    void el.getBoundingClientRect(); // flush the start position
    el.style.transition = "transform var(--transition-base)";
    el.style.transform = "";
    const done = () => {
      el.style.transition = "";
      el.removeEventListener("transitionend", done);
    };
    el.addEventListener("transitionend", done);
  };

  // Runs every render on purpose: the render that brings the new order is
  // not knowable in advance (the op is async), so each one is inspected
  // until the pending settle is consumed or times out.
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    const el = resolveRef.current(pending.id);
    if (!el) {
      // The row left the list entirely (playhead moved on) — nothing to land.
      if (pending.timer !== null) clearTimeout(pending.timer);
      pendingRef.current = null;
      return;
    }
    const top = el.getBoundingClientRect().top;
    if (pending.fromTop === null) pending.fromTop = top;
    if (Math.abs(top - pending.fromTop) < 0.5) {
      // Old order still on screen — hold the row at its release position.
      el.style.transition = "none";
      el.style.transform = `translateY(${pending.releaseTop - top}px)`;
      if (pending.timer === null) {
        pending.timer = window.setTimeout(() => {
          pendingRef.current = null;
          glide(el);
        }, HOLD_MS);
      }
      return;
    }
    // The new order landed: glide from the release position into the slot.
    if (pending.timer !== null) clearTimeout(pending.timer);
    pendingRef.current = null;
    el.style.transition = "none";
    el.style.transform = `translateY(${pending.releaseTop - top}px)`;
    glide(el);
  });

  useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (pending?.timer != null) clearTimeout(pending.timer);
      pendingRef.current = null;
    },
    [],
  );

  return {
    /// Call at drop, while the row element still carries its pointer-follow
    /// transform — the release position is measured here.
    arm: (id: string, el: HTMLElement) => {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        return;
      }
      const prior = pendingRef.current;
      if (prior?.timer != null) clearTimeout(prior.timer);
      pendingRef.current = {
        id,
        releaseTop: el.getBoundingClientRect().top,
        fromTop: null,
        timer: null,
      };
    },
    /// Abandon a pending settle and its inline hold — a new gesture on the
    /// same list must start from clean styles.
    cancel: () => {
      const pending = pendingRef.current;
      if (!pending) return;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pendingRef.current = null;
      const el = resolveRef.current(pending.id);
      if (el) {
        el.style.transition = "";
        el.style.transform = "";
      }
    },
  };
}
