import { useTranslation } from "react-i18next";
import type { AnimTrack, TrackSummary } from "../ipc";
import { trackKeyframeProperties, keyframeAbsoluteX } from "./geometry";
import { readParamTrack } from "../keyframe/descriptors";
import { useIsKeyframeSelected } from "../keyframe/selectionStore";

export const KF_SUBLANE_H = 24;

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
}: {
  track: TrackSummary;
  pxPerSec: number;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const props = trackKeyframeProperties(track);
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
              />
            ));
          })}
        </div>
      ))}
    </>
  );
}

function SubLaneDiamond({ layerId, paramKey, kfId, x, outOfRange }: {
  layerId: string;
  paramKey: string;
  kfId: string;
  x: number;
  outOfRange: boolean;
}) {
  const selected = useIsKeyframeSelected(layerId, paramKey, kfId);
  return (
    <span
      className={`kf-diamond kf-sublane-diamond${selected ? " is-selected" : ""}`}
      style={{ left: x, opacity: outOfRange ? 0.4 : 1 }}
      data-kf-id={kfId}
      data-layer-id={layerId}
      data-param={paramKey}
    />
  );
}
