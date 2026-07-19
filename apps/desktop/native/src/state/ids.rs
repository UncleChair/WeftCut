//! Stable, opaque, time-sortable identifiers for every addressable entity.
//!
//! Type aliases (not newtypes) match the data-model doc; promote to newtypes
//! when the type-confusion cost shows up in code review.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use uuid::Uuid;

pub type MediaId = Uuid;
pub type TrackId = Uuid;
pub type LayerId = Uuid;
pub type KeyframeId = Uuid;
pub type MarkerId = Uuid;
pub type CheckpointId = Uuid;
pub type OpId = Uuid;
pub type TransitionId = Uuid;
pub type GroupId = Uuid;
pub type EffectId = Uuid;

pub fn new_id() -> Uuid {
    if det::ENABLED.load(Ordering::Relaxed) {
        let n = det::COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
        Uuid::from_u128(n as u128)
    } else {
        Uuid::now_v7()
    }
}

/// Process-global deterministic id mode for the differential replay driver.
/// OFF in production (default). Not thread-local: the driver runs commands
/// serially, so a global counter yields a stable sequence across tokio threads.
pub mod det {
    use super::{AtomicBool, AtomicU64, Ordering};
    pub(super) static ENABLED: AtomicBool = AtomicBool::new(false);
    pub(super) static COUNTER: AtomicU64 = AtomicU64::new(0);
    pub fn enable() {
        ENABLED.store(true, Ordering::Relaxed);
    }
    pub fn disable() {
        ENABLED.store(false, Ordering::Relaxed);
    }
    pub fn reset() {
        COUNTER.store(0, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod det_tests {
    use super::*;

    #[test]
    fn deterministic_mode_counts_from_one() {
        det::reset();
        det::enable();
        assert_eq!(new_id().to_string(), "00000000-0000-0000-0000-000000000001");
        assert_eq!(new_id().to_string(), "00000000-0000-0000-0000-000000000002");
        det::disable();
    }
}
