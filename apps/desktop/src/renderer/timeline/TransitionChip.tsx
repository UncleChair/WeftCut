import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight } from "lucide-react";
import { boundaryDisplayFrameUs, formatTimecode } from "../frames";
import { setTransitionSelection } from "../state/selectionStore";
import { transportPause, transportSeek } from "../state/playbackStore";
import { playheadTimeUs, setPlayheadTimeUs } from "../state/playheadStore";
import { useMediaById } from "../state/projectStore";
import type { LayerSlice } from "./geometry";
import {
  chipSliceSlot,
  transitionLeftEdgeClampUs,
  transitionLeftEdgeDragArgs,
  transitionRightEdgeClampUs,
  transitionRightEdgeDragArgs,
  transitionTailHandleUs,
  type TrackTransitionChip,
  type TransitionResizeArgs,
} from "./transitions";

/// Matches LayerBlock's EDGE_ZONE_PX so the chip's edges and a clip's edges
/// feel like one affordance; zones clamp to a third of the chip width so the
/// two never overlap on a narrow chip.
const EDGE_ZONE_PX = 6;

/// Overlay rectangle straddling a transition's window `[B.start, A.end]` on
/// the track lane. Selectable; both edges drag-resize with invariant,
/// placement-independent semantics (spec D6): the left edge is B's timeline
/// start (A.end pinned), the right edge is A's actual end (B.start pinned) —
/// rightward = explicit handle borrow, leftward past S = genuine tail trim.
///
/// The chip spans the whole window and renders ABOVE the participants' blocks,
/// so a pointerdown anywhere on it — including where B's head or A's tail edge
/// zones would be — reaches only the chip: bare participant edges are not
/// grabbable inside the window (gesture-layer capture only; Policy B stays the
/// mutation-layer backstop).
///
/// Playhead-gate discipline: geometry derives ONLY from the project summary +
/// zoom (drag ghost is local state) — no playhead subscription of any tier.
/// The chip re-renders when the project version or zoom changes, never per
/// frame.
export function TransitionChip({
  chip,
  pxPerSec,
  laneHeight,
  slice,
  isSelected,
  bladeMode,
  fpsNum,
  fpsDen,
  onContextMenu,
  onResize,
}: {
  chip: TrackTransitionChip;
  pxPerSec: number;
  laneHeight: number;
  /// Vertical slot of the INCOMING layer's block, so the chip hugs it in
  /// combined V+A rows too.
  slice: LayerSlice;
  isSelected: boolean;
  /// Blade mode: the chip goes transparent to clicks so the razor can reach
  /// the layer surface underneath.
  bladeMode: boolean;
  fpsNum: number;
  fpsDen: number;
  /// Right-click hook — the Timeline shows the chip menu (kind / direction /
  /// duration / delete) at the cursor.
  onContextMenu: (e: React.MouseEvent) => void;
  /// Edge-drag commit hook — the Timeline lowers the assembled patch through
  /// `updateTransition` (failures → logMutationFailure "Resize transition").
  onResize: (args: TransitionResizeArgs) => void;
}) {
  const { t } = useTranslation();
  // Live drag ghost: the clamped window while an edge gesture is in flight.
  // Frame-quantized upstream, so a pointer wiggle inside one frame neither
  // re-renders nor re-seeks.
  const [ghost, setGhost] = useState<{ startUs: number; endUs: number } | null>(
    null,
  );
  const fromParams = chip.fromLayer.params;
  const isMediaBearing =
    fromParams.kind === "VideoClip" || fromParams.kind === "Audio";
  // Media tail resolves through the summary-derived mediaById index (the
  // TimelineVisualPreview precedent) — still no per-frame subscription.
  const fromMedia = useMediaById(isMediaBearing ? fromParams.media_id : null);
  const startUs = ghost?.startUs ?? chip.startUs;
  const endUs = ghost?.endUs ?? chip.endUs;
  const left = (startUs / 1_000_000) * pxPerSec;
  const width = Math.max(6, ((endUs - startUs) / 1_000_000) * pxPerSec);
  const edgeZonePx = Math.min(EDGE_ZONE_PX, Math.floor(width / 3));
  const slot = chipSliceSlot(laneHeight, slice);
  const kind = chip.transition.kind.kind;
  const kindLabel = t(`transitions.kind_${kind.toLowerCase()}`, {
    defaultValue: kind,
  });
  const title = t("timeline.transition_chip_title", {
    kind: kindLabel,
    start: formatTimecode(chip.startUs, fpsNum, fpsDen),
    end: formatTimecode(chip.endUs, fpsNum, fpsDen),
    defaultValue: "{{kind}} transition · {{start}} → {{end}}",
  });

  /// Arm an edge drag (the keyframe-diamond pattern: window pointermove /
  /// pointerup pair, accumulate locally, commit ONCE on pointerup and only
  /// when the snapped destination differs from the start). Destinations are
  /// frame-snapped and live-clamped by the pure kernels; the monitor
  /// live-seeks to the dragged edge from the first EFFECTIVE move and the
  /// playhead is restored on release (the useLayerDrag trim discipline).
  const beginEdgeDrag = (edge: "left" | "right") =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // Same capture contract as the chip body: nothing below the chip may
      // see this gesture.
      e.stopPropagation();
      setTransitionSelection(chip.transition.id);
      const startClientX = e.clientX;
      // Geometry snapshot for the whole gesture. chip.endUs IS A.end
      // (overlap === duration); the clamp inputs are summary spans only.
      const aStartUs = chip.fromLayer.t_start_us;
      const aEndUs = chip.endUs;
      const bStartUs = chip.startUs;
      const bEndUs = chip.toLayer.t_end_us;
      const tailUs = transitionTailHandleUs(
        fromParams.kind,
        isMediaBearing ? fromParams.src_out_us : 0,
        fromMedia?.duration_us,
      );
      const initialUs = edge === "left" ? bStartUs : aEndUs;
      let lastUs = initialUs;
      let restoreUs: number | null = null;
      const onMove = (me: PointerEvent) => {
        const targetUs =
          initialUs + ((me.clientX - startClientX) / pxPerSec) * 1_000_000;
        const nextUs =
          edge === "left"
            ? transitionLeftEdgeClampUs({
                targetUs,
                aStartUs,
                aEndUs,
                bStartUs,
                bEndUs,
                extendedUs: chip.transition.extended_us,
                fpsNum,
                fpsDen,
              })
            : transitionRightEdgeClampUs({
                targetUs,
                bStartUs,
                bEndUs,
                aEndUs,
                tailHandleUs: tailUs,
                fpsNum,
                fpsDen,
              });
        if (nextUs === lastUs) return;
        lastUs = nextUs;
        if (restoreUs === null) {
          // First effective move: park the transport and remember where the
          // user left the playhead — the gesture must not relocate it.
          restoreUs = playheadTimeUs();
          transportPause();
        }
        // Left edge is an in-style boundary (show the boundary frame), right
        // edge an out-style one (show the last kept frame) — the trim-drag
        // display convention.
        transportSeek(
          boundaryDisplayFrameUs(
            nextUs,
            edge === "left" ? "in" : "out",
            fpsNum,
            fpsDen,
          ),
        );
        setGhost(
          edge === "left"
            ? { startUs: nextUs, endUs: aEndUs }
            : { startUs: bStartUs, endUs: nextUs },
        );
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setGhost(null);
        if (restoreUs !== null) {
          // Optimistic store write + transport seek (the seekExact pattern):
          // put both the playhead line and the monitor back.
          setPlayheadTimeUs(restoreUs);
          transportSeek(restoreUs);
        }
        // A stationary pointer never commits.
        if (lastUs === initialUs) return;
        onResize(
          edge === "left"
            ? transitionLeftEdgeDragArgs(chip.transition, aEndUs, lastUs)
            : transitionRightEdgeDragArgs(
                chip.transition,
                aEndUs,
                bStartUs,
                lastUs,
              ),
        );
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };

  return (
    <div
      data-testid="transition-chip"
      data-transition-id={chip.transition.id}
      data-selected={isSelected || undefined}
      role="button"
      aria-label={title}
      className={[
        "absolute z-[2] flex items-center justify-center overflow-hidden rounded-sm",
        "border border-fuchsia-200/70 bg-fuchsia-500/40 text-fuchsia-50",
        "cursor-pointer select-none transition-[outline,box-shadow] duration-75",
        "hover:bg-fuchsia-500/55 hover:shadow-[0_2px_6px_rgba(0,0,0,0.4)]",
        isSelected ? "outline outline-2 -outline-offset-2 outline-ring" : "",
        bladeMode ? "pointer-events-none" : "",
      ].join(" ")}
      style={{ left, top: slot.top, width, height: slot.height }}
      title={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Selecting a chip must not arm a layer drag or bubble to the lane;
        // the store clears the layer selection in the same update (selection
        // idiom: one selected entity kind at a time).
        e.stopPropagation();
        setTransitionSelection(chip.transition.id);
      }}
      onClick={(e) => {
        // Keep the click off the timeline-root background-deselect — same
        // stopPropagation contract as LayerBlock.
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        // Swallow so the layer menu underneath doesn't open too; select
        // first so the menu always describes the chip it visibly targets.
        e.preventDefault();
        e.stopPropagation();
        setTransitionSelection(chip.transition.id);
        onContextMenu(e);
      }}
    >
      {width >= 18 && (
        <ArrowLeftRight size={10} strokeWidth={2} aria-hidden />
      )}
      {edgeZonePx > 0 && (
        <>
          <div
            data-testid="transition-chip-edge-left"
            aria-hidden
            className="absolute inset-y-0 left-0 cursor-ew-resize"
            style={{ width: edgeZonePx }}
            onPointerDown={beginEdgeDrag("left")}
          />
          <div
            data-testid="transition-chip-edge-right"
            aria-hidden
            className="absolute inset-y-0 right-0 cursor-ew-resize"
            style={{ width: edgeZonePx }}
            onPointerDown={beginEdgeDrag("right")}
          />
        </>
      )}
    </div>
  );
}
