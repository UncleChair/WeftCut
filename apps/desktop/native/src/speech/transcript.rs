//! The normalized transcript shape every speech backend converges on.
//!
//! Backends emit different *styles* (SRT, whisper JSON, FunASR JSON); a
//! per-style [`parse`](super::parse) turns each into this one structure so
//! consumers (the `transcribe_clip` tool, the scene/content-analysis
//! word-transcript resource) see a single shape regardless of engine. The only
//! thing that differs across backends is [`WordTiming`] — the provenance of the
//! per-word timestamps — and it is inspectable.
//!
//! Timestamps are microseconds. As produced by a parser they are
//! **audio-slice-relative** (0 = first sample of the extracted window); the
//! tool layer calls [`Transcript::shift`] to place them on the timeline before
//! returning to the agent. [`Transcript::render_srt`] is the bridge back to the
//! `apply_subtitles` caption flow (SRT is cue-granular, so word spans are not
//! represented there — by design; they live in the JSON `segments`).

use serde::Serialize;

/// Provenance of the per-word timestamps in a [`Transcript`]. Downstream
/// text-editing reads this to know whether a word boundary is frame-trustworthy
/// (`Exact`, straight from an engine's token offsets) or approximate
/// (`InterpolatedFromCue`, derived by splitting a cue span across its words).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WordTiming {
    /// Word times come straight from the engine's per-token offsets.
    Exact,
    /// Word times were derived by distributing a cue span across its words by
    /// length — approximate, not sample-accurate.
    InterpolatedFromCue,
    /// No word-level timing available (segment granularity only).
    None,
}

/// One word with its own `[t_start_us, t_end_us]` span.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Word {
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub text: String,
}

/// One transcript segment — an SRT cue, or a whisper `transcription[]` entry:
/// a timed span of text plus its constituent [`Word`]s.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Segment {
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub text: String,
    pub words: Vec<Word>,
}

/// The single normalized shape produced by every backend after parsing.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Transcript {
    pub segments: Vec<Segment>,
    pub language: Option<String>,
    pub word_timing: WordTiming,
}

impl Transcript {
    /// Shift every segment and word timestamp forward by `offset_us` (the
    /// slice's timeline-absolute start), clamping at zero so a negative result
    /// never underflows. Shifts the parsed struct; a caller that needs a cue
    /// body re-renders it via [`render_srt`].
    ///
    /// [`render_srt`]: Transcript::render_srt
    pub fn shift(&mut self, offset_us: i64) {
        for seg in &mut self.segments {
            seg.t_start_us = shift_us(seg.t_start_us, offset_us);
            seg.t_end_us = shift_us(seg.t_end_us, offset_us);
            for w in &mut seg.words {
                w.t_start_us = shift_us(w.t_start_us, offset_us);
                w.t_end_us = shift_us(w.t_end_us, offset_us);
            }
        }
    }

    /// Render the segments back to an SRT body (cue granularity — index /
    /// `HH:MM:SS,mmm --> HH:MM:SS,mmm` / text / blank line). This is what
    /// `transcribe_clip` returns in the envelope's `srt` field so the existing
    /// `apply_subtitles` flow keeps working. Cue indices are renumbered from 1;
    /// per-word times are intentionally not emitted (SRT can't represent them).
    pub fn render_srt(&self) -> String {
        let mut out = String::new();
        for (i, seg) in self.segments.iter().enumerate() {
            out.push_str(&(i + 1).to_string());
            out.push('\n');
            out.push_str(&format_srt_timestamp(seg.t_start_us));
            out.push_str(" --> ");
            out.push_str(&format_srt_timestamp(seg.t_end_us));
            out.push('\n');
            out.push_str(&seg.text);
            out.push('\n');
            out.push('\n');
        }
        out
    }
}

fn shift_us(base_us: i64, offset_us: i64) -> i64 {
    base_us.saturating_add(offset_us).max(0)
}

/// `HH:MM:SS,mmm` — the SRT cue-timestamp format.
fn format_srt_timestamp(us: i64) -> String {
    let us = us.max(0);
    let total_ms = us / 1000;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(a: i64, b: i64, t: &str) -> Word {
        Word {
            t_start_us: a,
            t_end_us: b,
            text: t.to_string(),
        }
    }

    fn sample() -> Transcript {
        Transcript {
            segments: vec![
                Segment {
                    t_start_us: 1_000_000,
                    t_end_us: 2_500_000,
                    text: "Hello world".into(),
                    words: vec![word(1_000_000, 1_750_000, "Hello"), word(1_750_000, 2_500_000, "world")],
                },
                Segment {
                    t_start_us: 3_000_000,
                    t_end_us: 4_000_000,
                    text: "Bye".into(),
                    words: vec![word(3_000_000, 4_000_000, "Bye")],
                },
            ],
            language: Some("en".into()),
            word_timing: WordTiming::InterpolatedFromCue,
        }
    }

    #[test]
    fn shift_moves_segments_and_words_together() {
        let mut t = sample();
        t.shift(500_000);
        assert_eq!(t.segments[0].t_start_us, 1_500_000);
        assert_eq!(t.segments[0].t_end_us, 3_000_000);
        assert_eq!(t.segments[0].words[0].t_start_us, 1_500_000);
        assert_eq!(t.segments[0].words[1].t_end_us, 3_000_000);
        assert_eq!(t.segments[1].words[0].t_start_us, 3_500_000);
    }

    #[test]
    fn shift_clamps_at_zero() {
        let mut t = sample();
        t.shift(-5_000_000);
        for seg in &t.segments {
            assert!(seg.t_start_us >= 0 && seg.t_end_us >= 0);
            for w in &seg.words {
                assert!(w.t_start_us >= 0 && w.t_end_us >= 0);
            }
        }
    }

    #[test]
    fn render_srt_emits_renumbered_cues() {
        let t = sample();
        let srt = t.render_srt();
        assert!(srt.starts_with("1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n"));
        assert!(srt.contains("2\n00:00:03,000 --> 00:00:04,000\nBye\n\n"));
    }

    #[test]
    fn word_timing_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&WordTiming::InterpolatedFromCue).unwrap(),
            "\"interpolated_from_cue\"",
        );
        assert_eq!(serde_json::to_string(&WordTiming::Exact).unwrap(), "\"exact\"");
        assert_eq!(serde_json::to_string(&WordTiming::None).unwrap(), "\"none\"");
    }
}
