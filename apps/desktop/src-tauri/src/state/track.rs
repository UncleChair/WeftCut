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
