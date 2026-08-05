// On-canvas transform box for the primary selected layer: shows its footprint
// over the preview and drags it to a new position. Move-only for now (no
// resize/rotate handles).
//
// Screen-space by design — an SVG overlay, not Pixi children. The stage is
// read back by the eyedropper and by the conformance capture hooks, so anything
// drawn into it would poison those buffers; and a box drawn in composition
// space would be sub-pixel on a 4K composition shown in a small panel.
//
// Every pointer- and frame-rate update here is imperative through refs: the box
// follows animated x/y during playback, and a per-frame React state write is
// exactly what the memory-ratchet gate exists to catch.
// Spec: .scratch/preview-gizmo/spec.md (Phase 2)

import { useEffect, useRef } from "react";

import { snapFrameRound } from "../frames";
import {
  updateLayerParamTracks,
  type AnimTrack,
  type CompositionSummary,
  type LayerSummary,
} from "../ipc";
import { autoKeyTrack } from "../keyframe/autoKey";
import { readParamTrack } from "../keyframe/descriptors";
import { resolveAnimated } from "../render/animated";
import {
  clearTransformOverride,
  setTransformOverride,
  transformOverrideFor,
} from "../render/transformOverrides";
import { useProjectStore } from "../state/projectStore";
import { playheadTimeUs } from "../state/playheadStore";
import { usePrimaryLayerId } from "../state/selectionStore";
import {
  clientDeltaToComp,
  compToClient,
  containFit,
  layerQuad,
  type TransformOrigin,
} from "./gizmoGeometry";
import { getGizmoProbe } from "./gizmoProbeRegistry";

/// Color has no transform at all (it fills the composition) and Audio is not
/// visual — neither gets a box.
const TRANSFORM_KINDS = new Set(["VideoClip", "ImageOverlay", "Text", "Motif"]);

/// The flattened transform fields every box needs. Read through one cast at the
/// edge because `LayerParamsView` is a discriminated union and the gizmo is
/// deliberately kind-agnostic past the `TRANSFORM_KINDS` gate.
interface TransformFields {
  kind: string;
  x?: AnimTrack<number>;
  y?: AnimTrack<number>;
  scale_x?: AnimTrack<number>;
  scale_y?: AnimTrack<number>;
  rotation_deg?: AnimTrack<number>;
  anchor_x?: number;
  anchor_y?: number;
}

function transformFields(layer: LayerSummary): TransformFields {
  return layer.params as unknown as TransformFields;
}

export function TransformGizmoHost() {
  const primaryLayerId = usePrimaryLayerId();
  const summary = useProjectStore((s) => s.summary);
  if (!primaryLayerId || !summary) return null;
  let found: LayerSummary | null = null;
  for (const track of summary.tracks) {
    for (const layer of track.layers) {
      if (layer.id === primaryLayerId) found = layer;
    }
  }
  if (!found || !TRANSFORM_KINDS.has(found.params.kind)) return null;
  // Keyed on the layer id so switching selection remounts with fresh drag
  // state instead of carrying a half-finished gesture across layers.
  return <TransformGizmo key={found.id} layer={found} composition={summary.composition} />;
}

interface Drag {
  startClientX: number;
  startClientY: number;
  /// Layer-local time FROZEN at pointerdown, frame-snapped: it is both where a
  /// keyframed track gets its key and where the pre-drag base value is read.
  /// Frozen so a drag during playback can't smear across frames.
  tInLayerUs: number;
  dxComp: number;
  dyComp: number;
}

function TransformGizmo({
  layer,
  composition,
}: {
  layer: LayerSummary;
  composition: CompositionSummary;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const boxRef = useRef<SVGPolygonElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  // Latest props for the rAF loop + pointer handlers, so neither has to be
  // re-created (and the loop re-started) on every project refresh.
  const layerRef = useRef(layer);
  layerRef.current = layer;
  const compRef = useRef(composition);
  compRef.current = composition;

  /// The override outlives the commit on purpose: clearing it the moment the
  /// mutation resolves would snap the layer back to its old position for the
  /// frame or two until `project:changed` → refetch → new summary lands. A new
  /// summary IS a new `layer` object, so this effect is that arrival.
  useEffect(() => {
    if (!dragRef.current && transformOverrideFor(layer.id)) {
      clearTransformOverride(layer.id);
    }
  }, [layer]);

  useEffect(() => {
    const layerId = layerRef.current.id;
    return () => clearTransformOverride(layerId);
  }, []);

  useEffect(() => {
    let frame = 0;
    const draw = (): void => {
      frame = requestAnimationFrame(draw);
      const box = boxRef.current;
      const svg = svgRef.current;
      const probe = getGizmoProbe();
      if (!box || !svg) return;
      const hide = (): void => {
        box.style.display = "none";
      };
      if (!probe) return hide();
      const l = layerRef.current;
      const comp = compRef.current;
      const tUs = playheadTimeUs();
      if (tUs < l.t_start_us || tUs >= l.t_end_us) return hide();
      const rect = probe.canvasRect();
      const size = probe.naturalSizeOf(l.id);
      if (!rect || !size) return hide();
      const fit = containFit(rect, comp.width, comp.height);
      if (!fit) return hide();
      const p = transformFields(l);
      const tLocalUs = tUs - l.t_start_us;
      const drag = dragRef.current;
      // The box is the layer's footprint, so it reads the UNSIGNED scale: a
      // flip mirrors the content within the same box (anchorPivot.ts), so
      // folding `flip_h` in here would only reverse the vertex order.
      const quad = layerQuad({
        x: resolveAnimated(p.x, tLocalUs, 0) + (drag?.dxComp ?? 0),
        y: resolveAnimated(p.y, tLocalUs, 0) + (drag?.dyComp ?? 0),
        // Raw, NOT `?? 0.5`: `anchorOr` inside the geometry owns the default,
        // and it is the same one the renderer applies. A local fallback here is
        // exactly how the box and the picture drifted apart before.
        anchorX: p.anchor_x,
        anchorY: p.anchor_y,
        naturalW: size.w,
        naturalH: size.h,
        scaleX: resolveAnimated(p.scale_x, tLocalUs, 1),
        scaleY: resolveAnimated(p.scale_y, tLocalUs, 1),
        rotationDeg: resolveAnimated(p.rotation_deg, tLocalUs, 0),
        origin: originFor(p.kind),
      });
      // The SVG is inset:0 inside the preview panel, so subtract its own client
      // origin to land in its coordinate system.
      const own = svg.getBoundingClientRect();
      box.setAttribute(
        "points",
        quad
          .map((corner) => {
            const c = compToClient(corner, fit);
            return `${c.x - own.left},${c.y - own.top}`;
          })
          .join(" "),
      );
      box.style.display = "";
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !dragRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = null;
      clearTransformOverride(layerRef.current.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const beginDrag = (e: React.PointerEvent<SVGPolygonElement>): void => {
    if (e.button !== 0) return;
    // The preview is not a selection surface, so nothing downstream needs this
    // press — and letting it through would start a canvas-level gesture.
    e.preventDefault();
    e.stopPropagation();
    const l = layerRef.current;
    const comp = compRef.current;
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      tInLayerUs: snapFrameRound(
        playheadTimeUs() - l.t_start_us,
        comp.fps_num,
        comp.fps_den,
      ),
      dxComp: 0,
      dyComp: 0,
    };
    // Capture so the drag survives the pointer leaving the box (which it always
    // does — the box is being dragged out from under the cursor).
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent<SVGPolygonElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = getGizmoProbe()?.canvasRect();
    const fit = rect ? containFit(rect, compRef.current.width, compRef.current.height) : null;
    if (!fit) return;
    const d = clientDeltaToComp(
      e.clientX - drag.startClientX,
      e.clientY - drag.startClientY,
      fit,
    );
    drag.dxComp = d.x;
    drag.dyComp = d.y;
    // Transient only — one IPC write per pointermove would be a full
    // renderer→main→refetch round trip and would pile up undo steps.
    setTransformOverride(layerRef.current.id, { dx: d.x, dy: d.y });
  };

  const endDrag = (e: React.PointerEvent<SVGPolygonElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!drag) return;
    const l = layerRef.current;
    if (drag.dxComp === 0 && drag.dyComp === 0) {
      clearTransformOverride(l.id);
      return;
    }
    const xTrack: AnimTrack<number> = readParamTrack(l.params, "x") ?? {
      mode: "Static",
      value: 0,
    };
    const yTrack: AnimTrack<number> = readParamTrack(l.params, "y") ?? {
      mode: "Static",
      value: 0,
    };
    // One batch = one undo step. `autoKeyTrack` is the shared rule: a Static
    // track takes a plain value, a Keyframed one gets a key at the playhead —
    // the same thing the inspector does.
    updateLayerParamTracks(l.id, [
      ["x", autoKeyTrack(xTrack, drag.tInLayerUs, resolveAnimated(xTrack, drag.tInLayerUs, 0) + drag.dxComp)],
      ["y", autoKeyTrack(yTrack, drag.tInLayerUs, resolveAnimated(yTrack, drag.tInLayerUs, 0) + drag.dyComp)],
    ]).catch((err) => {
      // The override is only safe to hold while a commit is in flight; a
      // failed write means no new summary is coming to lift it.
      clearTransformOverride(l.id);
      console.warn("transform gizmo commit failed:", err);
    });
  };

  return (
    <svg
      ref={svgRef}
      data-testid="transform-gizmo"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      <polygon
        ref={boxRef}
        data-testid="transform-gizmo-box"
        points=""
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          // A transparent fill still hit-tests under `pointerEvents: all`, so
          // the whole footprint is the drag handle.
          fill: "rgba(0, 0, 0, 0)",
          stroke: "var(--ring)",
          strokeWidth: 1.5,
          strokeDasharray: "4 3",
          pointerEvents: "all",
          cursor: "move",
          display: "none",
        }}
      />
    </svg>
  );
}

function originFor(kind: string): TransformOrigin {
  // docs/data-model.md#transform: only Text stores the anchor point as x/y.
  return kind === "Text" ? "anchor" : "top-left";
}
