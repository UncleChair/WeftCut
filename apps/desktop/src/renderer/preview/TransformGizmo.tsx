// On-canvas transform box for the primary selected layer: shows its footprint
// over the preview, drags it to a new position, rotates it by the knob on a
// stalk above its top edge, and moves its anchor by the target reticle at the
// pivot. No resize handles yet.
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
import { DEFAULT_ANCHOR } from "../render/anchorPivot";
import {
  clearTransformOverride,
  setTransformOverride,
  transformOverrideFor,
} from "../render/transformOverrides";
import { useProjectStore } from "../state/projectStore";
import { playheadTimeUs } from "../state/playheadStore";
import { usePrimaryLayerId } from "../state/selectionStore";
import {
  anchorCompensation,
  angleAboutDeg,
  clientDeltaToComp,
  compDeltaToLocal,
  compToClient,
  containFit,
  layerPivot,
  layerQuad,
  rotateHandle,
  shortestDeltaDeg,
  snapAngleDeg,
  type LayerQuadInput,
  type Pt,
  type TransformOrigin,
} from "./gizmoGeometry";
import { getGizmoProbe } from "./gizmoProbeRegistry";

/// Client-pixel gap between the box's top edge and the rotation knob, and the
/// knob's radius. Screen space, so the affordance is identical on a 4K
/// composition and a 480p one.
const ROTATE_GAP_PX = 26;
const ROTATE_KNOB_R = 5;
/// Shift-constrained rotation grid — the de-facto standard step.
const ROTATE_SNAP_DEG = 15;
/// The anchor target: a ring with crosshair arms reaching past it, and an
/// invisible grab disc. Client pixels for the same reason as the knob. The arms
/// out-reach the ring on purpose — the exact centre is the thing being placed,
/// and a bare ring over busy footage hides it.
const ANCHOR_RING_R = 5.5;
const ANCHOR_ARM_PX = 9;
const ANCHOR_HIT_R = 11;

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
  anchor_x?: AnimTrack<number>;
  anchor_y?: AnimTrack<number>;
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

interface DragBase {
  /// Layer-local time FROZEN at pointerdown, frame-snapped: it is both where a
  /// keyframed track gets its key and where the pre-drag base value is read.
  /// Frozen so a drag during playback can't smear across frames.
  tInLayerUs: number;
}

interface MoveDrag extends DragBase {
  kind: "move";
  startClientX: number;
  startClientY: number;
  dxComp: number;
  dyComp: number;
}

interface RotateDrag extends DragBase {
  kind: "rotate";
  /// The engine's pivot in CLIENT pixels, frozen at pointerdown — rotation
  /// doesn't move the pivot, and freezing means a move needs no probe call at
  /// all (the whole gesture is then pure angle arithmetic).
  pivotClient: Pt;
  /// `rotation_deg` resolved at `tInLayerUs`, i.e. the value the commit adds to.
  /// The snap grid is measured from here so a Shift drag lands ON 15°.
  baseDeg: number;
  lastAngleDeg: number;
  /// Un-snapped rotation accumulated since pointerdown. Separate from
  /// `deltaDeg` so releasing Shift returns to the true cursor angle rather than
  /// to wherever the snap last quantized it.
  rawDeltaDeg: number;
  /// What is actually applied — and committed.
  deltaDeg: number;
}

interface AnchorDrag extends DragBase {
  kind: "anchor";
  startClientX: number;
  startClientY: number;
  /// The geometry the reticle was grabbed from, frozen at pointerdown. Both
  /// halves of this gesture need it — the client→normalized conversion and the
  /// pan-behind compensation — and freezing means the arithmetic can't shift
  /// under the cursor when the layer is mid-animation.
  frame: LayerQuadInput;
  /// Normalized anchor delta, and the `x`/`y` compensation that holds the
  /// picture still for it (`anchorCompensation`). Stored together because they
  /// commit as one batch: applying one without the other is a visible jump.
  dAnchorX: number;
  dAnchorY: number;
  compDx: number;
  compDy: number;
}

type Drag = MoveDrag | RotateDrag | AnchorDrag;

function TransformGizmo({
  layer,
  composition,
}: {
  layer: LayerSummary;
  composition: CompositionSummary;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const boxRef = useRef<SVGPolygonElement | null>(null);
  const stalkRef = useRef<SVGLineElement | null>(null);
  const knobRef = useRef<SVGCircleElement | null>(null);
  const anchorRef = useRef<SVGGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /// The pivot the last drawn frame used, in client pixels. A rotate gesture
  /// starts from what the user actually grabbed rather than from a geometry
  /// re-resolved a frame later.
  const pivotRef = useRef<Pt | null>(null);
  /// Likewise the whole transform frame of the last drawn box — what an anchor
  /// gesture converts its cursor movement through.
  const geomRef = useRef<LayerQuadInput | null>(null);
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
      const stalk = stalkRef.current;
      const knob = knobRef.current;
      const anchor = anchorRef.current;
      const svg = svgRef.current;
      const probe = getGizmoProbe();
      if (!box || !stalk || !knob || !anchor || !svg) return;
      const show = (on: boolean): void => {
        const display = on ? "" : "none";
        box.style.display = display;
        stalk.style.display = display;
        knob.style.display = display;
        anchor.style.display = display;
      };
      const hide = (): void => show(false);
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
      // The in-flight gesture is read from the OVERRIDE map rather than from
      // `dragRef`, because that map is also what the Compositor folds into the
      // picture (`withTransformOverride`). Same source ⇒ the box and the
      // footprint it outlines cannot disagree mid-drag, whichever handle is
      // being moved. Absent (no gesture) ⇒ all zeroes.
      const d = transformOverrideFor(l.id);
      // The box is the layer's footprint, so it reads the UNSIGNED scale: a
      // flip mirrors the content within the same box (anchorPivot.ts), so
      // folding `flip_h` in here would only reverse the vertex order.
      const geom: LayerQuadInput = {
        x: resolveAnimated(p.x, tLocalUs, 0) + (d?.dx ?? 0),
        y: resolveAnimated(p.y, tLocalUs, 0) + (d?.dy ?? 0),
        // DEFAULT_ANCHOR and nothing else — the same constant the renderer
        // resolves through (resolveView.ts). A local fallback here is exactly
        // how the box and the picture once pivoted around different points.
        anchorX: resolveAnimated(p.anchor_x, tLocalUs, DEFAULT_ANCHOR) + (d?.danchorX ?? 0),
        anchorY: resolveAnimated(p.anchor_y, tLocalUs, DEFAULT_ANCHOR) + (d?.danchorY ?? 0),
        naturalW: size.w,
        naturalH: size.h,
        scaleX: resolveAnimated(p.scale_x, tLocalUs, 1),
        scaleY: resolveAnimated(p.scale_y, tLocalUs, 1),
        rotationDeg: resolveAnimated(p.rotation_deg, tLocalUs, 0) + (d?.drotDeg ?? 0),
        origin: originFor(p.kind),
      };
      geomRef.current = geom;
      // The SVG is inset:0 inside the preview panel, so subtract its own client
      // origin to land in its coordinate system. A pure translation, so the
      // handle's screen-space gap survives it unchanged.
      const own = svg.getBoundingClientRect();
      const local = (c: Pt): Pt => ({ x: c.x - own.left, y: c.y - own.top });
      const corners = layerQuad(geom).map((corner) => local(compToClient(corner, fit)));
      box.setAttribute("points", corners.map((c) => `${c.x},${c.y}`).join(" "));
      // Client, not SVG-local: pointer events speak client coordinates.
      const pivotClient = compToClient(layerPivot(geom), fit);
      pivotRef.current = pivotClient;
      // The reticle's parts are drawn once around (0,0) and the whole group is
      // translated — one attribute write per frame instead of six.
      const pivotLocal = local(pivotClient);
      anchor.setAttribute("transform", `translate(${pivotLocal.x} ${pivotLocal.y})`);
      const handle = rotateHandle(corners, ROTATE_GAP_PX);
      if (!handle) return hide();
      stalk.setAttribute("x1", String(handle.root.x));
      stalk.setAttribute("y1", String(handle.root.y));
      stalk.setAttribute("x2", String(handle.knob.x));
      stalk.setAttribute("y2", String(handle.knob.y));
      knob.setAttribute("cx", String(handle.knob.x));
      knob.setAttribute("cy", String(handle.knob.y));
      show(true);
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

  /// Layer-local time for a gesture starting now, frozen and frame-snapped.
  const grabTimeUs = (): number => {
    const l = layerRef.current;
    const comp = compRef.current;
    return snapFrameRound(playheadTimeUs() - l.t_start_us, comp.fps_num, comp.fps_den);
  };

  const beginDrag = (e: React.PointerEvent<SVGPolygonElement>): void => {
    if (e.button !== 0) return;
    // The preview is not a selection surface, so nothing downstream needs this
    // press — and letting it through would start a canvas-level gesture.
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      kind: "move",
      startClientX: e.clientX,
      startClientY: e.clientY,
      tInLayerUs: grabTimeUs(),
      dxComp: 0,
      dyComp: 0,
    };
    // Capture so the drag survives the pointer leaving the box (which it always
    // does — the box is being dragged out from under the cursor).
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent<SVGPolygonElement>): void => {
    const drag = dragRef.current;
    if (drag?.kind !== "move") return;
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
    if (drag?.kind !== "move") return;
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

  const beginRotate = (e: React.PointerEvent<SVGCircleElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const pivotClient = pivotRef.current;
    if (!pivotClient) return;
    const tInLayerUs = grabTimeUs();
    dragRef.current = {
      kind: "rotate",
      tInLayerUs,
      pivotClient,
      baseDeg: resolveAnimated(transformFields(layerRef.current).rotation_deg, tInLayerUs, 0),
      lastAngleDeg: angleAboutDeg(pivotClient, { x: e.clientX, y: e.clientY }),
      rawDeltaDeg: 0,
      deltaDeg: 0,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const moveRotate = (e: React.PointerEvent<SVGCircleElement>): void => {
    const drag = dragRef.current;
    if (drag?.kind !== "rotate") return;
    const now = angleAboutDeg(drag.pivotClient, { x: e.clientX, y: e.clientY });
    // Accumulate normalized increments — see `shortestDeltaDeg`: diffing against
    // the start angle would spin the layer backwards across the ±180° cut, and
    // this way a knob dragged twice around means two full turns.
    drag.rawDeltaDeg += shortestDeltaDeg(now - drag.lastAngleDeg);
    drag.lastAngleDeg = now;
    const target = drag.baseDeg + drag.rawDeltaDeg;
    drag.deltaDeg =
      (e.shiftKey ? snapAngleDeg(target, ROTATE_SNAP_DEG) : target) - drag.baseDeg;
    setTransformOverride(layerRef.current.id, { dx: 0, dy: 0, drotDeg: drag.deltaDeg });
  };

  const endRotate = (e: React.PointerEvent<SVGCircleElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag?.kind !== "rotate") return;
    const l = layerRef.current;
    if (drag.deltaDeg === 0) {
      clearTransformOverride(l.id);
      return;
    }
    const track: AnimTrack<number> = readParamTrack(l.params, "rotation_deg") ?? {
      mode: "Static",
      value: 0,
    };
    // No fan-out: unlike scale, rotation is a single track on every kind — the
    // linked-scale twin invariant doesn't apply here (spec D6).
    updateLayerParamTracks(l.id, [
      [
        "rotation_deg",
        autoKeyTrack(
          track,
          drag.tInLayerUs,
          resolveAnimated(track, drag.tInLayerUs, 0) + drag.deltaDeg,
        ),
      ],
    ]).catch((err) => {
      clearTransformOverride(l.id);
      console.warn("transform gizmo rotate commit failed:", err);
    });
  };

  const beginAnchor = (e: React.PointerEvent<SVGCircleElement>): void => {
    if (e.button !== 0) return;
    // Must beat the box underneath, which claims its whole footprint as a move
    // handle and contains the reticle by construction.
    e.preventDefault();
    e.stopPropagation();
    const frame = geomRef.current;
    if (!frame) return;
    dragRef.current = {
      kind: "anchor",
      tInLayerUs: grabTimeUs(),
      startClientX: e.clientX,
      startClientY: e.clientY,
      frame,
      dAnchorX: 0,
      dAnchorY: 0,
      compDx: 0,
      compDy: 0,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const moveAnchor = (e: React.PointerEvent<SVGCircleElement>): void => {
    const drag = dragRef.current;
    if (drag?.kind !== "anchor") return;
    const rect = getGizmoProbe()?.canvasRect();
    const fit = rect ? containFit(rect, compRef.current.width, compRef.current.height) : null;
    if (!fit) return;
    const frame = drag.frame;
    if (frame.naturalW <= 0 || frame.naturalH <= 0) return;
    // client → composition → the layer's own local pixels → normalized. The
    // middle step is what keeps the reticle under the cursor on a rotated or
    // non-uniformly scaled layer.
    const dComp = clientDeltaToComp(
      e.clientX - drag.startClientX,
      e.clientY - drag.startClientY,
      fit,
    );
    const dLocal = compDeltaToLocal(dComp, frame);
    if (!dLocal) return; // a flat axis has no local extent to move along
    drag.dAnchorX = dLocal.x / frame.naturalW;
    drag.dAnchorY = dLocal.y / frame.naturalH;
    const comp = anchorCompensation(frame, drag.dAnchorX, drag.dAnchorY);
    drag.compDx = comp.x;
    drag.compDy = comp.y;
    setTransformOverride(layerRef.current.id, {
      dx: comp.x,
      dy: comp.y,
      danchorX: drag.dAnchorX,
      danchorY: drag.dAnchorY,
    });
  };

  const endAnchor = (e: React.PointerEvent<SVGCircleElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag?.kind !== "anchor") return;
    const l = layerRef.current;
    if (drag.dAnchorX === 0 && drag.dAnchorY === 0) {
      clearTransformOverride(l.id);
      return;
    }
    const at = (key: string, fallback: number): AnimTrack<number> =>
      readParamTrack(l.params, key) ?? { mode: "Static", value: fallback };
    const anchorX = at("anchor_x", DEFAULT_ANCHOR);
    const anchorY = at("anchor_y", DEFAULT_ANCHOR);
    const entries: Array<[string, AnimTrack<number>]> = [
      ["anchor_x", autoKeyTrack(anchorX, drag.tInLayerUs, resolveAnimated(anchorX, drag.tInLayerUs, DEFAULT_ANCHOR) + drag.dAnchorX)],
      ["anchor_y", autoKeyTrack(anchorY, drag.tInLayerUs, resolveAnimated(anchorY, drag.tInLayerUs, DEFAULT_ANCHOR) + drag.dAnchorY)],
    ];
    // The pan-behind compensation rides the SAME batch — one undo step for the
    // whole gesture. Skipped when it is exactly zero, which is the common case
    // (an unrotated, unflipped media layer): writing it anyway would stamp a
    // redundant key on `x`/`y` for a gesture that never moved the picture.
    if (drag.compDx !== 0 || drag.compDy !== 0) {
      const xTrack = at("x", 0);
      const yTrack = at("y", 0);
      entries.push(
        ["x", autoKeyTrack(xTrack, drag.tInLayerUs, resolveAnimated(xTrack, drag.tInLayerUs, 0) + drag.compDx)],
        ["y", autoKeyTrack(yTrack, drag.tInLayerUs, resolveAnimated(yTrack, drag.tInLayerUs, 0) + drag.compDy)],
      );
    }
    updateLayerParamTracks(l.id, entries).catch((err) => {
      clearTransformOverride(l.id);
      console.warn("transform gizmo anchor commit failed:", err);
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
        // The rotation knob hangs OUTSIDE the box, so for a layer at the top of
        // the composition it lands outside the SVG viewport too — which an SVG
        // clips by default. The preview panel still clips it, which is the
        // intended bound.
        overflow: "visible",
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
      <line
        ref={stalkRef}
        data-testid="transform-gizmo-stalk"
        style={{
          // Solid where the box is dashed, so the stalk reads as an affordance
          // rather than as part of the footprint. The knob is the hit target.
          stroke: "var(--ring)",
          strokeWidth: 1.5,
          pointerEvents: "none",
          display: "none",
        }}
      />
      <circle
        ref={knobRef}
        data-testid="transform-gizmo-rotate"
        r={ROTATE_KNOB_R}
        onPointerDown={beginRotate}
        onPointerMove={moveRotate}
        onPointerUp={endRotate}
        onPointerCancel={endRotate}
        style={{
          fill: "var(--ring)",
          // Same trick as the box's fill: under `pointerEvents: all` a fully
          // transparent stroke still hit-tests, so this widens a 10 px dot to a
          // ~20 px grab target without drawing anything.
          stroke: "rgba(0, 0, 0, 0)",
          strokeWidth: 10,
          pointerEvents: "all",
          cursor: "grab",
          display: "none",
        }}
      />
      {/* The anchor target, LAST in document order on purpose: it sits inside
          the box, which claims its whole footprint for the move drag, and SVG
          hit-tests the topmost painted element — so an earlier reticle would be
          unreachable. Every child is drawn about (0,0) and the group carries the
          translate (see the draw loop). */}
      <g ref={anchorRef} data-testid="transform-gizmo-anchor" style={{ display: "none" }}>
        {/* Dark under-stroke, then the light ring/arms on top: the target has to
            stay legible over both a white and a black frame, and the preview has
            no background to contrast against. */}
        <g
          style={{
            fill: "none",
            stroke: "rgba(0, 0, 0, 0.55)",
            strokeWidth: 3.5,
            pointerEvents: "none",
          }}
        >
          <circle cx={0} cy={0} r={ANCHOR_RING_R} />
          <line x1={-ANCHOR_ARM_PX} y1={0} x2={ANCHOR_ARM_PX} y2={0} />
          <line x1={0} y1={-ANCHOR_ARM_PX} x2={0} y2={ANCHOR_ARM_PX} />
        </g>
        <g
          style={{
            fill: "none",
            stroke: "var(--ring)",
            strokeWidth: 1.5,
            pointerEvents: "none",
          }}
        >
          <circle cx={0} cy={0} r={ANCHOR_RING_R} />
          <line x1={-ANCHOR_ARM_PX} y1={0} x2={ANCHOR_ARM_PX} y2={0} />
          <line x1={0} y1={-ANCHOR_ARM_PX} x2={0} y2={ANCHOR_ARM_PX} />
        </g>
        <circle
          data-testid="transform-gizmo-anchor-grab"
          cx={0}
          cy={0}
          r={ANCHOR_HIT_R}
          onPointerDown={beginAnchor}
          onPointerMove={moveAnchor}
          onPointerUp={endAnchor}
          onPointerCancel={endAnchor}
          style={{
            // Invisible but hit-testable, same trick as the box's fill.
            fill: "rgba(0, 0, 0, 0)",
            pointerEvents: "all",
            cursor: "move",
          }}
        />
      </g>
    </svg>
  );
}

function originFor(kind: string): TransformOrigin {
  // docs/data-model.md#transform: only Text stores the anchor point as x/y.
  return kind === "Text" ? "anchor" : "top-left";
}
