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
            EffectParams::HtmlTransform { .. } => EffectKind::HtmlTransform,
        }
    }

    /// True iff any `Animated<T>` field on this effect's params is
    /// actually keyframed (more than one keyframe). Used by the routing
    /// rule that picks ffmpeg vs html-cap per layer/group: a Blur with
    /// `radius: Animated::Static(...)` stays on the fast ffmpeg gblur
    /// path; a Blur with two keyframes routes to html-cap where the
    /// engine resolves the radius per tick.
    ///
    /// `HtmlTransform` always reports `false` here because its kind
    /// already triggers html-cap regardless (no static-ffmpeg path
    /// exists for HtmlTransform). Callers should compose with
    /// `kind().requires_html()` to cover both reasons.
    pub fn has_keyframed_params(&self) -> bool {
        match &self.params {
            EffectParams::Blur { radius } => radius.is_animated(),
            EffectParams::ColorCorrect {
                brightness,
                contrast,
                saturation,
                gamma,
            } => {
                brightness.is_animated()
                    || contrast.is_animated()
                    || saturation.is_animated()
                    || gamma.is_animated()
            }
            EffectParams::ChromaKey {
                similarity,
                smoothness,
                ..
            } => similarity.is_animated() || smoothness.is_animated(),
            EffectParams::Speed { factor, .. } => factor.is_animated(),
            EffectParams::Vignette { amount } => amount.is_animated(),
            // HtmlTransform is always html-cap via its kind; no need to
            // report keyframes separately.
            EffectParams::HtmlTransform { .. } => false,
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
    /// `docs/html-render-groups.md` (2026-05-17 redesign) — a CSS
    /// transform animation. Carries `Animated<f64>` tracks for
    /// translate/scale/rotate/opacity. First and last keyframes
    /// implicitly mark the html-cap render window; outside the window
    /// the effect is inactive (the layer / group / member renders
    /// with no transform, fully via ffmpeg in the export planner's
    /// segment-stitching path).
    HtmlTransform,
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
            EffectKind::ColorCorrect | EffectKind::Blur | EffectKind::HtmlTransform => true,
            EffectKind::ChromaKey | EffectKind::Speed | EffectKind::Vignette => false,
        }
    }

    /// Whether this effect has an ffmpeg lavfi lowering. The
    /// `HtmlTransform` variant is **CSS-only** — its semantics (3D
    /// transforms, perspective, complex CSS animation) can't be
    /// expressed in lavfi. Its presence on a layer/group flags the
    /// affected time window for html-cap rendering; the export
    /// planner segments the timeline accordingly.
    pub fn supports_ffmpeg(self) -> bool {
        match self {
            EffectKind::ColorCorrect
            | EffectKind::Blur
            | EffectKind::ChromaKey
            | EffectKind::Speed
            | EffectKind::Vignette => true,
            EffectKind::HtmlTransform => false,
        }
    }

    /// True iff this kind's presence on a layer/group *requires* html-
    /// cap rendering during its active window. Distinct from
    /// `!supports_ffmpeg()` because some future effects might be
    /// "html-preferred but ffmpeg-fallback OK"; the planner currently
    /// uses this for strict segment-stitching (decision 2 of the
    /// 2026-05-17 redesign).
    pub fn requires_html(self) -> bool {
        !self.supports_ffmpeg()
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
    /// CSS transform animation. Each field's `Animated<f64>` carries a
    /// keyframe track in **owner-local** time (layer t_start_us for
    /// layer effects, group earliest-member t_start_us for group
    /// effects). The effect's render window is implicitly defined by
    /// the **union** of keyframe time ranges across all six fields —
    /// the smallest first_kf.t and largest last_kf.t. Outside that
    /// window the effect is inactive (planner picks ffmpeg).
    ///
    /// Default values when a field has no keyframes:
    ///   x, y, rotation_deg → 0.0
    ///   scale_x, scale_y, opacity → 1.0
    ///
    /// All static-initialized variants land on the value with no
    /// animation; the keyframed path is what the user authors via
    /// the property panel / MCP.
    HtmlTransform {
        x: Animated<f64>,
        y: Animated<f64>,
        scale_x: Animated<f64>,
        scale_y: Animated<f64>,
        rotation_deg: Animated<f64>,
        opacity: Animated<f64>,
    },
}
