//! `Animated<T>` — either a static value or a sorted keyframe vector.
//!
//! Keyframe times are RELATIVE to the layer's `t_start_us`. Otherwise moving a
//! layer breaks its animation.

// `Animated::static` is part of the keyframe-mutation API; not every caller
// is wired up yet, so the dead-code lint is silenced module-wide.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::color::Rgba;
use super::ids::KeyframeId;
use super::time::TimeUs;

// `Interpolation`, `unit_bezier`, and the slice-form keyframe evaluator now live
// in the `weftcut-eval` leaf crate (one source of truth shared with the renderer
// via wasm). `Animated<f64>::value_at` below delegates to `eval_f64` through a
// POD `Kf` slice; `Animated<T>` itself (imbl-backed) stays here.
pub use weftcut_eval::{unit_bezier, Interpolation};

/// `T: Clone` is required because `imbl::Vector` uses structural sharing — the
/// inner `Keyframe<T>` must be cloneable. Bounding the type is cleaner than
/// repeating the bound at every use site.
///
/// **No `JsonSchema` derive**: `imbl::Vector` doesn't ship a `JsonSchema`
/// impl, and `Uuid` requires schemars' `uuid1` feature. MCP tools that
/// need to accept an `Animated<T>` from agents declare the field as
/// `serde_json::Value` and deserialize inside the handler; the wire
/// shape is the same.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "mode", content = "value")]
pub enum Animated<T: Clone> {
    Static(T),
    Keyframed(imbl::Vector<Keyframe<T>>),
}

impl<T: Clone> Animated<T> {
    pub fn r#static(v: T) -> Self {
        Self::Static(v)
    }

    /// True iff the value actually changes over time — `Keyframed` with
    /// at least two keyframes. `Static`, empty `Keyframed`, and
    /// single-keyframe `Keyframed` all read as not animated. Audio
    /// envelope sampling (`audio::envelope`) branches on it: a
    /// non-animated gain/pan track collapses to a constant envelope
    /// instead of a per-step sampled one.
    ///
    /// Doesn't compare values — `[t=0: v=5, t=10: v=5]` reports
    /// animated even though it's effectively static. A false positive
    /// only costs the caller the general path; tightening to "any two
    /// adjacent keyframes have distinct values" is a follow-up if it
    /// matters.
    pub fn is_animated(&self) -> bool {
        match self {
            Animated::Static(_) => false,
            Animated::Keyframed(kfs) => kfs.len() > 1,
        }
    }

    /// Shift every keyframe's `t_us` by `delta_us` (no-op on `Static`).
    pub fn shift_keyframes(&mut self, delta_us: TimeUs) {
        if let Animated::Keyframed(kfs) = self {
            *kfs = kfs
                .iter()
                .map(|k| Keyframe {
                    id: k.id,
                    t_us: k.t_us + delta_us,
                    value: k.value.clone(),
                    interp: k.interp,
                })
                .collect();
        }
    }

    /// Value of the first keyframe (front of the sorted vector), or `None` for
    /// `Static` / empty `Keyframed`. Split uses this to collapse an empty LEFT
    /// half to the value the track clamps to before its first key.
    pub fn first_keyframe_value(&self) -> Option<T> {
        match self {
            Animated::Keyframed(kfs) => kfs.front().map(|k| k.value.clone()),
            Animated::Static(_) => None,
        }
    }

    /// Value of the last keyframe (back of the sorted vector), or `None` for
    /// `Static` / empty `Keyframed`. Split uses this to collapse an empty RIGHT
    /// half to the value the track clamps to after its last key.
    pub fn last_keyframe_value(&self) -> Option<T> {
        match self {
            Animated::Keyframed(kfs) => kfs.back().map(|k| k.value.clone()),
            Animated::Static(_) => None,
        }
    }

    /// Keep only keyframes whose `t_us` satisfies `keep` (no-op on `Static`).
    /// If `keep` filters out every keyframe, the result is an EMPTY `Keyframed`
    /// track — the caller is responsible for collapsing that to `Static`,
    /// since an empty `Keyframed` is rejected by `normalize_keyframes` and
    /// reads as the fallback in `value_at`.
    pub fn retain_keyframes(&mut self, keep: impl Fn(TimeUs) -> bool) {
        if let Animated::Keyframed(kfs) = self {
            *kfs = kfs.iter().filter(|k| keep(k.t_us)).cloned().collect();
        }
    }

    /// Canonicalize a `Keyframed` track for storage: snap each `t_us` via
    /// `snap`, stable-sort by `t_us`, and dedupe same-snapped-time keys. The
    /// stable sort preserves input order among equal keys, so the dedupe keeps
    /// whichever key appears LAST in the input vector — the caller must supply
    /// keys with the most-recent write last (the write path appends the edited
    /// key, so a duplicate snapped time resolves last-write-wins). Returns
    /// `Err(())` for an empty `Keyframed` track (a keyframed property must hold
    /// at least one key — the caller turns this into a `CommandError`).
    /// `Static` is unchanged and always `Ok`.
    pub fn normalize_keyframes(&mut self, snap: impl Fn(TimeUs) -> TimeUs) -> Result<(), ()> {
        if let Animated::Keyframed(kfs) = self {
            if kfs.is_empty() {
                return Err(());
            }
            let mut v: Vec<Keyframe<T>> = kfs
                .iter()
                .map(|k| Keyframe {
                    id: k.id,
                    t_us: snap(k.t_us),
                    value: k.value.clone(),
                    interp: k.interp,
                })
                .collect();
            v.sort_by_key(|k| k.t_us); // stable
            let mut out: Vec<Keyframe<T>> = Vec::with_capacity(v.len());
            for k in v {
                match out.last_mut() {
                    Some(last) if last.t_us == k.t_us => *last = k,
                    _ => out.push(k),
                }
            }
            *kfs = out.into_iter().collect();
        }
        Ok(())
    }
}

impl<T: Clone + PartialEq> Animated<T> {
    /// Owner-local intervals where this track is *actually animating*
    /// — adjacent keyframe pairs with continuous-interp on the LEFT
    /// keyframe AND distinct values.
    ///
    /// Interp-direction convention (verified against `render/animated.ts`
    /// `resolveAnimated`): the segment `[kf[i].t_us, kf[i+1].t_us)` is
    /// governed by `kf[i].interp`. Hold on the left → no motion in the
    /// segment (value is constant `kf[i].value`); continuous interp
    /// (Linear / EaseIn / EaseOut / Bezier) on the left WITH
    /// `kf[i].value != kf[i+1].value` → motion across the segment.
    ///
    /// Static tracks and zero/one keyframe tracks return empty.
    ///
    /// NOTE: out-of-range keyframes are valid stored state (trim/split keep
    /// keys outside `[0, duration]`), so returned intervals may fall outside
    /// the layer span. No live consumer; re-audit against out-of-range keys
    /// before wiring one up.
    ///
    /// See `docs/data-model.md` § Animated values.
    pub fn animating_runs(&self) -> Vec<(TimeUs, TimeUs)> {
        let Animated::Keyframed(kfs) = self else {
            return Vec::new();
        };
        if kfs.len() < 2 {
            return Vec::new();
        }
        let mut runs = Vec::new();
        for i in 0..kfs.len() - 1 {
            let a = &kfs[i];
            let b = &kfs[i + 1];
            if a.value == b.value {
                continue;
            }
            if matches!(a.interp, Interpolation::Hold) {
                continue;
            }
            if b.t_us <= a.t_us {
                continue;
            }
            runs.push((a.t_us, b.t_us));
        }
        runs
    }

    /// Owner-local timestamps where a Hold-step occurs — the value
    /// changes from one constant level to another at exactly
    /// `kf[i+1].t_us` because `kf[i].interp == Hold` AND
    /// `kf[i].value != kf[i+1].value`.
    ///
    /// NOTE: like `animating_runs`, may now return times outside `[0, duration]`
    /// (out-of-range keyframes are valid). No consumer today; re-audit if revived.
    ///
    /// See `docs/data-model.md` §4.
    pub fn hold_step_times(&self) -> Vec<TimeUs> {
        let Animated::Keyframed(kfs) = self else {
            return Vec::new();
        };
        if kfs.len() < 2 {
            return Vec::new();
        }
        let mut steps = Vec::new();
        for i in 0..kfs.len() - 1 {
            let a = &kfs[i];
            let b = &kfs[i + 1];
            if matches!(a.interp, Interpolation::Hold) && a.value != b.value {
                steps.push(b.t_us);
            }
        }
        steps
    }
}

impl Animated<f64> {
    /// Materialize the keyframes as POD `weftcut_eval::Kf` for slice evaluation
    /// (empty for `Static`). HOIST this out of per-sample loops (e.g. the audio
    /// envelope sampler) and call `weftcut_eval::eval_f64` on the slice directly,
    /// rather than paying the collection on every sample.
    pub fn eval_kfs(&self) -> Vec<weftcut_eval::Kf> {
        match self {
            Animated::Static(_) => Vec::new(),
            Animated::Keyframed(kfs) => kfs
                .iter()
                .map(|k| weftcut_eval::Kf {
                    t_us: k.t_us,
                    value: k.value,
                    interp: k.interp,
                })
                .collect(),
        }
    }

    /// Resolve the value at owner-local `t_us`. `Static(v)` → `v`; otherwise
    /// delegates to the shared `weftcut_eval::eval_f64` over a `Kf` slice, so
    /// preview, export, and the renderer interpolate identically. See the leaf
    /// for the empty/single/clamp/segment/interp semantics (mirrors
    /// `render/animated.ts::resolveAnimated`).
    pub fn value_at(&self, t_us: TimeUs, default: f64) -> f64 {
        match self {
            Animated::Static(v) => *v,
            Animated::Keyframed(_) => weftcut_eval::eval_f64(&self.eval_kfs(), t_us, default),
        }
    }
}

impl Animated<Rgba> {
    /// Materialize the keyframes as POD `weftcut_eval::Kf<Rgba8>` for slice
    /// evaluation (empty for `Static`). Parallels `Animated<f64>::eval_kfs`;
    /// each `Rgba` value crosses to the leaf via `Rgba::to_eval`.
    pub fn eval_kfs(&self) -> Vec<weftcut_eval::Kf<weftcut_eval::Rgba8>> {
        match self {
            Animated::Static(_) => Vec::new(),
            Animated::Keyframed(kfs) => kfs
                .iter()
                .map(|k| weftcut_eval::Kf {
                    t_us: k.t_us,
                    value: k.value.to_eval(),
                    interp: k.interp,
                })
                .collect(),
        }
    }

    /// Resolve the color at owner-local `t_us`. `Static(v)` → `v`; otherwise
    /// delegates to the shared generic `weftcut_eval::eval::<Rgba8>` over a
    /// `Kf<Rgba8>` slice, which interpolates in OkLab + premultiplied alpha (see
    /// `Rgba8::lerp`). Same empty/single/clamp/segment/interp semantics as
    /// `Animated<f64>::value_at`.
    pub fn value_at(&self, t_us: TimeUs, default: Rgba) -> Rgba {
        match self {
            Animated::Static(v) => *v,
            Animated::Keyframed(_) => {
                let out = weftcut_eval::eval::<weftcut_eval::Rgba8>(
                    &self.eval_kfs(),
                    t_us,
                    default.to_eval(),
                );
                Rgba::from_eval(out)
            }
        }
    }
}

impl<T: Clone + Default> Default for Animated<T> {
    fn default() -> Self {
        Self::Static(T::default())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Keyframe<T: Clone> {
    pub id: KeyframeId,
    /// Time relative to the owning layer's `t_start_us`.
    pub t_us: TimeUs,
    pub value: T,
    pub interp: Interpolation,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ids::new_id;

    fn kf(t_us: TimeUs, value: f64, interp: Interpolation) -> Keyframe<f64> {
        Keyframe {
            id: new_id(),
            t_us,
            value,
            interp,
        }
    }

    fn keyframed(kfs: Vec<Keyframe<f64>>) -> Animated<f64> {
        Animated::Keyframed(kfs.into_iter().collect())
    }

    #[test]
    fn static_animating_runs_empty() {
        let a: Animated<f64> = Animated::Static(1.0);
        assert_eq!(a.animating_runs(), Vec::<(TimeUs, TimeUs)>::new());
    }

    #[test]
    fn single_kf_animating_runs_empty() {
        let a = keyframed(vec![kf(0, 1.0, Interpolation::Linear)]);
        assert_eq!(a.animating_runs(), Vec::<(TimeUs, TimeUs)>::new());
    }

    #[test]
    fn linear_distinct_pair_yields_one_run() {
        let a = keyframed(vec![
            kf(5_000_000, 0.0, Interpolation::Linear),
            kf(10_000_000, 8.0, Interpolation::Linear),
        ]);
        assert_eq!(a.animating_runs(), vec![(5_000_000, 10_000_000)]);
    }

    #[test]
    fn equal_value_pair_yields_no_run() {
        let a = keyframed(vec![
            kf(0, 5.0, Interpolation::Linear),
            kf(10_000_000, 5.0, Interpolation::Linear),
        ]);
        assert_eq!(a.animating_runs(), Vec::<(TimeUs, TimeUs)>::new());
    }

    #[test]
    fn hold_left_interp_yields_no_run() {
        let a = keyframed(vec![
            kf(0, 0.0, Interpolation::Hold),
            kf(5_000_000, 8.0, Interpolation::Hold),
        ]);
        assert_eq!(a.animating_runs(), Vec::<(TimeUs, TimeUs)>::new());
    }

    #[test]
    fn hold_step_times_captures_value_step() {
        let a = keyframed(vec![
            kf(0, 0.0, Interpolation::Hold),
            kf(5_000_000, 8.0, Interpolation::Hold),
            kf(10_000_000, 8.0, Interpolation::Hold),
        ]);
        // Step at t=5 (value changes 0→8); no step at t=10 (8→8 same).
        assert_eq!(a.hold_step_times(), vec![5_000_000]);
    }

    #[test]
    fn hold_step_times_skips_left_continuous_interp() {
        // Linear left interp doesn't step, it lerps. Even though the
        // values differ, no hold_step entry.
        let a = keyframed(vec![
            kf(0, 0.0, Interpolation::Linear),
            kf(5_000_000, 8.0, Interpolation::Linear),
        ]);
        assert_eq!(a.hold_step_times(), Vec::<TimeUs>::new());
    }

    #[test]
    fn mixed_track_animating_and_hold_step() {
        // [0:0 Linear, 5:8 Hold, 10:8 Hold, 10:0 Hold]
        // Linear pair (0→8 over [0,5)) = animating run [0,5)
        // Hold pair (5→10) values equal, no step.
        // Hold pair (10→10) — careful: duplicate timestamps. Skip this case.
        let a = keyframed(vec![
            kf(0, 0.0, Interpolation::Linear),
            kf(5_000_000, 8.0, Interpolation::Hold),
            kf(10_000_000, 8.0, Interpolation::Hold),
            kf(15_000_000, 0.0, Interpolation::Hold),
        ]);
        assert_eq!(a.animating_runs(), vec![(0, 5_000_000)]);
        // Hold-step at t=15 only (value steps 8→0).
        assert_eq!(a.hold_step_times(), vec![15_000_000]);
    }

    #[test]
    fn value_at_static() {
        let a: Animated<f64> = Animated::Static(7.5);
        assert!((a.value_at(0, 0.0) - 7.5).abs() < 1e-9);
        assert!((a.value_at(999_999, 0.0) - 7.5).abs() < 1e-9);
    }

    #[test]
    fn value_at_empty_keyframed_returns_default() {
        let a: Animated<f64> = Animated::Keyframed(imbl::Vector::new());
        assert!((a.value_at(0, 4.2) - 4.2).abs() < 1e-9);
    }

    // ---- Animated<Rgba>::value_at structural shape (exact OkLab values not pinned here) ----

    fn color_kf(t_us: TimeUs, value: Rgba, interp: Interpolation) -> Keyframe<Rgba> {
        Keyframe {
            id: new_id(),
            t_us,
            value,
            interp,
        }
    }

    #[test]
    fn color_value_at_static_returns_value() {
        let a: Animated<Rgba> = Animated::Static(Rgba::rgb(10, 20, 30));
        assert_eq!(a.value_at(0, Rgba::BLACK), Rgba::rgb(10, 20, 30));
        assert_eq!(a.value_at(999_999, Rgba::BLACK), Rgba::rgb(10, 20, 30));
    }

    #[test]
    fn color_value_at_empty_keyframed_returns_default() {
        let a: Animated<Rgba> = Animated::Keyframed(imbl::Vector::new());
        assert_eq!(a.value_at(0, Rgba::WHITE), Rgba::WHITE);
    }

    #[test]
    fn color_value_at_clamps_to_endpoints() {
        let red = Rgba::rgb(255, 0, 0);
        let green = Rgba::rgb(0, 255, 0);
        let a: Animated<Rgba> = Animated::Keyframed(
            vec![
                color_kf(5_000_000, red, Interpolation::Linear),
                color_kf(10_000_000, green, Interpolation::Linear),
            ]
            .into_iter()
            .collect(),
        );
        // Endpoint clamp must be exact (delegates to the same eval clamp).
        assert_eq!(a.value_at(0, Rgba::BLACK), red);
        assert_eq!(a.value_at(15_000_000, Rgba::BLACK), green);
        // Midpoint just has to land strictly between (perceptual blend); exact
        // values are not pinned here.
        let mid = a.value_at(7_500_000, Rgba::BLACK);
        assert!(mid.r > 0 && mid.r < 255, "r={} interpolated", mid.r);
        assert!(mid.g > 0 && mid.g < 255, "g={} interpolated", mid.g);
        assert_eq!(mid.a, 255);
    }

    #[test]
    fn value_at_single_keyframe() {
        let a = keyframed(vec![kf(0, 3.0, Interpolation::Linear)]);
        assert!((a.value_at(0, 0.0) - 3.0).abs() < 1e-9);
        assert!((a.value_at(100_000, 0.0) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn value_at_clamps_before_first_and_after_last() {
        let a = keyframed(vec![
            kf(5_000_000, 2.0, Interpolation::Linear),
            kf(10_000_000, 8.0, Interpolation::Linear),
        ]);
        // Before first
        assert!((a.value_at(0, 0.0) - 2.0).abs() < 1e-9);
        // After last
        assert!((a.value_at(15_000_000, 0.0) - 8.0).abs() < 1e-9);
    }

    #[test]
    fn value_at_linear_interpolates_midpoint() {
        let a = keyframed(vec![
            kf(0, 0.0, Interpolation::Linear),
            kf(10_000_000, 10.0, Interpolation::Linear),
        ]);
        assert!((a.value_at(5_000_000, 0.0) - 5.0).abs() < 1e-6);
        assert!((a.value_at(2_000_000, 0.0) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn value_at_hold_returns_left_value() {
        let a = keyframed(vec![
            kf(0, 3.0, Interpolation::Hold),
            kf(10_000_000, 8.0, Interpolation::Hold),
        ]);
        // Mid-segment: held at left value, NOT lerped.
        assert!((a.value_at(5_000_000, 0.0) - 3.0).abs() < 1e-9);
        // At the right endpoint: clamp-to-last says 8.0.
        assert!((a.value_at(10_000_000, 0.0) - 8.0).abs() < 1e-9);
    }

    #[test]
    fn value_at_ease_in_uses_cubic_bezier() {
        let a = keyframed(vec![
            kf(0, 0.0, Interpolation::EaseIn),
            kf(10_000_000, 10.0, Interpolation::EaseIn),
        ]);
        let expected = super::unit_bezier(0.42, 0.0, 1.0, 1.0, 0.5) * 10.0;
        assert!((a.value_at(5_000_000, 0.0) - expected).abs() < 1e-9);
    }

    #[test]
    fn value_at_ease_out_uses_cubic_bezier() {
        let a = keyframed(vec![
            kf(0, 0.0, Interpolation::EaseOut),
            kf(10_000_000, 10.0, Interpolation::EaseOut),
        ]);
        let expected = super::unit_bezier(0.0, 0.0, 0.58, 1.0, 0.5) * 10.0;
        assert!((a.value_at(5_000_000, 0.0) - expected).abs() < 1e-9);
    }

    #[test]
    fn shift_keyframes_offsets_all_times() {
        let mut a = keyframed(vec![
            kf(1_000_000, 0.0, Interpolation::Linear),
            kf(3_000_000, 1.0, Interpolation::Linear),
        ]);
        a.shift_keyframes(-1_000_000);
        let Animated::Keyframed(kfs) = &a else {
            panic!("keyframed")
        };
        assert_eq!(kfs[0].t_us, 0);
        assert_eq!(kfs[1].t_us, 2_000_000);
    }

    #[test]
    fn shift_keyframes_noop_on_static() {
        let mut a: Animated<f64> = Animated::Static(5.0);
        a.shift_keyframes(1_000_000);
        assert!(matches!(a, Animated::Static(_)));
    }

    #[test]
    fn retain_keyframes_filters_by_time() {
        let mut a = keyframed(vec![
            kf(0, 0.0, Interpolation::Linear),
            kf(2_000_000, 1.0, Interpolation::Linear),
            kf(5_000_000, 2.0, Interpolation::Linear),
        ]);
        a.retain_keyframes(|t| t <= 2_000_000);
        let Animated::Keyframed(kfs) = &a else {
            panic!("keyframed")
        };
        assert_eq!(kfs.len(), 2);
        assert_eq!(kfs[1].t_us, 2_000_000);
    }

    #[test]
    fn first_last_keyframe_value() {
        let a = keyframed(vec![
            kf(0, 3.0, Interpolation::Linear),
            kf(5_000_000, 7.0, Interpolation::Linear),
        ]);
        assert_eq!(a.first_keyframe_value(), Some(3.0));
        assert_eq!(a.last_keyframe_value(), Some(7.0));
    }

    #[test]
    fn first_last_keyframe_value_none_for_static_and_empty() {
        let s: Animated<f64> = Animated::Static(1.0);
        assert_eq!(s.first_keyframe_value(), None);
        assert_eq!(s.last_keyframe_value(), None);
        let e: Animated<f64> = Animated::Keyframed(imbl::Vector::new());
        assert_eq!(e.first_keyframe_value(), None);
        assert_eq!(e.last_keyframe_value(), None);
    }

    #[test]
    fn normalize_sorts_snaps_and_dedupes_last_wins() {
        // Snap = round to 1_000_000 grid. Two keys land on the same snapped
        // time (900_000 and 1_100_000 -> 1_000_000); last (by input order
        // after a stable sort) wins.
        let snap = |t: TimeUs| ((t + 500_000) / 1_000_000) * 1_000_000;
        let mut a = keyframed(vec![
            kf(3_000_000, 3.0, Interpolation::Linear),
            kf(900_000, 1.0, Interpolation::Linear),
            kf(1_100_000, 2.0, Interpolation::Linear),
        ]);
        a.normalize_keyframes(snap)
            .expect("non-empty keyframed normalizes");
        let Animated::Keyframed(kfs) = &a else {
            panic!("keyframed")
        };
        assert_eq!(kfs.len(), 2, "900k & 1100k collapse to one at 1_000_000");
        assert_eq!(kfs[0].t_us, 1_000_000);
        assert_eq!(kfs[0].value, 2.0, "last-write-wins among same-frame keys");
        assert_eq!(kfs[1].t_us, 3_000_000);
    }

    #[test]
    fn normalize_rejects_empty_keyframed() {
        let mut a: Animated<f64> = Animated::Keyframed(imbl::Vector::new());
        assert!(a.normalize_keyframes(|t| t).is_err());
    }

    #[test]
    fn normalize_noop_on_static() {
        let mut a: Animated<f64> = Animated::Static(2.0);
        assert!(a.normalize_keyframes(|t| t).is_ok());
    }

    #[test]
    fn unit_bezier_identity_when_coords_equal() {
        // cubic-bezier(0,0,1,1): x and y control coords equal → y(x) = x.
        for &x in &[0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0] {
            assert!((super::unit_bezier(0.0, 0.0, 1.0, 1.0, x) - x).abs() < 1e-6);
        }
    }

    #[test]
    fn unit_bezier_endpoints() {
        assert!((super::unit_bezier(0.42, 0.0, 0.58, 1.0, 0.0) - 0.0).abs() < 1e-9);
        assert!((super::unit_bezier(0.42, 0.0, 0.58, 1.0, 1.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn unit_bezier_symmetric_ease_in_out_midpoint_is_half() {
        // cubic-bezier(0.42,0,0.58,1) is point-symmetric about (0.5,0.5).
        assert!((super::unit_bezier(0.42, 0.0, 0.58, 1.0, 0.5) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn unit_bezier_ease_in_is_slow_at_start() {
        // Ease-in (0.42,0,1,1) stays below the diagonal for all x in (0,1) —
        // slow start, late surge, flat arrival; never overtakes the diagonal.
        assert!(super::unit_bezier(0.42, 0.0, 1.0, 1.0, 0.25) < 0.25);
        assert!(super::unit_bezier(0.42, 0.0, 1.0, 1.0, 0.75) < 0.75);
        assert!(super::unit_bezier(0.42, 0.0, 1.0, 1.0, 0.5) < 0.5);
    }

    /// Externally-anchored OkLab color golden. Expected mixed values were read back
    /// from Chromium 149 `color-mix(in oklab)` (external authority). The SAME
    /// fixture is asserted by the TS side too; a drift between the two sides indicates
    /// a real math divergence, not a tolerance issue.
    #[test]
    fn golden_color_vectors_match_fixture() {
        #[derive(serde::Deserialize)]
        struct Sample {
            t_us: TimeUs,
            expect: Rgba,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            track: Animated<Rgba>,
            samples: Vec<Sample>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            default: Rgba,
            cases: Vec<Case>,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/renderer/render/animatedColorGolden.fixture.json"
        ))
        .expect("color fixture parses as Animated<Rgba> wire shape");
        assert!(!fixture.cases.is_empty());
        for case in &fixture.cases {
            for s in &case.samples {
                let got = case.track.value_at(s.t_us, fixture.default);
                // ±1 tolerance: golden is anchored to Chromium/V8 math while Rust
                // uses `libm` (last-ULP rounding may differ by one count).
                // native↔wasm exactness is covered separately.
                assert!(
                    (got.r as i32 - s.expect.r as i32).abs() <= 1,
                    "case `{}` t_us={}: r got={}, expect={}",
                    case.name,
                    s.t_us,
                    got.r,
                    s.expect.r
                );
                assert!(
                    (got.g as i32 - s.expect.g as i32).abs() <= 1,
                    "case `{}` t_us={}: g got={}, expect={}",
                    case.name,
                    s.t_us,
                    got.g,
                    s.expect.g
                );
                assert!(
                    (got.b as i32 - s.expect.b as i32).abs() <= 1,
                    "case `{}` t_us={}: b got={}, expect={}",
                    case.name,
                    s.t_us,
                    got.b,
                    s.expect.b
                );
                assert!(
                    (got.a as i32 - s.expect.a as i32).abs() <= 1,
                    "case `{}` t_us={}: a got={}, expect={}",
                    case.name,
                    s.t_us,
                    got.a,
                    s.expect.a
                );
            }
        }
    }

    /// Cross-language golden vectors. The SAME fixture is asserted by
    /// `render/animated.golden.test.ts` against the TS `resolveAnimated`;
    /// a change that passes one side and fails the other is an engine
    /// drift, which is exactly what this test exists to catch. Also
    /// locks the serde wire shape (`mode`/`value`, `interp.kind`).
    #[test]
    fn golden_vectors_match_fixture() {
        #[derive(serde::Deserialize)]
        struct Sample {
            t_us: TimeUs,
            expect: f64,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            track: Animated<f64>,
            samples: Vec<Sample>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            default: f64,
            cases: Vec<Case>,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/renderer/render/animatedGolden.fixture.json"
        ))
        .expect("fixture parses as Animated<f64> wire shape");
        assert!(!fixture.cases.is_empty());
        for case in &fixture.cases {
            for s in &case.samples {
                let got = case.track.value_at(s.t_us, fixture.default);
                assert!(
                    (got - s.expect).abs() < 1e-6,
                    "case `{}` t_us={}: got {got}, expect {}",
                    case.name,
                    s.t_us,
                    s.expect
                );
            }
        }
    }
}
