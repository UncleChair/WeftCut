//! SRT cue-timestamp shift. Whisper returns SRT cues with timestamps
//! relative to the start of the audio slice it received; the `transcribe_clip`
//! MCP tool shifts them by the slice's timeline-absolute start so the body
//! pipes straight into `apply_subtitles` without further math on the agent
//! side.
//!
//! Parsing is line-oriented and tolerant: we only touch cue header lines
//! (matching `HH:MM:SS,mmm --> HH:MM:SS,mmm`); everything else passes through
//! verbatim. This is deliberate — `,` vs `.` decimal, blank lines, the
//! optional cue index, and trailing text styling all behave identically to
//! how the original body did.

/// Shift every SRT cue timestamp in `body` forward by `offset_us` microseconds.
/// Returns a new String. Lines that don't parse as cue headers pass through
/// unchanged so the cue text, indices, and blank separators are preserved
/// bit-for-bit.
pub fn shift_srt(body: &str, offset_us: i64) -> String {
    let mut out = String::with_capacity(body.len() + 16);
    for line in body.split_inclusive('\n') {
        // split_inclusive keeps the trailing '\n'; the last line may or may
        // not have one. Either way `line` is what we operate on.
        let (content, eol) = match line.strip_suffix('\n') {
            Some(without) => (without, "\n"),
            None => (line, ""),
        };
        let (content_trimmed_cr, cr) = match content.strip_suffix('\r') {
            Some(without) => (without, "\r"),
            None => (content, ""),
        };
        if let Some(shifted) = try_shift_cue_line(content_trimmed_cr, offset_us) {
            out.push_str(&shifted);
            out.push_str(cr);
            out.push_str(eol);
        } else {
            // Pass-through. `split_inclusive` over `'\n'` plus this branch
            // preserves CRLF / LF exactly as input.
            out.push_str(line);
        }
    }
    out
}

/// Try to parse `line` as `HH:MM:SS,mmm --> HH:MM:SS,mmm [extra...]`. If it
/// matches, returns the re-emitted line with both timestamps shifted. The
/// `[extra...]` tail (line-position overrides like `X1:0 X2:0 Y1:0 Y2:0`)
/// is preserved.
fn try_shift_cue_line(line: &str, offset_us: i64) -> Option<String> {
    let (lhs, rest) = line.split_once("-->")?;
    let lhs = lhs.trim();
    let (rhs, tail) = match rest.trim_start().split_once(' ') {
        Some((rhs, tail)) => (rhs.trim(), format!(" {tail}")),
        None => (rest.trim(), String::new()),
    };
    let a = parse_srt_timestamp(lhs)?;
    let b = parse_srt_timestamp(rhs)?;
    let a_shifted = shift_us(a, offset_us);
    let b_shifted = shift_us(b, offset_us);
    Some(format!(
        "{} --> {}{}",
        format_srt_timestamp(a_shifted),
        format_srt_timestamp(b_shifted),
        tail,
    ))
}

fn shift_us(base_us: i64, offset_us: i64) -> i64 {
    let v = base_us.saturating_add(offset_us);
    if v < 0 {
        0
    } else {
        v
    }
}

fn parse_srt_timestamp(s: &str) -> Option<i64> {
    // `HH:MM:SS,mmm`. Accept `.` as fallback decimal separator since some
    // implementations emit it that way, even though Whisper uses `,`.
    let (hms, ms) = s.split_once(',').or_else(|| s.split_once('.'))?;
    let mut parts = hms.split(':');
    let h: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let sec: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let ms: i64 = ms.parse().ok()?;
    if !(0..1000).contains(&ms) || !(0..60).contains(&sec) || !(0..60).contains(&m) || h < 0 {
        return None;
    }
    Some(((h * 3600 + m * 60 + sec) * 1000 + ms) * 1000)
}

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

    #[test]
    fn shift_zero_is_identity() {
        let body = "1\n00:00:01,000 --> 00:00:02,500\nHello\n\n";
        assert_eq!(shift_srt(body, 0), body);
    }

    #[test]
    fn shift_one_second_advances_cues() {
        let input = "1\n00:00:01,000 --> 00:00:02,500\nHello\n";
        let want = "1\n00:00:02,000 --> 00:00:03,500\nHello\n";
        assert_eq!(shift_srt(input, 1_000_000), want);
    }

    #[test]
    fn shift_subsecond_offset_works() {
        let input = "1\n00:00:01,000 --> 00:00:02,500\nHi\n";
        let want = "1\n00:00:01,250 --> 00:00:02,750\nHi\n";
        assert_eq!(shift_srt(input, 250_000), want);
    }

    #[test]
    fn shift_crosses_minute_and_hour_boundaries() {
        let input = "1\n00:59:59,500 --> 01:00:00,500\nrollover\n";
        let want = "1\n01:00:00,500 --> 01:00:01,500\nrollover\n";
        assert_eq!(shift_srt(input, 1_000_000), want);
    }

    #[test]
    fn shift_preserves_cue_text_and_blank_lines() {
        let input = "1\n00:00:01,000 --> 00:00:02,000\nfirst\n\n2\n00:00:03,000 --> 00:00:04,000\nsecond line\n";
        let got = shift_srt(input, 500_000);
        assert!(got.contains("00:00:01,500 --> 00:00:02,500"));
        assert!(got.contains("00:00:03,500 --> 00:00:04,500"));
        assert!(got.contains("first"));
        assert!(got.contains("second line"));
    }

    #[test]
    fn shift_preserves_crlf() {
        let input = "1\r\n00:00:01,000 --> 00:00:02,000\r\nhello\r\n";
        let got = shift_srt(input, 500_000);
        assert!(got.contains("00:00:01,500 --> 00:00:02,500\r\n"));
        assert!(got.contains("hello\r\n"));
    }

    #[test]
    fn shift_preserves_position_overrides_after_cue() {
        // Some SRT writers append `X1:... X2:... Y1:... Y2:...` after the
        // timestamps. Whisper doesn't, but a robust shifter should leave it
        // alone instead of stripping it.
        let input = "1\n00:00:01,000 --> 00:00:02,000 X1:0 X2:100 Y1:0 Y2:100\nstyled\n";
        let got = shift_srt(input, 500_000);
        assert!(got.contains("00:00:01,500 --> 00:00:02,500 X1:0 X2:100 Y1:0 Y2:100"));
    }

    #[test]
    fn shift_clamps_at_zero_for_negative_result() {
        // Negative shift larger than the cue start clamps to 00:00:00,000
        // rather than overflowing into negatives (which SRT can't represent).
        let input = "1\n00:00:01,000 --> 00:00:02,000\nclip\n";
        let got = shift_srt(input, -2_000_000);
        assert!(got.contains("00:00:00,000 --> 00:00:00,000"));
    }

    #[test]
    fn passes_unrelated_lines_through_verbatim() {
        let input = "WEBVTT\n\nNOTE this isn't SRT\nbut whatever\n";
        assert_eq!(shift_srt(input, 1_000_000), input);
    }

    #[test]
    fn timestamp_parse_rejects_out_of_range_fields() {
        assert!(parse_srt_timestamp("00:60:00,000").is_none(), "min 60");
        assert!(parse_srt_timestamp("00:00:60,000").is_none(), "sec 60");
        assert!(parse_srt_timestamp("00:00:00,1000").is_none(), "ms 1000");
        assert!(parse_srt_timestamp("00:00:00").is_none(), "missing ms");
    }

    #[test]
    fn timestamp_parse_accepts_dot_as_alternative_decimal() {
        // Some non-Whisper implementations emit `.` instead of `,` — we accept
        // both on parse but emit canonical `,`.
        assert_eq!(parse_srt_timestamp("00:00:01.500"), Some(1_500_000));
    }
}
