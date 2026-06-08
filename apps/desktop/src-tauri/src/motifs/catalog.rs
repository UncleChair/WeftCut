//! Motif manifest schema + built-in catalog shared with the TypeScript side.
//!
//! Defines the serde types (`Manifest`, `PropSpec`, `FontDecl`, `Motif`)
//! that describe a Motif's capabilities and the validation logic
//! (`canonicalize_props`, `resolve_motif_max_dur_us`) that commands and MCP
//! tools use when placing or updating a Motif layer.
//!
//! Two built-in Motifs (`countdown`, `lower-third`) are embedded via
//! `include_str!` (manifest JSON + `index.html`) so the desktop binary ships
//! them without runtime file access. The catalog is exposed to the picker UI
//! and to MCP agents via
//! `catalog()` / `builtins()`.
//!
//! Cache integration: `Motif::content_hash()` feeds the CDP raster cache
//! key, so any change to a Motif's manifest or `index.html` invalidates cached
//! frames automatically (no manual cache wipe).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Per-prop type contract from the manifest. Stage D supports the three
/// types the starter motifs need; richer types (enum, image, number) can
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
    /// present, the timeline forbids trimming or adding the motif longer
    /// than this (content-bounded motifs like `countdown`). When absent
    /// (`None`), the motif is freely extendable — holdable overlays such
    /// as lower-thirds rely on this.
    ///
    /// This is the STATIC fallback cap. When `max_duration_prop` is set and
    /// the layer's props carry a valid value for that prop, the cap is driven
    /// by the prop instead (see `resolve_motif_max_dur_us`); this field is
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
    /// Fixed content/animation duration (seconds) that does NOT cap the layer.
    /// When set, the seekable content spans this many seconds; the layer stays
    /// freely extendable (`resolve_motif_max_dur_us` ignores this field), and
    /// the TS frame math clamps frames past it to the last content frame (a
    /// held, deduped tail). Used by holdable overlays (e.g. the lower third);
    /// distinct from `max_duration_s`, which caps the layer.
    #[serde(default)]
    pub content_duration_s: Option<f64>,
    /// Fonts the motif bundles under `assets/`. Empty for built-ins that
    /// use system fonts (e.g. `countdown`).
    #[serde(default)]
    pub fonts: Vec<FontDecl>,
    /// Use a BTreeMap so canonical JSON serialization is key-order-stable —
    /// the cache key derived from props depends on this.
    pub props_schema: BTreeMap<String, PropSpec>,
}

impl Manifest {
    /// The `max_duration_s` cap expressed in integer microseconds, or `None`
    /// when the motif is unbounded. This is a plain seconds→µs conversion
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

/// Resolve a Motif layer's length cap (in integer microseconds) from its
/// manifest + the layer's current props.
///
/// When the manifest names a `max_duration_prop` AND the layer's props carry a
/// finite, positive numeric value for that prop, the cap is that prop value (in
/// seconds → µs) — so editing the prop changes the cap live. Otherwise (no
/// prop named, prop missing, non-numeric, or non-finite/non-positive) the cap
/// falls back to the static `max_duration_s`. Returns `None` when the motif
/// is unbounded (no prop value and no `max_duration_s`).
///
/// Like `max_duration_us`, the returned µs value is absolute and NOT
/// frame-aligned — the trim / add-layer call sites snap the cap-bounded edge
/// onto the composition grid.
pub fn resolve_motif_max_dur_us(
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

/// The Motif's content/animation duration in SECONDS, for the capture
/// `ctx.duration`. Derived from the manifest + instance props:
/// `content_duration_s` → the `max_duration_prop` value → `max_duration_s` →
/// `default_duration_s`. Replaces the old hardcoded "seconds" prop name so it's
/// correct for any Motif, not just countdown. (Mirrors the TS content-duration
/// resolution; distinct from `resolve_motif_max_dur_us`, the layer cap.)
pub fn motif_ctx_duration_s(manifest: &Manifest, props: &serde_json::Value) -> f64 {
    if let Some(s) = manifest.content_duration_s {
        if s.is_finite() && s > 0.0 {
            return s;
        }
    }
    if let Some(name) = &manifest.max_duration_prop {
        if let Some(v) = props.get(name).and_then(|v| v.as_f64()) {
            if v.is_finite() && v > 0.0 {
                return v;
            }
        }
    }
    if let Some(s) = manifest.max_duration_s {
        if s > 0.0 {
            return s;
        }
    }
    manifest.default_duration_s
}

/// A bundled font declared by a motif manifest. `file` is the asset
/// filename (under the motif's `assets/` dir); the bytes are loaded
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
pub struct Motif {
    pub manifest: Manifest,
    pub html: String,
}

impl Motif {
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
    ) -> Result<String, MotifError> {
        let provided_map = match provided {
            serde_json::Value::Object(m) => m,
            serde_json::Value::Null => {
                // Treat null/missing as "use all defaults".
                return self.canonicalize_props(&serde_json::json!({}));
            }
            _ => {
                return Err(MotifError::PropsNotObject);
            }
        };

        // Reject keys not in the schema — typos shouldn't silently pass.
        for k in provided_map.keys() {
            if !self.manifest.props_schema.contains_key(k) {
                return Err(MotifError::UnknownProp(k.clone()));
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
            .map_err(|e| MotifError::Serialize(e.to_string()))
    }
}

/// Extract and parse the Motif's metadata island from its HTML, WITHOUT
/// executing the page. A user Motif is a single self-contained `.html` whose
/// manifest is a delimited JSON island:
///
/// ```html
/// <script type="application/json" id="motif-manifest">{ … }</script>
/// ```
///
/// This is the single static source of a Motif's metadata (see the upload
/// design spec §2). We locate the island by its `id="motif-manifest"` marker,
/// take the text up to the next `</script>`, and `serde_json`-parse it into a
/// `Manifest`. Whitespace and other attributes on the tag are tolerated; we
/// control the writer side so the format is stable.
pub fn parse_manifest_island(html: &str) -> Result<Manifest, MotifError> {
    let id_marker = html
        .find(r#"id="motif-manifest""#)
        .ok_or(MotifError::NoManifestIsland)?;
    // End of the opening `<script ...>` tag: the first `>` at or after the marker.
    let tag_end = html[id_marker..]
        .find('>')
        .map(|i| id_marker + i + 1)
        .ok_or(MotifError::NoManifestIsland)?;
    let close = html[tag_end..]
        .find("</script>")
        .map(|i| tag_end + i)
        .ok_or(MotifError::NoManifestIsland)?;
    let json = html[tag_end..close].trim();
    serde_json::from_str(json).map_err(|e| MotifError::ManifestParse(e.to_string()))
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
) -> Result<(), MotifError> {
    match spec {
        PropSpec::String { max_length, .. } => {
            let s = value
                .as_str()
                .ok_or_else(|| MotifError::WrongType(key.to_string(), "string"))?;
            if let Some(cap) = max_length {
                if s.chars().count() > *cap {
                    return Err(MotifError::TooLong(key.to_string(), *cap));
                }
            }
        }
        PropSpec::Color { .. } => {
            let s = value
                .as_str()
                .ok_or_else(|| MotifError::WrongType(key.to_string(), "color string"))?;
            if !is_hex_color(s) {
                return Err(MotifError::BadColor(key.to_string(), s.to_string()));
            }
        }
        PropSpec::Number { min, max, .. } => {
            let n = value
                .as_f64()
                .ok_or_else(|| MotifError::WrongType(key.to_string(), "number"))?;
            if let Some(lo) = min {
                if n < *lo {
                    return Err(MotifError::OutOfRange(key.to_string(), Some(*lo), *max));
                }
            }
            if let Some(hi) = max {
                if n > *hi {
                    return Err(MotifError::OutOfRange(key.to_string(), *min, Some(*hi)));
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
pub enum MotifError {
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
    #[error("no <script type=\"application/json\" id=\"motif-manifest\"> island found in HTML")]
    NoManifestIsland,
    #[error("manifest island is not valid JSON: {0}")]
    ManifestParse(String),
}

// -- Built-in Motifs ---------------------------------------------------------
//
// Two built-ins (`countdown`, `lower-third`) are embedded via `include_str!`
// so the desktop binary ships them without runtime file access. They live in
// `motifs/catalog/countdown/` and `motifs/catalog/lower-third/`.

macro_rules! builtin_motif {
    ($fn_name:ident, $dir:literal) => {
        pub fn $fn_name() -> Motif {
            const MANIFEST: &str = include_str!(concat!($dir, "/manifest.json"));
            const HTML: &str = include_str!(concat!($dir, "/index.html"));
            let manifest: Manifest =
                serde_json::from_str(MANIFEST).expect("built-in manifest must parse");
            Motif {
                manifest,
                html: HTML.to_string(),
            }
        }
    };
}

builtin_motif!(builtin_countdown, "catalog/countdown");
builtin_motif!(builtin_lower_third, "catalog/lower-third");

/// Catalog entry — the JSON-serializable shape that the picker UI + the
/// `list_motifs` MCP tool + the `motifs://current` resource all
/// agree on. One source of truth so the three surfaces can't drift.
///
/// Fields are exactly the manifest's, so adding a new manifest field
/// surfaces it everywhere without per-surface plumbing.
pub fn catalog() -> Vec<Manifest> {
    builtins().into_iter().map(|t| t.manifest).collect()
}

/// All built-in motifs, in display order. The picker UI iterates this
/// list; agents see the same set via `list_motifs` (Stage H).
pub fn builtins() -> Vec<Motif> {
    vec![builtin_countdown(), builtin_lower_third()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builtin_motif_parses() {
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
        assert!(matches!(err, MotifError::UnknownProp(k) if k == "bogus"));
    }

    #[test]
    fn canonicalize_validates_color() {
        let t = builtin_countdown();
        let err = t
            .canonicalize_props(&json!({ "accent": "blue" }))
            .expect_err("should fail");
        assert!(matches!(err, MotifError::BadColor(_, _)));
    }

    #[test]
    fn canonicalize_enforces_number_range() {
        // `seconds` is bounded [1, 60]; out-of-range values must be rejected.
        let t = builtin_countdown();
        let err = t
            .canonicalize_props(&json!({ "seconds": 999.0 }))
            .expect_err("should fail");
        assert!(matches!(err, MotifError::OutOfRange(_, _, _)));
    }

    /// `resolve_motif_max_dur_us` maps `countdown`'s cap onto the `seconds`
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
        assert_eq!(resolve_motif_max_dur_us(m, &p10), Some(10_000_000));

        // Integer JSON value resolves the same (as_f64 handles ints).
        let mut p3: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        p3.insert("seconds".into(), json!(3));
        assert_eq!(resolve_motif_max_dur_us(m, &p3), Some(3_000_000));

        // Prop missing → static fallback (max_duration_s = 5s).
        let empty: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        assert_eq!(resolve_motif_max_dur_us(m, &empty), Some(5_000_000));

        // Prop present but non-numeric / non-positive → static fallback.
        let mut bad: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        bad.insert("seconds".into(), json!("nope"));
        assert_eq!(resolve_motif_max_dur_us(m, &bad), Some(5_000_000));
        let mut zero: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        zero.insert("seconds".into(), json!(0.0));
        assert_eq!(resolve_motif_max_dur_us(m, &zero), Some(5_000_000));

        // A manifest with NO max_duration_prop uses the static cap only.
        let mut static_only = m.clone();
        static_only.max_duration_prop = None;
        // Even with a `seconds` value present, the prop is ignored.
        assert_eq!(resolve_motif_max_dur_us(&static_only, &p10), Some(5_000_000));
        // And a wholly-unbounded manifest stays None.
        static_only.max_duration_s = None;
        assert_eq!(resolve_motif_max_dur_us(&static_only, &p10), None);
    }

    /// `String` props with a `max_length` cap exercise the `TooLong` and
    /// `WrongType("string")` validator arms (mod.rs `validate_prop`). No
    /// built-in declares a capped string today, so build a synthetic
    /// `Motif` (like the other synthetic-input tests) rather than adding a
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
        let t = Motif {
            manifest: Manifest {
                id: "synthetic-string".to_string(),
                name: "Synthetic".to_string(),
                version: 1,
                size: [100, 100],
                default_duration_s: 1.0,
                max_duration_s: None,
                max_duration_prop: None,
                content_duration_s: None,
                fonts: vec![],
                props_schema,
            },
            html: String::new(),
        };

        // (a) A string longer than `max_length` → TooLong.
        let too_long = t
            .canonicalize_props(&json!({ "label": "toolong" }))
            .expect_err("over-cap string should fail");
        assert!(matches!(too_long, MotifError::TooLong(k, cap) if k == "label" && cap == 3));

        // (b) A non-string value for the String prop → WrongType("string").
        let wrong_type = t
            .canonicalize_props(&json!({ "label": 42 }))
            .expect_err("non-string value should fail");
        assert!(matches!(wrong_type, MotifError::WrongType(k, ty) if k == "label" && ty == "string"));
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

    /// Motif ids feed `cache_key` — collisions silently cross-mix
    /// rendered frames between motifs. Catch any duplicate at compile-
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
    /// negative), matching the TS `resolveMotifContentDurationUs` guard
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

    /// `content_duration_s` defines the seekable content span but must NOT cap
    /// the layer — `resolve_motif_max_dur_us` (the layer cap) ignores it, so a
    /// holdable overlay stays freely extendable.
    #[test]
    fn content_duration_s_does_not_cap_the_layer() {
        let mut m = builtin_countdown().manifest;
        m.max_duration_s = None;
        m.max_duration_prop = None;
        m.content_duration_s = Some(0.8);
        let props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        assert_eq!(resolve_motif_max_dur_us(&m, &props), None);
    }

    /// The field round-trips through serde and defaults to `None` when absent
    /// (so existing manifests without it keep parsing).
    #[test]
    fn manifest_roundtrips_content_duration_s() {
        let json = r#"{"id":"x","name":"X","version":1,"size":[10,10],
            "default_duration_s":1.0,"content_duration_s":0.8,"props_schema":{}}"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.content_duration_s, Some(0.8));
        assert_eq!(m.max_duration_s, None);

        let without = r#"{"id":"y","name":"Y","version":1,"size":[10,10],
            "default_duration_s":1.0,"props_schema":{}}"#;
        let m2: Manifest = serde_json::from_str(without).unwrap();
        assert_eq!(m2.content_duration_s, None);
    }

    #[test]
    fn builtins_cover_starter_set() {
        let actual: Vec<String> = builtins().iter().map(|t| t.id().to_string()).collect();
        assert_eq!(actual, vec!["countdown".to_string(), "lower-third".to_string()]);
        let catalog_ids: Vec<String> = catalog().iter().map(|m| m.id.clone()).collect();
        assert_eq!(catalog_ids, vec!["countdown".to_string(), "lower-third".to_string()]);
    }

    /// `motif_ctx_duration_s` resolution order: `content_duration_s` →
    /// `max_duration_prop` value → `max_duration_s` → `default_duration_s`.
    /// Covers: countdown (max_duration_prop="seconds" → props value),
    /// content_duration_s overrides everything, and the fallback chain.
    #[test]
    fn motif_ctx_duration_s_resolution() {
        // --- countdown: max_duration_prop="seconds" → props.seconds -----------
        let m = builtin_countdown().manifest;
        // Props carry seconds=7 → should return 7.0.
        let p7 = json!({ "seconds": 7 });
        assert!(
            (motif_ctx_duration_s(&m, &p7) - 7.0).abs() < 1e-9,
            "expected 7.0 from seconds prop"
        );
        // Props carry seconds=30.0 (float) → 30.0.
        let p30 = json!({ "seconds": 30.0 });
        assert!(
            (motif_ctx_duration_s(&m, &p30) - 30.0).abs() < 1e-9,
            "expected 30.0 from seconds prop"
        );
        // Props missing → falls back through max_duration_s (5.0) since no
        // prop value is present but max_duration_s=5.0 is set.
        let empty = json!({});
        assert!(
            (motif_ctx_duration_s(&m, &empty) - 5.0).abs() < 1e-9,
            "expected 5.0 (max_duration_s fallback)"
        );

        // --- content_duration_s overrides max_duration_prop + seconds prop ---
        let mut m_content = m.clone();
        m_content.content_duration_s = Some(0.8);
        // Even with seconds=7, content_duration_s wins.
        assert!(
            (motif_ctx_duration_s(&m_content, &p7) - 0.8).abs() < 1e-9,
            "expected 0.8 from content_duration_s"
        );
        // Also wins over empty props.
        assert!(
            (motif_ctx_duration_s(&m_content, &empty) - 0.8).abs() < 1e-9,
            "expected 0.8 from content_duration_s with empty props"
        );

        // --- fallback to default_duration_s when nothing else applies --------
        let mut m_bare = m.clone();
        m_bare.content_duration_s = None;
        m_bare.max_duration_prop = None;
        m_bare.max_duration_s = None;
        m_bare.default_duration_s = 3.5;
        assert!(
            (motif_ctx_duration_s(&m_bare, &empty) - 3.5).abs() < 1e-9,
            "expected 3.5 from default_duration_s"
        );
        // Even with seconds prop present, ignored because max_duration_prop=None.
        assert!(
            (motif_ctx_duration_s(&m_bare, &p7) - 3.5).abs() < 1e-9,
            "expected 3.5 (max_duration_prop=None ignores seconds)"
        );

        // --- lower-third: content_duration_s=0.8, no max_duration_prop ------
        let m_lt = builtin_lower_third().manifest;
        assert_eq!(m_lt.content_duration_s, Some(0.8));
        assert!(
            (motif_ctx_duration_s(&m_lt, &empty) - 0.8).abs() < 1e-9,
            "expected 0.8 for lower-third (content_duration_s)"
        );
    }

    /// Every built-in's served HTML declares its lifecycle via `motif.define`
    /// (the live contract). A missing `motif.define` ships a blank frame.
    #[test]
    fn every_builtin_html_uses_motif_define() {
        for t in builtins() {
            assert!(
                t.html.contains("motif.define"),
                "{}: HTML missing motif.define() entry",
                t.id()
            );
        }
    }

    #[test]
    fn parses_a_valid_manifest_island() {
        let html = r#"<!doctype html><html><head>
<script type="application/json" id="motif-manifest">
{ "id": "user-x", "name": "User X", "version": 1, "size": [640, 480],
  "default_duration_s": 4.0, "props_schema": {} }
</script>
</head><body><script>motif.define({ setup(){} });</script></body></html>"#;
        let m = parse_manifest_island(html).expect("island parses");
        assert_eq!(m.id, "user-x");
        assert_eq!(m.size, [640, 480]);
    }

    #[test]
    fn missing_island_is_an_error() {
        let html = "<html><body>no island here</body></html>";
        assert!(matches!(
            parse_manifest_island(html),
            Err(MotifError::NoManifestIsland)
        ));
    }

    #[test]
    fn malformed_island_json_is_an_error() {
        let html = r#"<script type="application/json" id="motif-manifest">{ not json }</script>"#;
        assert!(matches!(
            parse_manifest_island(html),
            Err(MotifError::ManifestParse(_))
        ));
    }
}
