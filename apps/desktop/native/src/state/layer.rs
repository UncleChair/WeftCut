//! Layer envelope + kind-specific params.

// `Layer::duration_us` / `occupies` / `overlaps` are wire-contract helpers kept
// public with no caller in this crate; allow the lib-only dead-code noise.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::animated::Animated;
use super::audio_role::AudioRole;
use super::color::Rgba;
use super::effect::Effect;
use super::ids::{LayerId, MediaId};
use super::time::TimeUs;
use super::transform::{BlendMode, Rect, Transform};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Layer {
    pub id: LayerId,
    pub label: Option<String>,
    /// Inclusive start of the layer's display interval, in composition µs.
    /// Snapped to the comp-frame grid by the actor on every mutation.
    pub t_start_us: TimeUs,
    /// Exclusive end of the layer's display interval, in composition µs.
    /// The half-open interval is `[t_start_us, t_end_us)` — the layer is
    /// active at composition time `t` iff `t_start_us ≤ t < t_end_us`.
    ///
    /// This is a *boundary*, NOT a frame anchor. For a layer covering the
    /// entire 10 s 30 fps comp, `t_end_us = 10_000_000` (the boundary
    /// after frame 299, NOT frame 299's own start at 9_966_667). The
    /// playhead, which IS a frame anchor, can never reach `t_end_us`;
    /// see `apps/desktop/src/renderer/frames.ts::lastFrameAnchorUs` and
    /// `docs/data-model.md` for the distinction.
    pub t_end_us: TimeUs,
    pub enabled: bool,
    pub locked: bool,
    #[serde(default)]
    pub metadata: imbl::HashMap<String, Value>,
    pub params: LayerParams,
    #[serde(default)]
    pub effects: Vec<Effect>,
}

impl Layer {
    pub fn duration_us(&self) -> TimeUs {
        self.t_end_us - self.t_start_us
    }

    pub fn occupies(&self, t_us: TimeUs) -> bool {
        self.t_start_us <= t_us && t_us < self.t_end_us
    }

    pub fn overlaps(&self, other: &Layer) -> bool {
        self.t_start_us < other.t_end_us && other.t_start_us < self.t_end_us
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum LayerParams {
    VideoClip(VideoClipParams),
    ImageOverlay(ImageOverlayParams),
    Text(TextParams),
    Motif(MotifParams),
    Audio(AudioParams),
    Color(ColorParams),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VideoClipParams {
    pub media: MediaId,
    pub src_in_us: TimeUs,
    pub src_out_us: TimeUs,
    pub transform: Transform,
    pub opacity: Animated<f64>,
    pub crop: Option<Rect>,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    #[serde(default)]
    pub blend_mode: BlendMode,
    /// 1.0 default. `transcribe_clip` / `describe_clip` reject a layer whose
    /// speed differs from 1.0 rather than resampling the timings.
    pub speed: f64,
    /// Fade-from-black at the start of the clip. 0 = no fade.
    #[serde(default)]
    pub fade_in_us: u64,
    /// Fade-to-black at the end of the clip. Same semantics as `fade_in_us`.
    #[serde(default)]
    pub fade_out_us: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImageOverlayParams {
    pub media: MediaId,
    pub transform: Transform,
    pub opacity: Animated<f64>,
    #[serde(default)]
    pub blend_mode: BlendMode,
    /// Optional fade-in / fade-out wrapping the image overlay. Mirrors
    /// `VideoClipParams::fade_in_us` semantics.
    #[serde(default)]
    pub fade_in_us: u64,
    #[serde(default)]
    pub fade_out_us: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextParams {
    pub content: String,
    pub font: FontSpec,
    pub color: Animated<Rgba>,
    pub align: TextAlign,
    pub transform: Transform,
    pub opacity: Animated<f64>,
    pub shadow: Option<Shadow>,
    pub outline: Option<Outline>,
    pub intro: Option<TextAnimPreset>,
    pub outro: Option<TextAnimPreset>,
    /// Layout box in composition px, LOCAL (before `scale`). Which fields are
    /// set IS the resize mode — no mode enum to contradict them: `(None, None)`
    /// auto width, `(Some, None)` auto height (wraps), `(Some, Some)` fixed
    /// (wraps and shrinks to fit). See ADR 0049.
    ///
    /// Deliberately NOT `Animated`: a keyframed box would move the shrink
    /// factor every frame and rebuild the glyph atlas with it. `scale` is the
    /// animation channel for a text layer's size.
    #[serde(default)]
    pub box_w: Option<f32>,
    #[serde(default)]
    pub box_h: Option<f32>,
    /// Where the text block sits INSIDE the box. Orthogonal to
    /// `transform.anchor_y`, which places the box against `x`/`y`.
    #[serde(default)]
    pub valign: VAlign,
    /// Line leading; `0` = auto (the font's own metrics).
    #[serde(default)]
    pub line_height: f32,
    #[serde(default)]
    pub letter_spacing: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FontSpec {
    pub family: String,
    pub size_px: f32,
    #[serde(default)]
    pub weight: u16,
    #[serde(default)]
    pub italic: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TextAlign {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum VAlign {
    Top,
    #[default]
    Middle,
    Bottom,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shadow {
    pub color: Rgba,
    pub offset_x: f32,
    pub offset_y: f32,
    pub blur: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outline {
    pub color: Rgba,
    pub width: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextAnimPreset {
    FadeIn,
    FadeOut,
    SlideUp,
    SlideDown,
    Typewriter,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MotifParams {
    pub motif_id: String,
    pub motif_version: u32,
    /// Validated against the motif manifest's `props_schema` at apply time.
    pub props: imbl::HashMap<String, Value>,
    /// Window offset (µs) into the motif's intrinsic content. The window
    /// width equals the layer width (`t_end_us - t_start_us`); `src_out` is
    /// derived, never stored. Content duration is the resolved cap
    /// (`resolve_motif_max_dur_us`). `0` = window starts at content frame 0.
    /// Legacy projects (no field) deserialize to `0`.
    #[serde(default)]
    pub src_in_us: TimeUs,
    pub transform: Transform,
    pub opacity: Animated<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioParams {
    pub media: MediaId,
    pub src_in_us: TimeUs,
    pub src_out_us: TimeUs,
    pub gain_db: Animated<f64>,
    /// -1.0 left .. 1.0 right.
    pub pan: Animated<f64>,
    #[serde(default)]
    pub fade_in_us: u64,
    #[serde(default)]
    pub fade_out_us: u64,
    #[serde(default)]
    pub mute: bool,
    /// Mixing role (`docs/audio.md`). Legacy `.vproj` audio layers (no
    /// field) deserialize to `Dialogue`. The mixer groups by this, not by
    /// track.
    #[serde(default)]
    pub role: AudioRole,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ColorParams {
    pub color: Animated<Rgba>,
    pub width: u32,
    pub height: u32,
}

/// Apply `f` to every `Animated<f64>` track on these params (transform x/y/
/// scale_x/scale_y/rotation_deg + opacity for visual kinds; gain_db/pan for
/// Audio). The Rust mirror of the frontend `animatableParams(kind)` descriptor.
/// Used by trim/split keyframe transforms. Color has no f64 track.
pub(crate) fn for_each_animated_f64(
    params: &mut LayerParams,
    mut f: impl FnMut(&mut Animated<f64>),
) {
    match params {
        LayerParams::VideoClip(p) => {
            visit_transform_f64(&mut p.transform, &mut f);
            f(&mut p.opacity);
        }
        LayerParams::ImageOverlay(p) => {
            visit_transform_f64(&mut p.transform, &mut f);
            f(&mut p.opacity);
        }
        LayerParams::Text(p) => {
            visit_transform_f64(&mut p.transform, &mut f);
            f(&mut p.opacity);
        }
        LayerParams::Motif(p) => {
            visit_transform_f64(&mut p.transform, &mut f);
            f(&mut p.opacity);
        }
        LayerParams::Audio(p) => {
            f(&mut p.gain_db);
            f(&mut p.pan);
        }
        LayerParams::Color(_) => {}
    }
}

fn visit_transform_f64(t: &mut Transform, f: &mut impl FnMut(&mut Animated<f64>)) {
    f(&mut t.x);
    f(&mut t.y);
    f(&mut t.scale_x);
    f(&mut t.scale_y);
    f(&mut t.rotation_deg);
    // The anchor pair belongs in this walk, not just in the resolvers: trim and
    // split rebase keyframe TIMES through here, so omitting it would strand an
    // animated pivot at the pre-trim times while every other track moved.
    f(&mut t.anchor_x);
    f(&mut t.anchor_y);
}

/// Apply `f` to every `Animated<Rgba>` track on these params (Text color,
/// Color color). Separate from the f64 walk because the inner type differs.
/// Trim and split must carry color keyframes through the same rebase.
pub(crate) fn for_each_animated_rgba(
    params: &mut LayerParams,
    mut f: impl FnMut(&mut Animated<Rgba>),
) {
    match params {
        LayerParams::Text(p) => f(&mut p.color),
        LayerParams::Color(p) => f(&mut p.color),
        // Exhaustive (no wildcard) so a future kind with an Animated<Rgba>
        // field forces a compile error here rather than being silently skipped
        // — same discipline as the f64 walk above.
        LayerParams::VideoClip(_)
        | LayerParams::ImageOverlay(_)
        | LayerParams::Motif(_)
        | LayerParams::Audio(_) => {}
    }
}

/// Immutable sibling of `resolve_animated_f64_mut` — read a param's
/// `Animated<f64>` for the MCP keyframe read path. Same key vocabulary.
pub(crate) fn resolve_animated_f64<'a>(
    params: &'a LayerParams,
    key: &str,
) -> Option<&'a Animated<f64>> {
    match params {
        LayerParams::VideoClip(p) => transform_or_opacity_ref(&p.transform, &p.opacity, key),
        LayerParams::ImageOverlay(p) => transform_or_opacity_ref(&p.transform, &p.opacity, key),
        LayerParams::Text(p) => transform_or_opacity_ref(&p.transform, &p.opacity, key),
        LayerParams::Motif(p) => transform_or_opacity_ref(&p.transform, &p.opacity, key),
        LayerParams::Audio(p) => match key {
            "gain_db" => Some(&p.gain_db),
            "pan" => Some(&p.pan),
            _ => None,
        },
        LayerParams::Color(_) => None,
    }
}

fn transform_or_opacity_ref<'a>(
    t: &'a Transform,
    opacity: &'a Animated<f64>,
    key: &str,
) -> Option<&'a Animated<f64>> {
    match key {
        "x" => Some(&t.x),
        "y" => Some(&t.y),
        "scale_x" => Some(&t.scale_x),
        "scale_y" => Some(&t.scale_y),
        "rotation_deg" => Some(&t.rotation_deg),
        "anchor_x" => Some(&t.anchor_x),
        "anchor_y" => Some(&t.anchor_y),
        "opacity" => Some(opacity),
        _ => None,
    }
}

/// Resolve a `param_key` string to its `Animated<f64>` field for writing.
/// `None` for an unknown key or a key not valid on this kind.
pub(crate) fn resolve_animated_f64_mut<'a>(
    params: &'a mut LayerParams,
    key: &str,
) -> Option<&'a mut Animated<f64>> {
    match params {
        LayerParams::VideoClip(p) => transform_or_opacity(&mut p.transform, &mut p.opacity, key),
        LayerParams::ImageOverlay(p) => transform_or_opacity(&mut p.transform, &mut p.opacity, key),
        LayerParams::Text(p) => transform_or_opacity(&mut p.transform, &mut p.opacity, key),
        LayerParams::Motif(p) => transform_or_opacity(&mut p.transform, &mut p.opacity, key),
        LayerParams::Audio(p) => match key {
            "gain_db" => Some(&mut p.gain_db),
            "pan" => Some(&mut p.pan),
            _ => None,
        },
        LayerParams::Color(_) => None,
    }
}

fn transform_or_opacity<'a>(
    t: &'a mut Transform,
    opacity: &'a mut Animated<f64>,
    key: &str,
) -> Option<&'a mut Animated<f64>> {
    match key {
        "x" => Some(&mut t.x),
        "y" => Some(&mut t.y),
        "scale_x" => Some(&mut t.scale_x),
        "scale_y" => Some(&mut t.scale_y),
        "rotation_deg" => Some(&mut t.rotation_deg),
        "anchor_x" => Some(&mut t.anchor_x),
        "anchor_y" => Some(&mut t.anchor_y),
        "opacity" => Some(opacity),
        _ => None,
    }
}

/// Parse `effects[<uuid>].params[<key>]` → (effect_id, param_key). None if the
/// key isn't an effect-param path.
pub(crate) fn parse_effect_param_key(key: &str) -> Option<(crate::state::ids::EffectId, String)> {
    let rest = key.strip_prefix("effects[")?;
    let (id_str, rest) = rest.split_once("].params[")?;
    let param = rest.strip_suffix(']')?;
    let id = id_str.parse().ok()?;
    Some((id, param.to_string()))
}

/// Layer-level read resolver: effect-param paths look in `layer.effects`,
/// everything else delegates to the params-level resolver. Same key vocabulary
/// plus `effects[<id>].params[<key>]`.
pub(crate) fn resolve_animated_f64_on_layer<'a>(
    layer: &'a Layer,
    key: &str,
) -> Option<&'a Animated<f64>> {
    if let Some((effect_id, param)) = parse_effect_param_key(key) {
        return layer
            .effects
            .iter()
            .find(|e| e.id == effect_id)?
            .params
            .get(&param);
    }
    resolve_animated_f64(&layer.params, key)
}

/// Layer-level write resolver (mutable sibling of `resolve_animated_f64_on_layer`).
pub(crate) fn resolve_animated_f64_mut_on_layer<'a>(
    layer: &'a mut Layer,
    key: &str,
) -> Option<&'a mut Animated<f64>> {
    if let Some((effect_id, param)) = parse_effect_param_key(key) {
        return layer
            .effects
            .iter_mut()
            .find(|e| e.id == effect_id)?
            .params
            .get_mut(&param);
    }
    resolve_animated_f64_mut(&mut layer.params, key)
}

#[cfg(test)]
mod kf_fields_tests {
    use super::*;
    use crate::state::animated::Animated;

    fn videoclip() -> LayerParams {
        LayerParams::VideoClip(VideoClipParams {
            media: crate::state::ids::new_id(),
            src_in_us: 0,
            src_out_us: 1_000_000,
            transform: Transform::default(),
            opacity: Animated::Static(1.0),
            crop: None,
            flip_h: false,
            flip_v: false,
            blend_mode: BlendMode::default(),
            speed: 1.0,
            fade_in_us: 0,
            fade_out_us: 0,
        })
    }

    #[test]
    fn resolve_known_f64_keys_for_videoclip() {
        let mut p = videoclip();
        for key in [
            "x",
            "y",
            "scale_x",
            "scale_y",
            "rotation_deg",
            "anchor_x",
            "anchor_y",
            "opacity",
        ] {
            assert!(
                resolve_animated_f64_mut(&mut p, key).is_some(),
                "videoclip should resolve {key}"
            );
        }
        assert!(resolve_animated_f64_mut(&mut p, "gain_db").is_none());
        assert!(resolve_animated_f64_mut(&mut p, "bogus").is_none());
    }

    #[test]
    fn for_each_animated_f64_visits_every_videoclip_field() {
        let mut p = videoclip();
        let mut n = 0;
        for_each_animated_f64(&mut p, |_| n += 1);
        // transform x/y/scale_x/scale_y/rotation_deg/anchor_x/anchor_y (7)
        // + opacity (1) = 8.
        assert_eq!(n, 8);
    }

    #[test]
    fn resolve_writes_through_to_the_field() {
        let mut p = videoclip();
        if let Some(track) = resolve_animated_f64_mut(&mut p, "opacity") {
            *track = Animated::Static(0.25);
        }
        let LayerParams::VideoClip(v) = &p else {
            panic!()
        };
        assert!(matches!(v.opacity, Animated::Static(x) if (x - 0.25).abs() < 1e-9));
    }

    fn audioclip() -> LayerParams {
        LayerParams::Audio(AudioParams {
            media: crate::state::ids::new_id(),
            src_in_us: 0,
            src_out_us: 1_000_000,
            gain_db: Animated::Static(0.0),
            pan: Animated::Static(0.0),
            fade_in_us: 0,
            fade_out_us: 0,
            mute: false,
            role: AudioRole::Dialogue,
        })
    }

    #[test]
    fn immutable_resolver_matches_mut_keys() {
        let p = videoclip();
        for key in [
            "x",
            "y",
            "scale_x",
            "scale_y",
            "rotation_deg",
            "anchor_x",
            "anchor_y",
            "opacity",
        ] {
            assert!(
                resolve_animated_f64(&p, key).is_some(),
                "videoclip ref should resolve {key}"
            );
        }
        assert!(resolve_animated_f64(&p, "gain_db").is_none());
        assert!(resolve_animated_f64(&p, "bogus").is_none());
    }

    #[test]
    fn resolve_and_walk_for_audio() {
        let mut p = audioclip();
        // Audio resolves only gain_db/pan (its own match arm, independent of
        // transform_or_opacity); transform keys + opacity are None.
        assert!(resolve_animated_f64_mut(&mut p, "gain_db").is_some());
        assert!(resolve_animated_f64_mut(&mut p, "pan").is_some());
        assert!(resolve_animated_f64_mut(&mut p, "opacity").is_none());
        assert!(resolve_animated_f64_mut(&mut p, "x").is_none());
        // The walk visits exactly gain_db + pan.
        let mut n = 0;
        for_each_animated_f64(&mut p, |_| n += 1);
        assert_eq!(n, 2);
    }
}
