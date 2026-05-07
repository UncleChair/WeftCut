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
    /// Anchor point in normalized layer coordinates; (0.5, 0.5) = center.
    pub anchor: (f64, f64),
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            x: Animated::Static(0.0),
            y: Animated::Static(0.0),
            scale_x: Animated::Static(1.0),
            scale_y: Animated::Static(1.0),
            rotation_deg: Animated::Static(0.0),
            anchor: (0.5, 0.5),
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
