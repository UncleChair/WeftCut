//! `Animated<T>` — either a static value or a sorted keyframe vector.
//!
//! Keyframe times are RELATIVE to the layer's `t_start_us`. Otherwise moving a
//! layer breaks its animation.

// `Animated::static` constructor is API for keyframe-aware mutators landing
// with Phase 2 effects.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::ids::KeyframeId;
use super::time::TimeUs;

/// `T: Clone` is required because `imbl::Vector` uses structural sharing — the
/// inner `Keyframe<T>` must be cloneable. Bounding the type is cleaner than
/// repeating the bound at every use site.
///
/// **No `JsonSchema` derive**: `imbl::Vector` doesn't ship a `JsonSchema`
/// impl, and `Uuid` requires schemars' `uuid1` feature. MCP tools that
/// need to accept an `Animated<T>` from agents declare the field as
/// `serde_json::Value` and deserialize inside the handler; the wire
/// shape is the same.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "mode", content = "value")]
pub enum Animated<T: Clone> {
    Static(T),
    Keyframed(imbl::Vector<Keyframe<T>>),
}

impl<T: Clone> Animated<T> {
    pub fn r#static(v: T) -> Self {
        Self::Static(v)
    }

    /// True iff the value actually changes over time — `Keyframed` with
    /// at least two keyframes. `Static`, empty `Keyframed`, and
    /// single-keyframe `Keyframed` all read as not animated. The
    /// renderer's static-vs-keyframed routing rule consults this:
    /// animated tracks force html-cap rendering on the owning
    /// layer/group; non-animated tracks can take the fast ffmpeg path.
    ///
    /// Doesn't compare values — `[t=0: v=5, t=10: v=5]` reports
    /// animated even though it's effectively static. False positives
    /// just route to html-cap unnecessarily; tightening to "any two
    /// adjacent keyframes have distinct values" is a follow-up if it
    /// matters.
    pub fn is_animated(&self) -> bool {
        match self {
            Animated::Static(_) => false,
            Animated::Keyframed(kfs) => kfs.len() > 1,
        }
    }
}

impl<T: Clone + Default> Default for Animated<T> {
    fn default() -> Self {
        Self::Static(T::default())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Keyframe<T: Clone> {
    pub id: KeyframeId,
    /// Time relative to the owning layer's `t_start_us`.
    pub t_us: TimeUs,
    pub value: T,
    pub interp: Interpolation,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "kind")]
pub enum Interpolation {
    Hold,
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    Bezier { p1: (f64, f64), p2: (f64, f64) },
}
