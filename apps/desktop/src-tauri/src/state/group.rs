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

/// How a group renders at export time.
///
/// `Native` (the default — every pre-Phase-H project, and every group
/// the user hasn't explicitly opted in) lowers each member through the
/// normal ffmpeg path: each layer becomes its own IR nodes inside the
/// overlay chain.
///
/// `Html` (`docs/html-render-groups.md`) collapses the group's visual
/// members into one HTML composition that the offscreen raster webview
/// captures frame-by-frame. The captured frames stream into a transient
/// VP9-with-alpha intermediate that the main ffmpeg overlays as a
/// single input. Audio members of the group still feed the regular
/// amix unchanged.
///
/// Toggling `Native → Html` runs a validator that rejects the switch
/// when any member layer carries an effect with no CSS implementation
/// (`docs/html-render-groups.md` decision 8 — strict refusal). This
/// surfaces the problem at edit time rather than silently dropping the
/// effect from the final export.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum GroupRenderMode {
    #[default]
    Native,
    Html,
}

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
    /// `#[serde(default)]` loads every pre-v6 group as `Native`, so the
    /// schema v5 → v6 migration is a pure version bump.
    #[serde(default)]
    pub render_mode: GroupRenderMode,
    /// `docs/html-render-groups.md` (2026-05-17 redesign): group-level
    /// effect chain. Effects here apply to the composed bundle of all
    /// members — the engine writes resolved transforms to the
    /// `#composition` element instead of any single `.layer` host. A
    /// group whose effect chain contains an `HtmlTransform` (or any
    /// other `requires_html()` kind) in an active window is rendered
    /// via the html-cap path for that window. `#[serde(default)]` keeps
    /// pre-v7 projects loadable as v7 with an empty chain.
    #[serde(default)]
    pub effects: imbl::Vector<Effect>,
}

impl Group {
    pub fn new(id: GroupId, label: Option<String>, members: imbl::OrdSet<LayerId>) -> Self {
        Self {
            id,
            label,
            members,
            render_mode: GroupRenderMode::default(),
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
            render_mode: GroupRenderMode::default(),
            effects: imbl::Vector::new(),
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
