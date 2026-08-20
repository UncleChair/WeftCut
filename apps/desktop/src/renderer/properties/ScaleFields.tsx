import { useTranslation } from "react-i18next";
import { Link2, Link2Off } from "lucide-react";
import { tryMutate } from "../errors/tryMutate";
import { setScaleLinked, type LayerSummary } from "../ipc";
import { SCALE, SCALE_X, SCALE_Y } from "../keyframe/descriptors";
import { InspectorAnimField } from "./InspectorAnimField";

/// The scale block every transform-bearing section renders: a single
/// collapsed "Scale" row + closed chain while linked, separate Scale X /
/// Scale Y rows + open chain while not. Closing the chain is silent and
/// destructive by design (the actor snaps scale_y := scale_x, keyframes
/// included — one commit, so one undo restores both track and flag).
export function ScaleFields({
  layer,
  scaleLinked,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  scaleLinked: boolean;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toggleLabel = scaleLinked ? t("property_panel.scale_unlink") : t("property_panel.scale_link");
  const chain = (
    <button
      type="button"
      className={`scale-link-toggle ${scaleLinked ? "is-linked" : ""}`}
      aria-pressed={scaleLinked}
      aria-label={toggleLabel}
      title={toggleLabel}
      onClick={() => {
        void tryMutate(
          () => setScaleLinked(layer.id, !scaleLinked).then(onMutated),
          "Toggle scale link",
        );
      }}
    >
      {scaleLinked ? <Link2 size={12} aria-hidden /> : <Link2Off size={12} aria-hidden />}
    </button>
  );
  if (scaleLinked) {
    return (
      <div className="scale-link-row">
        <InspectorAnimField layer={layer} desc={SCALE} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
        {chain}
      </div>
    );
  }
  return (
    <>
      <div className="scale-link-row">
        <InspectorAnimField layer={layer} desc={SCALE_X} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
        {chain}
      </div>
      <InspectorAnimField layer={layer} desc={SCALE_Y} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
    </>
  );
}
