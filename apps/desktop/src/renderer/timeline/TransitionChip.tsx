import { useTranslation } from "react-i18next";
import { ArrowLeftRight } from "lucide-react";
import { formatTimecode } from "../frames";
import { setTransitionSelection } from "../state/selectionStore";
import type { LayerSlice } from "./geometry";
import { chipSliceSlot, type TrackTransitionChip } from "./transitions";

/// Overlay rectangle straddling a transition's window on the track lane
/// (start-at-cut: it sits over the incoming layer's head, from the old cut
/// point spanning `duration_us`). Selectable; NO edge drag-resize in v1.
///
/// Playhead-gate discipline: geometry derives ONLY from the project summary +
/// zoom — no playhead subscription of any tier. The chip re-renders when the
/// project version or zoom changes, never per frame.
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
}) {
  const { t } = useTranslation();
  const left = (chip.startUs / 1_000_000) * pxPerSec;
  const width = Math.max(6, ((chip.endUs - chip.startUs) / 1_000_000) * pxPerSec);
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
    </div>
  );
}
