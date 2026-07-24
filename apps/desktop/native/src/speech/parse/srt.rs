//! SRT → [`Transcript`]. Reuses the caption-import SRT parser
//! ([`subtitles::parse_subtitle_cues`]) — there is exactly ONE SRT parser in
//! the tree; a second one would be a twin-drift hazard (ADR 0036). From those
//! cues we derive word timing by distributing each cue's `[t_start, t_end]`
//! span across its words, weighting by word length.
//!
//! That distribution is approximate by construction, so
//! [`WordTiming::InterpolatedFromCue`]. The one exception: an SRT that is
//! genuinely one word per cue needs no distribution — each word's span already
//! IS its cue span — so it reports [`WordTiming::Exact`].
//!
//! [`subtitles::parse_subtitle_cues`]: crate::subtitles::parse_subtitle_cues

use super::TranscriptParser;
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

/// Distribute `[start_us, end_us]` across the whitespace-separated words of
/// `text`, weighting each word by its UTF-8 *character* count so longer words
/// get proportionally more of the span. Boundaries are contiguous and
/// monotonic (word `i` ends exactly where word `i+1` starts); the last word
/// ends exactly at `end_us` so accumulated rounding never drifts past the cue.
/// An empty (all-whitespace) cue yields no words; a single-word cue takes the
/// whole span.
fn split_cue_into_words(start_us: i64, end_us: i64, text: &str) -> Vec<Word> {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    if tokens.is_empty() {
        return Vec::new();
    }
    if tokens.len() == 1 {
        return vec![Word {
            t_start_us: start_us,
            t_end_us: end_us,
            text: tokens[0].to_string(),
        }];
    }

    let span = (end_us - start_us).max(0);
    // `.max(1)` guards a zero-length token (can't happen after split_whitespace,
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
}
