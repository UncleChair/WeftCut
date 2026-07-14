// On-lane value-curve renderer + in-place tangent-handle editor for one
// keyframed property of one layer. Curve + handles live in an SVG overlay
// (absolute, ruler-px coordinates); keyframe dots are HTML spans on top so
// they keep the `.kf-sublane-diamond` contract the e2e suite asserts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AnimTrack, Interpolation } from "../ipc";
import { interpToCoeffs } from "../keyframe/curve";
import {
  computeValueRange, segmentPolyline, segmentHandles, handleDragToCoeff,
  valueToY, timeToXPx, type CurveGeom, type Seg,
} from "../keyframe/curveGraph";

type KeyframedTrack = Extract<AnimTrack<number>, { mode: "Keyframed" }>;

export function KeyframeCurveGraph({
  track,
  layerTStartUs,
  clipDurationUs,
  pxPerSec,
  height,
  editable,
  selectedKfId,
  onSelectSeek,
  onRetime,
  onSetInterp,
  onOpenMenu,
}: {
  track: KeyframedTrack;
  layerTStartUs: number;
  clipDurationUs: number;
  pxPerSec: number;
  height: number;
  editable: boolean;
  selectedKfId: string | null;
  /// click a dot (no drag): select it + seek the transport to its time.
  onSelectSeek: (kfId: string) => void;
  /// drag a dot horizontally: retime to a new layer-local µs (caller commits).
  onRetime: (kfId: string, newTUsLocal: number) => void;
  /// drag a handle: set the owning segment-key's interp.
  onSetInterp: (kfId: string, interp: Interpolation) => void;
  /// right-click a dot or the curve: open the preset/Smooth menu.
  onOpenMenu: (clientX: number, clientY: number, kfId: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  useEffect(() => () => teardownRef.current?.(), []);

  const keys = track.value;

  // In-flight tangent-handle drag: holds the dragged segment's interp locally so
  // the curve previews live WITHOUT committing per pointermove. A per-move commit
  // would fire one async actor round-trip and one undo entry per move (60+ for a
  // single gesture). We commit once on pointerup; this preview survives until the
  // committed track catches up (see the clear effect below), so there's no
  // flicker back to the pre-drag curve while the async commit is in flight.
  const [preview, setPreview] = useState<{ owner: string; interp: Interpolation } | null>(null);

  // Keys as rendered: the dragged segment shows its preview interp; everything
  // else is the committed track. Drives geom + segments so the value-range and
  // handle positions track the drag live.
  const renderKeys = useMemo(() => {
    if (!preview) return keys;
    return keys.map((k) => (k.id === preview.owner ? { ...k, interp: preview.interp } : k));
  }, [keys, preview]);

  // Drop the preview once the committed track reflects it (or the owner key is
  // gone). Until then the preview stands in for the not-yet-arrived commit.
  useEffect(() => {
    if (!preview) return;
    const k = keys.find((x) => x.id === preview.owner);
    if (!k || JSON.stringify(k.interp) === JSON.stringify(preview.interp)) setPreview(null);
  }, [keys, preview]);

  const geom: CurveGeom = useMemo(() => {
    const { vmin, vmax } = computeValueRange(renderKeys);
    return { pxPerSec, layerTStartUs, height, vmin, vmax };
  }, [renderKeys, pxPerSec, layerTStartUs, height]);

  // Keep the latest geom reachable from drag closures created at pointerdown
  // (the timeline can zoom/rescale mid-drag → captured geom would go stale).
  const geomRef = useRef(geom);
  useLayoutEffect(() => {
    geomRef.current = geom;
  }, [geom]);

  // Segments: each owns renderKeys[i].interp (p1 near keys[i], p2 near keys[i+1]).
  const segments = useMemo(() => {
    const out: { owner: string; seg: Seg; interp: Interpolation }[] = [];
    for (let i = 0; i < renderKeys.length - 1; i++) {
      const a = renderKeys[i]!;
      const b = renderKeys[i + 1]!;
      out.push({
        owner: a.id,
        seg: { aTUs: a.t_us, aVal: a.value, bTUs: b.t_us, bVal: b.value },
        interp: a.interp,
      });
    }
    return out;
  }, [renderKeys]);

  function svgPoint(e: PointerEvent | React.PointerEvent): { x: number; y: number } {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function dragHandle(owner: string, which: "p1" | "p2", seg: Seg, e: React.PointerEvent) {
    if (!editable) return;
    e.stopPropagation();
    e.preventDefault();
    // Start from what's on screen (preview if a prior commit is still in flight,
    // else the committed interp), so the math is single-valued from the grab.
    const current = interpToCoeffs(
      renderKeys.find((k) => k.id === owner)!.interp,
    ) as [number, number, number, number];
    let nextInterp: Interpolation | null = null;
    const move = (me: PointerEvent) => {
      const p = svgPoint(me);
      const [c0, c1, c2, c3] = handleDragToCoeff(which, p.x, p.y, seg, geomRef.current, current);
      nextInterp = { kind: "Bezier", p1: [c0, c1], p2: [c2, c3] };
      setPreview({ owner, interp: nextInterp });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      teardownRef.current = null;
      // One commit for the whole gesture → one undo step. Preview holds until
      // the committed track arrives (clear effect), so no flicker on release.
      if (nextInterp) onSetInterp(owner, nextInterp);
    };
    teardownRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function dragDot(kfId: string, startTUs: number, e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelectSeek(kfId);
    const startClientX = e.clientX;
    let nextTUs: number | null = null;
    const move = (me: PointerEvent) => {
      const dxUs = ((me.clientX - startClientX) / geomRef.current.pxPerSec) * 1_000_000;
      nextTUs = Math.max(0, Math.min(clipDurationUs, startTUs + dxUs));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      teardownRef.current = null;
      if (nextTUs != null && nextTUs !== startTUs) onRetime(kfId, nextTUs);
    };
    teardownRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <>
      <svg
        ref={svgRef}
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        data-testid="kf-curve-graph"
      >
        {segments.map(({ owner, seg, interp }) => {
          const pts = segmentPolyline(seg, interp, geom).map((p) => `${p.x},${p.y}`).join(" ");
          const handles = editable ? segmentHandles(seg, interp, geom) : null;
          return (
            <g key={owner}>
              <polyline
                points={pts}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                className="pointer-events-auto cursor-context-menu"
                data-testid="kf-segment-hit"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenMenu(e.clientX, e.clientY, owner);
                }}
              />
              <polyline
                points={pts}
                fill="none"
                stroke="var(--ring, #9a9aff)"
                strokeWidth={editable ? 2 : 1}
                opacity={editable ? 1 : 0.5}
              />
              {handles && (["p1", "p2"] as const).map((which) => {
                const at = which === "p1" ? handles.p1 : handles.p2;
                const anchor = which === "p1"
                  ? { x: timeToXPx(seg.aTUs, geom), y: valueToY(seg.aVal, geom) }
                  : { x: timeToXPx(seg.bTUs, geom), y: valueToY(seg.bVal, geom) };
                return (
                  <g key={which}>
                    <line x1={anchor.x} y1={anchor.y} x2={at.x} y2={at.y}
                      stroke="var(--ring, #6b6bff)" strokeWidth={1} opacity={0.7} />
                    <circle
                      cx={at.x} cy={at.y} r={5}
                      fill="var(--ring, #6b6bff)"
                      className="pointer-events-auto cursor-grab"
                      data-testid="kf-handle"
                      onPointerDown={(e) => dragHandle(owner, which, seg, e)}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {keys.map((k) => (
        <span
          key={k.id}
          className={`kf-diamond kf-sublane-diamond${selectedKfId === k.id ? " is-selected" : ""}`}
          style={{ left: timeToXPx(k.t_us, geom), top: valueToY(k.value, geom) }}
          data-kf-id={k.id}
          onPointerDown={(e) => dragDot(k.id, k.t_us, e)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onSelectSeek(k.id);
            onOpenMenu(e.clientX, e.clientY, k.id);
          }}
        />
      ))}
    </>
  );
}
