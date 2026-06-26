//! Shared command-surface types that outlive the Rust state actor.
//!
//! The Rust actor (`state/actor.rs`) is being decommissioned in Phase 4b.
//! These types must survive that deletion because kept code in `jobs/`,
//! `commands/`, `mcp/`, `motifs/`, and the napi layer depend on them.
//!
//! Phase 4b T4a: moved here verbatim from `actor.rs` (L45–457) and from
//! `validate.rs` (ValidationError). The actor still compiles this task —
//! it re-imports the types from here. This is a pure refactor; no behavior
//! change.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::audio_role::AudioRole;
use super::color::{ColorSpace, Rgba};
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

    #[error(
        "transition {transition} from_layer {from} and to_layer {to} are on different tracks"
    )]
    TransitionCrossTrack {
        transition: TransitionId,
        from: LayerId,
        to: LayerId,
    },

    #[error(
        "transition {transition} duration {duration}us must equal layer overlap {overlap}us"
    )]
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

// ---- Actor ----

// Internally tagged (NOT adjacently tagged): `Agent`'s `client` field
// flattens alongside the `kind` tag → {"kind":"Agent","client":"x"}. This
// shape is serialized whole onto the MCP `/events` feed via
// `ChangeEventSummary`; `content = "client"` (adjacent tagging) would nest it
// as {"kind":"Agent","client":{"client":"x"}} (the "[object Object]" bug).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Actor {
    User,
    Agent { client: String },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id")]
pub enum EntityRef {
    Track(TrackId),
    Layer(LayerId),
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id")]
pub enum DiffHint {
    Coarse,
    Layer(LayerId),
    Composition,
}

/// Which edge of a layer's timeline range to trim.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LayerEdge {
    /// `t_start_us` — the in-point.
    In,
    /// `t_end_us` — the out-point.
    Out,
}

/// Partial update for a layer's envelope. Only `Some(_)` fields are applied.
/// `params_patch` carries kind-specific edits; the property panel sends one
/// of the variant patches so the actor can sanity-check the kind matches.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct LayerPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t_start_us: Option<TimeUs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t_end_us: Option<TimeUs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
}

/// Kind-tagged partial update for a layer's `params`. Fields are scalar so the
/// UI can drive them with simple inputs; the actor lifts them to
/// `Animated::Static(...)` where the underlying shape is animated.
///
/// Limitation: applying a static-value patch to a keyframed field overwrites
/// the keyframe track. Acceptable for the MVP property panel where keyframes
/// are not yet user-editable; revisit when the keyframe UI lands.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum LayerParamsPatch {
    Text(TextPatch),
    VideoClip(VideoClipPatch),
    ImageOverlay(ImageOverlayPatch),
    Motif(MotifPatch),
    Color(ColorPatch),
    Audio(AudioPatch),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct TextPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size_px: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Rgba>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

/// Batch style patch applied to every Text layer on a caption track at once.
/// Snake_case field names to match the codebase patch convention (no rename_all).
/// Sent from the TS side via `restyleCaptionTrack(trackId, patch)`.
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct CaptionStylePatch {
    pub font_family: Option<String>,
    pub font_size_px: Option<f32>,
    pub color: Option<Rgba>,
    pub outline_width: Option<f32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct VideoClipPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src_in_us: Option<TimeUs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src_out_us: Option<TimeUs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flip_h: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flip_v: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_in_us: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_out_us: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ImageOverlayPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_in_us: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_out_us: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MotifPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src_in_us: Option<TimeUs>,
    /// Retarget the layer to a different Motif id (Edit-in-place: swap the
    /// selected layer onto a working draft; Discard: swap it back). Paired with
    /// `motif_version` so the seen-at marker matches the new target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motif_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motif_version: Option<u32>,
    /// Props to merge into the layer's existing `props` map, FIELD-WISE — each
    /// key present here overwrites that key, all other keys are left intact.
    /// (Replacing the whole map would let a stale debounced commit clobber a
    /// concurrent edit; merge can't delete keys, which is fine — the schema
    /// keys are fixed at insert time.) No schema validation here: the actor has
    /// no motif-registry access, and props were already validated against
    /// the manifest's `props_schema` at `add_motif`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub props: Option<std::collections::HashMap<String, serde_json::Value>>,
}

/// One layer's retarget for `rebind_motif`. The caller (install_motif) precomputes
/// the target id/version + migrated props per affected layer; the actor applies by id.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MotifRebindEntry {
    pub layer_id: LayerId,
    pub motif_id: String,
    pub motif_version: u32,
    pub props: imbl::HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct ColorPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Rgba>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct AudioPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src_in_us: Option<TimeUs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src_out_us: Option<TimeUs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain_db: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_in_us: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_out_us: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mute: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<AudioRole>,
}


/// Patch for a media item's derivative paths (proxy / thumbnails / waveform).
/// Background jobs apply these when generation completes. `Some(path)` sets
/// the field; `None` leaves it alone. There's no clear-path here because once
/// a derivative exists, it persists — content-addressed cache invalidation
/// happens by hash mismatch on re-import, not by clearing fields.
///
/// EXCEPT: `proxy_path` IS clearable. `Some(None)` clears it (used by the
/// workspace-open invalidation pass when an existing proxy is stale per
/// `proxy_format_version`); `None` leaves it alone (the common path for
/// fresh-generation patches that don't touch proxies). See
/// `docs/preview.md`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct MediaDerivativesPatch {
    /// Tri-state (Option<Option<PathBuf>>): outer None = absent (leave), Some(None)
    /// = null (clear), Some(Some(p)) = string (set). `skip_serializing_if` on the
    /// OUTER Option is what produces the absent/null/string the TS `'key' in patch`
    /// contract reads (mutations/media.ts:67). DO NOT change to a plain Option.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_path: Option<Option<std::path::PathBuf>>,
    /// Set when the proxy job completes successfully; the workspace-open
    /// invalidation pass uses it to decide whether the cached proxy
    /// matches the current `jobs::proxy::PROXY_FORMAT_VERSION`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_format_version: Option<u32>,
    /// Same tri-state contract as `proxy_path`.
    /// `Some(Some(path))` sets a fast preview proxy; `Some(None)` clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_proxy_path: Option<Option<std::path::PathBuf>>,
    /// Marks the original workspace copy as safe for direct WebCodecs use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_bypassed: Option<bool>,
    /// Marks the original as the export decode source (preview still uses a
    /// generated proxy). `None` leaves the flag unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export_uses_original: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waveform_path: Option<std::path::PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conform_path: Option<std::path::PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnails_dir: Option<std::path::PathBuf>,
}

/// Partial update for a marker. Only `Some(_)` fields apply. Setting
/// `end_t_us` to `Some(None)` is impossible through this shape; clearing the
/// region must round-trip through `remove_marker` + `add_marker`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct MarkerPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t_us: Option<TimeUs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_t_us: Option<TimeUs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Rgba>,
}

/// Partial update for the composition envelope. Only `Some(_)` fields apply.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct CompositionPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<super::time::Rational>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_us: Option<TimeUs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channels: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_space: Option<ColorSpace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<Rgba>,
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
    #[error(
        "layer {layer} is already in group {existing} — pass reassign=true to move it"
    )]
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
