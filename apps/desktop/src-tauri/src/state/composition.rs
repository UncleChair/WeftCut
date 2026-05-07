//! Canvas composition: dimensions, frame rate, audio config, color space.

use serde::{Deserialize, Serialize};

use super::color::{ColorSpace, Rgba};
use super::time::{Rational, TimeUs};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Composition {
    pub width: u32,
    pub height: u32,
    pub fps: Rational,
    /// Computed from layers; user-overridable.
    pub duration_us: TimeUs,
    pub sample_rate: u32,
    pub channels: u8,
    #[serde(default)]
    pub color_space: ColorSpace,
    #[serde(default)]
    pub background: Rgba,
}

impl Default for Composition {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: Rational::FPS_30,
            duration_us: 0,
            sample_rate: 48_000,
            channels: 2,
            color_space: ColorSpace::Bt709,
            background: Rgba::BLACK,
        }
    }
}
