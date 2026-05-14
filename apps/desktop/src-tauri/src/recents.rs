//! Recent-projects list + app-level prefs persisted in `app_config_dir`.
//!
//! Per `docs/workspace-redesign.md` Q7 the startup screen surfaces the last
//! 10 workspaces. Schema is intentionally tiny — path + display name + last
//! opened — and lives in `<app_config_dir>/recents.json` as plain JSON so a
//! user can hand-edit / reset by deleting the file.
//!
//! "Reopen last project on launch" (Q7 sub-decision, default off) lives in
//! the same file so the startup screen doesn't have to read two files.
//! It's deliberately opt-in: a partial-commit state at crash time should not
//! silently re-mount on the next boot.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tracing::warn;

const RECENTS_FILE: &str = "recents.json";
const MAX_RECENTS: usize = 10;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: PathBuf,
    pub name: String,
    pub last_opened: DateTime<Utc>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct RecentsFile {
    #[serde(default)]
    reopen_on_launch: bool,
    #[serde(default)]
    entries: Vec<RecentEntry>,
    /// Parent folder of the last project the user created via the
    /// "+ New project" form. The startup screen pre-fills this so the
    /// next new project lands next to the previous one without
    /// re-navigating from `C:\Users\<name>\`. Falls back to the OS
    /// Documents directory in the UI when this is `None` (first launch).
    #[serde(default)]
    last_new_project_parent: Option<PathBuf>,
}

/// Tauri-managed recents store. Holds the path to `recents.json` and
/// serialises reads/writes through an RwLock; per-startup-screen access
/// cost is one file read + JSON parse, so caching isn't worth the
/// invalidation complexity.
#[derive(Clone)]
pub struct RecentsStore {
    path: Arc<RwLock<PathBuf>>,
}

impl RecentsStore {
    /// Create a store rooted at `<app_config_dir>/recents.json`. Caller is
    /// responsible for ensuring `config_dir` exists.
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            path: Arc::new(RwLock::new(config_dir.join(RECENTS_FILE))),
        }
    }

    fn read(&self) -> Result<RecentsFile> {
        let path = self.path.read().expect("recents path lock").clone();
        if !path.exists() {
            return Ok(RecentsFile::default());
        }
        let body = fs::read_to_string(&path)
            .with_context(|| format!("read {}", path.display()))?;
        if body.trim().is_empty() {
            return Ok(RecentsFile::default());
        }
        serde_json::from_str(&body).with_context(|| format!("parse {}", path.display()))
    }

    fn write(&self, file: &RecentsFile) -> Result<()> {
        let path = self.path.read().expect("recents path lock").clone();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(file).context("serialize recents")?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
        fs::rename(&tmp, &path)
            .with_context(|| format!("promote {} -> {}", tmp.display(), path.display()))?;
        Ok(())
    }

    /// Push `(path, name)` to the top of the list, deduping by canonical
    /// path (case-insensitive on Windows is good enough — the user picked
    /// the same folder). Truncates to `MAX_RECENTS`. Idempotent on retry;
    /// a failed write is logged but doesn't propagate to the caller —
    /// recents is best-effort UX, not a correctness anchor.
    pub fn push(&self, path: PathBuf, name: String) {
        let now = Utc::now();
        let mut file = match self.read() {
            Ok(f) => f,
            Err(e) => {
                warn!("recents read failed, starting fresh: {e:#}");
                RecentsFile::default()
            }
        };
        file.entries.retain(|e| !same_path(&e.path, &path));
        file.entries.insert(
            0,
            RecentEntry {
                path,
                name,
                last_opened: now,
            },
        );
        file.entries.truncate(MAX_RECENTS);
        if let Err(e) = self.write(&file) {
            warn!("recents write failed: {e:#}");
        }
    }

    /// Remove an entry by path. No-op if the path isn't in the list.
    pub fn remove(&self, path: &Path) -> Result<()> {
        let mut file = self.read()?;
        file.entries.retain(|e| !same_path(&e.path, path));
        self.write(&file)
    }

    /// Read the current list, newest first.
    pub fn list(&self) -> Result<Vec<RecentEntry>> {
        Ok(self.read()?.entries)
    }

    /// Top entry, if any. Used by the "Reopen last project on launch" path.
    pub fn most_recent(&self) -> Result<Option<RecentEntry>> {
        Ok(self.read()?.entries.into_iter().next())
    }

    pub fn reopen_on_launch(&self) -> Result<bool> {
        Ok(self.read()?.reopen_on_launch)
    }

    pub fn set_reopen_on_launch(&self, value: bool) -> Result<()> {
        let mut file = self.read().unwrap_or_default();
        if file.reopen_on_launch == value {
            return Ok(());
        }
        file.reopen_on_launch = value;
        self.write(&file)
    }

    /// Last parent folder used in the "+ New project" form. The startup
    /// screen pre-fills "Save in" with this so the user doesn't have to
    /// re-navigate from the OS root every time. `None` on first launch —
    /// the UI falls back to the OS Documents directory.
    pub fn last_new_project_parent(&self) -> Result<Option<PathBuf>> {
        Ok(self.read()?.last_new_project_parent)
    }

    /// Record the parent folder of the just-created workspace. Called by
    /// `project_new_workspace` on success. Best-effort: any error is
    /// logged but doesn't propagate to the caller — losing the default
    /// folder is mild UX regression, not a correctness anchor.
    pub fn set_last_new_project_parent(&self, parent: PathBuf) {
        let mut file = match self.read() {
            Ok(f) => f,
            Err(e) => {
                warn!("recents read failed, starting fresh: {e:#}");
                RecentsFile::default()
            }
        };
        file.last_new_project_parent = Some(parent);
        if let Err(e) = self.write(&file) {
            warn!("recents write failed: {e:#}");
        }
    }
}

#[cfg(target_os = "windows")]
fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

#[cfg(not(target_os = "windows"))]
fn same_path(a: &Path, b: &Path) -> bool {
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh(tmp: &TempDir) -> RecentsStore {
        RecentsStore::new(tmp.path().to_path_buf())
    }

    #[test]
    fn empty_when_no_file_yet() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        assert!(store.list().unwrap().is_empty());
        assert!(store.most_recent().unwrap().is_none());
        assert!(!store.reopen_on_launch().unwrap());
    }

    #[test]
    fn push_dedupes_and_caps() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        for i in 0..15 {
            store.push(PathBuf::from(format!("/proj/p{i}")), format!("p{i}"));
        }
        let entries = store.list().unwrap();
        assert_eq!(entries.len(), MAX_RECENTS);
        // Most recent first.
        assert_eq!(entries[0].name, "p14");

        // Re-push an existing entry — should move to top, not duplicate.
        store.push(PathBuf::from("/proj/p10"), "p10".into());
        let entries = store.list().unwrap();
        assert_eq!(entries.len(), MAX_RECENTS);
        assert_eq!(entries[0].name, "p10");
    }

    #[test]
    fn remove_drops_entry() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        store.push(PathBuf::from("/proj/a"), "a".into());
        store.push(PathBuf::from("/proj/b"), "b".into());
        store.remove(Path::new("/proj/a")).unwrap();
        let entries = store.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "b");
    }

    #[test]
    fn reopen_on_launch_round_trips() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        assert!(!store.reopen_on_launch().unwrap());
        store.set_reopen_on_launch(true).unwrap();
        assert!(store.reopen_on_launch().unwrap());
        store.set_reopen_on_launch(false).unwrap();
        assert!(!store.reopen_on_launch().unwrap());
    }

    #[test]
    fn last_new_project_parent_round_trips() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        assert!(store.last_new_project_parent().unwrap().is_none());
        store.set_last_new_project_parent(PathBuf::from("/projects/area"));
        assert_eq!(
            store.last_new_project_parent().unwrap(),
            Some(PathBuf::from("/projects/area")),
        );
        // Overwrite — UI re-records on every new project.
        store.set_last_new_project_parent(PathBuf::from("/other/area"));
        assert_eq!(
            store.last_new_project_parent().unwrap(),
            Some(PathBuf::from("/other/area")),
        );
    }
}
