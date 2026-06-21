// The single chokepoint that turns imported subtitle text (SRT/VTT/ASS) into
// Cues. File import, the MCP apply_subtitles tool, and the transcribe workflow
// all flow through `parse`. Cues are then laid out into Text layers by `layout`.
use crate::state::color::Rgba;

pub mod srt;
pub mod vtt;
// pub mod ass;    — wired in Task 3.4
// pub mod layout; — wired in Task 3.5

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubFormat { Srt, Vtt, Ass }

/// One subtitle cue. `text` preserves explicit line breaks as '\n'.
#[derive(Clone, Debug, PartialEq)]
pub struct Cue {
    pub start_us: i64,
    pub end_us: i64,
    pub text: String,
    pub style: CueStyle,
}

/// Per-cue style hints extracted from ASS (all None for SRT/VTT → default
/// caption style applies in `layout`). `align` is the ASS 9-grid (`\an` 1..9);
/// `pos` is an absolute `\pos(x,y)` override.
#[derive(Clone, Debug, Default, PartialEq)]
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
        SubFormat::Ass => unimplemented!("wired in Task 3.4"),
    }
}
