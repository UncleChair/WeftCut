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

/// Parsed pieces of a composed template HTML, shaped for the
/// composition engine's `instantiateCompositionTemplate(host, style,
/// scripts, body, ...)` entry. The engine attaches a fresh Shadow DOM
/// per template host and concatenates `<style>` + `body` into the
/// shadow innerHTML, then runs `scripts` via `new Function`.
///
/// Used by the html-render-groups composition path to embed a
/// template inside a larger composition document. (The standalone
/// offscreen-webview rasterizer that read the composed HTML directly
/// was deleted with P12-c.)
#[derive(Clone, Debug)]
pub struct ParsedComposed {
    pub style: String,
    pub scripts: String,
    pub body: String,
}

/// Parse a composed template HTML (i.e. after `__STYLE__` substitution)
/// into its three composition-relevant pieces. Mirrors
/// `TemplateHandle.parseTemplate` on the TS side.
///
/// The parser is intentionally simple: scan for `<style>...</style>` and
/// `<script>...</script>` runs, harvest their content into the
/// `style` / `scripts` outputs, and emit everything between them as the
/// `body` output. Built-in templates all follow a uniform structure
/// (one `<style>` in head, one `<script>` at end of body, rest is
/// markup) so a regex-or-DOM-grade parser is overkill.
///
/// `<style>` is matched case-insensitively. Attributes on the opening
/// tag are tolerated. Nested tags are NOT — templates don't nest
/// style/script and we'd need a real HTML parser if they did.
pub fn parse_composed_template(composed: &str) -> ParsedComposed {
    let mut style = String::new();
    let mut scripts = String::new();
    let mut body = String::new();

    let bytes = composed.as_bytes();
    let lower: String = composed.to_ascii_lowercase();
    let mut cursor = 0;
    while cursor < composed.len() {
        // Find the next `<style` / `<script` opener.
        let style_idx = lower[cursor..].find("<style").map(|i| cursor + i);
        let script_idx = lower[cursor..].find("<script").map(|i| cursor + i);
        let (next_open, kind) = match (style_idx, script_idx) {
            (Some(a), Some(b)) if a < b => (a, "style"),
            (Some(_), Some(b)) => (b, "script"),
            (Some(a), None) => (a, "style"),
            (None, Some(b)) => (b, "script"),
            (None, None) => {
                // No more style/script — append the rest as body and finish.
                body.push_str(&composed[cursor..]);
                break;
            }
        };
        // Everything between cursor and next_open is body markup.
        body.push_str(&composed[cursor..next_open]);

        // Find the end of the opening tag `>`.
        let after_open = match lower[next_open..].find('>') {
            Some(i) => next_open + i + 1,
            None => {
                // Malformed — surface what we have and bail.
                body.push_str(&composed[next_open..]);
                break;
            }
        };
        // Find the matching close tag.
        let close_tag = format!("</{}", kind);
        let close_pos = match lower[after_open..].find(&close_tag) {
            Some(i) => after_open + i,
            None => {
                // Unterminated — treat the rest as content and finish.
                let content = &composed[after_open..];
                if kind == "style" {
                    if !style.is_empty() {
                        style.push('\n');
                    }
                    style.push_str(content);
                } else {
                    if !scripts.is_empty() {
                        scripts.push_str("\n;\n");
                    }
                    scripts.push_str(content);
                }
                break;
            }
        };
        let content = &composed[after_open..close_pos];
        if kind == "style" {
            if !style.is_empty() {
                style.push('\n');
            }
            style.push_str(content);
        } else {
            if !scripts.is_empty() {
                scripts.push_str("\n;\n");
            }
            scripts.push_str(content);
        }
        // Skip past the `</style>` / `</script>` close tag.
        let _ = bytes; // suppress dead-code warning when no edge case fires
        cursor = match lower[close_pos..].find('>') {
            Some(i) => close_pos + i + 1,
            None => composed.len(),
        };
    }

    // Strip the `<head>...</head>` wrapper from `body` if present — the
    // built-in templates put their `<style>` inside `<head>`, and once
    // we've harvested those styles, an empty `<head></head>` shell is
    // left over. Same for `<!doctype>` / `<html>` / `<body>` tags.
    body = body.replace("<!doctype html>", "");
    body = body.replace("<!DOCTYPE html>", "");
    // Strip simple html/head/body opening + closing tags (no attrs).
    for tag in ["<html>", "</html>", "<head>", "</head>", "<body>", "</body>"] {
        body = body.replace(tag, "");
    }

    ParsedComposed {
        style: style.trim().to_string(),
        scripts: scripts.trim().to_string(),
        body: body.trim().to_string(),
    }
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
//
// One built-in (`countdown`) is retained as the validation exemplar for the
// SVG render-path redesign (ADR 0015); the other starters were removed. It
// lives in `templates/countdown/` and is embedded via `include_str!` so the
// desktop binary ships it without runtime file access.

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

builtin_template!(builtin_countdown, "countdown");

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

    // -- Stage F starter set ------------------------------------------------

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

    /// The Stage F bullet list calls for exactly these 10 templates. If
    /// `builtins()` is ever pruned or reordered, this guard surfaces it so
    /// the picker-UI / docs side stays in sync.
    #[test]
    fn builtins_cover_starter_set() {
        let expected: &[&str] = &[
            "lower-third-simple",
            "lower-third-glow",
            "lower-third-bar",
            "title-card",
            "captions-strip",
            "callout",
            "progress-bar",
            "countdown",
            "logo-bug",
            "slate",
        ];
        let actual: Vec<String> = builtins().iter().map(|t| t.id().to_string()).collect();
        let expected: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
        assert_eq!(actual, expected);
    }

    /// Every template's HTML must contain the `__STYLE__` placeholder —
    /// `navigate_to_template` does a plain `replace("__STYLE__", &style)`,
    /// so a missing placeholder ships the unstyled DOM and looks broken in
    /// the captured PNG. Cheap to enforce here rather than at first render.
    #[test]
    fn every_builtin_html_has_style_placeholder() {
        for t in builtins() {
            assert!(
                t.html.contains("__STYLE__"),
                "{}: HTML missing __STYLE__ placeholder",
                t.id()
            );
        }
    }

    /// `parse_composed_template` is load-bearing for the html-render-groups
    /// path: the composition engine reads `style` / `scripts` / `body`
    /// from the embedded state JSON. A regression that swallows the
    /// `<script>` body means templates render styled-but-static (no
    /// animation) inside compositions. Cover the round-trip against every
    /// built-in so a new template with a different structure (e.g. two
    /// `<script>` blocks) trips an actionable failure here, not at the
    /// first preview/export.
    #[test]
    fn parse_composed_extracts_each_builtin() {
        for t in builtins() {
            let composed = t.html.replace("__STYLE__", &t.style);
            let parsed = parse_composed_template(&composed);
            assert!(
                !parsed.style.is_empty(),
                "{}: parsed style empty",
                t.id()
            );
            assert!(
                !parsed.scripts.is_empty(),
                "{}: parsed scripts empty",
                t.id()
            );
            // Body keeps the visible markup (e.g. the title div).
            assert!(!parsed.body.is_empty(), "{}: parsed body empty", t.id());
            // No `<style>` / `<script>` tags should remain in the body —
            // those went to the dedicated buckets.
            assert!(
                !parsed.body.to_ascii_lowercase().contains("<style"),
                "{}: parsed body still contains <style>",
                t.id()
            );
            assert!(
                !parsed.body.to_ascii_lowercase().contains("<script"),
                "{}: parsed body still contains <script>",
                t.id()
            );
        }
    }

    #[test]
    fn parse_composed_handles_multiple_style_blocks() {
        let composed = "<!doctype html><html><head>\
            <style>a { color: red; }</style>\
            <style>b { color: blue; }</style>\
            </head><body><div>hi</div>\
            <script>var x = 1;</script>\
            </body></html>";
        let parsed = parse_composed_template(composed);
        assert!(parsed.style.contains("color: red"));
        assert!(parsed.style.contains("color: blue"));
        assert!(parsed.scripts.contains("var x = 1"));
        assert!(parsed.body.contains("<div>hi</div>"));
        // No html shell tags should leak into body.
        assert!(!parsed.body.contains("<html>"));
        assert!(!parsed.body.contains("<body>"));
    }
}
