//! `Project` — the top-level state. Single source of truth shared between the
//! UI, IR compiler, MCP server, and persistence layer.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::audio_role::{AudioRole, RoleMixSettings};
use super::composition::Composition;
use super::group::Group;
use super::ids::{MediaId, new_id};
use super::marker::Marker;
use super::media::MediaItem;
use super::track::{Track, TrackRole};
use super::transition::Transition;

/// `.vproj` schema version. Bump on any breaking change to the on-disk
/// `Project` shape. Pre-release: the TS loader (`persistence.ts`) rejects
/// anything below `SCHEMA_VERSION` with a clear error rather than migrating —
/// older `.vproj` folders must be re-created. Rust only ever deserializes
/// already-gated JSON. Per-version history lives in git / the ADRs.
// v10: proxy fields replaced by a single `decode_route: DecodeRoute` enum on MediaItem.
pub const SCHEMA_VERSION: u32 = 10;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub schema_version: u32,
    pub project_id: Uuid,
    pub metadata: ProjectMetadata,
    pub composition: Composition,
    pub media_pool: imbl::HashMap<MediaId, MediaItem>,
    /// 0 = bottom of z-stack, last = top.
    pub tracks: imbl::Vector<Track>,
    pub markers: imbl::Vector<Marker>,
    /// Authorized layer-pair overlaps with transition semantics. Each entry
    /// authorizes a specific overlap between two
    /// adjacent layers on the same track; validation rejects the project
    /// otherwise. `#[serde(default)]` keeps older `.vproj` files loadable.
    #[serde(default)]
    pub transitions: imbl::Vector<Transition>,
    /// Layer groups (`docs/groups.md`). Each `Group` owns a set of
    /// `LayerId`s; flat membership (a layer is in at most one group). The
    /// actor maintains a derived `LayerId → GroupId` index for fast lookup
    /// and fans out move/trim/split ops across members. `#[serde(default)]`
    /// makes v2 `.vproj` files load as v3 projects with no groups.
    #[serde(default)]
    pub groups: imbl::Vector<Group>,
    /// Per-role mix-bus settings (`docs/audio.md`). Absent keys resolve to
    /// `RoleMixSettings::default()` via `role_mix`. `#[serde(default)]`
    /// makes pre-roles `.vproj` files load with every role at unity.
    #[serde(default)]
    pub audio_roles: imbl::HashMap<AudioRole, RoleMixSettings>,
    pub settings: ProjectSettings,
}

impl Project {
    pub fn new_blank(name: impl Into<String>) -> Self {
        let now = Utc::now();
        // A fresh project seeds two reserved, kind-agnostic tracks (A roll,
        // B roll); layers of any kind coexist on them. V+A pairs from import
        // land on the same track and render as one combined row. See
        // `docs/data-model.md`.
        //
        // Data-model ordering is bottom-up (index 0 = bottom of z-stack, last
        // = top): A roll is the primary base, B roll overlays paint on top.
        // Separated-audio rows insert adjacent to their source video; on-screen
        // order is derived from this data order, not stored.
        let mut a_roll = Track::new();
        a_roll.label = Some("A roll".into());
        a_roll.removable = false;
        a_roll.role = Some(TrackRole::ARoll);

        let mut b_roll = Track::new();
        b_roll.label = Some("B roll".into());
        b_roll.removable = false;
        b_roll.role = Some(TrackRole::BRoll);

        let tracks = imbl::vector![a_roll, b_roll];
        Self {
            schema_version: SCHEMA_VERSION,
            project_id: new_id(),
            metadata: ProjectMetadata {
                name: name.into(),
                created_at: now,
                modified_at: now,
                description: None,
            },
            composition: Composition::default(),
            media_pool: imbl::HashMap::new(),
            tracks,
            markers: imbl::Vector::new(),
            transitions: imbl::Vector::new(),
            groups: imbl::Vector::new(),
            audio_roles: imbl::HashMap::new(),
            settings: ProjectSettings::default(),
        }
    }

    /// Mix settings for a role, defaulted when the table has no entry.
    pub fn role_mix(&self, role: AudioRole) -> RoleMixSettings {
        self.audio_roles.get(&role).cloned().unwrap_or_default()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectMetadata {
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectSettings {
    /// Proxy resolution used for live preview (Pixi compositor draft pass).
    pub preview_width: u32,
    pub preview_height: u32,
    pub autosave_interval_secs: Option<u32>,
    pub history_capacity: usize,
    /// When `true` (default), importing a video source that has an audio
    /// stream creates both a `VideoClip` and an `Audio` layer pointing at
    /// the same media, and groups them. See `docs/groups.md`. When
    /// `false`, only the `VideoClip` layer is created (audio is silently
    /// dropped, matching pre-v3 behavior).
    #[serde(default = "default_auto_pair_audio_on_import")]
    pub auto_pair_audio_on_import: bool,
    /// When `true` (default), deleting the last layer on a track also
    /// deletes the now-empty track inside the same history entry, so one
    /// undo restores both. Role-stamped tracks (A/B roll and the legacy
    /// audio roles), non-removable tracks, and locked tracks always stay.
    /// When `false`, an emptied track lingers until deleted explicitly.
    #[serde(default = "default_auto_delete_empty_tracks")]
    pub auto_delete_empty_tracks: bool,
    /// When `true`, preview decode prefers a generated proxy over the
    /// original source (per-clip `proxy_overrides` can force either way).
    /// Default `false` (native-decode-always, matching NLE convention).
    #[serde(default)]
    pub prefer_proxies: bool,
    /// Per-clip override of `prefer_proxies`, keyed by media id. Absent =
    /// follow the global preference. See `project_settings_patch_convention`.
    #[serde(default)]
    pub proxy_overrides: std::collections::HashMap<String, bool>,
}

fn default_auto_pair_audio_on_import() -> bool {
    true
}

fn default_auto_delete_empty_tracks() -> bool {
    true
}

/// Patch shape for `update_project_settings` — every field optional so the UI
/// can send tiny diffs without echoing the rest of the struct.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProjectSettingsPatch {
    pub auto_delete_empty_tracks: Option<bool>,
    pub prefer_proxies: Option<bool>,
    #[serde(default)]
    pub proxy_override: Option<ProxyOverridePatch>,
}

/// One entry of the `proxy_overrides` map, patched in or cleared.
/// `value: None` clears the override (falls back to the global preference).
#[derive(Clone, Debug, Deserialize)]
pub struct ProxyOverridePatch {
    pub media_id: String,
    pub value: Option<bool>,
}

/// Patch shape for `update_track_flags` — the timeline header's
/// eye/M/S/lock toggles. Preference-shaped like `ProjectSettingsPatch`:
/// applied to every history snapshot and never recorded, so Ctrl-Z never
/// flips a track toggle. Only `Some(_)` fields are applied.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct TrackFlagsPatch {
    pub enabled: Option<bool>,
    pub muted: Option<bool>,
    pub solo: Option<bool>,
    pub locked: Option<bool>,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            preview_width: 1280,
            preview_height: 720,
            autosave_interval_secs: Some(60),
            history_capacity: 200,
            auto_pair_audio_on_import: true,
            auto_delete_empty_tracks: true,
            prefer_proxies: false,
            proxy_overrides: Default::default(),
        }
    }
}

#[cfg(test)]
mod role_tests {
    use super::*;

    #[test]
    fn legacy_project_without_audio_roles_defaults_to_unity() {
        let p = Project::new_blank("t");
        let mut v = serde_json::to_value(&p).unwrap();
        v.as_object_mut().unwrap().remove("audio_roles");
        let back: Project = serde_json::from_value(v).unwrap();
        assert!(back.audio_roles.is_empty());
        let m = back.role_mix(AudioRole::Music);
        assert_eq!(m.gain_db, 0.0);
        assert!(!m.muted && !m.solo);
    }

    #[test]
    fn role_mix_reads_table_entry() {
        let mut p = Project::new_blank("t");
        p.audio_roles.insert(
            AudioRole::Dialogue,
            RoleMixSettings { gain_db: 6.0, muted: false, solo: true },
        );
        let m = p.role_mix(AudioRole::Dialogue);
        assert_eq!(m.gain_db, 6.0);
        assert!(m.solo);
    }
}
