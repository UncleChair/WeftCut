//! `Project` — the top-level state. Single source of truth shared between the
//! UI, IR compiler, MCP server, and persistence layer.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::composition::Composition;
use super::group::Group;
use super::ids::{MediaId, new_id};
use super::marker::Marker;
use super::media::MediaItem;
use super::track::{Track, TrackRole};
use super::transition::Transition;

// v1 — original .vproj format with absolute media paths.
// v2 — workspace-first redesign (`docs/data-model.md`): media
//      copied into `<workspace>/Media/`, `path_rel` authoritative,
//      derivatives in `<workspace>/Cache/`. `io::load_from_dir`
//      auto-migrates v1 projects to v2 on open.
// v3 — group system (`docs/groups.md`): adds project-level
//      `groups` table + `settings.auto_pair_audio_on_import`. Old v2
//      `.vproj` files load with `groups = []` via `#[serde(default)]`;
//      the migration is a pure version-bump.
// v4 — A/B-roll redesign v1: `Track.role` field stamps the four
//      reserved tracks of a fresh project (Video A / Video B / Audio
//      A / Audio B) and drives the AB display-mode filter.
// v5 — A/B-roll redesign v2 (AE-style, this commit): reserved
//      skeleton shrinks from 4 → 2 (A roll, B roll). Tracks become
//      kind-agnostic over the v5 phases (TrackKind field still
//      present in v5.0; removed in a later V.5). Legacy v4 projects
//      load as-is — orphan AudioA/AudioB tracks remain visible (no
//      auto-migration; user manually cleans up if desired).
// v6 — html-render groups (`docs/groups.md`): adds
//      `Group.render_mode: GroupRenderMode { Native | Html }` field.
//      Legacy v5 groups load as `Native` via `#[serde(default)]`. Pure
//      version bump; the migration is a no-op.
// v7 — effect-chain redesign (2026-05-17): `Group.effects` field for
//      group-level effects; new `EffectParams::HtmlTransform` variant
//      with `Animated<f64>` keyframe tracks. `render_mode` will be
//      dropped in step 3 of the redesign; the field stays present in
//      v7 for additive landing and is removed in v8.
// v8 — pixi-renderer cut-over (P11). The visual half of the IR / effects
//      surface is gone; `layer.effects` and `group.effects` are no
//      longer load-bearing on the renderer (P12 deletes the fields).
//      Pre-release, so we do NOT migrate v1–v7 forward: `io::load_from_dir`
//      rejects anything below `SCHEMA_VERSION` with a clear error. Old
//      `.vproj` folders need to be re-created.
pub const SCHEMA_VERSION: u32 = 8;

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
    /// Authorized layer-pair overlaps with transition semantics (Phase 2
    /// deferral). Each entry authorizes a specific overlap between two
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
    pub settings: ProjectSettings,
}

impl Project {
    pub fn new_blank(name: impl Into<String>) -> Self {
        let now = Utc::now();
        // A/B-roll v2 (`docs/data-model.md` follow-up): the reserved
        // skeleton shrinks from 4 → 2 tracks. Each is kind-agnostic in
        // the user-facing model (V.1 still has `TrackKind::Video` on
        // the field; the IR rewrite in V.5 removes the kind field and
        // lets layers of any kind coexist). V+A pairs from import land
        // on the same track and render as one combined row (V.6).
        //
        // Data-model ordering is bottom-up (index 0 = bottom of
        // z-stack, last = top). A roll is the primary base; B roll
        // overlays / cutaways paint on top. Separated-audio rows
        // created by V.7's "Separate audio" feature insert adjacent
        // to their source video, not at the bottom — visualOrderedTracks
        // (V.8) computes the on-screen order from this data order.
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
            settings: ProjectSettings::default(),
        }
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
}

fn default_auto_pair_audio_on_import() -> bool {
    true
}

fn default_auto_delete_empty_tracks() -> bool {
    true
}

/// Patch shape for `update_project_settings`. Mirrors `AppSettingsPatch`:
/// every field optional so the UI can send tiny diffs without echoing the
/// rest of the struct.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProjectSettingsPatch {
    pub auto_delete_empty_tracks: Option<bool>,
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
        }
    }
}
