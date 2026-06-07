//! Built-in Motif bundles, embedded into the binary, and the `motif:`
//! URI-scheme handler that serves them.
//!
//! A built-in Motif is an `index.html` (+ optional sibling assets) shipped in
//! `motifs/builtin/<id>/`. The files are embedded with `include_str!` /
//! `include_bytes!` (mirroring the old `templates` module) so they travel with
//! the binary and need no on-disk install.
//!
//! ## Scheme / URL convention (Windows)
//!
//! The scheme is registered as `motif`. On Windows, Tauri remaps custom
//! schemes to `http://<scheme>.localhost/<path>` (see the `Builder::
//! register_uri_scheme_protocol` docs in Tauri 2.11). So every request this
//! handler sees has the form:
//!
//! ```text
//! http://motif.localhost/<id>/<rest...>
//! ```
//!
//! and the host window is loaded from `http://motif.localhost/<id>/index.html`.
//! The runtime is NOT injected here — Approach A injects it via the window's
//! `initialization_script` (document-start, before the page's own scripts), so
//! the scheme handler serves the Motif's files verbatim.

use tauri::http::{header, Request, Response};
use tauri::UriSchemeContext;

/// The custom URI scheme name. The window URL and request origin are derived
/// from this (`http://motif.localhost/...` on Windows).
pub const SCHEME: &str = "motif";

/// The scheme origin, as the browser/WebView2 sees it on Windows. Used both to
/// build window URLs and inside the CSP (`img-src`/`font-src` allowance).
pub const SCHEME_ORIGIN: &str = "http://motif.localhost";

/// One embedded built-in Motif file: a relative path under the Motif dir and
/// its bytes. (`index.html`, plus any `assets/...`.)
struct BuiltinFile {
    /// Path relative to the Motif's directory, e.g. `index.html` or
    /// `assets/font.woff2`. Always forward-slash separated.
    rel: &'static str,
    bytes: &'static [u8],
}

/// One embedded built-in Motif: an id and its files.
struct BuiltinMotif {
    id: &'static str,
    files: &'static [BuiltinFile],
}

// --- The embedded built-in registry. Adding a new built-in is a small edit:
//     embed its files and add a `BuiltinMotif` entry below. ---

// NOTE: manifest.json is intentionally not embedded in v1 — props come from the
// capture command, not from parsing the manifest. Embed it in Plan 2 when prop
// canonicalization moves Rust-side.
const COUNTDOWN: BuiltinMotif = BuiltinMotif {
    id: "countdown",
    files: &[BuiltinFile {
        rel: "index.html",
        bytes: include_bytes!("builtin/countdown/index.html"),
    }],
};

const BUILTINS: &[BuiltinMotif] = &[COUNTDOWN];

/// Look up an embedded file by `(id, rel)`.
fn lookup(id: &str, rel: &str) -> Option<&'static [u8]> {
    let motif = BUILTINS.iter().find(|m| m.id == id)?;
    motif
        .files
        .iter()
        .find(|f| f.rel == rel)
        .map(|f| f.bytes)
}

/// Guess a `Content-Type` from a file's extension. Defaults to
/// `application/octet-stream` for unknown extensions.
fn content_type_for(rel: &str) -> &'static str {
    let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

/// The locked-down Content-Security-Policy served with every Motif document.
///
/// `default-src 'none'` denies everything not explicitly re-allowed; in
/// particular there is no `connect-src`, so it inherits `'none'` and the Motif
/// cannot make any network request (fetch/XHR/WebSocket). Inline `<script>` and
/// `<style>` are allowed (Motifs are authored as single self-contained HTML
/// files); images and fonts may be inline `data:` URIs or same-scheme assets.
fn csp() -> String {
    format!(
        "default-src 'none'; \
         script-src 'unsafe-inline'; \
         style-src 'unsafe-inline'; \
         img-src data: {origin}; \
         font-src data: {origin}",
        origin = SCHEME_ORIGIN
    )
}

/// Parse the request path into `(id, rest)`.
///
/// The request URI is `http://motif.localhost/<id>/<rest...>`. `Request::uri()`
/// gives us the full URL; we take the path component and split off the first
/// segment as the Motif id, leaving the remainder as the relative file path.
fn parse_path(uri_path: &str) -> Option<(String, String)> {
    let trimmed = uri_path.trim_start_matches('/');
    let mut parts = trimmed.splitn(2, '/');
    let id = parts.next()?;
    if id.is_empty() {
        return None;
    }
    let rest = parts.next().unwrap_or("index.html");
    // Empty rest (e.g. `/<id>/`) → default document.
    let rest = if rest.is_empty() { "index.html" } else { rest };
    Some((id.to_string(), rest.to_string()))
}

/// Build a 404 response.
fn not_found(msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(404)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// The synchronous `motif:` scheme handler. Maps
/// `http://motif.localhost/<id>/<rest>` to the embedded bytes of built-in
/// Motif `<id>`'s file `<rest>` (defaulting to `index.html`).
pub fn handle_request<R: tauri::Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let uri = request.uri();
    let path = uri.path();
    let Some((id, rest)) = parse_path(path) else {
        return not_found("motif: malformed path (expected /<id>/<file>)");
    };

    let Some(bytes) = lookup(&id, &rest) else {
        return not_found(&format!("motif: no built-in file '{id}/{rest}'"));
    };

    let content_type = content_type_for(&rest);
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, csp())
        // The capture path reads pixels via CDP `Page.captureScreenshot`, which
        // is not subject to canvas cross-origin tainting; this CORP/COEP-free
        // response is fine. No caching headers — the host window loads each id
        // once and we want a clean reload to re-fetch.
        .body(bytes.to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_id_and_default_index() {
        assert_eq!(
            parse_path("/countdown/"),
            Some(("countdown".into(), "index.html".into()))
        );
        assert_eq!(
            parse_path("/countdown"),
            Some(("countdown".into(), "index.html".into()))
        );
        assert_eq!(
            parse_path("/countdown/index.html"),
            Some(("countdown".into(), "index.html".into()))
        );
    }

    #[test]
    fn parses_nested_asset() {
        assert_eq!(
            parse_path("/countdown/assets/font.woff2"),
            Some(("countdown".into(), "assets/font.woff2".into()))
        );
    }

    #[test]
    fn rejects_empty_id() {
        assert_eq!(parse_path("/"), None);
        assert_eq!(parse_path(""), None);
    }

    #[test]
    fn looks_up_embedded_countdown_index() {
        let bytes = lookup("countdown", "index.html").expect("countdown index embedded");
        assert!(!bytes.is_empty());
        // sanity: it's the countdown HTML
        let s = std::str::from_utf8(bytes).unwrap();
        assert!(s.contains("motif.define"));
    }

    #[test]
    fn unknown_file_is_none() {
        assert!(lookup("countdown", "nope.html").is_none());
        assert!(lookup("nope", "index.html").is_none());
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type_for("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type_for("assets/x.woff2"), "font/woff2");
        assert_eq!(content_type_for("a.png"), "image/png");
        assert_eq!(content_type_for("weird"), "application/octet-stream");
    }

    #[test]
    fn csp_blocks_network_and_allows_inline() {
        let c = csp();
        assert!(c.contains("default-src 'none'"));
        assert!(c.contains("script-src 'unsafe-inline'"));
        assert!(!c.contains("connect-src"));
        assert!(c.contains(SCHEME_ORIGIN));
    }
}
