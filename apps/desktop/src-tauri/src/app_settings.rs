//! Per-user app-level preferences persisted in `app_config_dir`
//! (`docs/ab-roll-redesign`). Strict app-level scope: every project opens
//! under the same value; the inline pill / View menu / `T` shortcut
//! mutate the value here directly. No per-project override.
//!
//! Today this holds:
//!   - `display_mode`: `AbRoll` (default) | `ShowAll` — drives the
//!     timeline's track filter.
//!   - `delta_window_us`: half-width of the right-panel peek list's
//!     symmetric window around the playhead. Default 10 s.
//!   - `media_pool_drawer_open`: remembered last-toggle of the left
//!     MediaPool drawer. False by default; `M` shortcut flips it.
//!   - `tail_snap_enabled`: when true, dragging a timeline layer near
//!     another layer boundary or the playhead snaps the moved layer start there.
//!   - `tail_snap_strength_px`: pixel threshold for that boundary snap.
//!   - `prebake_templates`: when true, template layers pre-bake their frames
//!     to disk (L2). False by default.
//!
//! File layout (`<app_config_dir>/app_settings.json`):
//!
//! ```json
//! {
//!   "display_mode": "AbRoll",
//!   "delta_window_us": 10000000,
//!   "media_pool_drawer_open": false,
//!   "tail_snap_enabled": true,
//!   "tail_snap_strength_px": 12,
//!   "prebake_templates": false
//! }
//! ```
//!
//! Missing fields inherit defaults via `#[serde(default = ...)]`. A
//! corrupt or unreadable file degrades to all-defaults so a hand-edit
//! mishap can't brick the editor.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const APP_SETTINGS_FILE: &str = "app_settings.json";
const MIN_TAIL_SNAP_STRENGTH_PX: u32 = 2;
const MAX_TAIL_SNAP_STRENGTH_PX: u32 = 80;

/// Display mode for the timeline. Authoritative state for the AB filter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DisplayMode {
    /// Show only role-stamped tracks (Video A/B, Audio A/B). Default for
    /// new installs.
    AbRoll,
    /// Show every track. Required for legacy projects (no role stamps)
    /// and for users editing music videos / multicam where they want
    /// every layer visible.
    ShowAll,
}

impl Default for DisplayMode {
    fn default() -> Self {
        Self::AbRoll
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub display_mode: DisplayMode,
    #[serde(default = "default_delta_window_us")]
    pub delta_window_us: i64,
    #[serde(default)]
    pub media_pool_drawer_open: bool,
    #[serde(default = "default_tail_snap_enabled")]
    pub tail_snap_enabled: bool,
    #[serde(default = "default_tail_snap_strength_px")]
    pub tail_snap_strength_px: u32,
    #[serde(default)]
    pub prebake_templates: bool,
}

fn default_delta_window_us() -> i64 {
    10_000_000
}

fn default_tail_snap_enabled() -> bool {
    true
}

fn default_tail_snap_strength_px() -> u32 {
    12
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            display_mode: DisplayMode::default(),
            delta_window_us: default_delta_window_us(),
            media_pool_drawer_open: false,
            tail_snap_enabled: default_tail_snap_enabled(),
            tail_snap_strength_px: default_tail_snap_strength_px(),
            prebake_templates: false,
        }
    }
}

/// Patch shape coming over IPC. Every field is optional so the UI can
/// send tiny diffs ("just flip display_mode") without echoing the rest.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct AppSettingsPatch {
    pub display_mode: Option<DisplayMode>,
    pub delta_window_us: Option<i64>,
    pub media_pool_drawer_open: Option<bool>,
    pub tail_snap_enabled: Option<bool>,
    pub tail_snap_strength_px: Option<u32>,
    pub prebake_templates: Option<bool>,
}

/// Tauri-managed store. JSON-backed, lock-protected path. Loosely
/// modelled on `KeybindingsStore` — same single-writer / atomic-rename
/// discipline.
#[derive(Clone)]
pub struct AppSettingsStore {
    path: Arc<RwLock<PathBuf>>,
}

impl AppSettingsStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            path: Arc::new(RwLock::new(config_dir.join(APP_SETTINGS_FILE))),
        }
    }

    fn read(&self) -> AppSettings {
        let path = self.path.read().expect("app_settings path lock").clone();
        if !path.exists() {
            return AppSettings::default();
        }
        let body = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("app_settings read {}: {e:#}", path.display());
                return AppSettings::default();
            }
        };
        if body.trim().is_empty() {
            return AppSettings::default();
        }
        match serde_json::from_str::<AppSettings>(&body) {
            Ok(s) => s,
            Err(e) => {
                // Bad-config recovery: tolerate a corrupt file rather
                // than crashing the editor on launch. Log so the user
                // can see something went wrong if they look.
                tracing::warn!("app_settings parse {}: {e:#}", path.display());
                AppSettings::default()
            }
        }
    }

    fn write(&self, settings: &AppSettings) -> Result<()> {
        let path = self.path.read().expect("app_settings path lock").clone();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(settings).context("serialize app_settings")?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
        fs::rename(&tmp, &path)
            .with_context(|| format!("promote {} -> {}", tmp.display(), path.display()))?;
        Ok(())
    }

    pub fn get(&self) -> AppSettings {
        self.read()
    }

    /// Apply a patch atomically. Returns the post-patch settings so the
    /// caller can emit the change-event without a second read.
    pub fn apply(&self, patch: AppSettingsPatch) -> Result<AppSettings> {
        let mut current = self.read();
        if let Some(v) = patch.display_mode {
            current.display_mode = v;
        }
        if let Some(v) = patch.delta_window_us {
            // Clamp to a sane range so the peek list can't go below
            // 1 second (degenerate) or above 5 minutes (pointless).
            current.delta_window_us = v.clamp(1_000_000, 300_000_000);
        }
        if let Some(v) = patch.media_pool_drawer_open {
            current.media_pool_drawer_open = v;
        }
        if let Some(v) = patch.tail_snap_enabled {
            current.tail_snap_enabled = v;
        }
        if let Some(v) = patch.tail_snap_strength_px {
            current.tail_snap_strength_px =
                v.clamp(MIN_TAIL_SNAP_STRENGTH_PX, MAX_TAIL_SNAP_STRENGTH_PX);
        }
        if let Some(v) = patch.prebake_templates {
            current.prebake_templates = v;
        }
        self.write(&current)?;
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh(tmp: &TempDir) -> AppSettingsStore {
        AppSettingsStore::new(tmp.path().to_path_buf())
    }

    #[test]
    fn defaults_when_no_file() {
        let tmp = TempDir::new().unwrap();
        let s = fresh(&tmp).get();
        assert_eq!(s.display_mode, DisplayMode::AbRoll);
        assert_eq!(s.delta_window_us, 10_000_000);
        assert!(!s.media_pool_drawer_open);
        assert!(s.tail_snap_enabled);
        assert_eq!(s.tail_snap_strength_px, 12);
        assert!(!s.prebake_templates);
    }

    #[test]
    fn apply_persists_then_reads_back() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        let after = store
            .apply(AppSettingsPatch {
                display_mode: Some(DisplayMode::ShowAll),
                delta_window_us: Some(5_000_000),
                media_pool_drawer_open: Some(true),
                tail_snap_enabled: Some(false),
                tail_snap_strength_px: Some(24),
                prebake_templates: None,
            })
            .unwrap();
        assert_eq!(after.display_mode, DisplayMode::ShowAll);
        assert_eq!(after.delta_window_us, 5_000_000);
        assert!(after.media_pool_drawer_open);
        assert!(!after.tail_snap_enabled);
        assert_eq!(after.tail_snap_strength_px, 24);
        // Independent reader sees the same values from disk.
        let again = AppSettingsStore::new(tmp.path().to_path_buf()).get();
        assert_eq!(again.display_mode, DisplayMode::ShowAll);
        assert_eq!(again.delta_window_us, 5_000_000);
        assert!(again.media_pool_drawer_open);
        assert!(!again.tail_snap_enabled);
        assert_eq!(again.tail_snap_strength_px, 24);
    }

    #[test]
    fn missing_fields_inherit_defaults() {
        // Hand-edited file with only one field present — the rest must
        // fall through to defaults instead of failing the parse.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(APP_SETTINGS_FILE);
        fs::write(&path, r#"{ "display_mode": "ShowAll" }"#).unwrap();
        let s = AppSettingsStore::new(tmp.path().to_path_buf()).get();
        assert_eq!(s.display_mode, DisplayMode::ShowAll);
        assert_eq!(s.delta_window_us, 10_000_000);
        assert!(!s.media_pool_drawer_open);
        assert!(s.tail_snap_enabled);
        assert_eq!(s.tail_snap_strength_px, 12);
        assert!(!s.prebake_templates);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(APP_SETTINGS_FILE);
        fs::write(&path, "{ not valid json at all").unwrap();
        let s = AppSettingsStore::new(tmp.path().to_path_buf()).get();
        // Defaults — no crash, no propagated error.
        assert_eq!(s.display_mode, DisplayMode::AbRoll);
        assert_eq!(s.delta_window_us, 10_000_000);
        assert!(s.tail_snap_enabled);
        assert_eq!(s.tail_snap_strength_px, 12);
    }

    #[test]
    fn delta_window_clamps_out_of_range() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        let too_small = store
            .apply(AppSettingsPatch {
                delta_window_us: Some(0),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(too_small.delta_window_us, 1_000_000);
        let too_big = store
            .apply(AppSettingsPatch {
                delta_window_us: Some(10 * 60 * 1_000_000),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(too_big.delta_window_us, 300_000_000);
    }

    #[test]
    fn tail_snap_strength_clamps_out_of_range() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        let too_small = store
            .apply(AppSettingsPatch {
                tail_snap_strength_px: Some(0),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(too_small.tail_snap_strength_px, MIN_TAIL_SNAP_STRENGTH_PX);
        let too_big = store
            .apply(AppSettingsPatch {
                tail_snap_strength_px: Some(200),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(too_big.tail_snap_strength_px, MAX_TAIL_SNAP_STRENGTH_PX);
    }

    #[test]
    fn prebake_templates_defaults_off_and_round_trips() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        assert!(!store.get().prebake_templates); // default OFF
        let after = store
            .apply(AppSettingsPatch {
                prebake_templates: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert!(after.prebake_templates);
        // Independent reader sees it persisted.
        assert!(AppSettingsStore::new(tmp.path().to_path_buf()).get().prebake_templates);
    }
}
