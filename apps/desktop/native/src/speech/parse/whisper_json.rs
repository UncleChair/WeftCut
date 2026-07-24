//! whisper.cpp `-ojf` (output-json-full) → [`Transcript`], with exact
//! per-word timing.
//!
//! ## Wire contract with the whisper.cpp sidecar (ticket 04)
//!
//! This parser reads whisper.cpp's **native** full-JSON schema verbatim — the
//! sidecar must pass `-ojf` and hand us the resulting `.json` untouched (no unit
//! conversion). The schema:
//!
//! ```json
//! { "result": { "language": "en" },
//!   "transcription": [
//!     { "offsets": { "from": 0, "to": 2000 },     // MILLISECONDS
//!       "text": " Hello world",
//!       "tokens": [
//!         { "text": " Hello", "offsets": { "from": 0,    "to": 1000 } },
//!         { "text": " world", "offsets": { "from": 1000, "to": 2000 } }
//!       ] } ] }
//! ```
//!
//! `offsets.from`/`offsets.to` are **milliseconds** (whisper.cpp's JSON unit),
//! NOT the centisecond `t0`/`t1` of the C API — we multiply by 1000 to reach
//! microseconds. Token `text` uses a leading space to mark a word boundary
//! (SentencePiece convention); we group sub-word tokens back into words on that
//! signal. `word_timing = Exact`.

use serde::Deserialize;

use super::TranscriptParser;
use crate::speech::error::SpeechError;
use crate::speech::transcript::{Segment, Transcript, Word, WordTiming};

pub struct WhisperJsonParser;

impl TranscriptParser for WhisperJsonParser {
    fn parse(&self, raw: &str) -> Result<Transcript, SpeechError> {
        let full: WhisperFull = serde_json::from_str(raw)
            .map_err(|e| SpeechError::Parse(format!("whisper -ojf JSON: {e}")))?;

        let mut segments = Vec::with_capacity(full.transcription.len());
        for seg in &full.transcription {
            let seg_text = seg.text.trim().to_string();
            let mut words = group_tokens_into_words(&seg.tokens);
            // Fallback: some whisper builds omit the token array (segment-only
            // JSON). Keep a usable word by spanning the whole segment rather
            // than emitting a wordless segment.
            if words.is_empty() && !seg_text.is_empty() {
                words.push(Word {
                    t_start_us: ms_to_us(seg.offsets.from),
                    t_end_us: ms_to_us(seg.offsets.to),
                    text: seg_text.clone(),
                });
            }
            segments.push(Segment {
                t_start_us: ms_to_us(seg.offsets.from),
                t_end_us: ms_to_us(seg.offsets.to),
                text: seg_text,
                words,
            });
        }

        Ok(Transcript {
            segments,
            language: full
                .result
                .language
                .filter(|l| !l.is_empty() && l != "auto"),
            word_timing: WordTiming::Exact,
        })
    }
}

/// Group whisper's sub-word tokens back into words. A token whose raw `text`
/// begins with a space opens a new word (SentencePiece word-boundary marker);
/// tokens without a leading space are continuations (sub-word pieces or
/// attached punctuation) appended to the current word, extending its end time.
/// whisper's internal special tokens (`[_BEG_]`, `[_TT_123]`, `[_EOT_]`, …) are
/// skipped.
fn group_tokens_into_words(tokens: &[WhisperToken]) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    for tok in tokens {
        if tok.text.trim_start().starts_with("[_") {
            continue; // whisper internal marker, not transcript content
        }
        let opens_word = tok.text.starts_with(' ') || tok.text.starts_with('\n');
        let piece = tok.text.trim();
        if piece.is_empty() {
            continue;
        }
        let t0 = ms_to_us(tok.offsets.from);
        let t1 = ms_to_us(tok.offsets.to);
        if opens_word || words.is_empty() {
            words.push(Word {
                t_start_us: t0,
                t_end_us: t1,
                text: piece.to_string(),
            });
        } else {
            let last = words.last_mut().expect("non-empty checked above");
            last.text.push_str(piece);
            last.t_end_us = t1.max(last.t_end_us);
        }
    }
    words
}

fn ms_to_us(ms: i64) -> i64 {
    ms.saturating_mul(1000)
}

// ── whisper.cpp `-ojf` deserialization (tolerant: unknown fields ignored,
//    missing fields default) ────────────────────────────────────────────────

#[derive(Deserialize)]
struct WhisperFull {
    #[serde(default)]
    result: WhisperResult,
    #[serde(default)]
    transcription: Vec<WhisperSegment>,
}

#[derive(Deserialize, Default)]
struct WhisperResult {
    #[serde(default)]
    language: Option<String>,
}

#[derive(Deserialize)]
struct WhisperSegment {
    #[serde(default)]
    offsets: Offsets,
    #[serde(default)]
    text: String,
    #[serde(default)]
    tokens: Vec<WhisperToken>,
}

#[derive(Deserialize)]
struct WhisperToken {
    #[serde(default)]
    text: String,
    #[serde(default)]
    offsets: Offsets,
}

/// whisper.cpp emits `offsets` in **milliseconds**.
#[derive(Deserialize, Default, Clone, Copy)]
struct Offsets {
    #[serde(default)]
    from: i64,
    #[serde(default)]
    to: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "result": { "language": "en" },
        "transcription": [
            {
                "offsets": { "from": 0, "to": 2000 },
                "text": " Hello world.",
                "tokens": [
                    { "text": "[_BEG_]", "offsets": { "from": 0, "to": 0 } },
                    { "text": " Hello",  "offsets": { "from": 0, "to": 900 } },
                    { "text": " world",  "offsets": { "from": 900, "to": 1900 } },
                    { "text": ".",       "offsets": { "from": 1900, "to": 2000 } }
                ]
            }
        ]
    }"#;

    #[test]
    fn parses_exact_word_times_ms_to_us() {
        let t = WhisperJsonParser.parse(SAMPLE).expect("parse");
        assert_eq!(t.word_timing, WordTiming::Exact);
        assert_eq!(t.language.as_deref(), Some("en"));
        assert_eq!(t.segments.len(), 1);
        let words = &t.segments[0].words;
        // Two words: "Hello" and "world." (trailing punct token merged in).
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Hello");
        assert_eq!(words[0].t_start_us, 0);
        assert_eq!(words[0].t_end_us, 900_000); // 900 ms → µs
        assert_eq!(words[1].text, "world.");
        assert_eq!(words[1].t_start_us, 900_000);
        assert_eq!(words[1].t_end_us, 2_000_000); // extended by the "." token
    }

    #[test]
    fn skips_internal_marker_tokens() {
        let t = WhisperJsonParser.parse(SAMPLE).expect("parse");
        // The [_BEG_] marker must not become a word.
        assert!(t.segments[0].words.iter().all(|w| !w.text.contains("[_")));
    }

    #[test]
    fn segment_without_tokens_falls_back_to_one_word() {
        let json = r#"{"transcription":[{"offsets":{"from":500,"to":1500},"text":"solo"}]}"#;
        let t = WhisperJsonParser.parse(json).expect("parse");
        assert_eq!(t.segments[0].words.len(), 1);
        assert_eq!(t.segments[0].words[0].text, "solo");
        assert_eq!(t.segments[0].words[0].t_start_us, 500_000);
        assert_eq!(t.segments[0].words[0].t_end_us, 1_500_000);
    }

    #[test]
    fn invalid_json_is_a_parse_error() {
        let err = WhisperJsonParser.parse("{not json").expect_err("should fail");
        assert!(matches!(err, SpeechError::Parse(_)));
    }
}
