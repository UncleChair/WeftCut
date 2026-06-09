//! Track envelope. Layers in the same track must not overlap in time — hard
//! invariant enforced by the actor on commit.

use serde::{Deserialize, Serialize};

use super::ids::{TrackId, new_id};
use super::layer::Layer;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Track {
    pub id: TrackId,
    pub label: Option<String>,
    pub enabled: bool,
    pub locked: bool,
    /// Whether the user (or an agent) is allowed to delete this track. The
    /// default A-roll / B-roll tracks of a fresh project are non-removable so
    /// the editor always has a place to drop clips. Defaults to `true` for
    /// back-compat with `.vproj` files written before this field existed.
    #[serde(default = "default_removable")]
    pub removable: bool,
    /// A/B-roll role stamp (`docs/data-model.md`). Role-stamped tracks are
    /// the only tracks visible in AB display mode; everything else is hidden.
    /// Set on the two reserved tracks at project creation (A roll → ARoll, B
    /// roll → BRoll). Legacy v4 projects may also carry `AudioA`/`AudioB`
    /// variants — they load as-is. `None` for every track imported afterwards.
    #[serde(default)]
    pub role: Option<TrackRole>,
    /// Auto-prune flag for the "every import lands a fresh hidden track"
    /// rule (R.3 / R.4 / V.3). When `true`, the actor's mutation paths
    /// delete this track once its `layers` becomes empty so the timeline
    /// doesn't accumulate a graveyard. Set on tracks created by
    /// `import_media`; left `false` for reserved tracks and explicit
    /// user / agent adds.
    #[serde(default)]
    pub transient: bool,
    pub height_px: u16,
    /// Layers sorted by `t_start_us`. Under A/B-roll v2 (V.2 invariant),
    /// same-overlap-class layers can't overlap in time; different classes
    /// can coexist (enables AV pairs on one track).
    pub layers: imbl::Vector<Layer>,
}

fn default_removable() -> bool {
    true
}

impl Track {
    /// V.5: tracks are kind-agnostic. The `kind` parameter and field
    /// are gone — any layer kind can live on any track. The old
    /// `TrackKind` enum is no longer needed because the IR routes by
    /// `LayerParams` discriminator and the UI accepts any media on
    /// any lane.
    pub fn new() -> Self {
        Self {
            id: new_id(),
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

impl Default for Track {
    fn default() -> Self {
        Self::new()
    }
}

/// A/B-roll role stamp. Drives AB display-mode filtering on the UI and the
/// role-aware AV-pair fan-out when promoting hidden clips onto A or B
/// (`docs/data-model.md`). The audio variants pair with the video variants
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
