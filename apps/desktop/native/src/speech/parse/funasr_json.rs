//! sherpa-onnx-offline (FunASR Paraformer) JSON → [`Transcript`], with exact
//! per-token (Mandarin: per-character) timing.
//!
//! ## Wire contract with the sherpa-onnx-offline sidecar
//!
//! `sherpa-onnx-offline` prints ONE JSON object **to stdout** per input WAV (the
//! wav filename and progress/RTF logs go to stderr), so the sidecar captures
//! stdout verbatim and hands it here untouched — no unit conversion in the
//! backend. This path is NOT runnable in CI, so the schema below is pinned by
//! assumption + a committed sample test, exactly as `whisper_json.rs` pins
//! whisper.cpp's.
//!
//! The object is `OfflineRecognitionResult::AsJsonString`. We read only the
//! three fields we need (`text`, `timestamps`, `tokens`) plus the optional
//! `durations`, and ignore the rest (`lang` is read best-effort; `emotion`,
//! `event`, `ys_log_probs`, `words`, `segment_*` are ignored):
//!
//! ```json
//! { "text": "对我做了介绍",
//!   "timestamps": [0.00, 0.32, 0.64, 0.96, 1.20, 1.52],   // SECONDS
//!   "tokens": ["对", "我", "做", "了", "介", "绍"] }
//! ```
//!
//! - `timestamps[i]` is the START time of `tokens[i]`, in **seconds** (sherpa
//!   prints them `std::fixed` at 2 decimals). We multiply by 1_000_000 to reach
//!   the microseconds the rest of the pipeline uses.
//! - `tokens` align 1:1 with `timestamps`; for Paraformer-zh each token is a
//!   single Chinese character, so words come out char-granular. `Word` is
//!   granularity-agnostic, so this is the SAME `Transcript` shape as
//!   whisper/cloud — only `word_timing` differs (`Exact` here).
//! - sherpa reports no explicit token END, so each word ends where the next word
//!   starts; the final word ends at its own start (zero-width) — honest, since
//!   the engine does not report the last token's duration. If the optional
//!   `durations` array is present and long enough, we use `start + duration`
//!   instead (a truer end when the model emits it).
//! - sherpa-onnx-offline returns ONE result per WAV (no VAD segmentation without
//!   the separate VAD model, deferred in v1), so the transcript is a SINGLE
//!   segment spanning all tokens. `word_timing = Exact`.

use serde::Deserialize;

use super::TranscriptParser;
use crate::speech::error::SpeechError;
use crate::speech::transcript::{Segment, Transcript, Word, WordTiming};

pub struct FunAsrParser;

impl TranscriptParser for FunAsrParser {
    fn parse(&self, raw: &str) -> Result<Transcript, SpeechError> {
        let result: FunAsrResult = serde_json::from_str(raw.trim())
            .map_err(|e| SpeechError::Parse(format!("sherpa-onnx-offline JSON: {e}")))?;

        let words = build_words(&result.tokens, &result.timestamps, &result.durations);
        let text = result.text.trim().to_string();

        // One result per WAV → a single segment spanning all tokens. A silent
        // clip (no tokens, empty text) yields no segments rather than an empty
        // one.
        let segments = if words.is_empty() && text.is_empty() {
            Vec::new()
        } else {
            let t_start_us = words.first().map(|w| w.t_start_us).unwrap_or(0);
            let t_end_us = words.last().map(|w| w.t_end_us).unwrap_or(t_start_us);
            vec![Segment {
                t_start_us,
                t_end_us,
                text,
                words,
            }]
        };

        Ok(Transcript {
            segments,
            language: result.lang.filter(|l| !l.is_empty() && l != "auto"),
            word_timing: WordTiming::Exact,
        })
    }
}

/// Zip sherpa's parallel `tokens` / `timestamps` (and optional `durations`) into
/// words. `timestamps[i]` is token i's START (seconds → µs). End time: prefer
/// `durations[i]` when the array is long enough, else the next token's start;
/// the last token, lacking a successor, ends at its own start (zero-width) —
/// sherpa reports no final duration. Empty/whitespace tokens are skipped (they
/// don't occur for Paraformer-zh, but keep a stray blank out of the words).
fn build_words(tokens: &[String], timestamps: &[f64], durations: &[f64]) -> Vec<Word> {
    let n = tokens.len().min(timestamps.len());
    let use_durations = durations.len() >= n;
    let mut words = Vec::with_capacity(n);
    for i in 0..n {
        let piece = tokens[i].trim();
        if piece.is_empty() {
            continue;
        }
        let t_start_us = secs_to_us(timestamps[i]);
        let t_end_us = if use_durations {
            secs_to_us(timestamps[i] + durations[i])
        } else if i + 1 < n {
            // Next token's start is this token's end — monotonic, non-overlapping.
            secs_to_us(timestamps[i + 1])
        } else {
            t_start_us
        };
        words.push(Word {
            t_start_us,
            t_end_us: t_end_us.max(t_start_us),
            text: piece.to_string(),
        });
    }
    words
}

fn secs_to_us(secs: f64) -> i64 {
    (secs * 1_000_000.0).round() as i64
}

// ── sherpa-onnx-offline result deserialization (tolerant: unknown fields
//    ignored, missing fields default) ──────────────────────────────────────
#[derive(Deserialize)]
struct FunAsrResult {
    #[serde(default)]
    text: String,
    /// Per-token START times, in SECONDS.
    #[serde(default)]
    timestamps: Vec<f64>,
    /// Optional per-token durations, in SECONDS. Absent for many models; used
    /// only when it aligns with `timestamps`.
    #[serde(default)]
    durations: Vec<f64>,
    #[serde(default)]
    tokens: Vec<String>,
    /// Present for language-aware models (e.g. SenseVoice); empty for
    /// Paraformer-zh.
    #[serde(default)]
    lang: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // A committed sherpa-onnx-offline Paraformer-zh sample: full `text`, a
    // per-character `timestamps` array (seconds), and the matching `tokens`.
    // Extra fields (`lang`, `emotion`, `event`, `words`) are present to prove
    // they're ignored tolerantly.
    const SAMPLE: &str = r#"{
        "lang": "",
        "emotion": "",
        "event": "",
        "text": "对我做了介绍",
        "timestamps": [0.00, 0.32, 0.64, 0.96, 1.20, 1.52],
        "tokens": ["对", "我", "做", "了", "介", "绍"],
        "words": []
    }"#;

    #[test]
    fn parses_char_level_exact_words_secs_to_us() {
        let t = FunAsrParser.parse(SAMPLE).expect("parse");
        assert_eq!(t.word_timing, WordTiming::Exact);
        assert_eq!(t.language, None, "empty lang → None");
        assert_eq!(t.segments.len(), 1, "one result per wav → one segment");
        let seg = &t.segments[0];
        assert_eq!(seg.text, "对我做了介绍");
        // Six characters, six words — char-granular, granularity-agnostic Word.
        assert_eq!(seg.words.len(), 6);
        assert_eq!(seg.words[0].text, "对");
        assert_eq!(seg.words[0].t_start_us, 0);
        assert_eq!(seg.words[0].t_end_us, 320_000); // ends where "我" starts
        assert_eq!(seg.words[1].text, "我");
        assert_eq!(seg.words[1].t_start_us, 320_000); // 0.32 s → µs
        // Last token has no successor → zero-width end at its own start.
        assert_eq!(seg.words[5].text, "绍");
        assert_eq!(seg.words[5].t_start_us, 1_520_000);
        assert_eq!(seg.words[5].t_end_us, 1_520_000);
        // Segment spans first word start .. last word end.
        assert_eq!(seg.t_start_us, 0);
        assert_eq!(seg.t_end_us, 1_520_000);
    }

    #[test]
    fn optional_durations_give_true_word_ends() {
        let json = r#"{
            "text": "你好",
            "timestamps": [0.10, 0.50],
            "durations": [0.30, 0.40],
            "tokens": ["你", "好"]
        }"#;
        let t = FunAsrParser.parse(json).expect("parse");
        let w = &t.segments[0].words;
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].t_start_us, 100_000);
        assert_eq!(w[0].t_end_us, 400_000); // 0.10 + 0.30 = 0.40 s
        assert_eq!(w[1].t_start_us, 500_000);
        assert_eq!(w[1].t_end_us, 900_000); // 0.50 + 0.40 = 0.90 s (not zero-width)
    }

    #[test]
    fn language_tag_is_carried_when_present() {
        let json =
            r#"{"lang":"zh","text":"好","timestamps":[0.0],"tokens":["好"]}"#;
        let t = FunAsrParser.parse(json).expect("parse");
        assert_eq!(t.language.as_deref(), Some("zh"));
    }

    #[test]
    fn silent_clip_yields_no_segments() {
        let json = r#"{"text":"","timestamps":[],"tokens":[]}"#;
        let t = FunAsrParser.parse(json).expect("parse");
        assert!(t.segments.is_empty());
        assert_eq!(t.word_timing, WordTiming::Exact);
    }

    #[test]
    fn invalid_json_is_a_parse_error() {
        let err = FunAsrParser.parse("{not json").expect_err("should fail");
        assert!(matches!(err, SpeechError::Parse(_)));
    }
}
