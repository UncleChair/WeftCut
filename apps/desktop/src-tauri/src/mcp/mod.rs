//! MCP server: tool surface, resources, prompts, SSE change feed.
//!
//! Transport: SSE on `127.0.0.1:<auto-port>` via rmcp 0.1.x's `SseServer`.
//! Note that rmcp upstream has moved on (1.6.0, 2026-05-01) and dropped SSE
//! entirely in favor of Streamable HTTP. We're deliberately staying on 0.1.x
//! because Claude Desktop is SSE-only for local servers as of Anthropic's
//! 2026-05-03 statement; migrating to streamable-http would technically be
//! "spec-current" but would break the integration this app exists to serve.
//! Revisit when Claude Desktop ships streamable-http for local servers.
//!
//! Bearer token + auto-picked port are persisted to
//! `<app_config_dir>/mcp_auth.json` on first launch and reused on every
//! subsequent start, so the Claude Desktop / Cursor snippet stays valid
//! across restarts. If the saved port is occupied at bind time (another
//! WeftCut instance, port collision) the server falls back to a fresh
//! OS-picked port and rewrites the file.
//!
//! rmcp 0.1.x's `SseServer` exposes no middleware hook (only `serve` /
//! `serve_with_config` / `with_service` / `cancel` / `next_transport`), so
//! the token is generated and surfaced (UI panel + log) but **NOT enforced**
//! on incoming requests. Localhost-only binding is the real isolation on a
//! single-user machine; flipping to 0.0.0.0 needs proper enforcement first.
//! Enforcement paths considered (none active):
//! - rmcp 1.6.x with tower::Layer — blocked on Claude Desktop SSE-only.
//! - axum reverse-proxy in front of rmcp 0.1.x — feasible TODAY (would own
//!   the `/sse` GET stream + `/message` POST forwarding) but ~100-200 LoC
//!   with SSE-streaming risk; deferred until threat model justifies it.
//! When enforcement does land, migrate this file to the OS keyring
//! (`cloud/keys.rs` is the template — add a `Provider::McpBearer` variant).
//!
//! Resource surface (read-only):
//! - `project://current`     — full Project JSON
//! - `project://composition` — Composition only
//! - `project://media`       — media pool
//! - `project://tracks`      — tracks + layer envelopes
//! - `project://layers/{id}` — one Layer in detail
//! - `project://markers`     — markers
//! - `project://history`     — recent ops + checkpoints (snapshot-free)
//! - `project://compiled`    — compiled IRGraph (JSON)
//! - `media://{id}/thumbnail` — middle thumbnail JPG (base64 in
//!   BlobResourceContents). 404 with hint if generation hasn't completed yet.
//! - `media://{id}/frame/{t_us}` — on-demand frame extraction at the given
//!   microsecond timestamp, lazy-cached on disk. Multimodal-friendly.
//! - `media://{id}/waveform` — peaks file (base64). See `jobs/waveform.rs`
//!   for the binary format.
//! - `motifs://current` — full motif catalog (built-ins, installed, drafts;
//!   each entry carries status/content_hash/target_id?). Same payload as
//!   `list_motifs` (`html` stripped).
//!
//! Edit tools (Stage 3) and workflow tools (Stage 4) live alongside `ping`
//! in the `WeftCutServer` impl block. The change feed (Stage 5) lives on its
//! own axum-backed `/events` endpoint — see `events.rs`. Both servers spawn
//! from `serve(...)`.
//!
//! Design: `docs/mcp.md`.

mod events;
mod prompts;

use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rmcp::{
    Error as McpError, ServerHandler,
    model::{
        AnnotateAble, CallToolResult, Content, GetPromptRequestParam, GetPromptResult,
        ListPromptsResult, ListResourcesResult, PaginatedRequestParam, RawResource,
        ReadResourceRequestParam, ReadResourceResult, ResourceContents, ServerCapabilities,
        ServerInfo,
    },
    service::RequestContext,
    tool,
    transport::sse_server::SseServer,
};
use tauri::{AppHandle, Manager};
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
use crate::cloud;
use crate::motifs::catalog;
use crate::state::actor::LayerEdge;
use crate::state::{
    Actor, Animated, AudioParams, BlendMode, CheckpointId, ColorParams, CommandError,
    CompositionPatch, DryRunOp, DryRunOutput, LayerId, LayerParams, LayerParamsPatch, LayerPatch,
    MarkerPatch, MediaId, MediaItem, MediaKind, Project, ProjectHandle, Rational, Rgba,
    MotifParams, SubtitlesParams, SubtitlesSource, TrackId, Transform,
    ValidationError, VideoClipParams, new_id,
};

const URI_PROJECT: &str = "project://current";
const URI_COMPOSITION: &str = "project://composition";
const URI_MEDIA: &str = "project://media";
const URI_TRACKS: &str = "project://tracks";
const URI_MARKERS: &str = "project://markers";
const URI_HISTORY: &str = "project://history";
const URI_COMPILED: &str = "project://compiled";
const URI_MOTIFS: &str = "motifs://current";
const PREFIX_LAYERS: &str = "project://layers/";
const PREFIX_MEDIA: &str = "media://";

const HISTORY_LIMIT: usize = 100;

const APP_JSON: &str = "application/json";
const APP_OCTET: &str = "application/octet-stream";
const IMAGE_JPEG: &str = "image/jpeg";
const IMAGE_PNG: &str = "image/png";

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
pub struct WeftCutServer {
    project: ProjectHandle,
    cache: CacheLayout,
    app: AppHandle,
}

impl std::fmt::Debug for WeftCutServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WeftCutServer").finish_non_exhaustive()
    }
}

#[tool(tool_box)]
impl WeftCutServer {
    pub fn new(project: ProjectHandle, cache: CacheLayout, app: AppHandle) -> Self {
        Self {
            project,
            cache,
            app,
        }
    }

    /// The Motif catalog payload for the MCP surface (built-ins + installed +
    /// draft user Motifs, each with `status`/`content_hash`/`target_id`). Shares
    /// the Tauri picker's source (`commands::list_motifs_inner`) so the catalog
    /// can't drift, but STRIPS the per-entry `html` — the picker needs it for
    /// client-side rendering, agents don't (it would bloat their context; they
    /// fetch source on demand via `get_motif_source`).
    fn motifs_payload(&self) -> Vec<Value> {
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        crate::commands::list_motifs_inner(&store)
            .into_iter()
            .map(|mut entry| {
                if let Some(obj) = entry.as_object_mut() {
                    obj.remove("html");
                }
                entry
            })
            .collect()
    }

    #[tool(description = "Liveness check. Returns 'pong' to confirm the WeftCut MCP server is reachable.")]
    async fn ping(&self) -> String {
        "pong".to_string()
    }

    // ============================================================
    // Agent-mode session lifecycle
    // ============================================================
    //
    // `begin_agent_session(reason)` flips the human's UI into agent mode
    // — a simplified preview / scrub / record-only layout that lets the
    // user watch what the agent is doing without competing for the
    // timeline. The session carries a free-text `reason` so the human
    // sees WHY the agent took over (rendered as the panel header).
    //
    // Lifecycle (matches the design grilled out in `docs/mcp.md`):
    //   - Re-calling while a session is already active REPLACES it
    //     (last writer wins, fresh `reason` shown). Useful when the
    //     agent has finished one batch and is starting another.
    //   - End-of-session is one-way from the human's side (the
    //     `agent_session_end` Tauri command, fired by the Exit button).
    //     The agent does NOT have an `end_agent_session` tool — the
    //     human always exits.
    //   - Disconnect detection is best-effort: rmcp 0.1.x doesn't
    //     surface transport lifecycle, so a dropped SSE connection
    //     currently does NOT auto-end the session. The human can
    //     always exit via the UI button. Revisit when rmcp upgrade
    //     opens up middleware (see file-level note above).
    //
    // Auto-checkpoint: on every successful begin, we mint a
    // `History::checkpoint("Pre-agent: {reason}", Actor::Agent)` so the
    // human has a one-click "undo the whole agent session" lifeline.
    // The checkpoint id is returned to the agent in the tool response,
    // which the agent MAY use to `restore_checkpoint` if it wants to
    // backtrack its own work (Phase 3 of agent-mode plan).

    #[tool(description = "Enter agent mode: flip the human's UI to a simplified preview / scrub / \
                          record-only layout while the agent makes changes. `reason` is a short \
                          free-text label shown in the record panel header (e.g. 'cutting filler \
                          words'). Creates an automatic checkpoint named 'Pre-agent: {reason}' so \
                          the human can revert the entire session in one click. Calling this while \
                          already in agent mode replaces the session. The human exits via the UI; \
                          there is no end_agent_session tool.")]
    async fn begin_agent_session(
        &self,
        #[tool(aggr)] args: BeginAgentSessionArgs,
    ) -> Result<CallToolResult, McpError> {
        let reason = args.reason.trim();
        if reason.is_empty() {
            return Err(McpError::invalid_params(
                "reason must be non-empty",
                None,
            ));
        }
        let op_id = uuid::Uuid::now_v7();
        crate::logs::emit_via_app(
            &self.app,
            crate::logs::LogEntryInput {
                level: crate::logs::LogLevel::Info,
                category: crate::logs::LogCategory::Mcp,
                source: crate::logs::LogSource::Agent { client: "mcp".into() },
                message: format!("MCP: begin_agent_session started ({reason})"),
                op_id: Some(op_id),
                op_state: Some(crate::logs::OpState::Started),
                ..Default::default()
            },
        );

        // Auto-checkpoint BEFORE flipping the slot — wait, we actually
        // need started_at LOCKED first so the record-panel's filter
        // (`ts >= started_at`) catches the checkpoint LogEntry. The
        // history.checkpoint() call itself doesn't emit a LogEntry; we
        // emit one below with the same structured `details` shape the
        // `checkpoint` MCP tool uses, so the record panel renders this
        // as a normal pin-row at the top of the session.
        let started_at = Utc::now();
        let label = format!("Pre-agent: {reason}");
        let checkpoint_id = self
            .project
            .checkpoint(agent_actor(), label.clone())
            .await;
        crate::logs::emit_via_app(
            &self.app,
            crate::logs::LogEntryInput {
                level: crate::logs::LogLevel::Info,
                category: crate::logs::LogCategory::Project,
                source: crate::logs::LogSource::Agent { client: "mcp".into() },
                message: format!("Checkpoint: {label}"),
                details: Some(serde_json::json!({
                    "kind": "Checkpoint",
                    "id": checkpoint_id.to_string(),
                    "label": label,
                })),
                ..Default::default()
            },
        );


        let session = crate::agent_session::AgentSession {
            client: "mcp".into(),
            reason: reason.to_string(),
            started_at,
        };
        let slot = self
            .app
            .try_state::<crate::agent_session::AgentSessionSlot>()
            .ok_or_else(|| McpError::internal_error(
                "agent_session slot missing from Tauri state",
                None,
            ))?;
        let prior = crate::agent_session::begin_and_emit(
            &self.app,
            slot.inner(),
            session,
        );
        if let Some(prev) = prior {
            crate::logs::emit_via_app(
                &self.app,
                crate::logs::LogEntryInput {
                    level: crate::logs::LogLevel::Info,
                    category: crate::logs::LogCategory::System,
                    source: crate::logs::LogSource::System,
                    message: format!(
                        "Prior agent session displaced (client={} reason={})",
                        prev.client, prev.reason,
                    ),
                    ..Default::default()
                },
            );
        }

        crate::logs::emit_via_app(
            &self.app,
            crate::logs::LogEntryInput {
                level: crate::logs::LogLevel::Info,
                category: crate::logs::LogCategory::Mcp,
                source: crate::logs::LogSource::Agent { client: "mcp".into() },
                message: format!("MCP: begin_agent_session done (checkpoint={checkpoint_id})"),
                op_id: Some(op_id),
                op_state: Some(crate::logs::OpState::Ok),
                ..Default::default()
            },
        );

        ok_json(&serde_json::json!({
            "checkpoint_id": checkpoint_id.to_string(),
            "started_at": started_at.to_rfc3339(),
        }))
    }

    // ============================================================
    // Track tools
    // ============================================================

    #[tool(description = "Add a new track to the project. Returns the new track id as a UUID string. \
                          Tracks are kind-agnostic — any layer kind can be placed on any track.")]
    async fn add_track(
        &self,
        #[tool(aggr)] args: AddTrackArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = self
            .project
            .add_track(agent_actor(), args.label)
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
                          The two ranges should be the same length unless `speed` is later changed. \
                          When the source media has an audio stream and the project's \
                          `auto_pair_audio_on_import` setting is on (default), this also creates a \
                          paired Audio layer on an audio track at the same time bounds and groups the \
                          two so they move/trim/split together. Returns either the video layer id \
                          (legacy mode) or `{ video_layer_id, audio_layer_id, group_id }` when a pair \
                          was created.")]
    async fn add_video_layer(
        &self,
        #[tool(aggr)] args: AddVideoLayerArgs,
    ) -> Result<CallToolResult, McpError> {
        let track_id = parse_uuid(&args.track_id, "track_id")?;
        let media_id = parse_uuid(&args.media_id, "media_id")?;
        let snap = self.project.snapshot().await;
        let media_item = snap.media_pool.get(&media_id).cloned();
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
        let video_layer_id = self
            .project
            .add_layer(agent_actor(), track_id, params, args.t_start_us, args.t_end_us)
            .await
            .map_err(map_command_error)?;

        // `docs/groups.md` — pair + group when source has audio.
        let should_pair = snap.settings.auto_pair_audio_on_import
            && media_item
                .as_ref()
                .map(|m| m.metadata.audio.is_some())
                .unwrap_or(false);
        if should_pair {
            let audio_track = self.ensure_audio_track().await?;
            let audio_params = LayerParams::Audio(AudioParams {
                media: media_id,
                src_in_us: args.src_in_us,
                src_out_us: args.src_out_us,
                gain_db: Animated::Static(0.0),
                pan: Animated::Static(0.0),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
            });
            let audio_layer_id = self
                .project
                .add_layer(
                    agent_actor(),
                    audio_track,
                    audio_params,
                    args.t_start_us,
                    args.t_end_us,
                )
                .await
                .map_err(map_command_error)?;
            let group_id = self
                .project
                .groups_create(
                    agent_actor(),
                    vec![video_layer_id, audio_layer_id],
                    None,
                    false,
                )
                .await
                .map_err(map_command_error)?;
            return ok_json(&serde_json::json!({
                "video_layer_id": video_layer_id.to_string(),
                "audio_layer_id": audio_layer_id.to_string(),
                "group_id": group_id.to_string(),
            }));
        }
        Ok(ok_text(video_layer_id.to_string()))
    }

    #[tool(description = "Add a Subtitles layer that burns an inline SRT or ASS body onto the timeline. \
                          The body is stored in the project (so it round-trips through .vproj) and \
                          materialized to a content-addressed file in the OS app cache before render. \
                          `format` is 'srt' or 'ass'; if omitted it sniffs from the body. \
                          `track_id` is optional — if omitted, picks the first existing Subtitle track \
                          or creates one named 'Subtitles'. Returns the new layer id.")]
    async fn apply_subtitles(
        &self,
        #[tool(aggr)] args: ApplySubtitlesArgs,
    ) -> Result<CallToolResult, McpError> {
        if args.body.trim().is_empty() {
            return Err(McpError::invalid_params(
                "subtitles body is empty",
                None,
            ));
        }
        if args.t_end_us <= args.t_start_us.unwrap_or(0) {
            return Err(McpError::invalid_params(
                "t_end_us must be greater than t_start_us",
                None,
            ));
        }
        let format = match args.format.as_deref() {
            Some("srt") | Some("SRT") => SubFormat::Srt,
            Some("ass") | Some("ASS") => SubFormat::Ass,
            None => sniff_subtitle_format(&args.body),
            Some(other) => {
                return Err(McpError::invalid_params(
                    format!("unknown subtitle format '{other}' — expected 'srt' or 'ass'"),
                    None,
                ));
            }
        };
        let source = match format {
            SubFormat::Srt => SubtitlesSource::InlineSrt(args.body),
            SubFormat::Ass => SubtitlesSource::InlineAss(args.body),
        };
        let track_id = match args.track_id.as_deref() {
            Some(s) => parse_uuid(s, "track_id")?,
            None => self.ensure_subtitle_track().await?,
        };
        let params = LayerParams::Subtitles(SubtitlesParams { source });
        let id = self
            .project
            .add_layer(
                agent_actor(),
                track_id,
                params,
                args.t_start_us.unwrap_or(0),
                args.t_end_us,
            )
            .await
            .map_err(map_command_error)?;
        Ok(ok_text(id.to_string()))
    }

    #[tool(description = "Transcribe a VideoClip or Audio layer through the configured cloud transcription \
                          provider (OpenAI Whisper today) and return the SRT body with timestamps already \
                          shifted to timeline-absolute microseconds. Pipe the returned body straight into \
                          `apply_subtitles` (omit `t_start_us` so the layer activates from 0 — the cues \
                          self-position via their internal timestamps). Optional `t_start_us`/`t_end_us` \
                          narrow the transcription window inside the layer's time range; both default to \
                          the layer endpoints. VideoClip layers with speed != 1.0 are rejected — split off \
                          a speed-1 segment first. Errors with structured messages if no API key is \
                          configured, the audio slice exceeds the provider cap (~13 min for Whisper at \
                          25 MB), or the provider rate-limits / rejects auth.")]
    async fn transcribe_clip(
        &self,
        #[tool(aggr)] args: TranscribeClipArgs,
    ) -> Result<CallToolResult, McpError> {
        let log_op_id = uuid::Uuid::now_v7();
        let log_args = serde_json::to_value(&args).ok();
        crate::logs::emit_via_app(
            &self.app,
            crate::logs::LogEntryInput {
                level: crate::logs::LogLevel::Info,
                category: crate::logs::LogCategory::Mcp,
                source: crate::logs::LogSource::Agent { client: "mcp".into() },
                message: "MCP: transcribe_clip started".into(),
                op_id: Some(log_op_id),
                op_state: Some(crate::logs::OpState::Started),
                details: log_args,
                ..Default::default()
            },
        );
        let result = self.transcribe_clip_inner(args).await;
        match &result {
            Ok(_) => crate::logs::emit_via_app(
                &self.app,
                crate::logs::LogEntryInput {
                    level: crate::logs::LogLevel::Info,
                    category: crate::logs::LogCategory::Mcp,
                    source: crate::logs::LogSource::Agent { client: "mcp".into() },
                    message: "MCP: transcribe_clip done".into(),
                    op_id: Some(log_op_id),
                    op_state: Some(crate::logs::OpState::Ok),
                    ..Default::default()
                },
            ),
            Err(e) => crate::logs::emit_via_app(
                &self.app,
                crate::logs::LogEntryInput {
                    level: crate::logs::LogLevel::Error,
                    category: crate::logs::LogCategory::Mcp,
                    source: crate::logs::LogSource::Agent { client: "mcp".into() },
                    message: format!("MCP: transcribe_clip failed: {e}"),
                    op_id: Some(log_op_id),
                    op_state: Some(crate::logs::OpState::Err),
                    ..Default::default()
                },
            ),
        }
        result
    }

    /// Body of `transcribe_clip`; lifted out so the tool method itself
    /// can wrap it with log producer entries.
    async fn transcribe_clip_inner(
        &self,
        args: TranscribeClipArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        let snap = self.project.snapshot().await;
        let resolved = resolve_clip_audio_source(
            &snap,
            layer_id,
            args.t_start_us,
            args.t_end_us,
        )?;

        let transcriber = cloud::pick_transcriber().ok_or_else(|| {
            McpError::invalid_request(
                "no transcription provider configured — open Settings → API keys and add an OpenAI API key",
                None,
            )
        })?;

        let audio_path = cloud::audio_extract::extract_audio_window(
            &self.cache,
            &resolved.source_path,
            &resolved.source_hash,
            resolved.source_in_us,
            resolved.source_out_us,
        )
        .await
        .map_err(|e| McpError::internal_error(format!("audio extract: {e:#}"), None))?;

        let resp = transcriber
            .transcribe(cloud::TranscribeRequest {
                audio_path,
                language: args.language,
            })
            .await
            .map_err(map_cloud_error)?;

        let shifted = cloud::srt::shift_srt(&resp.srt_body, resolved.timeline_start_us);
        Ok(ok_text(shifted))
    }

    #[tool(description = "Find silent regions in a VideoClip or Audio layer using the pre-computed \
                          waveform. Walks the layer's peaks file (binary VPEAKS at 100 peaks/sec) and \
                          returns timeline-absolute ranges where every peak stays below `threshold_amp` \
                          for at least `min_silence_us` microseconds. Defaults: `threshold_amp=0.02` \
                          (-34 dBFS), `min_silence_us=500000` (0.5s). Use the returned ranges to feed \
                          `split_layer` + `delete_layer` and produce a tighter cut. \
                          Returns `[{ t_start_us, t_end_us }, ...]` sorted by t_start_us. Errors with \
                          `NotReady` if the waveform job hasn't finished yet — wait for a \
                          `media:job_complete` event with `kind=waveform` and retry.")]
    async fn detect_silences(
        &self,
        #[tool(aggr)] args: DetectSilencesArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        let snap = self.project.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .ok_or_else(|| {
                McpError::invalid_params(format!("layer {layer_id} not found"), None)
            })?;

        let media_id = match &layer.params {
            LayerParams::VideoClip(p) => p.media,
            LayerParams::Audio(p) => p.media,
            _ => {
                return Err(McpError::invalid_params(
                    format!(
                        "layer {layer_id} kind is not analyzable for silence — pass a VideoClip or Audio layer",
                    ),
                    None,
                ));
            }
        };
        let media = snap.media_pool.get(&media_id).ok_or_else(|| {
            McpError::invalid_params(
                format!("layer {layer_id} references missing media {media_id}"),
                None,
            )
        })?;
        let waveform_path = self.cache.waveform(&media.file_hash_blake3);
        if !cached_ok(&waveform_path) {
            return Err(McpError::invalid_request(
                format!(
                    "waveform not generated yet for media {media_id} — wait for a media:job_complete event with kind=waveform and retry",
                ),
                None,
            ));
        }

        let threshold_amp = args.threshold_amp.unwrap_or(0.02);
        let min_silence_us = args.min_silence_us.unwrap_or(500_000);
        if !(0.0..=1.0).contains(&threshold_amp) {
            return Err(McpError::invalid_params(
                format!("threshold_amp {threshold_amp} must be in [0.0, 1.0]"),
                None,
            ));
        }
        if min_silence_us <= 0 {
            return Err(McpError::invalid_params(
                format!("min_silence_us {min_silence_us} must be positive"),
                None,
            ));
        }

        let peaks = jobs::read_peaks_file(&waveform_path)
            .map_err(|e| McpError::internal_error(format!("read peaks: {e:#}"), None))?;

        // Map source-relative silence regions to timeline-absolute coords:
        //   timeline_t = layer.t_start_us + (source_t - layer.src_in_us)
        //   clipped to [layer.t_start_us, layer.t_end_us]
        let (src_in_us, src_out_us) = match &layer.params {
            LayerParams::VideoClip(p) => (p.src_in_us, p.src_out_us),
            LayerParams::Audio(p) => (p.src_in_us, p.src_out_us),
            _ => unreachable!("kind already checked above"),
        };
        let regions = detect_silences_in_peaks(
            &peaks,
            threshold_amp,
            min_silence_us,
            src_in_us,
            src_out_us,
            layer.t_start_us,
        );

        ok_json(&regions)
    }

    #[tool(description = "Synthesize speech via the configured cloud TTS provider (OpenAI tts-1 today) \
                          and attach the result as an Audio layer. The MP3 is content-addressed in cache \
                          by `(model, voice, speed, text)`, so a repeat call with the same args reuses \
                          the cached file without burning another API request. \
                          Args: `text` (≤4096 chars for tts-1), `voice` (one of alloy/echo/fable/onyx/nova/shimmer), \
                          optional `speed` (0.25..4.0; default = provider default ≈1.0), \
                          optional `target_track_id` (defaults to first existing Audio track or a new \
                          'Voiceover' track), optional `t_start_us` (defaults to the composition's \
                          current duration so the voiceover appends at the end). Returns \
                          `{ layer_id, media_id, t_start_us, t_end_us, cached }`.")]
    async fn synthesize_speech(
        &self,
        #[tool(aggr)] args: SynthesizeSpeechArgs,
    ) -> Result<CallToolResult, McpError> {
        if args.text.trim().is_empty() {
            return Err(McpError::invalid_params(
                "text is empty",
                None,
            ));
        }

        let synthesizer = cloud::pick_synthesizer().ok_or_else(|| {
            McpError::invalid_request(
                "no TTS provider configured — open Settings → API keys and add an OpenAI API key",
                None,
            )
        })?;

        let cache_key = cloud::providers::openai::tts_cache_key(
            &args.text,
            &args.voice,
            args.speed,
        );
        // Cache extension hardcoded as "mp3" because the only Stage 6 provider
        // (OpenAiTts) pins `response_format=mp3`. The `debug_assert!` below
        // trips in dev the first time a future provider returns a different
        // format and forces the format-extension-from-response fix here.
        // TODO(future-provider): pull extension from `resp.format` so cache
        // file naming matches provider output once a second TTS provider lands.
        let dest = self.cache.voiceover(&cache_key, "mp3");
        let cached = cached_ok(&dest);
        if !cached {
            let resp = synthesizer
                .synthesize(cloud::SynthesizeRequest {
                    text: args.text.clone(),
                    voice: args.voice.clone(),
                    speed: args.speed,
                })
                .await
                .map_err(map_cloud_error)?;
            debug_assert_eq!(
                resp.format,
                cloud::AudioFormat::Mp3,
                "Stage 6 v1 assumes mp3 output; update cache extension before adding non-mp3 providers",
            );
            write_voiceover_atomic(&dest, &resp.audio)
                .await
                .map_err(|e| {
                    McpError::internal_error(format!("write voiceover: {e:#}"), None)
                })?;
        }

        // Probe the (now-existing) file on a blocking thread to get duration.
        // ffprobe is required here — without duration we can't size the
        // Audio layer correctly.
        let probe_path = dest.clone();
        let cache_key_clone = cache_key.clone();
        let media_item = tokio::task::spawn_blocking(move || -> Result<MediaItem, String> {
            let metadata = probe::probe_metadata(&probe_path);
            if metadata.duration_us.is_none() {
                return Err(
                    "ffprobe could not determine duration of synthesized audio — \
                     install ffprobe (ships with ffmpeg) and retry"
                        .to_string(),
                );
            }
            let stat = std::fs::metadata(&probe_path)
                .map_err(|e| format!("stat voiceover: {e}"))?;
            Ok(MediaItem {
                id: new_id(),
                label: Some(format!("voiceover-{}", &cache_key_clone[..8])),
                path_abs: probe_path,
                path_rel: None,
                kind: MediaKind::Audio,
                metadata,
                proxy_path: None,

                proxy_format_version: 0,
                quick_proxy_path: None,
                proxy_bypassed: false,
                export_uses_original: false,
                waveform_path: None,
                conform_path: None,
                thumbnails_dir: None,
                file_hash_blake3: cache_key_clone,
                file_size: stat.len(),
                file_mtime: stat
                    .modified()
                    .ok()
                    .and_then(|t| {
                        t.duration_since(std::time::UNIX_EPOCH).ok()
                    })
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                imported_at: Utc::now(),
            })
        })
        .await
        .map_err(|e| McpError::internal_error(format!("probe join: {e}"), None))?
        .map_err(|e| McpError::internal_error(e, None))?;

        let duration_us = media_item.metadata.duration_us.unwrap_or(0);
        let media_item_for_jobs = media_item.clone();
        let media_id = self
            .project
            .add_media_item(agent_actor(), media_item)
            .await
            .map_err(map_command_error)?;
        // Fan out background jobs (waveform; thumbnails skip on audio-only).
        jobs::enqueue_for_media(
            self.app.clone(),
            self.cache.clone(),
            self.project.clone(),
            media_item_for_jobs,
        );

        let snap = self.project.snapshot().await;
        let t_start_us = args.t_start_us.unwrap_or(snap.composition.duration_us);
        let t_end_us = t_start_us + duration_us;

        let track_id = match args.target_track_id.as_deref() {
            Some(s) => parse_uuid(s, "target_track_id")?,
            None => self.ensure_audio_track().await?,
        };

        let params = LayerParams::Audio(AudioParams {
            media: media_id,
            src_in_us: 0,
            src_out_us: duration_us,
            gain_db: Animated::Static(0.0),
            pan: Animated::Static(0.0),
            fade_in_us: 0,
            fade_out_us: 0,
            mute: false,
        });
        let layer_id = self
            .project
            .add_layer(agent_actor(), track_id, params, t_start_us, t_end_us)
            .await
            .map_err(map_command_error)?;

        ok_json(&SynthesizeSpeechResult {
            layer_id: layer_id.to_string(),
            media_id: media_id.to_string(),
            t_start_us,
            t_end_us,
            cached,
        })
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
            .move_layer(
                agent_actor(),
                layer_id,
                new_track_id,
                args.new_t_start_us,
                args.escape_group.unwrap_or(false),
            )
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
            .split_layer(
                agent_actor(),
                id,
                args.at_t_us,
                args.escape_group.unwrap_or(false),
            )
            .await
            .map_err(map_command_error)?;
        ok_json(&SplitLayerResult {
            left: left.to_string(),
            right: right.to_string(),
        })
    }

    #[tool(description = "Delete a layer. When the project setting `auto_delete_empty_tracks` is on \
                          (default) and this empties a non-reserved, unlocked track, the track is \
                          deleted in the same history entry (one undo restores both). A/B-roll and \
                          other role-stamped tracks always stay.")]
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

    #[tool(description = "Trim one edge of a layer's timeline range. `edge` is 'in' (t_start) or 'out' (t_end). \
                          For media-bearing layers the corresponding src bound (src_in_us or src_out_us) moves \
                          by the same delta; over-trimming past the source bound is clamped. \
                          When the layer is in a group and `escape_group` is false (default), every group \
                          member whose corresponding edge sits at the same t as the trimmed edge is moved \
                          by the same delta, clamped to the tightest aligned member's bounds. Pass \
                          `escape_group=true` to trim only this layer. See `docs/groups.md`.")]
    async fn trim_layer(
        &self,
        #[tool(aggr)] args: TrimLayerArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.layer_id, "layer_id")?;
        let edge = parse_layer_edge(&args.edge)?;
        self.project
            .trim_layer(
                agent_actor(),
                id,
                edge,
                args.new_t_us,
                args.escape_group.unwrap_or(false),
            )
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    // ============================================================
    // Group tools (Phase G.4 — `docs/groups.md`)
    // ============================================================

    #[tool(description = "List every group in the project. Each entry has `id`, optional `label`, and the \
                          set of member `layer_ids`. Empty array when no groups exist. Membership is flat — \
                          a layer is in at most one group.")]
    async fn groups_list(&self) -> Result<CallToolResult, McpError> {
        let snap = self.project.snapshot().await;
        let payload: Vec<_> = snap
            .groups
            .iter()
            .map(|g| GroupView {
                id: g.id.to_string(),
                label: g.label.clone(),
                layer_ids: g.members.iter().map(|m| m.to_string()).collect(),
            })
            .collect();
        ok_json(&payload)
    }

    #[tool(description = "Read a single group by id. Returns `{ id, label, layer_ids }` or NotFound.")]
    async fn groups_get(
        &self,
        #[tool(aggr)] args: GroupIdArgs,
    ) -> Result<CallToolResult, McpError> {
        let gid = parse_uuid(&args.group_id, "group_id")?;
        let snap = self.project.snapshot().await;
        let g = snap
            .groups
            .iter()
            .find(|g| g.id == gid)
            .ok_or_else(|| McpError::invalid_params(format!("group {gid} not found"), None))?;
        ok_json(&GroupView {
            id: g.id.to_string(),
            label: g.label.clone(),
            layer_ids: g.members.iter().map(|m| m.to_string()).collect(),
        })
    }

    #[tool(description = "Create a new group from >=2 distinct layer ids. Optional `label`. \
                          If any layer is already in another group, the op fails unless `reassign=true`, \
                          which removes them from their prior group(s) first (auto-dissolving any group \
                          that falls below 2 members). Returns the new group id.")]
    async fn groups_create(
        &self,
        #[tool(aggr)] args: GroupsCreateArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_ids: Vec<LayerId> = args
            .layer_ids
            .iter()
            .map(|s| parse_uuid(s, "layer_id"))
            .collect::<Result<_, _>>()?;
        let gid = self
            .project
            .groups_create(
                agent_actor(),
                layer_ids,
                args.label,
                args.reassign.unwrap_or(false),
            )
            .await
            .map_err(map_command_error)?;
        Ok(ok_text(gid.to_string()))
    }

    #[tool(description = "Dissolve (delete) a group. The member layers themselves are not deleted.")]
    async fn groups_dissolve(
        &self,
        #[tool(aggr)] args: GroupIdArgs,
    ) -> Result<CallToolResult, McpError> {
        let gid = parse_uuid(&args.group_id, "group_id")?;
        self.project
            .groups_dissolve(agent_actor(), gid)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Add member layers to an existing group. Same reassign semantics as groups_create.")]
    async fn groups_add_members(
        &self,
        #[tool(aggr)] args: GroupsAddMembersArgs,
    ) -> Result<CallToolResult, McpError> {
        let gid = parse_uuid(&args.group_id, "group_id")?;
        let layer_ids: Vec<LayerId> = args
            .layer_ids
            .iter()
            .map(|s| parse_uuid(s, "layer_id"))
            .collect::<Result<_, _>>()?;
        self.project
            .groups_add_members(
                agent_actor(),
                gid,
                layer_ids,
                args.reassign.unwrap_or(false),
            )
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Remove member layers from a group. If the remaining membership falls below 2, \
                          the group auto-dissolves.")]
    async fn groups_remove_members(
        &self,
        #[tool(aggr)] args: GroupsRemoveMembersArgs,
    ) -> Result<CallToolResult, McpError> {
        let gid = parse_uuid(&args.group_id, "group_id")?;
        let layer_ids: Vec<LayerId> = args
            .layer_ids
            .iter()
            .map(|s| parse_uuid(s, "layer_id"))
            .collect::<Result<_, _>>()?;
        self.project
            .groups_remove_members(agent_actor(), gid, layer_ids)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    #[tool(description = "Update a group's label. Pass `label: null` to clear it.")]
    async fn groups_rename(
        &self,
        #[tool(aggr)] args: GroupsRenameArgs,
    ) -> Result<CallToolResult, McpError> {
        let gid = parse_uuid(&args.group_id, "group_id")?;
        self.project
            .groups_rename(agent_actor(), gid, args.label)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    // groups_set_effects / layers_set_effects MCP tools removed in P12-a.
    // Effects aren't routed by the Pixi renderer in v1, so the agent-facing
    // surface for them is gone. P12-b deletes the underlying Layer.effects /
    // Group.effects fields together with the IR visual half.

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
    // Motif tools (Phase 5 Stage H)
    // ============================================================

    #[tool(description = "List every motif available to add via `add_motif` — built-ins PLUS installed and \
                          draft user motifs. Returns an array of `{ id, name, version, size: [w,h], \
                          default_duration_s, props_schema, status, content_hash, target_id? }` where \
                          `status` is `builtin` | `installed` | `draft`. Inspect `props_schema` before \
                          `add_motif` to know what keys + types each motif accepts; unknown keys reject. \
                          Drafts (status `draft`) are placeable immediately for preview.")]
    async fn list_motifs(&self) -> Result<CallToolResult, McpError> {
        ok_json(&self.motifs_payload())
    }

    #[tool(description = "Read a Motif's source { manifest, html } — any built-in, installed, or draft. \
                          Read this before editing so you can base your changes on the current source. \
                          `id` comes from `list_motifs`.")]
    async fn get_motif_source(
        &self,
        #[tool(aggr)] args: MotifIdArgs,
    ) -> Result<CallToolResult, McpError> {
        if let Some(m) = catalog::builtins().into_iter().find(|m| m.id() == args.id) {
            return ok_json(&serde_json::json!({ "manifest": m.manifest, "html": m.html }));
        }
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        let m = store.get_motif(&args.id).ok_or_else(|| {
            McpError::invalid_params(format!("unknown motif id '{}'", args.id), None)
        })?;
        ok_json(&serde_json::json!({ "manifest": m.manifest, "html": m.html }))
    }

    #[tool(description = "Write a Motif draft from { manifest, html }. Returns the draft id. The draft is \
                          placeable immediately (via `add_motif`) for preview, and re-writable. `from` \
                          (optional) records an existing Motif id as the draft's UPDATE target so a later \
                          `install_motif {mode:'update'}` republishes over it; omit `from` for a brand-new \
                          Motif (installs as new). The manifest's `id`/`version` are ignored — app-assigned. \
                          Expose tweakable controls via `props_schema`.")]
    async fn write_motif_draft(
        &self,
        #[tool(aggr)] args: WriteMotifDraftArgs,
    ) -> Result<CallToolResult, McpError> {
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        let manifest: crate::motifs::catalog::Manifest = serde_json::from_value(args.manifest)
            .map_err(|e| McpError::invalid_params(format!("invalid manifest: {e}"), None))?;
        let id = crate::motifs::authoring_commands::write_motif_draft_core(
            &store,
            manifest,
            &args.html,
            args.from.as_deref(),
        )
        .map_err(|e| McpError::invalid_params(e, None))?;
        crate::motifs::authoring_commands::emit_motifs_changed(&self.app);
        Ok(ok_text(id))
    }

    #[tool(description = "Render one frame of a Motif (draft / installed / built-in) and return it as a \
                          base64-encoded PNG, so you can SEE your output and self-correct. Args: `id`, \
                          `t_sec` (content time), optional `width`/`height` (default = the motif's size), \
                          optional `props`. Requires the app's preview runtime to be live; returns an error \
                          (rather than hanging) if it isn't ready.")]
    async fn preview_motif_draft(
        &self,
        #[tool(aggr)] args: PreviewMotifDraftArgs,
    ) -> Result<CallToolResult, McpError> {
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        let motif = catalog::builtins()
            .into_iter()
            .find(|m| m.id() == args.id)
            .or_else(|| store.get_motif(&args.id))
            .ok_or_else(|| {
                McpError::invalid_params(format!("unknown motif id '{}'", args.id), None)
            })?;
        let (dw, dh) = motif.size();
        let width = args.width.unwrap_or(dw);
        let height = args.height.unwrap_or(dh);
        let provided = args
            .props
            .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
        let props_json = motif
            .canonicalize_props(&provided)
            .map_err(|e| McpError::invalid_params(format!("invalid props: {e}"), None))?;
        let content_hash = motif.content_hash();
        let runtime = self.app.state::<crate::motifs::MotifRuntime>();
        let capture = self.app.state::<crate::motifs::MotifCapture>();
        let b64 = crate::motifs::commands::capture_motif_frame_b64(
            &self.app,
            &runtime,
            &capture,
            &store,
            &args.id,
            args.t_sec,
            &props_json,
            width,
            height,
            None, // settle_rafs: the Rust Manifest has none (TS-only); use the capture default
            &content_hash,
        )
        .await
        .map_err(|e| McpError::internal_error(e, None))?;
        ok_json(&serde_json::json!({ "png_base64": b64, "width": width, "height": height }))
    }

    #[tool(description = "Install a draft. mode 'new' publishes under the draft's own id; 'update' \
                          republishes over the draft's recorded UPDATE target (set via `write_motif_draft`'s \
                          `from`) — bumping its version so every placement re-renders, and rebinding + \
                          migrating current-project layers. Returns the published id.")]
    async fn install_motif(
        &self,
        #[tool(aggr)] args: InstallMotifArgs,
    ) -> Result<CallToolResult, McpError> {
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        let mode = match args.mode.as_str() {
            "new" => crate::motifs::authoring_commands::InstallMode::New,
            "update" => {
                let target = store.read_draft_target(&args.draft_id).ok_or_else(|| {
                    McpError::invalid_params(
                        format!(
                            "draft '{}' has no UPDATE target — install with mode 'new', or write it with `from`",
                            args.draft_id
                        ),
                        None,
                    )
                })?;
                crate::motifs::authoring_commands::InstallMode::Update { target_id: target }
            }
            other => {
                return Err(McpError::invalid_params(
                    format!("mode must be 'new' or 'update', got '{other}'"),
                    None,
                ))
            }
        };
        let install_args = crate::motifs::authoring_commands::InstallArgs {
            draft_id: args.draft_id,
            mode,
        };
        let published = crate::motifs::authoring_commands::install_motif_core(
            &store,
            &self.project,
            &install_args,
        )
        .await
        .map_err(|e| McpError::internal_error(e, None))?;
        crate::motifs::authoring_commands::emit_motifs_changed(&self.app);
        Ok(ok_text(published))
    }

    #[tool(description = "Delete an installed or draft user Motif by id. Built-ins are rejected. Placed \
                          layers referencing it degrade to an error placeholder.")]
    async fn delete_motif(
        &self,
        #[tool(aggr)] args: MotifIdArgs,
    ) -> Result<CallToolResult, McpError> {
        if catalog::BUILTIN_IDS.contains(&args.id.as_str()) {
            return Err(McpError::invalid_params(
                format!("cannot delete the built-in Motif '{}'", args.id),
                None,
            ));
        }
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        store
            .delete_user_motif(&args.id)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        crate::motifs::authoring_commands::emit_motifs_changed(&self.app);
        Ok(ok_void())
    }

    #[tool(description = "Add a motif layer to a track. The motif is rasterized to a PNG sequence on \
                          first render and cached content-addressably; subsequent renders are folder lookups. \
                          Args: `motif_id` (from `list_motifs`), `t_start_us` (timeline microseconds), \
                          optional `t_end_us` (defaults to `t_start_us + default_duration_s * 1e6`), optional \
                          `track_id` (when omitted, always spawns a fresh track labeled 'Overlay' — never \
                          reuses an existing track, so consecutive auto-inserts can't collide), optional \
                          `props` (JSON object matched against the motif's `props_schema`; unknown keys \
                          reject, missing keys fall back to defaults). Returns the new layer id.")]
    async fn add_motif(
        &self,
        #[tool(aggr)] args: AddMotifArgs,
    ) -> Result<CallToolResult, McpError> {
        let store = self.app.state::<crate::motifs::store::UserMotifStore>();
        let motif = catalog::builtins()
            .into_iter()
            .find(|t| t.id() == args.motif_id)
            .or_else(|| store.get_motif(&args.motif_id))
            .ok_or_else(|| {
                McpError::invalid_params(
                    format!(
                        "unknown motif_id '{}' — call list_motifs for the catalog",
                        args.motif_id
                    ),
                    None,
                )
            })?;

        let provided = args
            .props
            .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
        let canonical = motif
            .canonicalize_props(&provided)
            .map_err(|e| McpError::invalid_params(format!("invalid props: {e}"), None))?;
        let props_map = parse_canonical_props(&canonical)?;

        let t_end_us = resolve_motif_t_end_us(
            args.t_start_us,
            args.t_end_us,
            motif.manifest.default_duration_s,
            // Cap is driven by the props being added (canonicalized above), so
            // a `max_duration_prop`-mapped motif clamps to its prop value.
            catalog::resolve_motif_max_dur_us(&motif.manifest, &props_map),
        );
        if t_end_us <= args.t_start_us {
            return Err(McpError::invalid_params(
                format!(
                    "t_end_us {} must be greater than t_start_us {}",
                    t_end_us, args.t_start_us,
                ),
                None,
            ));
        }

        let track_id = match args.track_id.as_deref() {
            Some(s) => parse_uuid(s, "track_id")?,
            None => self.ensure_motif_target_track().await?,
        };

        let params = LayerParams::Motif(MotifParams {
            motif_id: motif.id().to_string(),
            motif_version: motif.manifest.version,
            props: props_map,
            src_in_us: 0,
            transform: Transform::default(),
            opacity: Animated::Static(1.0),
        });

        let layer_id = self
            .project
            .add_layer(
                agent_actor(),
                track_id,
                params,
                args.t_start_us,
                t_end_us,
            )
            .await
            .map_err(map_command_error)?;

        Ok(ok_text(layer_id.to_string()))
    }

    // ============================================================
    // Composition tools
    // ============================================================

    #[tool(description = "Update composition envelope (canvas size, fps, sample rate, channels, color space, background, duration). \
                          Only fields you set are applied. Width/height must be positive; fps denominator must be non-zero. \
                          Setting `duration_us` pins the composition duration — subsequent layer edits will no longer \
                          auto-fit it (except an overflow guard if a layer extends past the pinned value). Use \
                          `fit_composition_to_layers` to clear the pin and snap duration back to the layer high-water mark.")]
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

    #[tool(description = "Clear the composition's duration pin and set `duration_us` to `max(layer.t_end_us)`. \
                          The inverse of `set_composition { duration_us }`: that pins, this unpins. After this \
                          call, subsequent layer edits track duration in both directions (grow on adds, shrink \
                          on deletes/inward trims).")]
    async fn fit_composition_to_layers(
        &self,
    ) -> Result<CallToolResult, McpError> {
        self.project
            .fit_composition_to_layers(agent_actor())
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

                proxy_format_version: 0,
                quick_proxy_path: None,
                proxy_bypassed: false,
                export_uses_original: false,
                waveform_path: None,
                conform_path: None,
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
                          Only timeline edits (layers, tracks, markers, transitions, composition duration, and \
                          cascade-deleting media removals) record onto the undo stack. The following sit OUTSIDE it \
                          and are unaffected by undo: media imports and removals of unreferenced media, canvas \
                          setup changes (width/height/fps/sample_rate/channels/color_space/background), and \
                          loading or creating a project (which resets history).")]
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

    // ============================================================
    // History lock
    // ============================================================
    //
    // The lock blocks every revert path — undo, redo, restore_checkpoint
    // — while the agent is mid-batch. The user's "Exit to editor" button
    // is never affected (release happens in the Tauri command); the
    // human can always escape agent mode. Lock auto-releases on
    // workspace change (History::reset wipes it).

    #[tool(description = "Block the user from reverting (undo / redo / restore_checkpoint) while \
                          the agent is mid-batch. `reason` is shown next to the lock badge in the \
                          record-panel header and as the error returned to revert attempts. \
                          Last-writer-wins. Always pair with an unlock_history call; releases \
                          also happen on workspace change and on user-side agent-mode exit.")]
    async fn lock_history(
        &self,
        #[tool(aggr)] args: LockHistoryArgs,
    ) -> Result<CallToolResult, McpError> {
        let reason = args.reason.trim();
        if reason.is_empty() {
            return Err(McpError::invalid_params(
                "reason must be non-empty",
                None,
            ));
        }
        self.project.lock_history(reason.to_string()).await;
        crate::logs::emit_via_app(
            &self.app,
            crate::logs::LogEntryInput {
                level: crate::logs::LogLevel::Info,
                category: crate::logs::LogCategory::Mcp,
                source: crate::logs::LogSource::Agent { client: "mcp".into() },
                message: format!("History locked: {reason}"),
                ..Default::default()
            },
        );
        Ok(ok_void())
    }

    #[tool(description = "Release the revert-lock taken by lock_history. Idempotent — calling \
                          while already unlocked is a no-op.")]
    async fn unlock_history(&self) -> Result<CallToolResult, McpError> {
        self.project.unlock_history().await;
        crate::logs::emit_via_app(
            &self.app,
            crate::logs::LogEntryInput {
                level: crate::logs::LogLevel::Info,
                category: crate::logs::LogCategory::Mcp,
                source: crate::logs::LogSource::Agent { client: "mcp".into() },
                message: "History unlocked".into(),
                ..Default::default()
            },
        );
        Ok(ok_void())
    }

    #[tool(description = "Create an explicit named checkpoint of the current state. \
                          Checkpoints survive new commits (they don't get truncated like the redo tail) \
                          and persist in the .vproj save file. Returns the new checkpoint id. \
                          The human's agent-mode record panel renders each created checkpoint as a \
                          pin-style row with a Restore button — use this at logical batch boundaries.")]
    async fn checkpoint(
        &self,
        #[tool(aggr)] args: CheckpointArgs,
    ) -> Result<CallToolResult, McpError> {
        let label = args.label.trim();
        if label.is_empty() {
            return Err(McpError::invalid_params(
                "label must be non-empty",
                None,
            ));
        }
        let id: CheckpointId = self
            .project
            .checkpoint(agent_actor(), label.to_string())
            .await;
        // Structured `details` so the agent-mode record panel can render
        // checkpoint rows distinctly from regular tool-call rows. The
        // raw `History::checkpoint` write doesn't produce a ChangeEvent
        // today; this LogEntry is the sole signal the record panel has.
        crate::logs::emit_via_app(
            &self.app,
            crate::logs::LogEntryInput {
                level: crate::logs::LogLevel::Info,
                category: crate::logs::LogCategory::Project,
                source: crate::logs::LogSource::Agent { client: "mcp".into() },
                message: format!("Checkpoint: {label}"),
                details: Some(serde_json::json!({
                    "kind": "Checkpoint",
                    "id": id.to_string(),
                    "label": label,
                })),
                ..Default::default()
            },
        );
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
                          pre-restore state. Errors with CheckpointNotFound if the id doesn't exist. \
                          The agent-mode record panel prunes the rolled-back agent actions from view; \
                          a small '↩ Restored to <label>' row marks the boundary.")]
    async fn restore_checkpoint(
        &self,
        #[tool(aggr)] args: RestoreCheckpointArgs,
    ) -> Result<CallToolResult, McpError> {
        let id = parse_uuid(&args.checkpoint_id, "checkpoint_id")?;
        let label = self
            .project
            .list_checkpoints()
            .await
            .into_iter()
            .find(|c| c.id == id)
            .map(|c| c.label);
        self.project
            .restore_checkpoint(agent_actor(), id)
            .await
            .map_err(map_command_error)?;
        crate::logs::emit_via_app(
            &self.app,
            crate::logs::LogEntryInput {
                level: crate::logs::LogLevel::Info,
                category: crate::logs::LogCategory::Project,
                source: crate::logs::LogSource::Agent { client: "mcp".into() },
                message: match &label {
                    Some(l) => format!("Restored to checkpoint: {l}"),
                    None => format!("Restored to checkpoint: {id}"),
                },
                details: Some(serde_json::json!({
                    "kind": "Restore",
                    "checkpoint_id": id.to_string(),
                    "label": label,
                })),
                ..Default::default()
            },
        );
        Ok(ok_void())
    }

    // ============================================================
    // Dry run (Phase 4.x last gap)
    // ============================================================

    #[tool(description = "Try-run a sequence of edit operations against a clone of the current project \
                          WITHOUT committing. Useful for previewing complex multi-step edits — agents \
                          can detect overlap / invariant violations before mutating real state. \
                          Validates after each op (matching real `commit()` behaviour) and HALTS at \
                          the first error so subsequent ops don't dry-run against a state real \
                          execution wouldn't reach. Returns `{ results: [{ index, status, output? \
                          | error? }, ...] }`. \
                          Supports add_color_layer, add_video_layer, update_layer, \
                          update_layer_params, move_layer, split_layer, delete_layer. Other tools \
                          (motifs, subtitles, media import, undo/redo) are not dry-runnable in v1.")]
    async fn dry_run(
        &self,
        #[tool(aggr)] args: DryRunArgs,
    ) -> Result<CallToolResult, McpError> {
        // Parse the MCP OperationSpec list into the actor's DryRunOp values
        // (string UUIDs → TrackId/LayerId/MediaId at this boundary).
        let mut ops = Vec::with_capacity(args.operations.len());
        for (idx, spec) in args.operations.into_iter().enumerate() {
            let op = spec_to_op(spec).map_err(|e| {
                McpError::invalid_params(
                    format!("operations[{idx}]: {e}"),
                    None,
                )
            })?;
            ops.push(op);
        }
        let results = self.project.dry_run(ops).await;
        ok_json(&DryRunResponse::from_results(results))
    }
}

// ============================================================
// Tool argument structs
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BeginAgentSessionArgs {
    /// Short free-text label shown in the human's record-panel header
    /// while the session is active. Examples: "cutting filler words",
    /// "applying transcribe + auto-cut pass". Required, non-empty.
    pub reason: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LockHistoryArgs {
    /// Short free-text label shown to the user while the lock is held
    /// ("applying transitions", "rendering preview", etc.). Required.
    pub reason: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddTrackArgs {
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
pub struct ApplySubtitlesArgs {
    /// Subtitle document body (SRT or ASS).
    pub body: String,
    /// 'srt' or 'ass'. Sniffed from body when omitted.
    pub format: Option<String>,
    /// Target Subtitle track id. If omitted, the first existing Subtitle
    /// track is used, or a new one is created.
    pub track_id: Option<String>,
    /// Layer start in timeline microseconds. Defaults to 0.
    pub t_start_us: Option<i64>,
    /// Layer end in timeline microseconds. Required.
    pub t_end_us: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DetectSilencesArgs {
    /// Target VideoClip or Audio layer id.
    pub layer_id: String,
    /// Peak amplitude threshold in [0.0, 1.0]. Anything strictly below this
    /// counts as silence. Default 0.02 (≈ -34 dBFS).
    pub threshold_amp: Option<f32>,
    /// Minimum contiguous silence duration (microseconds) to surface.
    /// Default 500000 (0.5 seconds).
    pub min_silence_us: Option<i64>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SilenceRegion {
    pub t_start_us: i64,
    pub t_end_us: i64,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct TranscribeClipArgs {
    /// Target VideoClip or Audio layer id.
    pub layer_id: String,
    /// Optional transcription window start in timeline microseconds.
    /// Defaults to the layer's `t_start_us`. Must lie within the layer.
    pub t_start_us: Option<i64>,
    /// Optional transcription window end in timeline microseconds.
    /// Defaults to the layer's `t_end_us`. Must lie within the layer.
    pub t_end_us: Option<i64>,
    /// Optional ISO-639-1 language hint (`"en"`, `"zh"`). Auto-detect when omitted.
    pub language: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SynthesizeSpeechArgs {
    /// Text to synthesize. tts-1 caps at 4096 characters.
    pub text: String,
    /// Voice identifier. tts-1 accepts: alloy, echo, fable, onyx, nova, shimmer.
    pub voice: String,
    /// 0.25..4.0 for tts-1. Omit to use the provider default (~1.0).
    pub speed: Option<f32>,
    /// Optional Audio track id. If omitted, lands on the first existing Audio
    /// track or auto-creates one labeled "Voiceover".
    pub target_track_id: Option<String>,
    /// Optional timeline start in microseconds. Defaults to the composition's
    /// current `duration_us` so the voiceover appends at the end.
    pub t_start_us: Option<i64>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SynthesizeSpeechResult {
    pub layer_id: String,
    pub media_id: String,
    pub t_start_us: i64,
    pub t_end_us: i64,
    /// True when the result came from the content-addressed cache and no API
    /// call was made. Surfaced so the agent knows whether to expect any
    /// provider-side billing.
    pub cached: bool,
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
    /// `docs/groups.md` — when the moved layer is in a group and
    /// `escape_group` is `false` or omitted, every group member shifts in
    /// time by the same delta. Pass `true` to move only this layer.
    #[serde(default)]
    pub escape_group: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SplitLayerArgs {
    pub layer_id: String,
    pub at_t_us: i64,
    /// `docs/groups.md` — when the split layer is in a group and
    /// `escape_group` is `false` or omitted, every group member spanning
    /// `at_t_us` is also split there (all halves stay in the same group).
    /// Pass `true` to split only this layer.
    #[serde(default)]
    pub escape_group: Option<bool>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct SplitLayerResult {
    pub left: String,
    pub right: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TrimLayerArgs {
    pub layer_id: String,
    /// Either `"in"` (t_start) or `"out"` (t_end). Case-insensitive.
    pub edge: String,
    pub new_t_us: i64,
    /// `docs/groups.md` — when the trimmed layer is in a group and
    /// `escape_group` is false or omitted, aligned-edge coupling fans the
    /// trim out to other members whose corresponding edge sits at the same
    /// time. Pass `true` to trim only this layer.
    #[serde(default)]
    pub escape_group: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GroupIdArgs {
    pub group_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GroupsCreateArgs {
    pub layer_ids: Vec<String>,
    #[serde(default)]
    pub label: Option<String>,
    /// When any layer is already in another group, `reassign=true` removes
    /// it from its prior group first (auto-dissolving if needed). When
    /// false or omitted, the op rejects with `LayerAlreadyGrouped`.
    #[serde(default)]
    pub reassign: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GroupsAddMembersArgs {
    pub group_id: String,
    pub layer_ids: Vec<String>,
    #[serde(default)]
    pub reassign: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GroupsRemoveMembersArgs {
    pub group_id: String,
    pub layer_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GroupsRenameArgs {
    pub group_id: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct GroupView {
    pub id: String,
    pub label: Option<String>,
    pub layer_ids: Vec<String>,
}

// GroupsSetEffectsArgs / LayersSetEffectsArgs removed in P12-a — see
// the tool-handler comment higher up in this file for the rationale.

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
pub struct AddMotifArgs {
    /// Motif id from `list_motifs` (e.g. "lower-third-simple", "title-card").
    pub motif_id: String,
    /// Layer start in timeline microseconds.
    pub t_start_us: i64,
    /// Layer end in timeline microseconds. Defaults to
    /// `t_start_us + default_duration_s * 1_000_000` when omitted.
    pub t_end_us: Option<i64>,
    /// Target Video track id. If omitted, the first existing Video track is used,
    /// or a new one labeled "Motifs" is created.
    pub track_id: Option<String>,
    /// Motif props as a JSON object. Keys must match the motif's
    /// `props_schema`; unknown keys reject; missing keys fill from defaults.
    pub props: Option<Value>,
}

/// Shared single-id arg for `get_motif_source` + `delete_motif`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotifIdArgs {
    /// The Motif id (from `list_motifs`).
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WriteMotifDraftArgs {
    /// Optional id of an existing Motif this draft will UPDATE on install (records
    /// it as the draft's target). Omit for a brand-new Motif (installs as new).
    pub from: Option<String>,
    /// The manifest as a JSON object (its `id`/`version` are ignored — app-assigned).
    /// Shape: `{ name, size:[w,h], default_duration_s, props_schema, ... }` — inspect
    /// a built-in via `get_motif_source` for an exact example. Rejected if malformed.
    pub manifest: Value,
    /// The HTML body. The manifest island is injected by the app; a
    /// `<script>motif.define({...})</script>` drives the render.
    pub html: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct InstallMotifArgs {
    /// The draft id (from `write_motif_draft`).
    pub draft_id: String,
    /// "new" (publish under the draft's own id) or "update" (republish over the
    /// draft's recorded target; fails if the draft has no target).
    pub mode: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PreviewMotifDraftArgs {
    /// Motif id (draft / installed / built-in).
    pub id: String,
    /// Content time in seconds to render (e.g. 0 = first frame).
    pub t_sec: f64,
    /// Optional render width (default = the motif's manifest width).
    pub width: Option<u32>,
    /// Optional render height (default = the motif's manifest height).
    pub height: Option<u32>,
    /// Optional props (JSON object); defaults to the manifest defaults.
    pub props: Option<Value>,
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
// dry_run argument shape
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DryRunArgs {
    /// Operations to apply in order against a CLONE of current project state.
    /// First error halts the chain. Each op uses string UUIDs at the MCP
    /// boundary; the actor parses them server-side.
    pub operations: Vec<OperationSpec>,
}

/// Tagged-union mirror of the small set of mutation MCP tools that can be
/// dry-run safely. Variants stay flat (no nested action/payload split) so
/// the JSON shape is `{"kind": "add_color_layer", "track_id": ..., ...}`.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OperationSpec {
    /// Equivalent to the `add_color_layer` tool.
    AddColorLayer {
        track_id: String,
        t_start_us: i64,
        t_end_us: i64,
        color: Rgba,
        width: Option<u32>,
        height: Option<u32>,
    },
    /// Equivalent to the `add_video_layer` tool.
    AddVideoLayer {
        track_id: String,
        media_id: String,
        t_start_us: i64,
        t_end_us: i64,
        src_in_us: i64,
        src_out_us: i64,
    },
    /// Equivalent to the `update_layer` tool — envelope only (label / time
    /// range / enabled / locked).
    UpdateLayer {
        layer_id: String,
        patch: LayerPatch,
    },
    /// Equivalent to `update_layer_params` — kind-specific params.
    UpdateLayerParams {
        layer_id: String,
        patch: LayerParamsPatch,
    },
    /// Equivalent to `move_layer`.
    MoveLayer {
        layer_id: String,
        new_track_id: String,
        new_t_start_us: i64,
        #[serde(default)]
        escape_group: Option<bool>,
    },
    /// Equivalent to `split_layer`.
    SplitLayer {
        layer_id: String,
        at_t_us: i64,
        #[serde(default)]
        escape_group: Option<bool>,
    },
    /// Equivalent to `delete_layer`.
    DeleteLayer {
        layer_id: String,
    },
}

/// Top-level shape returned by the `dry_run` tool. Halt-on-first-error
/// means `results.len()` may be less than the requested op count; the index
/// on each entry identifies which input op it corresponds to.
#[derive(Debug, Serialize)]
struct DryRunResponse {
    results: Vec<DryRunResultEntry>,
    /// Index of the op that errored (causing the halt), or `null` when the
    /// entire chain succeeded.
    halted_at: Option<usize>,
}

#[derive(Debug, Serialize)]
struct DryRunResultEntry {
    index: usize,
    #[serde(flatten)]
    outcome: DryRunResultOutcome,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum DryRunResultOutcome {
    Ok { output: DryRunOutput },
    Error { error: String },
}

impl DryRunResponse {
    fn from_results(results: Vec<Result<DryRunOutput, CommandError>>) -> Self {
        let mut halted_at: Option<usize> = None;
        let entries = results
            .into_iter()
            .enumerate()
            .map(|(index, r)| {
                let outcome = match r {
                    Ok(o) => DryRunResultOutcome::Ok { output: o },
                    Err(e) => {
                        if halted_at.is_none() {
                            halted_at = Some(index);
                        }
                        DryRunResultOutcome::Error { error: e.to_string() }
                    }
                };
                DryRunResultEntry { index, outcome }
            })
            .collect();
        Self { results: entries, halted_at }
    }
}

/// Translate an MCP-side `OperationSpec` (string UUIDs, agent-friendly
/// args) into the actor's `DryRunOp`. Errors propagate as the per-op
/// invalid-params reason in the dispatcher.
fn spec_to_op(spec: OperationSpec) -> Result<DryRunOp, String> {
    match spec {
        OperationSpec::AddColorLayer {
            track_id,
            t_start_us,
            t_end_us,
            color,
            width,
            height,
        } => {
            let track = Uuid::parse_str(&track_id)
                .map_err(|e| format!("track_id: {e}"))?;
            let params = LayerParams::Color(ColorParams {
                color: Animated::Static(color),
                width: width.unwrap_or(1920),
                height: height.unwrap_or(1080),
            });
            Ok(DryRunOp::AddLayer { track_id: track, params, t_start_us, t_end_us })
        }
        OperationSpec::AddVideoLayer {
            track_id,
            media_id,
            t_start_us,
            t_end_us,
            src_in_us,
            src_out_us,
        } => {
            let track = Uuid::parse_str(&track_id)
                .map_err(|e| format!("track_id: {e}"))?;
            let media = Uuid::parse_str(&media_id)
                .map_err(|e| format!("media_id: {e}"))?;
            let params = LayerParams::VideoClip(VideoClipParams {
                media,
                src_in_us,
                src_out_us,
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
            Ok(DryRunOp::AddLayer { track_id: track, params, t_start_us, t_end_us })
        }
        OperationSpec::UpdateLayer { layer_id, patch } => {
            let id = Uuid::parse_str(&layer_id)
                .map_err(|e| format!("layer_id: {e}"))?;
            Ok(DryRunOp::UpdateLayer { id, patch })
        }
        OperationSpec::UpdateLayerParams { layer_id, patch } => {
            let id = Uuid::parse_str(&layer_id)
                .map_err(|e| format!("layer_id: {e}"))?;
            Ok(DryRunOp::UpdateLayerParams { id, patch })
        }
        OperationSpec::MoveLayer {
            layer_id,
            new_track_id,
            new_t_start_us,
            escape_group,
        } => {
            let id = Uuid::parse_str(&layer_id)
                .map_err(|e| format!("layer_id: {e}"))?;
            let new_track = Uuid::parse_str(&new_track_id)
                .map_err(|e| format!("new_track_id: {e}"))?;
            Ok(DryRunOp::MoveLayer {
                id,
                new_track_id: new_track,
                new_t_start_us,
                escape_group: escape_group.unwrap_or(false),
            })
        }
        OperationSpec::SplitLayer {
            layer_id,
            at_t_us,
            escape_group,
        } => {
            let id = Uuid::parse_str(&layer_id)
                .map_err(|e| format!("layer_id: {e}"))?;
            Ok(DryRunOp::SplitLayer {
                id,
                at_t_us,
                escape_group: escape_group.unwrap_or(false),
            })
        }
        OperationSpec::DeleteLayer { layer_id } => {
            let id = Uuid::parse_str(&layer_id)
                .map_err(|e| format!("layer_id: {e}"))?;
            Ok(DryRunOp::DeleteLayer { id })
        }
    }
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

/// Convert the canonical JSON string produced by `Motif::canonicalize_props`
/// back into the `imbl::HashMap<String, Value>` shape that `MotifParams`
/// stores. Canonicalize already validated types + filled defaults; this is
/// just the format crossover.
fn parse_canonical_props(
    canonical_json: &str,
) -> Result<imbl::HashMap<String, Value>, McpError> {
    let parsed: Value = serde_json::from_str(canonical_json).map_err(|e| {
        McpError::internal_error(format!("canonical props parse: {e}"), None)
    })?;
    let obj = parsed.as_object().ok_or_else(|| {
        McpError::internal_error("canonical props is not a JSON object", None)
    })?;
    Ok(obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// Compute the layer's end time for `add_motif`. When the agent omits
/// `t_end_us` we extend by the motif's `default_duration_s`; otherwise we
/// pass the value through unchanged so the caller controls duration.
/// `saturating_add` guards the i64 overflow on absurd inputs (e.g. agent
/// passes `i64::MAX` as start time + a default duration).
///
/// `max_duration_us` is the motif's `max_duration_s` cap (in µs) or
/// `None` when unbounded. When present, the resolved length is clamped to
/// the cap so an explicit over-long `t_end_us` can't place the layer longer
/// than the manifest allows — mirrors the trim-time clamp in the actor.
pub(crate) fn resolve_motif_t_end_us(
    t_start_us: i64,
    t_end_us: Option<i64>,
    default_duration_s: f64,
    max_duration_us: Option<i64>,
) -> i64 {
    let end = match t_end_us {
        Some(end) => end,
        None => {
            let duration_us = (default_duration_s * 1_000_000.0) as i64;
            t_start_us.saturating_add(duration_us)
        }
    };
    match max_duration_us {
        Some(cap) if end - t_start_us > cap => t_start_us.saturating_add(cap),
        _ => end,
    }
}

fn parse_layer_edge(s: &str) -> Result<LayerEdge, McpError> {
    match s.to_ascii_lowercase().as_str() {
        "in" | "start" | "t_start" | "t_start_us" => Ok(LayerEdge::In),
        "out" | "end" | "t_end" | "t_end_us" => Ok(LayerEdge::Out),
        other => Err(McpError::invalid_params(
            format!("unknown layer edge '{other}' (expected 'in' or 'out')"),
            None,
        )),
    }
}

#[derive(Debug, Clone, Copy)]
enum SubFormat {
    Srt,
    Ass,
}

/// Best-effort SRT/ASS sniffer. ASS scripts begin with the `[Script Info]`
/// section header (even minimal SSA files); SRT cues begin with a digit
/// (cue index 1). When neither pattern matches we default to SRT — Whisper's
/// `response_format=srt` is the common case.
fn sniff_subtitle_format(body: &str) -> SubFormat {
    let trimmed = body.trim_start_matches('\u{feff}').trim_start();
    if trimmed.starts_with('[') || trimmed.to_ascii_lowercase().starts_with("[script info]") {
        SubFormat::Ass
    } else {
        SubFormat::Srt
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

/// Resolved source-audio coordinates for a `transcribe_clip` call.
#[derive(Debug)]
struct ResolvedAudioSource {
    source_path: std::path::PathBuf,
    source_hash: String,
    /// Source-relative microseconds: where to start the ffmpeg slice.
    source_in_us: i64,
    /// Source-relative microseconds: where to end the ffmpeg slice.
    source_out_us: i64,
    /// Timeline-absolute microseconds of the slice's start — what we shift
    /// the SRT cue timestamps by so they land on the timeline.
    timeline_start_us: i64,
}

/// Find a layer with audio attached (VideoClip or Audio), validate the
/// requested timeline window lies inside it, and map that window onto the
/// source media's coordinate space.
fn resolve_clip_audio_source(
    snap: &Project,
    layer_id: LayerId,
    t_start_arg: Option<i64>,
    t_end_arg: Option<i64>,
) -> Result<ResolvedAudioSource, McpError> {
    let layer = snap
        .tracks
        .iter()
        .flat_map(|t| t.layers.iter())
        .find(|l| l.id == layer_id)
        .ok_or_else(|| {
            McpError::invalid_params(
                format!("layer {layer_id} not found"),
                None,
            )
        })?;

    let (media_id, src_in_us, src_out_us) = match &layer.params {
        LayerParams::VideoClip(VideoClipParams {
            media,
            src_in_us,
            src_out_us,
            speed,
            ..
        }) => {
            // Speed != 1 changes the timeline↔source ratio. Until the
            // clip-edit path supports variable speed end-to-end, refuse
            // rather than silently transcribe the wrong audio span and
            // misalign cues on the timeline. Mirrors the split_layer
            // precedent ("source offsets adjusted at speed=1").
            if (*speed - 1.0).abs() > f64::EPSILON {
                return Err(McpError::invalid_params(
                    format!(
                        "transcribe_clip does not yet support speed != 1.0 (layer speed={speed}); \
                         split off a speed-1 segment first",
                    ),
                    None,
                ));
            }
            (*media, *src_in_us, *src_out_us)
        }
        LayerParams::Audio(AudioParams { media, src_in_us, src_out_us, .. }) => {
            (*media, *src_in_us, *src_out_us)
        }
        _ => {
            return Err(McpError::invalid_params(
                format!(
                    "layer {layer_id} kind is not transcribable — pass a VideoClip or Audio layer",
                ),
                None,
            ));
        }
    };

    let media = snap.media_pool.get(&media_id).ok_or_else(|| {
        McpError::invalid_params(
            format!(
                "layer {layer_id} references missing media {media_id} (project state is inconsistent)",
            ),
            None,
        )
    })?;
    if media.metadata.audio.is_none() {
        return Err(McpError::invalid_params(
            format!(
                "media {media_id} has no audio stream — transcription needs audio",
            ),
            None,
        ));
    }

    let t_start = t_start_arg.unwrap_or(layer.t_start_us);
    let t_end = t_end_arg.unwrap_or(layer.t_end_us);
    if t_end <= t_start {
        return Err(McpError::invalid_params(
            format!(
                "transcription window must have positive duration (t_start_us={t_start}, t_end_us={t_end})",
            ),
            None,
        ));
    }
    if t_start < layer.t_start_us || t_end > layer.t_end_us {
        return Err(McpError::invalid_params(
            format!(
                "transcription window [{t_start}, {t_end}] is outside layer range [{}, {}]",
                layer.t_start_us, layer.t_end_us,
            ),
            None,
        ));
    }

    // Map timeline-relative offset within the layer onto source-relative
    // microseconds. Speed != 1 is not yet supported for the clip-edit path
    // (see VideoClipParams::speed comment); transcription warns rather than
    // silently producing misaligned cues.
    let offset_in = t_start - layer.t_start_us;
    let offset_out = t_end - layer.t_start_us;
    let source_in = src_in_us + offset_in;
    let source_out = src_in_us + offset_out;
    if source_out > src_out_us {
        return Err(McpError::invalid_params(
            format!(
                "transcription window maps past the layer's source range (source_out={source_out} > src_out_us={src_out_us})",
            ),
            None,
        ));
    }

    Ok(ResolvedAudioSource {
        source_path: media.path_abs.clone(),
        source_hash: media.file_hash_blake3.clone(),
        source_in_us: source_in,
        source_out_us: source_out,
        timeline_start_us: t_start,
    })
}

/// Scan a peaks array (one f32 magnitude per ~10ms window, from
/// `jobs::waveform::SAMPLES_PER_PEAK`) and return timeline-absolute silence
/// ranges. Splits the peaks into segments where every value is strictly
/// below `threshold_amp` and total duration ≥ `min_silence_us`.
///
/// Coord math: peak index `i` covers source-relative window
/// `[i, i+1) * us_per_peak`, where `us_per_peak = 1_000_000 /
/// PEAKS_PER_SECOND`. Map to timeline via `t_us = layer.t_start_us +
/// (source_us - src_in_us)` and clip to `[layer.t_start_us, layer.t_end_us)`
/// using `src_in_us..src_out_us` as the source window.
fn detect_silences_in_peaks(
    peaks: &[f32],
    threshold_amp: f32,
    min_silence_us: i64,
    src_in_us: i64,
    src_out_us: i64,
    layer_t_start_us: i64,
) -> Vec<SilenceRegion> {
    let us_per_peak: i64 = 1_000_000 / crate::jobs::waveform::PEAKS_PER_SECOND as i64;
    let mut regions = Vec::new();
    let mut run_start: Option<usize> = None;
    for (i, &p) in peaks.iter().enumerate() {
        let silent = p < threshold_amp;
        match (silent, run_start) {
            (true, None) => run_start = Some(i),
            (false, Some(start)) => {
                push_if_long_enough(
                    &mut regions,
                    start,
                    i,
                    us_per_peak,
                    min_silence_us,
                    src_in_us,
                    src_out_us,
                    layer_t_start_us,
                );
                run_start = None;
            }
            _ => {}
        }
    }
    if let Some(start) = run_start {
        push_if_long_enough(
            &mut regions,
            start,
            peaks.len(),
            us_per_peak,
            min_silence_us,
            src_in_us,
            src_out_us,
            layer_t_start_us,
        );
    }
    regions
}

#[allow(clippy::too_many_arguments)]
fn push_if_long_enough(
    out: &mut Vec<SilenceRegion>,
    start_idx: usize,
    end_idx: usize, // exclusive
    us_per_peak: i64,
    min_silence_us: i64,
    src_in_us: i64,
    src_out_us: i64,
    layer_t_start_us: i64,
) {
    let src_silence_start = start_idx as i64 * us_per_peak;
    let src_silence_end = end_idx as i64 * us_per_peak;
    // Intersect with the layer's source window — peaks beyond src_out_us
    // belong to media the layer doesn't reference.
    let src_start = src_silence_start.max(src_in_us);
    let src_end = src_silence_end.min(src_out_us);
    if src_end - src_start < min_silence_us {
        return;
    }
    let t_start = layer_t_start_us + (src_start - src_in_us);
    let t_end = layer_t_start_us + (src_end - src_in_us);
    out.push(SilenceRegion {
        t_start_us: t_start,
        t_end_us: t_end,
    });
}

/// Write synthesized audio bytes atomically to the cache. Mirrors the
/// `<dest>.tmp → promote_temp` pattern from the jobs module so an interrupted
/// write never leaves a zero-byte file that `cached_ok` would happily skip.
async fn write_voiceover_atomic(
    dest: &std::path::Path,
    bytes: &[u8],
) -> Result<(), anyhow::Error> {
    use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path};
    use anyhow::Context;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("ensure {}", parent.display()))?;
    }
    let tmp = temp_path(dest);
    let _ = tokio::fs::remove_file(&tmp).await;
    tokio::fs::write(&tmp, bytes)
        .await
        .with_context(|| format!("write {}", tmp.display()))?;
    if !cached_ok(&tmp) {
        discard_temp(dest);
        anyhow::bail!("synthesized audio is empty after write");
    }
    promote_temp(dest)?;
    Ok(())
}

/// Map a `cloud::CloudError` to an `McpError` so the agent sees a structured
/// failure (missing key, invalid key, rate-limited, too-large payload) with
/// actionable recovery steps in the message.
fn map_cloud_error(e: cloud::CloudError) -> McpError {
    use cloud::CloudError as E;
    let message = e.to_string();
    match e {
        E::MissingKey { .. } | E::InvalidKey { .. } => {
            McpError::invalid_request(message, None)
        }
        E::PayloadTooLarge { .. } => McpError::invalid_params(message, None),
        E::RateLimited { .. } | E::Provider { .. } | E::Network(_) => {
            McpError::internal_error(message, None)
        }
        E::Io(_) | E::AudioExtract(_) => McpError::internal_error(message, None),
    }
}

#[tool(tool_box)]
impl ServerHandler for WeftCutServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "WeftCut exposes the open project as an MCP tool surface. \
                 Read-only resources cover the project state under `project://*`. \
                 Edit tools and change-feed events land in later Phase 4 stages."
                    .to_string(),
            ),
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_prompts()
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

    async fn list_prompts(
        &self,
        _request: PaginatedRequestParam,
        _context: RequestContext<rmcp::RoleServer>,
    ) -> Result<ListPromptsResult, McpError> {
        Ok(ListPromptsResult {
            prompts: prompts::catalog(),
            next_cursor: None,
        })
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParam,
        _context: RequestContext<rmcp::RoleServer>,
    ) -> Result<GetPromptResult, McpError> {
        prompts::expand(&request.name, request.arguments.as_ref())
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
            URI_MOTIFS => {
                serde_json::to_value(self.motifs_payload()).map_err(serialize_err)?
            }
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
                let id_part = match tail.split_once('/') {
                    Some((_, suffix)) => {
                        return Err(McpError::resource_not_found(
                            format!("unsupported layer sub-resource '{suffix}'"),
                            None,
                        ));
                    }
                    None => tail,
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
                serde_json::to_value(layer).map_err(serialize_err)?
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

impl WeftCutServer {
    /// Find an existing Subtitle track or create one labeled "Subtitles".
    /// Mirrors `commands::ensure_subtitle_track` so the apply_subtitles MCP
    /// V.5: tracks are kind-agnostic. Subtitle layers land on the
    /// topmost track (last index) which by convention holds overlays.
    /// Creates a new track if zero exist.
    async fn ensure_subtitle_track(&self) -> Result<TrackId, McpError> {
        let snap = self.project.snapshot().await;
        if let Some(t) = snap.tracks.last() {
            return Ok(t.id);
        }
        self.project
            .add_track(agent_actor(), Some("Overlay".into()))
            .await
            .map_err(map_command_error)
    }

    /// V.5: tracks are kind-agnostic. The MCP `synthesize_speech`
    /// caller asks for a default audio target — under v2 we pick the
    /// topmost track (overlay slot by convention) or spawn one named
    /// "Voiceover" if none exists.
    async fn ensure_audio_track(&self) -> Result<TrackId, McpError> {
        let snap = self.project.snapshot().await;
        if let Some(t) = snap.tracks.last() {
            return Ok(t.id);
        }
        self.project
            .add_track(agent_actor(), Some("Voiceover".into()))
            .await
            .map_err(map_command_error)
    }

    /// Every auto-routed Motif insert gets its own fresh "Overlay"
    /// track. Reusing one would re-trip the per-track no-overlap
    /// invariant the moment two Motifs land on intersecting ranges.
    /// Agents that want stacking should pass an explicit `track_id`.
    async fn ensure_motif_target_track(&self) -> Result<TrackId, McpError> {
        self.project
            .add_track(agent_actor(), Some("Overlay".into()))
            .await
            .map_err(map_command_error)
    }

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
        description: "The full open WeftCut project as JSON. Re-fetch after change events.",
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
    ResourceDescriptor {
        uri: URI_MOTIFS,
        name: "Motifs catalog",
        description: "Full motif catalog as JSON (built-ins, installed, drafts; html stripped). \
                      Same shape as the `list_motifs` tool result. Read once at session start \
                      to know what `add_motif` accepts; use authoring tools to create drafts.",
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
    let auth_path = auth_file_path(&app);
    let mut auth = match load_auth(&auth_path) {
        Some(a) => a,
        None => McpAuth {
            bearer_token: random_token(),
            port: pick_free_port().context("pick free localhost port")?,
        },
    };

    // Try the saved/picked port first. If it's now occupied (another WeftCut
    // instance, another process grabbed it) fall back to a freshly picked
    // port and rewrite the file so the next launch lands on the new one.
    let mut bind = SocketAddr::from(([127, 0, 0, 1], auth.port));
    let server = match SseServer::serve(bind).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                "mcp bind on saved port {} failed ({e:#}); picking fresh port",
                auth.port
            );
            let new_port = pick_free_port().context("pick free localhost port")?;
            bind = SocketAddr::from(([127, 0, 0, 1], new_port));
            auth.port = new_port;
            SseServer::serve(bind).await.context("start rmcp SSE server")?
        }
    };

    // Best-effort persistence — failure means next launch regenerates, which
    // is the pre-persistence behaviour, not a reason to fail server startup.
    if let Err(e) = save_auth(&auth_path, &auth) {
        tracing::warn!("persist mcp auth to {}: {e:#}", auth_path.display());
    }
    let bearer_token = auth.bearer_token;
    // The cancellation token gates the spawned server task. We intentionally drop
    // it — the server keeps running for the app's lifetime; tearing it down is a
    // future concern when sessions get pinned/unpinned.
    let project_for_factory = project.clone();
    let cache_for_factory = cache.clone();
    let app_for_factory = app.clone();
    let _ct = server.with_service(move || {
        WeftCutServer::new(
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
    crate::logs::emit_via_app(
        &app,
        crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Info,
            category: crate::logs::LogCategory::Mcp,
            source: crate::logs::LogSource::System,
            message: format!("MCP server listening on {bind}"),
            details: Some(serde_json::json!({
                "sse_url": info.sse_url,
                "events_url": info.events_url,
            })),
            ..Default::default()
        },
    );
    Ok(info)
}

/// Generate a fresh bearer token, swap it into the live `McpInfoCell`, and
/// persist it to `mcp_auth.json`. Port stays bound to the same socket — only
/// the token changes. Returns the new token so callers can echo it back to
/// the UI without a second read.
///
/// Once rmcp ships middleware and we start enforcing the bearer, this is the
/// hook that kicks every connected agent (their saved header goes stale).
/// Today it's a UX action that keeps the Connect-agent snippet current.
pub fn regenerate_token(app: &AppHandle, cell: &McpInfoCell) -> Result<String> {
    regenerate_token_at(&auth_file_path(app), cell)
}

/// Path-injected core of `regenerate_token` — same semantics, but takes the
/// auth-file path directly so tests don't need a live `AppHandle`.
fn regenerate_token_at(auth_path: &Path, cell: &McpInfoCell) -> Result<String> {
    let new_token = random_token();

    let mut guard = cell
        .write()
        .map_err(|_| anyhow::anyhow!("mcp info cell poisoned"))?;
    let info = guard
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("mcp server not ready"))?;
    info.bearer_token = new_token.clone();
    let port = info.bind.port();
    drop(guard);

    let auth = McpAuth {
        bearer_token: new_token.clone(),
        port,
    };
    save_auth(auth_path, &auth).context("persist regenerated mcp auth")?;

    info!("mcp bearer token regenerated");
    Ok(new_token)
}

fn pick_free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Persisted bearer + port so the Connect-agent snippet survives restarts.
/// Lives at `<app_config_dir>/mcp_auth.json`. Plain file (not OS keyring)
/// because the token isn't enforced yet — see module doc.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct McpAuth {
    bearer_token: String,
    port: u16,
}

const AUTH_FILE: &str = "mcp_auth.json";

fn auth_file_path(app: &AppHandle) -> PathBuf {
    // Falls back to a sibling of the working dir when Tauri can't resolve a
    // platform config dir (sandboxed CI, headless tests). Same shape as the
    // cache_dir fallback in `lib.rs`.
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("./config"))
        .join(AUTH_FILE)
}

fn load_auth(path: &Path) -> Option<McpAuth> {
    let bytes = fs::read(path).ok()?;
    let auth: McpAuth = serde_json::from_slice(&bytes).ok()?;
    // Drop obviously-broken state so we regenerate instead of looping on a
    // bad file (manual edit, partial write, schema drift).
    if auth.bearer_token.is_empty() || auth.port == 0 {
        return None;
    }
    Some(auth)
}

fn save_auth(path: &Path, auth: &McpAuth) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("create app config dir")?;
    }
    let bytes = serde_json::to_vec_pretty(auth).context("serialize mcp auth")?;
    fs::write(path, bytes).context("write mcp auth file")?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_format_picks_ass_for_script_info_header() {
        assert!(matches!(
            sniff_subtitle_format("[Script Info]\nTitle: t\n"),
            SubFormat::Ass
        ));
    }

    #[test]
    fn sniff_format_picks_srt_for_cue_index() {
        assert!(matches!(
            sniff_subtitle_format("1\n00:00:00,000 --> 00:00:01,000\nhi\n"),
            SubFormat::Srt
        ));
    }

    #[test]
    fn sniff_format_skips_bom_and_whitespace() {
        let with_bom = "\u{feff}  \n[Script Info]\n";
        assert!(matches!(sniff_subtitle_format(with_bom), SubFormat::Ass));
    }

    #[test]
    fn sniff_format_defaults_to_srt_when_unclear() {
        assert!(matches!(sniff_subtitle_format("hello\nworld\n"), SubFormat::Srt));
    }

    // ============================================================
    // mcp_auth.json — token + port persistence across launches
    // ============================================================

    #[test]
    fn save_then_load_roundtrips_token_and_port() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested").join("mcp_auth.json");
        let original = McpAuth {
            bearer_token: "deadbeef".repeat(8),
            port: 51234,
        };
        save_auth(&path, &original).unwrap();
        let loaded = load_auth(&path).expect("load after save");
        assert_eq!(loaded.bearer_token, original.bearer_token);
        assert_eq!(loaded.port, original.port);
    }

    #[test]
    fn load_returns_none_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(load_auth(&tmp.path().join("does-not-exist.json")).is_none());
    }

    #[test]
    fn load_rejects_zero_port_so_serve_regenerates() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mcp_auth.json");
        fs::write(&path, br#"{"bearer_token":"abc","port":0}"#).unwrap();
        assert!(load_auth(&path).is_none());
    }

    #[test]
    fn load_rejects_empty_token() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mcp_auth.json");
        fs::write(&path, br#"{"bearer_token":"","port":51234}"#).unwrap();
        assert!(load_auth(&path).is_none());
    }

    #[test]
    fn load_rejects_malformed_json() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mcp_auth.json");
        fs::write(&path, b"not json").unwrap();
        assert!(load_auth(&path).is_none());
    }

    #[test]
    fn regenerate_token_swaps_in_cell_and_persists_with_same_port() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mcp_auth.json");
        let original_bind: std::net::SocketAddr = "127.0.0.1:51234".parse().unwrap();
        let cell: McpInfoCell = std::sync::Arc::new(std::sync::RwLock::new(Some(McpInfo {
            bind: original_bind,
            sse_url: "http://127.0.0.1:51234/sse".into(),
            message_url: "http://127.0.0.1:51234/message".into(),
            bearer_token: "stale".repeat(8),
            events_url: "http://127.0.0.1:51235/events".into(),
        })));

        let new_token = regenerate_token_at(&path, &cell).unwrap();

        let after = cell.read().unwrap().clone().unwrap();
        assert_eq!(after.bearer_token, new_token);
        assert_ne!(after.bearer_token, "stale".repeat(8));
        assert_eq!(after.bind, original_bind, "port stays bound");

        let persisted = load_auth(&path).expect("auth file written");
        assert_eq!(persisted.bearer_token, new_token);
        assert_eq!(persisted.port, 51234);
    }

    #[test]
    fn regenerate_token_rejects_when_cell_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mcp_auth.json");
        let cell: McpInfoCell = std::sync::Arc::new(std::sync::RwLock::new(None));
        assert!(regenerate_token_at(&path, &cell).is_err());
        assert!(!path.exists(), "must not write a file with no port to persist");
    }

    // ============================================================
    // resolve_clip_audio_source — Stage 5 source-coordinate math
    // ============================================================

    use chrono::Utc;
    use std::path::PathBuf;
    use crate::state::{
        AudioStreamMeta, MediaItem, MediaKind, MediaMetadata, Layer, Track,
        new_id,
    };

    fn audio_media() -> MediaItem {
        MediaItem {
            id: new_id(),
            label: Some("a.wav".into()),
            path_abs: PathBuf::from("/tmp/a.wav"),
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata {
                duration_us: Some(60_000_000),
                video: None,
                audio: Some(AudioStreamMeta {
                    sample_rate: 44100,
                    channels: 1,
                    codec: "pcm_s16le".into(),
                }),
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "media-hash".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    fn video_clip_layer(
        media_id: MediaId,
        t_start: i64,
        t_end: i64,
        src_in: i64,
        src_out: i64,
        speed: f64,
    ) -> Layer {
        Layer {
            id: new_id(),
            label: None,
            t_start_us: t_start,
            t_end_us: t_end,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::VideoClip(VideoClipParams {
                media: media_id,
                src_in_us: src_in,
                src_out_us: src_out,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: BlendMode::default(),
                speed,
                fade_in_us: 0,
                fade_out_us: 0,
            }),
        }
    }

    fn audio_layer(media_id: MediaId, t_start: i64, t_end: i64, src_in: i64, src_out: i64) -> Layer {
        Layer {
            id: new_id(),
            label: None,
            t_start_us: t_start,
            t_end_us: t_end,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::Audio(AudioParams {
                media: media_id,
                src_in_us: src_in,
                src_out_us: src_out,
                gain_db: Animated::Static(0.0),
                pan: Animated::Static(0.0),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
            }),
        }
    }

    fn project_with_audio_layer(layer: Layer, media: MediaItem) -> Project {
        project_with_layer(layer, media)
    }

    fn project_with_layer(layer: Layer, media: MediaItem) -> Project {
        let mut p = Project::new_blank("test");
        p.media_pool.insert(media.id, media);
        let mut track = Track::new();
        track.label = Some("T".into());
        track.layers.push_back(layer);
        p.tracks.push_back(track);
        p
    }

    #[test]
    fn resolve_default_window_uses_layer_endpoints() {
        // Audio layer occupies [10s, 25s] on the timeline, mapping to
        // [5s, 20s] in the source file (so the layer started 5s into the
        // source). Default args -> full layer.
        let media = audio_media();
        let layer = audio_layer(
            media.id,
            10_000_000, 25_000_000,
            5_000_000, 20_000_000,
        );
        let layer_id = layer.id;
        let project = project_with_audio_layer(layer, media);

        let r = resolve_clip_audio_source(&project, layer_id, None, None).unwrap();
        assert_eq!(r.source_in_us, 5_000_000);
        assert_eq!(r.source_out_us, 20_000_000);
        assert_eq!(r.timeline_start_us, 10_000_000);
        assert_eq!(r.source_hash, "media-hash");
    }

    #[test]
    fn resolve_narrowed_window_maps_offset_into_source_coords() {
        // Layer at timeline [10s, 25s] → source [5s, 20s]. Agent asks for
        // [13s, 20s] timeline → offset [3s, 10s] in the layer → source
        // [8s, 15s].
        let media = audio_media();
        let layer = audio_layer(
            media.id,
            10_000_000, 25_000_000,
            5_000_000, 20_000_000,
        );
        let layer_id = layer.id;
        let project = project_with_audio_layer(layer, media);

        let r = resolve_clip_audio_source(
            &project, layer_id, Some(13_000_000), Some(20_000_000),
        ).unwrap();
        assert_eq!(r.source_in_us, 8_000_000);
        assert_eq!(r.source_out_us, 15_000_000);
        assert_eq!(r.timeline_start_us, 13_000_000);
    }

    #[test]
    fn resolve_rejects_window_outside_layer() {
        let media = audio_media();
        let layer = audio_layer(media.id, 10_000_000, 20_000_000, 0, 10_000_000);
        let layer_id = layer.id;
        let project = project_with_audio_layer(layer, media);

        let err = resolve_clip_audio_source(
            &project, layer_id, Some(5_000_000), Some(15_000_000),
        )
        .expect_err("window starts before layer");
        assert!(format!("{err:?}").contains("outside layer range"));
    }

    #[test]
    fn resolve_rejects_zero_or_inverted_duration() {
        let media = audio_media();
        let layer = audio_layer(media.id, 10_000_000, 20_000_000, 0, 10_000_000);
        let layer_id = layer.id;
        let project = project_with_audio_layer(layer, media);

        let err = resolve_clip_audio_source(
            &project, layer_id, Some(15_000_000), Some(15_000_000),
        )
        .expect_err("zero duration");
        assert!(format!("{err:?}").contains("positive duration"));
    }

    #[test]
    fn resolve_rejects_non_transcribable_layer_kind() {
        let media = audio_media();
        let mut layer = audio_layer(media.id, 0, 5_000_000, 0, 5_000_000);
        layer.params = LayerParams::Color(ColorParams {
            color: Animated::Static(Rgba::WHITE),
            width: 1920,
            height: 1080,
        });
        let layer_id = layer.id;
        let project = project_with_audio_layer(layer, media);
        let err = resolve_clip_audio_source(&project, layer_id, None, None)
            .expect_err("Color layer is not transcribable");
        assert!(format!("{err:?}").contains("not transcribable"));
    }

    #[test]
    fn resolve_rejects_media_without_audio_stream() {
        let mut media = audio_media();
        media.metadata.audio = None;
        let layer = audio_layer(media.id, 0, 5_000_000, 0, 5_000_000);
        let layer_id = layer.id;
        let project = project_with_audio_layer(layer, media);
        let err = resolve_clip_audio_source(&project, layer_id, None, None)
            .expect_err("media has no audio");
        assert!(format!("{err:?}").contains("no audio stream"));
    }

    #[test]
    fn resolve_works_for_video_clip_at_speed_1() {
        // VideoClip layer at timeline [10s, 25s] → source [5s, 20s] at
        // speed=1. Same coord math as audio.
        let media = audio_media(); // re-use; metadata.audio is present
        let layer = video_clip_layer(
            media.id,
            10_000_000, 25_000_000,
            5_000_000, 20_000_000,
            1.0,
        );
        let layer_id = layer.id;
        let project = project_with_layer(layer, media);

        let r = resolve_clip_audio_source(&project, layer_id, None, None).unwrap();
        assert_eq!(r.source_in_us, 5_000_000);
        assert_eq!(r.source_out_us, 20_000_000);
        assert_eq!(r.timeline_start_us, 10_000_000);
    }

    #[test]
    fn resolve_rejects_video_clip_with_nonunit_speed() {
        let media = audio_media();
        let layer = video_clip_layer(
            media.id,
            0, 10_000_000,
            0, 20_000_000,
            2.0, // 2x speed
        );
        let layer_id = layer.id;
        let project = project_with_layer(layer, media);
        let err = resolve_clip_audio_source(&project, layer_id, None, None)
            .expect_err("speed != 1 should reject");
        assert!(format!("{err:?}").contains("speed != 1.0"));
        assert!(format!("{err:?}").contains("split off"));
    }

    // ============================================================
    // detect_silences_in_peaks — Phase 4.x silence-cut helper
    // ============================================================

    /// 100 peaks/sec means each peak covers 10_000us. Easier to think in
    /// "peak indices" when constructing fixtures.
    const US_PER_PEAK: i64 = 10_000;

    fn flat_peaks(n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|_| amp).collect()
    }

    #[test]
    fn detect_silences_returns_empty_for_loud_track() {
        let peaks = flat_peaks(500, 0.5);
        let regions =
            detect_silences_in_peaks(&peaks, 0.02, 500_000, 0, 5_000_000, 0);
        assert!(regions.is_empty());
    }

    #[test]
    fn detect_silences_finds_single_quiet_window() {
        // 200 peaks (= 2s) total. Quiet from peak 50 (= 500ms) to peak 150
        // (= 1500ms), so silence duration = 1000ms.
        let mut peaks = flat_peaks(200, 0.5);
        for i in 50..150 {
            peaks[i] = 0.001;
        }
        let regions =
            detect_silences_in_peaks(&peaks, 0.02, 500_000, 0, 2_000_000, 0);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].t_start_us, 50 * US_PER_PEAK);
        assert_eq!(regions[0].t_end_us, 150 * US_PER_PEAK);
    }

    #[test]
    fn detect_silences_filters_out_runs_shorter_than_min_duration() {
        // 200 peaks (= 2s). Three quiet runs of 30 peaks each (= 300ms).
        // With min_silence_us=500_000 (500ms) none should be returned.
        let mut peaks = flat_peaks(200, 0.5);
        for i in 0..30 {
            peaks[i] = 0.0;
        }
        for i in 80..110 {
            peaks[i] = 0.0;
        }
        for i in 160..190 {
            peaks[i] = 0.0;
        }
        let regions =
            detect_silences_in_peaks(&peaks, 0.02, 500_000, 0, 2_000_000, 0);
        assert!(regions.is_empty(), "expected no regions, got {regions:?}");

        // With min_silence_us=200_000 (200ms) all three should be returned.
        let regions =
            detect_silences_in_peaks(&peaks, 0.02, 200_000, 0, 2_000_000, 0);
        assert_eq!(regions.len(), 3);
    }

    #[test]
    fn detect_silences_handles_silence_at_tail() {
        // Quiet from peak 100 to the end (peak 200). Runs to EOF — make
        // sure the closing branch flushes the pending region.
        let mut peaks = flat_peaks(200, 0.5);
        for i in 100..200 {
            peaks[i] = 0.0;
        }
        let regions =
            detect_silences_in_peaks(&peaks, 0.02, 500_000, 0, 2_000_000, 0);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].t_start_us, 100 * US_PER_PEAK);
        assert_eq!(regions[0].t_end_us, 200 * US_PER_PEAK);
    }

    #[test]
    fn detect_silences_shifts_by_layer_t_start_us() {
        // Layer placed at timeline t=5s. Source [0, 2s]. Silence at source
        // [0.5s, 1.5s] → timeline [5.5s, 6.5s].
        let mut peaks = flat_peaks(200, 0.5);
        for i in 50..150 {
            peaks[i] = 0.0;
        }
        let regions = detect_silences_in_peaks(
            &peaks,
            0.02,
            500_000,
            0,
            2_000_000,
            5_000_000,
        );
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].t_start_us, 5_500_000);
        assert_eq!(regions[0].t_end_us, 6_500_000);
    }

    #[test]
    fn detect_silences_clips_to_layer_source_window() {
        // Peaks cover 2s of source. Layer references only source [0.3s, 1.7s].
        // A silence spanning the WHOLE peaks file [0, 2s] should clip to
        // [0.3s, 1.7s] in source coords → timeline [0, 1.4s] for a layer
        // anchored at t=0.
        let peaks = flat_peaks(200, 0.0);
        let regions = detect_silences_in_peaks(
            &peaks,
            0.02,
            100_000,
            300_000,   // src_in_us
            1_700_000, // src_out_us
            0,         // layer_t_start_us
        );
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].t_start_us, 0);
        assert_eq!(regions[0].t_end_us, 1_400_000);
    }

    #[test]
    fn detect_silences_threshold_is_strict_below() {
        // Peaks exactly at threshold should NOT count as silence.
        let peaks = flat_peaks(200, 0.02);
        let regions =
            detect_silences_in_peaks(&peaks, 0.02, 100_000, 0, 2_000_000, 0);
        assert!(regions.is_empty());

        // Just below threshold → silence.
        let peaks = flat_peaks(200, 0.019);
        let regions =
            detect_silences_in_peaks(&peaks, 0.02, 100_000, 0, 2_000_000, 0);
        assert_eq!(regions.len(), 1);
    }

    // ============================================================
    // Stage H — motif MCP helpers
    // ============================================================

    /// `parse_canonical_props` is the format crossover between
    /// `Motif::canonicalize_props` (returns JSON string) and
    /// `MotifParams.props` (imbl::HashMap<String, Value>). Round-trip via
    /// canonicalize_props with empty input should yield every prop default
    /// keyed by name.
    #[test]
    fn parse_canonical_props_roundtrips_defaults() {
        let motif = catalog::builtin_countdown();
        let canonical = motif
            .canonicalize_props(&serde_json::json!({}))
            .expect("canonicalize defaults");
        let map = parse_canonical_props(&canonical).expect("parse");
        assert_eq!(map.len(), motif.manifest.props_schema.len());
        for key in motif.manifest.props_schema.keys() {
            assert!(map.contains_key(key), "missing prop {key}");
        }
    }

    #[test]
    fn parse_canonical_props_rejects_non_object_payload() {
        let err = parse_canonical_props("\"not an object\"").expect_err("non-object");
        assert!(
            format!("{err:?}").contains("not a JSON object"),
            "unexpected error: {err:?}",
        );
    }

    /// `add_motif` derives `t_end_us` from the motif's
    /// `default_duration_s` when the agent omits it. Guard against future
    /// regressions (e.g. someone swaps `as i64` for `as u64`).
    #[test]
    fn resolve_t_end_us_uses_motif_default_when_omitted() {
        // 5.0s default + 0us start → 5_000_000us end (no cap).
        assert_eq!(resolve_motif_t_end_us(0, None, 5.0, None), 5_000_000);
        // Caller's value wins when set, even if it would normally be invalid
        // (validation happens at the actor layer, not here).
        assert_eq!(
            resolve_motif_t_end_us(1_000_000, Some(2_000_000), 99.0, None),
            2_000_000,
        );
        // saturating_add survives i64::MAX start time without panicking.
        assert_eq!(
            resolve_motif_t_end_us(i64::MAX, None, 5.0, None),
            i64::MAX,
        );
        // A capped motif clamps an explicit over-long t_end_us to the cap.
        // 5.0s cap + 0us start + requested 8s end → clamped to 5_000_000.
        assert_eq!(
            resolve_motif_t_end_us(0, Some(8_000_000), 5.0, Some(5_000_000)),
            5_000_000,
        );
        // Within-cap explicit value passes through unchanged.
        assert_eq!(
            resolve_motif_t_end_us(0, Some(3_000_000), 5.0, Some(5_000_000)),
            3_000_000,
        );
    }

    /// `add_motif` resolves its cap from the props being added via
    /// `resolve_motif_max_dur_us`, so a prop-mapped motif (countdown's
    /// `seconds`) clamps an explicit over-long `t_end_us` to the PROP value,
    /// not the static `max_duration_s`. With `seconds = 8` + a requested 20s
    /// end, the resolved end is ~8s. (The actor's `add_layer` then frame-snaps
    /// both edges; this checks the cap-resolution + clamp step in isolation.)
    #[test]
    fn add_motif_cap_resolves_from_seconds_prop() {
        let manifest = &crate::motifs::catalog::builtin_countdown().manifest;
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(8.0));
        let cap = crate::motifs::catalog::resolve_motif_max_dur_us(manifest, &props);
        assert_eq!(cap, Some(8_000_000));
        // Explicit over-long t_end (20s) clamps to the 8s prop cap.
        assert_eq!(
            resolve_motif_t_end_us(0, Some(20_000_000), manifest.default_duration_s, cap),
            8_000_000,
        );
        // Within-cap explicit value (6s) passes through unchanged.
        assert_eq!(
            resolve_motif_t_end_us(0, Some(6_000_000), manifest.default_duration_s, cap),
            6_000_000,
        );
    }

}
