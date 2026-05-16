//! Track envelope. Layers in the same track must not overlap in time — hard
//! invariant enforced by the actor on commit.

use serde::{Deserialize, Serialize};

use super::ids::{TrackId, new_id};
use super::layer::Layer;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Track {
    pub id: TrackId,
    pub kind: TrackKind,
    pub label: Option<String>,
    pub enabled: bool,
    pub locked: bool,
    /// Whether the user (or an agent) is allowed to delete this track. The
    /// default A-roll / B-roll tracks of a fresh project are non-removable so
    /// the editor always has a place to drop clips. Defaults to `true` for
    /// back-compat with `.vproj` files written before this field existed.
    #[serde(default = "default_removable")]
    pub removable: bool,
    /// A/B-roll role stamp (`docs/ab-roll-redesign`). Role-stamped tracks are
    /// the only tracks visible in AB display mode; everything else is hidden.
    /// Set on the four reserved tracks at project creation (Video A / Video B
    /// → ARoll/BRoll; Audio A / Audio B → AudioA/AudioB) and `None` for every
    /// track imported afterwards. `#[serde(default)]` lets legacy `.vproj`
    /// files load with `role = None`.
    #[serde(default)]
    pub role: Option<TrackRole>,
    /// Auto-prune flag for the "every import lands a fresh hidden track"
    /// rule (R.3 / R.4 of the A/B-roll redesign). When `true`, the actor's
    /// mutation paths delete this track once its `layers` becomes empty so
    /// the timeline doesn't accumulate a graveyard. Set on tracks created
    /// by `import_media`; left `false` for the four reserved tracks, for
    /// tracks the user/agent created explicitly, and for legacy `.vproj`
    /// files (`#[serde(default)]` defaults to false, preserving prior
    /// behaviour on load).
    #[serde(default)]
    pub transient: bool,
    pub height_px: u16,
    /// Sorted by `t_start_us`, never overlapping.
    pub layers: imbl::Vector<Layer>,
}

fn default_removable() -> bool {
    true
}

impl Track {
    pub fn new(kind: TrackKind) -> Self {
        Self {
            id: new_id(),
            kind,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            role: None,
            transient: false,
            height_px: 64,
            layers: imbl::Vector::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrackKind {
    Video,
    Audio,
    Subtitle,
}

/// A/B-roll role stamp. Drives AB display-mode filtering on the UI and the
/// role-aware AV-pair fan-out when promoting hidden clips onto A or B
/// (`docs/ab-roll-redesign`). The audio variants pair with the video variants
/// of matching letter — promoting a video to `ARoll` translates a grouped
/// audio member's destination to the track stamped `AudioA`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TrackRole {
    ARoll,
    BRoll,
    AudioA,
    AudioB,
}

impl TrackRole {
    /// The audio role paired with a video role, and vice versa. Used by the
    /// group-fanout path when a layer is dragged across the V/A boundary
    /// onto an A or B track.
    pub fn paired(self) -> Self {
        match self {
            TrackRole::ARoll => TrackRole::AudioA,
            TrackRole::BRoll => TrackRole::AudioB,
            TrackRole::AudioA => TrackRole::ARoll,
            TrackRole::AudioB => TrackRole::BRoll,
        }
    }

    /// True for the two video-side roles. Used by the importer + UI filter
    /// without leaking TrackKind dependency.
    pub fn is_video(self) -> bool {
        matches!(self, TrackRole::ARoll | TrackRole::BRoll)
    }
}
