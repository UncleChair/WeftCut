//! Layer groups — bundle any set of layers across any tracks into a unit
//! that moves, trims, and splits together.
//!
//! Design: `docs/group-system.md`. Membership is flat (a layer is in at most
//! one group). The actor enforces invariants on every commit; fan-out for
//! structural ops lives in `state::actor` and consults the derived
//! `LayerId → GroupId` index built by `index_groups`.

#![allow(dead_code)]

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::effect::Effect;
use super::ids::{GroupId, LayerId};

// `PartialEq` dropped 2026-05-17: `Effect` carries `Animated<f64>` which
// could derive `PartialEq` but the chain of additional derives across
// `EffectParams` / `Animated` / `Keyframe` / `Interpolation` isn't
// motivated by current call sites (no `group == group` comparisons in
// the codebase; tests compare fields).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Group {
    pub id: GroupId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `OrdSet` so the on-disk form is deterministic. Insertion order is
    /// not user-visible — group membership is a set.
    pub members: imbl::OrdSet<LayerId>,
    /// `docs/html-render-groups.md` (2026-05-17 redesign): group-level
    /// effect chain. Effects here apply to the composed bundle of all
    /// members — the engine writes resolved transforms to the
    /// `#composition` element instead of any single `.layer` host. A
    /// group is rendered through the html-cap path whenever any
    /// effect in this chain has `EffectKind::requires_html() == true`
    /// (today: `HtmlTransform`). The render-mode flag from v6 is gone
    /// — render path is derived purely from the effect chain.
    /// `#[serde(default)]` keeps pre-v7 projects loadable as v7 with
    /// an empty chain.
    #[serde(default)]
    pub effects: imbl::Vector<Effect>,
}

impl Group {
    pub fn new(id: GroupId, label: Option<String>, members: imbl::OrdSet<LayerId>) -> Self {
        Self {
            id,
            label,
            members,
            effects: imbl::Vector::new(),
        }
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
            effects: imbl::Vector::new(),
        }
    }

    /// True iff any enabled effect in this group's chain requires html-
    /// cap rendering. The export planner uses this (with each effect's
    /// time window) to decide which segments go to html-cap vs ffmpeg;
    /// LiveLayers uses it to decide whether to mount an
    /// `HtmlGroupHandle` (one composition) instead of per-member
    /// `<Layer>` components.
    pub fn requires_html(&self) -> bool {
        self.effects.iter().any(|e| {
            e.enabled && (e.kind().requires_html() || e.has_keyframed_params())
        })
    }
}

/// True when the group should render through the html-cap path —
/// either because the group's own effect chain has an html-required
/// effect, or because at least one of its enabled member layers
/// carries one. Materialize + lower both gate on this; the preview
/// side mirrors it in `LiveLayers`.
///
/// `layer_lookup(layer_id) -> bool` returns true when the named
/// layer requires html (i.e. `Layer::requires_html()`). The caller
/// provides this so we don't depend on the whole `Project` shape
/// here — different call sites already have their own layer
/// indexes.
pub fn group_requires_html<F>(group: &Group, mut layer_requires_html: F) -> bool
where
    F: FnMut(LayerId) -> bool,
{
    if group.requires_html() {
        return true;
    }
    group.members.iter().any(|&lid| layer_requires_html(lid))
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
