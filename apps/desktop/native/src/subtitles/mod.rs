// The single chokepoint that turns imported subtitle text (SRT/VTT/ASS) into
// Cues. File import, the MCP apply_subtitles tool, and the transcribe workflow
// all flow through `parse`. Cues are then laid out into Text layers by `layout`.
use crate::state::color::Rgba;
use serde::Serialize;

pub mod ass;
pub mod layout;
pub mod srt;
pub mod vtt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubFormat { Srt, Vtt, Ass }

impl SubFormat {
    /// Parse a format tag string ("srt", "ass", "vtt", case-insensitive).
    /// Mirrors the tag-matching in `tools.rs apply_subtitles`. Returns Err for
    /// unknown tags; None input → use `sniff`.
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "srt" => Ok(SubFormat::Srt),
            "ass" => Ok(SubFormat::Ass),
            "vtt" => Ok(SubFormat::Vtt),
            other => Err(format!("unknown subtitle format '{other}' — expected 'srt', 'ass', or 'vtt'")),
        }
    }
}

/// One subtitle cue. `text` preserves explicit line breaks as '\n'.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Cue {
    pub start_us: i64,
    pub end_us: i64,
    pub text: String,
    pub style: CueStyle,
}

/// Per-cue style hints extracted from ASS (all None for SRT/VTT → default
/// caption style applies in `layout`). `align` is the ASS 9-grid (`\an` 1..9);
/// `pos` is an absolute `\pos(x,y)` override.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CueStyle {
    pub font_family: Option<String>,
    pub size_px: Option<f32>,
    pub primary: Option<Rgba>,
    pub bold: bool,
    pub italic: bool,
    pub outline_px: Option<f32>,
    pub outline_color: Option<Rgba>,
    pub shadow_px: Option<f32>,
    pub align: Option<u8>,
    pub pos: Option<(f64, f64)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedSubtitles {
    pub cues: Vec<Cue>,
    pub simplified: bool,
}

/// Sniff format from a body when the caller doesn't know it.
pub fn sniff(body: &str) -> SubFormat {
    let t = body.trim_start_matches('\u{feff}').trim_start();
    if t.starts_with("WEBVTT") { SubFormat::Vtt }
    else if t.starts_with('[') { SubFormat::Ass }
    else { SubFormat::Srt }
}

pub fn parse(body: &str, format: SubFormat) -> ParsedSubtitles {
    match format {
        SubFormat::Srt => ParsedSubtitles { cues: srt::parse(body), simplified: false },
        SubFormat::Vtt => ParsedSubtitles { cues: vtt::parse(body), simplified: false },
        SubFormat::Ass => ass::parse(body),
    }
}
