//! Shared command-surface types — the error/patch vocabulary that `jobs/`,
//! `commands/`, `mcp/`, and the napi layer depend on. The TS state actor is
//! the sole writer; these types are the Rust side of that wire contract.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::ids::{
    CheckpointId, EffectId, GroupId, LayerId, MarkerId, MediaId, TrackId, TransitionId,
};
use super::time::TimeUs;

// ---- ValidationError (moved from state/validate.rs) ----

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ValidationError {
    #[error("composition width and height must be positive; got {width}x{height}")]
    InvalidCanvas { width: u32, height: u32 },

    #[error("composition fps must be positive on both axes; got {num}/{den}")]
    InvalidFps { num: u32, den: u32 },

    #[error("layer {layer} time range invalid: t_start={t_start} must be < t_end={t_end}")]
    InvalidLayerRange {
        layer: LayerId,
        t_start: TimeUs,
        t_end: TimeUs,
    },

    #[error(
        "layer {b} would overlap layer {a} on track {track} at [{a_start}, {a_end}) vs [{b_start}, {b_end})"
    )]
    LayerOverlap {
        track: TrackId,
        a: LayerId,
        a_start: TimeUs,
        a_end: TimeUs,
        b: LayerId,
        b_start: TimeUs,
        b_end: TimeUs,
    },

    #[error("layer {layer} references missing media {media}")]
    MissingMedia { layer: LayerId, media: MediaId },

    #[error(
        "layer {layer} src range invalid: src_in={src_in} must be in [0, src_out) and src_out={src_out}"
    )]
    InvalidSrcRange {
        layer: LayerId,
        src_in: TimeUs,
        src_out: TimeUs,
    },

    #[error(
        "layer {layer} src range [{src_in}, {src_out}) exceeds media duration {media_duration}"
    )]
    SrcRangeExceedsMedia {
        layer: LayerId,
        src_in: TimeUs,
        src_out: TimeUs,
        media_duration: TimeUs,
    },

    #[error("duplicate layer id {layer}")]
    DuplicateLayerId { layer: LayerId },

    #[error("transition {transition} references unknown layer {layer}")]
    TransitionLayerMissing {
        transition: TransitionId,
        layer: LayerId,
    },

    #[error("transition {transition} from_layer and to_layer must be distinct ({layer})")]
    TransitionSelfReference {
        transition: TransitionId,
        layer: LayerId,
    },

    #[error("transition {transition} from_layer {from} and to_layer {to} are on different tracks")]
    TransitionCrossTrack {
        transition: TransitionId,
        from: LayerId,
        to: LayerId,
    },

    #[error("transition {transition} duration {duration}us must equal layer overlap {overlap}us")]
    TransitionDurationMismatch {
        transition: TransitionId,
        duration: TimeUs,
        overlap: TimeUs,
    },

    #[error(
        "transition {transition} duration {duration}us must be positive and not exceed either layer's length"
    )]
    TransitionDurationOutOfRange {
        transition: TransitionId,
        duration: TimeUs,
    },

    #[error("layer {layer} is in more than one transition on the same side")]
    LayerInMultipleTransitions { layer: LayerId },

    #[error("duplicate transition id {transition}")]
    DuplicateTransitionId { transition: TransitionId },

    #[error("group {group} references unknown layer {layer}")]
    GroupMemberMissing { group: GroupId, layer: LayerId },

    #[error("layer {layer} appears in more than one group ({first} and {second})")]
    LayerInMultipleGroups {
        layer: LayerId,
        first: GroupId,
        second: GroupId,
    },

    #[error("duplicate group id {group}")]
    DuplicateGroupId { group: GroupId },

    #[error("group {group} has fewer than 2 members — should have been auto-dissolved")]
    GroupBelowMinSize { group: GroupId, members: usize },
}

/// A full export master that landed on disk, plus the encoder format version
/// it was produced with. Serializes to a self-describing object
/// (`{ "path": …, "format_version": … }`) so the TS applier reads a legible,
/// drift-resistant wire payload rather than a positional tuple/array.
#[derive(Clone, Debug, Serialize)]
pub struct FullProxyLanded {
    pub path: std::path::PathBuf,
    pub format_version: u32,
}

/// Patch for a media item's derivative paths and decode route. Background jobs
/// apply these when generation completes. The route fields are FOLD SIGNALS:
/// rather than overwriting flat fields, they describe a change the TS state
/// actor folds into the source's current `DecodeRoute` variant (so a
/// route↔path contradiction stays unrepresentable). The plain derivative paths
/// (`waveform_path` / `conform_path` / `thumbnails_dir`) just set the field —
/// once a derivative exists it persists (content-addressed invalidation happens
/// by hash mismatch on re-import). See `docs/preview.md` and docs/adr/0028.
///
/// Each route field keeps `skip_serializing_if = "Option::is_none"` so the TS
/// `'key' in patch` contract (mutations/media.ts) reads absent vs present.
#[derive(Clone, Debug, Default, Serialize)]
pub struct MediaDerivativesPatch {
    /// Authoritative route replacement: the import decision, or a
    /// route-correction. Carries the variant's known payload at the time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_route: Option<crate::state::DecodeRoute>,
    /// A quick proxy landed (`Some(Some(p))`) or was cleared (`Some(None)`);
    /// folded into whatever the current variant is. Ignored on Bypass.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_proxy_landed: Option<Option<std::path::PathBuf>>,
    /// A full export master landed (`Some(Some(FullProxyLanded { .. }))`) or was
    /// cleared (`Some(None)`). Folded into the current Proxied variant; ignored
    /// otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_proxy_landed: Option<Option<FullProxyLanded>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waveform_path: Option<std::path::PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conform_path: Option<std::path::PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnails_dir: Option<std::path::PathBuf>,
}

// ---- CommandError ----

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "error", content = "detail")]
pub enum CommandError {
    #[error("track {track} not found")]
    TrackNotFound { track: TrackId },
    #[error("layer {layer} not found")]
    LayerNotFound { layer: LayerId },
    /// A/B-roll v2 V.7: returned when separate_audio_to_new_track is
    /// invoked on a non-Audio layer.
    #[error("layer {layer} is not a {expected} layer")]
    WrongLayerKind {
        layer: LayerId,
        expected: &'static str,
    },
    #[error("marker {marker} not found")]
    MarkerNotFound { marker: MarkerId },
    #[error("transition {transition} not found")]
    TransitionNotFound { transition: TransitionId },
    #[error(
        "transition layers {from} and {to} are neither adjacent nor pre-overlapped by {duration}us — bring them adjacent first"
    )]
    TransitionLayersNotAdjacent {
        from: LayerId,
        to: LayerId,
        duration: TimeUs,
    },
    #[error("checkpoint {checkpoint} not found")]
    CheckpointNotFound { checkpoint: CheckpointId },
    #[error("media {media} not found")]
    MediaNotFound { media: MediaId },
    #[error(
        "media {media} is referenced by {} layer(s) (use force to delete anyway, which also removes those layers)",
        .referenced_by.len()
    )]
    MediaInUse {
        media: MediaId,
        referenced_by: Vec<LayerId>,
    },
    #[error("track position {position} is out of range for track count {len}")]
    TrackPositionOutOfRange { position: usize, len: usize },
    #[error("track {track} is not empty (use force to delete anyway)")]
    TrackNotEmpty { track: TrackId },
    #[error("track {track} is not removable (default A-roll/B-roll)")]
    TrackNotRemovable { track: TrackId },
    #[error("track {track} is locked")]
    TrackLocked { track: TrackId },
    #[error("split point {at_t}us is outside layer {layer} bounds")]
    SplitOutsideLayer { layer: LayerId, at_t: TimeUs },
    #[error(
        "group op on layer {touched} blocked: member {locked_layer} of group {group} is locked"
    )]
    GroupLockedMember {
        group: GroupId,
        locked_layer: LayerId,
        touched: LayerId,
    },
    #[error(
        "trim edge invalid: new_t_us {new_t}us must satisfy t_start < t_end (current bounds were [{cur_start}, {cur_end}))"
    )]
    TrimEdgeOutOfRange {
        layer: LayerId,
        new_t: TimeUs,
        cur_start: TimeUs,
        cur_end: TimeUs,
    },
    #[error("layer {layer} kind {actual} does not match patch kind {patch}")]
    LayerParamsKindMismatch {
        layer: LayerId,
        actual: &'static str,
        patch: &'static str,
    },
    #[error("group {group} not found")]
    GroupNotFound { group: GroupId },
    #[error("layer {layer} is already in group {existing} — pass reassign=true to move it")]
    LayerAlreadyGrouped { layer: LayerId, existing: GroupId },
    #[error("groups_create needs at least 2 distinct layers, got {got}")]
    GroupCreateNeedsTwoLayers { got: usize },
    #[error("layer {layer} is not a member of group {group}")]
    LayerNotInGroup { group: GroupId, layer: LayerId },
    #[error("nothing to undo")]
    NothingToUndo,
    #[error("nothing to redo")]
    NothingToRedo,
    #[error("history is locked: {reason}")]
    HistoryLocked { reason: String },
    #[error("project invariant violated: {0}")]
    ValidationFailed(ValidationError),
    #[error("keyframe track on layer {layer} param `{param_key}` is empty")]
    EmptyKeyframeTrack { layer: LayerId, param_key: String },
    #[error("param `{param_key}` is not animatable on layer {layer}")]
    UnknownKeyframeParam { layer: LayerId, param_key: String },
    #[error("effect {effect} not found")]
    EffectNotFound { effect: EffectId },
    #[error("effect index {index} out of range for effect count {len}")]
    EffectIndexOutOfRange { index: usize, len: usize },
    /// Step 1a (command-surface unification): a raw argument failed to parse at
    /// the shared command layer — a UUID string, an edge name, etc. Carries the
    /// field so adapters render a precise message. The UI flattens it to a
    /// string; MCP maps it to `invalid_params`.
    #[error("invalid argument `{field}`: {detail}")]
    InvalidArgument { field: String, detail: String },
    /// Step 1a: the napi `Backend` had no project handle (uninitialized). Kept
    /// distinct from validation failures; MCP maps it to `internal_error`,
    /// matching the prior `From<String> for McpToolError` behavior.
    #[error("{0}")]
    Backend(String),
}

impl From<ValidationError> for CommandError {
    fn from(value: ValidationError) -> Self {
        Self::ValidationFailed(value)
    }
}
