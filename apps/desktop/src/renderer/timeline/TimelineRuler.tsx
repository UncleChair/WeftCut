import { useEffect, useMemo, useRef, useState } from "react";
import {
  timelineScrollLeftPx,
  useTimelineScrollStore,
} from "../state/timelineScrollStore";
import { RULER_SCROLL_QUANTUM_PX, computeRulerModel } from "./rulerModel";

/// Time ruler at the top of the scrollable timeline root. Width matches the
/// canvas so horizontal scroll keeps ticks aligned with the layers below.
///
/// This component paints `rulerModel.ts`'s view model and nothing else: which
/// ticks exist, where, and what they read all live there, bounded by the
/// viewport rather than by project length.

const quantizeScroll = (px: number): number =>
  Math.floor(Math.max(0, px) / RULER_SCROLL_QUANTUM_PX) *
  RULER_SCROLL_QUANTUM_PX;

/// Scroll offset for the tick window, stepped in `RULER_SCROLL_QUANTUM_PX`
/// blocks.
///
/// The ruler subscribes to the scroll store itself instead of taking
/// `scrollLeft` as a prop, because a prop would mean React state on the timeline
/// root and a full-tree re-render per wheel event (timelineScrollStore.ts states
/// the rule; `Timeline.tsx`'s TimelinePlayhead is the same pattern one step
/// cheaper). Quantizing bounds the cost further: the ruler commits at most once
/// per block of scrolling, not once per event, and the window built from a
/// lagging offset still covers the viewport because the overscan is at least one
/// quantum wide (see `RULER_OVERSCAN_PX`).
function useRulerScrollBlockPx(): number {
  const [blockPx, setBlockPx] = useState(() =>
    quantizeScroll(timelineScrollLeftPx()),
  );
  // The committed block, read from the subscription — `setBlockPx` is called
  // only when the block actually changes, so intra-block scrolling costs zero
  // React work rather than a bailed-out render.
  const committedRef = useRef(blockPx);
  useEffect(() => {
    const apply = (px: number) => {
      const next = quantizeScroll(px);
      if (next === committedRef.current) return;
      committedRef.current = next;
      setBlockPx(next);
    };
    // Re-sync on mount: the store may have moved while the timeline was
    // unmounted (dock panel switch), with no future event to correct it.
    apply(timelineScrollLeftPx());
    return useTimelineScrollStore.subscribe((s) => apply(s.scrollLeftPx));
  }, []);
  return blockPx;
}

export function TimelineRuler({
  pxPerSec,
  totalSec,
  widthPx,
  viewportWidthPx,
  fpsNum,
  fpsDen,
  onScrub,
}: {
  pxPerSec: number;
  totalSec: number;
  widthPx: number;
  /// Visible lane-area width (viewport minus the sticky header column) — with
  /// the scroll offset, the interval the painted tick set has to cover.
  viewportWidthPx: number;
  fpsNum: number;
  fpsDen: number;
  /// Begin a playhead scrub at the given client X. The ruler is the sole
  /// scrub surface (ruler-only seek); Timeline.tsx installs the drag-scrub
  /// loop via this callback.
  onScrub: (clientX: number) => void;
}) {
  const scrollLeftPx = useRulerScrollBlockPx();
  const { ticks } = useMemo(
    () =>
      computeRulerModel({
        fpsNum,
        fpsDen,
        pxPerSec,
        totalSec,
        scrollLeftPx,
        viewportWidthPx,
      }),
    [fpsNum, fpsDen, pxPerSec, totalSec, scrollLeftPx, viewportWidthPx],
  );

  return (
    /* Sizing notes:
       - `h-5` (20 px) accommodates a 10 px label in the upper half and
         4–8 px tick marks at the bottom; the playhead's `top: 2px` knob
         (Timeline.tsx renders it `top-0.5`) still lands inside this
         strip — keep the two coupled.
       - `overflow-hidden` is load-bearing: the major label is
         `whitespace-nowrap` at `left-[3px]` of an abs-positioned tick,
         so the rightmost major's label would spill past widthPx and
         inflate the parent's scrollWidth, leaving a few px of phantom
         horizontal scroll at fit-zoom that the user can't get rid of by
         zooming further. Same for the trailing tick the model
         deliberately emits past `totalSec` (rulerModel.ts) — this
         overflow clip is what actually clips it. */
    <div
      data-testid="timeline-ruler"
      className="sticky top-0 z-[3] h-5 flex-none cursor-ew-resize select-none overflow-hidden border-b border-border-soft bg-card text-[10px] text-muted-foreground"
      style={{ width: widthPx }}
      onPointerDown={(e) => {
        if (e.button === 0) onScrub(e.clientX);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {ticks.map((tk) => (
        <div
          key={tk.frame}
          className={`pointer-events-none absolute top-0 h-full w-0 after:absolute after:bottom-0 after:left-0 after:w-px after:content-[''] ${
            tk.isMajor
              ? "after:h-2 after:bg-foreground/55"
              : "after:h-1 after:bg-muted-foreground/55"
          }`}
          style={{ left: tk.xPx }}
        >
          {tk.label !== undefined && (
            <span className="absolute left-[3px] top-px whitespace-nowrap leading-3">
              {tk.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
