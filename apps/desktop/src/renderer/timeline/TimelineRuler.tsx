import { useEffect, useMemo, useRef, useState } from "react";
import { useRangeInUs, useRangeOutUs } from "../state/rangeStore";
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

/// Cyan, because every other timeline accent is already spoken for: red is the
/// playhead and collisions, amber the blade preview and locked drops, blue the
/// drop preview. An in/out point is a standing user mark, not a status, so it
/// must not borrow a status colour.
const CAP_COLOR = "bg-cyan-300";
/// Matches `w-0.5` below. The out cap's RIGHT edge sits on the boundary (the
/// end is exclusive — the boundary is the right edge of the last kept frame),
/// so it is drawn one bar-width left of it.
const CAP_WIDTH_PX = 2;

/**
 * One in/out mark: a full-height bar at the boundary with a short foot pointing
 * INTO the kept range, giving the `⌐` / `¬` brackets every NLE draws.
 *
 * Lives in the ruler strip and nowhere else. That is the whole point — the mark
 * is permanent, so it must cost zero lane pixels; the heavier out-of-range
 * treatment is transient and lives over the lanes instead.
 */
function RangeCap({ xPx, side }: { xPx: number; side: "in" | "out" }) {
  return (
    <div
      data-testid={`timeline-range-cap-${side}`}
      className={`pointer-events-none absolute top-0 h-full w-0.5 ${CAP_COLOR} shadow-[0_0_0_0.5px_rgba(0,0,0,0.6)]`}
      style={{ left: side === "in" ? xPx : xPx - CAP_WIDTH_PX }}
      aria-hidden="true"
    >
      <div
        className={`absolute bottom-0 h-0.5 w-1.5 ${CAP_COLOR} ${
          side === "in" ? "left-0" : "right-0"
        }`}
      />
    </div>
  );
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
  // Plain subscriptions, not the playhead's transient-DOM-mutation pattern:
  // in/out change when the user marks them, not once per composition frame, so
  // a React commit per change costs nothing worth optimising away. Atomic
  // selectors per `feedback_zustand_composite_selector`.
  const rangeInUs = useRangeInUs();
  const rangeOutUs = useRangeOutUs();
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
      {/* After the ticks so the caps paint over them — same stacking context,
          so DOM order is the whole z-story. Two nodes at most, positioned in
          the same row coordinates the ticks use, and clipped by this strip's
          `overflow-hidden` when the range is scrolled out of view. */}
      {rangeInUs !== null && (
        <RangeCap xPx={(rangeInUs / 1_000_000) * pxPerSec} side="in" />
      )}
      {rangeOutUs !== null && (
        <RangeCap xPx={(rangeOutUs / 1_000_000) * pxPerSec} side="out" />
      )}
    </div>
  );
}
