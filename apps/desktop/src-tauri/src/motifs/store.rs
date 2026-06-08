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

use super::catalog::{parse_manifest_island, Manifest, Motif};

/// Directory name reserved for Stage-2 drafts; never treated as an installed
/// Motif id.
pub const DRAFTS_DIR: &str = "drafts";

/// The global user-Motif store.
/// Accessed by reference via `tauri::State<UserMotifStore>` — no `Clone`/`Arc` needed.
pub struct UserMotifStore {
    root: PathBuf,
}

/// A single safe path segment (no traversal, no separators). Errors as an
/// io::Error so it composes with the `io::Result` store methods.
fn safe_seg(seg: &str) -> std::io::Result<PathBuf> {
    if seg.is_empty()
        || seg == "."
        || seg == ".."
        || seg.contains('/')
        || seg.contains('\\')
        || seg.contains(':')
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("unsafe path segment: {seg:?}"),
        ));
    }
    Ok(PathBuf::from(seg))
}

/// Recursively copy a directory tree (rename fallback for install_draft).
fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &dst)?;
        } else {
            std::fs::copy(entry.path(), dst)?;
        }
    }
    Ok(())
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
        // The reserved drafts/ subtree is never an installed Motif id. The
        // motif:// URI handler calls read_file with an id from the URL, so this
        // guard (not just list_manifests skipping it) is what keeps WIP drafts
        // unreachable.
        if id == DRAFTS_DIR {
            return None;
        }
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

    /// Build a full `Motif` (manifest + html) for an installed user Motif by id,
    /// or `None` if absent / unreadable / not a valid island. Mirrors a built-in
    /// `Motif` so callers (e.g. `add_motif`) can resolve user Motifs the same way.
    /// The reserved `drafts/` id is never a Motif.
    pub fn get_motif(&self, id: &str) -> Option<Motif> {
        if id == DRAFTS_DIR {
            return None;
        }
        let html = self.read_html(id)?;
        let manifest = parse_manifest_island(&html).ok()?;
        Some(Motif { manifest, html })
    }

    /// `<root>/drafts/`.
    fn drafts_root(&self) -> PathBuf {
        self.root.join(DRAFTS_DIR)
    }

    /// Write a draft's composed single-file HTML to
    /// `<root>/drafts/<draft_id>/index.html`.
    pub fn write_draft(&self, draft_id: &str, html: &str) -> std::io::Result<()> {
        let dir = self.drafts_root().join(safe_seg(draft_id)?);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("index.html"), html)
    }

    /// Ids of all drafts under `<root>/drafts/`.
    pub fn list_draft_ids(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(self.drafts_root()) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    if let Some(name) = e.file_name().to_str() {
                        out.push(name.to_string());
                    }
                }
            }
        }
        out.sort();
        out
    }

    /// Build a `Motif` from a draft's `index.html`.
    pub fn get_draft(&self, draft_id: &str) -> Option<Motif> {
        let html = std::fs::read_to_string(
            self.drafts_root().join(safe_seg(draft_id).ok()?).join("index.html"),
        )
        .ok()?;
        let manifest = parse_manifest_island(&html).ok()?;
        Some(Motif { manifest, html })
    }

    /// Publish a draft: move `<root>/drafts/<draft_id>/` to `<root>/<final_id>/`.
    /// The caller has already rewritten the draft's island so `id == final_id`
    /// (the dir==id invariant). Overwrites any existing `<final_id>/` (update path).
    pub fn install_draft(&self, draft_id: &str, final_id: &str) -> std::io::Result<()> {
        let from = self.drafts_root().join(safe_seg(draft_id)?);
        let to = self.root.join(safe_seg(final_id)?);
        if to.exists() {
            std::fs::remove_dir_all(&to)?;
        }
        std::fs::create_dir_all(self.root.as_path())?;
        match std::fs::rename(&from, &to) {
            Ok(()) => Ok(()),
            Err(_) => {
                copy_dir_all(&from, &to)?;
                std::fs::remove_dir_all(&from)
            }
        }
    }

    /// Delete a published user Motif directory. The caller rejects built-in ids.
    pub fn delete_user_motif(&self, id: &str) -> std::io::Result<()> {
        let dir = self.root.join(safe_seg(id)?);
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    /// Ids of all PUBLISHED user Motifs (for uniqueness checks at install).
    pub fn published_ids(&self) -> Vec<String> {
        self.list_manifests().into_iter().map(|m| m.id).collect()
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
                Ok(m) => {
                    // TODO(stage 2): the install path must enforce manifest.id ==
                    // <dir name>; here we trust the island's id matches the dir.
                    out.push(m);
                }
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
    use super::super::authoring::compose_motif_html;
    use super::super::catalog::{parse_manifest_island, Manifest};
    use std::collections::BTreeMap;

    fn manifest(id: &str, name: &str, version: u32) -> Manifest {
        Manifest {
            id: id.into(), name: name.into(), version,
            size: [100, 100], default_duration_s: 1.0,
            max_duration_s: None, max_duration_prop: None, content_duration_s: None,
            fonts: vec![], props_schema: BTreeMap::new(),
        }
    }

    #[test]
    fn write_draft_then_list_and_get() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let html = compose_motif_html(&manifest("d1", "Draft One", 1),
            "<head></head><body><script>motif.define({setup(){}})</script></body>");
        store.write_draft("d1", &html).unwrap();
        assert_eq!(store.list_draft_ids(), vec!["d1".to_string()]);
        assert!(store.list_manifests().is_empty()); // drafts aren't published
        let got = store.get_draft("d1").expect("draft resolves");
        assert_eq!(got.id(), "d1");
    }

    #[test]
    fn install_new_publishes_and_removes_draft() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let html = compose_motif_html(&manifest("foo", "Foo", 1),
            "<head></head><body><script>motif.define({setup(){}})</script></body>");
        store.write_draft("foo", &html).unwrap();
        store.install_draft("foo", "foo").unwrap();
        let ids: Vec<String> = store.list_manifests().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["foo".to_string()]);
        assert!(store.list_draft_ids().is_empty());
        let parsed = parse_manifest_island(&store.read_html("foo").unwrap()).unwrap();
        assert_eq!(parsed.id, "foo");
    }

    #[test]
    fn delete_user_motif_removes_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let html = compose_motif_html(&manifest("foo", "Foo", 1),
            "<head></head><body><script>motif.define({setup(){}})</script></body>");
        store.write_draft("foo", &html).unwrap();
        store.install_draft("foo", "foo").unwrap();
        store.delete_user_motif("foo").unwrap();
        assert!(store.list_manifests().is_empty());
    }

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
        assert!(store.read_file("user-x", ".").is_none());
        assert!(store.read_file("user-x", "").is_none());
        assert!(store.read_file("user-x", "C:/foo").is_none());
        // The reserved drafts subtree is unreachable via read_file.
        assert!(store.read_file(DRAFTS_DIR, "index.html").is_none());
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

    #[test]
    fn get_motif_builds_full_motif_or_none() {
        let tmp = tempfile::tempdir().unwrap();
        write_motif(
            tmp.path(),
            "user-a",
            r#"{"id":"user-a","name":"A","version":1,"size":[10,10],"default_duration_s":1.0,"props_schema":{}}"#,
        );
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let m = store.get_motif("user-a").expect("user-a resolves");
        assert_eq!(m.id(), "user-a");
        assert!(m.html.contains("motif.define"));
        // Absent id and the reserved drafts id resolve to None.
        assert!(store.get_motif("nope").is_none());
        assert!(store.get_motif(DRAFTS_DIR).is_none());
    }
}
