//! Transitions between adjacent layers on the same track.
//!
//! A `Transition` authorizes a specific timeline overlap between two layers
//! that the no-overlap invariant would otherwise reject; the overlap span MUST
//! equal `duration_us` so validation can reason about it.
//!
//! The only kind is `TransitionKind::Crossfade`, lowered as an alpha fade-in on
//! the incoming layer (its first `duration_us` get alpha ramped 0 → 1); the
//! outgoing layer stays at full opacity and the `overlay` filter does the linear
//! blend. Other kinds (slide/wipe/dissolve) could reuse this shape or switch to
//! ffmpeg's `xfade` filter.

use serde::{Deserialize, Serialize};

use super::ids::{LayerId, TransitionId};
use super::time::TimeUs;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transition {
    pub id: TransitionId,
    /// Outgoing layer — the one whose tail overlaps with the incoming layer.
    pub from_layer: LayerId,
    /// Incoming layer — the one whose head overlaps. Renders on top during
    /// the transition window (alpha-faded in for `TransitionKind::Crossfade`).
    pub to_layer: LayerId,
    /// Length of the transition in timeline microseconds. Must equal the
    /// overlap between `from_layer` and `to_layer`. Enforced in validation.
    pub duration_us: TimeUs,
    pub kind: TransitionKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TransitionKind {
    /// Linear alpha blend from `from_layer` to `to_layer` over `duration_us`.
    /// Implemented as a `fade=alpha=1` ramp on the incoming layer; the
    /// existing `overlay` filter chain produces the visible blend.
    Crossfade,
}
