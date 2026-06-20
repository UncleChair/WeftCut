//! Built-in Motif bundles, embedded into the binary.
//!
//! A built-in Motif is an `index.html` (+ optional sibling assets) shipped in
//! `motifs/catalog/<id>/`. The files are embedded with `include_str!` /
//! `include_bytes!` so they travel with the binary and need no on-disk install.
//!
//! ## Embedded-bytes registry
//!
//! `resolve_bytes(store, id, rest)` looks up a `(id, rel)` pair: embedded
//! built-ins win; the on-disk user-Motif store is the fallback. The Electron
//! main process calls `motif_resolve_file` (backed by this) to serve files over
//! `protocol.handle`.

/// The custom URI scheme name. The window URL and request origin are derived
/// from this (`motif://...`).
pub const SCHEME: &str = "motif";

/// The scheme origin, as the browser sees it. Used both to build window URLs
/// and inside CSP (`img-src`/`font-src` allowance).
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

// NOTE: this registry embeds only the files served over `protocol.handle` to the
// capture host (index.html + assets). The manifest is embedded separately by
// `catalog.rs` (`builtin_motif!`) for Rust-side prop canonicalization.
const COUNTDOWN: BuiltinMotif = BuiltinMotif {
    id: "countdown",
    files: &[BuiltinFile {
        rel: "index.html",
        bytes: include_bytes!("catalog/countdown/index.html"),
    }],
};

const LOWER_THIRD: BuiltinMotif = BuiltinMotif {
    id: "lower-third",
    files: &[
        BuiltinFile {
            rel: "index.html",
            bytes: include_bytes!("catalog/lower-third/index.html"),
        },
        BuiltinFile {
            rel: "assets/Inter.woff2",
            bytes: include_bytes!("catalog/lower-third/assets/Inter.woff2"),
        },
    ],
};

const TEXT_FX: BuiltinMotif = BuiltinMotif {
    id: "text-fx",
    files: &[
        BuiltinFile {
            rel: "index.html",
            bytes: include_bytes!("catalog/text-fx/index.html"),
        },
        BuiltinFile {
            rel: "assets/Inter.woff2",
            bytes: include_bytes!("catalog/text-fx/assets/Inter.woff2"),
        },
    ],
};

const BUILTINS: &[BuiltinMotif] = &[COUNTDOWN, LOWER_THIRD, TEXT_FX];

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
pub fn content_type_for(rel: &str) -> &'static str {
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

/// Resolve a `(id, rest)` request to bytes: embedded built-in first, then the
/// on-disk user-Motif store. Built-ins always win, so an uploaded Motif can
/// never shadow one. Returned as an owned `Vec` to unify the `&'static`
/// built-in path with the heap-read store path.
pub fn resolve_bytes(
    store: Option<&crate::motifs::store::UserMotifStore>,
    id: &str,
    rest: &str,
) -> Option<Vec<u8>> {
    if let Some(b) = lookup(id, rest) {
        return Some(b.to_vec());
    }
    store.and_then(|s| s.read_file(id, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_up_embedded_countdown_index() {
        let bytes = lookup("countdown", "index.html").expect("countdown index embedded");
        assert!(!bytes.is_empty());
        // sanity: it's the countdown HTML
        let s = std::str::from_utf8(bytes).unwrap();
        assert!(s.contains("motif.define"));
    }

    #[test]
    fn serves_lower_third_font_asset() {
        let bytes = lookup("lower-third", "assets/Inter.woff2")
            .expect("lower-third font embedded");
        assert!(!bytes.is_empty());
        assert_eq!(content_type_for("assets/Inter.woff2"), "font/woff2");
    }

    #[test]
    fn serves_text_fx_index_and_font() {
        let html = lookup("text-fx", "index.html").expect("text-fx index embedded");
        assert!(std::str::from_utf8(html).unwrap().contains("motif.define"));
        let font = lookup("text-fx", "assets/Inter.woff2").expect("text-fx font embedded");
        assert!(!font.is_empty());
    }

    #[test]
    fn looks_up_embedded_lower_third_index() {
        let bytes = lookup("lower-third", "index.html").expect("lower-third index embedded");
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
    fn resolve_prefers_builtin_then_store() {
        use crate::motifs::store::UserMotifStore;
        let tmp = tempfile::tempdir().unwrap();
        // A user Motif on disk.
        let dir = tmp.path().join("user-z");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), b"<html>user-z</html>").unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());

        // Built-in wins even if a same-id dir existed; here ids differ.
        let builtin = resolve_bytes(Some(&store), "countdown", "index.html").unwrap();
        assert!(std::str::from_utf8(&builtin).unwrap().contains("motif.define"));

        // User Motif served from the store fallback.
        let user = resolve_bytes(Some(&store), "user-z", "index.html").unwrap();
        assert_eq!(user, b"<html>user-z</html>".to_vec());

        // Unknown → None.
        assert!(resolve_bytes(Some(&store), "nope", "index.html").is_none());
    }
}
