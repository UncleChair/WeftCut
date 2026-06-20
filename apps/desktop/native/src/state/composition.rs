//! Canvas composition: dimensions, frame rate, audio config, color space.

use serde::{Deserialize, Serialize};

use super::color::{ColorSpace, Rgba};
use super::time::{Rational, TimeUs};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Composition {
    pub width: u32,
    pub height: u32,
    pub fps: Rational,
    /// Composition length as an EXCLUSIVE boundary: the half-open interval
    /// of the timeline is `[0, duration_us)`. For a 10 s 30 fps comp,
    /// `duration_us = 10_000_000` (the boundary AFTER frame 299, not frame
    /// 299's own anchor at 9_966_667). The playhead, being a frame anchor,
    /// can never sit at `duration_us`; its upper bound is
    /// `lastFrameAnchorUs` in `apps/desktop/src/renderer/frames.ts`. See
    /// `docs/data-model.md` for the boundary-vs-anchor distinction.
    ///
    /// Auto-fits to `max(layer.t_end_us)` while `duration_pinned` is false.
    /// An explicit `set_composition { duration_us }` sets the pin and freezes
    /// the value until `fit_composition_to_layers` clears it. See ADR 0005.
    pub duration_us: TimeUs,
    /// When true, layer edits no longer mutate `duration_us` (except to
    /// guard the `duration_us >= max(layer.t_end_us)` invariant). Cleared
    /// by `fit_composition_to_layers`. Old projects deserialize with this
    /// false and self-heal on first edit.
    #[serde(default)]
    pub duration_pinned: bool,
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
            duration_pinned: false,
            sample_rate: 48_000,
            channels: 2,
            color_space: ColorSpace::Bt709,
            background: Rgba::BLACK,
        }
    }
}
