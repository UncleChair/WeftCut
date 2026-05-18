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

    /// Owner-local intervals where any keyframed `Animated<f64>` field
    /// on this effect's params is actually animating (continuous-interp
    /// + distinct values). Union across all keyframed fields. Rebased to
    /// main-timeline by adding `owner_t_start`.
    ///
    /// Disabled effects contribute nothing. See
    /// `docs/effects-routing-pass-b.md` §3.
    pub fn animating_runs(&self, owner_t_start: super::time::TimeUs) -> Vec<(super::time::TimeUs, super::time::TimeUs)> {
        if !self.enabled {
            return Vec::new();
        }
        let mut runs: Vec<(super::time::TimeUs, super::time::TimeUs)> = Vec::new();
        let mut push_runs = |anim_runs: Vec<(super::time::TimeUs, super::time::TimeUs)>| {
            for (a, b) in anim_runs {
                runs.push((a + owner_t_start, b + owner_t_start));
            }
        };
        match &self.params {
            EffectParams::Blur { radius } => {
                push_runs(radius.animating_runs());
            }
            EffectParams::ColorCorrect {
                brightness,
                contrast,
                saturation,
                gamma,
            } => {
                push_runs(brightness.animating_runs());
                push_runs(contrast.animating_runs());
                push_runs(saturation.animating_runs());
                push_runs(gamma.animating_runs());
            }
            EffectParams::ChromaKey {
                similarity,
                smoothness,
                ..
            } => {
                push_runs(similarity.animating_runs());
                push_runs(smoothness.animating_runs());
            }
            EffectParams::Speed { factor, .. } => {
                push_runs(factor.animating_runs());
            }
            EffectParams::Vignette { amount } => {
                push_runs(amount.animating_runs());
            }
            EffectParams::HtmlTransform {
                x,
                y,
                scale_x,
                scale_y,
                rotation_deg,
                opacity,
            } => {
                push_runs(x.animating_runs());
                push_runs(y.animating_runs());
                push_runs(scale_x.animating_runs());
                push_runs(scale_y.animating_runs());
                push_runs(rotation_deg.animating_runs());
                push_runs(opacity.animating_runs());
            }
        }
        runs
    }

    /// Owner-local Hold-step timestamps (rebased to main-timeline by
    /// adding `owner_t_start`). Disabled effects contribute nothing.
    /// See `docs/effects-routing-pass-b.md` §4.
    pub fn hold_step_times(&self, owner_t_start: super::time::TimeUs) -> Vec<super::time::TimeUs> {
        if !self.enabled {
            return Vec::new();
        }
        let mut steps: Vec<super::time::TimeUs> = Vec::new();
        let mut push_steps = |ts: Vec<super::time::TimeUs>| {
            for t in ts {
                steps.push(t + owner_t_start);
            }
        };
        match &self.params {
            EffectParams::Blur { radius } => push_steps(radius.hold_step_times()),
            EffectParams::ColorCorrect {
                brightness,
                contrast,
                saturation,
                gamma,
            } => {
                push_steps(brightness.hold_step_times());
                push_steps(contrast.hold_step_times());
                push_steps(saturation.hold_step_times());
                push_steps(gamma.hold_step_times());
            }
            EffectParams::ChromaKey {
                similarity,
                smoothness,
                ..
            } => {
                push_steps(similarity.hold_step_times());
                push_steps(smoothness.hold_step_times());
            }
            EffectParams::Speed { factor, .. } => push_steps(factor.hold_step_times()),
            EffectParams::Vignette { amount } => push_steps(amount.hold_step_times()),
            EffectParams::HtmlTransform {
                x,
                y,
                scale_x,
                scale_y,
                rotation_deg,
                opacity,
            } => {
                push_steps(x.hold_step_times());
                push_steps(y.hold_step_times());
                push_steps(scale_x.hold_step_times());
                push_steps(scale_y.hold_step_times());
                push_steps(rotation_deg.hold_step_times());
                push_steps(opacity.hold_step_times());
            }
        }
        steps
    }

    /// Return a copy of this effect with every `Animated<f64>` field
    /// replaced by `Static(value_at(t_us_owner_local))`. Per-field
    /// defaults match the effect's identity values (see `is_identity`)
    /// so empty `Keyframed` tracks substitute to identity. Disabled
    /// effects are returned unchanged. See
    /// `docs/effects-routing-pass-b.md` §3 + §9.
    pub fn held_at(&self, t_us_owner_local: super::time::TimeUs) -> Effect {
        if !self.enabled {
            return self.clone();
        }
        let new_params = match &self.params {
            EffectParams::Blur { radius } => EffectParams::Blur {
                radius: Animated::Static(radius.value_at(t_us_owner_local, 0.0)),
            },
            EffectParams::ColorCorrect {
                brightness,
                contrast,
                saturation,
                gamma,
            } => EffectParams::ColorCorrect {
                brightness: Animated::Static(brightness.value_at(t_us_owner_local, 1.0)),
                contrast: Animated::Static(contrast.value_at(t_us_owner_local, 1.0)),
                saturation: Animated::Static(saturation.value_at(t_us_owner_local, 1.0)),
                gamma: Animated::Static(gamma.value_at(t_us_owner_local, 1.0)),
            },
            EffectParams::ChromaKey {
                key,
                similarity,
                smoothness,
            } => EffectParams::ChromaKey {
                key: *key,
                similarity: Animated::Static(similarity.value_at(t_us_owner_local, 0.0)),
                smoothness: Animated::Static(smoothness.value_at(t_us_owner_local, 0.0)),
            },
            EffectParams::Speed {
                factor,
                preserve_pitch,
            } => EffectParams::Speed {
                factor: Animated::Static(factor.value_at(t_us_owner_local, 1.0)),
                preserve_pitch: *preserve_pitch,
            },
            EffectParams::Vignette { amount } => EffectParams::Vignette {
                amount: Animated::Static(amount.value_at(t_us_owner_local, 0.0)),
            },
            EffectParams::HtmlTransform {
                x,
                y,
                scale_x,
                scale_y,
                rotation_deg,
                opacity,
            } => EffectParams::HtmlTransform {
                x: Animated::Static(x.value_at(t_us_owner_local, 0.0)),
                y: Animated::Static(y.value_at(t_us_owner_local, 0.0)),
                scale_x: Animated::Static(scale_x.value_at(t_us_owner_local, 1.0)),
                scale_y: Animated::Static(scale_y.value_at(t_us_owner_local, 1.0)),
                rotation_deg: Animated::Static(rotation_deg.value_at(t_us_owner_local, 0.0)),
                opacity: Animated::Static(opacity.value_at(t_us_owner_local, 1.0)),
            },
        };
        Effect {
            id: self.id,
            enabled: self.enabled,
            params: new_params,
        }
    }

    /// True iff every field is at the effect's identity value (within
    /// float tolerance). Per `docs/effects-routing-pass-b.md` §5 the
    /// gap absorber consults this on each held effect to decide
    /// whether the gap can render via the fast ffmpeg path.
    ///
    /// Returns `true` for disabled effects (a disabled effect
    /// contributes nothing — that's the identity case by definition).
    ///
    /// Non-`Static` (i.e. keyframed) fields conservatively return
    /// `false` — keyframed fields shouldn't be queried for identity
    /// directly. Call `held_at` first.
    pub fn is_identity(&self) -> bool {
        if !self.enabled {
            return true;
        }
        const EPS: f64 = 1e-6;
        let near = |a: f64, b: f64| (a - b).abs() < EPS;
        let static_or = |anim: &Animated<f64>, target: f64| -> bool {
            match anim {
                Animated::Static(v) => near(*v, target),
                Animated::Keyframed(_) => false,
            }
        };
        match &self.params {
            EffectParams::Blur { radius } => static_or(radius, 0.0),
            EffectParams::ColorCorrect {
                brightness,
                contrast,
                saturation,
                gamma,
            } => {
                static_or(brightness, 1.0)
                    && static_or(contrast, 1.0)
                    && static_or(saturation, 1.0)
                    && static_or(gamma, 1.0)
            }
            EffectParams::ChromaKey {
                similarity,
                smoothness,
                ..
            } => static_or(similarity, 0.0) && static_or(smoothness, 0.0),
            EffectParams::Speed { factor, .. } => static_or(factor, 1.0),
            EffectParams::Vignette { amount } => static_or(amount, 0.0),
            EffectParams::HtmlTransform {
                x,
                y,
                scale_x,
                scale_y,
                rotation_deg,
                opacity,
            } => {
                static_or(x, 0.0)
                    && static_or(y, 0.0)
                    && static_or(scale_x, 1.0)
                    && static_or(scale_y, 1.0)
                    && static_or(rotation_deg, 0.0)
                    && static_or(opacity, 1.0)
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::animated::{Interpolation, Keyframe};
    use crate::state::color::Rgba;
    use crate::state::ids::new_id;
    use crate::state::time::TimeUs;

    fn kf(t_us: TimeUs, value: f64, interp: Interpolation) -> Keyframe<f64> {
        Keyframe { id: new_id(), t_us, value, interp }
    }

    fn blur_keyframed(kfs: Vec<Keyframe<f64>>) -> Effect {
        Effect {
            id: new_id(),
            enabled: true,
            params: EffectParams::Blur {
                radius: Animated::Keyframed(kfs.into_iter().collect()),
            },
        }
    }

    #[test]
    fn animating_runs_rebases_to_owner_t_start() {
        // Layer-local keyframes at 14s and 16s on a layer that starts
        // at owner_t_start = 10s should yield main-timeline run
        // [24s, 26s).
        let e = blur_keyframed(vec![
            kf(14_000_000, 0.0, Interpolation::Linear),
            kf(16_000_000, 8.0, Interpolation::Linear),
        ]);
        assert_eq!(
            e.animating_runs(10_000_000),
            vec![(24_000_000, 26_000_000)],
        );
    }

    #[test]
    fn disabled_effect_contributes_no_runs() {
        let mut e = blur_keyframed(vec![
            kf(0, 0.0, Interpolation::Linear),
            kf(5_000_000, 8.0, Interpolation::Linear),
        ]);
        e.enabled = false;
        assert!(e.animating_runs(0).is_empty());
        assert!(e.hold_step_times(0).is_empty());
    }

    #[test]
    fn hold_step_times_rebases() {
        let e = blur_keyframed(vec![
            kf(0, 0.0, Interpolation::Hold),
            kf(5_000_000, 8.0, Interpolation::Hold),
        ]);
        // Owner-local step at 5s; with owner_t_start = 10s, main-timeline 15s.
        assert_eq!(e.hold_step_times(10_000_000), vec![15_000_000]);
    }

    #[test]
    fn held_at_substitutes_keyframed_to_static_at_value() {
        let e = blur_keyframed(vec![
            kf(0, 0.0, Interpolation::Linear),
            kf(10_000_000, 10.0, Interpolation::Linear),
        ]);
        // At owner-local 5s, the linear interp gives 5.0.
        let held = e.held_at(5_000_000);
        match held.params {
            EffectParams::Blur { radius: Animated::Static(v) } => {
                assert!((v - 5.0).abs() < 1e-6);
            }
            _ => panic!("expected Static Blur after held_at"),
        }
    }

    #[test]
    fn held_at_clamps_outside_keyframe_range() {
        // Below first kf and above last kf clamp to boundary values.
        let e = blur_keyframed(vec![
            kf(5_000_000, 0.0, Interpolation::Linear),
            kf(10_000_000, 8.0, Interpolation::Linear),
        ]);
        let before = e.held_at(0);
        let after = e.held_at(20_000_000);
        let v_before = match before.params {
            EffectParams::Blur { radius: Animated::Static(v) } => v,
            _ => panic!(),
        };
        let v_after = match after.params {
            EffectParams::Blur { radius: Animated::Static(v) } => v,
            _ => panic!(),
        };
        assert!((v_before - 0.0).abs() < 1e-6);
        assert!((v_after - 8.0).abs() < 1e-6);
    }

    #[test]
    fn is_identity_static_blur_zero_radius() {
        let e = Effect {
            id: new_id(),
            enabled: true,
            params: EffectParams::Blur { radius: Animated::Static(0.0) },
        };
        assert!(e.is_identity());
    }

    #[test]
    fn is_identity_static_blur_nonzero_not_identity() {
        let e = Effect {
            id: new_id(),
            enabled: true,
            params: EffectParams::Blur { radius: Animated::Static(4.0) },
        };
        assert!(!e.is_identity());
    }

    #[test]
    fn is_identity_keyframed_is_false() {
        let e = blur_keyframed(vec![
            kf(0, 0.0, Interpolation::Linear),
            kf(5_000_000, 8.0, Interpolation::Linear),
        ]);
        // Direct is_identity on keyframed is conservatively false.
        assert!(!e.is_identity());
    }

    #[test]
    fn is_identity_disabled_is_true() {
        let mut e = Effect {
            id: new_id(),
            enabled: false,
            params: EffectParams::Blur { radius: Animated::Static(4.0) },
        };
        assert!(e.is_identity(), "disabled effect should read as identity");
        e.enabled = true;
        assert!(!e.is_identity());
    }

    #[test]
    fn is_identity_html_transform_all_defaults() {
        let e = Effect {
            id: new_id(),
            enabled: true,
            params: EffectParams::HtmlTransform {
                x: Animated::Static(0.0),
                y: Animated::Static(0.0),
                scale_x: Animated::Static(1.0),
                scale_y: Animated::Static(1.0),
                rotation_deg: Animated::Static(0.0),
                opacity: Animated::Static(1.0),
            },
        };
        assert!(e.is_identity());

        // Now perturb rotation.
        let e = Effect {
            id: new_id(),
            enabled: true,
            params: EffectParams::HtmlTransform {
                x: Animated::Static(0.0),
                y: Animated::Static(0.0),
                scale_x: Animated::Static(1.0),
                scale_y: Animated::Static(1.0),
                rotation_deg: Animated::Static(90.0),
                opacity: Animated::Static(1.0),
            },
        };
        assert!(!e.is_identity());
    }

    #[test]
    fn held_at_then_is_identity_on_non_identity_tail() {
        // Rotation [0:0deg, 5:90deg]: held at owner-local 6s (past last kf)
        // clamps to 90deg → non-identity.
        let e = Effect {
            id: new_id(),
            enabled: true,
            params: EffectParams::HtmlTransform {
                x: Animated::Static(0.0),
                y: Animated::Static(0.0),
                scale_x: Animated::Static(1.0),
                scale_y: Animated::Static(1.0),
                rotation_deg: Animated::Keyframed(
                    vec![
                        kf(0, 0.0, Interpolation::Linear),
                        kf(5_000_000, 90.0, Interpolation::Linear),
                    ]
                    .into_iter()
                    .collect(),
                ),
                opacity: Animated::Static(1.0),
            },
        };
        let held = e.held_at(6_000_000);
        assert!(!held.is_identity());
    }

    #[test]
    fn color_correct_held_at_substitutes_all_four_fields() {
        let e = Effect {
            id: new_id(),
            enabled: true,
            params: EffectParams::ColorCorrect {
                brightness: Animated::Static(1.2),
                contrast: Animated::Static(1.0),
                saturation: Animated::Static(1.0),
                gamma: Animated::Static(1.0),
            },
        };
        let held = e.held_at(0);
        match held.params {
            EffectParams::ColorCorrect { brightness: Animated::Static(b), .. } => {
                assert!((b - 1.2).abs() < 1e-6);
            }
            _ => panic!("expected ColorCorrect with Static brightness"),
        }
        assert!(!e.is_identity()); // brightness != 1
    }

    // Stub to silence unused-import warning if Rgba is unused above.
    #[allow(dead_code)]
    fn _rgba_keep_unused_import() -> Rgba {
        Rgba::BLACK
    }
}
