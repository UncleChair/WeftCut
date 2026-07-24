//! SRT → [`Transcript`]. Reuses the caption-import SRT parser
//! ([`subtitles::parse_subtitle_cues`]) — there is exactly ONE SRT parser in
//! the tree; a second one would be a twin-drift hazard (ADR 0036). From those
//! cues we derive word timing by distributing each cue's `[t_start, t_end]`
//! span across its words, weighting by word length. Words are
//! whitespace-delimited, EXCEPT space-less CJK text (Han, kana), where each
//! character is its own word — matching FunASR's per-character granularity and
//! keeping a Chinese cue from collapsing into one sentence-sized "word".
//!
//! That distribution is approximate by construction, so
//! [`WordTiming::InterpolatedFromCue`]. The one exception: an SRT that is
//! genuinely one word per cue needs no distribution — each word's span already
//! IS its cue span — so it reports [`WordTiming::Exact`].
//!
//! [`subtitles::parse_subtitle_cues`]: crate::subtitles::parse_subtitle_cues

use super::{is_cjk_char, TranscriptParser};
use crate::speech::error::SpeechError;
use crate::speech::transcript::{Segment, Transcript, Word, WordTiming};
use crate::subtitles::{parse_subtitle_cues, SubFormat};

pub struct SrtParser;

impl TranscriptParser for SrtParser {
    fn parse(&self, raw: &str) -> Result<Transcript, SpeechError> {
        let (cues, _simplified) =
            parse_subtitle_cues(raw, Some(SubFormat::Srt)).map_err(SpeechError::Parse)?;

        let mut segments = Vec::with_capacity(cues.len());
        let mut all_single_word = true;
        for cue in cues {
            let words = split_cue_into_words(cue.start_us, cue.end_us, &cue.text);
            if words.len() != 1 {
                all_single_word = false;
            }
            segments.push(Segment {
                t_start_us: cue.start_us,
                t_end_us: cue.end_us,
                text: cue.text,
                words,
            });
        }

        let word_timing = if segments.is_empty() {
            WordTiming::None
        } else if all_single_word {
            WordTiming::Exact
        } else {
            WordTiming::InterpolatedFromCue
        };

        Ok(Transcript {
            segments,
            language: None, // SRT carries no language tag
            word_timing,
        })
    }
}

/// Split cue text into word tokens: whitespace-delimited first, then each
/// space-less CJK character ([`is_cjk_char`]) becomes its own token — Chinese
/// and Japanese SRT carries no spaces, so without this a whole cue collapses
/// into one "word" (and, being "single-word", used to spuriously promote the
/// transcript to `Exact`). Non-CJK runs (Latin, digits, punctuation) stay
/// glued; a punctuation-only fragment merges into the token before it so
/// `词。` never yields a lone `。` word.
fn split_word_tokens(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for ws_tok in text.split_whitespace() {
        let run_start = tokens.len();
        let mut cur = String::new();
        for c in ws_tok.chars() {
            if is_cjk_char(c) {
                if !cur.is_empty() {
                    push_or_merge(&mut tokens, run_start, std::mem::take(&mut cur));
                }
                tokens.push(c.to_string());
            } else {
                cur.push(c);
            }
        }
        if !cur.is_empty() {
            push_or_merge(&mut tokens, run_start, cur);
        }
    }
    tokens
}

/// Append `frag` as its own token, or — when it contains nothing letter-like
/// (pure punctuation, e.g. the `。` trailing a Han run) and a token from the
/// same whitespace run precedes it — glue it onto that token.
fn push_or_merge(tokens: &mut Vec<String>, run_start: usize, frag: String) {
    let punct_only = !frag.chars().any(char::is_alphanumeric);
    if punct_only && tokens.len() > run_start {
        tokens.last_mut().expect("len > run_start").push_str(&frag);
    } else {
        tokens.push(frag);
    }
}

/// Distribute `[start_us, end_us]` across the word tokens of `text`
/// ([`split_word_tokens`]: whitespace-split, then per-character for space-less
/// CJK), weighting each word by its UTF-8 *character* count so longer words
/// get proportionally more of the span. Boundaries are contiguous and
/// monotonic (word `i` ends exactly where word `i+1` starts); the last word
/// ends exactly at `end_us` so accumulated rounding never drifts past the cue.
/// An empty (all-whitespace) cue yields no words; a single-word cue takes the
/// whole span.
fn split_cue_into_words(start_us: i64, end_us: i64, text: &str) -> Vec<Word> {
    let tokens = split_word_tokens(text);
    if tokens.is_empty() {
        return Vec::new();
    }
    if tokens.len() == 1 {
        return vec![Word {
            t_start_us: start_us,
            t_end_us: end_us,
            text: tokens.into_iter().next().expect("len == 1"),
        }];
    }

    let span = (end_us - start_us).max(0);
    // `.max(1)` guards a zero-length token (split_word_tokens never emits one,
    // but keeps `total` non-zero regardless). i128 for the multiply so a long
    // cue × long text can never overflow before the divide brings it back down.
    let weights: Vec<i64> = tokens
        .iter()
        .map(|t| t.chars().count().max(1) as i64)
        .collect();
    let total: i64 = weights.iter().sum();

    let mut words = Vec::with_capacity(tokens.len());
    let mut cum: i64 = 0;
    for (i, tok) in tokens.iter().enumerate() {
        let w_start = start_us + ((span as i128 * cum as i128) / total as i128) as i64;
        cum += weights[i];
        let w_end = if i + 1 == tokens.len() {
            end_us
        } else {
            start_us + ((span as i128 * cum as i128) / total as i128) as i64
        };
        words.push(Word {
            t_start_us: w_start,
            t_end_us: w_end,
            text: (*tok).to_string(),
        });
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_word_cue_interpolates_monotonic_word_times() {
        let t = SrtParser
            .parse("1\n00:00:00,000 --> 00:00:04,000\nthe quick brown fox\n")
            .expect("parse");
        assert_eq!(t.word_timing, WordTiming::InterpolatedFromCue);
        assert_eq!(t.segments.len(), 1);
        let words = &t.segments[0].words;
        assert_eq!(words.len(), 4);
        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            ["the", "quick", "brown", "fox"],
        );
        // First word starts at cue start, last ends at cue end.
        assert_eq!(words[0].t_start_us, 0);
        assert_eq!(words[3].t_end_us, 4_000_000);
        // Contiguous + monotonic non-decreasing.
        for pair in words.windows(2) {
            assert_eq!(pair[0].t_end_us, pair[1].t_start_us, "contiguous");
            assert!(pair[1].t_start_us >= pair[0].t_start_us, "monotonic");
        }
        // Longer words get a wider span: "quick"/"brown" (5 chars) > "the"/"fox" (3).
        let dur = |w: &Word| w.t_end_us - w.t_start_us;
        assert!(dur(&words[1]) > dur(&words[0]));
    }

    #[test]
    fn one_word_per_cue_is_exact_not_interpolated() {
        let t = SrtParser
            .parse(
                "1\n00:00:00,000 --> 00:00:01,000\nHello\n\n\
                 2\n00:00:01,000 --> 00:00:02,000\nworld\n",
            )
            .expect("parse");
        assert_eq!(t.word_timing, WordTiming::Exact);
        assert_eq!(t.segments.len(), 2);
        assert_eq!(t.segments[0].words[0].t_start_us, 0);
        assert_eq!(t.segments[0].words[0].t_end_us, 1_000_000);
    }

    #[test]
    fn segment_text_preserves_the_full_cue() {
        let t = SrtParser
            .parse("1\n00:00:00,000 --> 00:00:02,000\nHello world\n")
            .expect("parse");
        assert_eq!(t.segments[0].text, "Hello world");
    }

    #[test]
    fn malformed_srt_is_a_parse_error() {
        let err = SrtParser.parse("not a subtitle at all").expect_err("should fail");
        assert!(matches!(err, SpeechError::Parse(_)));
    }

    /// Space-less Chinese cue → per-character words, honestly marked
    /// interpolated. Regression guard: before the CJK tokenizer, the whole cue
    /// was one "word" AND the single-word-per-cue heuristic then mislabeled the
    /// transcript `Exact` on the mainline zh cloud path.
    #[test]
    fn cjk_cue_splits_per_character_and_is_interpolated() {
        let t = SrtParser
            .parse("1\n00:00:00,000 --> 00:00:03,000\n对我做了介绍\n")
            .expect("parse");
        assert_eq!(t.word_timing, WordTiming::InterpolatedFromCue);
        let words = &t.segments[0].words;
        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            ["对", "我", "做", "了", "介", "绍"],
        );
        // Contiguous span partition: starts at cue start, ends at cue end.
        assert_eq!(words[0].t_start_us, 0);
        assert_eq!(words[5].t_end_us, 3_000_000);
        for pair in words.windows(2) {
            assert_eq!(pair[0].t_end_us, pair[1].t_start_us);
        }
    }

    /// Mixed Latin + Han: whitespace still bounds Latin words; the Han run
    /// splits per character; trailing CJK punctuation glues onto the character
    /// before it instead of becoming its own word.
    #[test]
    fn mixed_latin_cjk_tokenizes_both_ways_and_merges_punctuation() {
        let t = SrtParser
            .parse("1\n00:00:00,000 --> 00:00:02,000\nGPU 加速了。\n")
            .expect("parse");
        let words = &t.segments[0].words;
        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            ["GPU", "加", "速", "了。"],
        );
        assert_eq!(t.word_timing, WordTiming::InterpolatedFromCue);
    }
}
