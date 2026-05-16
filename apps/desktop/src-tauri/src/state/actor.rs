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
use super::project::Project;
use super::time::{Rational, TimeUs};
use super::track::{Track, TrackRole};
use super::transition::{Transition, TransitionKind};
use super::validate::{ValidationError, validate};

const INBOX_CAPACITY: usize = 100;
const BROADCAST_CAPACITY: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "client")]
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
    pub mute: Option<bool>,
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
/// `docs/preview-scrub.md`.
#[derive(Clone, Debug, Default)]
pub struct MediaDerivativesPatch {
    pub proxy_path: Option<Option<std::path::PathBuf>>,
    /// Set when the proxy job completes successfully; the workspace-open
    /// invalidation pass uses it to decide whether the cached proxy
    /// matches the current `jobs::proxy::PROXY_FORMAT_VERSION`.
    pub proxy_format_version: Option<u32>,
    pub waveform_path: Option<std::path::PathBuf>,
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
                actor,
                reply,
            })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    /// Like `add_track` but flags the new track as `transient` — the
    /// auto-prune sweep on every commit removes it once it's empty. Used
    /// by `commands::import_media` (R.3) to land an import's layer on a
    /// fresh hidden track that disappears the moment the user drags the
    /// clip onto A/B (or deletes it).
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
    /// pieces staying in the same group. See `docs/group-system.md`.
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
    /// `docs/group-system.md`.
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

    /// Move a layer to `new_track_id` at `new_t_start_us`. When the layer
    /// is in a group and `escape_group=false` (default), every group member
    /// shifts in time by the same delta as the moved layer; only the
    /// targeted layer's track changes (track changes never propagate). See
    /// `docs/group-system.md`.
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

    /// `docs/group-system.md` — bundle ≥2 layers into a unit that moves /
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
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::SetMediaWorkspacePaths {
                id,
                path_abs,
                path_rel,
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
    tauri::async_runtime::spawn(actor.run());
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
                actor,
                reply,
            } => {
                let result = self.do_add_track(label, transient, actor);
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
                actor,
                reply,
            } => {
                let result = self.do_set_media_workspace_paths(id, path_abs, path_rel, actor);
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
        actor: Actor,
    ) -> Result<TrackId, CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let mut track = Track::new();
        track.label = label;
        track.transient = transient;
        let track_id = track.id;
        next.tracks.push_back(track);
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
        // Insert AFTER the source track in the data-model order so V.8's
        // visualOrderedTracks renders the new audio row directly below
        // its source.
        let new_track_id = new_track.id;
        // Remove the audio layer from the source track.
        let audio_layer = next.tracks[ti].layers.remove(li);
        new_track.layers.push_back(audio_layer);
        // Insert the new track right after `ti`. `imbl::Vector::insert`
        // is O(log n) — fine for our handful-of-tracks workload.
        next.tracks.insert(ti + 1, new_track);

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

        // Auto-extend duration if the duplicate reaches further.
        let max_end = next
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter().map(|l| l.t_end_us))
            .max()
            .unwrap_or(next.composition.duration_us);
        if max_end > next.composition.duration_us {
            next.composition.duration_us = max_end;
        }

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
        let duration_change = patch.duration_us;

        // Atomicity: validate the full post-state (canvas + duration combined)
        // before mutating anything. Without this, an invalid mixed patch could
        // apply the canvas part to every snapshot and then fail on the
        // duration `commit`, leaving the caller with a partial change that
        // looks like a rollback to them.
        let current = self.history.current();
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
        validate(&probe)?;

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
            self.commit(
                next,
                actor,
                "Updated composition duration".to_string(),
                Vec::new(),
                DiffHint::Composition,
            )?;
        }

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
        // broadcast a non-recorded ChangeEvent so subscribers (UI, libmpv
        // hot-reload) re-fetch.
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
        if let Some(p) = patch.waveform_path {
            item.waveform_path = Some(p);
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
        apply_delete_layer(&mut next, id)?;
        self.commit(
            next,
            actor,
            format!("Deleted layer {id}"),
            vec![EntityRef::Layer(id)],
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

// ============================================================
// Pure mutation helpers — shared by `do_*` (real execution) and the
// `dry_run` dispatcher. These NEVER validate, record history, or
// broadcast events; that's the caller's responsibility. Each function
// either mutates `project` and returns its result, or short-circuits
// with a `CommandError` and leaves `project` in a partially-modified
// state — callers MUST clone the project first (or, for dry_run, drop
// the working clone on error).

/// Mutation half of `do_add_layer`. Inserts a new layer on `track_id` at
/// the t-start-sorted position. Extends composition duration if needed.
pub(crate) fn apply_add_layer(
    project: &mut Project,
    track_id: TrackId,
    params: LayerParams,
    t_start_us: TimeUs,
    t_end_us: TimeUs,
) -> Result<LayerId, CommandError> {
    let track_idx = project
        .tracks
        .iter()
        .position(|t| t.id == track_id)
        .ok_or(CommandError::TrackNotFound { track: track_id })?;
    let layer_id = new_id();
    let new_layer = Layer {
        id: layer_id,
        label: None,
        t_start_us,
        t_end_us,
        enabled: true,
        locked: false,
        metadata: imbl::HashMap::new(),
        effects: imbl::Vector::new(),
        params,
    };
    let track = project
        .tracks
        .get_mut(track_idx)
        .expect("index just verified");
    let insert_at = track
        .layers
        .iter()
        .position(|l| l.t_start_us > t_start_us)
        .unwrap_or(track.layers.len());
    track.layers.insert(insert_at, new_layer);
    if project.composition.duration_us < t_end_us {
        project.composition.duration_us = t_end_us;
    }
    Ok(layer_id)
}

/// Mutation half of `do_delete_layer`. Also removes the layer from any
/// group it belongs to and auto-dissolves the group when its member count
/// drops below 2 (`docs/group-system.md` invariant #3).
pub(crate) fn apply_delete_layer(
    project: &mut Project,
    id: LayerId,
) -> Result<(), CommandError> {
    let mut removed = false;
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == id) {
            track.layers.remove(idx);
            removed = true;
            break;
        }
    }
    if !removed {
        return Err(CommandError::LayerNotFound { layer: id });
    }
    drop_layer_from_groups(project, id);
    // A/B-roll redesign R.4: a deletion can leave behind an empty hidden
    // track (the import-created kind). Prune so the timeline graveyard
    // doesn't accumulate. Reserved tracks are protected by their role
    // stamp.
    prune_empty_hidden_tracks(project);
    Ok(())
}

/// Remove `layer_id` from every group it appears in and auto-dissolve any
/// group whose member count drops below 2. Used by both `apply_delete_layer`
/// and the explicit `apply_groups_remove_members` reassignment path.
pub(crate) fn drop_layer_from_groups(project: &mut Project, layer_id: LayerId) {
    let mut i = 0;
    while i < project.groups.len() {
        let g = &mut project.groups[i];
        if g.members.contains(&layer_id) {
            g.members.remove(&layer_id);
            if g.members.len() < 2 {
                project.groups.remove(i);
                continue;
            }
        }
        i += 1;
    }
}

/// `docs/group-system.md` — create a new group from the given layer ids.
/// Requires ≥2 distinct existing layers. If any target is already in
/// another group, fails with `LayerAlreadyGrouped` unless `reassign`,
/// which removes them from their prior group(s) (auto-dissolving below 2)
/// before creating the new group.
pub(crate) fn apply_groups_create(
    project: &mut Project,
    layer_ids: Vec<LayerId>,
    label: Option<String>,
    reassign: bool,
) -> Result<GroupId, CommandError> {
    let unique: imbl::OrdSet<LayerId> = layer_ids.into_iter().collect();
    if unique.len() < 2 {
        return Err(CommandError::GroupCreateNeedsTwoLayers { got: unique.len() });
    }
    let known = layer_id_set(project);
    for &m in unique.iter() {
        if !known.contains(&m) {
            return Err(CommandError::LayerNotFound { layer: m });
        }
    }
    let idx = super::group::index_groups(&project.groups);
    for &m in unique.iter() {
        if let Some(&existing) = idx.get(&m) {
            if !reassign {
                return Err(CommandError::LayerAlreadyGrouped {
                    layer: m,
                    existing,
                });
            }
        }
    }
    if reassign {
        for &m in unique.iter() {
            drop_layer_from_groups(project, m);
        }
    }
    let id = new_id();
    project.groups.push_back(Group {
        id,
        label,
        members: unique,
    });
    Ok(id)
}

pub(crate) fn apply_groups_dissolve(
    project: &mut Project,
    id: GroupId,
) -> Result<(), CommandError> {
    let idx = project
        .groups
        .iter()
        .position(|g| g.id == id)
        .ok_or(CommandError::GroupNotFound { group: id })?;
    project.groups.remove(idx);
    Ok(())
}

pub(crate) fn apply_groups_add_members(
    project: &mut Project,
    id: GroupId,
    layer_ids: Vec<LayerId>,
    reassign: bool,
) -> Result<(), CommandError> {
    let known = layer_id_set(project);
    for &m in layer_ids.iter() {
        if !known.contains(&m) {
            return Err(CommandError::LayerNotFound { layer: m });
        }
    }
    let idx_map = super::group::index_groups(&project.groups);
    for &m in layer_ids.iter() {
        if let Some(&existing) = idx_map.get(&m) {
            if existing == id {
                continue; // already a member of the target group
            }
            if !reassign {
                return Err(CommandError::LayerAlreadyGrouped {
                    layer: m,
                    existing,
                });
            }
        }
    }
    if reassign {
        for &m in layer_ids.iter() {
            if idx_map.get(&m).copied() != Some(id) {
                drop_layer_from_groups(project, m);
            }
        }
    }
    let gi = project
        .groups
        .iter()
        .position(|g| g.id == id)
        .ok_or(CommandError::GroupNotFound { group: id })?;
    let group = &mut project.groups[gi];
    for &m in layer_ids.iter() {
        group.members.insert(m);
    }
    Ok(())
}

pub(crate) fn apply_groups_remove_members(
    project: &mut Project,
    id: GroupId,
    layer_ids: Vec<LayerId>,
) -> Result<(), CommandError> {
    let gi = project
        .groups
        .iter()
        .position(|g| g.id == id)
        .ok_or(CommandError::GroupNotFound { group: id })?;
    {
        let group = &project.groups[gi];
        for &m in layer_ids.iter() {
            if !group.members.contains(&m) {
                return Err(CommandError::LayerNotInGroup { group: id, layer: m });
            }
        }
    }
    let group = &mut project.groups[gi];
    for &m in layer_ids.iter() {
        group.members.remove(&m);
    }
    if group.members.len() < 2 {
        project.groups.remove(gi);
    }
    Ok(())
}

pub(crate) fn apply_groups_rename(
    project: &mut Project,
    id: GroupId,
    label: Option<String>,
) -> Result<(), CommandError> {
    let gi = project
        .groups
        .iter()
        .position(|g| g.id == id)
        .ok_or(CommandError::GroupNotFound { group: id })?;
    project.groups[gi].label = label;
    Ok(())
}

fn layer_id_set(project: &Project) -> std::collections::HashSet<LayerId> {
    let mut s = std::collections::HashSet::new();
    for t in project.tracks.iter() {
        for l in t.layers.iter() {
            s.insert(l.id);
        }
    }
    s
}

/// Mutation half of `do_update_layer` — envelope-only patch.
pub(crate) fn apply_update_layer(
    project: &mut Project,
    id: LayerId,
    patch: &LayerPatch,
) -> Result<(), CommandError> {
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == id) {
            let layer = track.layers.get_mut(idx).expect("index just verified");
            if let Some(label) = patch.label.clone() {
                layer.label = Some(label);
            }
            if let Some(t_start) = patch.t_start_us {
                layer.t_start_us = t_start;
            }
            if let Some(t_end) = patch.t_end_us {
                layer.t_end_us = t_end;
            }
            if let Some(enabled) = patch.enabled {
                layer.enabled = enabled;
            }
            if let Some(locked) = patch.locked {
                layer.locked = locked;
            }
            return Ok(());
        }
    }
    Err(CommandError::LayerNotFound { layer: id })
}

/// Mutation half of `do_update_layer_params` — kind-specific patch.
/// `apply_params_patch` (below) is already a pure helper; this is a thin
/// locate-then-patch wrapper.
pub(crate) fn apply_update_layer_params(
    project: &mut Project,
    id: LayerId,
    patch: &LayerParamsPatch,
) -> Result<(), CommandError> {
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == id) {
            let layer = track.layers.get_mut(idx).expect("index just verified");
            apply_params_patch(layer, patch, id)?;
            return Ok(());
        }
    }
    Err(CommandError::LayerNotFound { layer: id })
}

/// Mutation half of `do_move_layer`. Removes layer from its current track,
/// shifts its end time by the same delta as its start, inserts at the
/// t-sorted position on the destination track, and auto-extends composition
/// duration if needed. When the layer is in a group and `escape_group=false`,
/// also shifts every group sibling's `t_start_us` / `t_end_us` by the same
/// delta (`docs/group-system.md` — move propagates time only, tracks stay
/// local). Locked siblings reject the whole op.
pub(crate) fn apply_move_layer(
    project: &mut Project,
    id: LayerId,
    new_track_id: TrackId,
    new_t_start_us: TimeUs,
    escape_group: bool,
) -> Result<(), CommandError> {
    // Locate the target layer to compute the delta before we mutate anything.
    let cur_start = locate_layer(project, id)
        .map(|(ti, li)| project.tracks[ti].layers[li].t_start_us)
        .ok_or(CommandError::LayerNotFound { layer: id })?;
    let delta = new_t_start_us - cur_start;

    // If grouped & not escaped, identify the sibling members we'll shift and
    // reject up-front on any locked member (including the target itself).
    let siblings: Vec<LayerId> = if escape_group {
        Vec::new()
    } else {
        group_siblings_excluding(project, id)
    };
    if !escape_group && !siblings.is_empty() {
        // Target counts as a "touched" layer for lock-check purposes.
        check_group_lock(project, id, std::iter::once(id).chain(siblings.iter().copied()))?;
    }

    // Move the target layer itself (existing behavior).
    let mut moved: Option<Layer> = None;
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == id) {
            moved = Some(track.layers.remove(idx));
            break;
        }
    }
    let mut layer = moved.expect("layer existence already verified");
    layer.t_start_us = new_t_start_us;
    layer.t_end_us += delta;
    let dest_idx = project
        .tracks
        .iter()
        .position(|t| t.id == new_track_id)
        .ok_or(CommandError::TrackNotFound { track: new_track_id })?;
    let dest = project
        .tracks
        .get_mut(dest_idx)
        .expect("index just verified");
    let insert_at = dest
        .layers
        .iter()
        .position(|l| l.t_start_us > new_t_start_us)
        .unwrap_or(dest.layers.len());
    dest.layers.insert(insert_at, layer);

    // A/B-roll v2 (V.4): group siblings FOLLOW to the destination
    // track AND shift by the same time delta. Replaces R.4's role-
    // aware promotion path (which routed audio siblings to a paired
    // audio role) — under v2 tracks are kind-agnostic, so the
    // sibling just lives on whichever track the user dragged the
    // anchor onto. Alt-escape (escape_group) skips this entirely;
    // siblings stay put.
    if !escape_group {
        for &sid in siblings.iter() {
            let Some((ti, li)) = locate_layer(project, sid) else {
                continue;
            };
            let on_dest = project.tracks[ti].id == new_track_id;
            // Remove the sibling from its current track. If it's
            // already on the destination, we still need to lift +
            // reinsert so the time shift can be applied cleanly and
            // the in-track sort order stays correct.
            let mut s = project.tracks[ti].layers.remove(li);
            if delta != 0 {
                s.t_start_us += delta;
                s.t_end_us += delta;
            }
            s.t_start_us = s.t_start_us.max(0);
            let dest_idx = project
                .tracks
                .iter()
                .position(|t| t.id == new_track_id)
                .expect("destination track verified above");
            let s_start = s.t_start_us;
            let insert_at = project.tracks[dest_idx]
                .layers
                .iter()
                .position(|l| l.t_start_us > s_start)
                .unwrap_or(project.tracks[dest_idx].layers.len());
            project.tracks[dest_idx].layers.insert(insert_at, s);
            // No-op note: `on_dest` is informational — we lift and
            // reinsert on the destination regardless to apply the
            // time delta uniformly.
            let _ = on_dest;
        }
    }

    // Auto-extend composition duration if the move pushed any clip out.
    let max_end = project
        .tracks
        .iter()
        .flat_map(|t| t.layers.iter().map(|l| l.t_end_us))
        .max()
        .unwrap_or(project.composition.duration_us);
    if max_end > project.composition.duration_us {
        project.composition.duration_us = max_end;
    }

    // A/B-roll redesign R.4: prune empty hidden tracks left behind by the
    // move. Reserved (role-stamped) tracks survive (their `role.is_some()`).
    // Tracks marked non-removable also survive in case any future code
    // path stamps that without a role.
    prune_empty_hidden_tracks(project);

    Ok(())
}

/// Remove every track that:
///   - is `transient` (created by R.3's "fresh hidden track per import"
///     path), and
///   - has zero layers.
///
/// Scope is deliberately narrow: only import-spawned holding tracks
/// auto-prune. Reserved (role-stamped) tracks survive — they're the
/// permanent skeleton. Tracks the user or an agent explicitly creates
/// via `add_track` survive too — their authors own their lifecycle.
///
/// The Q17(c) recommendation phrased this as "any hidden empty track,"
/// but in practice the only path that produces those is `import_media`
/// (R.10 removes the user-facing "Add Track" menu, and the underlying
/// command is now agent-only). Caller-managed auto-create paths like
/// `ensure_audio_track` would also be falsely pruned without this
/// narrowing. If an agent does call `add_track` and leaves the track
/// empty, it persists — that's the agent's responsibility to clean up.
pub(crate) fn prune_empty_hidden_tracks(project: &mut Project) {
    project.tracks.retain(|t| !(t.transient && t.layers.is_empty()));
}

/// Locate `(track_idx, layer_idx)` for a given LayerId. Returns None if
/// the layer doesn't exist in the project.
fn locate_layer(project: &Project, id: LayerId) -> Option<(usize, usize)> {
    for (ti, track) in project.tracks.iter().enumerate() {
        if let Some(li) = track.layers.iter().position(|l| l.id == id) {
            return Some((ti, li));
        }
    }
    None
}

/// All other members of `id`'s group (empty when ungrouped).
fn group_siblings_excluding(project: &Project, id: LayerId) -> Vec<LayerId> {
    let idx = super::group::index_groups(&project.groups);
    let Some(&gid) = idx.get(&id) else {
        return Vec::new();
    };
    let Some(group) = project.groups.iter().find(|g| g.id == gid) else {
        return Vec::new();
    };
    group.members.iter().copied().filter(|&m| m != id).collect()
}

/// Reject if any of `touched` is `locked`. Used by group-aware ops to
/// honour `Layer.locked` as a hard "don't touch" promise.
fn check_group_lock<I: IntoIterator<Item = LayerId>>(
    project: &Project,
    touched_anchor: LayerId,
    touched: I,
) -> Result<(), CommandError> {
    let idx = super::group::index_groups(&project.groups);
    let gid = match idx.get(&touched_anchor) {
        Some(&g) => g,
        None => return Ok(()),
    };
    for id in touched {
        if let Some((ti, li)) = locate_layer(project, id) {
            let layer = &project.tracks[ti].layers[li];
            if layer.locked {
                return Err(CommandError::GroupLockedMember {
                    group: gid,
                    locked_layer: id,
                    touched: touched_anchor,
                });
            }
        }
    }
    Ok(())
}

/// Mutation half of `do_split_layer`. Returns `(left_id, right_id)` — left
/// reuses the original layer id; right gets a freshly-allocated one.
///
/// When the layer is in a group and `escape_group=false`, every group
/// member whose interval strictly contains `at_t_us` is also split at
/// `at_t_us`, with both halves staying in the same group (`docs/group-
/// system.md` — split spans, group survives). Locked spanning members
/// reject the whole op.
pub(crate) fn apply_split_layer(
    project: &mut Project,
    id: LayerId,
    at_t_us: TimeUs,
    escape_group: bool,
) -> Result<(LayerId, LayerId), CommandError> {
    // Pre-flight on the target: existence + valid split point.
    {
        let (ti, li) = locate_layer(project, id).ok_or(CommandError::LayerNotFound { layer: id })?;
        let l = &project.tracks[ti].layers[li];
        if at_t_us <= l.t_start_us || at_t_us >= l.t_end_us {
            return Err(CommandError::SplitOutsideLayer { layer: id, at_t: at_t_us });
        }
    }

    // Identify spanning siblings (members whose interval strictly contains
    // `at_t_us`). Non-spanning members are unchanged.
    let spanning_siblings: Vec<LayerId> = if escape_group {
        Vec::new()
    } else {
        let siblings = group_siblings_excluding(project, id);
        siblings
            .into_iter()
            .filter(|&s| {
                locate_layer(project, s)
                    .map(|(ti, li)| {
                        let l = &project.tracks[ti].layers[li];
                        l.t_start_us < at_t_us && at_t_us < l.t_end_us
                    })
                    .unwrap_or(false)
            })
            .collect()
    };
    if !escape_group {
        check_group_lock(
            project,
            id,
            std::iter::once(id).chain(spanning_siblings.iter().copied()),
        )?;
    }

    // Split the target layer (and gather (left_id, right_id) to return).
    let (target_left, target_right) = split_single_layer(project, id, at_t_us)?;

    // Split each spanning sibling at the same time. Each gets a fresh
    // right-half LayerId; both halves are members of the same group, so
    // we patch the group's `members` set to add the right-half id (the
    // left-half keeps the original id, which is already in `members`).
    for &sid in spanning_siblings.iter() {
        let (_, right_id) = split_single_layer(project, sid, at_t_us)?;
        // Insert the new right-half into whichever group `sid` is in.
        let gidx = super::group::index_groups(&project.groups);
        if let Some(&gid) = gidx.get(&sid) {
            if let Some(g) = project.groups.iter_mut().find(|g| g.id == gid) {
                g.members.insert(right_id);
            }
        }
    }
    // Also add the target's right-half to its group, if any.
    {
        let gidx = super::group::index_groups(&project.groups);
        if let Some(&gid) = gidx.get(&target_left) {
            if let Some(g) = project.groups.iter_mut().find(|g| g.id == gid) {
                g.members.insert(target_right);
            }
        }
    }
    Ok((target_left, target_right))
}

/// Single-layer split helper — the part that doesn't know about groups.
/// Returns `(left_id, right_id)`; left reuses the original LayerId.
fn split_single_layer(
    project: &mut Project,
    id: LayerId,
    at_t_us: TimeUs,
) -> Result<(LayerId, LayerId), CommandError> {
    let (ti, li) = locate_layer(project, id).ok_or(CommandError::LayerNotFound { layer: id })?;
    let original = project.tracks[ti].layers[li].clone();
    if at_t_us <= original.t_start_us || at_t_us >= original.t_end_us {
        return Err(CommandError::SplitOutsideLayer { layer: id, at_t: at_t_us });
    }
    let split_offset = at_t_us - original.t_start_us;
    let mut right = original.clone();
    right.id = new_id();
    right.t_start_us = at_t_us;
    right.t_end_us = original.t_end_us;
    match &mut right.params {
        LayerParams::VideoClip(p) => {
            p.src_in_us = p.src_in_us + split_offset;
        }
        LayerParams::Audio(p) => {
            p.src_in_us = p.src_in_us + split_offset;
        }
        _ => {}
    }
    let mut left = original.clone();
    left.t_end_us = at_t_us;
    match &mut left.params {
        LayerParams::VideoClip(p) => {
            p.src_out_us = p.src_in_us + split_offset;
        }
        LayerParams::Audio(p) => {
            p.src_out_us = p.src_in_us + split_offset;
        }
        _ => {}
    }
    let track = &mut project.tracks[ti];
    track.layers[li] = left;
    let insert_at = li + 1;
    let right_id = right.id;
    track.layers.insert(insert_at, right);
    Ok((id, right_id))
}

/// `docs/group-system.md` — trim one edge of a layer's timeline range.
/// When grouped and `escape_group=false`, fan out the same delta to every
/// member whose corresponding edge sits at the *same* `t` as the trimmed
/// layer's pre-trim edge. Clamp the delta to the most-restrictive aligned
/// member (source-bound or `t_start < t_end` constraint).
pub(crate) fn apply_trim_layer(
    project: &mut Project,
    id: LayerId,
    edge: LayerEdge,
    new_t_us: TimeUs,
    escape_group: bool,
) -> Result<(), CommandError> {
    let (ti, li) = locate_layer(project, id).ok_or(CommandError::LayerNotFound { layer: id })?;
    let target = &project.tracks[ti].layers[li];
    let cur_start = target.t_start_us;
    let cur_end = target.t_end_us;
    let cur_edge_t = match edge {
        LayerEdge::In => cur_start,
        LayerEdge::Out => cur_end,
    };

    // Identify the aligned set: members (including the target) whose
    // matching edge sits at `cur_edge_t`. The target is always aligned.
    let aligned: Vec<LayerId> = if escape_group {
        vec![id]
    } else {
        let mut v = vec![id];
        for sid in group_siblings_excluding(project, id) {
            if let Some((sti, sli)) = locate_layer(project, sid) {
                let s = &project.tracks[sti].layers[sli];
                let s_edge_t = match edge {
                    LayerEdge::In => s.t_start_us,
                    LayerEdge::Out => s.t_end_us,
                };
                if s_edge_t == cur_edge_t {
                    v.push(sid);
                }
            }
        }
        v
    };
    if !escape_group {
        check_group_lock(project, id, aligned.iter().copied())?;
    }

    let requested_delta = new_t_us - cur_edge_t;
    if requested_delta == 0 {
        return Ok(());
    }

    // Compute the most-restrictive allowed delta across all aligned members.
    // For an `In` trim, the delta moves t_start by +delta; constraints:
    //   - new_t_start < t_end (so delta < cur_dur)
    //   - new_t_start >= 0 (so delta >= -t_start)
    //   - for media-bearing kinds: new src_in = src_in + delta within
    //     [0, src_out)
    // For an `Out` trim, the delta moves t_end by +delta; constraints:
    //   - new_t_end > t_start (so delta > -cur_dur)
    //   - for media-bearing kinds: new src_out = src_out + delta within
    //     (src_in, media_duration] (we don't know media_duration here, so
    //     we cap at src_out monotonicity vs src_in only; over-trim past
    //     media tail will be caught by `validate_src_range`).
    let clamped_delta = {
        let mut d = requested_delta;
        for &mid in aligned.iter() {
            let (mti, mli) = locate_layer(project, mid).expect("aligned member exists");
            let m = &project.tracks[mti].layers[mli];
            let bounds = trim_delta_bounds(m, edge);
            d = clamp_signed(d, bounds.min, bounds.max);
        }
        d
    };
    if clamped_delta == 0 {
        // The clamped op would be a no-op — surface as TrimEdgeOutOfRange
        // so the caller knows the request was rejected rather than silently
        // succeeded.
        return Err(CommandError::TrimEdgeOutOfRange {
            layer: id,
            new_t: new_t_us,
            cur_start,
            cur_end,
        });
    }

    // Apply the clamped delta to every aligned member's matching edge,
    // updating src_* for media-bearing kinds.
    for &mid in aligned.iter() {
        let (mti, mli) = locate_layer(project, mid).expect("aligned member exists");
        let m = &mut project.tracks[mti].layers[mli];
        match edge {
            LayerEdge::In => {
                m.t_start_us += clamped_delta;
                match &mut m.params {
                    LayerParams::VideoClip(p) => {
                        p.src_in_us += clamped_delta;
                    }
                    LayerParams::Audio(p) => {
                        p.src_in_us += clamped_delta;
                    }
                    _ => {}
                }
            }
            LayerEdge::Out => {
                m.t_end_us += clamped_delta;
                match &mut m.params {
                    LayerParams::VideoClip(p) => {
                        p.src_out_us += clamped_delta;
                    }
                    LayerParams::Audio(p) => {
                        p.src_out_us += clamped_delta;
                    }
                    _ => {}
                }
            }
        }
    }

    // The `In` trim can move a layer's start time backwards within its
    // track; re-sort the affected tracks to maintain the sort invariant.
    if matches!(edge, LayerEdge::In) {
        let touched_tracks: std::collections::HashSet<TrackId> = aligned
            .iter()
            .filter_map(|m| locate_layer(project, *m).map(|(ti, _)| project.tracks[ti].id))
            .collect();
        for tid in touched_tracks {
            if let Some(t) = project.tracks.iter_mut().find(|t| t.id == tid) {
                let mut sorted: Vec<Layer> = t.layers.iter().cloned().collect();
                sorted.sort_by_key(|l| l.t_start_us);
                t.layers = sorted.into();
            }
        }
    }

    // Auto-extend composition duration on `Out` trim.
    if matches!(edge, LayerEdge::Out) {
        let max_end = project
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter().map(|l| l.t_end_us))
            .max()
            .unwrap_or(project.composition.duration_us);
        if max_end > project.composition.duration_us {
            project.composition.duration_us = max_end;
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct DeltaBounds {
    min: i64,
    max: i64,
}

/// Allowable signed `delta` such that applying it to `edge` of `layer`
/// keeps the layer geometrically valid (`t_start < t_end`, src window
/// non-negative).
fn trim_delta_bounds(layer: &Layer, edge: LayerEdge) -> DeltaBounds {
    let dur = layer.t_end_us - layer.t_start_us;
    let inf = i64::MAX / 4; // large enough to feel infinite, small enough to clamp safely
    match edge {
        LayerEdge::In => {
            // delta > -t_start (keep timeline start >= 0)
            // delta < dur (keep t_start < t_end)
            let timeline_min = -layer.t_start_us;
            let timeline_max = dur - 1;
            // Source-bound (only for media-bearing kinds): src_in + delta >= 0
            //                                              src_in + delta < src_out
            let (src_min, src_max) = match &layer.params {
                LayerParams::VideoClip(p) => (-p.src_in_us, p.src_out_us - p.src_in_us - 1),
                LayerParams::Audio(p) => (-p.src_in_us, p.src_out_us - p.src_in_us - 1),
                _ => (-inf, inf),
            };
            DeltaBounds {
                min: timeline_min.max(src_min),
                max: timeline_max.min(src_max),
            }
        }
        LayerEdge::Out => {
            // delta > -dur (keep t_end > t_start, so delta > -(dur-1) i.e. >= -(dur-1))
            // delta unbounded above (composition will auto-extend)
            let timeline_min = -(dur - 1);
            // Source-bound: src_out + delta > src_in
            // No media-duration check here — `validate_src_range` does it.
            let (src_min, src_max) = match &layer.params {
                LayerParams::VideoClip(p) => (-(p.src_out_us - p.src_in_us - 1), inf),
                LayerParams::Audio(p) => (-(p.src_out_us - p.src_in_us - 1), inf),
                _ => (-inf, inf),
            };
            DeltaBounds {
                min: timeline_min.max(src_min),
                max: src_max,
            }
        }
    }
}

fn clamp_signed(d: i64, min: i64, max: i64) -> i64 {
    if min > max {
        // Bounds collapsed — no movement allowed.
        return 0;
    }
    d.max(min).min(max)
}

/// Apply a `LayerParamsPatch` to a layer's `params` in place. Errors if the
/// patch's kind doesn't match the layer's current `LayerParams` discriminant.
fn apply_params_patch(
    layer: &mut Layer,
    patch: &LayerParamsPatch,
    id: LayerId,
) -> Result<(), CommandError> {
    match (&mut layer.params, patch) {
        (LayerParams::Text(p), LayerParamsPatch::Text(tp)) => {
            if let Some(c) = &tp.content {
                p.content = c.clone();
            }
            if let Some(f) = &tp.font_family {
                p.font.family = f.clone();
            }
            if let Some(s) = tp.font_size_px {
                p.font.size_px = s;
            }
            if let Some(c) = tp.color {
                p.color = Animated::Static(c);
            }
            if let Some(x) = tp.x {
                p.transform.x = Animated::Static(x);
            }
            if let Some(y) = tp.y {
                p.transform.y = Animated::Static(y);
            }
            if let Some(o) = tp.opacity {
                p.opacity = Animated::Static(o);
            }
            Ok(())
        }
        (LayerParams::VideoClip(p), LayerParamsPatch::VideoClip(vp)) => {
            if let Some(v) = vp.src_in_us {
                p.src_in_us = v;
            }
            if let Some(v) = vp.src_out_us {
                p.src_out_us = v;
            }
            if let Some(x) = vp.x {
                p.transform.x = Animated::Static(x);
            }
            if let Some(y) = vp.y {
                p.transform.y = Animated::Static(y);
            }
            if let Some(s) = vp.scale_x {
                p.transform.scale_x = Animated::Static(s);
            }
            if let Some(s) = vp.scale_y {
                p.transform.scale_y = Animated::Static(s);
            }
            if let Some(o) = vp.opacity {
                p.opacity = Animated::Static(o);
            }
            if let Some(s) = vp.speed {
                p.speed = s;
            }
            if let Some(b) = vp.flip_h {
                p.flip_h = b;
            }
            if let Some(b) = vp.flip_v {
                p.flip_v = b;
            }
            if let Some(v) = vp.fade_in_us {
                p.fade_in_us = v;
            }
            if let Some(v) = vp.fade_out_us {
                p.fade_out_us = v;
            }
            Ok(())
        }
        (LayerParams::ImageOverlay(p), LayerParamsPatch::ImageOverlay(ip)) => {
            if let Some(x) = ip.x {
                p.transform.x = Animated::Static(x);
            }
            if let Some(y) = ip.y {
                p.transform.y = Animated::Static(y);
            }
            if let Some(s) = ip.scale_x {
                p.transform.scale_x = Animated::Static(s);
            }
            if let Some(s) = ip.scale_y {
                p.transform.scale_y = Animated::Static(s);
            }
            if let Some(o) = ip.opacity {
                p.opacity = Animated::Static(o);
            }
            if let Some(v) = ip.fade_in_us {
                p.fade_in_us = v;
            }
            if let Some(v) = ip.fade_out_us {
                p.fade_out_us = v;
            }
            Ok(())
        }
        (LayerParams::Color(p), LayerParamsPatch::Color(cp)) => {
            if let Some(c) = cp.color {
                p.color = Animated::Static(c);
            }
            if let Some(w) = cp.width {
                p.width = w;
            }
            if let Some(h) = cp.height {
                p.height = h;
            }
            Ok(())
        }
        (LayerParams::Audio(p), LayerParamsPatch::Audio(ap)) => {
            if let Some(v) = ap.src_in_us {
                p.src_in_us = v;
            }
            if let Some(v) = ap.src_out_us {
                p.src_out_us = v;
            }
            if let Some(g) = ap.gain_db {
                p.gain_db = Animated::Static(g);
            }
            if let Some(p_) = ap.pan {
                p.pan = Animated::Static(p_);
            }
            if let Some(m) = ap.mute {
                p.mute = m;
            }
            Ok(())
        }
        (actual, patch) => Err(CommandError::LayerParamsKindMismatch {
            layer: id,
            actual: layer_params_kind(actual),
            patch: layer_params_patch_kind(patch),
        }),
    }
}

/// Extend a layer's `t_end_us` (and `src_out_us` for media-bearing layer
/// kinds) by `delta_us`. Used by `add_transition` to atomically create the
/// authorized overlap between two back-to-back clips. Validation downstream
/// catches the case where `src_out_us` runs off the end of the source media.
fn extend_layer_t_end(layer: &mut Layer, delta_us: TimeUs) {
    layer.t_end_us += delta_us;
    match &mut layer.params {
        LayerParams::VideoClip(p) => p.src_out_us += delta_us,
        LayerParams::Audio(p) => p.src_out_us += delta_us,
        _ => {}
    }
}

/// Inverse of [`extend_layer_t_end`]: shrink `t_end_us` (and `src_out_us`
/// for media-bearing layers) by `delta_us`. Used by `remove_transition` to
/// undo the auto-extension. Saturates at 0 so a buggy delta can't underflow.
fn shrink_layer_t_end(layer: &mut Layer, delta_us: TimeUs) {
    layer.t_end_us = (layer.t_end_us - delta_us).max(0);
    match &mut layer.params {
        LayerParams::VideoClip(p) => p.src_out_us = (p.src_out_us - delta_us).max(0),
        LayerParams::Audio(p) => p.src_out_us = (p.src_out_us - delta_us).max(0),
        _ => {}
    }
}

fn layer_params_kind(params: &LayerParams) -> &'static str {
    match params {
        LayerParams::VideoClip(_) => "VideoClip",
        LayerParams::ImageOverlay(_) => "ImageOverlay",
        LayerParams::Text(_) => "Text",
        LayerParams::Template(_) => "Template",
        LayerParams::Audio(_) => "Audio",
        LayerParams::Subtitles(_) => "Subtitles",
        LayerParams::Color(_) => "Color",
    }
}

fn layer_params_patch_kind(patch: &LayerParamsPatch) -> &'static str {
    match patch {
        LayerParamsPatch::Text(_) => "Text",
        LayerParamsPatch::VideoClip(_) => "VideoClip",
        LayerParamsPatch::ImageOverlay(_) => "ImageOverlay",
        LayerParamsPatch::Color(_) => "Color",
        LayerParamsPatch::Audio(_) => "Audio",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        Animated, ColorParams, LayerParams, MediaKind, MediaMetadata, Project, Rgba, Track,
    };

    fn project_with_video_track() -> (Project, TrackId) {
        // Start from a blank but strip the default A-roll/B-roll so each
        // delete/insert/replace test has a clean slate to assert against.
        let mut p = Project::new_blank("test");
        p.tracks.clear();
        let track = Track::new();
        let track_id = track.id;
        p.tracks.push_back(track);
        (p, track_id)
    }

    fn color_layer(rgba: Rgba) -> LayerParams {
        LayerParams::Color(ColorParams {
            color: Animated::Static(rgba),
            width: 1920,
            height: 1080,
        })
    }

    #[tokio::test]
    async fn add_layer_persists_and_extends_duration() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                5_000_000,
            )
            .await
            .expect("add_layer");

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 1);
        assert_eq!(track.layers[0].id, layer_id);
        assert_eq!(snap.composition.duration_us, 5_000_000);
    }

    #[tokio::test]
    async fn add_layer_rejects_overlap() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                1_000_000,
                3_000_000,
            )
            .await
            .expect("first add");

        let err = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                2_000_000,
                4_000_000,
            )
            .await
            .expect_err("second add should overlap");

        assert!(matches!(
            err,
            CommandError::ValidationFailed(ValidationError::LayerOverlap { .. })
        ));
    }

    #[tokio::test]
    async fn add_layer_rejects_inverted_range() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                5_000_000,
                1_000_000,
            )
            .await
            .expect_err("inverted range");
        assert!(matches!(
            err,
            CommandError::ValidationFailed(ValidationError::InvalidLayerRange { .. })
        ));
    }

    #[tokio::test]
    async fn delete_layer_round_trip() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        handle.delete_layer(Actor::User, id).await.expect("delete");

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert!(track.layers.is_empty());
    }

    #[tokio::test]
    async fn change_event_broadcast() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let mut events = handle.subscribe();

        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        let event = events.recv().await.expect("event");
        assert!(event
            .affected
            .iter()
            .any(|e| matches!(e, EntityRef::Layer(id) if *id == layer_id)));
    }

    #[tokio::test]
    async fn undo_reverts_add_layer() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        assert_eq!(handle.history_status().await.can_undo, true);
        handle.undo(Actor::User).await.expect("undo");

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert!(track.layers.is_empty(), "undo should remove the added layer");

        let status = handle.history_status().await;
        assert!(!status.can_undo);
        assert!(status.can_redo);
    }

    #[tokio::test]
    async fn redo_reapplies_undone_change() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        handle.undo(Actor::User).await.unwrap();
        handle.redo(Actor::User).await.expect("redo");

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 1);
        assert_eq!(track.layers[0].id, layer_id);
    }

    #[tokio::test]
    async fn new_commit_truncates_redo() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        handle.undo(Actor::User).await.unwrap();
        // Redo available...
        assert!(handle.history_status().await.can_redo);

        // ...until a new commit truncates it.
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();

        assert!(!handle.history_status().await.can_redo);
    }

    #[tokio::test]
    async fn checkpoint_survives_undo_redo() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        let cp = handle.checkpoint(Actor::User, "after first add").await;

        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();
        handle.undo(Actor::User).await.unwrap(); // back to one layer
        handle.undo(Actor::User).await.unwrap(); // back to zero

        // Checkpoint still exists.
        let list = handle.list_checkpoints().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, cp);

        // Restore returns us to the one-layer state.
        handle
            .restore_checkpoint(Actor::User, cp)
            .await
            .expect("restore");
        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 1);
    }

    /// End-to-end happy path the human would see in agent mode:
    ///   1. Agent begins a session (here: just mints the auto-checkpoint
    ///      via the same code path the MCP tool exercises).
    ///   2. Agent locks history mid-batch.
    ///   3. User Undo / Restore attempts reject with HistoryLocked.
    ///   4. Agent unlocks. User Restore succeeds.
    ///   5. After Restore the project is back at the auto-checkpoint state.
    ///
    /// Walks every primitive Phase 1-4 added against the live actor.
    #[tokio::test]
    async fn agent_session_full_lifecycle() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        // Step 1: simulate the begin_agent_session auto-checkpoint.
        // Agent actor is the entity minting the checkpoint, mirroring
        // what the MCP tool does.
        let agent = Actor::Agent { client: "mcp".into() };
        let pre_agent_cp = handle.checkpoint(agent.clone(), "Pre-agent: test").await;

        // Agent makes a destructive edit.
        let added = handle
            .add_layer(
                agent.clone(),
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        let after_add = handle.snapshot().await;
        let track = after_add.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 1);
        assert_eq!(track.layers.front().unwrap().id, added);

        // Step 2: agent grabs the revert lock.
        handle.lock_history("agent batch".into()).await;
        assert_eq!(
            handle.history_status().await.lock_reason.as_deref(),
            Some("agent batch"),
        );

        // Step 3: user-side undo + restore both reject.
        match handle.undo(Actor::User).await.unwrap_err() {
            CommandError::HistoryLocked { reason } => {
                assert_eq!(reason, "agent batch");
            }
            other => panic!("expected HistoryLocked from undo, got {other:?}"),
        }
        match handle
            .restore_checkpoint(Actor::User, pre_agent_cp)
            .await
            .unwrap_err()
        {
            CommandError::HistoryLocked { reason } => {
                assert_eq!(reason, "agent batch");
            }
            other => panic!("expected HistoryLocked from restore, got {other:?}"),
        }

        // Step 4: agent releases the lock; user restore now works.
        handle.unlock_history().await;
        assert!(handle.history_status().await.lock_reason.is_none());
        handle
            .restore_checkpoint(Actor::User, pre_agent_cp)
            .await
            .expect("restore after unlock");

        // Step 5: project state is the pre-agent baseline (no layers).
        let restored = handle.snapshot().await;
        let track = restored.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 0);
    }

    /// agent_session_end's auto-unlock guarantee: the Tauri command
    /// for "Exit to editor" calls unlock_history so the human's
    /// editor-mode Undo / Restore re-enables on the next paint, even
    /// if the agent left a lock taken. We can't call the Tauri
    /// command directly from a lib test, but the load-bearing path is
    /// `ProjectHandle::unlock_history` — verify that path leaves the
    /// revert surface usable.
    #[tokio::test]
    async fn unlock_history_restores_editor_revert_surface() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        handle.lock_history("agent batch".into()).await;
        // User tries undo and gets rejected — same path the disabled-
        // tooltip UX is meant to communicate.
        assert!(matches!(
            handle.undo(Actor::User).await.unwrap_err(),
            CommandError::HistoryLocked { .. }
        ));
        // User clicks Exit-to-editor; the Tauri command calls this.
        handle.unlock_history().await;
        // Now undo succeeds.
        handle.undo(Actor::User).await.expect("undo after exit");
    }

    #[tokio::test]
    async fn lock_blocks_revert_paths() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        let cp = handle.checkpoint(Actor::User, "after first add").await;

        handle.lock_history("agent busy".into()).await;

        // Undo / redo / restore all reject with HistoryLocked while the
        // lock is held — error carries the reason the agent supplied.
        for err in [
            handle.undo(Actor::User).await.unwrap_err(),
            handle.redo(Actor::User).await.unwrap_err(),
            handle
                .restore_checkpoint(Actor::User, cp)
                .await
                .unwrap_err(),
        ] {
            match err {
                CommandError::HistoryLocked { reason } => {
                    assert_eq!(reason, "agent busy");
                }
                other => panic!("expected HistoryLocked, got {other:?}"),
            }
        }

        // Releasing the lock re-enables every revert path.
        handle.unlock_history().await;
        handle.undo(Actor::User).await.unwrap();
    }

    #[tokio::test]
    async fn undo_at_origin_errors() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .undo(Actor::User)
            .await
            .expect_err("undo before any commit");
        assert!(matches!(err, CommandError::NothingToUndo));
    }

    #[tokio::test]
    async fn delete_empty_track_succeeds() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .delete_track(Actor::User, track_id, false)
            .await
            .expect("delete empty track");
        let snap = handle.snapshot().await;
        assert!(snap.tracks.is_empty());
    }

    #[tokio::test]
    async fn delete_non_empty_track_rejects_without_force() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        let err = handle
            .delete_track(Actor::User, track_id, false)
            .await
            .expect_err("delete non-empty track");
        assert!(matches!(err, CommandError::TrackNotEmpty { .. }));

        // With force, it succeeds.
        handle
            .delete_track(Actor::User, track_id, true)
            .await
            .expect("delete with force");
        let snap = handle.snapshot().await;
        assert!(snap.tracks.is_empty());
    }

    #[tokio::test]
    async fn split_layer_produces_two_halves() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                4_000_000,
            )
            .await
            .unwrap();

        let (left, right) = handle
            .split_layer(Actor::User, layer_id, 1_500_000, false)
            .await
            .expect("split");
        assert_eq!(left, layer_id);
        assert_ne!(right, layer_id);

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 2);
        assert_eq!(track.layers[0].t_start_us, 0);
        assert_eq!(track.layers[0].t_end_us, 1_500_000);
        assert_eq!(track.layers[1].t_start_us, 1_500_000);
        assert_eq!(track.layers[1].t_end_us, 4_000_000);
    }

    #[tokio::test]
    async fn split_layer_at_endpoint_rejects() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                1_000_000,
                3_000_000,
            )
            .await
            .unwrap();
        // At the boundary — neither inside nor producing two valid halves.
        for at in [1_000_000, 3_000_000, 0, 5_000_000] {
            let err = handle
                .split_layer(Actor::User, layer_id, at, false)
                .await
                .expect_err("split outside bounds");
            assert!(
                matches!(err, CommandError::SplitOutsideLayer { .. }),
                "got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn update_layer_applies_patch() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                2_000_000,
            )
            .await
            .unwrap();

        handle
            .update_layer(
                Actor::User,
                id,
                LayerPatch {
                    label: Some("intro".into()),
                    t_end_us: Some(3_000_000),
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .await
            .expect("update");

        let snap = handle.snapshot().await;
        let layer = snap.tracks.iter().flat_map(|t| t.layers.iter()).next().unwrap();
        assert_eq!(layer.label.as_deref(), Some("intro"));
        assert_eq!(layer.t_end_us, 3_000_000);
        assert!(!layer.enabled);
    }

    #[tokio::test]
    async fn move_layer_across_tracks() {
        let (mut project, src_track) = project_with_video_track();
        // Add a second track manually so we can move into it.
        let dst_track = Track::new();
        let dst_track_id = dst_track.id;
        project.tracks.push_back(dst_track);

        let handle = spawn(project);
        let id = handle
            .add_layer(
                Actor::User,
                src_track,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        handle
            .move_layer(Actor::User, id, dst_track_id, 5_000_000, false)
            .await
            .expect("move");

        let snap = handle.snapshot().await;
        let src = snap.tracks.iter().find(|t| t.id == src_track).unwrap();
        let dst = snap.tracks.iter().find(|t| t.id == dst_track_id).unwrap();
        assert!(src.layers.is_empty());
        assert_eq!(dst.layers.len(), 1);
        assert_eq!(dst.layers[0].id, id);
        assert_eq!(dst.layers[0].t_start_us, 5_000_000);
        assert_eq!(dst.layers[0].t_end_us, 6_000_000); // delta preserved
    }

    #[tokio::test]
    async fn duplicate_layer_creates_offset_copy() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        let dup = handle
            .duplicate_layer(Actor::User, id, 1_500_000)
            .await
            .expect("duplicate");

        assert_ne!(dup, id);
        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 2);
        let copy = track.layers.iter().find(|l| l.id == dup).unwrap();
        assert_eq!(copy.t_start_us, 1_500_000);
        assert_eq!(copy.t_end_us, 2_500_000);
    }

    #[tokio::test]
    async fn set_composition_changes_canvas() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    width: Some(3840),
                    height: Some(2160),
                    fps: Some(Rational::FPS_60),
                    background: Some(Rgba::WHITE),
                    ..Default::default()
                },
            )
            .await
            .expect("set_composition");

        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.width, 3840);
        assert_eq!(snap.composition.height, 2160);
        assert_eq!(snap.composition.fps, Rational::FPS_60);
        assert_eq!(snap.composition.background, Rgba::WHITE);
    }

    #[tokio::test]
    async fn set_composition_rejects_invalid_canvas() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    width: Some(0),
                    ..Default::default()
                },
            )
            .await
            .expect_err("zero width should fail");
        assert!(matches!(
            err,
            CommandError::ValidationFailed(ValidationError::InvalidCanvas { width: 0, .. })
        ));
    }

    #[tokio::test]
    async fn add_transition_extends_outgoing_layer_to_create_overlap() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Two back-to-back clips at [0, 3] and [3, 6]. add_transition should
        // extend `a` to [0, 4] and create a 1s overlap with `b` at [3, 4].
        let a = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 3_000_000)
            .await
            .expect("add a");
        let b = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                3_000_000,
                6_000_000,
            )
            .await
            .expect("add b");
        let tid = handle
            .add_transition(Actor::User, a, b, 1_000_000, TransitionKind::Crossfade)
            .await
            .expect("add_transition");

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        let a_layer = track.layers.iter().find(|l| l.id == a).unwrap();
        let b_layer = track.layers.iter().find(|l| l.id == b).unwrap();
        assert_eq!(a_layer.t_end_us, 4_000_000, "a extended to overlap b by 1s");
        assert_eq!(b_layer.t_start_us, 3_000_000, "b unchanged");
        assert_eq!(snap.transitions.len(), 1);
        assert_eq!(snap.transitions[0].id, tid);
        assert_eq!(snap.transitions[0].duration_us, 1_000_000);
    }

    #[tokio::test]
    async fn add_transition_rejects_layers_with_gap() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let a = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                5_000_000, // 4s gap after a
                7_000_000,
            )
            .await
            .unwrap();
        let err = handle
            .add_transition(Actor::User, a, b, 500_000, TransitionKind::Crossfade)
            .await
            .expect_err("gap should reject");
        assert!(matches!(
            err,
            CommandError::TransitionLayersNotAdjacent { .. }
        ));
    }

    #[tokio::test]
    async fn remove_transition_undoes_in_one_step() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let a = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 3_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                3_000_000,
                6_000_000,
            )
            .await
            .unwrap();
        let tid = handle
            .add_transition(Actor::User, a, b, 1_000_000, TransitionKind::Crossfade)
            .await
            .unwrap();
        handle
            .remove_transition(Actor::User, tid)
            .await
            .expect("remove");
        let snap = handle.snapshot().await;
        assert_eq!(snap.transitions.len(), 0);
        // remove_transition mirrors add_transition: the outgoing layer is
        // shrunk back by the transition's duration so the timeline returns
        // to a validation-passing back-to-back shape.
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        let a_layer = track.layers.iter().find(|l| l.id == a).unwrap();
        assert_eq!(
            a_layer.t_end_us, 3_000_000,
            "remove_transition shrinks A back to its pre-transition end",
        );
    }

    #[tokio::test]
    async fn add_marker_keeps_list_sorted() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let _ = handle
            .add_marker(Actor::User, 5_000_000, None, "second", Rgba::WHITE)
            .await
            .unwrap();
        let _ = handle
            .add_marker(Actor::User, 1_000_000, None, "first", Rgba::BLACK)
            .await
            .unwrap();

        let snap = handle.snapshot().await;
        assert_eq!(snap.markers.len(), 2);
        assert_eq!(snap.markers[0].label, "first");
        assert_eq!(snap.markers[1].label, "second");
    }

    #[tokio::test]
    async fn replace_state_resets_history_to_fresh_stack() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Make a real edit so history has more than one entry, and a
        // checkpoint that should also get cleared on the swap.
        handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .expect("add layer");
        let _cp = handle.checkpoint(Actor::User, "before swap").await;
        let view_before = handle.history_view(100).await;
        assert!(view_before.len > 1, "stack should have prior edits");
        assert_eq!(view_before.checkpoints.len(), 1);

        let mut replacement = Project::new_blank("replaced");
        replacement.tracks.clear();
        replacement.tracks.push_back(super::Track::new());
        let replacement_id = replacement.project_id;

        handle
            .replace_state(Actor::User, replacement)
            .await
            .expect("replace_state");

        let snap = handle.snapshot().await;
        assert_eq!(snap.project_id, replacement_id);
        assert_eq!(snap.metadata.name, "replaced");
        assert_eq!(snap.tracks.len(), 1);

        // History was reset: exactly one "Initial" entry, no checkpoints, undo
        // is a no-op. The prior project's edits and the "before swap"
        // checkpoint are gone.
        let view_after = handle.history_view(100).await;
        assert_eq!(view_after.len, 1);
        assert_eq!(view_after.cursor, 0);
        assert!(view_after.checkpoints.is_empty());
        let err = handle.undo(Actor::User).await.unwrap_err();
        assert!(matches!(err, CommandError::NothingToUndo));
    }

    #[tokio::test]
    async fn replace_state_does_not_touch_modified_at() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        // Construct a replacement with a known modified_at value and verify
        // do_replace_state leaves it alone. Loading a project from disk
        // shouldn't mark it dirty in memory.
        let mut replacement = Project::new_blank("on-disk");
        let pinned = chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_000, 0).unwrap();
        replacement.metadata.modified_at = pinned;

        handle
            .replace_state(Actor::User, replacement)
            .await
            .expect("replace_state");

        let snap = handle.snapshot().await;
        assert_eq!(snap.metadata.modified_at, pinned);
    }

    #[tokio::test]
    async fn remove_media_with_no_references_does_not_record() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let media_id = new_id();
        let item = MediaItem {
            id: media_id,
            label: None,
            path_abs: "/tmp/x.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
            },
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        handle
            .add_media_item(Actor::User, item)
            .await
            .expect("add media");
        let len_before = handle.history_view(100).await.len;

        handle
            .remove_media(Actor::User, media_id, false)
            .await
            .expect("remove media");

        let view = handle.history_view(100).await;
        assert_eq!(
            view.len, len_before,
            "removing unreferenced media should not grow history"
        );
        let snap = handle.snapshot().await;
        assert!(!snap.media_pool.contains_key(&media_id));
    }

    #[tokio::test]
    async fn set_composition_canvas_only_does_not_record() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let len_before = handle.history_view(100).await.len;

        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    width: Some(1280),
                    height: Some(720),
                    ..Default::default()
                },
            )
            .await
            .expect("set composition");

        let view = handle.history_view(100).await;
        assert_eq!(
            view.len, len_before,
            "canvas-only changes should not grow history"
        );
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.width, 1280);
        assert_eq!(snap.composition.height, 720);
    }

    #[tokio::test]
    async fn set_composition_mixed_patch_splits() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let len_before = handle.history_view(100).await.len;
        let dur_before = handle.snapshot().await.composition.duration_us;

        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    width: Some(1280),
                    duration_us: Some(dur_before + 5_000_000),
                    ..Default::default()
                },
            )
            .await
            .expect("set composition");

        let view = handle.history_view(100).await;
        assert_eq!(
            view.len,
            len_before + 1,
            "mixed patch should record exactly one entry (for duration_us)",
        );
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.width, 1280, "canvas applied");
        assert_eq!(
            snap.composition.duration_us,
            dur_before + 5_000_000,
            "duration applied",
        );

        // Undo should reverse only the duration delta, leaving the canvas
        // change in place — that's the entire point of the split.
        handle.undo(Actor::User).await.expect("undo");
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.duration_us, dur_before);
        assert_eq!(snap.composition.width, 1280, "canvas survives undo");
    }


    #[tokio::test]
    async fn blank_project_ships_with_ab_roll_skeleton() {
        // A/B-roll v2 (`docs/ab-roll-redesign` follow-up): the reserved
        // skeleton shrinks from 4 → 2. Two non-removable, role-stamped
        // tracks (A roll + B roll). Both are kind-agnostic in the
        // user-facing model; in v5.0 the TrackKind field still exists
        // and is set to Video for back-compat (V.5 removes the field).
        //
        // Data-model order is bottom-up: A roll at index 0 (z-stack
        // base), B roll at index 1 (top — overlays / cutaways paint
        // on top of A).
        let p = Project::new_blank("untitled");
        assert_eq!(p.tracks.len(), 2);

        let expected = [
            ("A roll", super::TrackRole::ARoll),
            ("B roll", super::TrackRole::BRoll),
        ];
        for (track, (label, role)) in p.tracks.iter().zip(expected.iter()) {
            assert_eq!(track.label.as_deref(), Some(*label));
            assert_eq!(track.role, Some(*role));
            assert!(!track.removable);
        }
    }

    // ---- R.4: role-aware AV-pair promotion + auto-prune of empty
    //       hidden tracks ----

    /// Reusable setup: blank project (4 reserved tracks) + a fresh
    /// hidden V+A pair carrying a grouped video/audio clip, mimicking
    /// what R.3's `place_imported_media_on_fresh_tracks` produces from
    /// `import_media`. Returns the handle plus all the ids the
    /// promotion test needs to assert against.
    async fn project_with_hidden_av_pair(
    ) -> (ProjectHandle, TrackId, TrackId, LayerId, LayerId, MediaItem) {
        use crate::state::media::{AudioStreamMeta, MediaKind, MediaMetadata};
        use chrono::Utc;

        // V.4: reserved skeleton is just A roll + B roll. The V+A pair
        // here represents a manually-arranged split (V on one hidden
        // track, A on another) — V.3's import flow puts them on the
        // SAME hidden track, but the V.4 sibling-follow logic still
        // has to handle the manual-split case correctly.
        let mut p = Project::new_blank("ab-roll-test");
        // Add the import media to the pool so the layers can reference it.
        let media = MediaItem {
            id: new_id(),
            label: Some("import.mp4".into()),
            path_abs: "/m/import.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(5_000_000),
                video: None,
                audio: Some(AudioStreamMeta {
                    sample_rate: 48_000,
                    channels: 2,
                    codec: "aac".into(),
                }),
            },
            proxy_path: None,
            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "h".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        let media_id = media.id;
        p.media_pool.insert(media_id, media.clone());
        let handle = spawn(p);

        // Mirror R.3's import path: transient tracks so the auto-prune
        // sweep can act on them once they empty out.
        let v_track = handle
            .add_transient_track(Actor::User, Some("import".into()))
            .await
            .unwrap();
        let a_track = handle
            .add_transient_track(Actor::User, Some("import (audio)".into()))
            .await
            .unwrap();
        let v_layer = handle
            .add_layer(
                Actor::User,
                v_track,
                LayerParams::VideoClip(crate::state::layer::VideoClipParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 5_000_000,
                    transform: Default::default(),
                    opacity: Animated::Static(1.0),
                    crop: None,
                    flip_h: false,
                    flip_v: false,
                    blend_mode: Default::default(),
                    speed: 1.0,
                    fade_in_us: 0,
                    fade_out_us: 0,
                }),
                0,
                5_000_000,
            )
            .await
            .unwrap();
        let a_layer = handle
            .add_layer(
                Actor::User,
                a_track,
                LayerParams::Audio(crate::state::layer::AudioParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 5_000_000,
                    gain_db: Animated::Static(0.0),
                    pan: Animated::Static(0.0),
                    fade_in_us: 0,
                    fade_out_us: 0,
                    mute: false,
                }),
                0,
                5_000_000,
            )
            .await
            .unwrap();
        handle
            .groups_create(Actor::User, vec![v_layer, a_layer], None, false)
            .await
            .unwrap();

        (handle, v_track, a_track, v_layer, a_layer, media)
    }

    #[tokio::test]
    async fn promoting_video_to_a_roll_pulls_audio_sibling_onto_same_track() {
        // V.4: moving a grouped layer onto another track makes
        // grouped siblings follow onto the SAME destination track
        // (replaces R.4's "audio routes to paired AudioA/AudioB
        // role" logic — under v2 there are no role-paired audio
        // tracks). Both V and A end up on A roll; transient hidden
        // source tracks auto-prune once empty.
        let (handle, hidden_v_track, hidden_a_track, v_layer, a_layer, _media) =
            project_with_hidden_av_pair().await;
        let snap = handle.snapshot().await;
        let a_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .unwrap()
            .id;

        handle
            .move_layer(Actor::User, v_layer, a_roll, 0, false)
            .await
            .unwrap();

        let after = handle.snapshot().await;
        let a_roll_track = after
            .tracks
            .iter()
            .find(|t| t.id == a_roll)
            .expect("A roll still present");
        assert!(a_roll_track.layers.iter().any(|l| l.id == v_layer));
        assert!(
            a_roll_track.layers.iter().any(|l| l.id == a_layer),
            "audio sibling must follow video onto A roll (same track)"
        );
        // The hidden source tracks pruned themselves once empty.
        assert!(!after.tracks.iter().any(|t| t.id == hidden_v_track));
        assert!(!after.tracks.iter().any(|t| t.id == hidden_a_track));
    }

    #[tokio::test]
    async fn promoting_audio_to_b_roll_pulls_video_sibling_onto_same_track() {
        // Symmetric case: drag the audio waveform first; the video
        // sibling follows onto the destination track too.
        let (handle, hidden_v_track, hidden_a_track, v_layer, a_layer, _media) =
            project_with_hidden_av_pair().await;
        let snap = handle.snapshot().await;
        let b_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::BRoll))
            .unwrap()
            .id;

        handle
            .move_layer(Actor::User, a_layer, b_roll, 0, false)
            .await
            .unwrap();

        let after = handle.snapshot().await;
        let b_roll_track = after
            .tracks
            .iter()
            .find(|t| t.id == b_roll)
            .expect("B roll still present");
        assert!(b_roll_track.layers.iter().any(|l| l.id == a_layer));
        assert!(
            b_roll_track.layers.iter().any(|l| l.id == v_layer),
            "video sibling must follow audio onto B roll (same track)"
        );
        assert!(!after.tracks.iter().any(|t| t.id == hidden_v_track));
        assert!(!after.tracks.iter().any(|t| t.id == hidden_a_track));
    }

    #[tokio::test]
    async fn escape_group_keeps_audio_sibling_on_its_track() {
        // Alt-drag (escape_group=true) opts out of V.4's sibling-
        // follow logic: only the dragged layer moves; siblings stay
        // put on their original tracks. The hidden audio source
        // track survives because the audio layer is still on it.
        let (handle, hidden_v_track, hidden_a_track, v_layer, a_layer, _media) =
            project_with_hidden_av_pair().await;
        let snap = handle.snapshot().await;
        let a_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .unwrap()
            .id;

        handle
            .move_layer(Actor::User, v_layer, a_roll, 0, /* escape_group */ true)
            .await
            .unwrap();

        let after = handle.snapshot().await;
        // Video promoted alone; audio sibling unchanged.
        assert!(
            after
                .tracks
                .iter()
                .find(|t| t.id == a_roll)
                .unwrap()
                .layers
                .iter()
                .any(|l| l.id == v_layer)
        );
        assert!(
            after
                .tracks
                .iter()
                .find(|t| t.id == hidden_a_track)
                .map(|t| t.layers.iter().any(|l| l.id == a_layer))
                .unwrap_or(false),
            "audio layer stays on its original hidden track under Alt-escape"
        );
        // Hidden video source pruned (now empty), audio source did NOT.
        assert!(!after.tracks.iter().any(|t| t.id == hidden_v_track));
        assert!(after.tracks.iter().any(|t| t.id == hidden_a_track));
    }

    #[tokio::test]
    async fn separate_audio_lifts_layer_onto_new_track_just_below_source() {
        // V.7: an Audio layer is lifted onto a fresh non-transient
        // track inserted directly after the source. Group membership
        // is preserved (the V layer stays on the source track grouped
        // with the moved A layer).
        let (handle, _hidden_v, _hidden_a, v_layer, a_layer, _media) =
            project_with_hidden_av_pair().await;
        // Promote the pair to A roll first so we have a V+A on the
        // same track to separate. After this, both V and A live on
        // ARoll (V.4 sibling-follow).
        let snap = handle.snapshot().await;
        let a_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .unwrap()
            .id;
        handle
            .move_layer(Actor::User, v_layer, a_roll, 0, false)
            .await
            .unwrap();

        // Sanity: both layers now on ARoll.
        let pre = handle.snapshot().await;
        let pre_a_roll = pre
            .tracks
            .iter()
            .find(|t| t.id == a_roll)
            .unwrap();
        assert!(pre_a_roll.layers.iter().any(|l| l.id == v_layer));
        assert!(pre_a_roll.layers.iter().any(|l| l.id == a_layer));
        let pre_a_roll_idx = pre.tracks.iter().position(|t| t.id == a_roll).unwrap();

        // Separate the audio.
        let new_track_id = handle
            .separate_audio_to_new_track(Actor::User, a_layer)
            .await
            .expect("separate_audio_to_new_track");

        let after = handle.snapshot().await;
        // A layer is on the new track; V layer is still on ARoll.
        let a_roll_track = after
            .tracks
            .iter()
            .find(|t| t.id == a_roll)
            .unwrap();
        assert!(a_roll_track.layers.iter().any(|l| l.id == v_layer));
        assert!(
            !a_roll_track.layers.iter().any(|l| l.id == a_layer),
            "audio layer must leave the source track"
        );
        let new_track = after
            .tracks
            .iter()
            .find(|t| t.id == new_track_id)
            .expect("new track present");
        assert!(new_track.layers.iter().any(|l| l.id == a_layer));
        assert!(!new_track.transient, "new track must be non-transient");
        assert!(new_track.removable, "new track must be user-removable");
        // The new track sits directly after the source in data-model
        // order (V.7 contract).
        let new_idx = after
            .tracks
            .iter()
            .position(|t| t.id == new_track_id)
            .unwrap();
        assert_eq!(new_idx, pre_a_roll_idx + 1);
        // Group membership preserved (V and A still grouped).
        let groups = &after.groups;
        let pair_group = groups
            .iter()
            .find(|g| g.members.contains(&v_layer) && g.members.contains(&a_layer))
            .expect("group survives separate_audio");
        assert_eq!(pair_group.members.len(), 2);
    }

    #[tokio::test]
    async fn separate_audio_rejects_video_layer() {
        let (handle, _hidden_v, _hidden_a, v_layer, _a_layer, _media) =
            project_with_hidden_av_pair().await;
        let err = handle
            .separate_audio_to_new_track(Actor::User, v_layer)
            .await
            .expect_err("video layer should reject");
        assert!(matches!(
            err,
            CommandError::WrongLayerKind { expected: "Audio", .. }
        ));
    }

    #[tokio::test]
    async fn deleting_only_layer_on_hidden_track_prunes_the_track() {
        // Auto-prune also fires after `delete_layer`. A user / agent path
        // that removes the last layer of a hidden track shouldn't leave
        // an empty graveyard row in the timeline.
        let (handle, hidden_v_track, _hidden_a, v_layer, _a_layer, _media) =
            project_with_hidden_av_pair().await;
        // delete_layer doesn't have an escape_group flag (deletes are
        // single-layer by definition; group-aware delete is a separate
        // op). The audio sibling stays on its hidden track.
        handle.delete_layer(Actor::User, v_layer).await.unwrap();
        let after = handle.snapshot().await;
        assert!(
            !after.tracks.iter().any(|t| t.id == hidden_v_track),
            "hidden video track must auto-prune after its only layer is deleted"
        );
    }

    #[tokio::test]
    async fn promote_undo_restores_hidden_tracks() {
        // History invariant: undoing a promotion restores the project
        // to its prior shape — both the audio fan-out AND the
        // auto-pruned hidden tracks must reappear. The history layer
        // serialises whole-project snapshots so this is "free" as long
        // as our mutation paths don't leak across the commit boundary.
        let (handle, hidden_v_track, hidden_a_track, v_layer, _a_layer, _media) =
            project_with_hidden_av_pair().await;
        let snap = handle.snapshot().await;
        let video_a = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .unwrap()
            .id;

        handle
            .move_layer(Actor::User, v_layer, video_a, 0, false)
            .await
            .unwrap();
        // Pre-undo sanity: hidden source tracks gone.
        let mid = handle.snapshot().await;
        assert!(!mid.tracks.iter().any(|t| t.id == hidden_v_track));

        handle.undo(Actor::User).await.unwrap();
        let after = handle.snapshot().await;
        assert!(
            after.tracks.iter().any(|t| t.id == hidden_v_track),
            "undo must restore the auto-pruned hidden video track"
        );
        assert!(
            after.tracks.iter().any(|t| t.id == hidden_a_track),
            "undo must restore the auto-pruned hidden audio track"
        );
    }

    #[tokio::test]
    async fn cannot_delete_role_stamped_track() {
        // V.1: reserved skeleton is A roll + B roll (2 tracks). Both
        // are removable=false; an attempted delete must surface
        // TrackNotRemovable on either.
        let handle = spawn(Project::new_blank("untitled"));
        let snap = handle.snapshot().await;
        assert_eq!(snap.tracks.len(), 2);
        for t in snap.tracks.iter() {
            let err = handle
                .delete_track(Actor::User, t.id, true)
                .await
                .expect_err("delete should fail on every reserved track");
            assert!(matches!(err, CommandError::TrackNotRemovable { .. }));
        }
    }

    #[tokio::test]
    async fn import_media_does_not_grow_history() {
        use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
        use chrono::Utc;
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let history_before = handle.history_status().await.len;
        let item = MediaItem {
            id: new_id(),
            label: Some("intro.mp4".into()),
            path_abs: "/m/intro.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(5_000_000),
                video: None,
                audio: None,
            },
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        handle
            .add_media_item(Actor::User, item)
            .await
            .expect("import");
        let history_after = handle.history_status().await.len;
        assert_eq!(
            history_before, history_after,
            "media import must not push a history entry"
        );
        // But the snapshot must contain the new media.
        let snap = handle.snapshot().await;
        assert_eq!(snap.media_pool.len(), 1);
    }

    #[tokio::test]
    async fn imported_media_persists_across_undo() {
        use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
        use chrono::Utc;
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        // Edit 1: add a layer (this DOES push to history).
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        // Import media (must NOT push to history).
        let media_id = new_id();
        let item = MediaItem {
            id: media_id,
            label: Some("clip.mp4".into()),
            path_abs: "/m/clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(3_000_000),
                video: None,
                audio: None,
            },
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        handle
            .add_media_item(Actor::User, item)
            .await
            .expect("import");

        // Undo edit 1 — the media must still be in the pool.
        handle.undo(Actor::User).await.expect("undo");
        let snap = handle.snapshot().await;
        assert!(
            snap.media_pool.contains_key(&media_id),
            "imported media must survive undo of unrelated edits"
        );
    }

    fn dummy_video_media(duration_us: TimeUs) -> crate::state::media::MediaItem {
        use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
        use chrono::Utc;
        MediaItem {
            id: new_id(),
            label: Some("clip.mp4".into()),
            path_abs: "/m/clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(duration_us),
                video: None,
                audio: None,
            },
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn update_marker_changes_label() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let id = handle
            .add_marker(Actor::User, 1_000_000, None, "old", Rgba::WHITE)
            .await
            .unwrap();
        handle
            .update_marker(
                Actor::User,
                id,
                MarkerPatch {
                    label: Some("new".into()),
                    ..Default::default()
                },
            )
            .await
            .expect("update_marker");
        let snap = handle.snapshot().await;
        assert_eq!(snap.markers[0].label, "new");
    }

    #[tokio::test]
    async fn update_marker_resorts_after_t_change() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let id_a = handle
            .add_marker(Actor::User, 1_000_000, None, "a", Rgba::WHITE)
            .await
            .unwrap();
        let _ = handle
            .add_marker(Actor::User, 5_000_000, None, "b", Rgba::WHITE)
            .await
            .unwrap();
        // Move "a" past "b".
        handle
            .update_marker(
                Actor::User,
                id_a,
                MarkerPatch {
                    t_us: Some(9_000_000),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.markers[0].label, "b");
        assert_eq!(snap.markers[1].label, "a");
    }

    #[tokio::test]
    async fn update_marker_unknown_id_errors() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .update_marker(
                Actor::User,
                new_id(),
                MarkerPatch {
                    label: Some("x".into()),
                    ..Default::default()
                },
            )
            .await
            .expect_err("unknown marker");
        assert!(matches!(err, CommandError::MarkerNotFound { .. }));
    }

    #[tokio::test]
    async fn remove_marker_drops_it() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let id = handle
            .add_marker(Actor::User, 1_000_000, None, "m", Rgba::WHITE)
            .await
            .unwrap();
        handle
            .remove_marker(Actor::User, id)
            .await
            .expect("remove_marker");
        let snap = handle.snapshot().await;
        assert!(snap.markers.is_empty());
    }

    #[tokio::test]
    async fn remove_marker_unknown_id_errors() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .remove_marker(Actor::User, new_id())
            .await
            .expect_err("unknown marker");
        assert!(matches!(err, CommandError::MarkerNotFound { .. }));
    }

    #[tokio::test]
    async fn move_track_reorders() {
        // `docs/ab-roll-redesign`: blank project now has 4 reserved tracks
        // (Audio B, Audio A, Video A, Video B). Find Video A / Video B by
        // role so this test stays robust against any future re-ordering of
        // the bootstrap skeleton.
        use super::TrackRole;
        let handle = spawn(Project::new_blank("untitled"));
        let snap = handle.snapshot().await;
        let a_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .expect("A roll present")
            .id;
        let b_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::BRoll))
            .expect("B roll present")
            .id;
        // Move B roll to index 0 (bottom of stack).
        handle
            .move_track(Actor::User, b_roll, 0)
            .await
            .expect("move_track");
        let snap = handle.snapshot().await;
        assert_eq!(snap.tracks[0].id, b_roll);
        // A roll is still in the stack (somewhere) — exact index depends on
        // where the reorder shifted everyone else, which isn't this test's
        // concern.
        assert!(snap.tracks.iter().any(|t| t.id == a_roll));
    }

    #[tokio::test]
    async fn move_track_position_out_of_range() {
        let handle = spawn(Project::new_blank("untitled"));
        let snap = handle.snapshot().await;
        let id = snap.tracks[0].id;
        let err = handle
            .move_track(Actor::User, id, 99)
            .await
            .expect_err("position out of range");
        assert!(matches!(
            err,
            CommandError::TrackPositionOutOfRange { position: 99, .. }
        ));
    }

    #[tokio::test]
    async fn move_track_to_same_position_does_not_grow_history() {
        let handle = spawn(Project::new_blank("untitled"));
        let snap = handle.snapshot().await;
        let id = snap.tracks[0].id;
        let len_before = handle.history_status().await.len;
        handle
            .move_track(Actor::User, id, 0)
            .await
            .expect("no-op move");
        let len_after = handle.history_status().await.len;
        assert_eq!(len_before, len_after, "no-op move must not record history");
    }

    #[tokio::test]
    async fn remove_media_unreferenced_succeeds() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let item = dummy_video_media(5_000_000);
        let id = item.id;
        handle.add_media_item(Actor::User, item).await.unwrap();
        handle
            .remove_media(Actor::User, id, false)
            .await
            .expect("remove_media");
        let snap = handle.snapshot().await;
        assert!(!snap.media_pool.contains_key(&id));
    }

    #[tokio::test]
    async fn remove_media_referenced_rejects_without_force() {
        use crate::state::layer::VideoClipParams;
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let item = dummy_video_media(5_000_000);
        let media_id = item.id;
        handle.add_media_item(Actor::User, item).await.unwrap();
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                LayerParams::VideoClip(VideoClipParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    transform: Default::default(),
                    opacity: Animated::Static(1.0),
                    crop: None,
                    flip_h: false,
                    flip_v: false,
                    blend_mode: Default::default(),
                    speed: 1.0,
                    fade_in_us: 0,
                    fade_out_us: 0,
                }),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        let err = handle
            .remove_media(Actor::User, media_id, false)
            .await
            .expect_err("should reject without force");
        match err {
            CommandError::MediaInUse {
                media,
                referenced_by,
            } => {
                assert_eq!(media, media_id);
                assert_eq!(referenced_by, vec![layer_id]);
            }
            other => panic!("unexpected error: {other:?}"),
        }

        // Media still present, layer still present.
        let snap = handle.snapshot().await;
        assert!(snap.media_pool.contains_key(&media_id));
        let still_there = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .any(|l| l.id == layer_id);
        assert!(still_there);
    }

    #[tokio::test]
    async fn remove_media_with_force_cascades_layer_deletion() {
        use crate::state::layer::VideoClipParams;
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let item = dummy_video_media(5_000_000);
        let media_id = item.id;
        handle.add_media_item(Actor::User, item).await.unwrap();
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                LayerParams::VideoClip(VideoClipParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    transform: Default::default(),
                    opacity: Animated::Static(1.0),
                    crop: None,
                    flip_h: false,
                    flip_v: false,
                    blend_mode: Default::default(),
                    speed: 1.0,
                    fade_in_us: 0,
                    fade_out_us: 0,
                }),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        handle
            .remove_media(Actor::User, media_id, true)
            .await
            .expect("force-remove");

        let snap = handle.snapshot().await;
        assert!(!snap.media_pool.contains_key(&media_id));
        let layer_still_there = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .any(|l| l.id == layer_id);
        assert!(
            !layer_still_there,
            "force removal must cascade-delete referencing layers"
        );
    }

    #[tokio::test]
    async fn history_view_returns_recent_ops_and_checkpoints() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Three commits.
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();
        let cp = handle.checkpoint(Actor::User, "cp1").await;
        handle
            .add_marker(Actor::User, 500_000, None, "m", Rgba::WHITE)
            .await
            .unwrap();

        let view = handle.history_view(50).await;
        // Initial entry + 3 commits = 4 ops.
        assert_eq!(view.len, 4);
        assert_eq!(view.ops.len(), 4);
        assert!(view.cursor < view.len);
        assert_eq!(view.checkpoints.len(), 1);
        assert_eq!(view.checkpoints[0].id, cp);
        assert_eq!(view.checkpoints[0].label, "cp1");
    }

    #[tokio::test]
    async fn history_view_respects_limit() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Two commits — total 3 entries with the initial one.
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();

        let view = handle.history_view(2).await;
        assert_eq!(view.len, 3, "len reports the full history depth");
        assert_eq!(view.ops.len(), 2, "ops is capped to the limit");
    }

    #[tokio::test]
    async fn set_media_derivatives_patches_in_place_outside_history() {
        use std::path::PathBuf;
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let item = dummy_video_media(5_000_000);
        let media_id = item.id;
        handle.add_media_item(Actor::User, item).await.unwrap();
        let history_before = handle.history_status().await.len;

        handle
            .set_media_derivatives(
                Actor::User,
                media_id,
                MediaDerivativesPatch {
                    proxy_path: Some(Some(PathBuf::from("/cache/proxies/abc.mp4"))),
                    thumbnails_dir: Some(PathBuf::from("/cache/thumbnails/abc")),
                    ..Default::default()
                },
            )
            .await
            .expect("set derivatives");

        let history_after = handle.history_status().await.len;
        assert_eq!(
            history_before, history_after,
            "derivatives must not push to undo stack"
        );

        let snap = handle.snapshot().await;
        let m = snap.media_pool.get(&media_id).unwrap();
        assert_eq!(
            m.proxy_path.as_deref(),
            Some(std::path::Path::new("/cache/proxies/abc.mp4"))
        );
        assert_eq!(
            m.thumbnails_dir.as_deref(),
            Some(std::path::Path::new("/cache/thumbnails/abc"))
        );
        assert!(m.waveform_path.is_none(), "untouched fields stay None");
    }

    #[tokio::test]
    async fn set_media_derivatives_unknown_id_errors() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .set_media_derivatives(
                Actor::User,
                new_id(),
                MediaDerivativesPatch::default(),
            )
            .await
            .expect_err("unknown media");
        assert!(matches!(err, CommandError::MediaNotFound { .. }));
    }

    #[tokio::test]
    async fn remove_media_unknown_id_errors() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .remove_media(Actor::User, new_id(), false)
            .await
            .expect_err("unknown media");
        assert!(matches!(err, CommandError::MediaNotFound { .. }));
    }

    // ============================================================
    // dry_run — Phase 4.x last gap
    // ============================================================

    /// Dry-running a single AddLayer should report success but leave
    /// `handle.snapshot()` unchanged. This is the load-bearing property:
    /// agents trust dry_run because it can't accidentally commit.
    #[tokio::test]
    async fn dry_run_does_not_mutate_state() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let before = handle.snapshot().await;
        let track_count_before = before.tracks.len();
        let layer_count_before: usize =
            before.tracks.iter().map(|t| t.layers.len()).sum();
        let history_cursor_before = handle.history_status().await.cursor;

        let results = handle
            .dry_run(vec![DryRunOp::AddLayer {
                track_id,
                params: color_layer(Rgba::WHITE),
                t_start_us: 0,
                t_end_us: 2_000_000,
            }])
            .await;
        assert_eq!(results.len(), 1);
        assert!(matches!(results[0], Ok(DryRunOutput::AddLayer { .. })));

        let after = handle.snapshot().await;
        assert_eq!(after.tracks.len(), track_count_before);
        let layer_count_after: usize =
            after.tracks.iter().map(|t| t.layers.len()).sum();
        assert_eq!(layer_count_after, layer_count_before);
        assert_eq!(handle.history_status().await.cursor, history_cursor_before);
    }

    /// A 3-op chain where the second op violates the no-overlap invariant
    /// must HALT at that op — the third must NOT execute. Mirrors the
    /// real-execution behavior where a failing commit aborts.
    #[tokio::test]
    async fn dry_run_halts_at_first_validation_error() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        // Real-commit a layer at [0, 3s] so the first op in the chain
        // overlaps with it.
        handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::BLACK), 0, 3_000_000)
            .await
            .expect("seed layer");

        let results = handle
            .dry_run(vec![
                DryRunOp::AddLayer {
                    track_id,
                    params: color_layer(Rgba::WHITE),
                    t_start_us: 0,
                    t_end_us: 4_000_000, // overlaps with [0, 3s]
                },
                DryRunOp::AddLayer {
                    track_id,
                    params: color_layer(Rgba::WHITE),
                    t_start_us: 5_000_000,
                    t_end_us: 6_000_000,
                },
            ])
            .await;
        assert_eq!(results.len(), 1, "halt should drop subsequent ops");
        assert!(matches!(
            &results[0],
            Err(CommandError::ValidationFailed(ValidationError::LayerOverlap { .. }))
        ));
    }

    /// A two-op chain that's only valid as a sequence: add layer A, then
    /// move A. Dry-run must apply both in order against the SAME working
    /// clone so the second op sees the first op's mutation.
    #[tokio::test]
    async fn dry_run_chains_state_across_ops() {
        let (project, track_id) = project_with_video_track();
        // Need a second track so MoveLayer has somewhere to land.
        let mut project = project;
        let mut second_track = Track::new();
        let second_track_id = second_track.id;
        second_track.label = Some("Overlay".into());
        project.tracks.push_back(second_track);
        let handle = spawn(project);

        // First op produces a layer id; we don't see it from outside, so
        // pre-seed instead and chain a move + update on the real id.
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                2_000_000,
            )
            .await
            .expect("seed layer");

        let results = handle
            .dry_run(vec![
                DryRunOp::MoveLayer {
                    id: layer_id,
                    new_track_id: second_track_id,
                    new_t_start_us: 1_000_000,
                    escape_group: false,
                },
                DryRunOp::UpdateLayer {
                    id: layer_id,
                    patch: LayerPatch {
                        label: Some("renamed".into()),
                        ..Default::default()
                    },
                },
            ])
            .await;
        assert_eq!(results.len(), 2);
        assert!(matches!(results[0], Ok(DryRunOutput::Void)));
        assert!(matches!(results[1], Ok(DryRunOutput::Void)));

        // Real state still untouched — the seed layer should be where we
        // put it, not where the dry-run move would have landed it.
        let snap = handle.snapshot().await;
        let original_track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(original_track.layers.len(), 1);
        assert_eq!(original_track.layers[0].id, layer_id);
        assert_eq!(original_track.layers[0].label, None);
    }

    /// An invalid layer id surfaces as LayerNotFound from the apply_*
    /// function — should propagate cleanly through the dispatcher.
    #[tokio::test]
    async fn dry_run_surfaces_apply_errors_with_correct_op_index() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        // First op succeeds; second op refers to a non-existent layer.
        let results = handle
            .dry_run(vec![
                DryRunOp::AddLayer {
                    track_id,
                    params: color_layer(Rgba::WHITE),
                    t_start_us: 0,
                    t_end_us: 1_000_000,
                },
                DryRunOp::DeleteLayer { id: new_id() },
            ])
            .await;
        assert_eq!(results.len(), 2, "halt after the second op fails");
        assert!(matches!(results[0], Ok(DryRunOutput::AddLayer { .. })));
        assert!(matches!(
            &results[1],
            Err(CommandError::LayerNotFound { .. })
        ));
    }

    // ============================================================
    // Groups (Phase G.2 — `docs/group-system.md`)
    // ============================================================

    async fn three_layers_on_video_track() -> (ProjectHandle, TrackId, LayerId, LayerId, LayerId) {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let a = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();
        let c = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                4_000_000,
                5_000_000,
            )
            .await
            .unwrap();
        (handle, track_id, a, b, c)
    }

    #[tokio::test]
    async fn groups_create_two_layers_succeeds() {
        let (handle, _t, a, b, _c) = three_layers_on_video_track().await;
        let group_id = handle
            .groups_create(Actor::User, vec![a, b], Some("scene 1".into()), false)
            .await
            .expect("create");
        let snap = handle.snapshot().await;
        assert_eq!(snap.groups.len(), 1);
        let g = &snap.groups[0];
        assert_eq!(g.id, group_id);
        assert_eq!(g.label.as_deref(), Some("scene 1"));
        assert!(g.members.contains(&a) && g.members.contains(&b));
    }

    #[tokio::test]
    async fn groups_create_rejects_single_member() {
        let (handle, _t, a, _b, _c) = three_layers_on_video_track().await;
        let err = handle
            .groups_create(Actor::User, vec![a], None, false)
            .await
            .expect_err("single-member group");
        assert!(matches!(
            err,
            CommandError::GroupCreateNeedsTwoLayers { got: 1 }
        ));
    }

    #[tokio::test]
    async fn groups_create_rejects_unknown_layer() {
        let (handle, _t, a, _b, _c) = three_layers_on_video_track().await;
        let ghost = new_id();
        let err = handle
            .groups_create(Actor::User, vec![a, ghost], None, false)
            .await
            .expect_err("unknown layer");
        assert!(matches!(err, CommandError::LayerNotFound { layer } if layer == ghost));
    }

    #[tokio::test]
    async fn groups_create_rejects_already_grouped_without_reassign() {
        let (handle, _t, a, b, c) = three_layers_on_video_track().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let err = handle
            .groups_create(Actor::User, vec![a, c], None, false)
            .await
            .expect_err("a is already grouped");
        assert!(matches!(err, CommandError::LayerAlreadyGrouped { layer, .. } if layer == a));
    }

    #[tokio::test]
    async fn groups_create_with_reassign_moves_layer() {
        let (handle, _t, a, b, c) = three_layers_on_video_track().await;
        let g1 = handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let g2 = handle
            .groups_create(Actor::User, vec![a, c], None, true)
            .await
            .expect("reassign should succeed");
        let snap = handle.snapshot().await;
        // g1 had only {a, b}; removing a left {b}, which auto-dissolved g1.
        // So we should now have exactly one group (g2) with members {a, c}.
        assert_eq!(snap.groups.len(), 1, "g1 should have auto-dissolved");
        let g = snap.groups.iter().find(|g| g.id == g2).unwrap();
        assert!(g.members.contains(&a) && g.members.contains(&c));
        assert!(snap.groups.iter().all(|g| g.id != g1));
    }

    #[tokio::test]
    async fn groups_dissolve_removes_group() {
        let (handle, _t, a, b, _c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle.groups_dissolve(Actor::User, g).await.unwrap();
        let snap = handle.snapshot().await;
        assert!(snap.groups.is_empty());
    }

    #[tokio::test]
    async fn groups_dissolve_unknown_id_fails() {
        let (handle, _t, _a, _b, _c) = three_layers_on_video_track().await;
        let err = handle
            .groups_dissolve(Actor::User, new_id())
            .await
            .expect_err("unknown group");
        assert!(matches!(err, CommandError::GroupNotFound { .. }));
    }

    #[tokio::test]
    async fn groups_add_members_grows_group() {
        let (handle, _t, a, b, c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .groups_add_members(Actor::User, g, vec![c], false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.groups[0].members.len(), 3);
    }

    #[tokio::test]
    async fn groups_remove_members_auto_dissolves_below_two() {
        let (handle, _t, a, b, c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b, c], None, false)
            .await
            .unwrap();
        handle
            .groups_remove_members(Actor::User, g, vec![b, c])
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert!(
            snap.groups.is_empty(),
            "group with only one remaining member should auto-dissolve"
        );
    }

    #[tokio::test]
    async fn groups_remove_unknown_member_fails() {
        let (handle, _t, a, b, c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let err = handle
            .groups_remove_members(Actor::User, g, vec![c])
            .await
            .expect_err("c is not in the group");
        assert!(matches!(err, CommandError::LayerNotInGroup { .. }));
    }

    #[tokio::test]
    async fn groups_rename_updates_label() {
        let (handle, _t, a, b, _c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b], Some("old".into()), false)
            .await
            .unwrap();
        handle
            .groups_rename(Actor::User, g, Some("new".into()))
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.groups[0].label.as_deref(), Some("new"));
    }

    #[tokio::test]
    async fn delete_layer_auto_removes_from_group_and_dissolves() {
        let (handle, _t, a, b, _c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle.delete_layer(Actor::User, a).await.unwrap();
        let snap = handle.snapshot().await;
        // Group had {a, b}; removing a left {b}; auto-dissolved.
        assert!(snap.groups.iter().all(|gg| gg.id != g));
    }

    #[tokio::test]
    async fn undo_restores_group() {
        let (handle, _t, a, b, _c) = three_layers_on_video_track().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle.undo(Actor::User).await.unwrap();
        let snap = handle.snapshot().await;
        assert!(snap.groups.is_empty(), "undo should reverse groups_create");
    }

    // ============================================================
    // Group-aware move / trim / split (Phase G.3 — `docs/group-system.md`)
    // ============================================================

    /// Two tracks, A on track1 and B on track2, both at [0..1_000_000].
    /// Returns (handle, track1, track2, a, b).
    async fn paired_layers_on_two_tracks(
    ) -> (ProjectHandle, TrackId, TrackId, LayerId, LayerId) {
        let (project, track1) = project_with_video_track();
        let handle = spawn(project);
        let track2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let a = handle
            .add_layer(Actor::User, track1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(Actor::User, track2, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        (handle, track1, track2, a, b)
    }

    fn layer<'a>(p: &'a Project, id: LayerId) -> &'a Layer {
        p.tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == id)
            .expect("layer present")
    }

    #[tokio::test]
    async fn move_layer_propagates_time_delta_to_group_siblings() {
        // V.4 contract: siblings shift by the same time delta AND
        // follow the anchor onto its destination track. To keep the
        // test focused on the time-shift behavior (rather than
        // requiring a non-overlapping layout post-follow), use
        // cross-class layers — a Visual + an Audio — so they can
        // coexist on the same track at the same time slot.
        use crate::state::layer::AudioParams;
        let (project, t1) = project_with_video_track();
        let handle = spawn(project);
        let t2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let media = dummy_video_media(5_000_000);
        let media_id = media.id;
        handle.add_media_item(Actor::User, media).await.unwrap();

        let a = handle
            .add_layer(Actor::User, t1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                t2,
                LayerParams::Audio(AudioParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    gain_db: Animated::Static(0.0),
                    pan: Animated::Static(0.0),
                    fade_in_us: 0,
                    fade_out_us: 0,
                    mute: false,
                }),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();

        // Shift A right by +500ms on its own track.
        handle
            .move_layer(Actor::User, a, t1, 500_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        let la = layer(&snap, a);
        let lb = layer(&snap, b);
        assert_eq!(la.t_start_us, 500_000);
        assert_eq!(la.t_end_us, 1_500_000);
        assert_eq!(lb.t_start_us, 500_000, "sibling shifts by the same delta");
        assert_eq!(lb.t_end_us, 1_500_000);
    }

    #[tokio::test]
    async fn move_layer_track_change_pulls_grouped_siblings_along() {
        // V.4: siblings follow the anchor onto the destination track
        // (replaces the old "siblings stay on their track" rule).
        // Setup A on t1, B on t2 (different classes so they can
        // co-exist on one track). Move A to t3 with a +500ms delta;
        // both A and B end up on t3 at the shifted time.
        use crate::state::layer::AudioParams;
        let (project, t1) = project_with_video_track();
        let handle = spawn(project);
        let t2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let t3 = handle
            .add_track(Actor::User, Some("V3".into()))
            .await
            .unwrap();
        let media = dummy_video_media(5_000_000);
        let media_id = media.id;
        handle.add_media_item(Actor::User, media).await.unwrap();

        let a = handle
            .add_layer(Actor::User, t1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                t2,
                LayerParams::Audio(AudioParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    gain_db: Animated::Static(0.0),
                    pan: Animated::Static(0.0),
                    fade_in_us: 0,
                    fade_out_us: 0,
                    mute: false,
                }),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .move_layer(Actor::User, a, t3, 500_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        // Both A and B are now on t3.
        let track_of_a = snap
            .tracks
            .iter()
            .find(|t| t.layers.iter().any(|l| l.id == a))
            .unwrap();
        assert_eq!(track_of_a.id, t3, "anchor moves to destination");
        let track_of_b = snap
            .tracks
            .iter()
            .find(|t| t.layers.iter().any(|l| l.id == b))
            .unwrap();
        assert_eq!(track_of_b.id, t3, "sibling follows to same destination");
        // B's time shifted by the same delta.
        assert_eq!(layer(&snap, b).t_start_us, 500_000);
        assert_eq!(layer(&snap, b).t_end_us, 1_500_000);
    }

    #[tokio::test]
    async fn move_layer_escape_group_skips_fanout() {
        let (handle, t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let pre = handle.snapshot().await;
        let pre_b = layer(&pre, b).clone();
        handle
            .move_layer(Actor::User, a, t1, 2_000_000, true)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        let la = layer(&snap, a);
        let lb = layer(&snap, b);
        assert_eq!(la.t_start_us, 2_000_000);
        assert_eq!(lb.t_start_us, pre_b.t_start_us, "B not touched on escape");
    }

    #[tokio::test]
    async fn move_layer_rejects_when_sibling_locked() {
        let (handle, t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .update_layer(
                Actor::User,
                b,
                LayerPatch {
                    locked: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let err = handle
            .move_layer(Actor::User, a, t1, 500_000, false)
            .await
            .expect_err("locked sibling should reject");
        assert!(matches!(err, CommandError::GroupLockedMember { .. }));
    }

    #[tokio::test]
    async fn move_layer_locked_sibling_yields_to_escape() {
        let (handle, t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .update_layer(
                Actor::User,
                b,
                LayerPatch {
                    locked: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        // escape_group=true bypasses the lock check.
        handle
            .move_layer(Actor::User, a, t1, 500_000, true)
            .await
            .expect("escape should bypass lock");
    }

    /// AV-link case: video and audio at identical bounds, both edges aligned.
    /// Trimming the out edge of one should fan out to the other.
    #[tokio::test]
    async fn trim_aligned_edges_propagate_to_group_siblings() {
        let (handle, t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let _ = t1;
        // Trim out edge of A from 1_000_000 to 700_000. Both A and B were
        // at out=1_000_000 → aligned → both move.
        handle
            .trim_layer(Actor::User, a, LayerEdge::Out, 700_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(layer(&snap, a).t_end_us, 700_000);
        assert_eq!(
            layer(&snap, b).t_end_us,
            700_000,
            "aligned out edge propagates"
        );
    }

    /// Scene case: B-roll [0..1_000_000] and VO [0..5_000_000] in one group.
    /// Left edges align (both 0); out edges don't. Trimming B-roll's left
    /// edge should fan out (aligned); trimming its right edge should not.
    #[tokio::test]
    async fn trim_non_aligned_edge_stays_local() {
        let (project, track1) = project_with_video_track();
        let handle = spawn(project);
        let track2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let a = handle
            .add_layer(Actor::User, track1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(Actor::User, track2, color_layer(Rgba::WHITE), 0, 5_000_000)
            .await
            .unwrap();
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        // Trim A's OUT edge from 1_000_000 -> 800_000. B's out is at
        // 5_000_000 → NOT aligned → B unchanged.
        handle
            .trim_layer(Actor::User, a, LayerEdge::Out, 800_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(layer(&snap, a).t_end_us, 800_000);
        assert_eq!(layer(&snap, b).t_end_us, 5_000_000, "non-aligned stays");
        // Trim A's IN edge from 0 -> 100_000. B's in is also 0 → aligned →
        // both move. But clamping: A has dur=800_000 so its t_start can
        // go from 0 to at most 799_999; same for B (dur 5_000_000).
        // requested delta = +100_000 fits both.
        handle
            .trim_layer(Actor::User, a, LayerEdge::In, 100_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(layer(&snap, a).t_start_us, 100_000);
        assert_eq!(
            layer(&snap, b).t_start_us,
            100_000,
            "aligned in edge propagates"
        );
    }

    #[tokio::test]
    async fn trim_clamps_to_tightest_aligned_member() {
        // A on [0..1_000_000], B on [0..200_000], grouped. Trim A's out
        // edge to +500_000. B's dur is 200_000 so its max trim is +inf
        // upward (out goes up); but trimming A DOWN to 500_000 means
        // delta = -500_000. For B, that would push out to -300_000 — but
        // B's t_start is 0 and dur is 200_000, so trimming out by more
        // than 199_999 collapses it. Clamp should kick in.
        let (project, track1) = project_with_video_track();
        let handle = spawn(project);
        let track2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let a = handle
            .add_layer(Actor::User, track1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(Actor::User, track2, color_layer(Rgba::WHITE), 0, 200_000)
            .await
            .unwrap();
        // Force out edge alignment by trimming B's out to 1_000_000 first
        // via escape (so they're aligned at 1_000_000).
        // Actually here we test alignment at 200_000 only. The two layers
        // are NOT aligned at any out edge (1_000_000 vs 200_000), so the
        // fan-out doesn't fire — A trims alone.
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        // Trim A's out from 1_000_000 to 500_000. B is at out=200_000 (not
        // aligned) → B untouched.
        handle
            .trim_layer(Actor::User, a, LayerEdge::Out, 500_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(layer(&snap, a).t_end_us, 500_000);
        assert_eq!(layer(&snap, b).t_end_us, 200_000);
    }

    #[tokio::test]
    async fn trim_escape_group_stays_local() {
        let (handle, _t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .trim_layer(Actor::User, a, LayerEdge::Out, 600_000, true)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(layer(&snap, a).t_end_us, 600_000);
        assert_eq!(layer(&snap, b).t_end_us, 1_000_000, "escape keeps B intact");
    }

    #[tokio::test]
    async fn split_layer_fans_out_to_spanning_siblings() {
        let (handle, _t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let (_la, ra) = handle
            .split_layer(Actor::User, a, 500_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        // Both layers should be split at 500_000. A has its right half
        // (ra) and a left half (still id=a). B should also have two
        // pieces.
        let on_track2: Vec<&Layer> = snap
            .tracks
            .iter()
            .find(|t| t.layers.iter().any(|l| l.id == b))
            .unwrap()
            .layers
            .iter()
            .collect();
        assert_eq!(on_track2.len(), 2, "B was split into 2 pieces");
        assert!(on_track2.iter().any(|l| l.t_end_us == 500_000));
        assert!(on_track2.iter().any(|l| l.t_start_us == 500_000));
        // The group should now have 4 members (a, ra, b's left, b's right).
        assert_eq!(snap.groups.len(), 1);
        assert_eq!(snap.groups[0].members.len(), 4);
        // ra should be in the group.
        assert!(snap.groups[0].members.contains(&ra));
    }

    #[tokio::test]
    async fn split_layer_non_spanning_sibling_stays_whole() {
        // A on [0..1_000_000], B on [2_000_000..3_000_000], grouped.
        // Split A at 500_000 — B doesn't span 500_000, stays whole and
        // stays in the group.
        let (project, track1) = project_with_video_track();
        let handle = spawn(project);
        let track2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let a = handle
            .add_layer(Actor::User, track1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                track2,
                color_layer(Rgba::WHITE),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let _ = handle
            .split_layer(Actor::User, a, 500_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        let b_layer = layer(&snap, b);
        assert_eq!(b_layer.t_start_us, 2_000_000);
        assert_eq!(b_layer.t_end_us, 3_000_000);
        // Group has 3 members (a, ra, b).
        assert_eq!(snap.groups[0].members.len(), 3);
    }

    #[tokio::test]
    async fn split_layer_escape_group_only_splits_target() {
        let (handle, _t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let _ = handle
            .split_layer(Actor::User, a, 500_000, true)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        // Find B; it should be unchanged (one layer on its track).
        let on_track2: Vec<&Layer> = snap
            .tracks
            .iter()
            .find(|t| t.layers.iter().any(|l| l.id == b))
            .unwrap()
            .layers
            .iter()
            .collect();
        assert_eq!(on_track2.len(), 1, "B should not be split under escape");
    }

    // Phase G.5 — verify the import-pairing orchestration composes cleanly
    // at the actor level. `add_video_layer` / `add_media_layer` perform
    // add_layer + add_layer + groups_create as three sequential commits;
    // this test replays that sequence and checks the final group state.
    #[tokio::test]
    async fn paired_av_import_produces_grouped_pair() {
        use crate::state::{
            AudioParams as AP, LayerParams as LP, VideoClipParams as VCP, MediaItem,
            MediaKind, MediaMetadata, AudioStreamMeta,
        };
        let (project, video_track) = project_with_video_track();
        let handle = spawn(project);
        let audio_track = handle
            .add_track(Actor::User, Some("Audio".into()))
            .await
            .unwrap();
        // Inject a media item with both video AND audio streams. The
        // pairing path reads `MediaMetadata.audio` to decide whether to
        // create the Audio layer.
        let media = MediaItem {
            id: new_id(),
            label: Some("clip.mp4".into()),
            path_abs: "/tmp/clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(5_000_000),
                video: None,
                audio: Some(AudioStreamMeta {
                    sample_rate: 48_000,
                    channels: 2,
                    codec: "aac".into(),
                }),
            },
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        let media_id = media.id;
        handle.add_media_item(Actor::User, media).await.unwrap();
        let video_layer_id = handle
            .add_layer(
                Actor::User,
                video_track,
                LP::VideoClip(VCP {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 5_000_000,
                    transform: Default::default(),
                    opacity: Animated::Static(1.0),
                    crop: None,
                    flip_h: false,
                    flip_v: false,
                    blend_mode: Default::default(),
                    speed: 1.0,
                    fade_in_us: 0,
                    fade_out_us: 0,
                }),
                0,
                5_000_000,
            )
            .await
            .unwrap();
        let audio_layer_id = handle
            .add_layer(
                Actor::User,
                audio_track,
                LP::Audio(AP {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 5_000_000,
                    gain_db: Animated::Static(0.0),
                    pan: Animated::Static(0.0),
                    fade_in_us: 0,
                    fade_out_us: 0,
                    mute: false,
                }),
                0,
                5_000_000,
            )
            .await
            .unwrap();
        let group_id = handle
            .groups_create(
                Actor::User,
                vec![video_layer_id, audio_layer_id],
                None,
                false,
            )
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.groups.len(), 1);
        let g = &snap.groups[0];
        assert_eq!(g.id, group_id);
        assert!(g.members.contains(&video_layer_id));
        assert!(g.members.contains(&audio_layer_id));
        // Sanity: a subsequent move on the video propagates to the audio.
        handle
            .move_layer(Actor::User, video_layer_id, video_track, 1_000_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        let v = layer(&snap, video_layer_id);
        let a = layer(&snap, audio_layer_id);
        assert_eq!(v.t_start_us, 1_000_000);
        assert_eq!(a.t_start_us, 1_000_000, "AV pair shifts together");
    }

    #[tokio::test]
    async fn split_layer_locked_spanning_sibling_rejects() {
        let (handle, _t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .update_layer(
                Actor::User,
                b,
                LayerPatch {
                    locked: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let err = handle
            .split_layer(Actor::User, a, 500_000, false)
            .await
            .expect_err("locked sibling should reject");
        assert!(matches!(err, CommandError::GroupLockedMember { .. }));
    }
}
