//! Pure building blocks for turning untrusted `{manifest, html}` upload input
//! into a safe, canonical, well-identified on-disk Motif. No I/O here — the
//! `UserMotifStore` does the disk work and calls these. (Upload design spec
//! §4, §10.)

use super::catalog::{BUILTIN_IDS, Manifest, MotifError, PropSpec};
use super::store::DRAFTS_DIR;

/// Hard ceiling on a Motif's authored render size (CSS px). Generous for any
/// real overlay; rejects absurd values that would blow up `setDeviceMetricsOverride`.
const MAX_DIMENSION: u32 = 8192;
/// Cap on `props_schema` entries — a sane upper bound for an overlay's controls.
const MAX_PROPS: usize = 64;

/// Validate a manifest parsed from untrusted upload input, BEYOND what serde
/// already enforces. Checks the semantic constraints the renderer + timeline
/// rely on, and that every prop default satisfies its own spec (so a
/// freshly-placed layer's defaults can never fail `canonicalize_props`).
pub fn validate_manifest(m: &Manifest) -> Result<(), MotifError> {
    if m.name.trim().is_empty() {
        return Err(MotifError::InvalidManifest("name must not be empty".into()));
    }
    let [w, h] = m.size;
    if w == 0 || h == 0 || w > MAX_DIMENSION || h > MAX_DIMENSION {
        return Err(MotifError::InvalidManifest(format!(
            "size [{w},{h}] must be within [1,{MAX_DIMENSION}] on each axis"
        )));
    }
    if !(m.default_duration_s.is_finite() && m.default_duration_s > 0.0) {
        return Err(MotifError::InvalidManifest(
            "default_duration_s must be finite and > 0".into(),
        ));
    }
    for (field, val) in [
        ("max_duration_s", m.max_duration_s),
        ("content_duration_s", m.content_duration_s),
    ] {
        if let Some(s) = val {
            if !(s.is_finite() && s > 0.0) {
                return Err(MotifError::InvalidManifest(format!(
                    "{field} must be finite and > 0 when present"
                )));
            }
        }
    }
    if m.props_schema.len() > MAX_PROPS {
        return Err(MotifError::InvalidManifest(format!(
            "props_schema has {} entries (max {MAX_PROPS})",
            m.props_schema.len()
        )));
    }
    for (key, spec) in &m.props_schema {
        if let PropSpec::Number { min, max, default } = spec {
            if let (Some(lo), Some(hi)) = (min, max) {
                if lo > hi {
                    return Err(MotifError::InvalidManifest(format!(
                        "prop `{key}`: min {lo} > max {hi}"
                    )));
                }
            }
            // Must precede validate_default_for below: spec_default_json calls
            // serde_json::json!(default), which panics on a non-finite f64.
            if !default.is_finite() {
                return Err(MotifError::InvalidManifest(format!(
                    "prop `{key}`: default must be finite"
                )));
            }
        }
        super::catalog::validate_default_for(key, spec)?;
    }
    Ok(())
}

/// Slugify a display name into a safe single path-segment id: lowercase ASCII
/// alphanumerics, every other run collapsed to a single `-`, trimmed. Falls
/// back to `"motif"` if nothing survives.
pub fn sanitize_id(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() { "motif".to_string() } else { trimmed.to_string() }
}

/// Assign a unique id derived from `name`, avoiding `taken`, the built-in ids,
/// and the reserved `drafts` segment. Appends `-2`, `-3`, ... on collision.
pub fn assign_unique_id(name: &str, taken: &[String]) -> String {
    let base = sanitize_id(name);
    let reserved = |id: &str| {
        BUILTIN_IDS.contains(&id) || id == DRAFTS_DIR || taken.iter().any(|t| t == id)
    };
    if !reserved(&base) { return base; }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !reserved(&candidate) { return candidate; }
        n += 1;
    }
}

/// Compose the canonical single-file Motif HTML: strip any existing
/// `<script type="application/json" id="motif-manifest">…</script>` island,
/// then inject a fresh one (pretty JSON of `manifest`, with `<` escaped as
/// `<` so no manifest string field can close the island early) right after
/// the opening `<head>` (or at the very top if there is no head). The author's
/// body is otherwise preserved verbatim, and the result round-trips through
/// `parse_manifest_island`.
pub fn compose_motif_html(manifest: &Manifest, html: &str) -> String {
    let stripped = strip_manifest_island(html);
    // serde_json does not HTML-escape; escape `<` as < so a manifest string
    // field containing `</script>` (any case) can't truncate the island when the
    // reader slices up to `</script>`. The reader (and any JSON parser) decodes
    // < back to `<`, so the manifest round-trips exactly.
    let json = serde_json::to_string_pretty(manifest)
        .unwrap_or_else(|_| "{}".to_string())
        .replace('<', "\\u003c");
    let island = format!(
        "<script type=\"application/json\" id=\"motif-manifest\">\n{json}\n</script>\n"
    );
    if let Some(pos) = find_ci(&stripped, "<head>") {
        let at = pos + "<head>".len();
        let mut out = String::with_capacity(stripped.len() + island.len());
        out.push_str(&stripped[..at]);
        out.push('\n');
        out.push_str(&island);
        out.push_str(&stripped[at..]);
        out
    } else {
        format!("{island}{stripped}")
    }
}

/// Remove the existing manifest island (its owning `<script` .. `</script>`) if present.
fn strip_manifest_island(html: &str) -> String {
    let Some(id_marker) = html.find(r#"id="motif-manifest""#) else {
        return html.to_string();
    };
    let Some(open) = html[..id_marker].rfind("<script") else {
        return html.to_string();
    };
    let Some(rel_close) = html[id_marker..].find("</script>") else {
        return html.to_string();
    };
    let close = id_marker + rel_close + "</script>".len();
    let mut out = String::with_capacity(html.len());
    out.push_str(&html[..open]);
    out.push_str(&html[close..]);
    out
}

/// Case-insensitive substring search (ASCII needle); returns the byte offset.
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_ascii_lowercase().find(&needle.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::catalog::Manifest;
    use std::collections::BTreeMap;

    fn base() -> Manifest {
        Manifest {
            id: "x".into(), name: "X".into(), version: 1, size: [640, 480],
            default_duration_s: 5.0, max_duration_s: None, max_duration_prop: None,
            content_duration_s: None, fonts: vec![], props_schema: BTreeMap::new(),
        }
    }

    #[test]
    fn accepts_a_sane_manifest() {
        assert!(validate_manifest(&base()).is_ok());
    }

    #[test]
    fn rejects_empty_name_zero_or_huge_size() {
        let mut m = base(); m.name = "  ".into();
        assert!(validate_manifest(&m).is_err());
        let mut m = base(); m.size = [0, 100];
        assert!(validate_manifest(&m).is_err());
        let mut m = base(); m.size = [99999, 100];
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn rejects_bad_durations() {
        let mut m = base(); m.default_duration_s = 0.0;
        assert!(validate_manifest(&m).is_err());
        let mut m = base(); m.content_duration_s = Some(-1.0);
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn rejects_inverted_number_bounds_and_bad_color_default() {
        let mut m = base();
        m.props_schema.insert("n".into(), PropSpec::Number { default: 5.0, min: Some(10.0), max: Some(1.0) });
        assert!(validate_manifest(&m).is_err());
        let mut m = base();
        m.props_schema.insert("c".into(), PropSpec::Color { default: "not-a-hex".into() });
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn sanitize_id_slugifies() {
        assert_eq!(sanitize_id("My Cool Motif!"), "my-cool-motif");
        assert_eq!(sanitize_id("  Trailing--dashes  "), "trailing-dashes");
        assert_eq!(sanitize_id("___"), "motif");
        assert_eq!(sanitize_id("Lower/Third"), "lower-third");
    }

    #[test]
    fn assign_unique_id_avoids_collisions_and_builtins() {
        let taken = ["my-motif".to_string(), "my-motif-2".to_string()];
        assert_eq!(assign_unique_id("My Motif", &taken), "my-motif-3");
        let none: [String; 0] = [];
        assert_eq!(assign_unique_id("countdown", &none), "countdown-2");
        // The reserved `drafts` dir name is never handed out as a Motif id.
        assert_eq!(assign_unique_id("Drafts", &none), "drafts-2");
        assert_eq!(assign_unique_id("Fresh", &taken), "fresh");
    }

    #[test]
    fn compose_injects_island_that_parses_back() {
        let mut m = base();
        m.id = "demo".into();
        m.name = "Demo".into();
        let html = "<!doctype html><html><head></head><body><script>motif.define({setup(){}})</script></body></html>";
        let composed = compose_motif_html(&m, html);
        let parsed = super::super::catalog::parse_manifest_island(&composed).expect("parses");
        assert_eq!(parsed.id, "demo");
        assert_eq!(parsed.name, "Demo");
        assert!(composed.contains("motif.define"));
    }

    #[test]
    fn compose_survives_script_close_in_a_string_field() {
        let mut m = base();
        m.id = "evil".into();
        m.name = "Evil</script><script>x".into();
        let composed = compose_motif_html(&m,
            "<head></head><body><script>motif.define({setup(){}})</script></body>");
        // The reader must round-trip the name verbatim (no truncation), and the
        // body's real </script> must still be the island's closing tag.
        let parsed = super::super::catalog::parse_manifest_island(&composed).expect("parses");
        assert_eq!(parsed.name, "Evil</script><script>x");
        assert_eq!(parsed.id, "evil");
    }

    #[test]
    fn compose_with_no_head_prepends_and_round_trips() {
        let mut m = base();
        m.id = "nohead".into();
        let composed = compose_motif_html(&m, "<body><script>motif.define({setup(){}})</script></body>");
        let parsed = super::super::catalog::parse_manifest_island(&composed).expect("parses");
        assert_eq!(parsed.id, "nohead");
        // Island injected at the very top (no <head> to anchor to).
        assert!(composed.trim_start().starts_with("<script"));
    }

    #[test]
    fn compose_on_html_with_no_existing_island_injects_one() {
        let mut m = base();
        m.id = "fresh".into();
        let composed = compose_motif_html(&m, "<head></head><body>hi</body>");
        assert_eq!(composed.matches(r#"id="motif-manifest""#).count(), 1);
        assert_eq!(super::super::catalog::parse_manifest_island(&composed).unwrap().id, "fresh");
    }

    #[test]
    fn compose_replaces_a_pre_existing_island() {
        let mut m = base();
        m.id = "new-id".into();
        let seed = r#"<head><script type="application/json" id="motif-manifest">{"id":"old-id","name":"Old","version":1,"size":[10,10],"default_duration_s":1.0,"props_schema":{}}</script></head><body><script>motif.define({setup(){}})</script></body>"#;
        let composed = compose_motif_html(&m, seed);
        let parsed = super::super::catalog::parse_manifest_island(&composed).expect("parses");
        assert_eq!(parsed.id, "new-id");
        assert_eq!(composed.matches(r#"id="motif-manifest""#).count(), 1);
    }
}
