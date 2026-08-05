// Where a preview gesture's result gets pulled onto an alignment line. Pure —
// no renderer, no DOM, no store reads — for the same reason `gizmoGeometry.ts`
// is: the whole decision table below is unit-testable without a pointer, and the
// overlay and the committed value cannot disagree because both come from here.
//
// Everything in this module speaks COMPOSITION pixels. The threshold arrives
// already converted (`thresholdComp`), because the setting is a SCREEN-pixel
// radius — see `snapThresholdComp`.
//
// Two callers, two shapes, one reason they differ:
//   move / free resize → the landing point is reachable on both axes
//   uniform resize     → one degree of freedom, so at most one axis can be hit
// Spec: .scratch/preview-gizmo/spec.md (Phase 6, D20–D26)

import type { Pt } from "./gizmoGeometry";

/// A candidate alignment line, and where it came from. The source is carried
/// rather than inferred from array position because it decides ties, and a
/// tie-break that depends on construction order is exactly what
/// `timeline/snapping.ts` gets away with only because its boundary set has a
/// stable track order (D21).
export type SnapSource = "composition" | "layer";

export interface SnapTarget {
  /// The line's position on its axis, composition pixels.
  at: number;
  source: SnapSource;
}

/// Composition wins ties, so it ranks first.
function sourceRank(s: SnapSource): number {
  return s === "composition" ? 0 : 1;
}

export interface SnapTargets {
  /// Vertical lines — candidate `x` values.
  xs: readonly SnapTarget[];
  /// Horizontal lines — candidate `y` values.
  ys: readonly SnapTarget[];
}

/// An axis-aligned box in composition pixels. What a rotated layer contributes
/// to (and snaps by) — the range it occupies on screen, which is what a person
/// aligning things means, rather than its true corners (D21).
export interface Aabb {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/// The bounding box of a mapped quad. Null on a malformed quad, matching the
/// `rotateHandle` / `scaleHandlePoints` convention.
export function quadAabb(quad: readonly Pt[]): Aabb | null {
  const [a, b, c, d] = quad;
  if (!a || !b || !c || !d) return null;
  return {
    left: Math.min(a.x, b.x, c.x, d.x),
    top: Math.min(a.y, b.y, c.y, d.y),
    right: Math.max(a.x, b.x, c.x, d.x),
    bottom: Math.max(a.y, b.y, c.y, d.y),
  };
}

/// The three candidates a box offers on one axis: its two edges and its midpoint.
function axisCandidates(low: number, high: number): [number, number, number] {
  return [low, (low + high) / 2, high];
}

/// The composition's own lines plus every other staged layer's box. `others`
/// arrives already resolved and mapped — building it needs the animated tracks
/// and so belongs to the caller, which is what keeps this module pure.
///
/// The composition contributes its four edges and two centre lines. A `Color`
/// layer must NOT appear in `others`: it fills the composition, so its edges are
/// already here, and a duplicate line would only make the tie-break do work that
/// changes nothing (D21).
export function snapTargets(
  compW: number,
  compH: number,
  others: readonly Aabb[],
): SnapTargets {
  const xs: SnapTarget[] = [
    { at: 0, source: "composition" },
    { at: compW / 2, source: "composition" },
    { at: compW, source: "composition" },
  ];
  const ys: SnapTarget[] = [
    { at: 0, source: "composition" },
    { at: compH / 2, source: "composition" },
    { at: compH, source: "composition" },
  ];
  for (const box of others) {
    for (const at of axisCandidates(box.left, box.right)) xs.push({ at, source: "layer" });
    for (const at of axisCandidates(box.top, box.bottom)) ys.push({ at, source: "layer" });
  }
  return { xs, ys };
}

/// The setting's SCREEN-pixel radius in composition pixels. Zero (or worse)
/// disables snapping entirely, which is how the caller expresses both "the
/// preference is off" and "Ctrl is held" without a second flag — the same
/// `threshold <= 0` short-circuit `timeline/snapping.ts` uses.
export function snapThresholdComp(strengthPx: number, fitScale: number): number {
  if (!(fitScale > 0) || !Number.isFinite(fitScale)) return 0;
  return Math.max(0, strengthPx) / fitScale;
}

/// One axis' outcome: how far to move, and the line to draw for it.
interface AxisHit {
  /// Added to the raw value to land on the line.
  delta: number;
  /// The line's position — where a guide is drawn.
  at: number;
}

/// The smallest move that puts one of `candidates` onto one of `targets`.
///
/// Ranked by (distance, source), lexicographically: a layer line must be
/// STRICTLY nearer than a composition line to win, which is the whole of D21's
/// tie-break rule. `>=` on the distance alone would hand ties to whichever
/// target the loop reached first.
function snapAxis(
  candidates: readonly number[],
  targets: readonly SnapTarget[],
  thresholdComp: number,
): AxisHit | null {
  if (!(thresholdComp > 0)) return null;
  let best: AxisHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const rank = sourceRank(target.source);
    for (const candidate of candidates) {
      const distance = Math.abs(target.at - candidate);
      if (distance > thresholdComp) continue;
      if (distance > bestDistance) continue;
      if (distance === bestDistance && rank >= bestRank) continue;
      bestDistance = distance;
      bestRank = rank;
      best = { delta: target.at - candidate, at: target.at };
    }
  }
  return best;
}

/// Where a guide should be drawn on each axis, composition pixels. Null means
/// that axis did not snap — at most one line per axis exists by construction,
/// which is why the overlay needs two fixed elements and not a list (D25).
export interface SnapGuides {
  x: number | null;
  y: number | null;
}

const NO_GUIDES: SnapGuides = { x: null, y: null };

export interface MoveSnapResult {
  /// Correction to ADD to the raw drag delta.
  dx: number;
  dy: number;
  guides: SnapGuides;
}

/// The correction that pulls a move drag onto the nearest lines.
///
/// LANDMINE: `box` must be the layer's AABB at the RAW, un-snapped position. The
/// box depends on the override, the override depends on this result, and this
/// result depends on the box — reading the box after the write is the only
/// ordering of those three that fails to terminate (D20).
///
/// The axes are solved independently, so a drag can land flush against the left
/// edge and vertically centred at once. A single global best — right for
/// `timeline/snapping.ts`, where time is one-dimensional — would make that
/// unreachable.
export function snapMove(
  box: Aabb,
  targets: SnapTargets,
  thresholdComp: number,
): MoveSnapResult {
  const x = snapAxis(axisCandidates(box.left, box.right), targets.xs, thresholdComp);
  const y = snapAxis(axisCandidates(box.top, box.bottom), targets.ys, thresholdComp);
  return {
    dx: x?.delta ?? 0,
    dy: y?.delta ?? 0,
    guides: { x: x?.at ?? null, y: y?.at ?? null },
  };
}

/// Which axes a resize handle actually drives — `HANDLE_DIR`'s `hx`/`hy` with
/// the zero meaning preserved. Part of the handle's identity, never inferred
/// from an offset that happens to be zero (D18).
export interface DrivenAxes {
  x: boolean;
  y: boolean;
}

export interface ScaleSnapResult {
  /// The snapped point to hand to `solveScale`.
  target: Pt;
  guides: SnapGuides;
}

/// Snap a free (non-uniform) resize by moving its TARGET POINT onto the lines.
///
/// Exact at any rotation, flip or aspect, and that is worth knowing because
/// rotation makes it look like it should need a correction: `solveScale` produces
/// `S₁·u = R⁻¹·(target − P)`, so the handle's composed landing point is
/// `P + R·(S₁·u) = target` identically. Snap the point and the handle lands on
/// the line — no second pass (D22).
///
/// Masked by `drives`, and that mask is load-bearing for CORRECTNESS here rather
/// than for cursors: `solveScale` returns the frame's own scale unchanged on an
/// axis the handle does not drive, so a horizontal target offered to an `r`
/// handle would be solved, drawn as a guide, and then silently discarded.
export function snapScaleTarget(
  target: Pt,
  drives: DrivenAxes,
  targets: SnapTargets,
  thresholdComp: number,
): ScaleSnapResult {
  const x = drives.x ? snapAxis([target.x], targets.xs, thresholdComp) : null;
  const y = drives.y ? snapAxis([target.y], targets.ys, thresholdComp) : null;
  return {
    target: { x: target.x + (x?.delta ?? 0), y: target.y + (y?.delta ?? 0) },
    guides: { x: x?.at ?? null, y: y?.at ?? null },
  };
}

export interface UniformScaleSnapResult {
  /// The snapped uniform factor. Equal to `rawT` when nothing was hit.
  t: number;
  guides: SnapGuides;
}

/// Snap a UNIFORM resize (a `scale_linked` layer, or Shift) by intersecting the
/// handle's ray with a target line.
///
/// Under uniform scaling `S₁ = t·S₀`, so the handle travels `P + t·ray` with
/// `ray = R·S₀·u` fixed at pointerdown — one degree of freedom. A snapped target
/// point is therefore generally unreachable, and least squares would spread the
/// miss across both axes and leave the handle beside the guide it is drawing. So
/// this solves `t` directly, which is exact and one division per line:
///
///   vertical   x = X  ⇒  t = (X − P.x) / ray.x
///
/// At most ONE axis can be hit, since one parameter cannot satisfy two equations
/// (D23). That is not a weaker guarantee than `snapScaleTarget` — it is what one
/// degree of freedom exactly permits, and it is why a linked layer's guide never
/// lies.
///
/// LANDMINE — the distance metric is the resulting DISPLACEMENT `|Δt|·|ray|`,
/// not the perpendicular distance to the line. Using the perpendicular distance
/// explodes as the ray approaches parallel with the line: a layer whose ray is
/// `(0.01, 100)` sitting 5 px from a vertical line needs `Δt = 500`, i.e. a
/// 500× scale-up, from a gesture that asked for a nudge. Measuring the
/// displacement makes a near-parallel ray fail the threshold on its own, needs
/// no epsilon, and makes a zero component harmless — `t` comes out `±Infinity`
/// or `NaN`, and the finiteness check drops it. It also unifies the two
/// branches: for a free resize the along-axis displacement IS the perpendicular
/// distance, so both ask "how far would snapping move the handle?".
export function snapUniformScale(
  pivot: Pt,
  ray: Pt,
  rawT: number,
  drives: DrivenAxes,
  targets: SnapTargets,
  thresholdComp: number,
): UniformScaleSnapResult {
  if (!(thresholdComp > 0)) return { t: rawT, guides: NO_GUIDES };
  const rayLen = Math.hypot(ray.x, ray.y);
  if (!(rayLen > 0) || !Number.isFinite(rayLen)) return { t: rawT, guides: NO_GUIDES };

  let bestT: number | null = null;
  let bestShift = Number.POSITIVE_INFINITY;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestGuides: SnapGuides = NO_GUIDES;

  const consider = (
    lines: readonly SnapTarget[],
    origin: number,
    component: number,
    axis: "x" | "y",
  ): void => {
    for (const line of lines) {
      const t = (line.at - origin) / component;
      if (!Number.isFinite(t)) continue;
      const shift = Math.abs(t - rawT) * rayLen;
      if (shift > thresholdComp) continue;
      const rank = sourceRank(line.source);
      if (shift > bestShift) continue;
      if (shift === bestShift && rank >= bestRank) continue;
      bestShift = shift;
      bestRank = rank;
      bestT = t;
      bestGuides = axis === "x" ? { x: line.at, y: null } : { x: null, y: line.at };
    }
  };

  if (drives.x) consider(targets.xs, pivot.x, ray.x, "x");
  if (drives.y) consider(targets.ys, pivot.y, ray.y, "y");

  return bestT === null ? { t: rawT, guides: NO_GUIDES } : { t: bestT, guides: bestGuides };
}
