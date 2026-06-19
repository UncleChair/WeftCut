//! Per-user keyboard-shortcut overrides persisted in `app_config_dir`.
//!
//! The frontend `shortcuts/` module owns the static `ACTION_DEFS`
//! catalogue (action ids + default chord strings). This file is a dumb
//! JSON-backed key/value store that holds *only* the user's overrides —
//! actions that aren't in the file fall back to the frontend defaults
//! at dispatch time.
//!
//! Why the backend stays "dumb" (no conflict detection, no chord
//! parsing):
//!  - The frontend already owns `ACTION_DEFS` and parses bindings via
//!    `match.ts`. Duplicating that in Rust would mean two sources of
//!    truth for the chord DSL.
//!  - The only writer is the Keyboard Shortcuts panel in
//!    `SettingsPanel.tsx`, which performs the conflict check before
//!    calling `keybindings_set`. The store trusts its caller.
//!  - A hand-edited file with overlapping bindings is tolerated — the
//!    dispatcher picks the first matching entry and the conflict
//!    self-resolves when the user next opens the panel.
//!
//! File layout (`<app_config_dir>/keybindings.json`):
//!
//! ```json
//! {
//!   "overrides": {
//!     "undo": ["Mod+Z", "F3"],
//!     "togglePlay": ["Mod+Space"]
//!   }
//! }
//! ```
//!
//! Actions not listed inherit their defaults. An empty `keys` array
//! means "explicitly unbound" — different from "use the default."

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const KEYBINDINGS_FILE: &str = "keybindings.json";

/// Map of action id → list of binding strings (e.g. `"Mod+S"`,
/// `"Delete"`). Action ids are opaque strings on the Rust side — the
/// frontend validates them against `ACTION_DEFS`.
pub type KeybindingsMap = BTreeMap<String, Vec<String>>;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct KeybindingsFile {
    #[serde(default)]
    overrides: KeybindingsMap,
}

/// napi-managed store. Holds the path to `keybindings.json` and
/// serialises reads/writes through an `RwLock`. Reads are cheap (one
/// `fs::read_to_string` + `serde_json::from_str` per call); we don't
/// cache in memory because the panel writes are infrequent and a
/// stale cache adds invalidation complexity without saving real time.
#[derive(Clone)]
pub struct KeybindingsStore {
    path: Arc<RwLock<PathBuf>>,
}

impl KeybindingsStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            path: Arc::new(RwLock::new(config_dir.join(KEYBINDINGS_FILE))),
        }
    }

    fn read(&self) -> Result<KeybindingsFile> {
        let path = self.path.read().expect("keybindings path lock").clone();
        if !path.exists() {
            return Ok(KeybindingsFile::default());
        }
        let body = fs::read_to_string(&path)
            .with_context(|| format!("read {}", path.display()))?;
        if body.trim().is_empty() {
            return Ok(KeybindingsFile::default());
        }
        serde_json::from_str(&body).with_context(|| format!("parse {}", path.display()))
    }

    fn write(&self, file: &KeybindingsFile) -> Result<()> {
        let path = self.path.read().expect("keybindings path lock").clone();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(file).context("serialize keybindings")?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
        fs::rename(&tmp, &path)
            .with_context(|| format!("promote {} -> {}", tmp.display(), path.display()))?;
        Ok(())
    }

    /// Current overrides map. Missing actions inherit the frontend
    /// defaults — that fall-back is computed on the frontend at
    /// dispatch time.
    pub fn get(&self) -> Result<KeybindingsMap> {
        Ok(self.read()?.overrides)
    }

    /// Set the bindings for a single action. Passing an empty `keys`
    /// vector explicitly unbinds the action (no shortcut fires for it
    /// until the user re-adds one or resets).
    ///
    /// Conflict detection happens on the frontend before calling this
    /// — the store trusts its caller. See module-level comment.
    pub fn set(&self, action: String, keys: Vec<String>) -> Result<()> {
        let mut file = self.read().unwrap_or_default();
        file.overrides.insert(action, keys);
        self.write(&file)
    }

    /// Wipe every override. Effective bindings revert to the
    /// frontend defaults. Atomic — the file is replaced in one
    /// `rename` so there's no half-reset state observable on disk.
    pub fn reset_all(&self) -> Result<()> {
        self.write(&KeybindingsFile::default())
    }

    /// Copy the current `keybindings.json` to `dest`. If no file
    /// exists yet (user hasn't customized anything), we emit an empty
    /// `{"overrides":{}}` file so the user gets a valid template.
    pub fn export_to(&self, dest: PathBuf) -> Result<()> {
        let file = self.read().unwrap_or_default();
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(&file).context("serialize keybindings")?;
        fs::write(&dest, json).with_context(|| format!("write {}", dest.display()))
    }

    /// Replace the current `keybindings.json` with the contents of
    /// `src`. Validates the source parses as a `KeybindingsFile` —
    /// invalid JSON bails before touching the live file so a bad
    /// import can't brick the user's setup.
    pub fn import_from(&self, src: &Path) -> Result<KeybindingsMap> {
        let body = fs::read_to_string(src)
            .with_context(|| format!("read {}", src.display()))?;
        let file: KeybindingsFile = serde_json::from_str(&body)
            .with_context(|| format!("parse {}", src.display()))?;
        self.write(&file)?;
        Ok(file.overrides)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh(tmp: &TempDir) -> KeybindingsStore {
        KeybindingsStore::new(tmp.path().to_path_buf())
    }

    #[test]
    fn empty_when_no_file_yet() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        assert!(store.get().unwrap().is_empty());
    }

    #[test]
    fn set_round_trips() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        store.set("undo".into(), vec!["F3".into()]).unwrap();
        let got = store.get().unwrap();
        assert_eq!(got.get("undo"), Some(&vec!["F3".into()]));
    }

    #[test]
    fn set_overwrites_existing_action() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        store
            .set("undo".into(), vec!["Mod+Z".into(), "F3".into()])
            .unwrap();
        store.set("undo".into(), vec!["Mod+Z".into()]).unwrap();
        assert_eq!(
            store.get().unwrap().get("undo"),
            Some(&vec!["Mod+Z".into()])
        );
    }

    #[test]
    fn empty_keys_means_explicitly_unbound() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        store.set("undo".into(), vec![]).unwrap();
        // Distinct from "no entry"; the empty vec persists so the
        // dispatcher knows the user actively unbound this action.
        assert_eq!(store.get().unwrap().get("undo"), Some(&vec![]));
    }

    #[test]
    fn reset_all_clears_everything() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        store.set("undo".into(), vec!["F3".into()]).unwrap();
        store
            .set("save".into(), vec!["Ctrl+Alt+S".into()])
            .unwrap();
        store.reset_all().unwrap();
        assert!(store.get().unwrap().is_empty());
    }

    #[test]
    fn export_and_reimport_round_trips() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("backup.json");
        let store = fresh(&tmp);
        store.set("undo".into(), vec!["F3".into()]).unwrap();
        store.export_to(dest.clone()).unwrap();
        store.reset_all().unwrap();
        assert!(store.get().unwrap().is_empty());
        let restored = store.import_from(&dest).unwrap();
        assert_eq!(restored.get("undo"), Some(&vec!["F3".into()]));
        // The store reflects the imported file, not just the return
        // value.
        assert_eq!(
            store.get().unwrap().get("undo"),
            Some(&vec!["F3".into()])
        );
    }

    #[test]
    fn import_rejects_invalid_json() {
        let tmp = TempDir::new().unwrap();
        let bad = tmp.path().join("broken.json");
        fs::write(&bad, "{ not json").unwrap();
        let store = fresh(&tmp);
        // Pre-existing override survives a failed import.
        store.set("undo".into(), vec!["F3".into()]).unwrap();
        assert!(store.import_from(&bad).is_err());
        assert_eq!(
            store.get().unwrap().get("undo"),
            Some(&vec!["F3".into()])
        );
    }

    #[test]
    fn tolerates_empty_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(KEYBINDINGS_FILE);
        fs::write(&path, "").unwrap();
        let store = fresh(&tmp);
        assert!(store.get().unwrap().is_empty());
        // And we can still write to it.
        store.set("undo".into(), vec!["F3".into()]).unwrap();
        assert_eq!(store.get().unwrap().len(), 1);
    }
}

