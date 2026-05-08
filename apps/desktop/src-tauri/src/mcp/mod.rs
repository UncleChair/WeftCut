//! MCP server: tool surface, resources, prompts, SSE change feed.
//!
//! Transport: SSE on `127.0.0.1:<auto-port>`. Streamable HTTP is the spec
//! target but rmcp 0.1.x hasn't shipped it yet — Claude Desktop accepts both.
//! Swap to streamable-http when upstream lands.
//!
//! Per-session bearer token, regenerated on each app launch unless pinned.
//! rmcp 0.1.x's `SseServer` doesn't expose middleware injection, so the
//! token is generated and surfaced (UI panel + log) but **NOT enforced** on
//! incoming requests. Localhost-only binding is the real isolation on a
//! single-user machine; flipping to 0.0.0.0 must wait for proper auth.
//!
//! Resource surface (read-only):
//! - `project://current`     — full Project JSON
//! - `project://composition` — Composition only
//! - `project://media`       — media pool
//! - `project://tracks`      — tracks + layer envelopes
//! - `project://layers/{id}` — one Layer in detail
//! - `project://layers/{id}/effects` — effects on that layer (always [] today;
//!   effects deferred per `project_phase4_scope.md`)
//! - `project://markers`     — markers
//! - `project://history`     — recent ops + checkpoints (snapshot-free)
//! - `project://compiled`    — compiled IRGraph (JSON)
//! - `media://{id}/thumbnail` — middle thumbnail JPG (base64 in
//!   BlobResourceContents). 404 with hint if generation hasn't completed yet.
//! - `media://{id}/frame/{t_us}` — on-demand frame extraction at the given
//!   microsecond timestamp, lazy-cached on disk. Multimodal-friendly.
//! - `media://{id}/waveform` — peaks file (base64). See `jobs/waveform.rs`
//!   for the binary format.
//!
//! Edit tools (Stage 3) and workflow tools (Stage 4) live alongside `ping`
//! in the `VidetorServer` impl block. The change feed (Stage 5) lives on its
//! own axum-backed `/events` endpoint — see `events.rs`. Both servers spawn
//! from `serve(...)`.
//!
//! Design: `docs/mcp.md`.

mod events;

use std::net::SocketAddr;

use anyhow::{Context, Result};
use rmcp::{
    Error as McpError, ServerHandler,
    model::{
        AnnotateAble, CallToolResult, Content, ListResourcesResult, PaginatedRequestParam,
        RawResource, ReadResourceRequestParam, ReadResourceResult, ResourceContents,
        ServerCapabilities, ServerInfo,
    },
    service::RequestContext,
    tool,
    transport::sse_server::SseServer,
};
use tauri::AppHandle;
use chrono::Utc;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::info;
use uuid::Uuid;

use crate::cache::{CacheLayout, cached_ok};
use crate::io::probe;
use crate::ir::{self, RenderTarget};
use crate::jobs;
use crate::state::{
    Actor, Animated, BlendMode, ColorParams, CommandError, CompositionPatch, LayerId, LayerParams,
    LayerParamsPatch, LayerPatch, MarkerId, MarkerPatch, MediaId, MediaItem, MediaKind,
    ProjectHandle, Rational, Rgba, TrackId, TrackKind, Transform, ValidationError,
    VideoClipParams, new_id,
};

const URI_PROJECT: &str = "project://current";
const URI_COMPOSITION: &str = "project://composition";
const URI_MEDIA: &str = "project://media";
const URI_TRACKS: &str = "project://tracks";
const URI_MARKERS: &str = "project://markers";
const URI_HISTORY: &str = "project://history";
const URI_COMPILED: &str = "project://compiled";
const PREFIX_LAYERS: &str = "project://layers/";
const PREFIX_MEDIA: &str = "media://";

const HISTORY_LIMIT: usize = 100;

const APP_JSON: &str = "application/json";
const APP_OCTET: &str = "application/octet-stream";
const IMAGE_JPEG: &str = "image/jpeg";

/// Tauri-managed cell holding the MCP server's connection details once it's
/// bound. Set once at startup; read by the connect-agent panel via the
/// `get_mcp_info` Tauri command. `Arc<RwLock<Option<McpInfo>>>` rather than
/// a OnceLock so the panel gracefully renders "starting…" while the MCP
/// server is still binding its port.
pub type McpInfoCell = std::sync::Arc<std::sync::RwLock<Option<McpInfo>>>;

/// Connection details surfaced to the UI / logs so the user can wire up Claude Desktop.
#[derive(Debug, Clone, Serialize)]
pub struct McpInfo {
    pub bind: SocketAddr,
    pub sse_url: String,
    pub message_url: String,
    pub bearer_token: String,
    /// Separate /events SSE endpoint for the change feed (Stage 5). Carries
    /// snapshot-free `ChangeEventSummary` notifications. Agents subscribe to
    /// this and re-fetch `project://current` after each change.
    pub events_url: String,
}

/// The MCP server identity. Carries:
/// - `ProjectHandle` so resources read via the same single-writer actor as
///   UI commands.
/// - `CacheLayout` so `media://*` reads can serve cached derivatives.
/// - `AppHandle` so `import_media` can enqueue background jobs that emit
///   `media:job_*` Tauri events for the UI.
#[derive(Clone)]
pub struct VidetorServer {
    project: ProjectHandle,
    cache: CacheLayout,
    app: AppHandle,
}

impl std::fmt::Debug for VidetorServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VidetorServer").finish_non_exhaustive()
    }
}

#[tool(tool_box)]
impl VidetorServer {
    pub fn new(project: ProjectHandle, cache: CacheLayout, app: AppHandle) -> Self {
        Self {
            project,
            cache,
            app,
        }
    }

    #[tool(description = "Liveness check. Returns 'pong' to confirm the Videtor MCP server is reachable.")]
    async fn ping(&self) -> String {
        "pong".to_string()
    }

    // ============================================================
    // Track tools
    // ============================================================

    #[tool(description = "Add a new track to the project. Returns the new track id as a UUID string. \
                          `kind` is one of 'video', 'audio', 'subtitle' (case-insensitive).")]
    async fn add_track(
        &self,
        #[tool(aggr)] args: AddTrackArgs,
    ) -> Result<CallToolResult, McpError> {
        let kind = parse_track_kind(&args.kind)?;
        let id = self
            .project
            .add_track(agent_actor(), kind, args.label)
            .await
            .map_err(map_command_error)?;
        Ok(ok_text(id.to_string()))
    }

    #[tool(description = "Remove a track. Rejects if the track has layers unless force=true. \
                          Default A roll / B roll tracks cannot be removed.")]
    async fn remove_track(
        &self,
        #[tool(aggr)] args: RemoveTrackArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.track_id, "track_id")?;
        self.project
            .delete_track(agent_actor(), id, args.force.unwrap_or(false))
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Move a track to a different z-order position. 0 = bottom of stack. \
                          Position must be < current track count.")]
    async fn move_track(
        &self,
        #[tool(aggr)] args: MoveTrackArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.track_id, "track_id")?;
        self.project
            .move_track(agent_actor(), id, args.new_position)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    // ============================================================
    // Layer tools
    // ============================================================

    #[tool(description = "Add a solid-color layer to a track. Returns the new layer id. \
                          `t_start_us` and `t_end_us` are timeline microseconds (start inclusive, end exclusive). \
                          Layer cannot overlap existing layers on the same track.")]
    async fn add_color_layer(
        &self,
        #[tool(aggr)] args: AddColorLayerArgs,
    ) -> Result<CallToolResult, McpError> {
        let track_id = parse_uuid(&args.track_id, "track_id")?;
        let params = LayerParams::Color(ColorParams {
            color: Animated::Static(args.color),
            width: args.width.unwrap_or(1920),
            height: args.height.unwrap_or(1080),
        });
        let id = self
            .project
            .add_layer(agent_actor(), track_id, params, args.t_start_us, args.t_end_us)
            .await
            .map_err(map_command_error)?;
        Ok(ok_text(id.to_string()))
    }

    #[tool(description = "Add a video clip layer pulling a slice of an imported media item onto a track. \
                          `src_in_us`/`src_out_us` are the in/out points within the source media. \
                          `t_start_us`/`t_end_us` are where the clip lives on the timeline. \
                          The two ranges should be the same length unless `speed` is later changed.")]
    async fn add_video_layer(
        &self,
        #[tool(aggr)] args: AddVideoLayerArgs,
    ) -> Result<CallToolResult, McpError> {
        let track_id = parse_uuid(&args.track_id, "track_id")?;
        let media_id = parse_uuid(&args.media_id, "media_id")?;
        let params = LayerParams::VideoClip(VideoClipParams {
            media: media_id,
            src_in_us: args.src_in_us,
            src_out_us: args.src_out_us,
            transform: Transform::default(),
            opacity: Animated::Static(1.0),
            crop: None,
            flip_h: false,
            flip_v: false,
            blend_mode: BlendMode::default(),
            speed: 1.0,
            fade_in_us: 0,
            fade_out_us: 0,
        });
        let id = self
            .project
            .add_layer(agent_actor(), track_id, params, args.t_start_us, args.t_end_us)
            .await
            .map_err(map_command_error)?;
        Ok(ok_text(id.to_string()))
    }

    #[tool(description = "Update a layer's envelope (label, time range, enabled, locked). \
                          Only fields you set are applied. Time range changes go through validation.")]
    async fn update_layer(
        &self,
        #[tool(aggr)] args: UpdateLayerArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.layer_id, "layer_id")?;
        self.project
            .update_layer(agent_actor(), id, args.patch)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Update a layer's kind-specific params. \
                          The patch is tagged with `kind` ('Text' | 'VideoClip' | 'ImageOverlay' | 'Color' | 'Audio') \
                          and must match the layer's kind.")]
    async fn update_layer_params(
        &self,
        #[tool(aggr)] args: UpdateLayerParamsArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.layer_id, "layer_id")?;
        self.project
            .update_layer_params(agent_actor(), id, args.patch)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Move a layer to a different track and/or start time. The end time shifts \
                          by the same delta. Cross-track moves are validated against the destination's \
                          existing layers — overlap rejects with structured options.")]
    async fn move_layer(
        &self,
        #[tool(aggr)] args: MoveLayerArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        let new_track_id = parse_uuid(&args.new_track_id, "new_track_id")?;
        self.project
            .move_layer(agent_actor(), layer_id, new_track_id, args.new_t_start_us)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Split a layer into two halves at the given timeline microsecond. \
                          Returns {left, right} layer ids. `at_t_us` must be strictly between the layer's \
                          t_start_us and t_end_us. For media-bearing layers (VideoClip, Audio) the source \
                          offsets are adjusted at speed=1 — variable speed support is deferred.")]
    async fn split_layer(
        &self,
        #[tool(aggr)] args: SplitLayerArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.layer_id, "layer_id")?;
        let (left, right) = self
            .project
            .split_layer(agent_actor(), id, args.at_t_us)
            .await
            .map_err(map_command_error)?;
        ok_json(&SplitLayerResult {
            left: left.to_string(),
            right: right.to_string(),
        })
    }

    #[tool(description = "Delete a layer.")]
    async fn delete_layer(
        &self,
        #[tool(aggr)] args: LayerIdArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.layer_id, "layer_id")?;
        self.project
            .delete_layer(agent_actor(), id)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Duplicate a layer with a time offset. The copy is inserted on the same track. \
                          Returns the new layer id. The composition duration extends if needed.")]
    async fn duplicate_layer(
        &self,
        #[tool(aggr)] args: DuplicateLayerArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.layer_id, "layer_id")?;
        let dup = self
            .project
            .duplicate_layer(agent_actor(), id, args.t_offset_us)
            .await
            .map_err(map_command_error)?;
        Ok(ok_text(dup.to_string()))
    }

    // ============================================================
    // Composition tools
    // ============================================================

    #[tool(description = "Update composition envelope (canvas size, fps, sample rate, channels, color space, background). \
                          Only fields you set are applied. Width/height must be positive; fps denominator must be non-zero.")]
    async fn set_composition(
        &self,
        #[tool(aggr)] args: SetCompositionArgs,
    ) -> Result<CallToolResult, McpError> {
        self.project
            .set_composition(agent_actor(), args.patch)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    // ============================================================
    // Marker tools
    // ============================================================

    #[tool(description = "Add a marker (point or region) to the timeline. Returns the new marker id. \
                          Set `end_t_us` to make it a region marker.")]
    async fn add_marker(
        &self,
        #[tool(aggr)] args: AddMarkerArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = self
            .project
            .add_marker(agent_actor(), args.t_us, args.end_t_us, args.label, args.color)
            .await
            .map_err(map_command_error)?;
        Ok(ok_text(id.to_string()))
    }

    #[tool(description = "Update a marker. Setting `t_us` re-sorts the marker list.")]
    async fn update_marker(
        &self,
        #[tool(aggr)] args: UpdateMarkerArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.marker_id, "marker_id")?;
        self.project
            .update_marker(agent_actor(), id, args.patch)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Remove a marker.")]
    async fn remove_marker(
        &self,
        #[tool(aggr)] args: MarkerIdArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.marker_id, "marker_id")?;
        self.project
            .remove_marker(agent_actor(), id)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    // ============================================================
    // Media tools
    // ============================================================

    #[tool(description = "Import a media file from an absolute path. Hashes the file (blake3) and probes \
                          metadata via ffprobe when installed. Returns the new media id.")]
    async fn import_media(
        &self,
        #[tool(aggr)] args: ImportMediaArgs,
    ) -> Result<CallToolResult, McpError> {
        let path = std::path::PathBuf::from(&args.path);
        let item = tokio::task::spawn_blocking(move || -> Result<MediaItem, String> {
            let facts = probe::hash_and_stat(&path).map_err(|e| format!("{e:#}"))?;
            let metadata = probe::probe_metadata(&path);
            let kind: MediaKind = probe::detect_kind(&path, &metadata);
            let label = path.file_name().map(|n| n.to_string_lossy().to_string());
            Ok(MediaItem {
                id: new_id(),
                label,
                path_abs: path,
                path_rel: None,
                kind,
                metadata,
                proxy_path: None,
                waveform_path: None,
                thumbnails_dir: None,
                file_hash_blake3: facts.blake3_hex,
                file_size: facts.size,
                file_mtime: facts.mtime_secs,
                imported_at: Utc::now(),
            })
        })
        .await
        .map_err(|e| McpError::internal_error(format!("import join: {e}"), None))?
        .map_err(|e| McpError::invalid_params(format!("import: {e}"), None))?;
        let item_for_jobs = item.clone();
        let id = self
            .project
            .add_media_item(agent_actor(), item)
            .await
            .map_err(map_command_error)?;
        // Fire-and-forget: enqueues thumbnails / proxy / waveform jobs via
        // the global semaphore. UI listeners pick up `media:job_*` events;
        // cached derivatives appear in subsequent `project://media` reads.
        jobs::enqueue_for_media(
            self.app.clone(),
            self.cache.clone(),
            self.project.clone(),
            item_for_jobs,
        );
        Ok(ok_text(id.to_string()))
    }

    #[tool(description = "Remove a media item. Rejects if any layer references it unless force=true. \
                          With force=true, also deletes the referencing layers in one atomic commit.")]
    async fn remove_media(
        &self,
        #[tool(aggr)] args: RemoveMediaArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.media_id, "media_id")?;
        self.project
            .remove_media(agent_actor(), id, args.force.unwrap_or(false))
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    // ============================================================
    // Workflow tools
    // ============================================================

    #[tool(description = "Undo the most recent edit (linear history). Errors with NothingToUndo at the origin. \
                          Note: media imports sit OUTSIDE the undo stack — undoing past an import keeps the media in the pool.")]
    async fn undo(&self) -> Result<CallToolResult, McpError> {
        self.project
            .undo(agent_actor())
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Redo the next edit. Errors with NothingToRedo if no redo is available. \
                          A new commit truncates the redo tail.")]
    async fn redo(&self) -> Result<CallToolResult, McpError> {
        self.project
            .redo(agent_actor())
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Create an explicit named checkpoint of the current state. \
                          Checkpoints survive new commits (they don't get truncated like the redo tail) \
                          and persist in the .vproj save file. Returns the new checkpoint id.")]
    async fn checkpoint(
        &self,
        #[tool(aggr)] args: CheckpointArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = self.project.checkpoint(agent_actor(), args.label).await;
        Ok(ok_text(id.to_string()))
    }

    #[tool(description = "List all named checkpoints, oldest first. Returns id, label, actor, created_at \
                          per checkpoint (no project snapshot).")]
    async fn list_checkpoints(&self) -> Result<CallToolResult, McpError> {
        // Reuse history_view (limit doesn't affect the checkpoints field).
        let view = self.project.history_view(0).await;
        ok_json(&view.checkpoints)
    }

    #[tool(description = "Restore a named checkpoint. Records a new history entry — undo will return to the \
                          pre-restore state. Errors with CheckpointNotFound if the id doesn't exist.")]
    async fn restore_checkpoint(
        &self,
        #[tool(aggr)] args: RestoreCheckpointArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.checkpoint_id, "checkpoint_id")?;
        self.project
            .restore_checkpoint(agent_actor(), id)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }
}

// ============================================================
// Tool argument structs
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddTrackArgs {
    /// One of 'video', 'audio', 'subtitle' (case-insensitive).
    pub kind: String,
    /// Optional human-readable label.
    pub label: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RemoveTrackArgs {
    pub track_id: String,
    /// If true, deletes the track even if it has layers. Default false.
    pub force: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MoveTrackArgs {
    pub track_id: String,
    /// Target index in the tracks vector. Must be < current track count.
    pub new_position: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddColorLayerArgs {
    pub track_id: String,
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub color: Rgba,
    /// Defaults to composition width when omitted.
    pub width: Option<u32>,
    /// Defaults to composition height when omitted.
    pub height: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddVideoLayerArgs {
    pub track_id: String,
    pub media_id: String,
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub src_in_us: i64,
    pub src_out_us: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateLayerArgs {
    pub layer_id: String,
    pub patch: LayerPatch,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateLayerParamsArgs {
    pub layer_id: String,
    pub patch: LayerParamsPatch,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MoveLayerArgs {
    pub layer_id: String,
    pub new_track_id: String,
    pub new_t_start_us: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SplitLayerArgs {
    pub layer_id: String,
    pub at_t_us: i64,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SplitLayerResult {
    pub left: String,
    pub right: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LayerIdArgs {
    pub layer_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DuplicateLayerArgs {
    pub layer_id: String,
    pub t_offset_us: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetCompositionArgs {
    pub patch: CompositionPatch,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddMarkerArgs {
    pub t_us: i64,
    pub label: String,
    pub color: Rgba,
    /// Set to make this a region marker.
    pub end_t_us: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateMarkerArgs {
    pub marker_id: String,
    pub patch: MarkerPatch,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MarkerIdArgs {
    pub marker_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ImportMediaArgs {
    /// Absolute path to a video / audio / image / subtitle file the host can read.
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RemoveMediaArgs {
    pub media_id: String,
    /// If true, also deletes layers that reference this media. Default false.
    pub force: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CheckpointArgs {
    /// Human-readable label for the checkpoint.
    pub label: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RestoreCheckpointArgs {
    pub checkpoint_id: String,
}

// ============================================================
// Helpers
// ============================================================

/// Wrap a String in a `CallToolResult::success` with one text content block.
fn ok_text(s: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(s.into())])
}

/// Empty-content success — for void-returning tools where the agent just needs
/// the absence of an error.
fn ok_void() -> CallToolResult {
    CallToolResult::success(vec![])
}

/// JSON-encode any serializable value into a single text content block.
fn ok_json<T: Serialize>(v: &T) -> Result<CallToolResult, McpError> {
    Content::json(v).map(|c| CallToolResult::success(vec![c]))
}

/// Stamp every MCP-originated mutation with a stable Agent actor. The client
/// name is hardcoded to "mcp" until rmcp surfaces clientInfo from the
/// initialize handshake on the per-call context.
fn agent_actor() -> Actor {
    Actor::Agent {
        client: "mcp".to_string(),
    }
}

fn parse_uuid(s: &str, field: &str) -> Result<Uuid, McpError> {
    Uuid::parse_str(s)
        .map_err(|e| McpError::invalid_params(format!("{field} not a UUID: {e}"), None))
}

fn parse_track_kind(s: &str) -> Result<TrackKind, McpError> {
    match s.to_ascii_lowercase().as_str() {
        "video" => Ok(TrackKind::Video),
        "audio" => Ok(TrackKind::Audio),
        "subtitle" | "subtitles" => Ok(TrackKind::Subtitle),
        other => Err(McpError::invalid_params(
            format!("unknown track kind '{other}' (expected video|audio|subtitle)"),
            None,
        )),
    }
}

/// Map an actor `CommandError` to an MCP error. Validation failures with
/// agent-actionable alternatives (LayerOverlap) carry a structured `options[]`
/// list per the docs/mcp.md error model so the agent can pick a recovery
/// rather than bouncing off a brick wall.
fn map_command_error(e: CommandError) -> McpError {
    let message = e.to_string();
    let detail = match &e {
        CommandError::ValidationFailed(ValidationError::LayerOverlap {
            track,
            a,
            a_start,
            a_end,
            b: _,
            b_start,
            b_end,
        }) => Some(serde_json::json!({
            "error": "LayerOverlap",
            "track": track.to_string(),
            "blocking_layer": a.to_string(),
            "blocking_range_us": [*a_start, *a_end],
            "requested_range_us": [*b_start, *b_end],
            "options": [
                { "action": "create_new_track", "kind": "Video" },
                { "action": "trim_existing", "layer_id": a.to_string(), "new_t_end_us": *b_start },
                { "action": "split_at_t", "layer_id": a.to_string(), "at_t_us": *b_start }
            ]
        })),
        CommandError::MediaInUse {
            media,
            referenced_by,
        } => Some(serde_json::json!({
            "error": "MediaInUse",
            "media": media.to_string(),
            "referenced_by": referenced_by
                .iter()
                .map(|l| l.to_string())
                .collect::<Vec<_>>(),
            "options": [
                { "action": "force_remove", "note": "calls remove_media with force=true; cascades layer deletions" },
                { "action": "delete_layers_first", "layer_ids": referenced_by.iter().map(|l| l.to_string()).collect::<Vec<_>>() }
            ]
        })),
        _ => None,
    };
    match detail {
        Some(d) => McpError::invalid_params(message, Some(d)),
        None => McpError::invalid_params(message, None),
    }
}

#[tool(tool_box)]
impl ServerHandler for VidetorServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "Videtor exposes the open project as an MCP tool surface. \
                 Read-only resources cover the project state under `project://*`. \
                 Edit tools and change-feed events land in later Phase 4 stages."
                    .to_string(),
            ),
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
            ..Default::default()
        }
    }

    async fn list_resources(
        &self,
        _request: PaginatedRequestParam,
        _context: RequestContext<rmcp::RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let resources = STATIC_RESOURCES
            .iter()
            .map(|d| {
                RawResource {
                    uri: d.uri.to_string(),
                    name: d.name.to_string(),
                    description: Some(d.description.to_string()),
                    mime_type: Some(APP_JSON.to_string()),
                    size: None,
                }
                .no_annotation()
            })
            .collect();
        Ok(ListResourcesResult {
            resources,
            next_cursor: None,
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParam,
        _context: RequestContext<rmcp::RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        let snap = self.project.snapshot().await;
        let uri = request.uri.as_str();

        // media://* paths return binary content (image bytes, peaks file). We
        // peel them off here so the rest of `read_resource` can stay
        // text/JSON oriented.
        if let Some(tail) = uri.strip_prefix(PREFIX_MEDIA) {
            return self.read_media_resource(uri, tail, &snap).await;
        }

        let body: Value = match uri {
            URI_PROJECT => serde_json::to_value(&*snap).map_err(serialize_err)?,
            URI_COMPOSITION => serde_json::to_value(&snap.composition).map_err(serialize_err)?,
            URI_MEDIA => serde_json::to_value(&snap.media_pool).map_err(serialize_err)?,
            URI_TRACKS => serde_json::to_value(&snap.tracks).map_err(serialize_err)?,
            URI_MARKERS => serde_json::to_value(&snap.markers).map_err(serialize_err)?,
            URI_HISTORY => {
                let view = self.project.history_view(HISTORY_LIMIT).await;
                serde_json::to_value(&view).map_err(serialize_err)?
            }
            URI_COMPILED => {
                let target = RenderTarget::full(
                    snap.composition.width,
                    snap.composition.height,
                    Rational::new(snap.composition.fps.num, snap.composition.fps.den),
                    snap.composition.sample_rate,
                    snap.composition.channels,
                );
                match ir::lower(&snap, target) {
                    Ok(graph) => serde_json::to_value(&graph).map_err(serialize_err)?,
                    Err(e) => {
                        return Err(McpError::internal_error(
                            format!("compile project: {e}"),
                            None,
                        ));
                    }
                }
            }
            other if other.starts_with(PREFIX_LAYERS) => {
                let tail = &other[PREFIX_LAYERS.len()..];
                let (id_part, want_effects) = match tail.split_once('/') {
                    Some((id, "effects")) => (id, true),
                    Some((_, suffix)) => {
                        return Err(McpError::resource_not_found(
                            format!("unsupported layer sub-resource '{suffix}'"),
                            None,
                        ));
                    }
                    None => (tail, false),
                };
                let layer_id: LayerId = Uuid::parse_str(id_part).map_err(|_| {
                    McpError::resource_not_found(
                        format!("layer URI has invalid UUID: {id_part}"),
                        None,
                    )
                })?;
                let layer = snap
                    .tracks
                    .iter()
                    .flat_map(|t| t.layers.iter())
                    .find(|l| l.id == layer_id)
                    .ok_or_else(|| {
                        McpError::resource_not_found(
                            format!("layer {layer_id} not found"),
                            None,
                        )
                    })?;
                if want_effects {
                    // Effects deferred to Phase 4.x — see project_phase4_scope.md.
                    // The resource is reachable so agents can rely on the URI shape;
                    // it just always returns an empty array today.
                    serde_json::to_value(&layer.effects).map_err(serialize_err)?
                } else {
                    serde_json::to_value(layer).map_err(serialize_err)?
                }
            }
            other => {
                return Err(McpError::resource_not_found(
                    format!("unknown resource URI: {other}"),
                    None,
                ));
            }
        };

        let text = serde_json::to_string_pretty(&body).map_err(serialize_err)?;
        Ok(ReadResourceResult {
            contents: vec![ResourceContents::TextResourceContents {
                uri: uri.to_string(),
                mime_type: Some(APP_JSON.to_string()),
                text,
            }],
        })
    }
}

impl VidetorServer {
    /// Dispatch handler for `media://{id}/...` URIs. Returns binary content
    /// (image/jpeg, application/octet-stream) base64-encoded into rmcp's
    /// `BlobResourceContents.blob` field per the MCP spec.
    async fn read_media_resource(
        &self,
        uri: &str,
        tail: &str,
        snap: &crate::state::Project,
    ) -> Result<ReadResourceResult, McpError> {
        // tail = "{id}/thumbnail" | "{id}/frame/{t_us}" | "{id}/waveform"
        let (id_part, sub) = tail.split_once('/').ok_or_else(|| {
            McpError::resource_not_found(
                format!("media URI missing sub-path: {uri}"),
                None,
            )
        })?;
        let media_id: MediaId = Uuid::parse_str(id_part).map_err(|_| {
            McpError::resource_not_found(
                format!("media URI has invalid UUID: {id_part}"),
                None,
            )
        })?;
        let media = snap
            .media_pool
            .get(&media_id)
            .cloned()
            .ok_or_else(|| {
                McpError::resource_not_found(
                    format!("media {media_id} not found"),
                    None,
                )
            })?;

        if sub == "thumbnail" {
            self.serve_thumbnail(uri, &media).await
        } else if sub == "waveform" {
            self.serve_waveform(uri, &media).await
        } else if let Some(t_str) = sub.strip_prefix("frame/") {
            let t_us: i64 = t_str.parse().map_err(|_| {
                McpError::invalid_params(
                    format!("frame URI t_us not an integer: {t_str}"),
                    None,
                )
            })?;
            self.serve_frame(uri, &media, t_us).await
        } else {
            Err(McpError::resource_not_found(
                format!("unknown media sub-resource '{sub}'"),
                None,
            ))
        }
    }

    async fn serve_thumbnail(
        &self,
        uri: &str,
        media: &MediaItem,
    ) -> Result<ReadResourceResult, McpError> {
        // Pick the middle thumbnail (index 5) — agents asking for "show me
        // this clip" generally want a representative still, not the first
        // frame which is often a slate / black.
        const MID: usize = 5;
        let path = self.cache.thumbnail(&media.file_hash_blake3, MID);
        if !cached_ok(&path) {
            return Err(McpError::resource_not_found(
                format!(
                    "thumbnail not generated yet for media {} — wait for a media:job_complete event with kind=thumbnails, or read media://{}/frame/<t_us> for an on-demand extraction",
                    media.id, media.id,
                ),
                None,
            ));
        }
        blob_response(uri, &path, IMAGE_JPEG).await
    }

    async fn serve_frame(
        &self,
        uri: &str,
        media: &MediaItem,
        t_us: i64,
    ) -> Result<ReadResourceResult, McpError> {
        let path = jobs::extract_frame(&self.cache, media, t_us).await.map_err(
            |e| McpError::internal_error(format!("frame extract: {e:#}"), None),
        )?;
        blob_response(uri, &path, IMAGE_JPEG).await
    }

    async fn serve_waveform(
        &self,
        uri: &str,
        media: &MediaItem,
    ) -> Result<ReadResourceResult, McpError> {
        let path = self.cache.waveform(&media.file_hash_blake3);
        if !cached_ok(&path) {
            return Err(McpError::resource_not_found(
                format!(
                    "waveform not generated yet for media {} — wait for a media:job_complete event with kind=waveform",
                    media.id,
                ),
                None,
            ));
        }
        blob_response(uri, &path, APP_OCTET).await
    }
}

async fn blob_response(
    uri: &str,
    path: &std::path::Path,
    mime: &str,
) -> Result<ReadResourceResult, McpError> {
    use base64::Engine;
    let bytes = tokio::fs::read(path).await.map_err(|e| {
        McpError::internal_error(format!("read {}: {e}", path.display()), None)
    })?;
    let blob = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ReadResourceResult {
        contents: vec![ResourceContents::BlobResourceContents {
            uri: uri.to_string(),
            mime_type: Some(mime.to_string()),
            blob,
        }],
    })
}

struct ResourceDescriptor {
    uri: &'static str,
    name: &'static str,
    description: &'static str,
}

const STATIC_RESOURCES: &[ResourceDescriptor] = &[
    ResourceDescriptor {
        uri: URI_PROJECT,
        name: "Current project",
        description: "The full open Videtor project as JSON. Re-fetch after change events.",
    },
    ResourceDescriptor {
        uri: URI_COMPOSITION,
        name: "Composition",
        description: "Canvas size, fps, sample rate, color space, background.",
    },
    ResourceDescriptor {
        uri: URI_MEDIA,
        name: "Media pool",
        description: "All imported media items keyed by id.",
    },
    ResourceDescriptor {
        uri: URI_TRACKS,
        name: "Tracks",
        description: "Tracks with layer envelopes. Read project://layers/{id} for full layer detail.",
    },
    ResourceDescriptor {
        uri: URI_MARKERS,
        name: "Markers",
        description: "Timeline markers, sorted by t_us.",
    },
    ResourceDescriptor {
        uri: URI_HISTORY,
        name: "History",
        description: "Recent operations and named checkpoints (no snapshots).",
    },
    ResourceDescriptor {
        uri: URI_COMPILED,
        name: "Compiled IR",
        description: "Compiled IR graph for the current project — for agents that want structural reasoning.",
    },
];

fn serialize_err(e: serde_json::Error) -> McpError {
    McpError::internal_error(format!("serialize: {e}"), None)
}

pub async fn serve(
    project: ProjectHandle,
    cache: CacheLayout,
    app: AppHandle,
) -> Result<McpInfo> {
    let port = pick_free_port().context("pick free localhost port")?;
    let bind = SocketAddr::from(([127, 0, 0, 1], port));
    let bearer_token = random_token();

    let server = SseServer::serve(bind).await.context("start rmcp SSE server")?;
    // The cancellation token gates the spawned server task. We intentionally drop
    // it — the server keeps running for the app's lifetime; tearing it down is a
    // future concern when sessions get pinned/unpinned.
    let project_for_factory = project.clone();
    let cache_for_factory = cache.clone();
    let app_for_factory = app.clone();
    let _ct = server.with_service(move || {
        VidetorServer::new(
            project_for_factory.clone(),
            cache_for_factory.clone(),
            app_for_factory.clone(),
        )
    });

    let events_info = events::serve(project)
        .await
        .context("start change-feed events server")?;

    let info = McpInfo {
        bind,
        sse_url: format!("http://{bind}/sse"),
        message_url: format!("http://{bind}/message"),
        bearer_token,
        events_url: events_info.events_url,
    };

    info!(
        "MCP server listening — sse: {} message: {} events: {} bearer: {}",
        info.sse_url, info.message_url, info.events_url, info.bearer_token
    );
    Ok(info)
}

fn pick_free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Localhost-only spike token — entropy from monotonic-ish nanoseconds + process id
    // is enough to avoid trivial guessing on a single-user machine. Real auth swaps in
    // a CSPRNG-backed token and surfaces it through the keyring; gated on rmcp shipping
    // middleware support.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut seed = [0u8; 24];
    seed[..16].copy_from_slice(&nanos.to_le_bytes());
    seed[16..20].copy_from_slice(&std::process::id().to_le_bytes());
    seed[20..24].copy_from_slice(&fastrand_seed_from_addr().to_le_bytes());
    blake3::hash(&seed).to_hex().to_string()
}

fn fastrand_seed_from_addr() -> u32 {
    // Stack-address bits — varies across runs thanks to ASLR, no extra deps needed.
    let local = 0u8;
    (&local as *const u8 as usize) as u32
}
