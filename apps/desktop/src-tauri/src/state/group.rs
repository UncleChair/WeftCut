//! Layer groups — bundle any set of layers across any tracks into a unit
//! that moves, trims, and splits together.
//!
//! Design: `docs/group-system.md`. Membership is flat (a layer is in at most
//! one group). The actor enforces invariants on every commit; fan-out for
//! structural ops lives in `state::actor` and consults the derived
//! `LayerId → GroupId` index built by `index_groups`.

#![allow(dead_code)]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::ids::{GroupId, LayerId};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Group {
    pub id: GroupId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `OrdSet` so the on-disk form is deterministic. Insertion order is
    /// not user-visible — group membership is a set.
    pub members: imbl::OrdSet<LayerId>,
}

impl Group {
    pub fn new(id: GroupId, label: Option<String>, members: imbl::OrdSet<LayerId>) -> Self {
        Self { id, label, members }
    }

    /// Convenience: build from an unordered iterator.
    pub fn from_iter<I: IntoIterator<Item = LayerId>>(
        id: GroupId,
        label: Option<String>,
        members: I,
    ) -> Self {
        Self {
            id,
            label,
            members: members.into_iter().collect(),
        }
    }
}

/// Build the derived `LayerId → GroupId` lookup. The actor rebuilds this
/// on every commit that mutates `Project.groups` or `Project.tracks`;
/// readers use it for O(1) "what group is this in" queries.
pub fn index_groups(groups: &imbl::Vector<Group>) -> HashMap<LayerId, GroupId> {
    let mut idx = HashMap::new();
    for g in groups.iter() {
        for &m in g.members.iter() {
            idx.insert(m, g.id);
        }
    }
    idx
}
