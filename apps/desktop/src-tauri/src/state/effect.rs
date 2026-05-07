//! Per-layer effects. Order in `Layer.effects` is render order — first applied first.
//!
//! `[ColorCorrect, Blur]` produces different pixels than `[Blur, ColorCorrect]`.

// Effect family is Phase 2 scaffolding — types declared, lowering wired later.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::animated::Animated;
use super::color::Rgba;
use super::ids::EffectId;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Effect {
    pub id: EffectId,
    pub enabled: bool,
    pub params: EffectParams,
}

impl Effect {
    pub fn kind(&self) -> EffectKind {
        match &self.params {
            EffectParams::ColorCorrect { .. } => EffectKind::ColorCorrect,
            EffectParams::Blur { .. } => EffectKind::Blur,
            EffectParams::ChromaKey { .. } => EffectKind::ChromaKey,
            EffectParams::Speed { .. } => EffectKind::Speed,
            EffectParams::Vignette { .. } => EffectKind::Vignette,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EffectKind {
    ColorCorrect,
    Blur,
    ChromaKey,
    Speed,
    Vignette,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum EffectParams {
    ColorCorrect {
        brightness: Animated<f64>,
        contrast: Animated<f64>,
        saturation: Animated<f64>,
        gamma: Animated<f64>,
    },
    Blur {
        radius: Animated<f64>,
    },
    ChromaKey {
        key: Rgba,
        similarity: Animated<f64>,
        smoothness: Animated<f64>,
    },
    Speed {
        factor: Animated<f64>,
        preserve_pitch: bool,
    },
    Vignette {
        amount: Animated<f64>,
    },
}
