import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { formatTimecode } from "../frames";
import { useMarkersVisible } from "../settings/appSettingsStore";
import { useProjectMarkers } from "../state/projectStore";
import { useRangeInUs, useRangeOutUs } from "../state/rangeStore";
import {
  timelineScrollLeftPx,
  useTimelineScrollStore,
} from "../state/timelineScrollStore";
import {
  RULER_SCROLL_QUANTUM_PX,
  computeRulerMarkers,
  computeRulerModel,
  type RulerMarker,
} from "./rulerModel";

/// Time ruler at the top of the scrollable timeline root. Width matches the
/// canvas so horizontal scroll keeps ticks aligned with the layers below.
///
/// This component paints `rulerModel.ts`'s view model: which ticks and markers
/// exist, where, and how wide all live there, bounded by the viewport rather
/// than by project length. It adds one thing the model cannot own — marker
/// hover text, which needs a locale.

const quantizeScroll = (px: number): number =>
  Math.floor(Math.max(0, px) / RULER_SCROLL_QUANTUM_PX) *
  RULER_SCROLL_QUANTUM_PX;

/// Scroll offset for the tick window, stepped in `RULER_SCROLL_QUANTUM_PX`
/// blocks.
///
/// The ruler subscribes to the scroll store itself rather than taking
/// `scrollLeft` as a prop — see timelineScrollStore.ts for why this is not a
/// prop. Quantizing bounds the cost further: the ruler commits at most once per
/// block of scrolling, not once per event, and the window built from a lagging
/// offset still covers the viewport because the overscan is at least one quantum
/// wide (see `RULER_OVERSCAN_PX`).
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

/// The reading rule in the 20 px strip is positional: full height is the
/// playhead and the in/out caps, the upper half is timecode text, and the lower
/// half — these three numbers — is markers. A full-height marker rule would be
/// confusable with the caps, whose cyan was itself chosen to say "standing user
/// mark".
///
/// The point glyph is a SQUARE rotated 45°, so what it paints is its diagonal:
/// 7.07 px, not 5. Lifting it 1 px puts its bottom tip on the strip's floor
/// (the strip is `overflow-hidden`, so an unlifted diamond loses that tip) and
/// its top tip at 7 px — inside the 10 px lower half, which is the constraint
/// that actually matters.
const MARKER_POINT_SIZE_PX = 5;
const MARKER_POINT_BOTTOM_PX = 1;
const MARKER_BAR_HEIGHT_PX = 3;

/// Two concentric hairlines: dark inside, light outside. See `MarkerGlyph` for
/// why a marker needs both where an in/out cap needs only the dark one.
const MARKER_OUTLINE =
  "shadow-[0_0_0_0.5px_rgba(0,0,0,0.7),0_0_0_1.25px_rgba(255,255,255,0.4)]";

/// How far a 45°-rotated square paints beyond its own box on each side: the
/// diagonal is `size·√2`, so the overhang is half the difference. Rotation is
/// what makes the diamond a diamond, so this is not removable — it is
/// compensated for instead (`glyphTranslate`).
const MARKER_ROTATION_OVERHANG_PX =
  (MARKER_POINT_SIZE_PX * (Math.SQRT2 - 1)) / 2;

/// Where a glyph sits relative to the `left` its view item carries.
///
/// A true point marker is CENTRED on its frame: the frame is a line, and the
/// diamond straddles it the way a playhead would. A degraded region is not — it
/// begins at that x and nothing of it exists before, so it is nudged right by
/// the rotation overhang, putting its painted left edge exactly on the region's
/// start. Getting this backwards paints ~3.5 px of mark over frames the region
/// does not cover, in the one case the shape has already stopped reporting the
/// region's true extent.
function glyphTranslate(view: RulerMarker): string | undefined {
  if (view.shape === "region") return undefined;
  return view.endTUs === null ? "-50%" : `${MARKER_ROTATION_OVERHANG_PX}px`;
}

/// Hover text for one mark: `label · timecode`, or `label · start – end` for
/// anything carrying an `endTUs` — a degraded region included, which is the
/// half of `MARKER_MIN_REGION_PX`'s trade this function has to hold up.
function markerTitle(
  view: RulerMarker,
  fpsNum: number,
  fpsDen: number,
  t: TFunction,
): string {
  const label = view.label.trim() || t("kinds.marker");
  const start = formatTimecode(view.tUs, fpsNum, fpsDen);
  if (view.endTUs === null) {
    return t("timeline.marker_tooltip_point", { label, timecode: start });
  }
  return t("timeline.marker_tooltip_region", {
    label,
    start,
    end: formatTimecode(view.endTUs, fpsNum, fpsDen),
  });
}

/**
 * One marker: a diamond at its frame, or a bar across its range.
 *
 * Painted in the marker's OWN colour — timeline chrome is semantic by kind
 * except where the colour is the content, and a marker's colour is an authored
 * taxonomy (problem / approved / needs-VO).
 *
 * Outlined TWICE, which is where this departs from `RangeCap`. A cap is always
 * cyan, so one dark hairline is all it needs to sit off the ruler. A marker's
 * colour is whatever its author chose, and the ruler is `rgb(17,20,25)`: a
 * marker authored near-black (measured with `#14141a`) plus a dark ring is a
 * smudge, not a mark. The dark ring stays — it is what separates a BRIGHT
 * colour — and a light ring outside it separates a dark one, so no authored
 * colour can vanish into the background.
 *
 * Takes pointer events so the native tooltip fires, but installs no handler and
 * stops no propagation: every event continues to the ruler, which stays the sole
 * scrub surface. A press that lands on a marker still starts a scrub, and a drag
 * still crosses it without interruption.
 */
function MarkerGlyph({ view, title }: { view: RulerMarker; title: string }) {
  const isRegion = view.shape === "region";
  return (
    <div
      data-testid="timeline-marker"
      data-marker-id={view.id}
      data-shape={view.shape}
      title={title}
      className={`pointer-events-auto absolute ${MARKER_OUTLINE} ${
        isRegion ? "rounded-[1px]" : "rotate-45"
      }`}
      style={{
        // `left` is the marker's exact START in every shape — never its range's
        // midpoint, never widened. How the glyph sits around that x is
        // `glyphTranslate`'s call, so this stays the honest number.
        left: view.xPx,
        translate: glyphTranslate(view),
        bottom: isRegion ? 0 : MARKER_POINT_BOTTOM_PX,
        width: isRegion ? view.widthPx : MARKER_POINT_SIZE_PX,
        height: isRegion ? MARKER_BAR_HEIGHT_PX : MARKER_POINT_SIZE_PX,
        background: view.color,
      }}
    />
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
  // Markers are read here rather than threaded down from the timeline, for the
  // same reason the range and scroll stores are: the ruler is the only thing
  // that paints them, so they are not the timeline's prop surface. The array
  // changes once per project mutation, not once per frame.
  const markers = useProjectMarkers();
  // Read here for the same reason the markers themselves are: the ruler is the
  // only surface the flag governs, so it is not the timeline's prop surface. The
  // agent-mode mini timeline and the search palette answer to nothing here.
  const markersVisible = useMarkersVisible();
  const { t } = useTranslation();
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
  // Same window as the ticks, so a marker far outside the viewport costs no
  // DOM even on a project an agent has sprayed hundreds of markers across.
  //
  // Hover text is composed HERE rather than at each glyph: every title is a pair
  // of `formatTimecode` calls through the wasm frame grid, and a project
  // carrying hundreds of markers would otherwise pay for all of them on every
  // render rather than once per window.
  //
  // The visibility flag short-circuits HERE rather than at the JSX: with the
  // layer off there is no reason to run the window or format a single timecode,
  // and a project an agent sprayed markers across is exactly when someone
  // reaches for the toggle.
  const markerViews = useMemo(
    () =>
      markersVisible
        ? computeRulerMarkers({
            markers,
            pxPerSec,
            scrollLeftPx,
            viewportWidthPx,
          }).map((view) => ({
            view,
            title: markerTitle(view, fpsNum, fpsDen, t),
          }))
        : [],
    [markersVisible, markers, pxPerSec, scrollLeftPx, viewportWidthPx, fpsNum, fpsDen, t],
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
      {/* ONE wrapper, not N direct children of the strip: the ruler's RTL tests
          enumerate ticks by reading this strip's direct children, and the local
          node-count gate counts them to prove the tick set is bounded by the
          viewport rather than by composition length. A wrapper keeps both of
          those measuring ticks, and gives the e2e one locator for "the marker
          layer". `inset-0` so its children share the strip's row coordinates.

          LANDMINE: rendered only when it has marks. The node-count gate reads
          `parseFloat(child.style.left)` off every direct child and sorts the
          result — an always-present wrapper carries no `left`, so it feeds NaN
          into that sort on the marker-less project the gate creates. Giving it
          `left: 0` is NOT the fix: 0 then sorts first forever and the gate's
          "scrolling moved the window" check (`firstLeft > headLeft`) can never
          pass. */}
      {markerViews.length > 0 && (
        <div
          data-testid="timeline-marker-layer"
          className="pointer-events-none absolute inset-0"
        >
          {markerViews.map(({ view, title }) => (
            <MarkerGlyph key={view.id} view={view} title={title} />
          ))}
        </div>
      )}
      {/* After the ticks and the markers so the caps paint over both — same
          stacking context, so DOM order is the whole z-story, and the mark the
          user is actively placing wins. Two nodes at most, positioned in the
          same row coordinates the ticks use, and clipped by this strip's
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
