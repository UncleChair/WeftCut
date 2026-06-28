//! Color primitives.

// `Rgba::WHITE` / `Rgba::TRANSPARENT` are convenience constants used by tests
// and future UI/agent commands; not all wired in the lib build.
#![allow(dead_code)]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    pub const BLACK: Self = Self { r: 0, g: 0, b: 0, a: 255 };
    pub const WHITE: Self = Self { r: 255, g: 255, b: 255, a: 255 };
    pub const TRANSPARENT: Self = Self { r: 0, g: 0, b: 0, a: 0 };

    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255 }
    }

    /// Convert to the eval leaf's POD color type for keyframe interpolation.
    /// The leaf holds the OkLab/premultiplied-alpha math (and is the wasm-shared
    /// crate); `Rgba` stays the serde/schemars storage type. Plain methods, not
    /// `From`, to avoid the orphan rule (the leaf type is foreign here).
    pub fn to_eval(self) -> weftcut_eval::Rgba8 {
        weftcut_eval::Rgba8 { r: self.r, g: self.g, b: self.b, a: self.a }
    }

    /// Inverse of `to_eval` — rewrap an interpolated leaf color as storage `Rgba`.
    pub fn from_eval(c: weftcut_eval::Rgba8) -> Self {
        Self { r: c.r, g: c.g, b: c.b, a: c.a }
    }
}

impl Default for Rgba {
    fn default() -> Self {
        Self::BLACK
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default, JsonSchema)]
pub enum ColorSpace {
    #[default]
    Bt709,
    Bt601,
    Bt2020,
    SRgb,
}
