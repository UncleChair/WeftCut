//! Single-writer project actor — all mutations funnel here.
//!
//! Phase 1.2 introduced two load-bearing commands (`add_layer`, `delete_layer`).
//! Phase 1.3 layers undo/redo + named checkpoints on top via `History`.
//! Future phases extend the mutation surface and add validation invariants.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{broadcast, mpsc, oneshot};

use super::audio_role::{AudioRole, RoleFlagsPatch};
use super::color::{ColorSpace, Rgba};
use super::animated::Animated;
use super::history::{History, HistoryEntry, HistoryView, NamedCheckpoint};
use super::group::Group;
use super::ids::{
    CheckpointId, GroupId, LayerId, MarkerId, MediaId, OpId, TrackId, TransitionId, new_id,
};
use super::layer::{Layer, LayerParams};
use super::marker::Marker;
use super::media::MediaItem;
use super::project::{Project, ProjectSettingsPatch, TrackFlagsPatch};
use super::time::{Rational, TimeUs};
use super::track::{Track, TrackRole};
use super::transition::{Transition, TransitionKind};
use super::validate::{ValidationError, validate};

const INBOX_CAPACITY: usize = 100;
const BROADCAST_CAPACITY: usize = 256;

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
#[derive(Clone, Debug)]
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
#[derive(Clone, Debug, Default)]
pub struct MediaDerivativesPatch {
    pub proxy_path: Option<Option<std::path::PathBuf>>,
    /// Set when the proxy job completes successfully; the workspace-open
    /// invalidation pass uses it to decide whether the cached proxy
    /// matches the current `jobs::proxy::PROXY_FORMAT_VERSION`.
    pub proxy_format_version: Option<u32>,
    /// `Some(Some(path))` sets a fast preview proxy; `Some(None)` clears it.
    pub quick_proxy_path: Option<Option<std::path::PathBuf>>,
    /// Marks the original workspace copy as safe for direct WebCodecs use.
    pub proxy_bypassed: Option<bool>,
    /// Marks the original as the export decode source (preview still uses a
    /// generated proxy). `None` leaves the flag unchanged.
    pub export_uses_original: Option<bool>,
    pub waveform_path: Option<std::path::PathBuf>,
    pub conform_path: Option<std::path::PathBuf>,
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
    pub fps: Option<Rational>,
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

/// Broadcast to UI + MCP change feed after every successful mutation.
#[derive(Clone, Debug)]
pub struct ChangeEvent {
    pub op_id: OpId,
    pub actor: Actor,
    pub timestamp: DateTime<Utc>,
    pub summary: String,
    pub affected: Vec<EntityRef>,
    pub new_snapshot: Arc<Project>,
    pub diff_hint: DiffHint,
}

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
}

impl From<ValidationError> for CommandError {
    fn from(value: ValidationError) -> Self {
        Self::ValidationFailed(value)
    }
}

enum Command {
    AddTrack {
        label: Option<String>,
        /// When `true`, the new track flips its `transient` flag so the
        /// auto-prune sweep deletes it the moment its `layers` becomes
        /// empty. R.3 import flow sets this; the legacy `add_track`
        /// command leaves it `false`.
        transient: bool,
        /// V.8: insertion position in `project.tracks`. `None` = append
        /// (top of z-stack, visually at top under the v2 reverse-data-
        /// model rendering). `Some(0)` = prepend (bottom of z-stack,
        /// visually at the bottom of the timeline — used by the V.3
        /// import flow so transient holding tracks live out of the way).
        position: Option<usize>,
        actor: Actor,
        reply: oneshot::Sender<Result<TrackId, CommandError>>,
    },
    DeleteTrack {
        id: TrackId,
        force: bool,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    SeparateAudio {
        layer_id: LayerId,
        actor: Actor,
        reply: oneshot::Sender<Result<TrackId, CommandError>>,
    },
    AddLayer {
        track_id: TrackId,
        params: LayerParams,
        t_start_us: TimeUs,
        t_end_us: TimeUs,
        actor: Actor,
        reply: oneshot::Sender<Result<LayerId, CommandError>>,
    },
    DeleteLayer {
        id: LayerId,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    RebindMotif {
        updates: Vec<MotifRebindEntry>,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    SplitLayer {
        id: LayerId,
        at_t_us: TimeUs,
        escape_group: bool,
        actor: Actor,
        reply: oneshot::Sender<Result<(LayerId, LayerId), CommandError>>,
    },
    TrimLayer {
        id: LayerId,
        edge: LayerEdge,
        new_t_us: TimeUs,
        escape_group: bool,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    ReplaceState {
        next: Box<Project>,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    AddMediaItem {
        item: Box<MediaItem>,
        actor: Actor,
        reply: oneshot::Sender<Result<MediaId, CommandError>>,
    },
    UpdateLayer {
        id: LayerId,
        patch: LayerPatch,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    UpdateLayerParams {
        id: LayerId,
        patch: LayerParamsPatch,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    UpdateLayerParamTrack {
        id: LayerId,
        param_key: String,
        track: Animated<f64>,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    UpdateLayerParamTracks {
        id: LayerId,
        entries: Vec<(String, Animated<f64>)>,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    MoveLayer {
        id: LayerId,
        new_track_id: TrackId,
        new_t_start_us: TimeUs,
        escape_group: bool,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    DuplicateLayer {
        id: LayerId,
        t_offset_us: TimeUs,
        actor: Actor,
        reply: oneshot::Sender<Result<LayerId, CommandError>>,
    },
    SetComposition {
        patch: CompositionPatch,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    FitCompositionToLayers {
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    UpdateProjectSettings {
        patch: ProjectSettingsPatch,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    UpdateTrackFlags {
        id: TrackId,
        patch: TrackFlagsPatch,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    SetRoleGain {
        role: AudioRole,
        gain_db: f64,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    UpdateRoleFlags {
        role: AudioRole,
        patch: RoleFlagsPatch,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    AddMarker {
        t_us: TimeUs,
        end_t_us: Option<TimeUs>,
        label: String,
        color: Rgba,
        actor: Actor,
        reply: oneshot::Sender<Result<MarkerId, CommandError>>,
    },
    UpdateMarker {
        id: MarkerId,
        patch: MarkerPatch,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    RemoveMarker {
        id: MarkerId,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    AddTransition {
        from_layer: LayerId,
        to_layer: LayerId,
        duration_us: TimeUs,
        kind: TransitionKind,
        actor: Actor,
        reply: oneshot::Sender<Result<TransitionId, CommandError>>,
    },
    RemoveTransition {
        id: TransitionId,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    MoveTrack {
        id: TrackId,
        new_position: usize,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    RemoveMedia {
        id: MediaId,
        force: bool,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    SetMediaDerivatives {
        id: MediaId,
        patch: MediaDerivativesPatch,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    /// Per workspace-redesign Q6: the background import worker (`jobs::
    /// import`) copies the source file into `<workspace>/Media/` and then
    /// calls back through this command with the new absolute path + the
    /// workspace-relative anchor. Sits outside the undo stack — it's a
    /// background reconciliation, not a user edit.
    SetMediaWorkspacePaths {
        id: MediaId,
        path_abs: std::path::PathBuf,
        path_rel: std::path::PathBuf,
        file_hash_blake3: String,
        file_size: u64,
        file_mtime: u64,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    GroupsCreate {
        layer_ids: Vec<LayerId>,
        label: Option<String>,
        reassign: bool,
        actor: Actor,
        reply: oneshot::Sender<Result<GroupId, CommandError>>,
    },
    GroupsDissolve {
        id: GroupId,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    GroupsAddMembers {
        id: GroupId,
        layer_ids: Vec<LayerId>,
        reassign: bool,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    GroupsRemoveMembers {
        id: GroupId,
        layer_ids: Vec<LayerId>,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    GroupsRename {
        id: GroupId,
        label: Option<String>,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    // GroupsSetEffects / LayersSetEffects ops were removed in P12-a:
    // the Pixi renderer doesn't read effects in v1, so the mutation
    // surface for them is dead. The `effects` field on Layer / Group
    // stays alive (P12-b sweeps it together with the IR visual half)
    // but nothing can write to it from the UI / MCP layer anymore.
    Undo {
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    Redo {
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    Checkpoint {
        label: String,
        actor: Actor,
        reply: oneshot::Sender<CheckpointId>,
    },
    ListCheckpoints {
        reply: oneshot::Sender<Vec<NamedCheckpoint>>,
    },
    RestoreCheckpoint {
        id: CheckpointId,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    LockHistory {
        reason: String,
        reply: oneshot::Sender<()>,
    },
    UnlockHistory {
        reply: oneshot::Sender<()>,
    },
    Snapshot {
        reply: oneshot::Sender<Arc<Project>>,
    },
    HistoryStatus {
        reply: oneshot::Sender<HistoryStatus>,
    },
    HistoryView {
        limit: usize,
        reply: oneshot::Sender<HistoryView>,
    },
    DryRun {
        ops: Vec<DryRunOp>,
        reply: oneshot::Sender<Vec<Result<DryRunOutput, CommandError>>>,
    },
}

/// Operations the `dry_run` dispatcher can apply against a clone of the
/// current project. This is the actor-side parallel of `mcp::OperationSpec`
/// — string UUIDs come in at the MCP boundary and get parsed into proper
/// id types before reaching this enum.
#[derive(Debug, Clone)]
pub enum DryRunOp {
    AddLayer {
        track_id: TrackId,
        params: LayerParams,
        t_start_us: TimeUs,
        t_end_us: TimeUs,
    },
    DeleteLayer {
        id: LayerId,
    },
    UpdateLayer {
        id: LayerId,
        patch: LayerPatch,
    },
    UpdateLayerParams {
        id: LayerId,
        patch: LayerParamsPatch,
    },
    MoveLayer {
        id: LayerId,
        new_track_id: TrackId,
        new_t_start_us: TimeUs,
        #[allow(dead_code)]
        escape_group: bool,
    },
    SplitLayer {
        id: LayerId,
        at_t_us: TimeUs,
        #[allow(dead_code)]
        escape_group: bool,
    },
    TrimLayer {
        id: LayerId,
        edge: LayerEdge,
        new_t_us: TimeUs,
        escape_group: bool,
    },
}

/// Per-op output from a successful dry-run application. Voids (delete /
/// update / move) carry no payload; layer-producing ops surface the id(s)
/// that real execution would have allocated. Note: the layer ids here are
/// freshly generated on EACH dry-run pass, so two consecutive dry-runs of
/// the same op chain produce different ids.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DryRunOutput {
    AddLayer { layer_id: LayerId },
    SplitLayer { left_id: LayerId, right_id: LayerId },
    /// Void op — delete / update / move. No payload.
    Void,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryStatus {
    pub cursor: usize,
    pub len: usize,
    pub can_undo: bool,
    pub can_redo: bool,
    /// `Some(reason)` while the revert surface is locked. Surfaced
    /// through to the UI so the agent-mode record panel can render
    /// a lock badge and the editor-mode menu can disable Undo /
    /// Redo with a tooltip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ProjectHandle {
    tx: mpsc::Sender<Command>,
    events: broadcast::Sender<ChangeEvent>,
}

impl ProjectHandle {
    pub fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        self.events.subscribe()
    }

    pub async fn snapshot(&self) -> Arc<Project> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::Snapshot { reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn history_status(&self) -> HistoryStatus {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::HistoryStatus { reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Snapshot-free view of recent history (last `limit` ops + checkpoints).
    /// Used by MCP `project://history` and any UI history panel.
    pub async fn history_view(&self, limit: usize) -> HistoryView {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::HistoryView { limit, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Run a sequence of mutations against a CLONE of the current project,
    /// validating after each successful op. Halts at the first error so
    /// later ops don't dry-run against a state real execution wouldn't
    /// reach. Never commits — used by the MCP `dry_run` tool so agents can
    /// preview multi-step edits before mutating real state.
    pub async fn dry_run(
        &self,
        ops: Vec<DryRunOp>,
    ) -> Vec<Result<DryRunOutput, CommandError>> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::DryRun { ops, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn add_track(
        &self,
        actor: Actor,
        label: Option<String>,
    ) -> Result<TrackId, CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::AddTrack {
                label,
                transient: false,
                position: None,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Like `add_track` but flags the new track as `transient` AND
    /// prepends it at data-model index 0 so V.8's visualOrderedTracks
    /// renders it at the BOTTOM of the timeline UI (out of the way of
    /// the reserved A/B-roll skeleton). Used by `import_media` (V.3)
    /// to land an import's layer on a fresh hidden holding track.
    pub async fn add_transient_track(
        &self,
        actor: Actor,
        label: Option<String>,
    ) -> Result<TrackId, CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::AddTrack {
                label,
                transient: true,
                position: Some(0),
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn add_layer(
        &self,
        actor: Actor,
        track_id: TrackId,
        params: LayerParams,
        t_start_us: TimeUs,
        t_end_us: TimeUs,
    ) -> Result<LayerId, CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::AddLayer {
                track_id,
                params,
                t_start_us,
                t_end_us,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn delete_layer(&self, actor: Actor, id: LayerId) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::DeleteLayer { id, actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Retarget a set of Motif layers (by id) to new motif_id/version/props in
    /// one undo entry. Used by install_motif's Update path to rebind working-draft
    /// layers onto the published target and migrate every affected layer's props.
    pub async fn rebind_motif(
        &self,
        actor: Actor,
        updates: Vec<MotifRebindEntry>,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::RebindMotif {
                updates,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn delete_track(
        &self,
        actor: Actor,
        id: TrackId,
        force: bool,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::DeleteTrack {
                id,
                force,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// A/B-roll v2 V.7: lift `layer_id` (must be an Audio layer) onto a
    /// freshly-created non-transient track inserted directly after the
    /// layer's current track. Used by the timeline's "Separate audio"
    /// context-menu action to break the combined-row rendering for a
    /// specific AV pair without dissolving its group.
    ///
    /// Returns the newly-created track's id so the caller can scroll /
    /// select if desired.
    pub async fn separate_audio_to_new_track(
        &self,
        actor: Actor,
        layer_id: LayerId,
    ) -> Result<TrackId, CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::SeparateAudio {
                layer_id,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Split a layer at `at_t_us`. When the layer is in a group and
    /// `escape_group=false` (default), every group member whose interval
    /// strictly contains `at_t_us` is also split there, with all resulting
    /// pieces staying in the same group. See `docs/groups.md`.
    pub async fn split_layer(
        &self,
        actor: Actor,
        id: LayerId,
        at_t_us: TimeUs,
        escape_group: bool,
    ) -> Result<(LayerId, LayerId), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::SplitLayer {
                id,
                at_t_us,
                escape_group,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Trim one edge of a layer's timeline range. When the layer is in a
    /// group and `escape_group=false`, every group member whose corresponding
    /// edge sits at the same time as the trimmed layer's pre-trim edge is
    /// moved by the same delta. The op is clamped to the most restrictive
    /// aligned member's source-bound / `t_start < t_end` constraint. See
    /// `docs/groups.md`.
    pub async fn trim_layer(
        &self,
        actor: Actor,
        id: LayerId,
        edge: LayerEdge,
        new_t_us: TimeUs,
        escape_group: bool,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::TrimLayer {
                id,
                edge,
                new_t_us,
                escape_group,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn replace_state(
        &self,
        actor: Actor,
        next: Project,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::ReplaceState {
                next: Box::new(next),
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn add_media_item(
        &self,
        actor: Actor,
        item: MediaItem,
    ) -> Result<MediaId, CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::AddMediaItem {
                item: Box::new(item),
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn update_layer(
        &self,
        actor: Actor,
        id: LayerId,
        patch: LayerPatch,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateLayer {
                id,
                patch,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn update_layer_params(
        &self,
        actor: Actor,
        id: LayerId,
        patch: LayerParamsPatch,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateLayerParams {
                id,
                patch,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn update_layer_param_track(
        &self,
        actor: Actor,
        id: LayerId,
        param_key: String,
        track: Animated<f64>,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateLayerParamTrack {
                id,
                param_key,
                track,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn update_layer_param_tracks(
        &self,
        actor: Actor,
        id: LayerId,
        entries: Vec<(String, Animated<f64>)>,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateLayerParamTracks {
                id,
                entries,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Move a layer to `new_track_id` at `new_t_start_us`. When the layer
    /// is in a group and `escape_group=false` (default), every group member
    /// shifts in time by the same delta as the moved layer; only the
    /// targeted layer's track changes (track changes never propagate). See
    /// `docs/groups.md`.
    pub async fn move_layer(
        &self,
        actor: Actor,
        id: LayerId,
        new_track_id: TrackId,
        new_t_start_us: TimeUs,
        escape_group: bool,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::MoveLayer {
                id,
                new_track_id,
                new_t_start_us,
                escape_group,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn duplicate_layer(
        &self,
        actor: Actor,
        id: LayerId,
        t_offset_us: TimeUs,
    ) -> Result<LayerId, CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::DuplicateLayer {
                id,
                t_offset_us,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn set_composition(
        &self,
        actor: Actor,
        patch: CompositionPatch,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::SetComposition {
                patch,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Clear `duration_pinned` and re-fit `duration_us` to the layer
    /// high-water mark. The companion to an explicit
    /// `set_composition { duration_us }`: the latter pins, this unpins.
    /// See ADR 0005.
    pub async fn fit_composition_to_layers(
        &self,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::FitCompositionToLayers { actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Patch per-project behavior settings (`Project.settings`).
    /// Preference-shaped, not editing-shaped: the patch is applied to
    /// every history snapshot and NOT recorded, so Ctrl-Z never flips a
    /// Settings-panel toggle.
    pub async fn update_project_settings(
        &self,
        actor: Actor,
        patch: ProjectSettingsPatch,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateProjectSettings {
                patch,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Toggle a track's enabled/muted/solo/locked flags (timeline header
    /// eye/M/S/lock buttons). Preference-shaped, not editing-shaped: the
    /// patch is applied to every history snapshot and NOT recorded, so
    /// Ctrl-Z never flips a track toggle.
    pub async fn update_track_flags(
        &self,
        actor: Actor,
        id: TrackId,
        patch: TrackFlagsPatch,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateTrackFlags {
                id,
                patch,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Set a role's mix-bus gain (recorded — undoable like a normal edit).
    pub async fn set_role_gain(
        &self,
        actor: Actor,
        role: AudioRole,
        gain_db: f64,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::SetRoleGain {
                role,
                gain_db,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Toggle a role's mute/solo (unrecorded — preference, never reverted
    /// by Ctrl-Z; mirrors `update_track_flags`).
    pub async fn update_role_flags(
        &self,
        actor: Actor,
        role: AudioRole,
        patch: RoleFlagsPatch,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateRoleFlags {
                role,
                patch,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn add_marker(
        &self,
        actor: Actor,
        t_us: TimeUs,
        end_t_us: Option<TimeUs>,
        label: impl Into<String>,
        color: Rgba,
    ) -> Result<MarkerId, CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::AddMarker {
                t_us,
                end_t_us,
                label: label.into(),
                color,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn update_marker(
        &self,
        actor: Actor,
        id: MarkerId,
        patch: MarkerPatch,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateMarker {
                id,
                patch,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn remove_marker(&self, actor: Actor, id: MarkerId) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::RemoveMarker { id, actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn add_transition(
        &self,
        actor: Actor,
        from_layer: LayerId,
        to_layer: LayerId,
        duration_us: TimeUs,
        kind: TransitionKind,
    ) -> Result<TransitionId, CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::AddTransition {
                from_layer,
                to_layer,
                duration_us,
                kind,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn remove_transition(
        &self,
        actor: Actor,
        id: TransitionId,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::RemoveTransition { id, actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// `docs/groups.md` — bundle ≥2 layers into a unit that moves /
    /// trims / splits together. Members must not be in any other group
    /// unless `reassign == true` (in which case they're moved here and
    /// the prior group auto-dissolves below 2 members).
    pub async fn groups_create(
        &self,
        actor: Actor,
        layer_ids: Vec<LayerId>,
        label: Option<String>,
        reassign: bool,
    ) -> Result<GroupId, CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::GroupsCreate {
                layer_ids,
                label,
                reassign,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn groups_dissolve(
        &self,
        actor: Actor,
        id: GroupId,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::GroupsDissolve { id, actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn groups_add_members(
        &self,
        actor: Actor,
        id: GroupId,
        layer_ids: Vec<LayerId>,
        reassign: bool,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::GroupsAddMembers {
                id,
                layer_ids,
                reassign,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn groups_remove_members(
        &self,
        actor: Actor,
        id: GroupId,
        layer_ids: Vec<LayerId>,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::GroupsRemoveMembers {
                id,
                layer_ids,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn groups_rename(
        &self,
        actor: Actor,
        id: GroupId,
        label: Option<String>,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::GroupsRename {
                id,
                label,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn move_track(
        &self,
        actor: Actor,
        id: TrackId,
        new_position: usize,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::MoveTrack {
                id,
                new_position,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn remove_media(
        &self,
        actor: Actor,
        id: MediaId,
        force: bool,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::RemoveMedia {
                id,
                force,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Background import worker callback: replace a media item's
    /// `path_abs` / `path_rel` once the source has been copied into
    /// `<workspace>/Media/`. Outside the editing undo stack — mirrors
    /// `set_media_derivatives`.
    pub async fn set_media_workspace_paths(
        &self,
        actor: Actor,
        id: MediaId,
        path_abs: std::path::PathBuf,
        path_rel: std::path::PathBuf,
        file_hash_blake3: String,
        file_size: u64,
        file_mtime: u64,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::SetMediaWorkspacePaths {
                id,
                path_abs,
                path_rel,
                file_hash_blake3,
                file_size,
                file_mtime,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Apply a derivatives patch to a media item — used by background jobs
    /// when proxy / thumbnails / waveform generation completes. Sits outside
    /// the editing undo stack (mirrors `add_media_item` semantics) so undoing
    /// past a generation event doesn't toggle the cached path on/off.
    pub async fn set_media_derivatives(
        &self,
        actor: Actor,
        id: MediaId,
        patch: MediaDerivativesPatch,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::SetMediaDerivatives {
                id,
                patch,
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn undo(&self, actor: Actor) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::Undo { actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn redo(&self, actor: Actor) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::Redo { actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn checkpoint(&self, actor: Actor, label: impl Into<String>) -> CheckpointId {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::Checkpoint {
                label: label.into(),
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn list_checkpoints(&self) -> Vec<NamedCheckpoint> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::ListCheckpoints { reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Take the revert lock. While set, undo/redo/restore_checkpoint
    /// reject with `CommandError::HistoryLocked`. Last-writer-wins.
    pub async fn lock_history(&self, reason: String) {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::LockHistory { reason, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Release the revert lock. Idempotent.
    pub async fn unlock_history(&self) {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UnlockHistory { reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn restore_checkpoint(
        &self,
        actor: Actor,
        id: CheckpointId,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::RestoreCheckpoint { id, actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }
}

pub struct ProjectActor {
    history: History,
    inbox: mpsc::Receiver<Command>,
    events: broadcast::Sender<ChangeEvent>,
}

pub fn spawn(initial: Project) -> ProjectHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel(INBOX_CAPACITY);
    let (event_tx, _) = broadcast::channel::<ChangeEvent>(BROADCAST_CAPACITY);
    let actor = ProjectActor {
        history: History::new(Arc::new(initial), Actor::User),
        inbox: cmd_rx,
        events: event_tx.clone(),
    };
    tokio::spawn(actor.run());
    ProjectHandle {
        tx: cmd_tx,
        events: event_tx,
    }
}

impl ProjectActor {
    async fn run(mut self) {
        while let Some(cmd) = self.inbox.recv().await {
            self.handle(cmd);
        }
    }

    fn handle(&mut self, cmd: Command) {
        match cmd {
            Command::AddTrack {
                label,
                transient,
                position,
                actor,
                reply,
            } => {
                let result = self.do_add_track(label, transient, position, actor);
                let _ = reply.send(result);
            }
            Command::AddLayer {
                track_id,
                params,
                t_start_us,
                t_end_us,
                actor,
                reply,
            } => {
                let result = self.do_add_layer(track_id, params, t_start_us, t_end_us, actor);
                let _ = reply.send(result);
            }
            Command::DeleteLayer { id, actor, reply } => {
                let result = self.do_delete_layer(id, actor);
                let _ = reply.send(result);
            }
            Command::RebindMotif {
                updates,
                actor,
                reply,
            } => {
                let result = self.do_rebind_motif(updates, actor);
                let _ = reply.send(result);
            }
            Command::DeleteTrack {
                id,
                force,
                actor,
                reply,
            } => {
                let result = self.do_delete_track(id, force, actor);
                let _ = reply.send(result);
            }
            Command::SeparateAudio {
                layer_id,
                actor,
                reply,
            } => {
                let result = self.do_separate_audio(layer_id, actor);
                let _ = reply.send(result);
            }
            Command::SplitLayer {
                id,
                at_t_us,
                escape_group,
                actor,
                reply,
            } => {
                let result = self.do_split_layer(id, at_t_us, escape_group, actor);
                let _ = reply.send(result);
            }
            Command::TrimLayer {
                id,
                edge,
                new_t_us,
                escape_group,
                actor,
                reply,
            } => {
                let result = self.do_trim_layer(id, edge, new_t_us, escape_group, actor);
                let _ = reply.send(result);
            }
            Command::ReplaceState { next, actor, reply } => {
                let result = self.do_replace_state(*next, actor);
                let _ = reply.send(result);
            }
            Command::AddMediaItem { item, actor, reply } => {
                let result = self.do_add_media_item(*item, actor);
                let _ = reply.send(result);
            }
            Command::UpdateLayer {
                id,
                patch,
                actor,
                reply,
            } => {
                let result = self.do_update_layer(id, patch, actor);
                let _ = reply.send(result);
            }
            Command::UpdateLayerParams {
                id,
                patch,
                actor,
                reply,
            } => {
                let result = self.do_update_layer_params(id, patch, actor);
                let _ = reply.send(result);
            }
            Command::UpdateLayerParamTrack {
                id,
                param_key,
                track,
                actor,
                reply,
            } => {
                let result = self.do_update_layer_param_track(id, param_key, track, actor);
                let _ = reply.send(result);
            }
            Command::UpdateLayerParamTracks {
                id,
                entries,
                actor,
                reply,
            } => {
                let result = self.do_update_layer_param_tracks(id, entries, actor);
                let _ = reply.send(result);
            }
            Command::MoveLayer {
                id,
                new_track_id,
                new_t_start_us,
                escape_group,
                actor,
                reply,
            } => {
                let result =
                    self.do_move_layer(id, new_track_id, new_t_start_us, escape_group, actor);
                let _ = reply.send(result);
            }
            Command::DuplicateLayer {
                id,
                t_offset_us,
                actor,
                reply,
            } => {
                let result = self.do_duplicate_layer(id, t_offset_us, actor);
                let _ = reply.send(result);
            }
            Command::SetComposition {
                patch,
                actor,
                reply,
            } => {
                let result = self.do_set_composition(patch, actor);
                let _ = reply.send(result);
            }
            Command::FitCompositionToLayers { actor, reply } => {
                let result = self.do_fit_composition_to_layers(actor);
                let _ = reply.send(result);
            }
            Command::UpdateProjectSettings {
                patch,
                actor,
                reply,
            } => {
                let result = self.do_update_project_settings(patch, actor);
                let _ = reply.send(result);
            }
            Command::UpdateTrackFlags {
                id,
                patch,
                actor,
                reply,
            } => {
                let result = self.do_update_track_flags(id, patch, actor);
                let _ = reply.send(result);
            }
            Command::SetRoleGain {
                role,
                gain_db,
                actor,
                reply,
            } => {
                let result = self.do_set_role_gain(role, gain_db, actor);
                let _ = reply.send(result);
            }
            Command::UpdateRoleFlags {
                role,
                patch,
                actor,
                reply,
            } => {
                let result = self.do_update_role_flags(role, patch, actor);
                let _ = reply.send(result);
            }
            Command::AddMarker {
                t_us,
                end_t_us,
                label,
                color,
                actor,
                reply,
            } => {
                let result = self.do_add_marker(t_us, end_t_us, label, color, actor);
                let _ = reply.send(result);
            }
            Command::UpdateMarker {
                id,
                patch,
                actor,
                reply,
            } => {
                let result = self.do_update_marker(id, patch, actor);
                let _ = reply.send(result);
            }
            Command::RemoveMarker { id, actor, reply } => {
                let result = self.do_remove_marker(id, actor);
                let _ = reply.send(result);
            }
            Command::AddTransition {
                from_layer,
                to_layer,
                duration_us,
                kind,
                actor,
                reply,
            } => {
                let result =
                    self.do_add_transition(from_layer, to_layer, duration_us, kind, actor);
                let _ = reply.send(result);
            }
            Command::RemoveTransition { id, actor, reply } => {
                let result = self.do_remove_transition(id, actor);
                let _ = reply.send(result);
            }
            Command::MoveTrack {
                id,
                new_position,
                actor,
                reply,
            } => {
                let result = self.do_move_track(id, new_position, actor);
                let _ = reply.send(result);
            }
            Command::RemoveMedia {
                id,
                force,
                actor,
                reply,
            } => {
                let result = self.do_remove_media(id, force, actor);
                let _ = reply.send(result);
            }
            Command::SetMediaDerivatives {
                id,
                patch,
                actor,
                reply,
            } => {
                let result = self.do_set_media_derivatives(id, patch, actor);
                let _ = reply.send(result);
            }
            Command::SetMediaWorkspacePaths {
                id,
                path_abs,
                path_rel,
                file_hash_blake3,
                file_size,
                file_mtime,
                actor,
                reply,
            } => {
                let result = self.do_set_media_workspace_paths(
                    id,
                    path_abs,
                    path_rel,
                    file_hash_blake3,
                    file_size,
                    file_mtime,
                    actor,
                );
                let _ = reply.send(result);
            }
            Command::GroupsCreate {
                layer_ids,
                label,
                reassign,
                actor,
                reply,
            } => {
                let result = self.do_groups_create(layer_ids, label, reassign, actor);
                let _ = reply.send(result);
            }
            Command::GroupsDissolve { id, actor, reply } => {
                let result = self.do_groups_dissolve(id, actor);
                let _ = reply.send(result);
            }
            Command::GroupsAddMembers {
                id,
                layer_ids,
                reassign,
                actor,
                reply,
            } => {
                let result = self.do_groups_add_members(id, layer_ids, reassign, actor);
                let _ = reply.send(result);
            }
            Command::GroupsRemoveMembers {
                id,
                layer_ids,
                actor,
                reply,
            } => {
                let result = self.do_groups_remove_members(id, layer_ids, actor);
                let _ = reply.send(result);
            }
            Command::GroupsRename {
                id,
                label,
                actor,
                reply,
            } => {
                let result = self.do_groups_rename(id, label, actor);
                let _ = reply.send(result);
            }
            Command::Undo { actor, reply } => {
                let result = self.do_undo(actor);
                let _ = reply.send(result);
            }
            Command::Redo { actor, reply } => {
                let result = self.do_redo(actor);
                let _ = reply.send(result);
            }
            Command::Checkpoint {
                label,
                actor,
                reply,
            } => {
                let id = self.history.checkpoint(label, actor);
                let _ = reply.send(id);
            }
            Command::ListCheckpoints { reply } => {
                let _ = reply.send(self.history.list_checkpoints());
            }
            Command::LockHistory { reason, reply } => {
                self.history.lock(reason);
                let _ = reply.send(());
            }
            Command::UnlockHistory { reply } => {
                self.history.unlock();
                let _ = reply.send(());
            }
            Command::RestoreCheckpoint { id, actor, reply } => {
                let result = self.do_restore_checkpoint(id, actor);
                let _ = reply.send(result);
            }
            Command::Snapshot { reply } => {
                let _ = reply.send(self.history.current());
            }
            Command::HistoryStatus { reply } => {
                let _ = reply.send(HistoryStatus {
                    cursor: self.history.cursor(),
                    len: self.history.len(),
                    can_undo: self.history.can_undo(),
                    can_redo: self.history.can_redo(),
                    lock_reason: self.history.lock_reason().map(str::to_string),
                });
            }
            Command::HistoryView { limit, reply } => {
                let _ = reply.send(self.history.view(limit));
            }
            Command::DryRun { ops, reply } => {
                let results = self.do_dry_run(ops);
                let _ = reply.send(results);
            }
        }
    }

    /// Dispatcher for `Command::DryRun`. Clones the current project, applies
    /// each op via the shared `apply_*` mutation helpers, validates after
    /// each successful application, and halts at the first error so the
    /// agent sees exactly the op that would fail in real execution. The
    /// clone is dropped on return — the actor's state is never touched.
    fn do_dry_run(
        &self,
        ops: Vec<DryRunOp>,
    ) -> Vec<Result<DryRunOutput, CommandError>> {
        let mut next: Project = (*self.history.current()).clone();
        let mut results: Vec<Result<DryRunOutput, CommandError>> =
            Vec::with_capacity(ops.len());
        for op in ops {
            let outcome: Result<DryRunOutput, CommandError> = match op {
                DryRunOp::AddLayer {
                    track_id,
                    params,
                    t_start_us,
                    t_end_us,
                } => apply_add_layer(&mut next, track_id, params, t_start_us, t_end_us)
                    .map(|layer_id| DryRunOutput::AddLayer { layer_id }),
                DryRunOp::DeleteLayer { id } => {
                    apply_delete_layer(&mut next, id).map(|_| DryRunOutput::Void)
                }
                DryRunOp::UpdateLayer { id, patch } => {
                    apply_update_layer(&mut next, id, &patch).map(|_| DryRunOutput::Void)
                }
                DryRunOp::UpdateLayerParams { id, patch } => {
                    apply_update_layer_params(&mut next, id, &patch)
                        .map(|_| DryRunOutput::Void)
                }
                DryRunOp::MoveLayer {
                    id,
                    new_track_id,
                    new_t_start_us,
                    escape_group,
                } => apply_move_layer(&mut next, id, new_track_id, new_t_start_us, escape_group)
                    .map(|_| DryRunOutput::Void),
                DryRunOp::SplitLayer {
                    id,
                    at_t_us,
                    escape_group,
                } => apply_split_layer(&mut next, id, at_t_us, escape_group).map(
                    |(left_id, right_id)| DryRunOutput::SplitLayer { left_id, right_id },
                ),
                DryRunOp::TrimLayer {
                    id,
                    edge,
                    new_t_us,
                    escape_group,
                } => apply_trim_layer(&mut next, id, edge, new_t_us, escape_group)
                    .map(|_| DryRunOutput::Void),
            };
            // Validate after each successful op. If an op's mutation
            // succeeds but the resulting project violates an invariant
            // (overlap, inverted range, …), surface it as that op's error
            // — real execution would have rejected at the same point via
            // `commit()`'s validate call.
            let outcome = outcome.and_then(|out| {
                validate(&next).map(|_| out).map_err(CommandError::from)
            });
            let halt = outcome.is_err();
            results.push(outcome);
            if halt {
                break;
            }
        }
        results
    }

    fn do_add_track(
        &mut self,
        label: Option<String>,
        transient: bool,
        position: Option<usize>,
        actor: Actor,
    ) -> Result<TrackId, CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let mut track = Track::new();
        track.label = label;
        track.transient = transient;
        let track_id = track.id;
        // V.8 insertion position. `None` = append (legacy / explicit
        // adds). `Some(i)` = insert at index `i`, shifting existing
        // tracks at `i..` up by one. Clamp to [0, len] so a too-high
        // index degrades to "append" rather than panicking.
        let len = next.tracks.len();
        let insert_at = position.unwrap_or(len).min(len);
        next.tracks.insert(insert_at, track);
        self.commit(
            next,
            actor,
            format!("Added track {track_id}"),
            vec![EntityRef::Track(track_id)],
            DiffHint::Coarse,
        )?;
        Ok(track_id)
    }

    fn do_add_layer(
        &mut self,
        track_id: TrackId,
        params: LayerParams,
        t_start_us: TimeUs,
        t_end_us: TimeUs,
        actor: Actor,
    ) -> Result<LayerId, CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let layer_id = apply_add_layer(&mut next, track_id, params, t_start_us, t_end_us)?;
        self.commit(
            next,
            actor,
            format!("Added layer {layer_id} on track {track_id}"),
            vec![EntityRef::Layer(layer_id), EntityRef::Track(track_id)],
            DiffHint::Layer(layer_id),
        )?;
        Ok(layer_id)
    }

    /// A/B-roll v2 V.7: lift an Audio layer onto a freshly-created
    /// non-transient track inserted directly after the layer's current
    /// track. The group membership (if any) survives — only the
    /// data-model placement changes. UI consequence (V.6 combined-row
    /// rendering): the source row collapses to V-only chrome and the
    /// new row below shows the waveform on its own.
    ///
    /// Errors:
    ///   - LayerNotFound: `layer_id` doesn't exist in the project
    ///   - WrongLayerKind: layer isn't an Audio layer
    fn do_separate_audio(
        &mut self,
        layer_id: LayerId,
        actor: Actor,
    ) -> Result<TrackId, CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        // Locate.
        let (ti, li) = locate_layer(&next, layer_id)
            .ok_or(CommandError::LayerNotFound { layer: layer_id })?;
        let source_track = &next.tracks[ti];
        let layer = &source_track.layers[li];
        if !matches!(layer.params, LayerParams::Audio(_)) {
            return Err(CommandError::WrongLayerKind {
                layer: layer_id,
                expected: "Audio",
            });
        }
        // Build the new non-transient track. Label derives from the
        // source track ("X (audio)") so the user can see the
        // relationship in the timeline header.
        let mut new_track = Track::new();
        let source_label = source_track.label.clone();
        new_track.label = Some(match source_label.as_deref() {
            Some(s) if !s.is_empty() => format!("{s} (audio)"),
            _ => "Audio".to_string(),
        });
        // Insert BEFORE the source in data-model order. V.8's
        // visualOrderedTracks renders tracks in REVERSE data-model
        // order (last index = top of z-stack = top of screen), so
        // inserting at `ti` puts the new audio track at lower
        // z-stack position than the source — which renders the audio
        // row directly BELOW its source video in the timeline UI. The
        // source track's data-model index shifts up by 1.
        let new_track_id = new_track.id;
        // Remove the audio layer from the source track.
        let audio_layer = next.tracks[ti].layers.remove(li);
        new_track.layers.push_back(audio_layer);
        next.tracks.insert(ti, new_track);

        self.commit(
            next,
            actor,
            format!("Separated audio layer {layer_id} onto a new track"),
            vec![EntityRef::Layer(layer_id), EntityRef::Track(new_track_id)],
            DiffHint::Coarse,
        )?;
        Ok(new_track_id)
    }

    fn do_delete_track(
        &mut self,
        id: TrackId,
        force: bool,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let track_idx = next
            .tracks
            .iter()
            .position(|t| t.id == id)
            .ok_or(CommandError::TrackNotFound { track: id })?;
        if !next.tracks[track_idx].removable {
            return Err(CommandError::TrackNotRemovable { track: id });
        }
        if !force && !next.tracks[track_idx].layers.is_empty() {
            return Err(CommandError::TrackNotEmpty { track: id });
        }
        next.tracks.remove(track_idx);
        self.commit(
            next,
            actor,
            format!("Deleted track {id}"),
            vec![EntityRef::Track(id)],
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_split_layer(
        &mut self,
        id: LayerId,
        at_t_us: TimeUs,
        escape_group: bool,
        actor: Actor,
    ) -> Result<(LayerId, LayerId), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let (left_id, right_id) = apply_split_layer(&mut next, id, at_t_us, escape_group)?;
        self.commit(
            next,
            actor,
            format!("Split layer {id} at {at_t_us}us"),
            vec![EntityRef::Layer(left_id), EntityRef::Layer(right_id)],
            DiffHint::Coarse,
        )?;
        Ok((left_id, right_id))
    }

    fn do_trim_layer(
        &mut self,
        id: LayerId,
        edge: LayerEdge,
        new_t_us: TimeUs,
        escape_group: bool,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        apply_trim_layer(&mut next, id, edge, new_t_us, escape_group)?;
        self.commit(
            next,
            actor,
            format!("Trimmed layer {id} {edge:?} -> {new_t_us}us"),
            vec![EntityRef::Layer(id)],
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_add_media_item(
        &mut self,
        item: MediaItem,
        actor: Actor,
    ) -> Result<MediaId, CommandError> {
        // Media imports live outside the editing undo/redo stack. We mutate
        // the media pool of the current snapshot (and every other snapshot in
        // history) so the pool is durable across undos and redos through
        // unrelated edits. No new HistoryEntry is recorded.
        let id = item.id;
        let mut next_pool = self.history.current().media_pool.clone();
        next_pool.insert(id, item);

        // Validate against the resulting current state. Older snapshots can't
        // be invalidated by *adding* media (no existing layer reference can
        // break), so we skip re-validating them.
        let mut probe: Project = (*self.history.current()).clone();
        probe.media_pool = next_pool.clone();
        validate(&probe)?;

        self.history.replace_media_pool_everywhere(next_pool);
        let snapshot = self.history.current();
        self.broadcast_unrecorded(actor, format!("Imported media {id}"), snapshot);
        Ok(id)
    }

    fn do_update_layer(
        &mut self,
        id: LayerId,
        patch: LayerPatch,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        apply_update_layer(&mut next, id, &patch)?;
        self.commit(
            next,
            actor,
            format!("Updated layer {id}"),
            vec![EntityRef::Layer(id)],
            DiffHint::Layer(id),
        )?;
        Ok(())
    }

    fn do_update_layer_params(
        &mut self,
        id: LayerId,
        patch: LayerParamsPatch,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        apply_update_layer_params(&mut next, id, &patch)?;
        self.commit(
            next,
            actor,
            format!("Updated params on layer {id}"),
            vec![EntityRef::Layer(id)],
            DiffHint::Layer(id),
        )?;
        Ok(())
    }

    fn do_update_layer_param_track(
        &mut self,
        id: LayerId,
        param_key: String,
        track: Animated<f64>,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        apply_update_layer_param_track(&mut next, id, &param_key, track)?;
        self.commit(
            next,
            actor,
            format!("Keyframed layer {id} param {param_key}"),
            vec![EntityRef::Layer(id)],
            DiffHint::Layer(id),
        )?;
        Ok(())
    }

    fn do_update_layer_param_tracks(
        &mut self,
        id: LayerId,
        entries: Vec<(String, Animated<f64>)>,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        for (param_key, track) in &entries {
            apply_update_layer_param_track(&mut next, id, param_key, track.clone())?;
        }
        self.commit(
            next,
            actor,
            format!("Keyframed layer {id} ({} params)", entries.len()),
            vec![EntityRef::Layer(id)],
            DiffHint::Layer(id),
        )?;
        Ok(())
    }

    fn do_move_layer(
        &mut self,
        id: LayerId,
        new_track_id: TrackId,
        new_t_start_us: TimeUs,
        escape_group: bool,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        apply_move_layer(&mut next, id, new_track_id, new_t_start_us, escape_group)?;
        self.commit(
            next,
            actor,
            format!("Moved layer {id}"),
            vec![EntityRef::Layer(id), EntityRef::Track(new_track_id)],
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_duplicate_layer(
        &mut self,
        id: LayerId,
        t_offset_us: TimeUs,
        actor: Actor,
    ) -> Result<LayerId, CommandError> {
        let mut next: Project = (*self.history.current()).clone();

        // Locate the source. We need the track index too so we can insert after.
        let mut location: Option<(usize, usize)> = None;
        for (ti, track) in next.tracks.iter().enumerate() {
            if let Some(li) = track.layers.iter().position(|l| l.id == id) {
                location = Some((ti, li));
                break;
            }
        }
        let (ti, li) = location.ok_or(CommandError::LayerNotFound { layer: id })?;

        let mut copy = next.tracks[ti].layers[li].clone();
        let dup_id = new_id();
        copy.id = dup_id;
        copy.t_start_us += t_offset_us;
        copy.t_end_us += t_offset_us;

        let track = next.tracks.get_mut(ti).expect("track index verified");
        let insert_at = track
            .layers
            .iter()
            .position(|l| l.t_start_us > copy.t_start_us)
            .unwrap_or(track.layers.len());
        track.layers.insert(insert_at, copy);

        apply_duration_autofit(&mut next);

        self.commit(
            next,
            actor,
            format!("Duplicated layer {id} → {dup_id}"),
            vec![EntityRef::Layer(dup_id)],
            DiffHint::Layer(dup_id),
        )?;
        Ok(dup_id)
    }

    fn do_set_composition(
        &mut self,
        patch: CompositionPatch,
        actor: Actor,
    ) -> Result<(), CommandError> {
        // Composition fields split into two classes:
        //   - canvas setup (width / height / fps / sample_rate / channels /
        //     color_space / background) — not editing; patched into every
        //     snapshot and NOT recorded.
        //   - duration_us — editing-shaped (auto-extended by layer adds);
        //     recorded normally.
        // A mixed patch is split: canvas part applied everywhere first, then
        // the duration delta committed on top.
        let canvas_changes = patch.width.is_some()
            || patch.height.is_some()
            || patch.fps.is_some()
            || patch.sample_rate.is_some()
            || patch.channels.is_some()
            || patch.color_space.is_some()
            || patch.background.is_some();
        let current = self.history.current();
        // Snap the explicit duration against the POST-patch fps (covers
        // the same-patch fps+duration case where the new duration is
        // sized to the new grid). The auto-extend after layer adds
        // already inherits snap from t_end_us (Task 4), but this path
        // takes a raw TimeUs and needs the explicit guard.
        let post_fps = patch.fps.unwrap_or(current.composition.fps);
        let duration_change = patch
            .duration_us
            .map(|d| crate::state::time::snap_frame_round(d, post_fps));

        // Atomicity: validate the full post-state (canvas + duration combined)
        // before mutating anything. Without this, an invalid mixed patch could
        // apply the canvas part to every snapshot and then fail on the
        // duration `commit`, leaving the caller with a partial change that
        // looks like a rollback to them.
        let mut new_canvas = current.composition.clone();
        if let Some(width) = patch.width {
            new_canvas.width = width;
        }
        if let Some(height) = patch.height {
            new_canvas.height = height;
        }
        if let Some(fps) = patch.fps {
            new_canvas.fps = fps;
        }
        if let Some(sr) = patch.sample_rate {
            new_canvas.sample_rate = sr;
        }
        if let Some(ch) = patch.channels {
            new_canvas.channels = ch;
        }
        if let Some(cs) = patch.color_space {
            new_canvas.color_space = cs;
        }
        if let Some(bg) = patch.background {
            new_canvas.background = bg;
        }
        let mut probe: Project = (*current).clone();
        probe.composition = new_canvas.clone();
        probe.composition.duration_us =
            duration_change.unwrap_or(current.composition.duration_us);
        // ADR 0005: any explicit duration write pins the composition.
        // The pin survives until `fit_composition_to_layers` clears it.
        if duration_change.is_some() {
            probe.composition.duration_pinned = true;
        }

        // If fps changed, re-snap every layer's t_start_us/t_end_us
        // against the new grid in the same atomic patch. Pre-patch
        // t_* values were snapped to the OLD fps; worst-case shift
        // per layer is half a NEW frame — invisible visually,
        // inaudible. composition.duration_us also re-snaps so the
        // autofit reconciliation below is on the new grid.
        let fps_changed =
            patch.fps.is_some_and(|f| f != current.composition.fps);
        if fps_changed {
            let new_fps = probe.composition.fps;
            for track in probe.tracks.iter_mut() {
                for layer in track.layers.iter_mut() {
                    layer.t_start_us =
                        crate::state::time::snap_frame_round(layer.t_start_us, new_fps);
                    layer.t_end_us =
                        crate::state::time::snap_frame_round(layer.t_end_us, new_fps);
                    // Motif src_in_us lives on the COMPOSITION grid (a window
                    // offset into comp-frame content), unlike VideoClip/Audio
                    // src_in_us which are on the source-PTS grid (intentionally
                    // left untouched). Re-snap it to the new comp grid too.
                    if let LayerParams::Motif(p) = &mut layer.params {
                        p.src_in_us =
                            crate::state::time::snap_frame_round(p.src_in_us, new_fps);
                    }
                }
            }
            probe.composition.duration_us =
                crate::state::time::snap_frame_round(probe.composition.duration_us, new_fps);
        }

        // Reconcile the duration against the layer high-water mark:
        // unpinned probes follow `max_end`; pinned ones only grow when
        // `max_end` overflows the user-set value (overflow guard).
        apply_duration_autofit(&mut probe);

        validate(&probe)?;

        if fps_changed {
            // Layer geometry actually changed — commit as a recorded
            // editing change rather than the unrecorded
            // replace_composition_canvas_everywhere path. The commit
            // also persists the canvas patch + any duration change in
            // one transaction.
            self.commit(
                probe,
                actor,
                "Updated composition fps + re-snapped layers".to_string(),
                Vec::new(),
                DiffHint::Composition,
            )?;
        } else {
            if canvas_changes {
                self.history.replace_composition_canvas_everywhere(&new_canvas);
                let snapshot = self.history.current();
                self.broadcast_unrecorded(
                    actor.clone(),
                    "Updated composition canvas".to_string(),
                    snapshot,
                );
            }

            if let Some(duration) = duration_change {
                let mut next: Project = (*self.history.current()).clone();
                next.composition.duration_us = duration;
                next.composition.duration_pinned = true;
                // Overflow guard: a pinned value below `max(t_end_us)`
                // would break the `duration_us >= max(t_end_us)` invariant;
                // autofit bumps it up while keeping the pin set.
                apply_duration_autofit(&mut next);
                self.commit(
                    next,
                    actor,
                    "Updated composition duration".to_string(),
                    Vec::new(),
                    DiffHint::Composition,
                )?;
            }
        }

        Ok(())
    }

    /// Clear `composition.duration_pinned` and re-fit `duration_us` to
    /// the layer high-water mark. Inverse of an explicit
    /// `set_composition { duration_us }`. Always records an entry: the
    /// pin flag and (often) the duration value both change, and undo
    /// should be able to walk back through the operation. See ADR 0005.
    fn do_fit_composition_to_layers(
        &mut self,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        next.composition.duration_pinned = false;
        apply_duration_autofit(&mut next);
        self.commit(
            next,
            actor,
            "Fit composition duration to layers".to_string(),
            Vec::new(),
            DiffHint::Composition,
        )?;
        Ok(())
    }

    fn do_add_marker(
        &mut self,
        t_us: TimeUs,
        end_t_us: Option<TimeUs>,
        label: String,
        color: Rgba,
        actor: Actor,
    ) -> Result<MarkerId, CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let id = new_id();
        let marker = Marker {
            id,
            t_us,
            end_t_us,
            label,
            color,
            metadata: imbl::HashMap::new(),
        };
        // Insert in `t_us` order so the marker list is sorted.
        let insert_at = next
            .markers
            .iter()
            .position(|m| m.t_us > t_us)
            .unwrap_or(next.markers.len());
        next.markers.insert(insert_at, marker);

        self.commit(
            next,
            actor,
            format!("Added marker {id}"),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(id)
    }

    fn do_update_marker(
        &mut self,
        id: MarkerId,
        patch: MarkerPatch,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let idx = next
            .markers
            .iter()
            .position(|m| m.id == id)
            .ok_or(CommandError::MarkerNotFound { marker: id })?;
        let needs_resort = patch.t_us.is_some();
        {
            let m = next.markers.get_mut(idx).expect("index just verified");
            if let Some(t) = patch.t_us {
                m.t_us = t;
            }
            if let Some(end) = patch.end_t_us {
                m.end_t_us = Some(end);
            }
            if let Some(label) = patch.label.clone() {
                m.label = label;
            }
            if let Some(c) = patch.color {
                m.color = c;
            }
        }
        if needs_resort {
            // Re-sort after a t_us change so the data-model invariant (markers
            // sorted by t_us) holds.
            let mut v: Vec<Marker> = next.markers.iter().cloned().collect();
            v.sort_by_key(|m| m.t_us);
            next.markers = imbl::Vector::from(v);
        }
        self.commit(
            next,
            actor,
            format!("Updated marker {id}"),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_remove_marker(&mut self, id: MarkerId, actor: Actor) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let idx = next
            .markers
            .iter()
            .position(|m| m.id == id)
            .ok_or(CommandError::MarkerNotFound { marker: id })?;
        next.markers.remove(idx);
        self.commit(
            next,
            actor,
            format!("Removed marker {id}"),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_add_transition(
        &mut self,
        from_layer: LayerId,
        to_layer: LayerId,
        duration_us: TimeUs,
        kind: TransitionKind,
        actor: Actor,
    ) -> Result<TransitionId, CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        // Find both layers and their track. They must live on the same track —
        // validate will catch the cross-track case, but rejecting it early
        // produces a more specific error.
        let (track_idx, from_idx) = next
            .tracks
            .iter()
            .enumerate()
            .find_map(|(ti, t)| {
                t.layers.iter().position(|l| l.id == from_layer).map(|fi| (ti, fi))
            })
            .ok_or(CommandError::LayerNotFound { layer: from_layer })?;
        let to_idx = next.tracks[track_idx]
            .layers
            .iter()
            .position(|l| l.id == to_layer)
            .ok_or(CommandError::LayerNotFound { layer: to_layer })?;

        let from_end = next.tracks[track_idx].layers[from_idx].t_end_us;
        let to_start = next.tracks[track_idx].layers[to_idx].t_start_us;
        let cur_overlap = (from_end - to_start).max(0);

        // Three cases:
        // 1. Layers are exactly adjacent (from.t_end == to.t_start): extend
        //    `from` by `duration_us` so post-state overlap == duration_us.
        // 2. Layers already overlap by exactly `duration_us`: just add the
        //    transition (the caller pre-positioned them).
        // 3. Anything else (gap, wrong overlap): reject — the caller must
        //    move/trim layers explicitly so the intent is unambiguous.
        if cur_overlap == 0 && from_end == to_start {
            extend_layer_t_end(&mut next.tracks[track_idx].layers[from_idx], duration_us);
        } else if cur_overlap == duration_us {
            // No adjustment needed.
        } else {
            return Err(CommandError::TransitionLayersNotAdjacent {
                from: from_layer,
                to: to_layer,
                duration: duration_us,
            });
        }

        let id = new_id();
        next.transitions.push_back(Transition {
            id,
            from_layer,
            to_layer,
            duration_us,
            kind,
        });
        // `commit`'s validate pass enforces the rest: src_out_us within media
        // duration, no double-overlap on either side, etc. Bad inputs roll
        // back via ValidationFailed before history is touched.
        self.commit(
            next,
            actor,
            format!("Added transition {id}"),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(id)
    }

    fn do_remove_transition(
        &mut self,
        id: TransitionId,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let idx = next
            .transitions
            .iter()
            .position(|t| t.id == id)
            .ok_or(CommandError::TransitionNotFound { transition: id })?;
        let tr = next.transitions[idx].clone();
        next.transitions.remove(idx);
        // Mirror the auto-extend in `add_transition`: shrink `from_layer`
        // back by `duration_us`. This puts the timeline back into a
        // validation-passing shape (no unauthorized overlap). If the user
        // manually trimmed `from_layer` between add and remove, this can
        // shrink past their intent — that's an edge case the caller can
        // restore by editing `t_end_us` afterwards.
        if let Some((track_idx, layer_idx)) =
            next.tracks.iter().enumerate().find_map(|(ti, t)| {
                t.layers.iter().position(|l| l.id == tr.from_layer).map(|li| (ti, li))
            })
        {
            let layer = &mut next.tracks[track_idx].layers[layer_idx];
            shrink_layer_t_end(layer, tr.duration_us);
        }
        self.commit(
            next,
            actor,
            format!("Removed transition {id}"),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_groups_create(
        &mut self,
        layer_ids: Vec<LayerId>,
        label: Option<String>,
        reassign: bool,
        actor: Actor,
    ) -> Result<GroupId, CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let group_id = apply_groups_create(&mut next, layer_ids, label, reassign)?;
        self.commit(
            next,
            actor,
            format!("Created group {group_id}"),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(group_id)
    }

    fn do_groups_dissolve(&mut self, id: GroupId, actor: Actor) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        apply_groups_dissolve(&mut next, id)?;
        self.commit(
            next,
            actor,
            format!("Dissolved group {id}"),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_groups_add_members(
        &mut self,
        id: GroupId,
        layer_ids: Vec<LayerId>,
        reassign: bool,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        apply_groups_add_members(&mut next, id, layer_ids, reassign)?;
        self.commit(
            next,
            actor,
            format!("Added members to group {id}"),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_groups_remove_members(
        &mut self,
        id: GroupId,
        layer_ids: Vec<LayerId>,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        apply_groups_remove_members(&mut next, id, layer_ids)?;
        self.commit(
            next,
            actor,
            format!("Removed members from group {id}"),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_groups_rename(
        &mut self,
        id: GroupId,
        label: Option<String>,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        apply_groups_rename(&mut next, id, label)?;
        self.commit(
            next,
            actor,
            format!("Renamed group {id}"),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_move_track(
        &mut self,
        id: TrackId,
        new_position: usize,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let cur_idx = next
            .tracks
            .iter()
            .position(|t| t.id == id)
            .ok_or(CommandError::TrackNotFound { track: id })?;
        if new_position >= next.tracks.len() {
            return Err(CommandError::TrackPositionOutOfRange {
                position: new_position,
                len: next.tracks.len(),
            });
        }
        if cur_idx == new_position {
            // No-op; skip the commit so we don't pollute history.
            return Ok(());
        }
        let track = next.tracks.remove(cur_idx);
        next.tracks.insert(new_position, track);
        self.commit(
            next,
            actor,
            format!("Moved track {id} to position {new_position}"),
            vec![EntityRef::Track(id)],
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_remove_media(
        &mut self,
        id: MediaId,
        force: bool,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let current = self.history.current();
        if !current.media_pool.contains_key(&id) {
            return Err(CommandError::MediaNotFound { media: id });
        }

        // Find every layer that references this media id.
        let referencing: Vec<LayerId> = current
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .filter(|l| match &l.params {
                LayerParams::VideoClip(p) => p.media == id,
                LayerParams::Audio(p) => p.media == id,
                LayerParams::ImageOverlay(p) => p.media == id,
                LayerParams::Subtitles(p) => matches!(
                    &p.source,
                    super::layer::SubtitlesSource::Media(m) if *m == id
                ),
                _ => false,
            })
            .map(|l| l.id)
            .collect();

        if !referencing.is_empty() && !force {
            return Err(CommandError::MediaInUse {
                media: id,
                referenced_by: referencing,
            });
        }

        // No references → pure media-pool deletion, mirror of `add_media_item`.
        // Patch every snapshot's pool so the removal is durable across undos
        // through unrelated edits, and skip recording a history entry: this is
        // library bookkeeping, not a timeline edit.
        if referencing.is_empty() {
            let mut next_pool = current.media_pool.clone();
            next_pool.remove(&id);

            let mut probe: Project = (*current).clone();
            probe.media_pool = next_pool.clone();
            validate(&probe)?;

            self.history.replace_media_pool_everywhere(next_pool);
            let snapshot = self.history.current();
            self.broadcast_unrecorded(actor, format!("Removed media {id}"), snapshot);
            return Ok(());
        }

        // Force cascade: actual layer deletions, real editing event.
        let mut next: Project = (*current).clone();
        for layer_id in &referencing {
            for track in next.tracks.iter_mut() {
                if let Some(idx) = track.layers.iter().position(|l| l.id == *layer_id) {
                    track.layers.remove(idx);
                    break;
                }
            }
        }
        next.media_pool.remove(&id);

        let summary = format!(
            "Removed media {id} and {} referencing layer(s)",
            referencing.len()
        );
        let affected: Vec<EntityRef> =
            referencing.iter().map(|l| EntityRef::Layer(*l)).collect();
        self.commit(next, actor, summary, affected, DiffHint::Coarse)?;
        Ok(())
    }

    fn do_set_media_workspace_paths(
        &mut self,
        id: MediaId,
        path_abs: std::path::PathBuf,
        path_rel: std::path::PathBuf,
        file_hash_blake3: String,
        file_size: u64,
        file_mtime: u64,
        actor: Actor,
    ) -> Result<(), CommandError> {
        // Mirrors `do_set_media_derivatives`: patch every snapshot's
        // media_pool so undo across unrelated edits doesn't flip the path
        // back to the pre-copy original. Broadcast non-recorded so this
        // doesn't grow the undo stack.
        let current = self.history.current();
        let mut next_pool = current.media_pool.clone();
        let item = next_pool
            .get_mut(&id)
            .ok_or(CommandError::MediaNotFound { media: id })?;
        item.path_abs = path_abs;
        item.path_rel = Some(path_rel);
        item.file_hash_blake3 = file_hash_blake3;
        item.file_size = file_size;
        item.file_mtime = file_mtime;
        self.history.replace_media_pool_everywhere(next_pool);
        let snapshot = self.history.current();
        self.broadcast_unrecorded(
            actor,
            format!("Updated workspace paths for media {id}"),
            snapshot,
        );
        Ok(())
    }

    fn do_set_media_derivatives(
        &mut self,
        id: MediaId,
        patch: MediaDerivativesPatch,
        actor: Actor,
    ) -> Result<(), CommandError> {
        // Mirrors `do_add_media_item`: derivatives sit outside the editing
        // undo stack. We patch every snapshot's `media_pool` so cached paths
        // remain consistent across undo cursors of unrelated edits, then
        // broadcast a non-recorded ChangeEvent so subscribers re-fetch.
        let current = self.history.current();
        let mut next_pool = current.media_pool.clone();
        let item = next_pool
            .get_mut(&id)
            .ok_or(CommandError::MediaNotFound { media: id })?;
        if let Some(p) = patch.proxy_path {
            // `Some(Some(path))` sets a freshly generated proxy.
            // `Some(None)` clears it (workspace-open invalidation).
            item.proxy_path = p;
        }
        if let Some(v) = patch.proxy_format_version {
            item.proxy_format_version = v;
        }
        if let Some(p) = patch.quick_proxy_path {
            item.quick_proxy_path = p;
        }
        if let Some(bypassed) = patch.proxy_bypassed {
            item.proxy_bypassed = bypassed;
        }
        if let Some(v) = patch.export_uses_original {
            item.export_uses_original = v;
        }
        if let Some(p) = patch.waveform_path {
            item.waveform_path = Some(p);
        }
        if let Some(p) = patch.conform_path {
            item.conform_path = Some(p);
        }
        if let Some(p) = patch.thumbnails_dir {
            item.thumbnails_dir = Some(p);
        }
        self.history.replace_media_pool_everywhere(next_pool);
        let snapshot = self.history.current();
        self.broadcast_unrecorded(actor, format!("Updated derivatives for media {id}"), snapshot);
        Ok(())
    }

    fn do_replace_state(&mut self, next: Project, actor: Actor) -> Result<(), CommandError> {
        // A state swap is wholesale — typically loading a different project, or
        // creating a new one. The prior project's snapshots and checkpoints
        // reference a different `project_id` and are incoherent against the
        // new state, so history is reset to a fresh single-entry stack rather
        // than recording a "Replaced project state" entry that Ctrl-Z could
        // flop back through.
        //
        // `modified_at` is NOT touched here: opening an on-disk project
        // shouldn't mark it dirty in memory. Callers that are authoring fresh
        // state (e.g. "+ New project") set `modified_at` themselves via
        // `Project::new_blank`.
        validate(&next)?;
        let snapshot = Arc::new(next);
        self.history.reset(snapshot.clone(), actor.clone());
        self.broadcast_unrecorded(actor, "Replaced project state".to_string(), snapshot);
        Ok(())
    }

    fn do_delete_layer(&mut self, id: LayerId, actor: Actor) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let pruned_track = apply_delete_layer(&mut next, id)?;
        let mut affected = vec![EntityRef::Layer(id)];
        let summary = match pruned_track {
            // The emptied track went with the layer — one entry, so one
            // undo restores both (`settings.auto_delete_empty_tracks`).
            Some(track_id) => {
                affected.push(EntityRef::Track(track_id));
                format!("Deleted layer {id} and its emptied track {track_id}")
            }
            None => format!("Deleted layer {id}"),
        };
        self.commit(next, actor, summary, affected, DiffHint::Coarse)?;
        Ok(())
    }

    /// `Project.settings` patch — see the `update_project_settings` wrapper
    /// for why this bypasses the recorded stack (preference, not edit).
    fn do_update_project_settings(
        &mut self,
        patch: ProjectSettingsPatch,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next = self.history.current().settings.clone();
        if let Some(v) = patch.auto_delete_empty_tracks {
            next.auto_delete_empty_tracks = v;
        }
        self.history.replace_settings_everywhere(&next);
        let snapshot = self.history.current();
        self.broadcast_unrecorded(actor, "Updated project settings".to_string(), snapshot);
        Ok(())
    }

    /// Track flag toggles (enabled/muted/solo/locked) — see the
    /// `update_track_flags` wrapper for why this bypasses the recorded
    /// stack (preference, not edit).
    fn do_update_track_flags(
        &mut self,
        id: TrackId,
        patch: TrackFlagsPatch,
        actor: Actor,
    ) -> Result<(), CommandError> {
        if !self.history.current().tracks.iter().any(|t| t.id == id) {
            return Err(CommandError::TrackNotFound { track: id });
        }
        self.history.replace_track_flags_everywhere(id, &patch);
        let snapshot = self.history.current();
        self.broadcast_unrecorded(actor, format!("Updated track flags {id}"), snapshot);
        Ok(())
    }

    /// Set a role's mix-bus gain — a RECORDED edit (mirrors
    /// `do_update_layer_params`): it goes through `commit`, so Ctrl-Z
    /// reverts it. The mutation is project-wide (the role table, not a
    /// single layer), so it carries no `affected` entities and a coarse
    /// `DiffHint`.
    fn do_set_role_gain(
        &mut self,
        role: AudioRole,
        gain_db: f64,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let mut s = next.role_mix(role);
        s.gain_db = gain_db;
        next.audio_roles.insert(role, s);
        self.commit(
            next,
            actor,
            format!("Set {} role gain to {gain_db} dB", role.as_str()),
            vec![],
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    /// Toggle a role's mute/solo — UNRECORDED (mirrors
    /// `do_update_track_flags`): the patch is applied to every history
    /// snapshot via `replace_role_flags_everywhere` and NOT recorded, so
    /// Ctrl-Z never flips a mixer M/S toggle.
    fn do_update_role_flags(
        &mut self,
        role: AudioRole,
        patch: RoleFlagsPatch,
        actor: Actor,
    ) -> Result<(), CommandError> {
        self.history.replace_role_flags_everywhere(role, &patch);
        let snapshot = self.history.current();
        self.broadcast_unrecorded(actor, format!("Updated {} role flags", role.as_str()), snapshot);
        Ok(())
    }

    /// Retarget a set of Motif layers (by id) to new motif_id/version/props as ONE
    /// undo entry. The caller (install_motif's Update path) precomputes each
    /// affected layer's target id/version + migrated props; the actor just applies
    /// them by id. Layers not found, or found but not Motif-kind, are skipped —
    /// the caller is the source of truth for which layers are affected.
    fn do_rebind_motif(
        &mut self,
        updates: Vec<MotifRebindEntry>,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let affected: Vec<EntityRef> =
            updates.iter().map(|u| EntityRef::Layer(u.layer_id)).collect();
        for entry in &updates {
            for track in next.tracks.iter_mut() {
                for layer in track.layers.iter_mut() {
                    if layer.id == entry.layer_id {
                        if let LayerParams::Motif(p) = &mut layer.params {
                            p.motif_id = entry.motif_id.clone();
                            p.motif_version = entry.motif_version;
                            p.props = entry.props.clone();
                        }
                    }
                }
            }
        }
        self.commit(
            next,
            actor,
            "Rebound motif layers".to_string(),
            affected,
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_undo(&mut self, actor: Actor) -> Result<(), CommandError> {
        if let Some(reason) = self.history.lock_reason() {
            return Err(CommandError::HistoryLocked {
                reason: reason.to_string(),
            });
        }
        let snapshot = self.history.undo().ok_or(CommandError::NothingToUndo)?;
        self.broadcast_unrecorded(actor, "Undo".to_string(), snapshot);
        Ok(())
    }

    fn do_redo(&mut self, actor: Actor) -> Result<(), CommandError> {
        if let Some(reason) = self.history.lock_reason() {
            return Err(CommandError::HistoryLocked {
                reason: reason.to_string(),
            });
        }
        let snapshot = self.history.redo().ok_or(CommandError::NothingToRedo)?;
        self.broadcast_unrecorded(actor, "Redo".to_string(), snapshot);
        Ok(())
    }

    fn do_restore_checkpoint(
        &mut self,
        id: CheckpointId,
        actor: Actor,
    ) -> Result<(), CommandError> {
        if let Some(reason) = self.history.lock_reason() {
            return Err(CommandError::HistoryLocked {
                reason: reason.to_string(),
            });
        }
        let snapshot = self
            .history
            .restore_checkpoint(id)
            .ok_or(CommandError::CheckpointNotFound { checkpoint: id })?;
        // restore_checkpoint already records a new HistoryEntry; just broadcast.
        let event = ChangeEvent {
            op_id: new_id(),
            actor,
            timestamp: Utc::now(),
            summary: format!("Restored checkpoint {id}"),
            affected: Vec::new(),
            new_snapshot: snapshot,
            diff_hint: DiffHint::Coarse,
        };
        let _ = self.events.send(event);
        Ok(())
    }

    fn commit(
        &mut self,
        next: Project,
        actor: Actor,
        summary: String,
        affected: Vec<EntityRef>,
        diff_hint: DiffHint,
    ) -> Result<(), ValidationError> {
        validate(&next)?;
        let snapshot = Arc::new(next);
        let op_id = new_id();
        let timestamp = Utc::now();
        self.history.record(HistoryEntry {
            op_id,
            actor: actor.clone(),
            timestamp,
            summary: summary.clone(),
            affected: affected.clone(),
            snapshot: snapshot.clone(),
        });
        let _ = self.events.send(ChangeEvent {
            op_id,
            actor,
            timestamp,
            summary,
            affected,
            new_snapshot: snapshot,
            diff_hint,
        });
        Ok(())
    }

    /// Broadcast a state change that's already recorded in history (e.g. undo/redo
    /// where we're moving the cursor without creating a new entry).
    fn broadcast_unrecorded(&self, actor: Actor, summary: String, snapshot: Arc<Project>) {
        let _ = self.events.send(ChangeEvent {
            op_id: new_id(),
            actor,
            timestamp: Utc::now(),
            summary,
            affected: Vec::new(),
            new_snapshot: snapshot,
            diff_hint: DiffHint::Coarse,
        });
    }
}

// Pure mutation helpers (apply_*, trim/split geometry, param patching) and the
// unit-test suite live in submodules to keep this file navigable.
mod mutations;
pub(crate) use mutations::*;

#[cfg(test)]
mod tests;
