//! Motif manifest schema + built-in catalog shared with the TypeScript side.
//!
//! Defines the serde types (`Manifest`, `PropSpec`, `FontDecl`, `Template`)
//! that describe a Motif's capabilities and the validation logic
//! (`canonicalize_props`, `resolve_template_max_dur_us`) that commands and MCP
//! tools use when placing or updating a Motif layer.
//!
//! One built-in Motif (`countdown`) is embedded via `include_str!` (manifest
//! JSON + `index.html`) so the desktop binary ships it without runtime file
//! access. The catalog is exposed to the picker UI and to MCP agents via
//! `catalog()` / `builtins()`.
//!
//! Cache integration: `Template::content_hash()` feeds the CDP raster cache
//! key, so any change to a Motif's manifest or `index.html` invalidates cached
//! frames automatically (no manual cache wipe).

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
    /// Optional hard cap on a placed layer's total length, in seconds. When
    /// present, the timeline forbids trimming or adding the template longer
    /// than this (content-bounded templates like `countdown`). When absent
    /// (`None`), the template is freely extendable — holdable overlays such
    /// as lower-thirds rely on this.
    ///
    /// This is the STATIC fallback cap. When `max_duration_prop` is set and
    /// the layer's props carry a valid value for that prop, the cap is driven
    /// by the prop instead (see `resolve_template_max_dur_us`); this field is
    /// then used only if the prop is missing/invalid.
    #[serde(default)]
    pub max_duration_s: Option<f64>,
    /// Optional name of a NUMBER prop whose current value (in seconds) is the
    /// layer's length cap. When set and the layer's props carry a finite,
    /// positive value under this key, that value (not `max_duration_s`) bounds
    /// the layer length — so editing the prop changes the cap live. Falls back
    /// to `max_duration_s` when the prop is absent or invalid. `None` keeps the
    /// purely-static cap behavior.
    #[serde(default)]
    pub max_duration_prop: Option<String>,
    /// How the template's frames are captured. Defaults to `"svg"` when the
    /// manifest omits it.
    #[serde(default = "default_engine")]
    pub engine: String,
    /// Fonts the template bundles under `assets/`. Empty for built-ins that
    /// use system fonts (e.g. `countdown`).
    #[serde(default)]
    pub fonts: Vec<FontDecl>,
    /// Use a BTreeMap so canonical JSON serialization is key-order-stable —
    /// the cache key derived from props depends on this.
    pub props_schema: BTreeMap<String, PropSpec>,
}

fn default_engine() -> String {
    "svg".into()
}

impl Manifest {
    /// The `max_duration_s` cap expressed in integer microseconds, or `None`
    /// when the template is unbounded. This is a plain seconds→µs conversion
    /// (rounded to the nearest µs to avoid float-truncation noise); the
    /// result is an absolute µs value and is NOT frame-aligned — e.g. `5.0`s
    /// = 5_000_000µs is off the frame grid at 29.97 fps. Frame-snapping of the
    /// cap-bounded edge happens at the trim / add-layer call sites
    /// (`apply_trim_layer` / `add_layer`), which round it onto the
    /// composition grid.
    pub fn max_duration_us(&self) -> Option<i64> {
        self.max_duration_s
            .filter(|&s| s > 0.0)
            .map(|s| (s * 1_000_000.0).round() as i64)
    }
}

/// Resolve a Template layer's length cap (in integer microseconds) from its
/// manifest + the layer's current props.
///
/// When the manifest names a `max_duration_prop` AND the layer's props carry a
/// finite, positive numeric value for that prop, the cap is that prop value (in
/// seconds → µs) — so editing the prop changes the cap live. Otherwise (no
/// prop named, prop missing, non-numeric, or non-finite/non-positive) the cap
/// falls back to the static `max_duration_s`. Returns `None` when the template
/// is unbounded (no prop value and no `max_duration_s`).
///
/// Like `max_duration_us`, the returned µs value is absolute and NOT
/// frame-aligned — the trim / add-layer call sites snap the cap-bounded edge
/// onto the composition grid.
pub fn resolve_template_max_dur_us(
    manifest: &Manifest,
    props: &imbl::HashMap<String, serde_json::Value>,
) -> Option<i64> {
    if let Some(name) = &manifest.max_duration_prop {
        if let Some(n) = props.get(name).and_then(|v| v.as_f64()) {
            if n.is_finite() && n > 0.0 {
                return Some((n * 1_000_000.0).round() as i64);
            }
        }
    }
    manifest.max_duration_us()
}

/// A bundled font declared by a template manifest. `file` is the asset
/// filename (under the template's `assets/` dir); the bytes are loaded
/// separately by the capture harness.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FontDecl {
    pub family: String,
    #[serde(default)]
    pub weight: Option<u32>,
    #[serde(default)]
    pub style: Option<String>,
    pub file: String,
}

#[derive(Clone, Debug)]
pub struct Template {
    pub manifest: Manifest,
    pub html: String,
}

impl Template {
    pub fn id(&self) -> &str {
        &self.manifest.id
    }

    pub fn size(&self) -> (u32, u32) {
        (self.manifest.size[0], self.manifest.size[1])
    }

    /// blake3 of every input that affects the rendered output — manifest +
    /// HTML, concatenated with `\0` so a string boundary can't be hidden by
    /// content. Stable across runs as long as the inputs are stable.
    pub fn content_hash(&self) -> String {
        let mut hasher = blake3::Hasher::new();
        let manifest_canonical = serde_json::to_vec(&self.manifest)
            .expect("manifest serialize cannot fail");
        for part in [manifest_canonical.as_slice(), self.html.as_bytes()] {
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

// -- Built-in Motifs ---------------------------------------------------------
//
// One built-in (`countdown`) is embedded via `include_str!` so the desktop
// binary ships it without runtime file access. It lives in
// `motifs/catalog/countdown/`.

macro_rules! builtin_template {
    ($fn_name:ident, $dir:literal) => {
        pub fn $fn_name() -> Template {
            const MANIFEST: &str = include_str!(concat!($dir, "/manifest.json"));
            const HTML: &str = include_str!(concat!($dir, "/index.html"));
            let manifest: Manifest =
                serde_json::from_str(MANIFEST).expect("built-in manifest must parse");
            Template {
                manifest,
                html: HTML.to_string(),
            }
        }
    };
}

builtin_template!(builtin_countdown, "catalog/countdown");

/// Catalog entry — the JSON-serializable shape that the picker UI + the
/// `list_templates` MCP tool + the `templates://current` resource all
/// agree on. One source of truth so the three surfaces can't drift.
///
/// Fields are exactly the manifest's, so adding a new manifest field
/// surfaces it everywhere without per-surface plumbing.
pub fn catalog() -> Vec<Manifest> {
    builtins().into_iter().map(|t| t.manifest).collect()
}

/// All built-in templates, in display order. The picker UI iterates this
/// list; agents see the same set via `list_templates` (Stage H).
pub fn builtins() -> Vec<Template> {
    vec![builtin_countdown()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builtin_template_parses() {
        let t = builtin_countdown();
        assert_eq!(t.id(), "countdown");
        assert_eq!(t.size(), (480, 480));
        assert!(t.manifest.props_schema.contains_key("seconds"));
        assert!(t.manifest.props_schema.contains_key("accent"));
        // Content hash is stable across calls.
        let h1 = t.content_hash();
        let h2 = builtin_countdown().content_hash();
        assert_eq!(h1, h2);
    }

    #[test]
    fn canonicalize_fills_defaults() {
        let t = builtin_countdown();
        let canonical = t.canonicalize_props(&json!({})).expect("ok");
        // Order-stable canonical form: BTreeMap keys sorted alphabetically.
        // Every schema prop is present with its default filled in.
        assert!(canonical.contains("\"accent\""));
        assert!(canonical.contains("\"seconds\""));
    }

    #[test]
    fn canonicalize_rejects_unknown_key() {
        let t = builtin_countdown();
        // Pair the unknown key with a *valid* one so `bogus` is the only
        // unknown — the validator returns on the first unknown it hits and
        // serde_json map order isn't guaranteed, so don't rely on which one.
        let err = t
            .canonicalize_props(&json!({ "accent": "#ffffff", "bogus": 1 }))
            .expect_err("should fail");
        assert!(matches!(err, TemplateError::UnknownProp(k) if k == "bogus"));
    }

    #[test]
    fn canonicalize_validates_color() {
        let t = builtin_countdown();
        let err = t
            .canonicalize_props(&json!({ "accent": "blue" }))
            .expect_err("should fail");
        assert!(matches!(err, TemplateError::BadColor(_, _)));
    }

    #[test]
    fn canonicalize_enforces_number_range() {
        // `seconds` is bounded [1, 60]; out-of-range values must be rejected.
        let t = builtin_countdown();
        let err = t
            .canonicalize_props(&json!({ "seconds": 999.0 }))
            .expect_err("should fail");
        assert!(matches!(err, TemplateError::OutOfRange(_, _, _)));
    }

    /// `resolve_template_max_dur_us` maps `countdown`'s cap onto the `seconds`
    /// prop (manifest `max_duration_prop: "seconds"`). The prop value (in
    /// seconds) becomes the cap when present + valid; otherwise it falls back
    /// to the static `max_duration_s` (5s). Covers: prop present (drives cap),
    /// prop missing (static fallback), prop non-finite/non-positive (fallback),
    /// and a manifest without `max_duration_prop` (pure static).
    #[test]
    fn resolve_max_dur_us_prefers_prop_then_falls_back() {
        let m = &builtin_countdown().manifest;
        assert_eq!(m.max_duration_prop.as_deref(), Some("seconds"));

        // Prop present + valid → prop value drives the cap (10s, not static 5s).
        let mut p10: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        p10.insert("seconds".into(), json!(10.0));
        assert_eq!(resolve_template_max_dur_us(m, &p10), Some(10_000_000));

        // Integer JSON value resolves the same (as_f64 handles ints).
        let mut p3: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        p3.insert("seconds".into(), json!(3));
        assert_eq!(resolve_template_max_dur_us(m, &p3), Some(3_000_000));

        // Prop missing → static fallback (max_duration_s = 5s).
        let empty: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        assert_eq!(resolve_template_max_dur_us(m, &empty), Some(5_000_000));

        // Prop present but non-numeric / non-positive → static fallback.
        let mut bad: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        bad.insert("seconds".into(), json!("nope"));
        assert_eq!(resolve_template_max_dur_us(m, &bad), Some(5_000_000));
        let mut zero: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        zero.insert("seconds".into(), json!(0.0));
        assert_eq!(resolve_template_max_dur_us(m, &zero), Some(5_000_000));

        // A manifest with NO max_duration_prop uses the static cap only.
        let mut static_only = m.clone();
        static_only.max_duration_prop = None;
        // Even with a `seconds` value present, the prop is ignored.
        assert_eq!(resolve_template_max_dur_us(&static_only, &p10), Some(5_000_000));
        // And a wholly-unbounded manifest stays None.
        static_only.max_duration_s = None;
        assert_eq!(resolve_template_max_dur_us(&static_only, &p10), None);
    }

    /// `String` props with a `max_length` cap exercise the `TooLong` and
    /// `WrongType("string")` validator arms (mod.rs `validate_prop`). No
    /// built-in declares a capped string today, so build a synthetic
    /// `Template` (like the other synthetic-input tests) rather than adding a
    /// built-in just to keep those arms covered.
    #[test]
    fn canonicalize_validates_string_max_length_and_type() {
        let mut props_schema: BTreeMap<String, PropSpec> = BTreeMap::new();
        props_schema.insert(
            "label".to_string(),
            PropSpec::String {
                default: "hi".to_string(),
                max_length: Some(3),
            },
        );
        let t = Template {
            manifest: Manifest {
                id: "synthetic-string".to_string(),
                name: "Synthetic".to_string(),
                version: 1,
                size: [100, 100],
                default_duration_s: 1.0,
                max_duration_s: None,
                max_duration_prop: None,
                engine: "svg".to_string(),
                fonts: vec![],
                props_schema,
            },
            html: String::new(),
        };

        // (a) A string longer than `max_length` → TooLong.
        let too_long = t
            .canonicalize_props(&json!({ "label": "toolong" }))
            .expect_err("over-cap string should fail");
        assert!(matches!(too_long, TemplateError::TooLong(k, cap) if k == "label" && cap == 3));

        // (b) A non-string value for the String prop → WrongType("string").
        let wrong_type = t
            .canonicalize_props(&json!({ "label": 42 }))
            .expect_err("non-string value should fail");
        assert!(matches!(wrong_type, TemplateError::WrongType(k, ty) if k == "label" && ty == "string"));
    }

    #[test]
    fn same_props_same_canonical_form() {
        // Cache-key stability: re-canonicalising with the same logical
        // inputs in different key order must produce the same string.
        let t = builtin_countdown();
        let a = t
            .canonicalize_props(&json!({ "seconds": 5, "accent": "#ffaa00" }))
            .unwrap();
        let b = t
            .canonicalize_props(&json!({ "accent": "#ffaa00", "seconds": 5 }))
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

    // -- Built-in starter set -----------------------------------------------

    /// Every builtin's manifest must parse, every prop default must satisfy
    /// its own validator, and `content_hash` must be stable across two
    /// constructions (cache-key requirement). One loop covers all of these
    /// so adding a future builtin requires zero extra test scaffolding.
    #[test]
    fn every_builtin_parses_and_self_validates() {
        for t in builtins() {
            assert!(!t.id().is_empty(), "id missing");
            assert!(t.manifest.size[0] > 0 && t.manifest.size[1] > 0, "{}: zero size", t.id());
            assert!(
                t.manifest.default_duration_s > 0.0,
                "{}: default_duration_s must be > 0",
                t.id()
            );
            // Canonicalize-with-empty-object: every prop falls back to its
            // default and the result must pass validation.
            let canonical = t
                .canonicalize_props(&json!({}))
                .unwrap_or_else(|e| panic!("{}: defaults must validate: {e}", t.id()));
            // Stable canonical form (BTreeMap-ordered).
            let again = t
                .canonicalize_props(&json!({}))
                .expect("second pass canonicalize");
            assert_eq!(canonical, again, "{}: canonical form unstable", t.id());
            // Content hash stable across constructions.
            let h1 = t.content_hash();
            let h2 = builtins()
                .into_iter()
                .find(|x| x.id() == t.id())
                .expect("present")
                .content_hash();
            assert_eq!(h1, h2, "{}: content_hash unstable", t.id());
        }
    }

    /// Template ids feed `cache_key` — collisions silently cross-mix
    /// rendered frames between templates. Catch any duplicate at compile-
    /// adjacent time rather than at first cache hit.
    #[test]
    fn builtin_ids_are_unique() {
        use std::collections::HashSet;
        let mut seen = HashSet::new();
        for t in builtins() {
            assert!(
                seen.insert(t.id().to_string()),
                "duplicate builtin id: {}",
                t.id()
            );
        }
    }

    /// The render-path redesign (ADR 0015) trimmed the starter set to the
    /// single `countdown` exemplar. If `builtins()` is ever expanded or the
    /// id renamed, this guard surfaces it so the picker-UI / docs side stays
    /// in sync.
    /// `max_duration_us` must return `None` for non-positive values (zero or
    /// negative), matching the TS `resolveTemplateContentDurationUs` guard
    /// (`max_duration_s > 0`). A positive value converts normally.
    #[test]
    fn max_duration_us_rejects_non_positive() {
        let base = builtin_countdown().manifest;

        // Positive → converts normally (5s = 5_000_000µs).
        let mut m = base.clone();
        m.max_duration_s = Some(5.0);
        assert_eq!(m.max_duration_us(), Some(5_000_000));

        // Zero → treated as uncapped (returns None).
        m.max_duration_s = Some(0.0);
        assert_eq!(m.max_duration_us(), None);

        // Negative → also treated as uncapped.
        m.max_duration_s = Some(-1.0);
        assert_eq!(m.max_duration_us(), None);

        // None → None (no change from before).
        m.max_duration_s = None;
        assert_eq!(m.max_duration_us(), None);
    }

    #[test]
    fn builtins_cover_starter_set() {
        let actual: Vec<String> = builtins().iter().map(|t| t.id().to_string()).collect();
        assert_eq!(actual, vec!["countdown".to_string()]);
        // `catalog()` exposes the same single template to the picker / MCP.
        let catalog_ids: Vec<String> = catalog().iter().map(|m| m.id.clone()).collect();
        assert_eq!(catalog_ids, vec!["countdown".to_string()]);
    }

    /// Built-in HTML is now a self-contained SVG document: an `<svg>` plus an
    /// inline `<script>` defining `render(...)`. The old `__STYLE__`
    /// placeholder / separate-CSS mechanism is gone, so assert the new shape
    /// instead — a missing `render` or `<svg>` ships a blank frame.
    #[test]
    fn every_builtin_html_is_svg_with_render() {
        for t in builtins() {
            assert_eq!(t.manifest.engine, "svg", "{}: engine must be svg", t.id());
            assert!(t.html.contains("<svg"), "{}: HTML missing <svg>", t.id());
            assert!(
                t.html.contains("function render"),
                "{}: HTML missing render() entry",
                t.id()
            );
        }
    }
}
