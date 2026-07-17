//! Sampled envelope contract — docs/audio.md §The envelope contract.
//!
//! `sample_gain` composes Animated gain_db (via the golden-locked
//! `Animated::value_at`) with the layer's linear fade ramps, on a fixed
//! 10 ms grid, in LINEAR gain (10^(dB/20)). Both renderers linearly
//! interpolate between the same points: Web Audio `setValueCurveAtTime`
//! on the TS side, `Envelope::eval` per sample on this side. The TS twin
//! is `apps/desktop/src/render/audio/envelope.ts`; the shared fixture is
//! `audioEnvelopeGolden.fixture.json` — keep all three in lockstep.

use crate::state::animated::Animated;

pub const ENVELOPE_STEP_US: i64 = 10_000; // 10 ms grid

/// Control points on the implicit grid: values[k] sits at t = k * step_us,
/// the last point clamps to the layer end. len()==1 ⇔ effectively static.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub step_us: i64,
    pub span_us: i64,
    pub values: Vec<f32>,
}

impl Envelope {
    pub fn constant(v: f32, span_us: i64) -> Self {
        Self {
            step_us: ENVELOPE_STEP_US,
            span_us,
            values: vec![v],
        }
    }

    pub fn is_constant(&self) -> bool {
        self.values.len() == 1
    }

    /// Linear interpolation between grid points, clamped at the ends.
    /// `t_us` is layer-local.
    pub fn eval(&self, t_us: i64) -> f32 {
        match self.values.len() {
            0 => 1.0,
            1 => self.values[0],
            _ => {
                if t_us <= 0 {
                    return self.values[0];
                }
                let last = (self.values.len() - 1) as i64;
                let pos = t_us as f64 / self.step_us as f64;
                let i = pos.floor() as i64;
                if i >= last {
                    return *self.values.last().unwrap();
                }
                let u = (pos - i as f64) as f32;
                let a = self.values[i as usize];
                let b = self.values[(i + 1) as usize];
                a + (b - a) * u
            }
        }
    }

    /// Multiply every control point by `factor`. Used to fold a role's
    /// linear gain into a layer's gain envelope (v1 role-bus realization).
    pub fn scale(&mut self, factor: f32) {
        for v in self.values.iter_mut() {
            *v *= factor;
        }
    }
}

// dB→linear lives in the weftcut-eval leaf (shared with the renderer's audio
// preview via wasm). Re-exported so `crate::audio::envelope::db_to_linear` and
// the golden tests keep resolving.
pub use weftcut_eval::db_to_linear;

// Fade ramp lives in the weftcut-eval leaf (shared with the renderer's gain
// sampler via wasm). Re-exported so `crate::audio::envelope::fade_multiplier`
// and `sample_gain` keep resolving against one source.
pub use weftcut_eval::fade_multiplier;

/// Gain envelope for one audio layer: linear(value_at(gain_db)) × fades.
/// Static gain + no fades short-circuits to a single point.
pub fn sample_gain(
    gain_db: &Animated<f64>,
    fade_in_us: i64,
    fade_out_us: i64,
    span_us: i64,
) -> Envelope {
    let animated = gain_db.is_animated();
    if !animated && fade_in_us == 0 && fade_out_us == 0 {
        return Envelope::constant(db_to_linear(gain_db.value_at(0, 0.0)), span_us);
    }
    // Collect keyframes ONCE (not per sample): the per-sample `value_at` would
    // re-materialize the Kf slice on every 10 ms step. `static_v` short-circuits
    // the Static case (empty kfs ⇒ eval_f64 would return the default, not v).
    let kfs = gain_db.eval_kfs();
    let static_v = if let Animated::Static(v) = gain_db { Some(*v) } else { None };
    let base = |t: i64| -> f64 {
        match static_v {
            Some(v) => v,
            None => weftcut_eval::eval_f64(&kfs, t, 0.0),
        }
    };
    let mut values = Vec::with_capacity((span_us / ENVELOPE_STEP_US) as usize + 2);
    let mut k = 0i64;
    loop {
        let t = (k * ENVELOPE_STEP_US).min(span_us);
        let g = db_to_linear(base(t))
            * fade_multiplier(t, span_us, fade_in_us, fade_out_us) as f32;
        values.push(g);
        if t >= span_us {
            break;
        }
        k += 1;
    }
    Envelope {
        step_us: ENVELOPE_STEP_US,
        span_us,
        values,
    }
}

/// Pan envelope: plain sampling of Animated pan, clamped to [-1, 1].
pub fn sample_pan(pan: &Animated<f64>, span_us: i64) -> Envelope {
    if !pan.is_animated() {
        return Envelope::constant(pan.value_at(0, 0.0).clamp(-1.0, 1.0) as f32, span_us);
    }
    // Animated ⇒ Keyframed with ≥2 keys, so collect once and eval the slice
    // directly (no Static case to special-case here).
    let kfs = pan.eval_kfs();
    let mut values = Vec::new();
    let mut k = 0i64;
    loop {
        let t = (k * ENVELOPE_STEP_US).min(span_us);
        values.push(weftcut_eval::eval_f64(&kfs, t, 0.0).clamp(-1.0, 1.0) as f32);
        if t >= span_us {
            break;
        }
        k += 1;
    }
    Envelope {
        step_us: ENVELOPE_STEP_US,
        span_us,
        values,
    }
}

/// Lerped equal-power pan coefficients `[a,b,c,d]` at layer-local `t_us`, off a
/// pan-VALUE envelope. Computes `pan_coeffs` at the two grid points straddling
/// `t_us` (from the un-lerped grid values) and lerps the coefficients — the X
/// parity contract: both export and the preview matrix mixer lerp COEFFICIENTS,
/// not the pan value. Mirrors `render/audio/panGraph.ts::panCoeffsAt`.
pub fn pan_coeffs_at(pan: &Envelope, channels: i32, t_us: i64) -> [f32; 4] {
    use weftcut_eval::pan_coeffs;
    if pan.values.len() <= 1 {
        return pan_coeffs(*pan.values.first().unwrap_or(&0.0) as f64, channels);
    }
    let last = (pan.values.len() - 1) as i64;
    let pos = (t_us.max(0) as f64) / pan.step_us as f64;
    let i = (pos.floor() as i64).min(last);
    let a = pan_coeffs(pan.values[i as usize] as f64, channels);
    if i >= last {
        return a;
    }
    let b = pan_coeffs(pan.values[(i + 1) as usize] as f64, channels);
    let u = (pos - i as f64) as f32;
    [
        a[0] + (b[0] - a[0]) * u,
        a[1] + (b[1] - a[1]) * u,
        a[2] + (b[2] - a[2]) * u,
        a[3] + (b[3] - a[3]) * u,
    ]
}

/// Property-based twin test: pins `pan_coeffs_at` to the same spec as the TS
/// twin `panCoeffsAt` (render/audio/panGraph.ts). The reference is derived
/// independently — it must NOT call `pan_coeffs_at` itself.
#[cfg(test)]
mod pbt {
    use super::*;
    use proptest::prelude::*;
    use proptest::sample::select;

    proptest! {
        #[test]
        fn pan_coeffs_at_matches_reference(
            values in proptest::collection::vec(-1.0f64..=1.0, 1usize..8),
            step_us in select(vec![10_000i64, 20_000]),
            channels in select(vec![1i32, 2]),
            t_us in -50_000i64..200_000,
        ) {
            // Build an Envelope directly from the generated grid — same shape
            // that sample_pan produces (values already clamped f64→f32).
            let env = Envelope {
                step_us,
                span_us: (values.len() as i64 - 1) * step_us,
                values: values.iter().map(|&v| v as f32).collect(),
            };

            let got = pan_coeffs_at(&env, channels, t_us);

            // --- Independent reference (mirrors the TS reference exactly) ---
            // coeff(idx) reads the SAME f32-rounded grid value production reads
            // from `env.values` (production round-trips f64→f32→f64), so the
            // comparison is on identical inputs — not the raw proptest f64 vec.
            // The outer loop (index/clamp/lerp) is still derived independently.
            let coeff = |idx: usize| weftcut_eval::pan_coeffs(env.values[idx] as f64, channels);
            let last = values.len() - 1;
            let exp: [f32; 4] = if last == 0 {
                coeff(0)
            } else {
                let pos = (t_us.max(0) as f64) / step_us as f64;
                let i = (pos.floor() as usize).min(last);
                if i >= last {
                    coeff(last)
                } else {
                    let frac = (pos - i as f64) as f32;
                    let a = coeff(i);
                    let b = coeff(i + 1);
                    [
                        a[0] + (b[0] - a[0]) * frac,
                        a[1] + (b[1] - a[1]) * frac,
                        a[2] + (b[2] - a[2]) * frac,
                        a[3] + (b[3] - a[3]) * frac,
                    ]
                }
            };

            for k in 0..4 {
                prop_assert!(
                    (got[k] - exp[k]).abs() < 1e-6,
                    "k={} got={} exp={} (t_us={} step_us={} channels={} values={:?})",
                    k, got[k], exp[k], t_us, step_us, channels, values
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::animated::{Animated, Interpolation, Keyframe};
    use crate::state::ids::new_id;

    fn kf(t_us: i64, value: f64) -> Keyframe<f64> {
        Keyframe {
            id: new_id(),
            t_us,
            value,
            interp: Interpolation::Linear,
        }
    }

    #[test]
    fn scale_multiplies_every_point() {
        let mut e = sample_gain(&Animated::Static(0.0), 0, 0, 1_000_000); // unity, 1 point
        e.scale(0.5);
        assert!((e.eval(0) - 0.5).abs() < 1e-6);
        let mut k = sample_gain(&Animated::Static(0.0), 1_000_000, 0, 1_000_000); // fade-in ramp
        k.scale(2.0);
        assert!((k.eval(1_000_000) - 2.0).abs() < 1e-3);
    }

    #[test]
    fn static_no_fades_is_single_point() {
        let e = sample_gain(&Animated::Static(-6.0), 0, 0, 10_000_000);
        assert!(e.is_constant());
        assert!((e.values[0] - db_to_linear(-6.0)).abs() < 1e-6);
        assert!((e.eval(0) - e.eval(9_999_999)).abs() < 1e-9);
    }

    #[test]
    fn zero_db_is_unity() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 1e-9);
        assert!((db_to_linear(-20.0) - 0.1).abs() < 1e-6);
    }

    #[test]
    fn fade_in_ramps_linearly() {
        // 0 dB gain, 1 s fade-in over a 10 s layer.
        let e = sample_gain(&Animated::Static(0.0), 1_000_000, 0, 10_000_000);
        assert!((e.eval(0) - 0.0).abs() < 1e-6);
        assert!((e.eval(500_000) - 0.5).abs() < 1e-3);
        assert!((e.eval(1_000_000) - 1.0).abs() < 1e-3);
        assert!((e.eval(5_000_000) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn fade_out_ramps_to_zero_at_end() {
        let e = sample_gain(&Animated::Static(0.0), 0, 1_000_000, 10_000_000);
        assert!((e.eval(9_000_000) - 1.0).abs() < 1e-3);
        assert!((e.eval(9_500_000) - 0.5).abs() < 1e-3);
        assert!((e.eval(10_000_000) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn keyframed_gain_samples_the_engine_curve() {
        // -20 dB → 0 dB linear over 1 s: midpoint is -10 dB in dB-space,
        // sampled then linearized.
        let track = Animated::Keyframed(
            vec![kf(0, -20.0), kf(1_000_000, 0.0)].into_iter().collect(),
        );
        let e = sample_gain(&track, 0, 0, 1_000_000);
        assert!(!e.is_constant());
        assert!((e.eval(500_000) - db_to_linear(-10.0)).abs() < 2e-3);
    }

    #[test]
    fn grid_covers_span_inclusive() {
        let e = sample_gain(&Animated::Static(0.0), 0, 100_000, 25_000);
        // span 25 ms → points at 0, 10, 20, 25 ms = 4 points
        assert_eq!(e.values.len(), 4);
    }

    /// Cross-language golden vectors. The SAME fixture is asserted by
    /// `render/audio/envelope.golden.test.ts` against the TS twin; a change
    /// that passes one side and fails the other is envelope-contract drift.
    /// Also locks the serde wire shape (`mode`/`value`, `interp.kind`).
    #[test]
    fn golden_vectors_match_fixture() {
        #[derive(serde::Deserialize)]
        struct Sample {
            t_us: i64,
            expect: f64,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            gain_db: Animated<f64>,
            fade_in_us: i64,
            fade_out_us: i64,
            span_us: i64,
            samples: Vec<Sample>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/renderer/render/audio/audioEnvelopeGolden.fixture.json"
        ))
        .expect("fixture parses as Animated<f64> wire shape");
        assert!(!fixture.cases.is_empty());
        for case in &fixture.cases {
            let e = sample_gain(&case.gain_db, case.fade_in_us, case.fade_out_us, case.span_us);
            for s in &case.samples {
                let got = e.eval(s.t_us) as f64;
                assert!(
                    (got - s.expect).abs() < 1e-5,
                    "case `{}` t_us={}: got {got}, expect {}",
                    case.name,
                    s.t_us,
                    s.expect
                );
            }
        }

        #[derive(serde::Deserialize)]
        struct PanSample { t_us: i64, expect: f64 }
        #[derive(serde::Deserialize)]
        struct PanCase { name: String, pan: Animated<f64>, span_us: i64, samples: Vec<PanSample> }
        #[derive(serde::Deserialize)]
        struct CoeffSample { t_us: i64, expect: [f32; 4] }
        #[derive(serde::Deserialize)]
        struct CoeffCase { name: String, pan: Animated<f64>, channels: i32, span_us: i64, samples: Vec<CoeffSample> }
        #[derive(serde::Deserialize)]
        struct Fixture2 {
            #[serde(default)] pan_cases: Vec<PanCase>,
            #[serde(default)] pan_coeff_env_cases: Vec<CoeffCase>,
        }

        let fx2: Fixture2 = serde_json::from_str(include_str!(
            "../../../src/renderer/render/audio/audioEnvelopeGolden.fixture.json"
        )).unwrap();
        for c in &fx2.pan_cases {
            let e = sample_pan(&c.pan, c.span_us);
            for s in &c.samples {
                assert!((e.eval(s.t_us) as f64 - s.expect).abs() < 1e-5,
                    "pan `{}` t={}: got {}, expect {}", c.name, s.t_us, e.eval(s.t_us), s.expect);
            }
        }
        for c in &fx2.pan_coeff_env_cases {
            let e = sample_pan(&c.pan, c.span_us);
            for s in &c.samples {
                let got = pan_coeffs_at(&e, c.channels, s.t_us);
                for i in 0..4 {
                    assert!((got[i] - s.expect[i]).abs() < 1e-5,
                        "coeff-env `{}` t={} idx{i}: got {}, expect {}", c.name, s.t_us, got[i], s.expect[i]);
                }
            }
        }
    }
}
