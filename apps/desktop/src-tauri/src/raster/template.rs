//! Template loader + manifest validator.
//!
//! Stage D ships one built-in template (`lower-third-simple`) embedded as
//! Rust string constants. Stage F will add the on-disk loader for
//! `packages/templates/<id>/` and the full starter set. The types here are
//! shaped for both — `Template::from_inline` and a future
//! `Template::from_dir` both produce the same `Template` value, and the
//! rasterizer's render path doesn't know the difference.
//!
//! Cache integration: `Template::content_hash()` is what feeds the raster
//! cache key, so any change to a template's HTML/CSS/manifest invalidates
//! cached renders automatically (no manual cache wipe).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Per-prop type contract from the manifest. Stage D supports the three
/// types the starter templates need; richer types (enum, image, number) can
/// be added incrementally without changing the call sites.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PropSpec {
    String {
        default: String,
        #[serde(default)]
        max_length: Option<usize>,
    },
    Color {
        /// `#rrggbb` or `#rrggbbaa`.
        default: String,
    },
    Number {
        default: f64,
        #[serde(default)]
        min: Option<f64>,
        #[serde(default)]
        max: Option<f64>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub size: [u32; 2],
    pub default_duration_s: f64,
    /// Use a BTreeMap so canonical JSON serialization is key-order-stable —
    /// the cache key derived from props depends on this.
    pub props_schema: BTreeMap<String, PropSpec>,
}

#[derive(Clone, Debug)]
pub struct Template {
    pub manifest: Manifest,
    pub html: String,
    pub style: String,
}

impl Template {
    pub fn id(&self) -> &str {
        &self.manifest.id
    }

    pub fn size(&self) -> (u32, u32) {
        (self.manifest.size[0], self.manifest.size[1])
    }

    /// blake3 of every input that affects the rendered output — manifest +
    /// HTML + CSS, concatenated with `\0` so a string boundary can't be
    /// hidden by content. Stable across runs as long as the inputs are
    /// stable.
    pub fn content_hash(&self) -> String {
        let mut hasher = blake3::Hasher::new();
        let manifest_canonical = serde_json::to_vec(&self.manifest)
            .expect("manifest serialize cannot fail");
        for part in [
            manifest_canonical.as_slice(),
            self.html.as_bytes(),
            self.style.as_bytes(),
        ] {
            hasher.update(part);
            hasher.update(&[0]);
        }
        hasher.finalize().to_hex().to_string()
    }

    /// Validate `props` against the manifest's `props_schema`. Unknown keys
    /// → error. Missing keys → filled from defaults. Returns canonical
    /// JSON (BTreeMap-ordered) suitable for the cache key.
    pub fn canonicalize_props(
        &self,
        provided: &serde_json::Value,
    ) -> Result<String, TemplateError> {
        let provided_map = match provided {
            serde_json::Value::Object(m) => m,
            serde_json::Value::Null => {
                // Treat null/missing as "use all defaults".
                return self.canonicalize_props(&serde_json::json!({}));
            }
            _ => {
                return Err(TemplateError::PropsNotObject);
            }
        };

        // Reject keys not in the schema — typos shouldn't silently pass.
        for k in provided_map.keys() {
            if !self.manifest.props_schema.contains_key(k) {
                return Err(TemplateError::UnknownProp(k.clone()));
            }
        }

        let mut canonical: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        for (key, spec) in &self.manifest.props_schema {
            let value = provided_map
                .get(key)
                .cloned()
                .unwrap_or_else(|| spec_default_json(spec));
            validate_prop(key, spec, &value)?;
            canonical.insert(key.clone(), value);
        }

        serde_json::to_string(&canonical)
            .map_err(|e| TemplateError::Serialize(e.to_string()))
    }
}

fn spec_default_json(spec: &PropSpec) -> serde_json::Value {
    match spec {
        PropSpec::String { default, .. } => serde_json::Value::String(default.clone()),
        PropSpec::Color { default } => serde_json::Value::String(default.clone()),
        PropSpec::Number { default, .. } => serde_json::json!(*default),
    }
}

fn validate_prop(
    key: &str,
    spec: &PropSpec,
    value: &serde_json::Value,
) -> Result<(), TemplateError> {
    match spec {
        PropSpec::String { max_length, .. } => {
            let s = value
                .as_str()
                .ok_or_else(|| TemplateError::WrongType(key.to_string(), "string"))?;
            if let Some(cap) = max_length {
                if s.chars().count() > *cap {
                    return Err(TemplateError::TooLong(key.to_string(), *cap));
                }
            }
        }
        PropSpec::Color { .. } => {
            let s = value
                .as_str()
                .ok_or_else(|| TemplateError::WrongType(key.to_string(), "color string"))?;
            if !is_hex_color(s) {
                return Err(TemplateError::BadColor(key.to_string(), s.to_string()));
            }
        }
        PropSpec::Number { min, max, .. } => {
            let n = value
                .as_f64()
                .ok_or_else(|| TemplateError::WrongType(key.to_string(), "number"))?;
            if let Some(lo) = min {
                if n < *lo {
                    return Err(TemplateError::OutOfRange(key.to_string(), Some(*lo), *max));
                }
            }
            if let Some(hi) = max {
                if n > *hi {
                    return Err(TemplateError::OutOfRange(key.to_string(), *min, Some(*hi)));
                }
            }
        }
    }
    Ok(())
}

fn is_hex_color(s: &str) -> bool {
    if !s.starts_with('#') {
        return false;
    }
    let hex = &s[1..];
    matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

#[derive(Debug, thiserror::Error)]
pub enum TemplateError {
    #[error("props must be a JSON object")]
    PropsNotObject,
    #[error("unknown prop `{0}` — not in manifest props_schema")]
    UnknownProp(String),
    #[error("prop `{0}` must be a {1}")]
    WrongType(String, &'static str),
    #[error("prop `{0}` exceeds max_length {1}")]
    TooLong(String, usize),
    #[error("prop `{0}` is not a valid hex color: {1:?}")]
    BadColor(String, String),
    #[error("prop `{0}` out of range [{1:?}, {2:?}]")]
    OutOfRange(String, Option<f64>, Option<f64>),
    #[error("manifest serialize failed: {0}")]
    Serialize(String),
}

// -- Built-in starter templates ------------------------------------------

const LOWER_THIRD_HTML: &str = include_str!("templates/lower_third_simple/index.html");
const LOWER_THIRD_STYLE: &str = include_str!("templates/lower_third_simple/style.css");
const LOWER_THIRD_MANIFEST: &str =
    include_str!("templates/lower_third_simple/manifest.json");

/// Simple lower-third title card. Reads `title`, `subtitle`, `color` props;
/// rAF-driven slide-in animation over the first 0.6 s so a multi-frame
/// render shows visible motion.
pub fn builtin_lower_third_simple() -> Template {
    let manifest: Manifest =
        serde_json::from_str(LOWER_THIRD_MANIFEST).expect("built-in manifest must parse");
    Template {
        manifest,
        html: LOWER_THIRD_HTML.to_string(),
        style: LOWER_THIRD_STYLE.to_string(),
    }
}

/// All built-in templates, in display order.
pub fn builtins() -> Vec<Template> {
    vec![builtin_lower_third_simple()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builtin_template_parses() {
        let t = builtin_lower_third_simple();
        assert_eq!(t.id(), "lower-third-simple");
        assert_eq!(t.size(), (800, 200));
        assert!(t.manifest.props_schema.contains_key("title"));
        assert!(t.manifest.props_schema.contains_key("subtitle"));
        assert!(t.manifest.props_schema.contains_key("color"));
        // Content hash is stable across calls.
        let h1 = t.content_hash();
        let h2 = builtin_lower_third_simple().content_hash();
        assert_eq!(h1, h2);
    }

    #[test]
    fn canonicalize_fills_defaults() {
        let t = builtin_lower_third_simple();
        let canonical = t.canonicalize_props(&json!({})).expect("ok");
        // Order-stable canonical form: BTreeMap keys sorted alphabetically.
        // Color comes first, then subtitle, then title.
        assert!(canonical.contains("\"color\""));
        assert!(canonical.contains("\"title\""));
    }

    #[test]
    fn canonicalize_rejects_unknown_key() {
        let t = builtin_lower_third_simple();
        let err = t
            .canonicalize_props(&json!({ "title": "x", "bogus": 1 }))
            .expect_err("should fail");
        assert!(matches!(err, TemplateError::UnknownProp(k) if k == "bogus"));
    }

    #[test]
    fn canonicalize_validates_color() {
        let t = builtin_lower_third_simple();
        let err = t
            .canonicalize_props(&json!({ "color": "blue" }))
            .expect_err("should fail");
        assert!(matches!(err, TemplateError::BadColor(_, _)));
    }

    #[test]
    fn canonicalize_enforces_max_length() {
        let t = builtin_lower_third_simple();
        let long = "x".repeat(200);
        let err = t
            .canonicalize_props(&json!({ "title": long }))
            .expect_err("should fail");
        assert!(matches!(err, TemplateError::TooLong(_, _)));
    }

    #[test]
    fn same_props_same_canonical_form() {
        // Cache-key stability: re-canonicalising with the same logical
        // inputs in different key order must produce the same string.
        let t = builtin_lower_third_simple();
        let a = t
            .canonicalize_props(&json!({ "title": "A", "color": "#ffaa00" }))
            .unwrap();
        let b = t
            .canonicalize_props(&json!({ "color": "#ffaa00", "title": "A" }))
            .unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn is_hex_color_basics() {
        assert!(is_hex_color("#000"));
        assert!(is_hex_color("#00aaff"));
        assert!(is_hex_color("#00aaffcc"));
        assert!(!is_hex_color("00aaff"));
        assert!(!is_hex_color("#xyz"));
        assert!(!is_hex_color("#"));
    }
}
