//! Spatial transform applied to a layer when composited onto the canvas.

use serde::{Deserialize, Serialize};

use super::animated::Animated;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transform {
    /// Canvas-space pixel offset.
    pub x: Animated<f64>,
    pub y: Animated<f64>,
    pub scale_x: Animated<f64>,
    pub scale_y: Animated<f64>,
    pub rotation_deg: Animated<f64>,
    /// Anchor point in normalized layer coordinates; (0.5, 0.5) = center. This is
    /// the transform PIVOT — what `rotation_deg` turns around and what a flip
    /// mirrors about — and it animates like the rest of the transform.
    ///
    /// LANDMINE: these two tracks replaced a plain `anchor: (f64, f64)` tuple
    /// WITHOUT a schema bump, so the serde default below is NOT the migration.
    /// It would silently re-centre a legacy off-centre anchor (which ASS `\an`
    /// import writes on every caption — `subtitles/layout.rs`). The real
    /// conversion is the tuple→tracks backfill in the TS load pass
    /// (`state/serialize.ts`), and TS owns all state (ADR 0024), so a project
    /// only ever reaches Rust already carrying these fields.
    #[serde(default = "centre_anchor")]
    pub anchor_x: Animated<f64>,
    #[serde(default = "centre_anchor")]
    pub anchor_y: Animated<f64>,
    /// Uniform-scale intent: the two scale tracks edit as one. Owned and
    /// enforced by the TS state layer (mutations/scaleLink.ts); Rust only
    /// carries it on the wire — compute never reads it. The serde default
    /// covers saves that predate the field; the TS load path replaces that
    /// placeholder with a real twin-check backfill before anything edits.
    #[serde(default)]
    pub scale_linked: bool,
}

/// The centred default both serde and `Default` hand out — one function so the
/// two can't drift.
fn centre_anchor() -> Animated<f64> {
    Animated::Static(0.5)
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            x: Animated::Static(0.0),
            y: Animated::Static(0.0),
            scale_x: Animated::Static(1.0),
            scale_y: Animated::Static(1.0),
            rotation_deg: Animated::Static(0.0),
            anchor_x: centre_anchor(),
            anchor_y: centre_anchor(),
            // Matches the TS defaultTransform() twin (mutations/add.ts).
            scale_linked: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    Add,
    Difference,
}
