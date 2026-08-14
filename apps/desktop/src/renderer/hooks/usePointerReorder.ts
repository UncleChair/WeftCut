import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/// An in-progress list-reorder gesture. `gap` is the insertion slot in
/// [0..rowIds.length]: the dragged row would land before row `gap`.
export interface ReorderDrag {
  /// Row id captured at gesture start (`rowIds[fromIndex]` at pointerdown).
  id: string;
  /// The dragged row's index at gesture start.
  fromIndex: number;
  /// Current insertion slot, derived from live row rects.
  gap: number;
}

export interface PointerReorderOptions {
  /// Ids of the reorderable rows, in on-screen order. Read per render, so the
  /// pointerdown always resolves against the list currently displayed.
  rowIds: readonly string[];
  /// Fired exactly once per completed gesture — at drop, never mid-gesture —
  /// and only when the drop gap actually moves the row (a drop on the row's
  /// own gap is a silent no-op, matching the indicator). The consumer decides
  /// what one thing to fire.
  onDrop: (drop: ReorderDrag) => void;
}

export interface PointerReorder {
  /// The live gesture, or null when idle. Non-null also means "reordering":
  /// consumers key their container/row drag styling off it.
  drag: ReorderDrag | null;
  /// The gap to draw an insertion indicator at, or null (idle, or the gap is
  /// the dragged row's own position — no indicator, and drop would no-op).
  indicatorGap: number | null;
  /// Attach to the list's container element; the edge auto-scroll targets its
  /// nearest scrollable ancestor.
  containerRef: RefObject<HTMLElement | null>;
  /// Register row `index`'s element — the live rect source for gap
  /// hit-testing. Pass as each row's ref callback.
  setRowEl: (index: number, el: HTMLElement | null) => void;
  /// pointerdown handler for row `index`'s grip. Left button only; prevents
  /// default so the grip never starts a text selection or native drag.
  startDrag: (index: number, e: ReactPointerEvent) => void;
}

/// Dropping on the row's own origin gap (or its own following gap, the same
/// position) leaves the list untouched — no indicator, no drop callback.
export function isNoopGap(gap: number, fromIndex: number): boolean {
  return gap === fromIndex || gap === fromIndex + 1;
}

// Auto-scroll band and speed for a drag that reaches the host's edge. Reorder
// lists live in scrolling dock hosts, so a long list would otherwise be
// unreorderable past the visible rows.
const EDGE_BAND_PX = 28;
const EDGE_SPEED_PX = 12;

/// Nearest scrollable ancestor, or null when the list fits without scrolling.
function scrollHostOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const overflowY = getComputedStyle(n).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      n.scrollHeight > n.clientHeight
    ) {
      return n;
    }
  }
  return null;
}

/// Shared pointer-driven list-reorder gesture: drag state with a gap model,
/// gap hit-testing by row-rect midlines, edge auto-scroll against the nearest
/// scrollable ancestor, per-gesture window listeners, and Escape /
/// pointercancel disarm. Pure pointer events — never HTML5 drag-and-drop —
/// so a consumer's row gesture can never become a Dockview Panel dock drag.
/// Emits nothing mid-gesture; exactly one `onDrop` at a non-noop drop.
/// Presentation stays with the consumer — this hook only says which row is
/// dragging and where the insertion indicator belongs.
export function usePointerReorder(opts: PointerReorderOptions): PointerReorder {
  // The ref mirrors the state so the window-level listeners registered once
  // per gesture always read the freshest gap.
  const [drag, setDrag] = useState<ReorderDrag | null>(null);
  const dragRef = useRef<ReorderDrag | null>(null);
  const setDragState = (next: ReorderDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const rowsRef = useRef<(HTMLElement | null)[]>([]);
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!drag) return;
    // The gap is derived from live rects, so it stays correct while the host
    // auto-scrolls under a stationary pointer.
    const gapAt = (clientY: number) => {
      let gap = 0;
      rowsRef.current.forEach((row, i) => {
        if (!row) return;
        const rect = row.getBoundingClientRect();
        if (clientY > rect.top + rect.height / 2) gap = i + 1;
      });
      return gap;
    };
    const applyGap = (clientY: number) => {
      const current = dragRef.current;
      if (!current) return;
      const gap = gapAt(clientY);
      if (gap !== current.gap) setDragState({ ...current, gap });
    };

    // Edge auto-scroll: a rAF pump so holding the pointer at the host edge
    // keeps scrolling, instead of advancing one step per pointermove event.
    const host = scrollHostOf(containerRef.current);
    let speed = 0;
    let lastY = 0;
    let raf = 0;
    const pump = () => {
      raf = 0;
      if (!host || speed === 0 || !dragRef.current) return;
      const before = host.scrollTop;
      host.scrollTop += speed;
      if (host.scrollTop !== before) applyGap(lastY);
      raf = requestAnimationFrame(pump);
    };
    const updateAutoScroll = (clientY: number) => {
      lastY = clientY;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      if (clientY < rect.top + EDGE_BAND_PX) speed = -EDGE_SPEED_PX;
      else if (clientY > rect.bottom - EDGE_BAND_PX) speed = EDGE_SPEED_PX;
      else speed = 0;
      if (speed !== 0 && raf === 0) raf = requestAnimationFrame(pump);
    };

    const onMove = (e: PointerEvent) => {
      applyGap(e.clientY);
      updateAutoScroll(e.clientY);
    };
    const onUp = () => {
      const current = dragRef.current;
      setDragState(null);
      if (!current) return;
      if (isNoopGap(current.gap, current.fromIndex)) return;
      opts.onDrop(current);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDragState(null);
    };
    // A browser-aborted gesture (pointercancel) must not stay armed: the next
    // unrelated pointerup would otherwise commit an unintended move.
    const onCancel = () => setDragState(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      speed = 0;
      if (raf !== 0) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
    // onDrop is re-read per gesture; the listeners live exactly one gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const setRowEl = (index: number, el: HTMLElement | null) => {
    rowsRef.current[index] = el;
  };

  const startDrag = (index: number, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const id = opts.rowIds[index];
    if (id === undefined) return; // stale index from a consumer bug — refuse to arm
    e.preventDefault(); // no text selection or native drag out of the grip
    // Pointer capture keeps the gesture's release delivered even off-window;
    // jsdom lacks the API, so it is best-effort only (tests drive window).
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Not every embedder supports capture; window listeners still own the gesture.
    }
    setDragState({ id, fromIndex: index, gap: index });
  };

  const indicatorGap =
    drag && !isNoopGap(drag.gap, drag.fromIndex) ? drag.gap : null;

  return { drag, indicatorGap, containerRef, setRowEl, startDrag };
}
