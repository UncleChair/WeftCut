use super::{Cue, CueStyle};

/// Parse a WebVTT body to cues — text + timing only. Cue settings (line/
/// position/align/region) are dropped — VTT renders at SRT level.
pub fn parse(body: &str) -> Vec<Cue> {
    let mut cues = Vec::new();
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    for block in normalized.split("\n\n") {
        let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.is_empty() || lines[0].trim_start().starts_with("WEBVTT") {
            continue;
        }
        // An optional cue identifier line may precede the time line.
        let (time_idx, time_line) = match lines.iter().enumerate().find(|(_, l)| l.contains("-->"))
        {
            Some((i, l)) => (i, *l),
            None => continue,
        };
        let (start_us, end_us) = match parse_time_range(time_line) {
            Some(t) => t,
            None => continue,
        };
        let text = lines[time_idx + 1..].join("\n");
        if text.is_empty() {
            continue;
        }
        cues.push(Cue {
            start_us,
            end_us,
            text,
            style: CueStyle::default(),
        });
    }
    cues
}

fn parse_time_range(line: &str) -> Option<(i64, i64)> {
    let (lhs, rhs) = line.split_once("-->")?;
    let a = parse_ts(lhs.trim())?;
    // Drop trailing cue-setting tokens (line:/position:/align:/region:…).
    let rhs0 = rhs.trim().split_whitespace().next()?;
    let b = parse_ts(rhs0)?;
    Some((a, b))
}

/// `[HH:]MM:SS.mmm` — hours optional, '.' decimal separator.
fn parse_ts(s: &str) -> Option<i64> {
    let (hms, ms) = s.split_once('.')?;
    let parts: Vec<&str> = hms.split(':').collect();
    let (h, m, sec): (i64, i64, i64) = match parts.as_slice() {
        [m, s] => (0, m.parse().ok()?, s.parse().ok()?),
        [h, m, s] => (h.parse().ok()?, m.parse().ok()?, s.parse().ok()?),
        _ => return None,
    };
    let ms: i64 = ms.parse().ok()?;
    if !(0..1000).contains(&ms) || !(0..60).contains(&sec) || !(0..60).contains(&m) || h < 0 {
        return None;
    }
    Some(((h * 3600 + m * 60 + sec) * 1000 + ms) * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vtt_dropping_header_and_cue_settings() {
        let body = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:90%\nHello\n\n00:00:03.000 --> 00:00:04.000\nBye\n";
        let cues = parse(body);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_us, 1_000_000);
        assert_eq!(cues[0].text, "Hello");
    }

    #[test]
    fn parses_vtt_with_cue_identifier() {
        // Cue identifier line before the time line must be skipped.
        let body = "WEBVTT\n\ncue-1\n00:00:05.000 --> 00:00:06.500\nWith id\n";
        let cues = parse(body);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].start_us, 5_000_000);
        assert_eq!(cues[0].end_us, 6_500_000);
        assert_eq!(cues[0].text, "With id");
    }

    #[test]
    fn parses_vtt_hours_optional() {
        // MM:SS.mmm form (no hours component).
        let body = "WEBVTT\n\n01:30.500 --> 02:00.000\nShort form\n";
        let cues = parse(body);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].start_us, 90_500_000);
    }

    #[test]
    fn skips_vtt_blocks_without_arrow() {
        // NOTE header block and NOTE comment blocks must be silently dropped.
        let body = "WEBVTT\n\nNOTE This is a comment\n\n00:00:01.000 --> 00:00:02.000\nOk\n";
        let cues = parse(body);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Ok");
    }

    #[test]
    fn skips_vtt_cues_with_empty_text() {
        let body =
            "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n\n00:00:03.000 --> 00:00:04.000\nPresent\n";
        let cues = parse(body);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Present");
    }

    #[test]
    fn preserves_multiline_vtt_text() {
        let body = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nLine one\nLine two\n";
        let cues = parse(body);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Line one\nLine two");
    }
}
