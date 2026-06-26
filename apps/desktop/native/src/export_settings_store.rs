//! Per-workspace export settings persisted as `<workspace>/export.json`.
//!
//! Opaque to Rust: the renderer owns the schema (codec/resolution/quality/etc).
//! This is a dumb typed key/value — the encoder config is assembled in the
//! renderer and never round-trips through here. Kept in a SEPARATE file from
//! `view.json` so the timeline's whole-file view-state writer can never
//! clobber export settings (two independent writers, one file = data loss).
//!
//! Atomic write pattern mirrors `keybindings.rs` (temp file + rename).

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

const EXPORT_FILE: &str = "export.json";

/// Read export settings from `<workspace>/export.json`. Returns `None` if the
/// file is missing, empty, or unreadable — the renderer falls back to defaults.
pub fn load(workspace: &Path) -> Option<serde_json::Value> {
    let path = workspace.join(EXPORT_FILE);
    if !path.exists() {
        return None;
    }
    let body = match fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("export_settings read failed ({}): {e:#}", path.display());
            return None;
        }
    };
    if body.trim().is_empty() {
        return None;
    }
    match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("export_settings parse failed ({}): {e:#}", path.display());
            None
        }
    }
}

/// Atomically write export settings to `<workspace>/export.json`.
pub fn save(workspace: &Path, settings: &serde_json::Value) -> Result<()> {
    fs::create_dir_all(workspace)
        .with_context(|| format!("create {}", workspace.display()))?;
    let path = workspace.join(EXPORT_FILE);
    let json = serde_json::to_string_pretty(settings).context("serialize export settings")?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .with_context(|| format!("promote {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn none_when_missing() {
        let tmp = TempDir::new().unwrap();
        assert!(load(tmp.path()).is_none());
    }

    #[test]
    fn round_trip() {
        let tmp = TempDir::new().unwrap();
        let value = serde_json::json!({ "codec": "av1", "quality": "high" });
        save(tmp.path(), &value).unwrap();
        assert_eq!(load(tmp.path()), Some(value));
    }

    #[test]
    fn none_on_garbage() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(EXPORT_FILE), "{ not json").unwrap();
        assert!(load(tmp.path()).is_none());
    }
}
