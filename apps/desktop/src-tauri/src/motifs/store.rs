//! The on-disk store of user-installed Motifs, rooted at
//! `<app_config_dir>/motifs/`.
//!
//! Layout: `<root>/<id>/index.html` (a single self-contained document whose
//! manifest is a `<script type="application/json" id="motif-manifest">` island)
//! plus optional `<root>/<id>/assets/...`. The reserved `<root>/drafts/`
//! subtree is for Stage 2 (work-in-progress drafts) and is skipped here.
//!
//! Stage 1 only READS this store; nothing writes user Motifs yet (tests place
//! files directly). All path resolution is component-validated so a served
//! `motif://<id>/<rest>` request can never escape the Motif's own directory.

use std::path::{Path, PathBuf};

use super::catalog::{parse_manifest_island, Manifest};

/// Directory name reserved for Stage-2 drafts; never treated as an installed
/// Motif id.
pub const DRAFTS_DIR: &str = "drafts";

/// The global user-Motif store. Cheap to clone-by-reference via Tauri state.
pub struct UserMotifStore {
    root: PathBuf,
}

/// Validate a `/`-separated relative path into safe OS path components.
///
/// Rejects anything that could escape the Motif directory: empty segments,
/// `.`/`..`, absolute paths, Windows drive letters (`:`), and backslashes.
/// Returns the rejoined relative `PathBuf` on success.
fn safe_rel(rel: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        if seg.contains('\\') || seg.contains(':') {
            return None;
        }
        out.push(seg);
    }
    if out.as_os_str().is_empty() {
        return None;
    }
    Some(out)
}

impl UserMotifStore {
    /// Root at `<app_config_dir>/motifs/`. Does not create the directory; a
    /// missing root simply yields an empty catalog.
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Read a file from `<root>/<id>/<rel>`, path-safely. `None` if `id`/`rel`
    /// are unsafe or the file does not exist.
    pub fn read_file(&self, id: &str, rel: &str) -> Option<Vec<u8>> {
        let safe_id = safe_rel(id)?;
        let safe = safe_rel(rel)?;
        let path = self.root.join(safe_id).join(safe);
        std::fs::read(path).ok()
    }

    /// Read a user Motif's `index.html` as a string.
    pub fn read_html(&self, id: &str) -> Option<String> {
        self.read_file(id, "index.html")
            .and_then(|b| String::from_utf8(b).ok())
    }

    /// Every installed user Motif's manifest, id-sorted. Subdirectories whose
    /// `index.html` is missing or whose island fails to parse are skipped (with
    /// a warning); the reserved `drafts/` subtree is ignored.
    pub fn list_manifests(&self) -> Vec<Manifest> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if entry.file_name() == DRAFTS_DIR {
                continue;
            }
            let Ok(html) = std::fs::read_to_string(path.join("index.html")) else {
                continue;
            };
            match parse_manifest_island(&html) {
                Ok(m) => out.push(m),
                Err(e) => tracing::warn!(
                    "user motif {:?}: bad manifest island: {e}",
                    entry.file_name()
                ),
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_motif(root: &Path, id: &str, manifest_json: &str) {
        let dir = root.join(id);
        fs::create_dir_all(dir.join("assets")).unwrap();
        let html = format!(
            r#"<script type="application/json" id="motif-manifest">{manifest_json}</script>
<script>motif.define({{ setup(){{}} }});</script>"#
        );
        fs::write(dir.join("index.html"), html).unwrap();
        fs::write(dir.join("assets").join("logo.svg"), b"<svg/>").unwrap();
    }

    #[test]
    fn rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        assert!(store.read_file("user-x", "../secret.txt").is_none());
        assert!(store.read_file("user-x", "a/../../b").is_none());
        assert!(store.read_file("..", "index.html").is_none());
        assert!(store.read_file("user-x", "/etc/hosts").is_none());
        assert!(store.read_file("user-x", "a\\b").is_none());
    }

    #[test]
    fn reads_an_existing_asset() {
        let tmp = tempfile::tempdir().unwrap();
        write_motif(
            tmp.path(),
            "user-x",
            r#"{"id":"user-x","name":"X","version":1,"size":[10,10],"default_duration_s":1.0,"props_schema":{}}"#,
        );
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        assert_eq!(store.read_file("user-x", "assets/logo.svg"), Some(b"<svg/>".to_vec()));
        assert!(store.read_html("user-x").unwrap().contains("motif.define"));
    }

    #[test]
    fn lists_installed_skipping_drafts_and_broken() {
        let tmp = tempfile::tempdir().unwrap();
        write_motif(
            tmp.path(),
            "user-a",
            r#"{"id":"user-a","name":"A","version":1,"size":[10,10],"default_duration_s":1.0,"props_schema":{}}"#,
        );
        // A draft dir (reserved) and a broken motif (no island) must be ignored.
        fs::create_dir_all(tmp.path().join("drafts").join("wip")).unwrap();
        fs::write(tmp.path().join("drafts").join("wip").join("index.html"), "draft").unwrap();
        fs::create_dir_all(tmp.path().join("broken")).unwrap();
        fs::write(tmp.path().join("broken").join("index.html"), "<html>no island</html>").unwrap();

        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let ids: Vec<String> = store.list_manifests().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["user-a".to_string()]);
    }

    #[test]
    fn missing_root_is_empty() {
        let store = UserMotifStore::new(PathBuf::from("/no/such/dir/at/all"));
        assert!(store.list_manifests().is_empty());
        assert!(store.read_html("anything").is_none());
    }
}
