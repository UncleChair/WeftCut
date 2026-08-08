// Keyframe easing vocabulary, single-sourced for BOTH processes: the
// `Interpolation` wire type and the canonical named-preset table with its
// exact-equality reverse lookup. Lives in src/shared/ because main (state
// model, MCP preset baking) and the renderer (preset picker, curve editor)
// both author it — same pattern as DecodeRoute / RecentEntry / AppSettings.
// Spec: .scratch/keyframe-easing/spec.md.

/// Easing direction for the procedural families (`Elastic` / `Bounce`).
/// Serializes as the bare variant name, mirroring the Rust `EaseDir`.
export type EaseDir = "In" | "Out" | "InOut";

/// Wire-compatible mirror of the Rust `Interpolation` enum (serde tag "kind").
/// TWIN: keep in lockstep with `native/eval/src/lib.rs::Interpolation` and the
/// napi wire contract in `native/src/state/animated.rs`. Named ease presets are
/// a display-layer concept — they bake to `Bezier` params at authoring time
/// (see `EASING_PRESETS`), so the schema carries no named variants.
export type Interpolation =
  | { kind: "Hold" }
  | { kind: "Linear" }
  | { kind: "Bezier"; p1: [number, number]; p2: [number, number] }
  /// `amplitude` ≥ 1 (engine clamps defensively), `period` > 0 (authoring
  /// enforces; the engine divides by it as given).
  | { kind: "Elastic"; dir: EaseDir; amplitude: number; period: number }
  | { kind: "Bounce"; dir: EaseDir };

/// Elastic authoring defaults (spec §Decisions #4). The amplitude floor is 1
/// (the engine's phase needs `asin(1/a)` to exist and clamps below it).
export const ELASTIC_DEFAULT_AMPLITUDE = 1.0;
export const ELASTIC_DEFAULT_PERIOD = 0.3;

/// Penner's back-overshoot constant.
const BACK_S = 1.70158;
/// Bernstein y-control magnitude for the exact back cubics: S/3, computed as an
/// f64 EXPRESSION (never hand-rounded) so a fixture computing the same
/// expression in either language lands on the identical bit pattern.
const BACK_Y = BACK_S / 3;

/// Table-entry constructor: narrows `id` to its literal so `EasingPresetId`
/// can be derived from the table itself.
function preset<Id extends string>(
  id: Id,
  labelKey: string,
  interp: Interpolation,
): { id: Id; labelKey: string; interp: Interpolation } {
  return { id, labelKey, interp };
}

/// The canonical preset table — the ONE source of truth for named easing.
/// Renderer surfaces read it for pickers/labels; main bakes MCP preset ids
/// through it and recovers display names via `presetIdForInterp`.
///
/// IRON RULE — APPEND-ONLY. Never retune an existing entry's params: baked
/// params live in saved projects and reverse lookup is exact f64 equality, so
/// a retune silently re-labels (or un-labels) every project that used the
/// preset. A re-tuned feel is a NEW id.
///
/// Exact entries represent the Penner polynomial in the cubic Bernstein basis
/// with x(s) = s (x controls at 1/3, 2/3); fractions stay ARITHMETIC
/// EXPRESSIONS (`1 / 3`, not 0.333…) for cross-language bit-identity.
/// Approximated entries carry easings.net's industry-standard cubic-bezier
/// params (spec §Decisions #3 accepts the approximation).
export const EASING_PRESETS = [
  preset("linear", "keyframe.interp_linear", { kind: "Linear" }),
  preset("hold", "keyframe.interp_hold", { kind: "Hold" }),
  // CSS named curves (the pre-table presets, params unchanged).
  preset("ease", "keyframe.interp_ease", { kind: "Bezier", p1: [0.25, 0.1], p2: [0.25, 1] }),
  preset("ease_in", "keyframe.interp_ease_in", { kind: "Bezier", p1: [0.42, 0], p2: [1, 1] }),
  preset("ease_out", "keyframe.interp_ease_out", { kind: "Bezier", p1: [0, 0], p2: [0.58, 1] }),
  preset("ease_in_out", "keyframe.interp_ease_in_out", { kind: "Bezier", p1: [0.42, 0], p2: [0.58, 1] }),
  // sine — easings.net approximations.
  preset("ease_in_sine", "keyframe.interp_ease_in_sine", { kind: "Bezier", p1: [0.12, 0], p2: [0.39, 0] }),
  preset("ease_out_sine", "keyframe.interp_ease_out_sine", { kind: "Bezier", p1: [0.61, 1], p2: [0.88, 1] }),
  preset("ease_in_out_sine", "keyframe.interp_ease_in_out_sine", { kind: "Bezier", p1: [0.37, 0], p2: [0.63, 1] }),
  // quad — in/out are EXACT t² / mirror; in-out is piecewise → easings.net approx.
  preset("ease_in_quad", "keyframe.interp_ease_in_quad", { kind: "Bezier", p1: [1 / 3, 0], p2: [2 / 3, 1 / 3] }),
  preset("ease_out_quad", "keyframe.interp_ease_out_quad", { kind: "Bezier", p1: [1 / 3, 2 / 3], p2: [2 / 3, 1] }),
  preset("ease_in_out_quad", "keyframe.interp_ease_in_out_quad", { kind: "Bezier", p1: [0.45, 0], p2: [0.55, 1] }),
  // cubic — in/out are EXACT t³ / mirror; in-out easings.net.
  preset("ease_in_cubic", "keyframe.interp_ease_in_cubic", { kind: "Bezier", p1: [1 / 3, 0], p2: [2 / 3, 0] }),
  preset("ease_out_cubic", "keyframe.interp_ease_out_cubic", { kind: "Bezier", p1: [1 / 3, 1], p2: [2 / 3, 1] }),
  preset("ease_in_out_cubic", "keyframe.interp_ease_in_out_cubic", { kind: "Bezier", p1: [0.65, 0], p2: [0.35, 1] }),
  // quart — easings.net.
  preset("ease_in_quart", "keyframe.interp_ease_in_quart", { kind: "Bezier", p1: [0.5, 0], p2: [0.75, 0] }),
  preset("ease_out_quart", "keyframe.interp_ease_out_quart", { kind: "Bezier", p1: [0.25, 1], p2: [0.5, 1] }),
  preset("ease_in_out_quart", "keyframe.interp_ease_in_out_quart", { kind: "Bezier", p1: [0.76, 0], p2: [0.24, 1] }),
  // quint — easings.net.
  preset("ease_in_quint", "keyframe.interp_ease_in_quint", { kind: "Bezier", p1: [0.64, 0], p2: [0.78, 0] }),
  preset("ease_out_quint", "keyframe.interp_ease_out_quint", { kind: "Bezier", p1: [0.22, 1], p2: [0.36, 1] }),
  preset("ease_in_out_quint", "keyframe.interp_ease_in_out_quint", { kind: "Bezier", p1: [0.83, 0], p2: [0.17, 1] }),
  // expo — easings.net.
  preset("ease_in_expo", "keyframe.interp_ease_in_expo", { kind: "Bezier", p1: [0.7, 0], p2: [0.84, 0] }),
  preset("ease_out_expo", "keyframe.interp_ease_out_expo", { kind: "Bezier", p1: [0.16, 1], p2: [0.3, 1] }),
  preset("ease_in_out_expo", "keyframe.interp_ease_in_out_expo", { kind: "Bezier", p1: [0.87, 0], p2: [0.13, 1] }),
  // circ — easings.net.
  preset("ease_in_circ", "keyframe.interp_ease_in_circ", { kind: "Bezier", p1: [0.55, 0], p2: [1, 0.45] }),
  preset("ease_out_circ", "keyframe.interp_ease_out_circ", { kind: "Bezier", p1: [0, 0.55], p2: [0.45, 1] }),
  preset("ease_in_out_circ", "keyframe.interp_ease_in_out_circ", { kind: "Bezier", p1: [0.85, 0], p2: [0.15, 1] }),
  // back — in/out are EXACT (s+1)t³−st² / mirror (BACK_Y = S/3); in-out easings.net.
  preset("ease_in_back", "keyframe.interp_ease_in_back", { kind: "Bezier", p1: [1 / 3, 0], p2: [2 / 3, -BACK_Y] }),
  preset("ease_out_back", "keyframe.interp_ease_out_back", { kind: "Bezier", p1: [1 / 3, 1 + BACK_Y], p2: [2 / 3, 1] }),
  preset("ease_in_out_back", "keyframe.interp_ease_in_out_back", { kind: "Bezier", p1: [0.68, -0.6], p2: [0.32, 1.6] }),
  // elastic / bounce — closed-form engine math, not baked beziers.
  preset("ease_in_elastic", "keyframe.interp_ease_in_elastic", { kind: "Elastic", dir: "In", amplitude: ELASTIC_DEFAULT_AMPLITUDE, period: ELASTIC_DEFAULT_PERIOD }),
  preset("ease_out_elastic", "keyframe.interp_ease_out_elastic", { kind: "Elastic", dir: "Out", amplitude: ELASTIC_DEFAULT_AMPLITUDE, period: ELASTIC_DEFAULT_PERIOD }),
  preset("ease_in_out_elastic", "keyframe.interp_ease_in_out_elastic", { kind: "Elastic", dir: "InOut", amplitude: ELASTIC_DEFAULT_AMPLITUDE, period: ELASTIC_DEFAULT_PERIOD }),
  preset("ease_in_bounce", "keyframe.interp_ease_in_bounce", { kind: "Bounce", dir: "In" }),
  preset("ease_out_bounce", "keyframe.interp_ease_out_bounce", { kind: "Bounce", dir: "Out" }),
  preset("ease_in_out_bounce", "keyframe.interp_ease_in_out_bounce", { kind: "Bounce", dir: "InOut" }),
];

export type EasingPreset = (typeof EASING_PRESETS)[number];
export type EasingPresetId = EasingPreset["id"];

/// Exact structural equality on every param. EXACT `===` on purpose:
/// serde_json and JSON.stringify both round-trip f64 exactly and the app is
/// the only writer of these values, so a tolerance could only invent false
/// identities (the historical `ease`/`ease_in_out` mislabel).
export function interpEqExact(a: Interpolation, b: Interpolation): boolean {
  switch (a.kind) {
    case "Hold":
    case "Linear":
      return a.kind === b.kind;
    case "Bezier":
      return (
        b.kind === "Bezier" &&
        a.p1[0] === b.p1[0] && a.p1[1] === b.p1[1] &&
        a.p2[0] === b.p2[0] && a.p2[1] === b.p2[1]
      );
    case "Elastic":
      return (
        b.kind === "Elastic" &&
        a.dir === b.dir && a.amplitude === b.amplitude && a.period === b.period
      );
    case "Bounce":
      return b.kind === "Bounce" && a.dir === b.dir;
  }
}

/// Reverse lookup: baked params → preset id, or undefined for a hand-tuned
/// curve. The preset NAME is a display-layer concept recovered here — the
/// store persists only params, and a name dies on the first handle-drag.
export function presetIdForInterp(interp: Interpolation): EasingPresetId | undefined {
  for (const p of EASING_PRESETS) if (interpEqExact(p.interp, interp)) return p.id;
  return undefined;
}

/// Structural deep copy (Bezier handle arrays re-created, never aliased).
/// Shared by the fan-out twin writers on both sides of the process boundary
/// (renderer keyframe/fanOut.ts, main mutations/scaleLink.ts).
export function cloneInterp(i: Interpolation): Interpolation {
  switch (i.kind) {
    case "Hold":
    case "Linear":
      return { kind: i.kind };
    case "Bezier":
      return { kind: "Bezier", p1: [i.p1[0], i.p1[1]], p2: [i.p2[0], i.p2[1]] };
    case "Elastic":
      return { kind: "Elastic", dir: i.dir, amplitude: i.amplitude, period: i.period };
    case "Bounce":
      return { kind: "Bounce", dir: i.dir };
  }
}
