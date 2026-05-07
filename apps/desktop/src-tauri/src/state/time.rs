//! Time and rate primitives. Time is `i64` microseconds; never round-trip through
//! `f64` seconds except at API boundaries — precision loss starts past the hour mark.

// `US_PER_SEC`/`US_PER_MS` and the `FPS_*` presets are public scaffolding —
// they'll be wired by Phase 2 UI / agent commands.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub type TimeUs = i64;

pub const US_PER_SEC: i64 = 1_000_000;
pub const US_PER_MS: i64 = 1_000;

/// Frame rate as an exact rational. `30000/1001` ≠ `29.97`, and ffmpeg cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
