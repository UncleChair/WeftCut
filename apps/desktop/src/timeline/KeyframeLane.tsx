import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AnimTrack, TrackSummary } from "../ipc";
import { trackKeyframeProperties, keyframeAbsoluteX } from "./geometry";
import { readParamTrack, animatableParams } from "../keyframe/descriptors";
import {
  useIsKeyframeSelected,
  selectKeyframe,
  clearKeyframeSelection,
  getSelectedKeyframe,
  useKeyframeSelectionStore,
} from "../keyframe/selectionStore";
import { retimeKeyframe, removeKeyframe } from "../keyframe/edits";
import { transportSeek } from "../state/playbackStore";
import { EasingEditor } from "./EasingEditor";

export const KF_SUBLANE_H = 24;

type OpenInterpMenu = (
  clientX: number,
  clientY: number,
  layerId: string,
  paramKey: string,
  kfId: string,
) => void;

/// Header-column rows: one property-name label per sub-lane (kept row-aligned
/// with the body rows below by sharing trackKeyframeProperties + KF_SUBLANE_H).
export function KeyframeLaneHeaders({ track }: { track: TrackSummary }) {
  const { t } = useTranslation();
  const props = trackKeyframeProperties(track);
  return (
    <>
      {props.map((d) => (
        <div
          key={d.paramKey}
          className="flex items-center justify-end border-b border-border-soft px-1.5 text-[10px] text-muted-foreground/80"
          style={{ height: KF_SUBLANE_H }}
        >
          {t(d.labelKey, { defaultValue: d.paramKey })}
        </div>
      ))}
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
  // LayerBlock effect, keyed on focusedParam, doesn't cover). Same
  // capture+stopImmediatePropagation rationale as Phase 2: preempt the
  // app-level delete-selected-layer shortcut. Subscribe to a primitive so the
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

  return (
    <>
      {props.map((d) => (
        <div
          key={d.paramKey}
          className="relative border-b border-border-soft"
          style={{ height: KF_SUBLANE_H }}
        >
          {track.layers.map((layer) => {
            const trk = readParamTrack(layer.params, d.paramKey);
            if (!trk || trk.mode !== "Keyframed") return null;
            const durUs = layer.t_end_us - layer.t_start_us;
            return trk.value.map((kf) => (
              <SubLaneDiamond
                key={kf.id}
                layerId={layer.id}
                paramKey={d.paramKey}
                kfId={kf.id}
                x={keyframeAbsoluteX(layer.t_start_us, kf.t_us, pxPerSec)}
                outOfRange={kf.t_us < 0 || kf.t_us > durUs}
                layerTStartUs={layer.t_start_us}
                kfTUs={kf.t_us}
                clipDurationUs={durUs}
                pxPerSec={pxPerSec}
                paramTrack={trk}
                onCommitParamTrack={onCommitParamTrack}
                onOpenInterpMenu={openInterpMenu}
              />
            ));
          })}
        </div>
      ))}
      {interpMenu && (() => {
        const layer = track.layers.find((l) => l.id === interpMenu.layerId);
        if (!layer) return null;
        const trk = readParamTrack(layer.params, interpMenu.paramKey);
        if (!trk || trk.mode !== "Keyframed") return null;
        return (
          <EasingEditor
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

function SubLaneDiamond({
  layerId,
  paramKey,
  kfId,
  x,
  outOfRange,
  layerTStartUs,
  kfTUs,
  clipDurationUs,
  pxPerSec,
  paramTrack,
  onCommitParamTrack,
  onOpenInterpMenu,
}: {
  layerId: string;
  paramKey: string;
  kfId: string;
  x: number;
  outOfRange: boolean;
  layerTStartUs: number;
  kfTUs: number;
  clipDurationUs: number;
  pxPerSec: number;
  paramTrack: AnimTrack<number>;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
  onOpenInterpMenu: OpenInterpMenu;
}) {
  const selected = useIsKeyframeSelected(layerId, paramKey, kfId);
  return (
    <span
      className={`kf-diamond kf-sublane-diamond${selected ? " is-selected" : ""}`}
      style={{ left: x, opacity: outOfRange ? 0.4 : 1 }}
      data-kf-id={kfId}
      data-layer-id={layerId}
      data-param={paramKey}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        selectKeyframe({ layerId, paramKey, kfId });
        transportSeek(layerTStartUs + kfTUs);
        // begin drag-retime — commit on release if the key actually moved.
        const startClientX = e.clientX;
        const startTUs = kfTUs;
        let nextTUs: number | null = null;
        const onMove = (me: PointerEvent) => {
          const dxUs = ((me.clientX - startClientX) / pxPerSec) * 1_000_000;
          nextTUs = Math.max(0, Math.min(clipDurationUs, startTUs + dxUs));
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          if (nextTUs != null && nextTUs !== startTUs) {
            onCommitParamTrack(layerId, paramKey, retimeKeyframe(paramTrack, kfId, nextTUs));
          }
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        selectKeyframe({ layerId, paramKey, kfId });
        onOpenInterpMenu(e.clientX, e.clientY, layerId, paramKey, kfId);
      }}
    />
  );
}
