import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AnimTrack, TrackSummary } from "../ipc";
import { trackKeyframeProperties } from "./geometry";
import { readParamTrack, animatableParams } from "../keyframe/descriptors";
import {
  selectKeyframe,
  clearKeyframeSelection,
  getSelectedKeyframe,
  useKeyframeSelectionStore,
} from "../keyframe/selectionStore";
import { retimeKeyframe, removeKeyframe, setKeyframeInterp } from "../keyframe/edits";
import { transportSeek } from "../state/playbackStore";
import { usePlayheadTimeUsThrottled } from "../state/playheadStore";
import {
  setKeyframeFocus,
  useFocusedParamKeyForTrackLayers,
  useKeyframeFocusStore,
} from "../keyframe/focusStore";
import { KeyframeCurveGraph } from "./KeyframeCurveGraph";
import { EasingMenu } from "./EasingMenu";
import { KeyframeNavigator } from "./KeyframeNavigator";
import { KeyframeValueField } from "./KeyframeValueField";

export const KF_SUBLANE_H = 24;
export const KF_SUBLANE_EXPANDED_H = 72;

type OpenInterpMenu = (
  clientX: number,
  clientY: number,
  layerId: string,
  paramKey: string,
  kfId: string,
) => void;

/// Header-column rows: each property's keyframe navigator (◄ ◆ ►) on the left,
/// the property-name label right-aligned. Row-aligned with the body rows below
/// by sharing trackKeyframeProperties + KF_SUBLANE_H.
export function KeyframeLaneHeaders({
  track,
  fpsNum,
  fpsDen,
  visible,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  fpsNum: number;
  fpsDen: number;
  visible: boolean;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const { t } = useTranslation();
  // Panel-rate playhead subscription (tier 3, playheadStore.ts): navigator
  // arrows + value readouts follow playback without per-frame re-renders.
  const currentTimeUs = usePlayheadTimeUsThrottled(100, visible);
  const props = trackKeyframeProperties(track);
  const layerIds = useMemo(() => new Set(track.layers.map((l) => l.id)), [track.layers]);
  const focusedParamKey = useFocusedParamKeyForTrackLayers(layerIds);
  return (
    <>
      {props.map((d) => {
        const expanded = d.paramKey === focusedParamKey;
        return (
          <div
            key={d.paramKey}
            className="border-b border-border-soft px-1.5 text-[10px] text-muted-foreground/80"
            style={{ height: expanded ? KF_SUBLANE_EXPANDED_H : KF_SUBLANE_H }}
          >
            <div className="flex items-center justify-between gap-1" style={{ height: KF_SUBLANE_H }}>
              <span className="min-w-0 truncate">{t(d.labelKey, { defaultValue: d.paramKey })}</span>
              <KeyframeNavigator
                track={track}
                paramKey={d.paramKey}
                fallback={d.fallback}
                currentTimeUs={currentTimeUs}
                fpsNum={fpsNum}
                fpsDen={fpsDen}
                onCommitParamTrack={onCommitParamTrack}
              />
            </div>
            {expanded && (
              <KeyframeValueField
                track={track}
                desc={d}
                currentTimeUs={currentTimeUs}
                fpsNum={fpsNum}
                fpsDen={fpsDen}
                onCommitParamTrack={onCommitParamTrack}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/// Body rows: one diamond lane per property, diamonds absolute-positioned.
export function KeyframeLane({
  track,
  pxPerSec,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  pxPerSec: number;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const props = trackKeyframeProperties(track);
  const [interpMenu, setInterpMenu] = useState<{
    x: number;
    y: number;
    layerId: string;
    paramKey: string;
    kfId: string;
  } | null>(null);

  const openInterpMenu: OpenInterpMenu = (clientX, clientY, layerId, paramKey, kfId) =>
    setInterpMenu({ x: clientX, y: clientY, layerId, paramKey, kfId });

  // Capture-phase Delete for the selected keyframe, gated on the selection
  // belonging to a layer in THIS track (any property — the sub-lanes can
  // select a key on a property other than the layer's focused param, which the
  // LayerBlock effect, keyed on focusedParam, doesn't cover). Capture phase +
  // stopImmediatePropagation so this preempts the app-level
  // delete-selected-layer shortcut. Subscribe to a primitive so the
  // effect re-arms on selection change (atomic selector).
  const layerIds = useMemo(
    () => new Set(track.layers.map((l) => l.id)),
    [track.layers],
  );
  const armedKfId = useKeyframeSelectionStore((s) =>
    s.selected && layerIds.has(s.selected.layerId) ? s.selected.kfId : null,
  );
  useEffect(() => {
    if (!armedKfId) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const sel = getSelectedKeyframe();
      if (!sel || !layerIds.has(sel.layerId)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const layer = track.layers.find((l) => l.id === sel.layerId);
      if (!layer) return;
      const trk = readParamTrack(layer.params, sel.paramKey);
      if (!trk || trk.mode !== "Keyframed") return;
      const desc = animatableParams(layer.kind).find((d) => d.paramKey === sel.paramKey);
      onCommitParamTrack(
        sel.layerId,
        sel.paramKey,
        removeKeyframe(trk, sel.kfId, desc?.fallback ?? 0),
      );
      clearKeyframeSelection();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [armedKfId, layerIds, track.layers, onCommitParamTrack]);

  const focusedParamKey = useFocusedParamKeyForTrackLayers(layerIds);
  const focusedLayerId = useKeyframeFocusStore((s) =>
    s.layerId && layerIds.has(s.layerId) ? s.layerId : null,
  );

  return (
    <>
      {props.map((d) => {
        const expanded = d.paramKey === focusedParamKey;
        return (
          <div
            key={d.paramKey}
            className="relative border-b border-border-soft"
            style={{ height: expanded ? KF_SUBLANE_EXPANDED_H : KF_SUBLANE_H }}
          >
            {track.layers.map((layer) => {
              const trk = readParamTrack(layer.params, d.paramKey);
              if (!trk || trk.mode !== "Keyframed") return null;
              const durUs = layer.t_end_us - layer.t_start_us;
              return (
                <LayerCurveLane
                  key={layer.id}
                  layerId={layer.id}
                  paramKey={d.paramKey}
                  track={trk}
                  layerTStartUs={layer.t_start_us}
                  clipDurationUs={durUs}
                  pxPerSec={pxPerSec}
                  height={expanded ? KF_SUBLANE_EXPANDED_H : KF_SUBLANE_H}
                  editable={expanded && focusedLayerId === layer.id}
                  onCommitParamTrack={onCommitParamTrack}
                  onOpenInterpMenu={openInterpMenu}
                />
              );
            })}
          </div>
        );
      })}
      {interpMenu && (() => {
        const layer = track.layers.find((l) => l.id === interpMenu.layerId);
        if (!layer) return null;
        const trk = readParamTrack(layer.params, interpMenu.paramKey);
        if (!trk || trk.mode !== "Keyframed") return null;
        return (
          <EasingMenu
            x={interpMenu.x}
            y={interpMenu.y}
            track={trk}
            kfId={interpMenu.kfId}
            onClose={() => setInterpMenu(null)}
            onCommit={(next) => onCommitParamTrack(interpMenu.layerId, interpMenu.paramKey, next)}
          />
        );
      })()}
    </>
  );
}

function LayerCurveLane({
  layerId, paramKey, track, layerTStartUs, clipDurationUs, pxPerSec, height,
  editable, onCommitParamTrack, onOpenInterpMenu,
}: {
  layerId: string;
  paramKey: string;
  track: Extract<AnimTrack<number>, { mode: "Keyframed" }>;
  layerTStartUs: number;
  clipDurationUs: number;
  pxPerSec: number;
  height: number;
  editable: boolean;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
  onOpenInterpMenu: OpenInterpMenu;
}) {
  const selectedKfId = useKeyframeSelectionStore((s) =>
    s.selected && s.selected.layerId === layerId && s.selected.paramKey === paramKey
      ? s.selected.kfId
      : null,
  );
  return (
    <KeyframeCurveGraph
      track={track}
      layerTStartUs={layerTStartUs}
      clipDurationUs={clipDurationUs}
      pxPerSec={pxPerSec}
      height={height}
      editable={editable}
      selectedKfId={selectedKfId}
      onSelectSeek={(kfId) => {
        const kf = track.value.find((k) => k.id === kfId);
        if (!kf) return;
        selectKeyframe({ layerId, paramKey, kfId });
        setKeyframeFocus(layerId, paramKey);
        transportSeek(layerTStartUs + kf.t_us);
      }}
      onRetime={(kfId, newTUs) =>
        onCommitParamTrack(layerId, paramKey, retimeKeyframe(track, kfId, newTUs))
      }
      onSetInterp={(kfId, interp) =>
        onCommitParamTrack(layerId, paramKey, setKeyframeInterp(track, kfId, interp))
      }
      onOpenMenu={(cx, cy, kfId) => onOpenInterpMenu(cx, cy, layerId, paramKey, kfId)}
    />
  );
}
