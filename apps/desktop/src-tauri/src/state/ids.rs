//! Stable, opaque, time-sortable identifiers for every addressable entity.
//!
//! Type aliases (not newtypes) match the data-model doc; promote to newtypes
//! when the type-confusion cost shows up in code review.

use uuid::Uuid;

pub type MediaId = Uuid;
pub type TrackId = Uuid;
pub type LayerId = Uuid;
pub type EffectId = Uuid;
pub type KeyframeId = Uuid;
pub type MarkerId = Uuid;
pub type CheckpointId = Uuid;
pub type OpId = Uuid;
pub type TransitionId = Uuid;
pub type GroupId = Uuid;

pub fn new_id() -> Uuid {
    Uuid::now_v7()
}
