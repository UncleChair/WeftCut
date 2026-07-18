// Contextual per-Layer effect-chain Panel. This boundary deliberately owns
// only the existing visual effect chain; kind-specific Layer fields remain in
// AttributePanel.

import { useTranslation } from "react-i18next";

import { type TrackSummary } from "../ipc";
import { EffectsSection } from "../properties/EffectsSection";
import { findPanelLayer, isVisualKind } from "./panelLayer";

export interface EffectPanelProps {
  tracks: TrackSummary[];
  selectedLayerId: string | null;
  currentTimeUs: number;
  onMutated: () => Promise<void>;
}

export function EffectPanel({
  tracks,
  selectedLayerId,
  currentTimeUs,
  onMutated,
}: EffectPanelProps) {
  const { t } = useTranslation();
  const layer = findPanelLayer(tracks, selectedLayerId);

  // Every selection state gets an explicit Panel body: the chain is never an
  // unexplained blank area, and an Audio selection never implies an
  // add-effect surface exists.
  if (!layer || !isVisualKind(layer.params.kind)) {
    return (
      <aside
        className="property-panel effect-panel"
        aria-label={t("effects.heading")}
      >
        <p className="placeholder">
          {layer ? t("effects.unsupported_audio") : t("effects.empty")}
        </p>
      </aside>
    );
  }

  const tInLayerUs = currentTimeUs - layer.t_start_us;
  const playheadInSpan =
    currentTimeUs >= layer.t_start_us && currentTimeUs < layer.t_end_us;

  return (
    <aside
      className="property-panel effect-panel"
      aria-label={t("effects.heading")}
    >
      <EffectsSection
        layer={layer}
        tInLayerUs={tInLayerUs}
        playheadInSpan={playheadInSpan}
        onMutated={onMutated}
      />
    </aside>
  );
}
