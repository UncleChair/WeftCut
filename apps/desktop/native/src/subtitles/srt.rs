use super::{Cue, CueStyle};

/// Parse an SRT body into cues. Blocks are separated by blank lines; each
/// block is `index / "HH:MM:SS,mmm --> HH:MM:SS,mmm" / text…`. Malformed
/// blocks are skipped. Line breaks inside a cue are preserved as '\n'.
pub fn parse(body: &str) -> Vec<Cue> {
    let mut cues = Vec::new();
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    for block in normalized.split("\n\n") {
        let mut lines = block.lines().filter(|l| !l.trim().is_empty());
        // Optional numeric index line; skip if present.
        let first = match lines.next() {
            Some(l) => l,
            None => continue,
        };
        let time_line = if first.contains("-->") {
            first
        } else {
            match lines.next() {
                Some(l) => l,
                None => continue,
            }
        };
        let (start_us, end_us) = match parse_time_range(time_line) {
            Some(t) => t,
            None => continue,
        };
        let text = lines.collect::<Vec<_>>().join("\n");
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
    // The RHS may carry SRT position overrides after the timestamp; take token 0.
    let rhs0 = rhs.trim().split_whitespace().next()?;
    let b = parse_ts(rhs0)?;
    Some((a, b))
}

/// `HH:MM:SS,mmm` (also accepts '.' as the decimal separator).
fn parse_ts(s: &str) -> Option<i64> {
    let (hms, ms) = s.split_once(',').or_else(|| s.split_once('.'))?;
    let mut p = hms.split(':');
    let h: i64 = p.next()?.parse().ok()?;
    let m: i64 = p.next()?.parse().ok()?;
    let sec: i64 = p.next()?.parse().ok()?;
    if p.next().is_some() {
        return None;
    }
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
    fn parses_two_cues_with_preserved_line_breaks() {
        let body = "1\n00:00:01,000 --> 00:00:02,500\nHello\nworld\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n";
        let cues = parse(body);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_us, 1_000_000);
        assert_eq!(cues[0].end_us, 2_500_000);
        assert_eq!(cues[0].text, "Hello\nworld");
        assert_eq!(cues[1].start_us, 3_000_000);
        assert_eq!(cues[1].text, "Bye");
    }
}
