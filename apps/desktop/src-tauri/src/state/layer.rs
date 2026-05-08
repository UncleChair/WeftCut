//! Layer envelope + kind-specific params.

// `Layer::duration_us` / `occupies` / `overlaps` are public helpers used by
// validation and future agent-side queries; allow lib-only dead-code noise.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::animated::Animated;
use super::color::Rgba;
use super::effect::Effect;
use super::ids::{LayerId, MediaId};
use super::time::TimeUs;
use super::transform::{BlendMode, Rect, Transform};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Layer {
    pub id: LayerId,
    pub label: Option<String>,
    pub t_start_us: TimeUs,
    /// Exclusive.
    pub t_end_us: TimeUs,
    pub enabled: bool,
    pub locked: bool,
    #[serde(default)]
    pub metadata: imbl::HashMap<String, Value>,
    #[serde(default)]
    pub effects: imbl::Vector<Effect>,
    pub params: LayerParams,
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
    Template(TemplateParams),
    Audio(AudioParams),
    Subtitles(SubtitlesParams),
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
    /// 1.0 default. Warns at apply time if != 1 with attached audio.
    pub speed: f64,
    /// Fade-from-black at the start of the clip. 0 = no fade. Lowering uses the
    /// `fade` filter (single-input, simpler than `xfade` which needs two
    /// streams). Capped at the clip duration at lowering time.
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
    #[serde(default)]
    pub backend_hint: TextBackend,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TextBackend {
    /// Compiler picks DrawText for simple styles, Rasterized for animated/styled.
    #[default]
    Auto,
    DrawText,
    Rasterized,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TemplateParams {
    pub template_id: String,
    pub template_version: u32,
    /// Validated against the template manifest's `props_schema` at apply time.
    pub props: imbl::HashMap<String, Value>,
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SubtitlesParams {
    pub source: SubtitlesSource,
}

/// Source of subtitle text for a `SubtitlesParams` layer.
///
/// Inline variants carry the body in-state so projects round-trip cleanly
/// through `.vproj` and so MCP tools (auto-caption, agent-authored cues)
/// don't need to invent file paths. ffmpeg's `subtitles=` filter only
/// accepts a path — the IR pipeline runs `ir::materialize_inline_subtitles`
/// before `lower()` to turn each inline body into a content-addressed file
/// in the OS app cache. Persistence stays inline.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value")]
pub enum SubtitlesSource {
    /// Reference an imported `MediaItem` of `MediaKind::Subtitle`.
    Media(MediaId),
    /// Inline ASS document — what auto-caption returns.
    InlineAss(String),
    /// Inline SRT document.
    InlineSrt(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ColorParams {
    pub color: Animated<Rgba>,
    pub width: u32,
    pub height: u32,
}
