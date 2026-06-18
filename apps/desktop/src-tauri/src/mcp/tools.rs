//! MCP tool functions, transport-free. Each tool is a
//! `pub(super) async fn <name>(b: &Backend, args: <Args>) -> Result<ToolResult, McpToolError>`.
//! Bodies are ported verbatim from the pre-S4a `WeftCutServer` impl with the
//! mechanical transform applied: `self.project` → `b.project()?`, `self.cache`
//! → `&b.cache`, `crate::logs::emit_via_app(&self.app, e)` → `b.log_slot.emit(e)`,
//! `ok_text`/`ok_json`/`ok_void` → `ToolResult::{text,json,empty}`, and
//! `McpError` → `McpToolError` (constructors match 1:1).
//!
//! The keyframe tools are thin wrappers delegating to `super::keyframes::*`.
//!
//! Cloud tools (transcribe/synthesize) and motif tools are NOT here — they are
//! deferred to S4b/S5 and recoverable from git.

use chrono::Utc;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[cfg(feature = "jobs")]
use crate::cache::cached_ok;
#[cfg(feature = "jobs")]
use crate::jobs;
use crate::napi_backend::Backend;
use crate::state::actor::LayerEdge;
use crate::state::audio_role::AudioRole;
use crate::state::{
    Actor, Animated, AudioParams, BlendMode, CheckpointId, ColorParams, CommandError,
    DryRunOp, DryRunOutput, LayerId, LayerParams, LayerParamsPatch, LayerPatch, MarkerPatch,
    Rgba, SubtitlesParams, SubtitlesSource, TrackId, Transform, ValidationError,
    VideoClipParams,
};

#[cfg(feature = "jobs")]
use crate::io::probe;
#[cfg(feature = "jobs")]
use crate::state::{MediaItem, MediaKind, new_id};

use super::wire::{McpToolError, ToolResult};
use super::EmptyArgs;

// ============================================================
// Shared helpers (ported verbatim; McpError → McpToolError)
// ============================================================

/// Stamp every MCP-originated mutation with a stable Agent actor. The client
/// name is hardcoded to "mcp".
pub(super) fn agent_actor() -> Actor {
    Actor::Agent {
        client: "mcp".to_string(),
    }
}

pub(super) fn parse_uuid(s: &str, field: &str) -> Result<Uuid, McpToolError> {
    Uuid::parse_str(s)
        .map_err(|e| McpToolError::invalid_params(format!("{field} not a UUID: {e}"), None))
}

pub(super) fn parse_layer_edge(s: &str) -> Result<LayerEdge, McpToolError> {
    match s.to_ascii_lowercase().as_str() {
        "in" | "start" | "t_start" | "t_start_us" => Ok(LayerEdge::In),
        "out" | "end" | "t_end" | "t_end_us" => Ok(LayerEdge::Out),
        other => Err(McpToolError::invalid_params(
            format!("unknown layer edge '{other}' (expected 'in' or 'out')"),
            None,
        )),
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) enum SubFormat {
    Srt,
    Ass,
}

/// Best-effort SRT/ASS sniffer. ASS scripts begin with the `[Script Info]`
/// section header (even minimal SSA files); SRT cues begin with a digit
/// (cue index 1). When neither pattern matches we default to SRT — Whisper's
/// `response_format=srt` is the common case.
pub(super) fn sniff_subtitle_format(body: &str) -> SubFormat {
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
pub(super) fn map_command_error(e: CommandError) -> McpToolError {
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
        Some(d) => McpToolError::invalid_params(message, Some(d)),
        None => McpToolError::invalid_params(message, None),
    }
}

/// Find an existing track or create one labeled "Overlay" for subtitles.
/// V.5: tracks are kind-agnostic. Subtitle layers land on the topmost track.
async fn ensure_subtitle_track(b: &Backend) -> Result<TrackId, McpToolError> {
    let snap = b.project()?.snapshot().await;
    if let Some(t) = snap.tracks.last() {
        return Ok(t.id);
    }
    b.project()?
        .add_track(agent_actor(), Some("Overlay".into()))
        .await
        .map_err(map_command_error)
}

/// V.5: tracks are kind-agnostic. Pick the topmost track or spawn a
/// "Voiceover" track when none exists. Used for the auto-paired audio layer
/// in `add_video_layer`.
async fn ensure_audio_track(b: &Backend) -> Result<TrackId, McpToolError> {
    let snap = b.project()?.snapshot().await;
    if let Some(t) = snap.tracks.last() {
        return Ok(t.id);
    }
    b.project()?
        .add_track(agent_actor(), Some("Voiceover".into()))
        .await
        .map_err(map_command_error)
}

// ============================================================
// Liveness
// ============================================================

pub(super) async fn ping(_b: &Backend, _args: EmptyArgs) -> Result<ToolResult, McpToolError> {
    Ok(ToolResult::text("pong"))
}

// ============================================================
// Agent-mode session lifecycle
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct BeginAgentSessionArgs {
    /// Short free-text label shown in the human's record-panel header
    /// while the session is active. Examples: "cutting filler words",
    /// "applying transcribe + auto-cut pass". Required, non-empty.
    pub reason: String,
}

pub(super) async fn begin_agent_session(
    b: &Backend,
    args: BeginAgentSessionArgs,
) -> Result<ToolResult, McpToolError> {
    let reason = args.reason.trim();
    if reason.is_empty() {
        return Err(McpToolError::invalid_params(
            "reason must be non-empty",
            None,
        ));
    }
    let op_id = uuid::Uuid::now_v7();
    b.log_slot.emit(crate::logs::LogEntryInput {
        level: crate::logs::LogLevel::Info,
        category: crate::logs::LogCategory::Mcp,
        source: crate::logs::LogSource::Agent { client: "mcp".into() },
        message: format!("MCP: begin_agent_session started ({reason})"),
        op_id: Some(op_id),
        op_state: Some(crate::logs::OpState::Started),
        ..Default::default()
    });

    // Auto-checkpoint BEFORE flipping the slot — wait, we actually
    // need started_at LOCKED first so the record-panel's filter
    // (`ts >= started_at`) catches the checkpoint LogEntry. The
    // history.checkpoint() call itself doesn't emit a LogEntry; we
    // emit one below with the same structured `details` shape the
    // `checkpoint` MCP tool uses, so the record panel renders this
    // as a normal pin-row at the top of the session.
    let started_at = Utc::now();
    let label = format!("Pre-agent: {reason}");
    let checkpoint_id = b
        .project()?
        .checkpoint(agent_actor(), label.clone())
        .await;
    b.log_slot.emit(crate::logs::LogEntryInput {
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
    });

    let session = crate::agent_session::AgentSession {
        client: "mcp".into(),
        reason: reason.to_string(),
        started_at,
    };
    let prior = crate::agent_session::begin_and_emit(
        b.events.as_ref(),
        &b.agent_session,
        session,
    );
    if let Some(prev) = prior {
        b.log_slot.emit(crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Info,
            category: crate::logs::LogCategory::System,
            source: crate::logs::LogSource::System,
            message: format!(
                "Prior agent session displaced (client={} reason={})",
                prev.client, prev.reason,
            ),
            ..Default::default()
        });
    }

    b.log_slot.emit(crate::logs::LogEntryInput {
        level: crate::logs::LogLevel::Info,
        category: crate::logs::LogCategory::Mcp,
        source: crate::logs::LogSource::Agent { client: "mcp".into() },
        message: format!("MCP: begin_agent_session done (checkpoint={checkpoint_id})"),
        op_id: Some(op_id),
        op_state: Some(crate::logs::OpState::Ok),
        ..Default::default()
    });

    ToolResult::json(&serde_json::json!({
        "checkpoint_id": checkpoint_id.to_string(),
        "started_at": started_at.to_rfc3339(),
    }))
}

// ============================================================
// Track tools
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct AddTrackArgs {
    /// Optional human-readable label.
    pub label: Option<String>,
}

pub(super) async fn add_track(b: &Backend, args: AddTrackArgs) -> Result<ToolResult, McpToolError> {
    let id = b
        .project()?
        .add_track(agent_actor(), args.label)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::text(id.to_string()))
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct RemoveTrackArgs {
    pub track_id: String,
    /// If true, deletes the track even if it has layers. Default false.
    pub force: Option<bool>,
}

pub(super) async fn remove_track(
    b: &Backend,
    args: RemoveTrackArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.track_id, "track_id")?;
    b.project()?
        .delete_track(agent_actor(), id, args.force.unwrap_or(false))
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct MoveTrackArgs {
    pub track_id: String,
    /// Target index in the tracks vector. Must be < current track count.
    pub new_position: usize,
}

pub(super) async fn move_track(
    b: &Backend,
    args: MoveTrackArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.track_id, "track_id")?;
    b.project()?
        .move_track(agent_actor(), id, args.new_position)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

// ============================================================
// Layer tools
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct AddColorLayerArgs {
    pub track_id: String,
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub color: Rgba,
    /// Defaults to composition width when omitted.
    pub width: Option<u32>,
    /// Defaults to composition height when omitted.
    pub height: Option<u32>,
}

pub(super) async fn add_color_layer(
    b: &Backend,
    args: AddColorLayerArgs,
) -> Result<ToolResult, McpToolError> {
    let track_id = parse_uuid(&args.track_id, "track_id")?;
    let params = LayerParams::Color(ColorParams {
        color: Animated::Static(args.color),
        width: args.width.unwrap_or(1920),
        height: args.height.unwrap_or(1080),
    });
    let id = b
        .project()?
        .add_layer(agent_actor(), track_id, params, args.t_start_us, args.t_end_us)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::text(id.to_string()))
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct AddVideoLayerArgs {
    pub track_id: String,
    pub media_id: String,
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub src_in_us: i64,
    pub src_out_us: i64,
}

pub(super) async fn add_video_layer(
    b: &Backend,
    args: AddVideoLayerArgs,
) -> Result<ToolResult, McpToolError> {
    let track_id = parse_uuid(&args.track_id, "track_id")?;
    let media_id = parse_uuid(&args.media_id, "media_id")?;
    let snap = b.project()?.snapshot().await;
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
    let video_layer_id = b
        .project()?
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
        let audio_track = ensure_audio_track(b).await?;
        let audio_params = LayerParams::Audio(AudioParams {
            media: media_id,
            src_in_us: args.src_in_us,
            src_out_us: args.src_out_us,
            gain_db: Animated::Static(0.0),
            pan: Animated::Static(0.0),
            fade_in_us: 0,
            fade_out_us: 0,
            mute: false,
            role: AudioRole::Dialogue,
        });
        let audio_layer_id = b
            .project()?
            .add_layer(
                agent_actor(),
                audio_track,
                audio_params,
                args.t_start_us,
                args.t_end_us,
            )
            .await
            .map_err(map_command_error)?;
        let group_id = b
            .project()?
            .groups_create(
                agent_actor(),
                vec![video_layer_id, audio_layer_id],
                None,
                false,
            )
            .await
            .map_err(map_command_error)?;
        return ToolResult::json(&serde_json::json!({
            "video_layer_id": video_layer_id.to_string(),
            "audio_layer_id": audio_layer_id.to_string(),
            "group_id": group_id.to_string(),
        }));
    }
    Ok(ToolResult::text(video_layer_id.to_string()))
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct ApplySubtitlesArgs {
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

pub(super) async fn apply_subtitles(
    b: &Backend,
    args: ApplySubtitlesArgs,
) -> Result<ToolResult, McpToolError> {
    if args.body.trim().is_empty() {
        return Err(McpToolError::invalid_params(
            "subtitles body is empty",
            None,
        ));
    }
    if args.t_end_us <= args.t_start_us.unwrap_or(0) {
        return Err(McpToolError::invalid_params(
            "t_end_us must be greater than t_start_us",
            None,
        ));
    }
    let format = match args.format.as_deref() {
        Some("srt") | Some("SRT") => SubFormat::Srt,
        Some("ass") | Some("ASS") => SubFormat::Ass,
        None => sniff_subtitle_format(&args.body),
        Some(other) => {
            return Err(McpToolError::invalid_params(
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
        None => ensure_subtitle_track(b).await?,
    };
    let params = LayerParams::Subtitles(SubtitlesParams { source });
    let id = b
        .project()?
        .add_layer(
            agent_actor(),
            track_id,
            params,
            args.t_start_us.unwrap_or(0),
            args.t_end_us,
        )
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::text(id.to_string()))
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct DetectSilencesArgs {
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
pub(super) struct SilenceRegion {
    pub t_start_us: i64,
    pub t_end_us: i64,
}

#[cfg(feature = "jobs")]
pub(super) async fn detect_silences(
    b: &Backend,
    args: DetectSilencesArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let snap = b.project()?.snapshot().await;
    let layer = snap
        .tracks
        .iter()
        .flat_map(|t| t.layers.iter())
        .find(|l| l.id == layer_id)
        .ok_or_else(|| {
            McpToolError::invalid_params(format!("layer {layer_id} not found"), None)
        })?;

    let media_id = match &layer.params {
        LayerParams::VideoClip(p) => p.media,
        LayerParams::Audio(p) => p.media,
        _ => {
            return Err(McpToolError::invalid_params(
                format!(
                    "layer {layer_id} kind is not analyzable for silence — pass a VideoClip or Audio layer",
                ),
                None,
            ));
        }
    };
    let media = snap.media_pool.get(&media_id).ok_or_else(|| {
        McpToolError::invalid_params(
            format!("layer {layer_id} references missing media {media_id}"),
            None,
        )
    })?;
    let waveform_path = b.cache.waveform(&media.file_hash_blake3);
    if !cached_ok(&waveform_path) {
        return Err(McpToolError::invalid_request(
            format!(
                "waveform not generated yet for media {media_id} — wait for a media:job_complete event with kind=waveform and retry",
            ),
            None,
        ));
    }

    let threshold_amp = args.threshold_amp.unwrap_or(0.02);
    let min_silence_us = args.min_silence_us.unwrap_or(500_000);
    if !(0.0..=1.0).contains(&threshold_amp) {
        return Err(McpToolError::invalid_params(
            format!("threshold_amp {threshold_amp} must be in [0.0, 1.0]"),
            None,
        ));
    }
    if min_silence_us <= 0 {
        return Err(McpToolError::invalid_params(
            format!("min_silence_us {min_silence_us} must be positive"),
            None,
        ));
    }

    let peaks = jobs::read_peaks_file(&waveform_path)
        .map_err(|e| McpToolError::internal_error(format!("read peaks: {e:#}"), None))?;

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

    ToolResult::json(&regions)
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct UpdateLayerArgs {
    pub layer_id: String,
    pub patch: LayerPatch,
}

pub(super) async fn update_layer(
    b: &Backend,
    args: UpdateLayerArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.layer_id, "layer_id")?;
    b.project()?
        .update_layer(agent_actor(), id, args.patch)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct UpdateLayerParamsArgs {
    pub layer_id: String,
    pub patch: LayerParamsPatch,
}

pub(super) async fn update_layer_params(
    b: &Backend,
    args: UpdateLayerParamsArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.layer_id, "layer_id")?;
    b.project()?
        .update_layer_params(agent_actor(), id, args.patch)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct MoveLayerArgs {
    pub layer_id: String,
    pub new_track_id: String,
    pub new_t_start_us: i64,
    /// `docs/groups.md` — when the moved layer is in a group and
    /// `escape_group` is `false` or omitted, every group member shifts in
    /// time by the same delta. Pass `true` to move only this layer.
    #[serde(default)]
    pub escape_group: Option<bool>,
}

pub(super) async fn move_layer(
    b: &Backend,
    args: MoveLayerArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let new_track_id = parse_uuid(&args.new_track_id, "new_track_id")?;
    b.project()?
        .move_layer(
            agent_actor(),
            layer_id,
            new_track_id,
            args.new_t_start_us,
            args.escape_group.unwrap_or(false),
        )
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SplitLayerArgs {
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
pub(super) struct SplitLayerResult {
    pub left: String,
    pub right: String,
}

pub(super) async fn split_layer(
    b: &Backend,
    args: SplitLayerArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.layer_id, "layer_id")?;
    let (left, right) = b
        .project()?
        .split_layer(
            agent_actor(),
            id,
            args.at_t_us,
            args.escape_group.unwrap_or(false),
        )
        .await
        .map_err(map_command_error)?;
    ToolResult::json(&SplitLayerResult {
        left: left.to_string(),
        right: right.to_string(),
    })
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct LayerIdArgs {
    pub layer_id: String,
}

pub(super) async fn delete_layer(
    b: &Backend,
    args: LayerIdArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.layer_id, "layer_id")?;
    b.project()?
        .delete_layer(agent_actor(), id)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct TrimLayerArgs {
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

pub(super) async fn trim_layer(
    b: &Backend,
    args: TrimLayerArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.layer_id, "layer_id")?;
    let edge = parse_layer_edge(&args.edge)?;
    b.project()?
        .trim_layer(
            agent_actor(),
            id,
            edge,
            args.new_t_us,
            args.escape_group.unwrap_or(false),
        )
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

// ============================================================
// Group tools (Phase G.4 — `docs/groups.md`)
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct GroupIdArgs {
    pub group_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct GroupsCreateArgs {
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
pub(super) struct GroupsAddMembersArgs {
    pub group_id: String,
    pub layer_ids: Vec<String>,
    #[serde(default)]
    pub reassign: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct GroupsRemoveMembersArgs {
    pub group_id: String,
    pub layer_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct GroupsRenameArgs {
    pub group_id: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub(super) struct GroupView {
    pub id: String,
    pub label: Option<String>,
    pub layer_ids: Vec<String>,
}

pub(super) async fn groups_list(
    b: &Backend,
    _args: EmptyArgs,
) -> Result<ToolResult, McpToolError> {
    let snap = b.project()?.snapshot().await;
    let payload: Vec<_> = snap
        .groups
        .iter()
        .map(|g| GroupView {
            id: g.id.to_string(),
            label: g.label.clone(),
            layer_ids: g.members.iter().map(|m| m.to_string()).collect(),
        })
        .collect();
    ToolResult::json(&payload)
}

pub(super) async fn groups_get(
    b: &Backend,
    args: GroupIdArgs,
) -> Result<ToolResult, McpToolError> {
    let gid = parse_uuid(&args.group_id, "group_id")?;
    let snap = b.project()?.snapshot().await;
    let g = snap
        .groups
        .iter()
        .find(|g| g.id == gid)
        .ok_or_else(|| McpToolError::invalid_params(format!("group {gid} not found"), None))?;
    ToolResult::json(&GroupView {
        id: g.id.to_string(),
        label: g.label.clone(),
        layer_ids: g.members.iter().map(|m| m.to_string()).collect(),
    })
}

pub(super) async fn groups_create(
    b: &Backend,
    args: GroupsCreateArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_ids: Vec<LayerId> = args
        .layer_ids
        .iter()
        .map(|s| parse_uuid(s, "layer_id"))
        .collect::<Result<_, _>>()?;
    let gid = b
        .project()?
        .groups_create(
            agent_actor(),
            layer_ids,
            args.label,
            args.reassign.unwrap_or(false),
        )
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::text(gid.to_string()))
}

pub(super) async fn groups_dissolve(
    b: &Backend,
    args: GroupIdArgs,
) -> Result<ToolResult, McpToolError> {
    let gid = parse_uuid(&args.group_id, "group_id")?;
    b.project()?
        .groups_dissolve(agent_actor(), gid)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

pub(super) async fn groups_add_members(
    b: &Backend,
    args: GroupsAddMembersArgs,
) -> Result<ToolResult, McpToolError> {
    let gid = parse_uuid(&args.group_id, "group_id")?;
    let layer_ids: Vec<LayerId> = args
        .layer_ids
        .iter()
        .map(|s| parse_uuid(s, "layer_id"))
        .collect::<Result<_, _>>()?;
    b.project()?
        .groups_add_members(
            agent_actor(),
            gid,
            layer_ids,
            args.reassign.unwrap_or(false),
        )
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

pub(super) async fn groups_remove_members(
    b: &Backend,
    args: GroupsRemoveMembersArgs,
) -> Result<ToolResult, McpToolError> {
    let gid = parse_uuid(&args.group_id, "group_id")?;
    let layer_ids: Vec<LayerId> = args
        .layer_ids
        .iter()
        .map(|s| parse_uuid(s, "layer_id"))
        .collect::<Result<_, _>>()?;
    b.project()?
        .groups_remove_members(agent_actor(), gid, layer_ids)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

pub(super) async fn groups_rename(
    b: &Backend,
    args: GroupsRenameArgs,
) -> Result<ToolResult, McpToolError> {
    let gid = parse_uuid(&args.group_id, "group_id")?;
    b.project()?
        .groups_rename(agent_actor(), gid, args.label)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct DuplicateLayerArgs {
    pub layer_id: String,
    pub t_offset_us: i64,
}

pub(super) async fn duplicate_layer(
    b: &Backend,
    args: DuplicateLayerArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.layer_id, "layer_id")?;
    let dup = b
        .project()?
        .duplicate_layer(agent_actor(), id, args.t_offset_us)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::text(dup.to_string()))
}

// ============================================================
// Keyframe tools — thin wrappers delegating to super::keyframes.
// Times are TIMELINE-ABSOLUTE microseconds.
// ============================================================

pub(super) async fn get_param_track(
    b: &Backend,
    args: super::keyframes::GetParamTrackArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let value = super::keyframes::get_param_track(b.project()?, layer_id, &args.param_key)
        .await
        .map_err(super::keyframes::kf_error_to_mcp)?;
    ToolResult::json(&value)
}

pub(super) async fn set_keyframe(
    b: &Backend,
    args: super::keyframes::SetKeyframeArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let interp = match args.interp {
        Some(v) => Some(
            serde_json::from_value::<crate::state::animated::Interpolation>(v)
                .map_err(|e| McpToolError::invalid_params(format!("invalid interp: {e}"), None))?,
        ),
        None => None,
    };
    super::keyframes::set_keyframe(
        b.project()?,
        agent_actor(),
        layer_id,
        &args.param_key,
        args.t_us,
        args.value,
        interp,
    )
    .await
    .map_err(super::keyframes::kf_error_to_mcp)?;
    Ok(ToolResult::empty())
}

pub(super) async fn remove_keyframe(
    b: &Backend,
    args: super::keyframes::RemoveKeyframeArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let keyframe_id = parse_uuid(&args.keyframe_id, "keyframe_id")?;
    super::keyframes::remove_keyframe(b.project()?, agent_actor(), layer_id, &args.param_key, keyframe_id)
        .await
        .map_err(super::keyframes::kf_error_to_mcp)?;
    Ok(ToolResult::empty())
}

pub(super) async fn retime_keyframe(
    b: &Backend,
    args: super::keyframes::RetimeKeyframeArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let keyframe_id = parse_uuid(&args.keyframe_id, "keyframe_id")?;
    super::keyframes::retime_keyframe(
        b.project()?,
        agent_actor(),
        layer_id,
        &args.param_key,
        keyframe_id,
        args.t_us,
    )
    .await
    .map_err(super::keyframes::kf_error_to_mcp)?;
    Ok(ToolResult::empty())
}

pub(super) async fn set_keyframe_easing(
    b: &Backend,
    args: super::keyframes::SetKeyframeEasingArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let keyframe_id = parse_uuid(&args.keyframe_id, "keyframe_id")?;
    let interp = serde_json::from_value::<crate::state::animated::Interpolation>(args.interp)
        .map_err(|e| McpToolError::invalid_params(format!("invalid interp: {e}"), None))?;
    super::keyframes::set_keyframe_easing(
        b.project()?,
        agent_actor(),
        layer_id,
        &args.param_key,
        keyframe_id,
        interp,
    )
    .await
    .map_err(super::keyframes::kf_error_to_mcp)?;
    Ok(ToolResult::empty())
}

pub(super) async fn smooth_keyframes(
    b: &Backend,
    args: super::keyframes::SmoothKeyframesArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let keyframe_id = match args.keyframe_id.as_deref() {
        Some(s) => Some(parse_uuid(s, "keyframe_id")?),
        None => None,
    };
    super::keyframes::smooth_keyframes(b.project()?, agent_actor(), layer_id, &args.param_key, keyframe_id)
        .await
        .map_err(super::keyframes::kf_error_to_mcp)?;
    Ok(ToolResult::empty())
}

pub(super) async fn clear_keyframes(
    b: &Backend,
    args: super::keyframes::ClearKeyframesArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    super::keyframes::clear_keyframes(b.project()?, agent_actor(), layer_id, &args.param_key, args.value)
        .await
        .map_err(super::keyframes::kf_error_to_mcp)?;
    Ok(ToolResult::empty())
}

pub(super) async fn set_param_track(
    b: &Backend,
    args: super::keyframes::SetParamTrackArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let track = serde_json::from_value::<Animated<f64>>(args.track)
        .map_err(|e| McpToolError::invalid_params(format!("invalid track: {e}"), None))?;
    super::keyframes::set_param_track(b.project()?, agent_actor(), layer_id, &args.param_key, track)
        .await
        .map_err(super::keyframes::kf_error_to_mcp)?;
    Ok(ToolResult::empty())
}

// ============================================================
// Composition tools
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SetCompositionArgs {
    pub patch: crate::state::CompositionPatch,
}

pub(super) async fn set_composition(
    b: &Backend,
    args: SetCompositionArgs,
) -> Result<ToolResult, McpToolError> {
    b.project()?
        .set_composition(agent_actor(), args.patch)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

pub(super) async fn fit_composition_to_layers(
    b: &Backend,
    _args: EmptyArgs,
) -> Result<ToolResult, McpToolError> {
    b.project()?
        .fit_composition_to_layers(agent_actor())
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

// ============================================================
// Marker tools
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct AddMarkerArgs {
    pub t_us: i64,
    pub label: String,
    pub color: Rgba,
    /// Set to make this a region marker.
    pub end_t_us: Option<i64>,
}

pub(super) async fn add_marker(
    b: &Backend,
    args: AddMarkerArgs,
) -> Result<ToolResult, McpToolError> {
    let id = b
        .project()?
        .add_marker(agent_actor(), args.t_us, args.end_t_us, args.label, args.color)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::text(id.to_string()))
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct UpdateMarkerArgs {
    pub marker_id: String,
    pub patch: MarkerPatch,
}

pub(super) async fn update_marker(
    b: &Backend,
    args: UpdateMarkerArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.marker_id, "marker_id")?;
    b.project()?
        .update_marker(agent_actor(), id, args.patch)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct MarkerIdArgs {
    pub marker_id: String,
}

pub(super) async fn remove_marker(
    b: &Backend,
    args: MarkerIdArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.marker_id, "marker_id")?;
    b.project()?
        .remove_marker(agent_actor(), id)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

// ============================================================
// Media tools
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct ImportMediaArgs {
    /// Absolute path to a video / audio / image / subtitle file the host can read.
    pub path: String,
}

#[cfg(feature = "jobs")]
pub(super) async fn import_media(
    b: &Backend,
    args: ImportMediaArgs,
) -> Result<ToolResult, McpToolError> {
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
    .map_err(|e| McpToolError::internal_error(format!("import join: {e}"), None))?
    .map_err(|e| McpToolError::invalid_params(format!("import: {e}"), None))?;
    let item_for_jobs = item.clone();
    let id = b
        .project()?
        .add_media_item(agent_actor(), item)
        .await
        .map_err(map_command_error)?;
    // Fire-and-forget: enqueues thumbnails / proxy / waveform jobs via
    // the global semaphore. UI listeners pick up `media:job_*` events;
    // cached derivatives appear in subsequent `project://media` reads.
    jobs::enqueue_for_media(
        b.events.clone(),
        b.cache.clone(),
        b.project()?.clone(),
        item_for_jobs,
    );
    Ok(ToolResult::text(id.to_string()))
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct RemoveMediaArgs {
    pub media_id: String,
    /// If true, also deletes layers that reference this media. Default false.
    pub force: Option<bool>,
}

pub(super) async fn remove_media(
    b: &Backend,
    args: RemoveMediaArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.media_id, "media_id")?;
    b.project()?
        .remove_media(agent_actor(), id, args.force.unwrap_or(false))
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

// ============================================================
// Workflow tools
// ============================================================

pub(super) async fn undo(b: &Backend, _args: EmptyArgs) -> Result<ToolResult, McpToolError> {
    b.project()?
        .undo(agent_actor())
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

pub(super) async fn redo(b: &Backend, _args: EmptyArgs) -> Result<ToolResult, McpToolError> {
    b.project()?
        .redo(agent_actor())
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

// ============================================================
// History lock
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct LockHistoryArgs {
    /// Short free-text label shown to the user while the lock is held
    /// ("applying transitions", "rendering preview", etc.). Required.
    pub reason: String,
}

pub(super) async fn lock_history(
    b: &Backend,
    args: LockHistoryArgs,
) -> Result<ToolResult, McpToolError> {
    let reason = args.reason.trim();
    if reason.is_empty() {
        return Err(McpToolError::invalid_params(
            "reason must be non-empty",
            None,
        ));
    }
    b.project()?.lock_history(reason.to_string()).await;
    b.log_slot.emit(crate::logs::LogEntryInput {
        level: crate::logs::LogLevel::Info,
        category: crate::logs::LogCategory::Mcp,
        source: crate::logs::LogSource::Agent { client: "mcp".into() },
        message: format!("History locked: {reason}"),
        ..Default::default()
    });
    Ok(ToolResult::empty())
}

pub(super) async fn unlock_history(
    b: &Backend,
    _args: EmptyArgs,
) -> Result<ToolResult, McpToolError> {
    b.project()?.unlock_history().await;
    b.log_slot.emit(crate::logs::LogEntryInput {
        level: crate::logs::LogLevel::Info,
        category: crate::logs::LogCategory::Mcp,
        source: crate::logs::LogSource::Agent { client: "mcp".into() },
        message: "History unlocked".into(),
        ..Default::default()
    });
    Ok(ToolResult::empty())
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct CheckpointArgs {
    /// Human-readable label for the checkpoint.
    pub label: String,
}

pub(super) async fn checkpoint(
    b: &Backend,
    args: CheckpointArgs,
) -> Result<ToolResult, McpToolError> {
    let label = args.label.trim();
    if label.is_empty() {
        return Err(McpToolError::invalid_params(
            "label must be non-empty",
            None,
        ));
    }
    let id: CheckpointId = b
        .project()?
        .checkpoint(agent_actor(), label.to_string())
        .await;
    // Structured `details` so the agent-mode record panel can render
    // checkpoint rows distinctly from regular tool-call rows. The
    // raw `History::checkpoint` write doesn't produce a ChangeEvent
    // today; this LogEntry is the sole signal the record panel has.
    b.log_slot.emit(crate::logs::LogEntryInput {
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
    });
    Ok(ToolResult::text(id.to_string()))
}

pub(super) async fn list_checkpoints(
    b: &Backend,
    _args: EmptyArgs,
) -> Result<ToolResult, McpToolError> {
    // Reuse history_view (limit doesn't affect the checkpoints field).
    let view = b.project()?.history_view(0).await;
    ToolResult::json(&view.checkpoints)
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct RestoreCheckpointArgs {
    pub checkpoint_id: String,
}

pub(super) async fn restore_checkpoint(
    b: &Backend,
    args: RestoreCheckpointArgs,
) -> Result<ToolResult, McpToolError> {
    let id = parse_uuid(&args.checkpoint_id, "checkpoint_id")?;
    let label = b
        .project()?
        .list_checkpoints()
        .await
        .into_iter()
        .find(|c| c.id == id)
        .map(|c| c.label);
    b.project()?
        .restore_checkpoint(agent_actor(), id)
        .await
        .map_err(map_command_error)?;
    b.log_slot.emit(crate::logs::LogEntryInput {
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
    });
    Ok(ToolResult::empty())
}

// ============================================================
// Dry run (Phase 4.x last gap)
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct DryRunArgs {
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
pub(super) enum OperationSpec {
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

pub(super) async fn dry_run(b: &Backend, args: DryRunArgs) -> Result<ToolResult, McpToolError> {
    // Parse the MCP OperationSpec list into the actor's DryRunOp values
    // (string UUIDs → TrackId/LayerId/MediaId at this boundary).
    let mut ops = Vec::with_capacity(args.operations.len());
    for (idx, spec) in args.operations.into_iter().enumerate() {
        let op = spec_to_op(spec).map_err(|e| {
            McpToolError::invalid_params(
                format!("operations[{idx}]: {e}"),
                None,
            )
        })?;
        ops.push(op);
    }
    let results = b.project()?.dry_run(ops).await;
    ToolResult::json(&DryRunResponse::from_results(results))
}

// ============================================================
// Audio-role tools
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SetRoleGainArgs {
    /// "dialogue" | "music" | "sfx" | "voiceover"
    pub role: AudioRole,
    /// Mix-bus gain in decibels. 0.0 = unity; typical range -60..+12. Sets
    /// the role's gain absolutely (replaces the current value, not additive).
    pub gain_db: f64,
}

pub(super) async fn set_role_gain(
    b: &Backend,
    args: SetRoleGainArgs,
) -> Result<ToolResult, McpToolError> {
    b.project()?
        .set_role_gain(agent_actor(), args.role, args.gain_db)
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SetRoleFlagsArgs {
    /// "dialogue" | "music" | "sfx" | "voiceover"
    pub role: AudioRole,
    #[serde(default)]
    pub muted: Option<bool>,
    #[serde(default)]
    pub solo: Option<bool>,
}

pub(super) async fn set_role_flags(
    b: &Backend,
    args: SetRoleFlagsArgs,
) -> Result<ToolResult, McpToolError> {
    b.project()?
        .update_role_flags(
            agent_actor(),
            args.role,
            crate::state::audio_role::RoleFlagsPatch {
                muted: args.muted,
                solo: args.solo,
            },
        )
        .await
        .map_err(map_command_error)?;
    Ok(ToolResult::empty())
}

// ============================================================
// detect_silences peak-scan helpers (ported verbatim)
// ============================================================

/// Scan a peaks array and return timeline-absolute silence ranges. Splits the
/// peaks into segments where every value is strictly below `threshold_amp` and
/// total duration ≥ `min_silence_us`.
#[cfg(feature = "jobs")]
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

#[cfg(feature = "jobs")]
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

// ============================================================
// Tests — ported from the pre-S4a `mcp/mod.rs` #[cfg(test)] block,
// adapted to the free-fn signatures. Tests that exercised deleted
// cloud/motif tools are dropped (their tools moved to S4b/S5).
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Project;

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
    // detect_silences_in_peaks — Phase 4.x silence-cut helper
    // ============================================================

    /// 100 peaks/sec means each peak covers 10_000us. Easier to think in
    /// "peak indices" when constructing fixtures.
    #[cfg(feature = "jobs")]
    const US_PER_PEAK: i64 = 10_000;

    #[cfg(feature = "jobs")]
    fn flat_peaks(n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|_| amp).collect()
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn detect_silences_returns_empty_for_loud_track() {
        let peaks = flat_peaks(500, 0.5);
        let regions =
            detect_silences_in_peaks(&peaks, 0.02, 500_000, 0, 5_000_000, 0);
        assert!(regions.is_empty());
    }

    #[cfg(feature = "jobs")]
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

    #[cfg(feature = "jobs")]
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

    #[cfg(feature = "jobs")]
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

    #[cfg(feature = "jobs")]
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

    #[cfg(feature = "jobs")]
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

    #[cfg(feature = "jobs")]
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
    // Audio-role tools: set_role_gain / set_role_flags
    //
    // Drive the exact `ProjectHandle` call each tool body makes against a
    // real actor, then assert the change through a project snapshot.
    // ============================================================

    #[tokio::test]
    async fn set_role_gain_tool_changes_project() {
        // Assert the kebab role + gain wire shape lands in the args struct.
        let args: SetRoleGainArgs =
            serde_json::from_value(serde_json::json!({ "role": "dialogue", "gain_db": 6.0 }))
                .expect("SetRoleGainArgs deserializes from the tool-call shape");
        assert_eq!(args.role, AudioRole::Dialogue);

        // Then run the tool body's effect against a real project actor.
        let project = crate::state::actor::spawn(Project::new_blank("test"));
        project
            .set_role_gain(agent_actor(), args.role, args.gain_db)
            .await
            .expect("set_role_gain");

        assert_eq!(
            project.snapshot().await.role_mix(AudioRole::Dialogue).gain_db,
            6.0,
        );
    }

    #[tokio::test]
    async fn set_role_flags_tool_changes_project() {
        // `muted`/`solo` are optional (serde default); a partial patch (mute
        // only) must deserialize and apply just that field.
        let args: SetRoleFlagsArgs =
            serde_json::from_value(serde_json::json!({ "role": "music", "muted": true }))
                .expect("SetRoleFlagsArgs deserializes from the tool-call shape");
        assert_eq!(args.role, AudioRole::Music);
        assert_eq!(args.muted, Some(true));
        assert_eq!(args.solo, None);

        let project = crate::state::actor::spawn(Project::new_blank("test"));
        project
            .update_role_flags(
                agent_actor(),
                args.role,
                crate::state::audio_role::RoleFlagsPatch {
                    muted: args.muted,
                    solo: args.solo,
                },
            )
            .await
            .expect("update_role_flags");

        let mix = project.snapshot().await.role_mix(AudioRole::Music);
        assert!(mix.muted, "mute flag applied");
        assert!(!mix.solo, "solo untouched by a mute-only patch");
    }

    // ============================================================
    // add_track via the free-fn surface, end to end through Backend.
    // ============================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_track_via_backend_grows_track_count() {
        use std::sync::Arc;
        let b = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let before = b.project().unwrap().snapshot().await.tracks.len();
        let r = add_track(&b, AddTrackArgs { label: None }).await.unwrap();
        // Returns the new track id as a text block.
        assert!(!r.content.is_empty());
        let after = b.project().unwrap().snapshot().await.tracks.len();
        assert_eq!(after, before + 1);
    }
}
