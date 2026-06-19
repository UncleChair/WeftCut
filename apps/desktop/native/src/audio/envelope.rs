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

pub fn db_to_linear(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

/// Fade multiplier at layer-local `t_us`: linear 0→1 over fade_in from the
/// layer start, 1→0 over fade_out into the layer end, multiplied when they
/// overlap. Zero-length fades are identity.
pub fn fade_multiplier(t_us: i64, span_us: i64, fade_in_us: i64, fade_out_us: i64) -> f64 {
    let mut m = 1.0f64;
    if fade_in_us > 0 && t_us < fade_in_us {
        m *= (t_us.max(0) as f64) / fade_in_us as f64;
    }
    if fade_out_us > 0 {
        let from_end = span_us - t_us;
        if from_end < fade_out_us {
            m *= (from_end.max(0) as f64) / fade_out_us as f64;
        }
    }
    m
}

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
    let mut values = Vec::with_capacity((span_us / ENVELOPE_STEP_US) as usize + 2);
    let mut k = 0i64;
    loop {
        let t = (k * ENVELOPE_STEP_US).min(span_us);
        let g = db_to_linear(gain_db.value_at(t, 0.0))
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
    let mut values = Vec::new();
    let mut k = 0i64;
    loop {
        let t = (k * ENVELOPE_STEP_US).min(span_us);
        values.push(pan.value_at(t, 0.0).clamp(-1.0, 1.0) as f32);
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

/// Web Audio StereoPannerNode equal-power pan law. Verified branch-for-branch
/// against Chromium's implementation (the engine WebView2 actually runs):
/// third_party/blink/renderer/platform/audio/stereo_panner.cc — mono
/// pan_radian=(pan·0.5+0.5)·π/2; stereo pan≤0 pan_radian=(pan+1)·π/2 with
/// out_l = l + r·gain_l; stereo pan>0 pan_radian=pan·π/2 with
/// out_r = r + l·gain_r. Returns the (L, R) output frame.
///
/// mono:   x = (pan+1)/2;  L = in·cos(xπ/2),       R = in·sin(xπ/2)
/// stereo, pan≤0: x = pan+1; L = l + r·cos(xπ/2),  R = r·sin(xπ/2)
/// stereo, pan>0: x = pan;   L = l·cos(xπ/2),      R = r + l·sin(xπ/2)
pub fn pan_frame(pan: f32, ch: &[f32]) -> (f32, f32) {
    use std::f32::consts::FRAC_PI_2;
    let p = pan.clamp(-1.0, 1.0);
    match ch.len() {
        1 => {
            let x = (p + 1.0) / 2.0;
            (ch[0] * (x * FRAC_PI_2).cos(), ch[0] * (x * FRAC_PI_2).sin())
        }
        _ => {
            let (l, r) = (ch[0], ch[1]);
            if p <= 0.0 {
                let x = p + 1.0;
                (l + r * (x * FRAC_PI_2).cos(), r * (x * FRAC_PI_2).sin())
            } else {
                let x = p;
                (l * (x * FRAC_PI_2).cos(), r + l * (x * FRAC_PI_2).sin())
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

    #[test]
    fn pan_law_center_mono_is_equal_power() {
        let (l, r) = pan_frame(0.0, &[1.0]);
        let half = (std::f32::consts::FRAC_PI_4).cos(); // = sin(π/4) ≈ 0.7071
        assert!((l - half).abs() < 1e-6);
        assert!((r - half).abs() < 1e-6);
    }

    #[test]
    fn pan_law_stereo_center_is_identity() {
        // pan = 0, stereo: x = 1 ⇒ cos(π/2)=0, so L = l + r·0 = l; R = r·1 = r.
        let (l, r) = pan_frame(0.0, &[0.3, 0.7]);
        assert!((l - 0.3).abs() < 1e-6);
        assert!((r - 0.7).abs() < 1e-6);
    }

    #[test]
    fn pan_law_hard_left_stereo_folds_right_into_left() {
        let (l, r) = pan_frame(-1.0, &[0.3, 0.7]);
        assert!((l - 1.0).abs() < 1e-6); // 0.3 + 0.7·cos(0) = 1.0
        assert!(r.abs() < 1e-6);
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
            "../../../src/render/audio/audioEnvelopeGolden.fixture.json"
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
    }
}
