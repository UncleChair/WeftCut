import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatTimecode } from "../frames";
import { DROP_STRIP_HEIGHT_PX } from "./geometry";
import { SPAWN_TRACK_ID } from "./placement";
import { playheadTimeUs } from "../state/playheadStore";
import {
  MEDIA_DRAG_CURSOR_OFFSET_PX,
  MEDIA_DRAG_TYPE,
  parseMediaDrag,
  planMediaDrop,
  useMediaDragStore,
  type MediaDragPayload,
  type MediaDropPlan,
  type MediaDropSnapOptions,
} from "./mediaDrag";

/// The permanently reserved row above the topmost lane: releasing a drag here
/// spawns a lane at the top of the z-stack and places the clip on it (ADR 0042).
///
/// Idle it is a bare seam — no header, no content, nothing that reads as an
/// empty lane the editor is supposed to manage, because that mental model is
/// what tracks-as-a-by-product removes. It shows itself only while a drag is in
/// flight, and it claims the highlight through the SAME drop-target protocol the
/// lanes use, under `SPAWN_TRACK_ID`, so ownership transfers between the strip
/// and a lane without a second mechanism deciding who is lit.
///
/// A drop here is never a collision: the lane it lands on does not exist yet, so
/// `planMediaDrop` with no track answers `"spawn"` (see `placement.ts`).
///
/// Two genuinely different event models reach this one row. The media-pool drag
/// is HTML5 drag-and-drop and lands in the handlers below; the existing-clip drag
/// is pointer-driven, terminates in the timeline's own drag-commit path, and
/// populates no store this component could read — so it arrives as `layerDrag`.
/// Both then feed the SINGLE armed/lit pair at the bottom, because the failure
/// mode here is one mechanism lighting the strip while the other silently does
/// nothing.
export function DropStrip({
  elRef,
  pxPerSec,
  fpsNum,
  fpsDen,
  mediaDropSnap,
  layerDrag,
  onMediaDrop,
}: {
  /// The row's element, which the layer drag's hit-test measures. A ref rather
  /// than a registry entry: the strip is not a track (see `useLayerDrag`).
  elRef: React.RefObject<HTMLDivElement | null>;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  mediaDropSnap: Omit<MediaDropSnapOptions, "currentTimeUs">;
  /// The live pointer-driven move drag, or null when none is in flight.
  layerDrag: {
    /// Whether the drag's resolved destination is this strip.
    overStrip: boolean;
    /// x of the dragged clip's head, so the hint lands beside it. The clip keeps
    /// its own chip in the lane it came from — unlike a media drag, which brings
    /// a ghost into the strip — so there is no ghost head to borrow.
    anchorLeftPx: number;
  } | null;
  /// Commits the drop. A null track means "spawn one" — the Timeline owns the
  /// two-step commit because it also owns the readiness guards every media drop
  /// shares.
  onMediaDrop: (
    track: null,
    payload: MediaDragPayload,
    plan: MediaDropPlan,
  ) => void;
}) {
  const { t } = useTranslation();
  const activeMediaDrag = useMediaDragStore((s) => s.active);
  const dropTargetTrackId = useMediaDragStore((s) => s.dropTargetTrackId);
  const claimDropTarget = useMediaDragStore((s) => s.claimDropTarget);
  const releaseDropTarget = useMediaDragStore((s) => s.releaseDropTarget);
  const endMediaDrag = useMediaDragStore((s) => s.end);
  const [dropPreview, setDropPreview] = useState<{
    media: MediaDragPayload;
    plan: MediaDropPlan;
  } | null>(null);

  useEffect(() => {
    if (activeMediaDrag === null || dropTargetTrackId !== SPAWN_TRACK_ID) {
      setDropPreview(null);
    }
  }, [activeMediaDrag, dropTargetTrackId]);

  const visibleDropPreview =
    dropTargetTrackId === SPAWN_TRACK_ID ? dropPreview : null;

  const planFor = useCallback(
    (media: MediaDragPayload, pointerXPx: number) =>
      planMediaDrop({
        track: null,
        media,
        pointerXPx,
        pxPerSec,
        fpsNum,
        fpsDen,
        snap: { ...mediaDropSnap, currentTimeUs: playheadTimeUs() },
      }),
    [fpsDen, fpsNum, mediaDropSnap, pxPerSec],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
      e.preventDefault();
      if (activeMediaDrag === null) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const plan = planFor(activeMediaDrag, e.clientX - rect.left);
      e.dataTransfer.dropEffect = "copy";
      // Collapse the floating media card into a chip inside the strip, the same
      // way a lane absorbs it. Not cosmetic here: at full size the card covers
      // the whole row, so without this the highlight and the hint that say what
      // release will do are both hidden underneath it.
      const ghostLeft = rect.left + (plan.tStartUs / 1_000_000) * pxPerSec;
      const ghostWidth = Math.max(
        4,
        ((plan.tEndUs - plan.tStartUs) / 1_000_000) * pxPerSec,
      );
      const width = Math.min(36, Math.max(14, ghostWidth));
      const height = Math.max(8, DROP_STRIP_HEIGHT_PX - 4);
      claimDropTarget(SPAWN_TRACK_ID, {
        left:
          ghostLeft +
          Math.min(MEDIA_DRAG_CURSOR_OFFSET_PX, ghostWidth / 2) -
          width / 2,
        top: rect.top + (DROP_STRIP_HEIGHT_PX - height) / 2,
        width,
        height,
      });
      setDropPreview({ media: activeMediaDrag, plan });
    },
    [activeMediaDrag, claimDropTarget, planFor, pxPerSec],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      // Chromium reports (0, 0) as an unavailable-coordinate sentinel for some
      // dragleave events; the strip commonly begins at the viewport origin, so
      // treating that as a real point outside the row would wedge its highlight.
      const rect = e.currentTarget.getBoundingClientRect();
      const hasPointerCoordinates = e.clientX !== 0 || e.clientY !== 0;
      const pointerStillInside =
        hasPointerCoordinates &&
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (pointerStillInside) return;
      releaseDropTarget(SPAWN_TRACK_ID);
      setDropPreview(null);
    },
    [releaseDropTarget],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const payload = parseMediaDrag(e);
      setDropPreview(null);
      if (!payload) return;
      e.preventDefault();
      endMediaDrag();
      const rect = e.currentTarget.getBoundingClientRect();
      onMediaDrop(null, payload, planFor(payload, e.clientX - rect.left));
    },
    [endMediaDrag, onMediaDrop, planFor],
  );

  // One armed/lit pair, fed by both event models. Either drag arms the row;
  // whichever one currently owns the strip lights it.
  const armed = activeMediaDrag !== null || layerDrag !== null;
  const lit = visibleDropPreview !== null || layerDrag?.overStrip === true;
  const ghostLeftPx =
    visibleDropPreview !== null
      ? (visibleDropPreview.plan.tStartUs / 1_000_000) * pxPerSec
      : 0;
  // Anchored to the gesture's head rather than to the row, so the hint lands
  // beside the pointer at any scroll offset. For a media drag that is the ghost's
  // head, offset far enough to clear the absorbed media chip (which reaches at
  // most MEDIA_DRAG_CURSOR_OFFSET_PX + 18 px past it); for a clip drag it is the
  // clip's own head, which nothing covers.
  const hintLeftPx =
    visibleDropPreview !== null
      ? ghostLeftPx + MEDIA_DRAG_CURSOR_OFFSET_PX + 24
      : (layerDrag?.anchorLeftPx ?? 0);
  return (
    <div
      ref={elRef}
      data-testid="timeline-drop-strip"
      data-armed={armed ? "true" : "false"}
      data-lit={lit ? "true" : "false"}
      className={`relative ${
        lit
          ? "bg-blue-500/25 outline outline-1 outline-dashed -outline-offset-1 outline-blue-300/80"
          : armed
            ? "bg-blue-400/10"
            : ""
      }`}
      style={{ height: DROP_STRIP_HEIGHT_PX }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {visibleDropPreview !== null && (
        <div
          data-testid="timeline-drop-strip-ghost"
          data-validity={visibleDropPreview.plan.validity}
          data-start-us={visibleDropPreview.plan.tStartUs}
          data-end-us={visibleDropPreview.plan.tEndUs}
          className="pointer-events-none absolute inset-y-0 z-[5] rounded-sm border border-blue-200 bg-blue-500/45"
          style={{
            left: ghostLeftPx,
            width: Math.max(
              4,
              ((visibleDropPreview.plan.tEndUs -
                visibleDropPreview.plan.tStartUs) /
                1_000_000) *
                pxPerSec,
            ),
          }}
          title={`${visibleDropPreview.media.label}: ${formatTimecode(visibleDropPreview.plan.tStartUs, fpsNum, fpsDen)} → ${formatTimecode(visibleDropPreview.plan.tEndUs, fpsNum, fpsDen)}`}
        />
      )}
      {/* Says what release will do, for whichever gesture is over the row.
          Absolute because a 14 px row's height must never depend on the text. */}
      {lit && (
        <div
          data-testid="timeline-drop-strip-hint"
          className="pointer-events-none absolute inset-y-0 z-[6] whitespace-nowrap rounded-sm bg-blue-950/85 px-1.5 text-[9px] font-semibold leading-[14px] text-blue-50"
          style={{ left: hintLeftPx }}
        >
          {t("timeline.drop_spawn_hint", {
            defaultValue: "Release to create a track",
          })}
        </div>
      )}
    </div>
  );
}
