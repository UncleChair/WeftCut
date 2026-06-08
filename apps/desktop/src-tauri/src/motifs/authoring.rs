//! Pure building blocks for turning untrusted `{manifest, html}` upload input
//! into a safe, canonical, well-identified on-disk Motif. No I/O here — the
//! `UserMotifStore` does the disk work and calls these. (Upload design spec
//! §4, §10.)

use super::catalog::{Manifest, MotifError, PropSpec};

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
}
