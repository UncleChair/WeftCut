//! The transcript-parser interface: one impl per raw output *style*, all
//! converging on [`Transcript`]. This is the deliberate split that keeps no
//! backend reimplementing SRT→words:
//!
//! - A [`Transcriber`](crate::speech::Transcriber) declares which styles it can
//!   emit ([`output_formats`](crate::speech::Transcriber::output_formats)) and,
//!   honoring the request's `want_word_timing` hint, returns one tagged
//!   [`RawTranscript`].
//! - Here, [`parse_raw`] dispatches that tag to the matching
//!   [`TranscriptParser`] — [`srt::SrtParser`], [`whisper_json::WhisperJsonParser`],
//!   or [`funasr_json::FunAsrParser`] (sherpa-onnx-offline / FunASR Paraformer).
//!
//! The tool layer only ever calls [`parse_raw`]; it never needs to know which
//! parser runs.

use super::error::SpeechError;
use super::transcript::Transcript;

pub mod funasr_json;
pub mod srt;
pub mod whisper_json;

/// A backend's raw output, tagged by style. Carries the payload; the style tag
/// alone (without a payload) is [`TranscriptFormat`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawTranscript {
    /// SubRip body — e.g. OpenAI Whisper `response_format=srt`, or whisper.cpp
    /// `-osrt`. Word timing is interpolated across cue spans.
    Srt(String),
    /// whisper.cpp `-ojf` (output-json-full) body — per-token `offsets` give
    /// exact word timing.
    WhisperJson(String),
    /// sherpa-onnx-offline (FunASR Paraformer) stdout body — a JSON object with
    /// `text` + per-token `timestamps` (seconds) → exact (char-level) word timing.
    FunAsrJson(String),
}

/// The style tag advertised by [`Transcriber::output_formats`]. Separate from
/// [`RawTranscript`] so a backend can declare *which* styles it can emit
/// without producing one.
///
/// [`Transcriber::output_formats`]: crate::speech::Transcriber::output_formats
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptFormat {
    Srt,
    WhisperJson,
    FunAsrJson,
}

impl RawTranscript {
    /// The style tag of this payload.
    pub fn format(&self) -> TranscriptFormat {
        match self {
            RawTranscript::Srt(_) => TranscriptFormat::Srt,
            RawTranscript::WhisperJson(_) => TranscriptFormat::WhisperJson,
            RawTranscript::FunAsrJson(_) => TranscriptFormat::FunAsrJson,
        }
    }
}

/// One parser per raw style. Stateless — `parse` takes the raw body as `&str`.
pub trait TranscriptParser {
    fn parse(&self, raw: &str) -> Result<Transcript, SpeechError>;
}

/// Dispatch a tagged [`RawTranscript`] to its style parser. The single
/// chokepoint the tool layer calls.
pub fn parse_raw(raw: RawTranscript) -> Result<Transcript, SpeechError> {
    match raw {
        RawTranscript::Srt(body) => srt::SrtParser.parse(&body),
        RawTranscript::WhisperJson(body) => whisper_json::WhisperJsonParser.parse(&body),
        RawTranscript::FunAsrJson(body) => funasr_json::FunAsrParser.parse(&body),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::transcript::WordTiming;

    /// A multi-word SRT and a whisper `-ojf` JSON must produce the SAME
    /// `Transcript` *structure* (segments with words, monotonic times) — only
    /// `word_timing` differs. This is the whole point of the normalization ADR.
    #[test]
    fn both_styles_yield_the_same_transcript_structure() {
        let srt = parse_raw(RawTranscript::Srt(
            "1\n00:00:00,000 --> 00:00:02,000\nHello world\n".into(),
        ))
        .expect("srt parses");
        let json = parse_raw(RawTranscript::WhisperJson(
            r#"{"result":{"language":"en"},"transcription":[
                {"offsets":{"from":0,"to":2000},"text":" Hello world","tokens":[
                    {"text":" Hello","offsets":{"from":0,"to":1000}},
                    {"text":" world","offsets":{"from":1000,"to":2000}}
                ]}
            ]}"#
            .into(),
        ))
        .expect("whisper json parses");

        // Same structure: one segment, two words each.
        assert_eq!(srt.segments.len(), 1);
        assert_eq!(json.segments.len(), 1);
        assert_eq!(srt.segments[0].words.len(), 2);
        assert_eq!(json.segments[0].words.len(), 2);
        assert_eq!(srt.segments[0].words[0].text, "Hello");
        assert_eq!(json.segments[0].words[0].text, "Hello");

        // Only the provenance differs.
        assert_eq!(srt.word_timing, WordTiming::InterpolatedFromCue);
        assert_eq!(json.word_timing, WordTiming::Exact);
    }

    /// `render_srt(parse(srt))` must round-trip cue timing + text through the
    /// SAME caption-import parser `apply_subtitles` uses — the bridge that keeps
    /// the caption flow working (ADR 0036 acceptance).
    #[test]
    fn render_srt_round_trips_through_caption_parser() {
        use crate::subtitles::{parse_subtitle_cues, SubFormat};
        let body = "1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n\
                    2\n00:00:03,000 --> 00:00:04,000\nBye now\n";
        let t = parse_raw(RawTranscript::Srt(body.into())).expect("parse");
        let rendered = t.render_srt();
        let (cues, _) =
            parse_subtitle_cues(&rendered, Some(SubFormat::Srt)).expect("re-parse rendered srt");
        assert_eq!(cues.len(), 2);
        assert_eq!((cues[0].start_us, cues[0].end_us), (1_000_000, 2_500_000));
        assert_eq!(cues[0].text, "Hello world");
        assert_eq!((cues[1].start_us, cues[1].end_us), (3_000_000, 4_000_000));
        assert_eq!(cues[1].text, "Bye now");
    }

    #[test]
    fn format_tag_matches_variant() {
        assert_eq!(RawTranscript::Srt(String::new()).format(), TranscriptFormat::Srt);
        assert_eq!(
            RawTranscript::WhisperJson(String::new()).format(),
            TranscriptFormat::WhisperJson,
        );
        assert_eq!(
            RawTranscript::FunAsrJson(String::new()).format(),
            TranscriptFormat::FunAsrJson,
        );
    }

    /// A FunASR (sherpa-onnx-offline) result routed through `parse_raw` yields
    /// the SAME `Transcript` structure as the SRT / whisper styles — segments
    /// with monotonic words — differing only in `word_timing` (`Exact`). This is
    /// the ticket-06 acceptance: identical shape, char-level provenance.
    #[test]
    fn funasr_style_yields_the_same_transcript_structure() {
        let t = parse_raw(RawTranscript::FunAsrJson(
            r#"{"text":"你好世界","timestamps":[0.00,0.40,0.80,1.20],
                "tokens":["你","好","世","界"]}"#
                .into(),
        ))
        .expect("funasr json parses");
        assert_eq!(t.segments.len(), 1);
        assert_eq!(t.segments[0].words.len(), 4);
        assert_eq!(t.segments[0].words[0].text, "你");
        assert_eq!(t.segments[0].words[0].t_start_us, 0);
        assert_eq!(t.segments[0].words[1].t_start_us, 400_000); // 0.40 s → µs
        assert_eq!(t.word_timing, WordTiming::Exact);
    }
}
