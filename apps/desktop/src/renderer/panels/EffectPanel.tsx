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

  // Preserve the legacy inspector behaviour for no selection and Audio. A
  // dedicated unsupported state belongs to the later Effect feature ticket.
  if (!layer || !isVisualKind(layer.params.kind)) return null;

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
