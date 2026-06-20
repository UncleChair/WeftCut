//! Time and rate primitives. Time is `i64` microseconds; never round-trip through
//! `f64` seconds except at API boundaries — precision loss starts past the hour mark.
//!
//! The frame-snap ALGORITHM lives in the `weftcut-eval` leaf crate so there is ONE
//! source of truth for the frame grid across the renderer↔Rust boundary (the
//! renderer consumes the same crate compiled to wasm). `Rational` stays here: it
//! carries the serde + schemars derives the project schema needs, which the leaf
//! deliberately forbids — so the snap wrappers below pass its `(num, den)` to the
//! leaf. The storage invariant (every timeline mutation snaps to the grid,
//! `state/actor/mutations.rs`) and the renderer's drag/seek/playhead snap now run
//! the exact same i128 math.

// `US_PER_SEC`/`US_PER_MS` and the `FPS_*` presets are public API surface not
// all consumed internally yet.
#![allow(dead_code)]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use weftcut_eval::{US_PER_MS, US_PER_SEC};

pub type TimeUs = i64;

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
/// Delegates to the shared i128 algorithm in `weftcut-eval`.
pub fn snap_frame_floor(t_us: TimeUs, fps: Rational) -> TimeUs {
    weftcut_eval::snap_frame_floor(t_us, fps.num, fps.den)
}

/// Round `t_us` UP to the nearest canvas-fps frame boundary.
/// Delegates to the shared i128 algorithm in `weftcut-eval`.
pub fn snap_frame_ceil(t_us: TimeUs, fps: Rational) -> TimeUs {
    weftcut_eval::snap_frame_ceil(t_us, fps.num, fps.den)
}

/// Round `t_us` to the NEAREST canvas-fps frame boundary (half-up). This is the
/// snap used for every timeline mutation (move, trim, split, seek); see the leaf
/// for the half-up OUTPUT rounding that aligns with the demuxer's source-PTS
/// rounding. Delegates to the shared i128 algorithm in `weftcut-eval`.
pub fn snap_frame_round(t_us: TimeUs, fps: Rational) -> TimeUs {
    weftcut_eval::snap_frame_round(t_us, fps.num, fps.den)
}
