//! Track envelope — the per-track flags, the A/B-roll role stamp, and the layer
//! list. The no-overlap invariant is documented on `Track::layers` and enforced
//! on commit by `apps/desktop/src/main/state/validate.ts`.

use serde::{Deserialize, Serialize};

use super::ids::{new_id, TrackId};
use super::layer::Layer;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Track {
    pub id: TrackId,
    pub label: Option<String>,
    pub enabled: bool,
    pub locked: bool,
    /// Track-level audio mute.
    /// Silences this track's Audio layers in preview AND export; video
    /// output is unaffected. Toggled via the unrecorded
    /// `update_track_flags` path so undo never flips it. Defaults to
    /// `false` for `.vproj` files written before the field existed.
    #[serde(default)]
    pub muted: bool,
    /// Track-level solo. When ANY enabled track has `solo == true`, only
    /// solo tracks are audible; `muted` wins over `solo`. Same unrecorded
    /// toggle path and back-compat default as `muted`.
    #[serde(default)]
    pub solo: bool,
    /// Whether the user (or an agent) is allowed to delete this track. The
    /// default A-roll / B-roll tracks of a fresh project are non-removable so
    /// the editor always has a place to drop clips. Defaults to `true` for
    /// back-compat with `.vproj` files written before this field existed.
    #[serde(default = "default_removable")]
    pub removable: bool,
    /// A/B-roll role stamp (`docs/data-model.md`). Role-stamped tracks are
    /// the only tracks visible in AB display mode; everything else is hidden.
    /// Set on the two reserved tracks at project creation (the A-roll track →
    /// `ARoll`, B-roll → `BRoll`); a role-stamped track carries no stored
    /// `label`, its name deriving from the role instead (ADR 0042). The
    /// `AudioA`/`AudioB` variants stamp the audio side of a roll pair (see
    /// `TrackRole::paired`). `None` for every track created afterwards.
    #[serde(default)]
    pub role: Option<TrackRole>,
    /// `true` marks a track as NOT part of the reserved skeleton, which is
    /// exactly the cleanup-eligibility flag (ADR 0042; `docs/data-model.md`):
    /// the invariant is `transient == (role is None)` at every creation site,
    /// so it is stamped on every role-less track — including one an agent adds
    /// through `add_track`, not just an import-spawned one. Cleanup is one
    /// rule: a track disappears when its last layer leaves it, gated on
    /// `transient && !locked` and applied to the track an edit just emptied,
    /// never a project-wide sweep. Absent in a pre-field `.vproj` → `false`,
    /// so a legacy track is never swept.
    #[serde(default)]
    pub transient: bool,
    pub height_px: u16,
    /// Layers sorted by `t_start_us`. Same-overlap-class layers can't overlap
    /// in time unless a `Transition` authorizes the overlap; different classes
    /// can coexist (enables AV pairs on one track).
    pub layers: imbl::Vector<Layer>,
}

fn default_removable() -> bool {
    true
}

impl Track {
    /// Tracks are kind-agnostic: any layer kind can live on any track — the IR
    /// routes by the `LayerParams` discriminator and the UI accepts any media
    /// on any lane.
    pub fn new() -> Self {
        Self {
            id: new_id(),
            label: None,
            enabled: true,
            locked: false,
            muted: false,
            solo: false,
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
    /// Subtitle / caption track. Hidden from AB display-mode filtering like
    /// audio tracks; has no audio pair. Created by subtitle import.
    Caption,
}

impl TrackRole {
    /// The audio role paired with a video role, and vice versa. Used by the
    /// group-fanout path when a layer is dragged across the V/A boundary
    /// onto an A or B track.
    /// Caption has no audio pair; it maps to itself so callers that always
    /// call `paired()` don't have to special-case it.
    pub fn paired(self) -> Self {
        match self {
            TrackRole::ARoll => TrackRole::AudioA,
            TrackRole::BRoll => TrackRole::AudioB,
            TrackRole::AudioA => TrackRole::ARoll,
            TrackRole::AudioB => TrackRole::BRoll,
            TrackRole::Caption => TrackRole::Caption,
        }
    }

    /// True for the two video-side roles. Used by the importer + UI filter.
    pub fn is_video(self) -> bool {
        matches!(self, TrackRole::ARoll | TrackRole::BRoll)
    }

    /// True only for `Caption` tracks. Keyed on by the subtitle import path
    /// and any UI / MCP surface that needs to locate the caption lane.
    pub fn is_caption(self) -> bool {
        matches!(self, TrackRole::Caption)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caption_role_is_not_video_and_reports_caption() {
        assert!(TrackRole::Caption.is_caption());
        assert!(!TrackRole::Caption.is_video());
        assert!(!TrackRole::ARoll.is_caption());
    }

    /// Old `.vproj` JSON (written before muted/solo existed) must load
    /// with both flags defaulting to false.
    #[test]
    fn track_deserializes_without_muted_solo() {
        let t = Track::new();
        let mut v = serde_json::to_value(&t).expect("serialize");
        let obj = v.as_object_mut().unwrap();
        obj.remove("muted");
        obj.remove("solo");
        let back: Track = serde_json::from_value(v).expect("deserialize legacy");
        assert!(!back.muted);
        assert!(!back.solo);
    }
}
