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

impl EffectKind {
    /// Whether this effect has a CSS-rendered representation. Consulted
    /// by `state::validate` to reject `Group.render_mode = Html` when a
    /// member layer carries an effect that ffmpeg can do but CSS can't
    /// — the strict-refusal policy from `docs/html-render-groups.md`
    /// decision 8. False today doesn't mean "never" — it means "no v1
    /// CSS impl exists" and adding one is a real piece of work
    /// (per-effect shader / SVG-filter / radial-gradient adapter).
    ///
    /// Today's mapping (revisit as the html-render-groups effect
    /// catalog grows):
    ///
    /// | Kind          | supports_css | Why                                              |
    /// |---------------|--------------|--------------------------------------------------|
    /// | ColorCorrect  | true         | `filter: brightness/contrast/saturate(...)`      |
    /// | Blur          | true         | `filter: blur(...)` (math diverges from `gblur`, |
    /// |               |              | but inside an html-group CSS *is* the truth)     |
    /// | ChromaKey     | false        | No native CSS chroma-key; SVG filter would be    |
    /// |               |              | a real engineering project                       |
    /// | Speed         | false        | Temporal remap, not a per-frame style; html-group|
    /// |               |              | source frames are pre-extracted at canvas fps,   |
    /// |               |              | which makes Speed redundant inside the island    |
    /// | Vignette      | false        | Possible via radial-gradient overlay or          |
    /// |               |              | `mask-image`, but no impl in v1                  |
    ///
    /// Effects without `supports_css` block toggling a containing group
    /// to `Html` render mode; surface the structured error to the user
    /// at edit time (decision 8) so silent drops at export are
    /// impossible.
    pub fn supports_css(self) -> bool {
        match self {
            EffectKind::ColorCorrect | EffectKind::Blur => true,
            EffectKind::ChromaKey | EffectKind::Speed | EffectKind::Vignette => false,
        }
    }

    /// Whether this effect has an ffmpeg lavfi lowering. Always `true`
    /// today — every effect must lower to ffmpeg or it couldn't ship.
    /// The mirror of `supports_css` for symmetry; consulted by lowering
    /// if/when an export-only-via-CSS effect ever lands.
    pub fn supports_ffmpeg(self) -> bool {
        match self {
            EffectKind::ColorCorrect
            | EffectKind::Blur
            | EffectKind::ChromaKey
            | EffectKind::Speed
            | EffectKind::Vignette => true,
        }
    }
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
