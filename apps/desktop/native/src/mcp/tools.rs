//! MCP tool functions, transport-free. Each tool is a
//! `pub(super) async fn <name>(b: &Backend, args: <Args>) -> Result<ToolResult, McpToolError>`.
//! Each tool returns `ToolResult` / `McpToolError`. Errors map 1:1 onto the MCP
//! error model in `wire.rs`.
//!
//! Phase 4b T3: only the native/compute/hybrid-compute tool handlers remain.
//! The ~47 TS-executed mutation handlers are deleted; the TS actor serves them.
//! Cloud tools (transcribe/synthesize) are gated on `feature = "cloud"`; motif
//! tools on `feature = "motifs"`.

use chrono::Utc;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(feature = "cloud")]
use crate::cloud;

#[cfg(feature = "jobs")]
use crate::cache::cached_ok;
#[cfg(feature = "jobs")]
use crate::jobs;
use uuid::Uuid;

use crate::napi_backend::Backend;
use crate::state::{
    Actor, Animated, AudioParams, CommandError,
    LayerId, LayerParams, TrackId, ValidationError,
};

#[cfg(feature = "cloud")]
use crate::state::audio_role::AudioRole;

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

/// Map an actor `CommandError` to an MCP error. Validation failures with
/// agent-actionable alternatives (LayerOverlap) carry a structured `options[]`
/// list per the docs/mcp.md error model so the agent can pick a recovery
/// rather than bouncing off a brick wall.
pub(super) fn map_command_error(e: CommandError) -> McpToolError {
    // Step 1a: errors the shared command layer raises while parsing args map to
    // the same MCP shapes the per-tool handlers produced directly before
    // delegation — bad input → invalid_params, missing backend → internal_error
    // (the latter matching the old `From<String> for McpToolError`).
    match &e {
        CommandError::InvalidArgument { field, detail } => {
            return McpToolError::invalid_params(format!("{field}: {detail}"), None);
        }
        CommandError::Backend(msg) => {
            return McpToolError::internal_error(msg.clone(), None);
        }
        _ => {}
    }
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

// Track and layer mutation tools (add_track, remove_track, move_track,
// add_color_layer, add_video_layer, update_layer, update_layer_params,
// move_layer, trim_layer, delete_layer, split_layer, duplicate_layer) are
// deleted — they are served by the TS actor (Phase 4b T3).

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct ApplySubtitlesArgs {
    /// Subtitle document body (SRT, ASS, or VTT).
    pub body: String,
    /// 'srt', 'ass', or 'vtt'. Sniffed from body when omitted.
    pub format: Option<String>,
    /// IGNORED — a caption import always creates its own Caption-role track.
    /// Kept for wire-schema stability; do not remove.
    pub track_id: Option<String>,
    /// IGNORED — cue timings come from the body, not the timeline envelope.
    /// Kept for wire-schema stability; do not remove.
    pub t_start_us: Option<i64>,
    /// IGNORED — cue timings come from the body, not the timeline envelope.
    /// Kept for wire-schema stability; do not remove.
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
    let format = match args.format.as_deref() {
        Some("srt") | Some("SRT") => Some(crate::subtitles::SubFormat::Srt),
        Some("ass") | Some("ASS") => Some(crate::subtitles::SubFormat::Ass),
        Some("vtt") | Some("VTT") => Some(crate::subtitles::SubFormat::Vtt),
        None => None,
        Some(other) => {
            return Err(McpToolError::invalid_params(
                format!("unknown subtitle format '{other}' — expected 'srt', 'ass', or 'vtt'"),
                None,
            ));
        }
    };
    let (track_id, simplified) =
        crate::commands::mutations::import_subtitles(b, args.body, format, Some("Captions".into()))
            .await
            .map_err(|e| McpToolError::internal_error(e, None))?;
    let msg = if simplified {
        format!("{track_id} (some ASS styling was simplified)")
    } else {
        track_id
    };
    Ok(ToolResult::text(msg))
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
    let snap = b.snapshot_for_read().await?;
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

// Layer-mutation tools (update_layer, update_layer_params, move_layer,
// split_layer, delete_layer, trim_layer), group tools (groups_list, groups_get,
// groups_create, groups_dissolve, groups_add_members, groups_remove_members,
// groups_rename), duplicate_layer, keyframe tools (get_param_track, set_keyframe,
// remove_keyframe, retime_keyframe, set_keyframe_easing, smooth_keyframes,
// clear_keyframes, set_param_track), effect tools (add_effect, update_effect,
// move_effect, remove_effect), composition tools (set_composition,
// fit_composition_to_layers), and marker tools (add_marker, update_marker,
// remove_marker) are deleted — served by the TS actor (Phase 4b T3).

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
        b.read_mirror_handle(),
    );
    Ok(ToolResult::text(id.to_string()))
}

// remove_media, undo, redo, lock_history, unlock_history, checkpoint,
// list_checkpoints, restore_checkpoint, dry_run, set_role_gain, set_role_flags
// are deleted — served by the TS actor (Phase 4b T3).

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
// Motif tools
// ============================================================

/// schemars 0.8 renders `serde_json::Value` as the boolean schema `true`, which
/// the MCP TS-SDK Zod validator rejects (it requires object schemas). Emit `{}`
/// (an unconstrained OBJECT schema) so `client.listTools()` accepts the catalog.
/// Moved here from the deleted `keyframes.rs` (Phase 4b T3).
fn any_object_schema(_gen: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
    schemars::schema::Schema::Object(schemars::schema::SchemaObject::default())
}

// add_motif is deleted — it calls b.project()? (project mutation), served by
// the TS actor (Phase 4b T3).

/// Shared single-id arg for `get_motif_source` + `delete_motif`.
#[cfg(feature = "motifs")]
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct MotifIdArgs {
    /// The Motif id (from `list_motifs`).
    pub id: String,
}

#[cfg(feature = "motifs")]
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct WriteMotifDraftArgs {
    /// Optional id of an existing Motif this draft will UPDATE on install (records
    /// it as the draft's target). Omit for a brand-new Motif (installs as new).
    pub from: Option<String>,
    /// The manifest as a JSON object (its `id`/`version` are ignored — app-assigned).
    /// Shape: `{ name, size:[w,h], default_duration_s, props_schema, ... }` — inspect
    /// a built-in via `get_motif_source` for an exact example. Rejected if malformed.
    #[schemars(schema_with = "any_object_schema")]
    pub manifest: Value,
    /// The HTML body. The manifest island is injected by the app; a
    /// `<script>motif.define({...})</script>` drives the render.
    pub html: String,
}

#[cfg(feature = "motifs")]
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct InstallMotifArgs {
    /// The draft id (from `write_motif_draft`).
    pub draft_id: String,
    /// "new" (publish under the draft's own id) or "update" (republish over the
    /// draft's recorded target; fails if the draft has no target).
    pub mode: String,
}

#[cfg(feature = "motifs")]
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct PreviewMotifDraftArgs {
    /// Motif id (draft / installed / built-in).
    pub id: String,
    /// Content time in seconds to render (e.g. 0 = first frame).
    pub t_sec: f64,
    /// Optional render width (default = the motif's manifest width).
    pub width: Option<u32>,
    /// Optional render height (default = the motif's manifest height).
    pub height: Option<u32>,
    /// Optional props (JSON object); defaults to the manifest defaults.
    #[schemars(schema_with = "any_object_schema")]
    pub props: Option<Value>,
}

#[cfg(feature = "motifs")]
pub(super) async fn list_motifs(
    b: &Backend,
    _args: super::EmptyArgs,
) -> Result<ToolResult, McpToolError> {
    let payload: Vec<Value> = crate::commands::motifs::list_motifs_inner(&b.motif_store)
        .into_iter()
        .map(|mut entry| {
            if let Some(obj) = entry.as_object_mut() {
                obj.remove("html");
            }
            entry
        })
        .collect();
    ToolResult::json(&payload)
}

#[cfg(feature = "motifs")]
pub(super) async fn get_motif_source(
    b: &Backend,
    args: MotifIdArgs,
) -> Result<ToolResult, McpToolError> {
    let source = crate::motifs::authoring_commands::get_motif_source_core(&b.motif_store, &args.id)
        .map_err(|e| McpToolError::invalid_params(e, None))?;
    ToolResult::json(&serde_json::json!({ "manifest": source.manifest, "html": source.html }))
}

#[cfg(feature = "motifs")]
pub(super) async fn write_motif_draft(
    b: &Backend,
    args: WriteMotifDraftArgs,
) -> Result<ToolResult, McpToolError> {
    let manifest: crate::motifs::catalog::Manifest = serde_json::from_value(args.manifest)
        .map_err(|e| McpToolError::invalid_params(format!("invalid manifest: {e}"), None))?;
    let id = crate::motifs::authoring_commands::write_motif_draft_core(
        &b.motif_store,
        manifest,
        &args.html,
        args.from.as_deref(),
    )
    .map_err(|e| McpToolError::invalid_params(e, None))?;
    b.events.emit(
        crate::motifs::authoring_commands::MOTIFS_CHANGED_EVENT,
        serde_json::json!({}),
    );
    Ok(ToolResult::text(id))
}

/// `preview_motif_draft` Rust handler is a stub — capture lives in the JS host.
/// The schema is still advertised so `listTools` includes the tool; the JS
/// server intercepts the call before dispatch reaches this handler.
#[cfg(feature = "motifs")]
pub(super) async fn preview_motif_draft(
    _b: &Backend,
    _args: PreviewMotifDraftArgs,
) -> Result<ToolResult, McpToolError> {
    Err(McpToolError::internal_error(
        "preview_motif_draft is handled by the host process".to_string(),
        None,
    ))
}

#[cfg(feature = "motifs")]
pub(super) async fn install_motif(
    b: &Backend,
    args: InstallMotifArgs,
) -> Result<ToolResult, McpToolError> {
    let mode = match args.mode.as_str() {
        "new" => crate::motifs::authoring_commands::InstallMode::New,
        "update" => {
            let target = b.motif_store.read_draft_target(&args.draft_id).ok_or_else(|| {
                McpToolError::invalid_params(
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
            return Err(McpToolError::invalid_params(
                format!("mode must be 'new' or 'update', got '{other}'"),
                None,
            ));
        }
    };
    let install_args = crate::motifs::authoring_commands::InstallArgs {
        draft_id: args.draft_id,
        mode,
    };
    let published = crate::motifs::authoring_commands::install_motif_core(
        &b.motif_store,
        b.project()?,
        &install_args,
    )
    .await
    .map_err(|e| McpToolError::internal_error(e, None))?;
    b.events.emit(
        crate::motifs::authoring_commands::MOTIFS_CHANGED_EVENT,
        serde_json::json!({}),
    );
    Ok(ToolResult::text(published))
}

#[cfg(feature = "motifs")]
pub(super) async fn delete_motif(
    b: &Backend,
    args: MotifIdArgs,
) -> Result<ToolResult, McpToolError> {
    if crate::motifs::catalog::BUILTIN_IDS.contains(&args.id.as_str()) {
        return Err(McpToolError::invalid_params(
            format!("cannot delete the built-in Motif '{}'", args.id),
            None,
        ));
    }
    crate::motifs::authoring_commands::delete_motif_core(&b.motif_store, &args.id)
        .map_err(|e| McpToolError::internal_error(e, None))?;
    b.events.emit(
        crate::motifs::authoring_commands::MOTIFS_CHANGED_EVENT,
        serde_json::json!({}),
    );
    Ok(ToolResult::empty())
}

// ============================================================
// Tests for the free-fn tool surface.
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ============================================================
    // detect_silences_in_peaks — silence-cut helper
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

    // Tests for audio-role tools (set_role_gain_tool_changes_project,
    // set_role_flags_tool_changes_project) and add_track_via_backend_grows_track_count
    // are deleted along with their handlers (Phase 4b T3).

    // ============================================================
    // Regression: shift_srt(offset=5s) → apply_subtitles → caption
    // track with first layer at t_start_us == 5_000_000.
    //
    // Offset choice: 5_000_000µs × 30fps = 150 whole frames — exactly
    // frame-aligned at the default 30fps composition, so snap_frame_round
    // is a no-op and the assertion can be exact without a tolerance band.
    // ============================================================

    #[cfg(feature = "cloud")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shifted_srt_applies_as_caption_track() {
        use std::sync::Arc;
        let b = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let slice_relative = "1\n00:00:00,000 --> 00:00:01,000\nHi\n";
        let shifted = crate::cloud::srt::shift_srt(slice_relative, 5_000_000);
        let args = serde_json::json!({ "body": shifted, "t_end_us": 1 }).to_string();
        let _ = crate::mcp::catalog::dispatch_tool(&b, "apply_subtitles", &args)
            .await
            .unwrap();
        let snap = b.project().unwrap().snapshot().await;
        let track = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(crate::state::TrackRole::Caption))
            .expect("a Caption-role track must exist after apply_subtitles");
        assert_eq!(
            track.layers[0].t_start_us, 5_000_000,
            "shifted cue must land at t=5s on the timeline"
        );
    }
}

// ============================================================
// Cloud tools: transcribe_clip + synthesize_speech. Gated on feature = "cloud".
// ============================================================

#[cfg(feature = "cloud")]
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub(super) struct TranscribeClipArgs {
    /// Target VideoClip or Audio layer id.
    pub layer_id: String,
    /// Optional transcription window start in timeline microseconds.
    /// Defaults to the layer's `t_start_us`. Must lie within the layer.
    #[serde(default)]
    pub t_start_us: Option<i64>,
    /// Optional transcription window end in timeline microseconds.
    /// Defaults to the layer's `t_end_us`. Must lie within the layer.
    #[serde(default)]
    pub t_end_us: Option<i64>,
    /// Optional ISO-639-1 language hint (`"en"`, `"zh"`). Auto-detect when omitted.
    #[serde(default)]
    pub language: Option<String>,
}

#[cfg(feature = "cloud")]
#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SynthesizeSpeechArgs {
    /// Text to synthesize. tts-1 caps at 4096 characters.
    pub text: String,
    /// Voice identifier. tts-1 accepts: alloy, echo, fable, onyx, nova, shimmer.
    pub voice: String,
    /// 0.25..4.0 for tts-1. Omit to use the provider default (~1.0).
    #[serde(default)]
    pub speed: Option<f32>,
    /// Optional Audio track id. If omitted, lands on the first existing Audio
    /// track or auto-creates one labeled "Voiceover".
    #[serde(default)]
    pub target_track_id: Option<String>,
    /// Optional timeline start in microseconds. Defaults to the composition's
    /// current `duration_us` so the voiceover appends at the end.
    #[serde(default)]
    pub t_start_us: Option<i64>,
}

#[cfg(feature = "cloud")]
#[derive(Debug, Serialize, JsonSchema)]
pub(super) struct SynthesizeSpeechResult {
    pub layer_id: String,
    pub media_id: String,
    pub t_start_us: i64,
    pub t_end_us: i64,
    /// True when the result came from the content-addressed cache and no API
    /// call was made. Surfaced so the agent knows whether to expect any
    /// provider-side billing.
    pub cached: bool,
}

/// Resolved source-audio coordinates for a `transcribe_clip` call.
#[cfg(feature = "cloud")]
#[derive(Debug)]
struct ResolvedClipAudio {
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
#[cfg(feature = "cloud")]
fn resolve_clip_audio_source(
    snap: &crate::state::Project,
    layer_id: LayerId,
    t_start_arg: Option<i64>,
    t_end_arg: Option<i64>,
) -> Result<ResolvedClipAudio, McpToolError> {
    use crate::state::{AudioParams, VideoClipParams};

    let layer = snap
        .tracks
        .iter()
        .flat_map(|t| t.layers.iter())
        .find(|l| l.id == layer_id)
        .ok_or_else(|| {
            McpToolError::invalid_params(
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
            if (*speed - 1.0).abs() > f64::EPSILON {
                return Err(McpToolError::invalid_params(
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
            return Err(McpToolError::invalid_params(
                format!(
                    "layer {layer_id} kind is not transcribable — pass a VideoClip or Audio layer",
                ),
                None,
            ));
        }
    };

    let media = snap.media_pool.get(&media_id).ok_or_else(|| {
        McpToolError::invalid_params(
            format!(
                "layer {layer_id} references missing media {media_id} (project state is inconsistent)",
            ),
            None,
        )
    })?;
    if media.metadata.audio.is_none() {
        return Err(McpToolError::invalid_params(
            format!(
                "media {media_id} has no audio stream — transcription needs audio",
            ),
            None,
        ));
    }

    let t_start = t_start_arg.unwrap_or(layer.t_start_us);
    let t_end = t_end_arg.unwrap_or(layer.t_end_us);
    if t_end <= t_start {
        return Err(McpToolError::invalid_params(
            format!(
                "transcription window must have positive duration (t_start_us={t_start}, t_end_us={t_end})",
            ),
            None,
        ));
    }
    if t_start < layer.t_start_us || t_end > layer.t_end_us {
        return Err(McpToolError::invalid_params(
            format!(
                "transcription window [{t_start}, {t_end}] is outside layer range [{}, {}]",
                layer.t_start_us, layer.t_end_us,
            ),
            None,
        ));
    }

    let offset_in = t_start - layer.t_start_us;
    let offset_out = t_end - layer.t_start_us;
    let source_in = src_in_us + offset_in;
    let source_out = src_in_us + offset_out;
    if source_out > src_out_us {
        return Err(McpToolError::invalid_params(
            format!(
                "transcription window maps past the layer's source range (source_out={source_out} > src_out_us={src_out_us})",
            ),
            None,
        ));
    }

    Ok(ResolvedClipAudio {
        source_path: media.path_abs.clone(),
        source_hash: media.file_hash_blake3.clone(),
        source_in_us: source_in,
        source_out_us: source_out,
        timeline_start_us: t_start,
    })
}

/// Write synthesized audio bytes atomically to the cache. Mirrors the
/// `<dest>.tmp → promote_temp` pattern from the jobs module so an interrupted
/// write never leaves a zero-byte file that `cached_ok` would happily skip.
#[cfg(feature = "cloud")]
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

/// Map a `cloud::CloudError` to an `McpToolError` so the agent sees a structured
/// failure (missing key, invalid key, rate-limited, too-large payload) with
/// actionable recovery steps in the message.
#[cfg(feature = "cloud")]
fn map_cloud_error(e: cloud::CloudError) -> McpToolError {
    use cloud::CloudError as E;
    let message = e.to_string();
    match e {
        E::MissingKey { .. } | E::InvalidKey { .. } => {
            McpToolError::invalid_request(message, None)
        }
        E::PayloadTooLarge { .. } => McpToolError::invalid_params(message, None),
        E::RateLimited { .. } | E::Provider { .. } | E::Network(_) => {
            McpToolError::internal_error(message, None)
        }
        E::Io(_) | E::AudioExtract(_) => McpToolError::internal_error(message, None),
    }
}

#[cfg(feature = "cloud")]
pub(super) async fn transcribe_clip(
    b: &Backend,
    args: TranscribeClipArgs,
) -> Result<ToolResult, McpToolError> {
    let log_op_id = uuid::Uuid::now_v7();
    let log_args = serde_json::to_value(&args).ok();
    b.log_slot.emit(crate::logs::LogEntryInput {
        level: crate::logs::LogLevel::Info,
        category: crate::logs::LogCategory::Mcp,
        source: crate::logs::LogSource::Agent { client: "mcp".into() },
        message: "MCP: transcribe_clip started".into(),
        op_id: Some(log_op_id),
        op_state: Some(crate::logs::OpState::Started),
        details: log_args,
        ..Default::default()
    });
    let result = transcribe_clip_inner(b, args).await;
    match &result {
        Ok(_) => b.log_slot.emit(crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Info,
            category: crate::logs::LogCategory::Mcp,
            source: crate::logs::LogSource::Agent { client: "mcp".into() },
            message: "MCP: transcribe_clip done".into(),
            op_id: Some(log_op_id),
            op_state: Some(crate::logs::OpState::Ok),
            ..Default::default()
        }),
        Err(e) => b.log_slot.emit(crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Error,
            category: crate::logs::LogCategory::Mcp,
            source: crate::logs::LogSource::Agent { client: "mcp".into() },
            message: format!("MCP: transcribe_clip failed: {e}"),
            op_id: Some(log_op_id),
            op_state: Some(crate::logs::OpState::Err),
            ..Default::default()
        }),
    }
    result
}

#[cfg(feature = "cloud")]
async fn transcribe_clip_inner(
    b: &Backend,
    args: TranscribeClipArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let snap = b.snapshot_for_read().await?;
    let resolved = resolve_clip_audio_source(
        &snap,
        layer_id,
        args.t_start_us,
        args.t_end_us,
    )?;

    let transcriber = {
        let keys = b.cloud_keys.lock().expect("cloud_keys poisoned");
        cloud::pick_transcriber(&keys)
    }
    .ok_or_else(|| {
        McpToolError::invalid_request(
            "no transcription provider configured — open Settings → API keys and add an OpenAI API key",
            None,
        )
    })?;

    let audio_path = cloud::audio_extract::extract_audio_window(
        &b.cache,
        &resolved.source_path,
        &resolved.source_hash,
        resolved.source_in_us,
        resolved.source_out_us,
    )
    .await
    .map_err(|e| McpToolError::internal_error(format!("audio extract: {e:#}"), None))?;

    let resp = transcriber
        .transcribe(cloud::TranscribeRequest {
            audio_path,
            language: args.language,
        })
        .await
        .map_err(map_cloud_error)?;

    let shifted = cloud::srt::shift_srt(&resp.srt_body, resolved.timeline_start_us);
    Ok(ToolResult::text(shifted))
}

/// TTS compute half of the `synthesize_speech` hybrid (Phase 3d-e).
/// Validates the text, picks the synthesizer, checks the content-addressed
/// cache, synthesizes+writes the audio if needed, probes it for duration,
/// and builds the `MediaItem`. Does NOT write to the project actor — that is
/// the TS host's job. Returns `(MediaItem, cached)`.
#[cfg(feature = "cloud")]
pub(crate) async fn synthesize_speech_audio(
    b: &Backend,
    args: &SynthesizeSpeechArgs,
) -> Result<(crate::state::MediaItem, bool), McpToolError> {
    use crate::cache::cached_ok;
    use crate::state::{MediaItem, MediaKind, new_id};
    use crate::io::probe;

    if args.text.trim().is_empty() {
        return Err(McpToolError::invalid_params("text is empty", None));
    }

    let synthesizer = {
        let keys = b.cloud_keys.lock().expect("cloud_keys poisoned");
        cloud::pick_synthesizer(&keys)
    }
    .ok_or_else(|| {
        McpToolError::invalid_request(
            "no TTS provider configured — open Settings → API keys and add an OpenAI API key",
            None,
        )
    })?;

    let cache_key = cloud::providers::openai::tts_cache_key(
        &args.text,
        &args.voice,
        args.speed,
    );
    // Cache extension hardcoded "mp3": the only TTS provider pins
    // `response_format=mp3`. The `debug_assert!` below trips in dev the first time
    // a provider returns a different format — fix the extension-from-response here.
    // TODO: pull extension from `resp.format` once a non-mp3 TTS provider lands.
    let dest = b.cache.voiceover(&cache_key, "mp3");
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
            "TTS cache extension assumes mp3 output; update it before adding non-mp3 providers",
        );
        write_voiceover_atomic(&dest, &resp.audio)
            .await
            .map_err(|e| {
                McpToolError::internal_error(format!("write voiceover: {e:#}"), None)
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
    .map_err(|e| McpToolError::internal_error(format!("probe join: {e}"), None))?
    .map_err(|e| McpToolError::internal_error(e, None))?;

    Ok((media_item, cached))
}

#[cfg(feature = "cloud")]
pub(super) async fn synthesize_speech(
    b: &Backend,
    args: SynthesizeSpeechArgs,
) -> Result<ToolResult, McpToolError> {
    let (media_item, cached) = synthesize_speech_audio(b, &args).await?;

    let duration_us = media_item.metadata.duration_us.unwrap_or(0);
    let media_item_for_jobs = media_item.clone();
    let media_id = b
        .project()?
        .add_media_item(agent_actor(), media_item)
        .await
        .map_err(map_command_error)?;
    // Fan out background jobs (waveform; thumbnails skip on audio-only).
    crate::jobs::enqueue_for_media(
        b.events.clone(),
        b.cache.clone(),
        b.project()?.clone(),
        media_item_for_jobs,
        b.read_mirror_handle(),
    );

    let snap = b.project()?.snapshot().await;
    let t_start_us = args.t_start_us.unwrap_or(snap.composition.duration_us);
    let t_end_us = t_start_us + duration_us;

    let track_id = match args.target_track_id.as_deref() {
        Some(s) => parse_uuid(s, "target_track_id")?,
        None => ensure_audio_track(b).await?,
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
        // TTS narration → Voiceover bus (`docs/audio.md`).
        role: AudioRole::Voiceover,
    });
    let layer_id = b
        .project()?
        .add_layer(agent_actor(), track_id, params, t_start_us, t_end_us)
        .await
        .map_err(map_command_error)?;

    ToolResult::json(&SynthesizeSpeechResult {
        layer_id: layer_id.to_string(),
        media_id: media_id.to_string(),
        t_start_us,
        t_end_us,
        cached,
    })
}
