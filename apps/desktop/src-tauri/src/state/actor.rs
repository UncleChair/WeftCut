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
use super::ids::{
    CheckpointId, LayerId, MarkerId, MediaId, OpId, TrackId, TransitionId, new_id,
};
use super::layer::{Layer, LayerParams};
use super::marker::Marker;
use super::media::MediaItem;
use super::project::Project;
use super::time::{Rational, TimeUs};
use super::track::{Track, TrackKind};
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
#[derive(Clone, Debug, Default)]
pub struct MediaDerivativesPatch {
    pub proxy_path: Option<std::path::PathBuf>,
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
    #[error("layer {layer} kind {actual} does not match patch kind {patch}")]
    LayerParamsKindMismatch {
        layer: LayerId,
        actual: &'static str,
        patch: &'static str,
    },
    #[error("nothing to undo")]
    NothingToUndo,
    #[error("nothing to redo")]
    NothingToRedo,
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
        kind: TrackKind,
        label: Option<String>,
        actor: Actor,
        reply: oneshot::Sender<Result<TrackId, CommandError>>,
    },
    DeleteTrack {
        id: TrackId,
        force: bool,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
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
        actor: Actor,
        reply: oneshot::Sender<Result<(LayerId, LayerId), CommandError>>,
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
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct HistoryStatus {
    pub cursor: usize,
    pub len: usize,
    pub can_undo: bool,
    pub can_redo: bool,
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

    pub async fn add_track(
        &self,
        actor: Actor,
        kind: TrackKind,
        label: Option<String>,
    ) -> Result<TrackId, CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::AddTrack {
                kind,
                label,
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

    pub async fn split_layer(
        &self,
        actor: Actor,
        id: LayerId,
        at_t_us: TimeUs,
    ) -> Result<(LayerId, LayerId), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::SplitLayer {
                id,
                at_t_us,
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

    pub async fn move_layer(
        &self,
        actor: Actor,
        id: LayerId,
        new_track_id: TrackId,
        new_t_start_us: TimeUs,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::MoveLayer {
                id,
                new_track_id,
                new_t_start_us,
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
                kind,
                label,
                actor,
                reply,
            } => {
                let result = self.do_add_track(kind, label, actor);
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
            Command::SplitLayer {
                id,
                at_t_us,
                actor,
                reply,
            } => {
                let result = self.do_split_layer(id, at_t_us, actor);
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
                actor,
                reply,
            } => {
                let result = self.do_move_layer(id, new_track_id, new_t_start_us, actor);
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
                });
            }
            Command::HistoryView { limit, reply } => {
                let _ = reply.send(self.history.view(limit));
            }
        }
    }

    fn do_add_track(
        &mut self,
        kind: TrackKind,
        label: Option<String>,
        actor: Actor,
    ) -> Result<TrackId, CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let mut track = Track::new(kind);
        track.label = label;
        let track_id = track.id;
        next.tracks.push_back(track);
        self.commit(
            next,
            actor,
            format!("Added {kind:?} track {track_id}"),
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
        let track_idx = next
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

        let track = next
            .tracks
            .get_mut(track_idx)
            .expect("index just verified");

        // Insert in `t_start_us` order so iteration stays sorted; validation
        // catches actual overlap and inverted ranges.
        let insert_at = track
            .layers
            .iter()
            .position(|l| l.t_start_us > t_start_us)
            .unwrap_or(track.layers.len());
        track.layers.insert(insert_at, new_layer);

        if next.composition.duration_us < t_end_us {
            next.composition.duration_us = t_end_us;
        }

        self.commit(
            next,
            actor,
            format!("Added layer {layer_id} on track {track_id}"),
            vec![EntityRef::Layer(layer_id), EntityRef::Track(track_id)],
            DiffHint::Layer(layer_id),
        )?;
        Ok(layer_id)
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
        actor: Actor,
    ) -> Result<(LayerId, LayerId), CommandError> {
        let mut next: Project = (*self.history.current()).clone();

        // Locate the layer in some track.
        let mut found: Option<(usize, usize)> = None;
        for (ti, track) in next.tracks.iter().enumerate() {
            if let Some(li) = track.layers.iter().position(|l| l.id == id) {
                found = Some((ti, li));
                break;
            }
        }
        let (ti, li) = found.ok_or(CommandError::LayerNotFound { layer: id })?;

        let original = next.tracks[ti].layers[li].clone();
        if at_t_us <= original.t_start_us || at_t_us >= original.t_end_us {
            return Err(CommandError::SplitOutsideLayer {
                layer: id,
                at_t: at_t_us,
            });
        }

        let split_offset = at_t_us - original.t_start_us;

        // Build the right half.
        let mut right = original.clone();
        right.id = new_id();
        right.t_start_us = at_t_us;
        right.t_end_us = original.t_end_us;
        // Adjust source offsets for media-bearing variants. Speed=1 assumption
        // for Phase 1 — Phase 2 will fold variable speed into the offset math.
        match &mut right.params {
            LayerParams::VideoClip(p) => {
                p.src_in_us = p.src_in_us + split_offset;
            }
            LayerParams::Audio(p) => {
                p.src_in_us = p.src_in_us + split_offset;
            }
            _ => {}
        }

        // Build the left half: clone original, truncate end. Adjust src_out
        // similarly so its source range matches its timeline range.
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

        let track = &mut next.tracks[ti];
        track.layers[li] = left;
        // Insert right just after left, keeping `t_start_us` order.
        let insert_at = li + 1;
        track.layers.insert(insert_at, right.clone());

        let left_id = id;
        let right_id = right.id;
        self.commit(
            next,
            actor,
            format!("Split layer {id} at {at_t_us}us"),
            vec![EntityRef::Layer(left_id), EntityRef::Layer(right_id)],
            DiffHint::Coarse,
        )?;
        Ok((left_id, right_id))
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
        let mut found = false;
        for track in next.tracks.iter_mut() {
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
                found = true;
                break;
            }
        }
        if !found {
            return Err(CommandError::LayerNotFound { layer: id });
        }
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
        let mut found = false;
        for track in next.tracks.iter_mut() {
            if let Some(idx) = track.layers.iter().position(|l| l.id == id) {
                let layer = track.layers.get_mut(idx).expect("index just verified");
                apply_params_patch(layer, &patch, id)?;
                found = true;
                break;
            }
        }
        if !found {
            return Err(CommandError::LayerNotFound { layer: id });
        }
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
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();

        // Pull the layer out of its current track first.
        let mut moved: Option<Layer> = None;
        for track in next.tracks.iter_mut() {
            if let Some(idx) = track.layers.iter().position(|l| l.id == id) {
                moved = Some(track.layers.remove(idx));
                break;
            }
        }
        let mut layer = moved.ok_or(CommandError::LayerNotFound { layer: id })?;

        // Shift end by the same delta as start.
        let delta = new_t_start_us - layer.t_start_us;
        layer.t_start_us = new_t_start_us;
        layer.t_end_us += delta;

        let dest_idx = next
            .tracks
            .iter()
            .position(|t| t.id == new_track_id)
            .ok_or(CommandError::TrackNotFound {
                track: new_track_id,
            })?;
        let dest = next
            .tracks
            .get_mut(dest_idx)
            .expect("index just verified");
        let insert_at = dest
            .layers
            .iter()
            .position(|l| l.t_start_us > new_t_start_us)
            .unwrap_or(dest.layers.len());
        dest.layers.insert(insert_at, layer);

        if next.composition.duration_us < new_t_start_us + delta {
            // Not strictly needed (delta could be negative), but auto-extend the
            // composition if the move pushes past it.
            let max_end = next
                .tracks
                .iter()
                .flat_map(|t| t.layers.iter().map(|l| l.t_end_us))
                .max()
                .unwrap_or(next.composition.duration_us);
            if max_end > next.composition.duration_us {
                next.composition.duration_us = max_end;
            }
        }

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
        let mut next: Project = (*self.history.current()).clone();
        let c = &mut next.composition;
        if let Some(width) = patch.width {
            c.width = width;
        }
        if let Some(height) = patch.height {
            c.height = height;
        }
        if let Some(fps) = patch.fps {
            c.fps = fps;
        }
        if let Some(duration) = patch.duration_us {
            c.duration_us = duration;
        }
        if let Some(sr) = patch.sample_rate {
            c.sample_rate = sr;
        }
        if let Some(ch) = patch.channels {
            c.channels = ch;
        }
        if let Some(cs) = patch.color_space {
            c.color_space = cs;
        }
        if let Some(bg) = patch.background {
            c.background = bg;
        }
        self.commit(
            next,
            actor,
            "Updated composition".to_string(),
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

        let mut next: Project = (*current).clone();
        // Cascade-delete referencing layers (force=true case). Without force,
        // this set is empty and the loop is a no-op.
        for layer_id in &referencing {
            for track in next.tracks.iter_mut() {
                if let Some(idx) = track.layers.iter().position(|l| l.id == *layer_id) {
                    track.layers.remove(idx);
                    break;
                }
            }
        }
        next.media_pool.remove(&id);

        let summary = if referencing.is_empty() {
            format!("Removed media {id}")
        } else {
            format!(
                "Removed media {id} and {} referencing layer(s)",
                referencing.len()
            )
        };
        let affected: Vec<EntityRef> =
            referencing.iter().map(|l| EntityRef::Layer(*l)).collect();
        self.commit(next, actor, summary, affected, DiffHint::Coarse)?;
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
            item.proxy_path = Some(p);
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
        // Carry the project_id through unchanged so listeners see "same project, new
        // state" rather than a fresh project. Callers wanting a fresh project should
        // construct one explicitly with `Project::new_blank`.
        let mut to_commit = next;
        to_commit.metadata.modified_at = Utc::now();
        self.commit(
            to_commit,
            actor,
            "Replaced project state".to_string(),
            Vec::new(),
            DiffHint::Coarse,
        )?;
        Ok(())
    }

    fn do_delete_layer(&mut self, id: LayerId, actor: Actor) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let mut removed = false;
        for track in next.tracks.iter_mut() {
            if let Some(idx) = track.layers.iter().position(|l| l.id == id) {
                track.layers.remove(idx);
                removed = true;
                break;
            }
        }
        if !removed {
            return Err(CommandError::LayerNotFound { layer: id });
        }
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
        let snapshot = self.history.undo().ok_or(CommandError::NothingToUndo)?;
        self.broadcast_unrecorded(actor, "Undo".to_string(), snapshot);
        Ok(())
    }

    fn do_redo(&mut self, actor: Actor) -> Result<(), CommandError> {
        let snapshot = self.history.redo().ok_or(CommandError::NothingToRedo)?;
        self.broadcast_unrecorded(actor, "Redo".to_string(), snapshot);
        Ok(())
    }

    fn do_restore_checkpoint(
        &mut self,
        id: CheckpointId,
        actor: Actor,
    ) -> Result<(), CommandError> {
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
    use crate::state::{Animated, ColorParams, LayerParams, Project, Rgba, Track, TrackKind};

    fn project_with_video_track() -> (Project, TrackId) {
        // Start from a blank but strip the default A-roll/B-roll so each
        // delete/insert/replace test has a clean slate to assert against.
        let mut p = Project::new_blank("test");
        p.tracks.clear();
        let track = Track::new(TrackKind::Video);
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
            .split_layer(Actor::User, layer_id, 1_500_000)
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
                .split_layer(Actor::User, layer_id, at)
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
        let dst_track = Track::new(TrackKind::Video);
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
            .move_layer(Actor::User, id, dst_track_id, 5_000_000)
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
    async fn replace_state_swaps_project_in_one_commit() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let mut replacement = Project::new_blank("replaced");
        replacement.tracks.clear();
        replacement
            .tracks
            .push_back(super::Track::new(super::TrackKind::Audio));
        let replacement_id = replacement.project_id;

        handle
            .replace_state(Actor::User, replacement)
            .await
            .expect("replace_state");

        let snap = handle.snapshot().await;
        assert_eq!(snap.project_id, replacement_id);
        assert_eq!(snap.metadata.name, "replaced");
        assert_eq!(snap.tracks.len(), 1);
        assert!(matches!(snap.tracks[0].kind, super::TrackKind::Audio));

        // Undo should bring back the original project.
        handle.undo(Actor::User).await.expect("undo");
        let snap = handle.snapshot().await;
        assert_eq!(snap.metadata.name, "test");
        assert!(matches!(snap.tracks[0].kind, super::TrackKind::Video));
    }

    #[tokio::test]
    async fn blank_project_ships_with_a_b_roll() {
        let p = Project::new_blank("untitled");
        assert_eq!(p.tracks.len(), 2);
        // Both video, both non-removable. A roll at index 0 (bottom of z-stack
        // = video base), B roll at index 1 (top of z-stack = overlays).
        assert_eq!(p.tracks[0].label.as_deref(), Some("A roll"));
        assert_eq!(p.tracks[1].label.as_deref(), Some("B roll"));
        for t in p.tracks.iter() {
            assert!(matches!(t.kind, super::TrackKind::Video));
            assert!(!t.removable);
        }
    }

    #[tokio::test]
    async fn cannot_delete_non_removable_track() {
        let handle = spawn(Project::new_blank("untitled"));
        let snap = handle.snapshot().await;
        let a_roll_id = snap.tracks[0].id;
        let err = handle
            .delete_track(Actor::User, a_roll_id, true)
            .await
            .expect_err("delete should fail on non-removable track");
        assert!(matches!(err, CommandError::TrackNotRemovable { .. }));
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
        let handle = spawn(Project::new_blank("untitled"));
        let snap = handle.snapshot().await;
        // Default A roll is at position 0, B roll at position 1.
        let a_roll = snap.tracks[0].id;
        let b_roll = snap.tracks[1].id;
        // Move B roll above A roll.
        handle
            .move_track(Actor::User, b_roll, 0)
            .await
            .expect("move_track");
        let snap = handle.snapshot().await;
        assert_eq!(snap.tracks[0].id, b_roll);
        assert_eq!(snap.tracks[1].id, a_roll);
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
                    proxy_path: Some(PathBuf::from("/cache/proxies/abc.mp4")),
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
}
