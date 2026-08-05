// On-canvas transform box for the primary selected layer: shows its footprint
// over the preview, drags it to a new position, resizes it by the handles on its
// corners and edges, rotates it by the knob on a stalk above its top edge, and
// moves its anchor by the target reticle at the pivot.
//
// Screen-space by design — an SVG overlay, not Pixi children. The stage is
// read back by the eyedropper and by the conformance capture hooks, so anything
// drawn into it would poison those buffers; and a box drawn in composition
// space would be sub-pixel on a 4K composition shown in a small panel.
//
// Every pointer- and frame-rate update here is imperative through refs: the box
// follows animated x/y during playback, and a per-frame React state write is
// exactly what the memory-ratchet gate exists to catch.
// Spec: docs/features.md#on-canvas-transform-gizmo

import { useEffect, useRef } from "react";
import { RotateCcwIcon } from "lucide-react";

import { snapFrameRound } from "../frames";
import {
  updateLayerParamTracks,
  type AnimTrack,
  type CompositionSummary,
  type LayerSummary,
  type ProjectSummary,
} from "../ipc";
import { autoKeyTrack } from "../keyframe/autoKey";
import { readParamTrack, readScaleLinked, scaleFanOutFor } from "../keyframe/descriptors";
import { fanOutEntries } from "../keyframe/fanOut";
import { resolveAnimated } from "../render/animated";
import { DEFAULT_ANCHOR } from "../render/anchorPivot";
import {
  clearTransformOverride,
  setTransformOverride,
  transformOverrideFor,
  type TransformDelta,
} from "../render/transformOverrides";
import { useProjectStore } from "../state/projectStore";
import { playheadTimeUs } from "../state/playheadStore";
import { usePrimaryLayerId } from "../state/selectionStore";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import {
  anchorCompensation,
  angleAboutDeg,
  clientDeltaToComp,
  compDeltaToLocal,
  compToClient,
  containFit,
  handleDrives,
  handleOutwardDeg,
  isCornerHandle,
  layerPivot,
  layerQuad,
  resizeCursorForDeg,
  rotateHandle,
  scaleCompensation,
  scaleFromUniformT,
  scaleHandlePoints,
  SCALE_HANDLE_IDS,
  shortestDeltaDeg,
  snapAngleDeg,
  solveScale,
  uniformScaleRay,
  type ContainFit,
  type LayerQuadInput,
  type Pt,
  type ScaleHandleId,
  type TransformOrigin,
} from "./gizmoGeometry";
import { getGizmoProbe, type GizmoProbe } from "./gizmoProbeRegistry";
import {
  quadAabb,
  snapMove,
  snapScaleTarget,
  snapTargets,
  snapThresholdComp,
  snapUniformScale,
  type Aabb,
  type DrivenAxes,
  type SnapGuides,
  type SnapTargets,
} from "./previewSnap";

/// Client-pixel gap between the box's top edge and the rotation knob, and the
/// disc the knob draws. Screen space, so the affordance is identical on a 4K
/// composition and a 480p one.
///
/// The disc is a legibility backing, not decoration: it carries a rotate glyph
/// that says what the handle does, and the preview has no background of its own
/// to read that glyph against (the same problem the anchor reticle solves with
/// its dark under-stroke).
const ROTATE_GAP_PX = 26;
const ROTATE_KNOB_R = 8;
/// The glyph inside the disc, and the invisible grab disc around it. Lucide art
/// is a 24-unit viewBox, so `absoluteStrokeWidth` is what keeps the stroke at
/// the gizmo's usual ~1.3 px instead of scaling it down to a hairline.
const ROTATE_GLYPH_PX = 11;
const ROTATE_GLYPH_STROKE_PX = 1.3;
const ROTATE_HIT_R = 13;
/// Shift-constrained rotation grid — the de-facto standard step.
const ROTATE_SNAP_DEG = 15;
/// The anchor target: a ring with crosshair arms reaching past it, and an
/// invisible grab disc. Client pixels for the same reason as the knob. The arms
/// out-reach the ring on purpose — the exact centre is the thing being placed,
/// and a bare ring over busy footage hides it.
const ANCHOR_RING_R = 5.5;
const ANCHOR_ARM_PX = 9;
const ANCHOR_HIT_R = 11;
/// Resize handles: the drawn dot, and the invisible disc that widens it into a
/// comfortable grab target. Client pixels again — the handle must not shrink
/// with the composition. The hit disc is kept modest on purpose: every pixel it
/// claims comes out of the box's interior, which is the MOVE handle.
///
/// ROUND, not square, and that is a design decision rather than a style one: a
/// circle has no orientation, so the handle needs no rotation to stay consistent
/// with the box. A square would have to be re-rotated every frame to match the
/// box's edges — and on a flipped or non-uniformly scaled layer, where the quad's
/// winding reverses and its edges stop being perpendicular, there is no single
/// correct angle for it to take. The direction that IS meaningful is carried by
/// the cursor instead (`handleOutwardDeg`).
const HANDLE_R_PX = 4.5;
const HANDLE_HIT_R_PX = 8;
/// Below this, an edge's midpoint handle would sit under the two corners it
/// lives between. Hide it rather than stack three targets on one spot — the
/// corners can still scale that axis.
const EDGE_HANDLE_MIN_PX = 24;

/// The snap guides. Hard-coded rather than a theme token because the app's
/// palette is deliberately achromatic (`oklch(x 0 0)`) and a guide has to be
/// findable against arbitrary footage in one glance — the same reason the anchor
/// reticle hard-codes its under-stroke.
///
/// MAGENTA specifically: it needs red and blue high with green low, which is
/// close to absent in natural imagery, so it stays legible over skin, sky, foliage
/// and water alike. And it is not `var(--ring)`, so a guide never reads as part of
/// the selection's own chrome.
const GUIDE_COLOR = "#ff2ec4";
const GUIDE_WIDTH_PX = 1;
/// The dark backing under the bright line, for the same reason the anchor reticle
/// carries one: the preview has no background of its own, and a single-colour
/// hairline disappears against a white or a black frame.
const GUIDE_UNDER_COLOR = "rgba(0, 0, 0, 0.55)";
const GUIDE_UNDER_WIDTH_PX = 3;

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

/// A layer's transform frame at an absolute time, with NO in-flight override
/// folded in. One rule for two readers — the draw loop (which then adds the
/// override on top) and the snap-target collector — so a layer's own box and the
/// box other layers snap it against cannot be derived differently.
///
/// Deliberately reads the MIRROR only, never the commit ledger: what this
/// returns plus the override has to equal what the Compositor draws, and the
/// Compositor's own base is the mirror (`resolveView` + `withTransformOverride`).
/// The unreflected commits reach here as the override's carry instead — see
/// `mergedDelta`. Layering the ledger in on top of that would double-count it.
function frameAt(
  layer: LayerSummary,
  tUs: number,
  size: { w: number; h: number },
): LayerQuadInput {
  const p = transformFields(layer);
  const tLocalUs = tUs - layer.t_start_us;
  return {
    x: resolveAnimated(p.x, tLocalUs, 0),
    y: resolveAnimated(p.y, tLocalUs, 0),
    // DEFAULT_ANCHOR and nothing else — the same constant the renderer resolves
    // through (resolveView.ts). LANDMINE: a local fallback here makes the box
    // pivot where the picture does not, and neither looks broken on its own.
    anchorX: resolveAnimated(p.anchor_x, tLocalUs, DEFAULT_ANCHOR),
    anchorY: resolveAnimated(p.anchor_y, tLocalUs, DEFAULT_ANCHOR),
    naturalW: size.w,
    naturalH: size.h,
    scaleX: resolveAnimated(p.scale_x, tLocalUs, 1),
    scaleY: resolveAnimated(p.scale_y, tLocalUs, 1),
    rotationDeg: resolveAnimated(p.rotation_deg, tLocalUs, 0),
    origin: originFor(p.kind),
  };
}

/// What a gesture snaps against, frozen at pointerdown. Null on a gesture
/// that will never snap — the preference is off, or there is no geometry to snap
/// within — so the move handlers can skip the whole path with one check.
interface SnapContext {
  targets: SnapTargets;
  /// The setting's SCREEN-pixel radius. Converted per move, because the contain
  /// fit it divides by is re-read per move.
  strengthPx: number;
}

/// Every OTHER staged layer's bounding box, composition pixels.
///
/// `TRANSFORM_KINDS` does the filtering that matters here for free: `Color`
/// fills the composition, so its edges ARE the composition's and would only add
/// duplicate lines for the tie-break to sort out, and `Audio` has no footprint
/// at all. A layer the compositor has not staged has no `naturalSizeOf`
/// and is skipped — its size is unknowable, not zero.
function otherLayerBoxes(
  summary: { tracks: readonly { layers: readonly LayerSummary[] }[] },
  selfId: string,
  tUs: number,
  probe: GizmoProbe,
): Aabb[] {
  const boxes: Aabb[] = [];
  for (const track of summary.tracks) {
    for (const other of track.layers) {
      if (other.id === selfId) continue;
      if (!TRANSFORM_KINDS.has(other.params.kind)) continue;
      if (tUs < other.t_start_us || tUs >= other.t_end_us) continue;
      const size = probe.naturalSizeOf(other.id);
      if (!size || size.w <= 0 || size.h <= 0) continue;
      const box = quadAabb(layerQuad(frameAt(other, tUs, size)));
      if (box) boxes.push(box);
    }
  }
  return boxes;
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
  return <TransformGizmo key={found.id} layer={found} summary={summary} />;
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
  /// The layer's own frame, frozen — the snap needs its AABB at the raw
  /// candidate position, which means re-mapping this quad per move. Nullable
  /// unlike the resize gesture's: a move begun before the first draw must still
  /// move, it just cannot snap.
  frame: LayerQuadInput | null;
  snap: SnapContext | null;
  /// Already SNAPPED: the override, the drawn box and the commit all read this,
  /// so there is no un-snapped value anywhere downstream.
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

interface ScaleDrag extends DragBase {
  kind: "scale";
  id: ScaleHandleId;
  startClientX: number;
  startClientY: number;
  /// The geometry the handle was grabbed from, frozen at pointerdown — the base
  /// scale the committed delta is measured from, and the frame the solve
  /// un-rotates the cursor through.
  frame: LayerQuadInput;
  /// The pivot in COMPOSITION pixels, frozen: the point this gesture pins. It
  /// stays truthful for the whole drag because the compensation below is exactly
  /// what holds it there.
  pivotComp: Pt;
  /// Where the grabbed handle sat at pointerdown, composition pixels. The solve
  /// targets `handleComp + cursor delta` rather than the raw cursor, so grabbing
  /// a handle slightly off its centre doesn't snap the box on the first move.
  handleComp: Pt;
  /// Frozen `scale_linked`: a linked layer scales uniformly for the whole
  /// gesture, no modifier involved (and only its corner handles are drawn).
  linked: boolean;
  snap: SnapContext | null;
  /// The direction the handle travels per unit uniform `t` (`R·S₀·u`), frozen
  /// with the frame it comes from. Only the uniform branch uses it, but it is
  /// computed once here rather than per move.
  ray: Pt;
  dScaleX: number;
  dScaleY: number;
  /// The `x`/`y` that keeps the pivot still (`scaleCompensation`). Committed in
  /// the same batch for the same reason as the anchor gesture's: applying the
  /// scale without it is a visible jump.
  compDx: number;
  compDy: number;
}

type Drag = MoveDrag | RotateDrag | AnchorDrag | ScaleDrag;

/// Below this, a gesture's delta is float noise rather than an edit.
///
/// LANDMINE: `Math.cos(±π/2)` is 6e-17, not 0, so anything that passes through
/// the inverse rotation — a resize solve, an anchor drag's `compDeltaToLocal` —
/// leaves ~1e-16 on the axis the cursor did NOT move. Compared against exact
/// zero that reads as an edit, and a keyframed layer collects a redundant key
/// with an invisible value change on every axis-aligned drag. The threshold is
/// far below perceptible for both units in play here (unitless scale, and
/// composition pixels).
const NOISE = 1e-9;

function moved(delta: number): boolean {
  return Math.abs(delta) > NOISE;
}

/// Tracks this gizmo has COMMITTED but the project mirror may not carry yet:
/// `param key → the track that was written`. Maintained by `commitEntries`.
type TrackLedger = ReadonlyMap<string, AnimTrack<number>>;

/// Where a commit reads its base values: the project mirror, with the ledger
/// layered over it. The two always travel together, so they are one argument.
interface CommitBase {
  layer: LayerSummary;
  ledger: TrackLedger;
}

/// The layer's track for `key` — LEDGER FIRST, then the mirror, then a Static
/// fallback for a kind that doesn't carry that param (or a version skew).
///
/// LANDMINE: reading `layer.params` alone here loses whole gestures. `layer` is
/// the project mirror, and it only refreshes on
/// commit → `project:changed` → refetch → re-render, i.e. TWO IPC round trips.
/// A second gesture released inside that window would read the pre-commit base,
/// and its commit — an absolute track built from base + delta — would overwrite
/// the first one entirely rather than stack on it.
function paramTrack(base: CommitBase, key: string, fallback: number): AnimTrack<number> {
  return (
    base.ledger.get(key) ??
    readParamTrack(base.layer.params, key) ?? { mode: "Static", value: fallback }
  );
}

/// What `key` resolves to at `tInLayerUs` for COMMIT purposes — the value a
/// gesture's delta is added to, and the value a snap grid is measured from.
function resolveBase(
  base: CommitBase,
  key: string,
  fallback: number,
  tInLayerUs: number,
): number {
  return resolveAnimated(paramTrack(base, key, fallback), tInLayerUs, fallback);
}

/// One commit's worth of "add `delta` to what this track resolves to at the
/// gesture's frozen time". `autoKeyTrack` is the shared rule — a Static track
/// takes a plain value, a Keyframed one gets a key at the playhead — so every
/// handle writes tracks exactly the way the inspector does.
function bumpTrack(
  base: CommitBase,
  key: string,
  fallback: number,
  tInLayerUs: number,
  delta: number,
): AnimTrack<number> {
  return autoKeyTrack(
    paramTrack(base, key, fallback),
    tInLayerUs,
    resolveBase(base, key, fallback, tInLayerUs) + delta,
  );
}

function bumpEntry(
  base: CommitBase,
  key: string,
  fallback: number,
  tInLayerUs: number,
  delta: number,
): [string, AnimTrack<number>] {
  return [key, bumpTrack(base, key, fallback, tInLayerUs, delta)];
}

/// The `x`/`y` half of a gesture that has to hold the picture (or the pivot)
/// still, PER AXIS — an axis whose compensation is exactly zero is left out.
/// Both compensating gestures hit that case constantly (an unrotated media
/// layer needs none at all for an anchor drag; a single-axis resize needs one
/// axis), and writing the zero anyway would stamp a redundant keyframe on a
/// track the gesture never moved.
function positionFix(
  base: CommitBase,
  tInLayerUs: number,
  dx: number,
  dy: number,
): Array<[string, AnimTrack<number>]> {
  const entries: Array<[string, AnimTrack<number>]> = [];
  if (moved(dx)) entries.push(bumpEntry(base, "x", 0, tInLayerUs, dx));
  if (moved(dy)) entries.push(bumpEntry(base, "y", 0, tInLayerUs, dy));
  return entries;
}

/// What the live gesture is worth, in override channels. Each `moveXxx` handler
/// writes its result into the drag record and then routes through here, so the
/// override writer and the post-summary rebase cannot disagree about what the
/// gesture contributes — and a channel a gesture does not own stays absent.
function deltaOf(drag: Drag): TransformDelta {
  switch (drag.kind) {
    case "move":
      return { dx: drag.dxComp, dy: drag.dyComp };
    case "rotate":
      return { dx: 0, dy: 0, drotDeg: drag.deltaDeg };
    case "anchor":
      return {
        dx: drag.compDx,
        dy: drag.compDy,
        danchorX: drag.dAnchorX,
        danchorY: drag.dAnchorY,
      };
    case "scale":
      return {
        dx: drag.compDx,
        dy: drag.compDy,
        dscaleX: drag.dScaleX,
        dscaleY: drag.dScaleY,
      };
  }
}

const NO_DELTA: TransformDelta = { dx: 0, dy: 0 };

/// The gesture delta with the CARRY folded in, per channel: what this gizmo has
/// committed that the mirror does not reflect yet, plus what the live gesture is
/// worth right now. Without the carry term, the first pointermove of a second
/// gesture replaces the held override (`setTransformOverride` is replace, not
/// merge) and the layer visibly snaps back by the previous gesture's whole
/// displacement.
///
/// The carry is SELF-CANCELLING: once the post-commit summary lands, the ledger
/// track and the mirror track resolve to the same value and every channel goes
/// to zero. That is what lifts the override, so nothing has to decide when the
/// round trip "finished" — and a summary arriving mid-gesture just moves the
/// carry into the base, with no jump.
function mergedDelta(base: CommitBase, d: TransformDelta, tLocalUs: number): TransformDelta {
  const carry = (key: string, fallback: number): number => {
    const written = base.ledger.get(key);
    if (!written) return 0;
    const live = readParamTrack(base.layer.params, key) ?? { mode: "Static", value: fallback };
    return resolveAnimated(written, tLocalUs, fallback) - resolveAnimated(live, tLocalUs, fallback);
  };
  return {
    dx: d.dx + carry("x", 0),
    dy: d.dy + carry("y", 0),
    drotDeg: (d.drotDeg ?? 0) + carry("rotation_deg", 0),
    danchorX: (d.danchorX ?? 0) + carry("anchor_x", DEFAULT_ANCHOR),
    danchorY: (d.danchorY ?? 0) + carry("anchor_y", DEFAULT_ANCHOR),
    dscaleX: (d.dscaleX ?? 0) + carry("scale_x", 1),
    dscaleY: (d.dscaleY ?? 0) + carry("scale_y", 1),
  };
}

/// Nothing left to apply. `NOISE` rather than exact zero, because a carry can
/// land a hair off zero if the actor canonicalized what we wrote (a keyframe
/// time snapped to the grid, say) — and an override that never quite lifts would
/// leave the layer permanently offset by a float ulp.
function isNoDelta(d: TransformDelta): boolean {
  return (
    !moved(d.dx) &&
    !moved(d.dy) &&
    !moved(d.drotDeg ?? 0) &&
    !moved(d.danchorX ?? 0) &&
    !moved(d.danchorY ?? 0) &&
    !moved(d.dscaleX ?? 0) &&
    !moved(d.dscaleY ?? 0)
  );
}

const NO_GUIDES: SnapGuides = { x: null, y: null };

/// The snap radius in composition pixels for this move, or 0 — which is how both
/// "the preference is off" and "Ctrl is held" reach the solvers, since they all
/// short-circuit on a non-positive threshold. Ctrl is read per move, so tapping
/// it releases the layer from a guide and letting go re-arms it, with no gesture
/// state to carry.
function thresholdFor(
  snap: SnapContext | null,
  fit: ContainFit,
  suppressed: boolean,
): number {
  if (!snap || suppressed) return 0;
  return snapThresholdComp(snap.strengthPx, fit.scale);
}

function TransformGizmo({
  layer,
  summary,
}: {
  layer: LayerSummary;
  summary: ProjectSummary;
}) {
  const composition: CompositionSummary = summary.composition;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const boxRef = useRef<SVGPolygonElement | null>(null);
  const stalkRef = useRef<SVGLineElement | null>(null);
  const knobRef = useRef<SVGGElement | null>(null);
  const anchorRef = useRef<SVGGElement | null>(null);
  /// One group per axis, each holding the dark under-stroke and the bright line
  /// over it. At most one guide per axis exists by construction, so these are two
  /// fixed elements rather than a list that has to be reconciled.
  const guideXRef = useRef<SVGGElement | null>(null);
  const guideYRef = useRef<SVGGElement | null>(null);
  /// The live snap hits, composition space — written by the pointer handlers,
  /// read by the rAF loop. A ref and not state: this changes at pointer rate,
  /// which is precisely what the playhead gate forbids re-rendering for.
  const guidesRef = useRef<SnapGuides>({ x: null, y: null });
  const handleEls = useRef(new Map<ScaleHandleId, SVGGElement>());
  /// Last cursor written per handle, so a rotating box costs one style write
  /// per handle per octant crossed instead of one per frame.
  const handleCursors = useRef(new Map<ScaleHandleId, string>());
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
  // Read only at pointerdown, to build the frozen snap target set.
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  /// Tracks committed by this gizmo whose `project:changed` → refetch has not
  /// come back yet. Two readers: the NEXT gesture's commit base (`paramTrack`),
  /// and the carry the override has to hold so the picture does not fall back to
  /// the stale mirror value mid-burst (`mergedDelta`).
  const pendingRef = useRef(new Map<string, AnimTrack<number>>());
  /// Commits dispatched and not yet settled. The ledger is dropped on the first
  /// summary that arrives with none outstanding, which is how an external writer
  /// — undo, the inspector, an MCP agent — takes the authority back.
  ///
  /// LANDMINE: this counts the MUTATION, which resolves a beat before its own
  /// summary arrives. An unrelated refetch issued before our write landed can
  /// publish in that sub-millisecond gap and drop the ledger early, costing one
  /// nudge. The alternative — comparing the arriving track against what we wrote
  /// — cannot tell "the mirror is behind" from "someone undid me", and
  /// resurrecting an undone drag is the worse failure.
  const inFlightRef = useRef(0);

  /// The base every commit reads from, in one place so no handler reaches into
  /// `layer.params` on its own and re-opens the race.
  const commitBase = (): CommitBase => ({
    layer: layerRef.current,
    ledger: pendingRef.current,
  });

  /// Publish the override for the world as it stands: the live gesture's delta
  /// (none when `drag` is null) plus the carry. THE single writer — every
  /// pointermove, Escape, a settling commit and the summary-arrival effect all
  /// route here, so the box, the picture and the ledger cannot drift apart.
  const applyOverride = (drag: Drag | null): void => {
    const l = layerRef.current;
    const d = drag ? deltaOf(drag) : NO_DELTA;
    // Nothing committed-but-unseen ⇒ the override IS the gesture. A separate
    // path so the common case writes only the channels its own gesture owns
    // rather than seven mostly-zero ones.
    if (pendingRef.current.size === 0) {
      if (drag) setTransformOverride(l.id, d);
      else clearTransformOverride(l.id);
      return;
    }
    // The playhead's own local time, un-snapped: that is the instant the
    // Compositor resolves the tracks at, so it is the instant the carry must be
    // measured at. On a KEYFRAMED track during playback the carry then ages
    // between pointermoves — the same freeze-at-grab limit the gesture's own
    // arithmetic already accepts.
    const merged = mergedDelta(commitBase(), d, playheadTimeUs() - l.t_start_us);
    if (isNoDelta(merged)) clearTransformOverride(l.id);
    else setTransformOverride(l.id, merged);
  };

  /// Send one gesture's batch — one call, one undo step. The written tracks
  /// enter the ledger BEFORE the round trip, which is the whole fix: a gesture
  /// released inside that window reads them as its base instead of the mirror's
  /// pre-commit value.
  const commitEntries = (
    layerId: string,
    entries: Array<[string, AnimTrack<number>]>,
    what: string,
  ): void => {
    for (const [key, track] of entries) pendingRef.current.set(key, track);
    inFlightRef.current += 1;
    updateLayerParamTracks(layerId, entries)
      .catch((err) => {
        // Nothing landed, so those ledger entries are fiction and no summary is
        // coming to lift their carry.
        for (const [key] of entries) pendingRef.current.delete(key);
        console.warn(`transform gizmo ${what} commit failed:`, err);
      })
      .finally(() => {
        inFlightRef.current -= 1;
        // Re-derive rather than clear: on failure this rolls the carry back, and
        // on success it is a no-op until the summary lands.
        applyOverride(dragRef.current);
      });
  };

  /// A fresh summary has landed (a new summary IS a new `layer` object).
  ///
  /// First the ledger is dropped if this gizmo has nothing outstanding — the
  /// mirror is then as current as anything we know.
  ///
  /// Then the override is re-derived. The carry goes to zero exactly when this
  /// summary is the one carrying our write, so this IS the lift the old
  /// unconditional clear performed: clearing on the mutation's resolve instead
  /// would snap the layer back for the frame or two until the refetch lands.
  /// Unlike that clear it also handles a summary arriving MID-gesture, where the
  /// gesture's delta has to be re-based onto the new value rather than dropped.
  useEffect(() => {
    if (inFlightRef.current === 0 && !dragRef.current) pendingRef.current.clear();
    applyOverride(dragRef.current);
  }, [layer]);

  useEffect(() => {
    const layerId = layerRef.current.id;
    return () => clearTransformOverride(layerId);
  }, []);

  useEffect(() => {
    let frame = 0;
    /// Position, show and cursor the eight resize handles for an already-mapped
    /// box. A linked layer keeps its CORNERS only: one axis of it cannot move
    /// without the other, so an edge handle would either lie about what it does
    /// or silently unlink the layer.
    const placeScaleHandles = (corners: Pt[], linked: boolean): void => {
      const points = scaleHandlePoints(corners);
      if (!points) return;
      const [tl, tr, , bl] = corners as [Pt, Pt, Pt, Pt];
      const edgeLen = {
        // Which edge each midpoint handle lives ON — a handle is hidden when
        // that edge is too short to separate it from its two corners.
        x: Math.hypot(tr.x - tl.x, tr.y - tl.y),
        y: Math.hypot(bl.x - tl.x, bl.y - tl.y),
      };
      for (const { id, at } of points) {
        const el = handleEls.current.get(id);
        if (!el) continue;
        const along = id === "t" || id === "b" ? edgeLen.x : edgeLen.y;
        const on = isCornerHandle(id) || (!linked && along >= EDGE_HANDLE_MIN_PX);
        el.style.display = on ? "" : "none";
        if (!on) continue;
        el.setAttribute("transform", `translate(${at.x} ${at.y})`);
        const deg = handleOutwardDeg(corners, id);
        if (deg === null) continue;
        const cursor = resizeCursorForDeg(deg);
        if (handleCursors.current.get(id) !== cursor) {
          handleCursors.current.set(id, cursor);
          el.style.cursor = cursor;
        }
      }
    };
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
      // The resize handles are NOT part of `show`: which of them exist depends
      // on the layer (linked ⇒ corners only) and on the box's drawn size, so
      // the visible path decides each one individually below.
      const hideGuides = (): void => {
        if (guideXRef.current) guideXRef.current.style.display = "none";
        if (guideYRef.current) guideYRef.current.style.display = "none";
      };
      const hide = (): void => {
        show(false);
        hideGuides();
        for (const el of handleEls.current.values()) el.style.display = "none";
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
      // The in-flight gesture is read from the OVERRIDE map rather than from
      // `dragRef`, because that map is also what the Compositor folds into the
      // picture (`withTransformOverride`). Same source ⇒ the box and the
      // footprint it outlines cannot disagree mid-drag, whichever handle is
      // being moved. Absent (no gesture) ⇒ all zeroes.
      const d = transformOverrideFor(l.id);
      // The box is the layer's footprint, so it reads the UNSIGNED scale: a
      // flip mirrors the content within the same box (anchorPivot.ts), so
      // folding `flip_h` in here would only reverse the vertex order.
      const base = frameAt(l, tUs, size);
      const geom: LayerQuadInput = {
        ...base,
        x: base.x + (d?.dx ?? 0),
        y: base.y + (d?.dy ?? 0),
        anchorX: (base.anchorX ?? DEFAULT_ANCHOR) + (d?.danchorX ?? 0),
        anchorY: (base.anchorY ?? DEFAULT_ANCHOR) + (d?.danchorY ?? 0),
        scaleX: base.scaleX + (d?.dscaleX ?? 0),
        scaleY: base.scaleY + (d?.dscaleY ?? 0),
        rotationDeg: base.rotationDeg + (d?.drotDeg ?? 0),
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
      // Translated, never rotated, and that is deliberate: the disc is round so
      // it needs no angle, and the glyph inside it is a LABEL — turning it with
      // the box would leave it upside-down at 180°, which is the one thing an
      // icon must not do.
      knob.setAttribute("transform", `translate(${handle.knob.x} ${handle.knob.y})`);
      placeScaleHandles(corners, readScaleLinked(l.params));
      // Guides last: they are a statement about the gesture, drawn from the
      // frozen target the solver picked (composition space) rather than from the
      // box — so they stay put while the layer slides onto them.
      const live = guidesRef.current;
      const paintGuide = (el: SVGGElement | null, a: Pt, b: Pt): void => {
        if (!el) return;
        const p1 = local(compToClient(a, fit));
        const p2 = local(compToClient(b, fit));
        el.style.display = "";
        // Both children — the dark under-stroke and the bright line over it —
        // share one geometry; only their strokes differ.
        for (let i = 0; i < el.children.length; i += 1) {
          const line = el.children[i]!;
          line.setAttribute("x1", String(p1.x));
          line.setAttribute("y1", String(p1.y));
          line.setAttribute("x2", String(p2.x));
          line.setAttribute("y2", String(p2.y));
        }
      };
      if (live.x === null) {
        if (guideXRef.current) guideXRef.current.style.display = "none";
      } else {
        paintGuide(guideXRef.current, { x: live.x, y: 0 }, { x: live.x, y: comp.height });
      }
      if (live.y === null) {
        if (guideYRef.current) guideYRef.current.style.display = "none";
      } else {
        paintGuide(guideYRef.current, { x: 0, y: live.y }, { x: comp.width, y: live.y });
      }
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
      guidesRef.current = NO_GUIDES;
      // Re-derive, not clear: Escape cancels the LIVE gesture, not the ones
      // already committed, so a carry has to survive it.
      applyOverride(null);
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

  /// The snap target set for a gesture starting now, frozen here and nowhere
  /// else. Null when the gesture will never snap — the preference is off, or the
  /// probe is gone — so the move handlers skip the whole path on one check.
  ///
  /// Recomputing this per move would run seven `resolveAnimated` calls plus a
  /// quad build for every staged layer at pointer rate. The cost of freezing is
  /// the same limit every part of a gesture accepts: if the playhead advances
  /// mid-drag, the guides do not follow the animated layers.
  const grabSnap = (): SnapContext | null => {
    const settings = useAppSettingsStore.getState().settings;
    if (!settings.preview_snap_enabled) return null;
    const probe = getGizmoProbe();
    if (!probe) return null;
    const comp = compRef.current;
    const others = otherLayerBoxes(
      summaryRef.current,
      layerRef.current.id,
      playheadTimeUs(),
      probe,
    );
    return {
      targets: snapTargets(comp.width, comp.height, others),
      strengthPx: settings.preview_snap_strength_px,
    };
  };

  const beginDrag = (e: React.PointerEvent<SVGPolygonElement>): void => {
    if (e.button !== 0) return;
    // The preview is not a selection surface, so nothing downstream needs this
    // press — and letting it through would start a canvas-level gesture.
    e.preventDefault();
    e.stopPropagation();
    // Nullable, unlike the resize gesture's: a move without a drawn frame yet
    // must still move, it just cannot snap.
    const frame = geomRef.current;
    dragRef.current = {
      kind: "move",
      startClientX: e.clientX,
      startClientY: e.clientY,
      tInLayerUs: grabTimeUs(),
      frame,
      snap: frame ? grabSnap() : null,
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
    const raw = clientDeltaToComp(
      e.clientX - drag.startClientX,
      e.clientY - drag.startClientY,
      fit,
    );
    // The box at the RAW position. LANDMINE: it must be the un-snapped one — the
    // box depends on the override, the override on this result, and this result
    // on the box, so reading the box after the write is the one ordering of the
    // three that fails to terminate.
    const rawBox = drag.frame
      ? quadAabb(layerQuad({ ...drag.frame, x: drag.frame.x + raw.x, y: drag.frame.y + raw.y }))
      : null;
    const hit =
      drag.snap && rawBox
        ? snapMove(rawBox, drag.snap.targets, thresholdFor(drag.snap, fit, e.ctrlKey))
        : null;
    drag.dxComp = raw.x + (hit?.dx ?? 0);
    drag.dyComp = raw.y + (hit?.dy ?? 0);
    guidesRef.current = hit?.guides ?? NO_GUIDES;
    // Transient only — one IPC write per pointermove would be a full
    // renderer→main→refetch round trip and would pile up undo steps.
    applyOverride(drag);
  };

  const endDrag = (e: React.PointerEvent<SVGPolygonElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    guidesRef.current = NO_GUIDES;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag?.kind !== "move") return;
    const base = commitBase();
    if (drag.dxComp === 0 && drag.dyComp === 0) {
      // Not a clear: a carry from an earlier gesture in this burst has to
      // survive a click that moved nothing.
      applyOverride(null);
      return;
    }
    // One batch = one undo step.
    commitEntries(
      base.layer.id,
      [
        bumpEntry(base, "x", 0, drag.tInLayerUs, drag.dxComp),
        bumpEntry(base, "y", 0, drag.tInLayerUs, drag.dyComp),
      ],
      "move",
    );
  };

  const beginRotate = (e: React.PointerEvent<SVGGElement>): void => {
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
      // Ledger-aware: the Shift grid is measured from here (see `moveRotate`),
      // so reading the stale mirror would snap a second rotation onto a
      // multiple of 15° relative to an angle that is no longer on screen.
      baseDeg: resolveBase(commitBase(), "rotation_deg", 0, tInLayerUs),
      lastAngleDeg: angleAboutDeg(pivotClient, { x: e.clientX, y: e.clientY }),
      rawDeltaDeg: 0,
      deltaDeg: 0,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const moveRotate = (e: React.PointerEvent<SVGGElement>): void => {
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
    applyOverride(drag);
  };

  const endRotate = (e: React.PointerEvent<SVGGElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag?.kind !== "rotate") return;
    const base = commitBase();
    if (drag.deltaDeg === 0) {
      applyOverride(null);
      return;
    }
    // No fan-out: unlike scale, rotation is a single track on every kind, so the
    // linked-scale twin invariant doesn't apply here.
    commitEntries(
      base.layer.id,
      [bumpEntry(base, "rotation_deg", 0, drag.tInLayerUs, drag.deltaDeg)],
      "rotate",
    );
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
    applyOverride(drag);
  };

  const endAnchor = (e: React.PointerEvent<SVGCircleElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag?.kind !== "anchor") return;
    const base = commitBase();
    if (drag.dAnchorX === 0 && drag.dAnchorY === 0) {
      applyOverride(null);
      return;
    }
    const entries: Array<[string, AnimTrack<number>]> = [
      bumpEntry(base, "anchor_x", DEFAULT_ANCHOR, drag.tInLayerUs, drag.dAnchorX),
      bumpEntry(base, "anchor_y", DEFAULT_ANCHOR, drag.tInLayerUs, drag.dAnchorY),
    ];
    // The pan-behind compensation rides the SAME batch — one undo step for the
    // whole gesture. Skipped when it is exactly zero, which is the common case
    // (an unrotated, unflipped media layer): writing it anyway would stamp a
    // redundant key on `x`/`y` for a gesture that never moved the picture.
    entries.push(...positionFix(base, drag.tInLayerUs, drag.compDx, drag.compDy));
    commitEntries(base.layer.id, entries, "anchor");
  };

  const beginScale = (e: React.PointerEvent<SVGGElement>, id: ScaleHandleId): void => {
    if (e.button !== 0) return;
    // Must beat the box underneath, which claims its whole footprint as a move
    // handle and contains every handle by construction.
    e.preventDefault();
    e.stopPropagation();
    const frame = geomRef.current;
    if (!frame || frame.naturalW <= 0 || frame.naturalH <= 0) return;
    // Composition space, from the same frozen frame the solve runs in — so the
    // gesture's arithmetic is self-consistent even if the layer is animating.
    const handleComp = scaleHandlePoints(layerQuad(frame))?.find((h) => h.id === id)?.at;
    if (!handleComp) return;
    dragRef.current = {
      kind: "scale",
      id,
      tInLayerUs: grabTimeUs(),
      startClientX: e.clientX,
      startClientY: e.clientY,
      frame,
      pivotComp: layerPivot(frame),
      handleComp,
      linked: readScaleLinked(layerRef.current.params),
      snap: grabSnap(),
      ray: uniformScaleRay(frame, id),
      dScaleX: 0,
      dScaleY: 0,
      compDx: 0,
      compDy: 0,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const moveScale = (e: React.PointerEvent<SVGGElement>): void => {
    const drag = dragRef.current;
    if (drag?.kind !== "scale") return;
    const rect = getGizmoProbe()?.canvasRect();
    const fit = rect ? containFit(rect, compRef.current.width, compRef.current.height) : null;
    if (!fit) return;
    // The target is the handle's own start plus the cursor's travel, not the
    // raw cursor: grabbing a handle a few pixels off centre must not snap the
    // box by those pixels on the first move.
    const d = clientDeltaToComp(e.clientX - drag.startClientX, e.clientY - drag.startClientY, fit);
    const rawTarget = { x: drag.handleComp.x + d.x, y: drag.handleComp.y + d.y };
    // A linked layer is uniform for the whole gesture; Shift is the usual
    // constrain-proportions modifier for an unlinked one.
    const uniform = drag.linked || e.shiftKey;
    const threshold = thresholdFor(drag.snap, fit, e.ctrlKey);
    // Straight off HANDLE_DIR, never re-derived: an axis this handle does not
    // drive is one `solveScale` would leave alone, so snapping there would draw
    // a guide for a change that then gets discarded.
    const drives: DrivenAxes = handleDrives(drag.id);
    let next: { scaleX: number; scaleY: number } | null;
    let guides: SnapGuides = NO_GUIDES;
    if (uniform) {
      // One degree of freedom, so the snapped POINT is generally unreachable:
      // fit `t` first, then slide `t` along the handle's ray onto the line. At
      // most one axis is hit, which is what one parameter permits.
      const raw = solveScale(drag.frame, drag.id, rawTarget, drag.pivotComp, true);
      if (!raw) return; // the handle has collapsed onto the pivot — no lever left
      const rawT = raw.uniformT;
      const snapped =
        drag.snap && rawT !== undefined
          ? snapUniformScale(
              drag.pivotComp,
              drag.ray,
              rawT,
              drives,
              drag.snap.targets,
              threshold,
            )
          : null;
      // `scaleFromUniformT` is also what the solve used, so an un-snapped `t`
      // round-trips to exactly `raw` rather than to a float-drifted copy.
      next = snapped ? scaleFromUniformT(drag.frame, snapped.t) : raw;
      guides = snapped?.guides ?? NO_GUIDES;
    } else {
      // Free scaling reaches any point, and `solveScale` lands the handle ON the
      // point identically — so snapping the point IS snapping the handle, at any
      // rotation.
      const snapped = drag.snap
        ? snapScaleTarget(rawTarget, drives, drag.snap.targets, threshold)
        : null;
      next = solveScale(
        drag.frame,
        drag.id,
        snapped?.target ?? rawTarget,
        drag.pivotComp,
        false,
      );
      if (!next) return; // the handle has collapsed onto the pivot — no lever left
      guides = snapped?.guides ?? NO_GUIDES;
    }
    guidesRef.current = guides;
    drag.dScaleX = next.scaleX - drag.frame.scaleX;
    drag.dScaleY = next.scaleY - drag.frame.scaleY;
    const fix = scaleCompensation(drag.frame, next.scaleX, next.scaleY);
    drag.compDx = fix.x;
    drag.compDy = fix.y;
    applyOverride(drag);
  };

  const endScale = (e: React.PointerEvent<SVGGElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    guidesRef.current = NO_GUIDES;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (drag?.kind !== "scale") return;
    const base = commitBase();
    const l = base.layer;
    if (!moved(drag.dScaleX) && !moved(drag.dScaleY)) {
      applyOverride(null);
      return;
    }
    // LANDMINE (docs/data-model.md#transform): a linked layer must be written as
    // ONE authored track fanned out to both axes. Two independently built tracks
    // would differ by a float ulp or a keyframe id and the main-side twin
    // invariant would read that as divergence and silently clear `scale_linked`.
    // `scale_linked` is a flag the gizmo never writes, so it is read from the
    // mirror and needs no ledger — only the TRACKS can be one round trip stale.
    const fan = scaleFanOutFor("scale_x", l.params);
    const entries: Array<[string, AnimTrack<number>]> = [];
    if (fan) {
      entries.push(
        ...fanOutEntries(fan, bumpTrack(base, "scale_x", 1, drag.tInLayerUs, drag.dScaleX)),
      );
    } else {
      // Per axis, so an edge handle (or a corner on a rotated layer that only
      // grew one way) leaves the untouched axis alone rather than re-keying it.
      if (moved(drag.dScaleX)) {
        entries.push(bumpEntry(base, "scale_x", 1, drag.tInLayerUs, drag.dScaleX));
      }
      if (moved(drag.dScaleY)) {
        entries.push(bumpEntry(base, "scale_y", 1, drag.tInLayerUs, drag.dScaleY));
      }
    }
    // Scaling about the anchor moves `x`/`y`, because the composed position
    // carries a `pivot·|scale|` term — the exact mirror of the anchor gesture,
    // where the media kinds needed no fix and Text always did.
    entries.push(...positionFix(base, drag.tInLayerUs, drag.compDx, drag.compDy));
    commitEntries(l.id, entries, "scale");
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
      {/* Snap guides, FIRST in document order so they paint UNDER the box and
          the handles: a guide is information about the gesture, never a target,
          and it must not occlude something grabbable. One group per axis, since
          at most one guide can be live on each — so these are two fixed
          elements and not a list to reconcile. Each holds the dark under-stroke
          and the bright line over it; the draw loop writes one geometry into
          both children. */}
      <g
        ref={guideXRef}
        data-testid="transform-gizmo-guide-x"
        style={{ pointerEvents: "none", display: "none" }}
      >
        <line style={{ stroke: GUIDE_UNDER_COLOR, strokeWidth: GUIDE_UNDER_WIDTH_PX }} />
        <line style={{ stroke: GUIDE_COLOR, strokeWidth: GUIDE_WIDTH_PX }} />
      </g>
      <g
        ref={guideYRef}
        data-testid="transform-gizmo-guide-y"
        style={{ pointerEvents: "none", display: "none" }}
      >
        <line style={{ stroke: GUIDE_UNDER_COLOR, strokeWidth: GUIDE_UNDER_WIDTH_PX }} />
        <line style={{ stroke: GUIDE_COLOR, strokeWidth: GUIDE_WIDTH_PX }} />
      </g>
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
      {/* Resize handles, after the box so they win the hit test against the
          footprint they sit on, and corners last within the set (see
          SCALE_HANDLE_IDS) so a shrunken box's corners beat its edge handles.
          Each is a group carrying the translate — ONE attribute write per frame,
          with no rotation to keep in sync because the dot is round — and the
          invisible second disc widens the grab area without changing what is
          drawn. */}
      {SCALE_HANDLE_IDS.map((id) => (
        <g
          key={id}
          data-testid={`transform-gizmo-scale-${id}`}
          ref={(el) => {
            if (el) handleEls.current.set(id, el);
            else handleEls.current.delete(id);
          }}
          onPointerDown={(e) => beginScale(e, id)}
          onPointerMove={moveScale}
          onPointerUp={endScale}
          onPointerCancel={endScale}
          style={{
            pointerEvents: "all",
            // Replaced per frame with the handle's true screen direction, so a
            // rotated layer's cursors turn with it.
            cursor: "nwse-resize",
            display: "none",
          }}
        >
          <circle
            cx={0}
            cy={0}
            r={HANDLE_R_PX}
            style={{ fill: "var(--background)", stroke: "var(--ring)", strokeWidth: 1.5 }}
          />
          <circle
            cx={0}
            cy={0}
            r={HANDLE_HIT_R_PX}
            style={{ fill: "rgba(0, 0, 0, 0)" }}
          />
        </g>
      ))}
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
      {/* The rotation knob: a disc carrying a rotate glyph, so the handle says
          what it does rather than reading as one more resize dot. A group for
          the same reason the reticle and the resize handles are groups — every
          child is drawn about (0,0) and the draw loop writes ONE translate. */}
      <g
        ref={knobRef}
        data-testid="transform-gizmo-rotate"
        onPointerDown={beginRotate}
        onPointerMove={moveRotate}
        onPointerUp={endRotate}
        onPointerCancel={endRotate}
        style={{
          pointerEvents: "all",
          cursor: "grab",
          display: "none",
        }}
      >
        <circle
          cx={0}
          cy={0}
          r={ROTATE_KNOB_R}
          style={{ fill: "var(--background)", stroke: "var(--ring)", strokeWidth: 1.5 }}
        />
        {/* A nested <svg>: lucide's own art, positioned and scaled by its
            viewport rather than re-drawn here, so it can't drift from the
            rotate-ccw used everywhere else in the app. */}
        <RotateCcwIcon
          x={-ROTATE_GLYPH_PX / 2}
          y={-ROTATE_GLYPH_PX / 2}
          size={ROTATE_GLYPH_PX}
          strokeWidth={ROTATE_GLYPH_STROKE_PX}
          absoluteStrokeWidth
          color="var(--ring)"
          style={{ pointerEvents: "none" }}
        />
        {/* Invisible but hit-testable, same trick as the box's fill: widens the
            grab target past the drawn disc without drawing anything. */}
        <circle cx={0} cy={0} r={ROTATE_HIT_R} style={{ fill: "rgba(0, 0, 0, 0)" }} />
      </g>
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
