//! `Project` — the top-level state. Single source of truth shared between the
//! UI, IR compiler, MCP server, and persistence layer.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::composition::Composition;
use super::ids::{MediaId, new_id};
use super::marker::Marker;
use super::media::MediaItem;
use super::track::{Track, TrackKind};

pub const SCHEMA_VERSION: u32 = 1;

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
    pub settings: ProjectSettings,
}

impl Project {
    pub fn new_blank(name: impl Into<String>) -> Self {
        let now = Utc::now();
        // Two non-removable video tracks, A-roll on top of B-roll. Stable IDs
        // would be nice for agents to address them by name; for now their
        // labels are what the UI shows and what the user sees.
        let mut a_roll = Track::new(TrackKind::Video);
        a_roll.label = Some("A roll".into());
        a_roll.removable = false;
        let mut b_roll = Track::new(TrackKind::Video);
        b_roll.label = Some("B roll".into());
        b_roll.removable = false;
        // Order in `tracks` is bottom-up (last = top of z-stack). Put A-roll on
        // top so it visually dominates when the user starts dropping clips.
        let tracks = imbl::vector![b_roll, a_roll];
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
    /// Resolution used for libmpv preview (proxy/draft).
    pub preview_width: u32,
    pub preview_height: u32,
    pub autosave_interval_secs: Option<u32>,
    pub history_capacity: usize,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            preview_width: 1280,
            preview_height: 720,
            autosave_interval_secs: Some(60),
            history_capacity: 200,
        }
    }
}
