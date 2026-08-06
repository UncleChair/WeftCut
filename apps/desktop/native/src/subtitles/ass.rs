use super::{Cue, CueStyle, ParsedSubtitles};
use crate::state::color::Rgba;
use std::collections::HashMap;

pub fn parse(body: &str) -> ParsedSubtitles {
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    let mut styles: HashMap<String, CueStyle> = HashMap::new();
    let mut style_fmt: Vec<String> = Vec::new();
    let mut event_fmt: Vec<String> = Vec::new();
    let mut cues = Vec::new();
    let mut simplified = false;
    let mut section = "";

    for line in normalized.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            section = if l.eq_ignore_ascii_case("[v4+ styles]") {
                "styles"
            } else if l.eq_ignore_ascii_case("[events]") {
                "events"
            } else {
                "other"
            };
            continue;
        }
        if let Some(rest) = l.strip_prefix("Format:") {
            let cols: Vec<String> = rest
                .split(',')
                .map(|s| s.trim().to_ascii_lowercase())
                .collect();
            if section == "styles" {
                style_fmt = cols;
            } else if section == "events" {
                event_fmt = cols;
            }
            continue;
        }
        if section == "styles" {
            if let Some(rest) = l.strip_prefix("Style:") {
                let (name, st) = parse_style_row(rest, &style_fmt);
                styles.insert(name, st);
            }
        } else if section == "events" {
            if let Some(rest) = l.strip_prefix("Dialogue:") {
                if let Some(cue) = parse_dialogue(rest, &event_fmt, &styles, &mut simplified) {
                    cues.push(cue);
                }
            }
        }
    }
    ParsedSubtitles { cues, simplified }
}

fn parse_style_row(rest: &str, fmt: &[String]) -> (String, CueStyle) {
    let vals: Vec<&str> = rest.splitn(fmt.len(), ',').map(|s| s.trim()).collect();
    let get = |key: &str| {
        fmt.iter()
            .position(|c| c == key)
            .and_then(|i| vals.get(i))
            .copied()
    };
    let mut st = CueStyle::default();
    let name = get("name").unwrap_or("Default").to_string();
    st.font_family = get("fontname").map(|s| s.to_string());
    st.size_px = get("fontsize").and_then(|s| s.parse().ok());
    st.primary = get("primarycolour").and_then(parse_ass_color);
    st.bold = get("bold").map(|s| s == "-1" || s == "1").unwrap_or(false);
    st.italic = get("italic")
        .map(|s| s == "-1" || s == "1")
        .unwrap_or(false);
    st.outline_px = get("outline").and_then(|s| s.parse().ok());
    st.shadow_px = get("shadow").and_then(|s| s.parse().ok());
    st.align = get("alignment").and_then(|s| s.parse().ok());
    (name, st)
}

fn parse_dialogue(
    rest: &str,
    fmt: &[String],
    styles: &HashMap<String, CueStyle>,
    simplified: &mut bool,
) -> Option<Cue> {
    let n = fmt.len().max(1);
    let vals: Vec<&str> = rest.splitn(n, ',').map(|s| s.trim()).collect();
    let col = |key: &str| {
        fmt.iter()
            .position(|c| c == key)
            .and_then(|i| vals.get(i))
            .copied()
    };
    let start_us = parse_ass_ts(col("start")?)?;
    let end_us = parse_ass_ts(col("end")?)?;
    let mut style = col("style")
        .and_then(|n| styles.get(n))
        .cloned()
        .unwrap_or_default();
    let raw = col("text")?;
    let text = apply_overrides(raw, &mut style, simplified);
    if text.is_empty() {
        return None;
    }
    Some(Cue {
        start_us,
        end_us,
        text,
        style,
    })
}

/// Strip `{...}` override blocks. Map the supported overrides into `style`;
/// any other tag sets `simplified`. Convert `\N`/`\n` to real newlines.
fn apply_overrides(raw: &str, style: &mut CueStyle, simplified: &mut bool) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = match after.find('}') {
            Some(c) => c,
            None => break,
        };
        let block = &after[..close];
        for tag in block.split('\\').filter(|t| !t.is_empty()) {
            let t = tag.trim();
            if let Some(v) = t.strip_prefix("an") {
                style.align = v.parse().ok();
            } else if let Some(v) = t.strip_prefix("pos(") {
                style.pos = parse_pos(v.trim_end_matches(')'));
            } else if t.starts_with("c&") || t.starts_with("1c&") {
                style.primary = parse_ass_color(t.trim_start_matches("1c").trim_start_matches('c'));
            } else if t == "b1" || t == "b-1" {
                style.bold = true;
            } else if t == "b0" {
                style.bold = false;
            } else if t == "i1" || t == "i-1" {
                style.italic = true;
            } else if t == "i0" {
                style.italic = false;
            } else if let Some(v) = t.strip_prefix("fs") {
                style.size_px = v.parse().ok().or(style.size_px);
            } else if let Some(v) = t.strip_prefix("fn") {
                style.font_family = Some(v.to_string());
            } else if t.starts_with("fad") {
                // `\fad` is dropped silently — deliberately not flagged as
                // `simplified`.
            } else {
                *simplified = true; // \k \p \clip \t \move \frx \blur …
            }
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out.replace("\\N", "\n")
        .replace("\\n", "\n")
        .trim()
        .to_string()
}

fn parse_pos(s: &str) -> Option<(f64, f64)> {
    let (x, y) = s.split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

/// ASS colour `&HAABBGGRR` (alpha optional) → Rgba.
fn parse_ass_color(s: &str) -> Option<Rgba> {
    let hex = s
        .trim()
        .trim_start_matches("&H")
        .trim_start_matches("&h")
        .trim_end_matches('&');
    let v = u32::from_str_radix(hex, 16).ok()?;
    Some(Rgba {
        r: (v & 0xFF) as u8,
        g: ((v >> 8) & 0xFF) as u8,
        b: ((v >> 16) & 0xFF) as u8,
        a: 255,
    })
}

/// ASS time `H:MM:SS.cs` (centiseconds).
fn parse_ass_ts(s: &str) -> Option<i64> {
    let (hms, cs_str) = s.split_once('.')?;
    let mut p = hms.split(':');
    let h: i64 = p.next()?.parse().ok()?;
    let m: i64 = p.next()?.parse().ok()?;
    let sec: i64 = p.next()?.parse().ok()?;
    let cs: i64 = cs_str.parse().ok()?;
    Some(((h * 3600 + m * 60 + sec) * 100 + cs) * 10_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::color::Rgba;

    const DOC: &str = "[Script Info]\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Outline, Shadow, Alignment\nStyle: Default,Arial,60,&H00FFFFFF,-1,0,2,1,2\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,{\\an8}Top line\nDialogue: 0,0:00:03.00,0:00:04.00,Default,{\\k50}Karaoke gone\n";

    #[test]
    fn maps_style_table_and_an_override() {
        let p = parse(DOC);
        assert_eq!(p.cues.len(), 2);
        assert_eq!(p.cues[0].style.font_family.as_deref(), Some("Arial"));
        assert_eq!(p.cues[0].style.size_px, Some(60.0));
        assert_eq!(p.cues[0].style.primary, Some(Rgba::WHITE));
        assert!(p.cues[0].style.bold);
        assert_eq!(p.cues[0].style.align, Some(8)); // \an8 overrides the style's 2
        assert_eq!(p.cues[0].text, "Top line");
    }

    #[test]
    fn karaoke_is_dropped_and_flags_simplified() {
        let p = parse(DOC);
        assert_eq!(p.cues[1].text, "Karaoke gone"); // \k tag stripped, text kept
        assert!(p.simplified);
    }
}
