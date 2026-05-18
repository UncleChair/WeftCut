//! Time and rate primitives. Time is `i64` microseconds; never round-trip through
//! `f64` seconds except at API boundaries — precision loss starts past the hour mark.

// `US_PER_SEC`/`US_PER_MS` and the `FPS_*` presets are public scaffolding —
// they'll be wired by Phase 2 UI / agent commands.
#![allow(dead_code)]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub type TimeUs = i64;

pub const US_PER_SEC: i64 = 1_000_000;
pub const US_PER_MS: i64 = 1_000;

/// Frame rate as an exact rational. `30000/1001` ≠ `29.97`, and ffmpeg cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Rational {
    pub num: u32,
    pub den: u32,
}

impl Rational {
    pub const fn new(num: u32, den: u32) -> Self {
        Self { num, den }
    }

    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    pub const FPS_24: Self = Self::new(24, 1);
    pub const FPS_25: Self = Self::new(25, 1);
    pub const FPS_29_97: Self = Self::new(30_000, 1001);
    pub const FPS_30: Self = Self::new(30, 1);
    pub const FPS_60: Self = Self::new(60, 1);
}

/// Round `t_us` DOWN to the nearest canvas-fps frame boundary.
///
/// Math (in `i128` to avoid overflow at hour-plus timelines):
///
/// ```text
/// frame_index   = floor(t_us * fps.num / (US_PER_SEC * fps.den))
/// snapped_t_us  = frame_index * US_PER_SEC * fps.den / fps.num
/// ```
///
/// 29.97 fps (30000/1001) doesn't yield integer-us frame boundaries; the
/// final divide truncates. Both Pass B branches snap with the same
/// function so they agree regardless of the rounding direction. See
/// `docs/effects-routing-pass-b.md` §10.
pub fn snap_frame_floor(t_us: TimeUs, fps: Rational) -> TimeUs {
    let prod = (t_us as i128) * (fps.num as i128);
    let div = (US_PER_SEC as i128) * (fps.den as i128);
    let frame_index = prod.div_euclid(div);
    let snapped = frame_index * (US_PER_SEC as i128) * (fps.den as i128) / (fps.num as i128);
    snapped as TimeUs
}

/// Round `t_us` UP to the nearest canvas-fps frame boundary. Symmetric
/// to `snap_frame_floor`; see its docs.
pub fn snap_frame_ceil(t_us: TimeUs, fps: Rational) -> TimeUs {
    let prod = (t_us as i128) * (fps.num as i128);
    let div = (US_PER_SEC as i128) * (fps.den as i128);
    let frame_index = prod.div_euclid(div);
    let rem = prod.rem_euclid(div);
    let frame_index = if rem > 0 { frame_index + 1 } else { frame_index };
    let snapped = frame_index * (US_PER_SEC as i128) * (fps.den as i128) / (fps.num as i128);
    snapped as TimeUs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snap_floor_integer_fps_at_frame_boundary() {
        // 30 fps → frame duration ~33333.33 us. The function uses i128
        // integer math throughout, so the asymmetry around the
        // non-integer frame boundary lands as:
        //   * t=0       → frame 0 starts at 0
        //   * t=33332   → still in frame 0 (33332*30 < 1_000_000)
        //   * t=33333   → still in frame 0 (33333*30 = 999990 < 1e6)
        //   * t=33334   → snaps DOWN to frame 1's snapped start = 33333
        // The asymmetry doesn't matter for Pass B as long as both
        // branches snap with the same function (and they do).
        assert_eq!(snap_frame_floor(0, Rational::FPS_30), 0);
        assert_eq!(snap_frame_floor(33_332, Rational::FPS_30), 0);
        assert_eq!(snap_frame_floor(33_333, Rational::FPS_30), 0);
        assert_eq!(snap_frame_floor(33_334, Rational::FPS_30), 33_333);
    }

    #[test]
    fn snap_ceil_integer_fps_at_frame_boundary() {
        assert_eq!(snap_frame_ceil(0, Rational::FPS_30), 0);
        // Just past the first frame boundary should snap to the next frame.
        assert_eq!(snap_frame_ceil(1, Rational::FPS_30), 33_333);
        assert_eq!(snap_frame_ceil(33_333, Rational::FPS_30), 33_333);
        assert_eq!(snap_frame_ceil(33_334, Rational::FPS_30), 66_666);
    }

    #[test]
    fn snap_floor_29_97_doesnt_overflow_at_hour_scale() {
        // Sanity: an hour in microseconds is 3_600_000_000.
        // i128 arithmetic must not overflow.
        let one_hour = 3_600_000_000_i64;
        let snapped = snap_frame_floor(one_hour, Rational::FPS_29_97);
        // 29.97 fps means ~107892 frames per hour. Snapped value is
        // <= one_hour by construction.
        assert!(snapped <= one_hour);
        assert!(snapped > one_hour - 50_000); // within one frame
    }

    #[test]
    fn snap_floor_then_ceil_brackets_input() {
        // For any t_us in the middle of a frame, floor < t_us <= ceil
        // (or floor == t_us == ceil when on a boundary).
        let t = 17_000_i64; // middle of frame 0 at 30 fps
        let lo = snap_frame_floor(t, Rational::FPS_30);
        let hi = snap_frame_ceil(t, Rational::FPS_30);
        assert!(lo <= t);
        assert!(t <= hi);
        assert!(hi - lo <= 33_334); // one frame at 30 fps
    }
}
