//! The description-parser interface: one impl per raw output *style*, all
//! converging on `Vec<DescSegment>`. Twin of [`speech::parse`](crate::speech).
//!
//! Both models return a JSON array of `{t_start, t_end, text, tags[]}` with
//! timestamps chosen verbatim from the frame times we injected (ticket 06 spike:
//! 14/14, 18/18, 20/20 spans map onto anchors), so parsing is **format
//! conversion, not semantic alignment**. The parser must encode two spike
//! landmines:
//!
//! - **Truncation tolerance.** At low temperature the model can degenerate into
//!   repeating the last segment until `-n`, cutting off the closing `]`. The
//!   extractor salvages objects up to the last complete `}` and closes the array
//!   itself (mirrors `spike.mjs:extractJsonArray`).
//! - **MiniCPM-V tag shape.** MiniCPM-V mashes `tags` into underscore-joined
//!   phrases (`"lower_body_feet_step_..."`) and emits a trailing empty segment.
//!   [`MiniCpmVParser`] splits those into discrete keywords; the shared
//!   empty-segment drop handles the trailing blank for every backend.
//!
//! Timestamps here are seconds → **window-relative µs** (0 = window start); the
//! tool shifts them onto source-absolute time (see [`super::description`]).

use serde_json::Value;

use super::description::DescSegment;
use super::error::VlmError;

/// A backend's raw output, tagged by style. Carries the payload; the style tag
/// decides which parser [`parse_raw`] dispatches to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawDescription {
    /// A plain JSON-array body — Qwen3-VL, and the BYO-endpoint / cloud backends
    /// (which we prompt identically). Tags arrive as discrete keywords.
    JsonArray(String),
    /// MiniCPM-V body — same JSON array, but `tags` are underscore-joined
    /// phrases and a trailing empty segment appears; needs the splitting parser.
    MiniCpmVText(String),
}

/// One parser per raw style. Stateless — `parse` takes the raw body as `&str`
/// and yields window-relative segments.
pub trait DescriptionParser {
    fn parse(&self, raw: &str) -> Result<Vec<DescSegment>, VlmError>;
}

/// General JSON-array parser (Qwen3-VL / BYO / cloud): tags used verbatim.
pub struct JsonArrayParser;
impl DescriptionParser for JsonArrayParser {
    fn parse(&self, raw: &str) -> Result<Vec<DescSegment>, VlmError> {
        parse_segments(raw, false)
    }
}

/// MiniCPM-V parser: splits underscore-joined `tags` into discrete keywords.
pub struct MiniCpmVParser;
impl DescriptionParser for MiniCpmVParser {
    fn parse(&self, raw: &str) -> Result<Vec<DescSegment>, VlmError> {
        parse_segments(raw, true)
    }
}

/// Dispatch a tagged [`RawDescription`] to its style parser — the single
/// chokepoint the tool layer calls.
pub fn parse_raw(raw: RawDescription) -> Result<Vec<DescSegment>, VlmError> {
    match raw {
        RawDescription::JsonArray(body) => JsonArrayParser.parse(&body),
        RawDescription::MiniCpmVText(body) => MiniCpmVParser.parse(&body),
    }
}

/// Shared parse: extract the (possibly truncated) JSON array, coerce each
/// element to a window-relative [`DescSegment`], dropping empty ones. When
/// `split_underscore_tags` is set (MiniCPM-V), break underscore/whitespace-joined
/// tag phrases into discrete keywords.
fn parse_segments(raw: &str, split_underscore_tags: bool) -> Result<Vec<DescSegment>, VlmError> {
    let arr = extract_json_array(raw).ok_or_else(|| {
        VlmError::Parse(format!(
            "no JSON array found in model output ({} bytes)",
            raw.len()
        ))
    })?;

    let mut segments = Vec::with_capacity(arr.len());
    for el in &arr {
        let obj = match el.as_object() {
            Some(o) => o,
            None => continue,
        };
        let text = obj
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        // Drop empty segments (MiniCPM-V's trailing blank, and any stray element
        // with no description) — a span with no text is useless to the agent.
        if text.is_empty() {
            continue;
        }
        let t_start_s = coerce_secs(obj.get("t_start")).unwrap_or(0.0);
        let t_end_s = coerce_secs(obj.get("t_end")).unwrap_or(t_start_s);
        let t_start_us = secs_to_us(t_start_s);
        let t_end_us = secs_to_us(t_end_s).max(t_start_us);
        let tags = coerce_tags(obj.get("tags"), split_underscore_tags);
        segments.push(DescSegment {
            t_start_us,
            t_end_us,
            text,
            tags,
        });
    }
    Ok(segments)
}

/// Find and parse the JSON array in the model's output. Mirrors
/// `spike.mjs:extractJsonArray`: try `[` .. last `]`; on failure salvage a
/// truncated array by closing after the last complete `}`. Prompt echo before
/// the `[` is skipped naturally (there is no `--no-display-prompt` in this
/// llama.cpp build, so the prompt may be echoed).
fn extract_json_array(text: &str) -> Option<Vec<Value>> {
    let start = text.find('[')?;
    if let Some(end) = text.rfind(']') {
        if end > start {
            if let Ok(Value::Array(v)) = serde_json::from_str::<Value>(&text[start..=end]) {
                return Some(v);
            }
        }
    }
    // Salvage a truncated array (repetition loop cut off by -n): parse objects
    // up to the last complete '}' and close the array ourselves.
    let last_obj = text.rfind('}')?;
    if last_obj > start {
        let candidate = format!("{}]", &text[start..=last_obj]);
        if let Ok(Value::Array(v)) = serde_json::from_str::<Value>(&candidate) {
            return Some(v);
        }
    }
    None
}

/// Coerce a JSON value to seconds: a number, or a numeric string (optionally
/// suffixed `s` — some models write `"3.8s"`).
fn coerce_secs(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches('s').trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn secs_to_us(secs: f64) -> i64 {
    if !secs.is_finite() || secs < 0.0 {
        return 0;
    }
    (secs * 1_000_000.0).round() as i64
}

/// Coerce the `tags` value to a keyword list. Accepts an array of strings or a
/// single string. When `split` is set (MiniCPM-V), split each entry on
/// underscores and whitespace into discrete keywords; otherwise trim verbatim.
/// Blank pieces are dropped.
fn coerce_tags(v: Option<&Value>, split: bool) -> Vec<String> {
    let raw: Vec<String> = match v {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    };
    let mut out = Vec::new();
    for t in raw {
        if split {
            for piece in t.split(|c: char| c == '_' || c.is_whitespace()) {
                let p = piece.trim();
                if !p.is_empty() {
                    out.push(p.to_string());
                }
            }
        } else {
            let p = t.trim();
            if !p.is_empty() {
                out.push(p.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A well-formed Qwen3-VL array: timestamps map straight to window-relative
    /// µs, tags used verbatim.
    #[test]
    fn json_array_parses_verbatim_timestamps_and_tags() {
        let raw = r#"Here is the timeline:
        [
          {"t_start": 0.0, "t_end": 2.5, "text": "A person walks in", "tags": ["person", "walking", "wide shot"]},
          {"t_start": 2.5, "t_end": 5.0, "text": "Close-up of a face", "tags": ["face", "close-up"]}
        ]"#;
        let segs = parse_raw(RawDescription::JsonArray(raw.into())).expect("parse");
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].t_start_us, 0);
        assert_eq!(segs[0].t_end_us, 2_500_000); // 2.5 s → µs, verbatim
        assert_eq!(segs[0].tags, vec!["person", "walking", "wide shot"]);
        assert_eq!(segs[1].t_start_us, 2_500_000);
        assert_eq!(segs[1].text, "Close-up of a face");
    }

    /// Truncation tolerance: a repetition loop cut off by -n leaves a dangling
    /// array (no closing `]`, a half-written final object). The salvage path
    /// recovers every complete object up to the last `}`.
    #[test]
    fn salvages_truncated_array_missing_closing_bracket() {
        let raw = r#"[
          {"t_start": 0.0, "t_end": 3.8, "text": "Skyline at dusk", "tags": ["skyline", "dusk"]},
          {"t_start": 3.8, "t_end": 7.6, "text": "Traffic below", "tags": ["traffic"]},
          {"t_start": 7.6, "t_end": 11.4, "text": "Traffic below", "tags": ["traf"#;
        let segs = parse_raw(RawDescription::JsonArray(raw.into())).expect("salvage");
        // Two complete objects recovered; the half-written third is dropped.
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "Skyline at dusk");
        assert_eq!(segs[1].t_end_us, 7_600_000);
    }

    /// MiniCPM-V: underscore-joined tag phrases split into discrete keywords,
    /// and its trailing empty segment is dropped.
    #[test]
    fn minicpm_splits_underscore_tags_and_drops_empty_trailing_segment() {
        let raw = r#"[
          {"t_start": 0.0, "t_end": 4.0, "text": "A dancer steps along marked lines",
           "tags": ["lower_body_feet_step_marked_lines", "full_body_shot"]},
          {"t_start": 4.0, "t_end": 4.0, "text": "", "tags": []}
        ]"#;
        let segs = parse_raw(RawDescription::MiniCpmVText(raw.into())).expect("parse");
        // The trailing empty-text segment is dropped.
        assert_eq!(segs.len(), 1);
        assert_eq!(
            segs[0].tags,
            vec!["lower", "body", "feet", "step", "marked", "lines", "full", "body", "shot"],
        );
    }

    /// The SAME MiniCPM-shaped body through the general (Qwen) parser keeps the
    /// tags un-split — proving the split is backend-specific, not global.
    #[test]
    fn general_parser_does_not_split_underscore_tags() {
        let raw = r#"[{"t_start":0,"t_end":1,"text":"x","tags":["a_b_c"]}]"#;
        let segs = parse_raw(RawDescription::JsonArray(raw.into())).expect("parse");
        assert_eq!(segs[0].tags, vec!["a_b_c"]);
    }

    #[test]
    fn no_array_is_a_parse_error() {
        let err = parse_raw(RawDescription::JsonArray("the model refused".into()))
            .expect_err("no array");
        assert!(matches!(err, VlmError::Parse(_)));
    }

    #[test]
    fn coerces_numeric_string_timestamps_with_s_suffix() {
        let raw = r#"[{"t_start":"1.5s","t_end":"3s","text":"y","tags":"solo_tag"}]"#;
        let segs = parse_raw(RawDescription::JsonArray(raw.into())).expect("parse");
        assert_eq!(segs[0].t_start_us, 1_500_000);
        assert_eq!(segs[0].t_end_us, 3_000_000);
        // A single-string tag is accepted (kept verbatim by the general parser).
        assert_eq!(segs[0].tags, vec!["solo_tag"]);
    }
}
