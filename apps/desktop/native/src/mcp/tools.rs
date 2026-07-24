//! MCP tool functions, transport-free. Each tool is a
//! `pub(super) async fn <name>(b: &Backend, args: <Args>) -> Result<ToolResult, McpToolError>`.
//! Each tool returns `ToolResult` / `McpToolError`. Errors map 1:1 onto the MCP
//! error model in `wire.rs`.
//!
//! Only the native/compute/hybrid-compute tool handlers live here.
//! The ~47 TS-executed mutation handlers are deleted; the TS actor serves them.
//! Cloud tools (transcribe/synthesize) are gated on `feature = "speech"`.

use chrono::Utc;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[cfg(feature = "speech")]
use crate::speech;

#[cfg(feature = "jobs")]
use crate::cache::cached_ok;
#[cfg(feature = "jobs")]
use crate::jobs;
use uuid::Uuid;

use crate::napi_backend::Backend;
use crate::state::{LayerId, LayerParams};

use super::wire::{McpToolError, ToolResult};
use super::EmptyArgs;

// ============================================================
// Shared helpers
// ============================================================

// `agent_actor` + `map_command_error` (the Agent-actor stamp + the structured
// CommandError→MCP error mapper) were used only by the deleted/stubbed mutation
// handlers (add_*, import_media, install_motif, synthesize_speech). The kept
// read/compute tools don't write the actor, so both are absent here.

pub(super) fn parse_uuid(s: &str, field: &str) -> Result<Uuid, McpToolError> {
    Uuid::parse_str(s)
        .map_err(|e| McpToolError::invalid_params(format!("{field} not a UUID: {e}"), None))
}

// ============================================================
// Liveness
// ============================================================

pub(super) async fn ping(_b: &Backend, _args: EmptyArgs) -> Result<ToolResult, McpToolError> {
    Ok(ToolResult::text("pong"))
}

// `begin_agent_session` routes to the TS actor (it is a `'ts'` MCP tool, so
// `mergeMcpCatalog` filters it out of the Rust catalog and the TS def supplies
// it). It has no Rust handler / args / catalog entry.

// Track and layer mutation tools (add_track, remove_track, move_track,
// add_color_layer, add_video_layer, update_layer, update_layer_params,
// move_layer, trim_layer, delete_layer, split_layer, duplicate_layer) are
// absent — they are served by the TS actor.

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

/// `apply_subtitles` Rust handler is a stub — the tool routes through the hybrid
/// orchestrator (parse_subtitles napi compute → TS-actor add_caption_track write);
/// the schema stays so `listTools` advertises it, but the TS host intercepts the
/// call before dispatch reaches this handler.
pub(super) async fn apply_subtitles(
    _b: &Backend,
    _args: ApplySubtitlesArgs,
) -> Result<ToolResult, McpToolError> {
    Err(McpToolError::internal_error(
        "apply_subtitles is handled by the host process (TS actor hybrid)".to_string(),
        None,
    ))
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
    /// Injected by the TS MCP host (sole state owner) — the layer resolved by
    /// `layer_id` and its `MediaItem`. `#[schemars(skip)]` keeps them OUT of the
    /// advertised tool schema; serde still deserializes them. `None` on a direct
    /// Rust call → the handler produces the same not-found error.
    #[serde(default)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
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
    let layer = args
        .layer
        .as_ref()
        .ok_or_else(|| McpToolError::invalid_params(format!("layer {layer_id} not found"), None))?;

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
    let media = args.media.as_ref().ok_or_else(|| {
        McpToolError::invalid_params(
            format!("layer {layer_id} references missing media {media_id}"),
            None,
        )
    })?;
    let waveform_path = b.cache.waveform(&media.file_hash_blake3);
    crate::cache::touch_if_stale(&waveform_path);
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

    let peaks_file = jobs::read_peaks_file(&waveform_path)
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
        &peaks_file.peaks,
        threshold_amp,
        min_silence_us,
        src_in_us,
        src_out_us,
        layer.t_start_us,
        peaks_file.sample_rate,
        peaks_file.frames_per_peak,
    );

    ToolResult::json(&regions)
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct AnalyzeClipArgs {
    /// Target VideoClip layer id.
    pub layer_id: String,
    /// Cut sensitivity in [0.0, 1.0]: a frame whose shot-change score exceeds
    /// this starts a new shot. Lower = more (finer) cuts. Default 0.4.
    pub sensitivity: Option<f32>,
    /// Minimum shot duration (microseconds); cuts closer than this are merged.
    /// Default 500000 (0.5 seconds).
    pub min_shot_us: Option<i64>,
    /// Which passes to run — a subset of `["shots", "stats", "events"]`.
    /// Default all. Drop `"stats"` / `"events"` to skip per-shot frame sampling
    /// and return timing only.
    pub passes: Option<Vec<String>>,
    /// Injected by the TS MCP host (sole state owner) — see DetectSilencesArgs.
    #[serde(default)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
}

#[cfg(feature = "jobs")]
pub(super) async fn analyze_clip(
    b: &Backend,
    args: AnalyzeClipArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let layer = args
        .layer
        .as_ref()
        .ok_or_else(|| McpToolError::invalid_params(format!("layer {layer_id} not found"), None))?;

    // Video-only: shots are a pixel concept. Reject anything else with an
    // actionable message (mirrors detect_silences).
    let (media_id, src_in_us, src_out_us) = match &layer.params {
        LayerParams::VideoClip(p) => (p.media, p.src_in_us, p.src_out_us),
        _ => {
            return Err(McpToolError::invalid_params(
                format!("layer {layer_id} kind is not analyzable for shots — pass a VideoClip layer"),
                None,
            ));
        }
    };
    let media = args.media.as_ref().ok_or_else(|| {
        McpToolError::invalid_params(
            format!("layer {layer_id} references missing media {media_id}"),
            None,
        )
    })?;
    if !matches!(media.kind, crate::state::MediaKind::Video) {
        return Err(McpToolError::invalid_params(
            format!("media {media_id} is not a video — analyze_clip needs a video source"),
            None,
        ));
    }

    let sensitivity = args.sensitivity.unwrap_or(0.4);
    if !(0.0..=1.0).contains(&sensitivity) {
        return Err(McpToolError::invalid_params(
            format!("sensitivity {sensitivity} must be in [0.0, 1.0]"),
            None,
        ));
    }
    let min_shot_us = args.min_shot_us.unwrap_or(500_000);
    if min_shot_us <= 0 {
        return Err(McpToolError::invalid_params(
            format!("min_shot_us {min_shot_us} must be positive"),
            None,
        ));
    }

    // Passes: default all. Unknown tags are rejected so a typo never silently
    // drops a pass. "shots" is always the base; "stats"/"events" gate the
    // per-shot frame sampling.
    let (mut want_stats, mut want_events) = (true, true);
    if let Some(passes) = &args.passes {
        want_stats = passes.iter().any(|p| p == "stats");
        want_events = passes.iter().any(|p| p == "events");
        for p in passes {
            if !matches!(p.as_str(), "shots" | "stats" | "events") {
                return Err(McpToolError::invalid_params(
                    format!("unknown pass {p:?}; expected \"shots\", \"stats\", or \"events\""),
                    None,
                ));
            }
        }
    }

    let opts = jobs::shot::ShotOpts {
        sensitivity,
        min_shot_us,
        stats: want_stats,
        events: want_events,
    };
    // Content-addressed write-through: compute the WHOLE-source report once
    // (keyed by source hash + params, `jobs::shot::cache_key`), cache it, then
    // clip to THIS layer's window. A second call on any layer of the same source
    // with the same params hits the sidecar and skips the ffmpeg scan; the cache
    // shares no namespace with the video-understanding `description` sidecar.
    let source_report = jobs::shot::cached_source_report(&b.cache, media, &opts)
        .await
        .map_err(|e| McpToolError::internal_error(format!("shot analysis: {e:#}"), None))?;
    let report = jobs::shot::clip_report(&source_report, src_in_us, src_out_us);

    ToolResult::json(&report)
}

/// One side of a `compare_frames` pair. `#[schemars(skip)]` on the injected
/// `layer` / `media` keeps each side's ADVERTISED schema exactly
/// `{ layer_id, t_us }`; serde still deserializes the host-injected slice.
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct FrameRef {
    /// Target VideoClip layer id.
    pub layer_id: String,
    /// SOURCE-ABSOLUTE timestamp (microseconds) of the frame to sample — the
    /// same coordinate space as `media://{id}/frame/<t_us>` and the
    /// `keyframe_t_us` / `t_*_us` that `analyze_clip` returns, so a shot cover
    /// frame can be fed straight in.
    pub t_us: i64,
    /// Injected by the TS MCP host (sole state owner) — the layer resolved by
    /// `layer_id` and its `MediaItem`; see DetectSilencesArgs. `None` on a direct
    /// Rust call → the handler produces the same not-found error.
    #[serde(default)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct CompareFramesArgs {
    /// First frame to compare.
    pub a: FrameRef,
    /// Second frame to compare.
    pub b: FrameRef,
}

/// Resolve one `FrameRef` to `(source_path, t_us)`: the layer must be a VideoClip
/// whose media is a video (same guards as `analyze_clip`). `side` ("a" / "b") is
/// folded into every error so the agent knows which frame is at fault.
#[cfg(feature = "jobs")]
fn resolve_frame_ref(
    r: &FrameRef,
    side: &str,
) -> Result<(std::path::PathBuf, i64), McpToolError> {
    let layer_id = parse_uuid(&r.layer_id, &format!("{side}.layer_id"))?;
    let layer = r.layer.as_ref().ok_or_else(|| {
        McpToolError::invalid_params(format!("{side}: layer {layer_id} not found"), None)
    })?;
    let media_id = match &layer.params {
        LayerParams::VideoClip(p) => p.media,
        _ => {
            return Err(McpToolError::invalid_params(
                format!("{side}: layer {layer_id} is not a VideoClip — compare_frames compares video frames only"),
                None,
            ));
        }
    };
    let media = r.media.as_ref().ok_or_else(|| {
        McpToolError::invalid_params(
            format!("{side}: layer {layer_id} references missing media {media_id}"),
            None,
        )
    })?;
    if !matches!(media.kind, crate::state::MediaKind::Video) {
        return Err(McpToolError::invalid_params(
            format!("{side}: media {media_id} is not a video — compare_frames needs a video source"),
            None,
        ));
    }
    if r.t_us < 0 {
        return Err(McpToolError::invalid_params(
            format!("{side}.t_us {} must be >= 0", r.t_us),
            None,
        ));
    }
    Ok((media.path_abs.clone(), r.t_us))
}

/// `compare_frames` — pairwise perceptual similarity of two video frames.
/// Read-only and cacheless (a pure function, per the ticket): sample one frame
/// per side at its source-absolute `t_us` through the same PNG extract as the
/// shot stats, then a DCT perceptual hash + MSSIM fused into a `similar` verdict.
/// Works across two different clips as well as within one.
#[cfg(feature = "jobs")]
pub(super) async fn compare_frames(
    _b: &Backend,
    args: CompareFramesArgs,
) -> Result<ToolResult, McpToolError> {
    let (path_a, t_a) = resolve_frame_ref(&args.a, "a")?;
    let (path_b, t_b) = resolve_frame_ref(&args.b, "b")?;

    let tmp = tempfile::Builder::new()
        .prefix("weftcut-cmp")
        .tempdir()
        .map_err(|e| McpToolError::internal_error(format!("temp dir: {e}"), None))?;
    let img_a = jobs::shot::extract_rgb(&path_a, t_a, &tmp.path().join("a.png"))
        .await
        .map_err(|e| McpToolError::internal_error(format!("frame a extract: {e:#}"), None))?;
    let img_b = jobs::shot::extract_rgb(&path_b, t_b, &tmp.path().join("b.png"))
        .await
        .map_err(|e| McpToolError::internal_error(format!("frame b extract: {e:#}"), None))?;

    ToolResult::json(&jobs::shot::sim::compare_frames(&img_a, &img_b))
}

// Layer-mutation tools (update_layer, update_layer_params, move_layer,
// split_layer, delete_layer, trim_layer), group mutation tools
// (groups_create, groups_dissolve, groups_add_members, groups_remove_members,
// groups_rename), duplicate_layer, keyframe tools (get_param_track, set_keyframe,
// remove_keyframe, retime_keyframe, set_keyframe_easing, smooth_keyframes,
// clear_keyframes, set_param_track), effect tools (add_effect, update_effect,
// move_effect, remove_effect), composition tools (set_composition,
// fit_composition_to_layers), and marker tools (add_marker, update_marker,
// remove_marker) are absent — served by the TS actor.

// ============================================================
// Media tools
// ============================================================

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct ImportMediaArgs {
    /// Absolute path to a video / audio / image / subtitle file the host can read.
    pub path: String,
}

/// `import_media` Rust handler is a stub — the tool routes through the hybrid
/// orchestrator (probe_media napi compute → TS-actor write); the schema stays so
/// `listTools` advertises it, but the TS host intercepts the call before dispatch
/// reaches this handler (the hybrid pattern).
#[cfg(feature = "jobs")]
pub(super) async fn import_media(
    _b: &Backend,
    _args: ImportMediaArgs,
) -> Result<ToolResult, McpToolError> {
    Err(McpToolError::internal_error(
        "import_media is handled by the host process (TS actor hybrid)".to_string(),
        None,
    ))
}

// remove_media, undo, redo, lock_history, unlock_history, checkpoint,
// list_checkpoints, restore_checkpoint, dry_run, set_role_gain, set_role_flags
// are absent — served by the TS actor.

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
    sample_rate: u32,
    frames_per_peak: u32,
) -> Vec<SilenceRegion> {
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
                    sample_rate,
                    frames_per_peak,
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
            sample_rate,
            frames_per_peak,
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
    sample_rate: u32,
    frames_per_peak: u32,
    min_silence_us: i64,
    src_in_us: i64,
    src_out_us: i64,
    layer_t_start_us: i64,
) {
    let peak_time_us = |idx: usize| -> i64 {
        ((idx as i128 * frames_per_peak as i128 * 1_000_000) / sample_rate as i128) as i64
    };
    let src_silence_start = peak_time_us(start_idx);
    let src_silence_end = peak_time_us(end_idx);
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
        let regions = detect_silences_in_peaks(&peaks, 0.02, 500_000, 0, 5_000_000, 0, 100, 1);
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
        let regions = detect_silences_in_peaks(&peaks, 0.02, 500_000, 0, 2_000_000, 0, 100, 1);
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
        let regions = detect_silences_in_peaks(&peaks, 0.02, 500_000, 0, 2_000_000, 0, 100, 1);
        assert!(regions.is_empty(), "expected no regions, got {regions:?}");

        // With min_silence_us=200_000 (200ms) all three should be returned.
        let regions = detect_silences_in_peaks(&peaks, 0.02, 200_000, 0, 2_000_000, 0, 100, 1);
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
        let regions = detect_silences_in_peaks(&peaks, 0.02, 500_000, 0, 2_000_000, 0, 100, 1);
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
        let regions =
            detect_silences_in_peaks(&peaks, 0.02, 500_000, 0, 2_000_000, 5_000_000, 100, 1);
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
            &peaks, 0.02, 100_000, 300_000,   // src_in_us
            1_700_000, // src_out_us
            0,         // layer_t_start_us
            100, 1,
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
        let regions = detect_silences_in_peaks(&peaks, 0.02, 100_000, 0, 2_000_000, 0, 100, 1);
        assert!(regions.is_empty());

        // Just below threshold → silence.
        let peaks = flat_peaks(200, 0.019);
        let regions = detect_silences_in_peaks(&peaks, 0.02, 100_000, 0, 2_000_000, 0, 100, 1);
        assert_eq!(regions.len(), 1);
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn detect_silences_uses_rational_peak_timebase_without_long_drift() {
        let mut peaks = flat_peaks(800, 0.5);
        for peak in &mut peaks[783..790] {
            *peak = 0.0;
        }
        let regions = detect_silences_in_peaks(&peaks, 0.02, 1, 0, 200_000_000, 0, 22_050, 2_816);
        assert_eq!(regions.len(), 1);
        assert_eq!(
            regions[0].t_start_us,
            (783_i128 * 2_816 * 1_000_000 / 22_050) as i64
        );
        assert_eq!(
            regions[0].t_end_us,
            (790_i128 * 2_816 * 1_000_000 / 22_050) as i64
        );
    }

    // Tests for audio-role tools, add_track, and the apply_subtitles caption-track
    // build are absent along with their handlers: those tools are
    // TS-served or hybrid stubs. The subtitle cue-shift + parse path is covered by
    // the subtitles module tests + the TS-side hybrid e2e.
}

// ============================================================
// Cloud tools: transcribe_clip + synthesize_speech. Gated on feature = "speech".
// ============================================================

#[cfg(feature = "speech")]
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
    /// Optional STRICT backend override: `"openai"` | `"whisper_cpp"` |
    /// `"funasr"`. When set, that engine serves the request or the call errors
    /// naming its exact gap (missing key / binary / model) — it never
    /// substitutes another engine, so an explicit local choice can never leak
    /// audio to a cloud provider. When omitted, the resolver walks the user's
    /// preference then availability. An unknown value is rejected.
    #[serde(default)]
    pub backend: Option<String>,
    /// Injected by the TS MCP host from the user's Settings preferred-engine —
    /// a SOFT hint (falls back by availability), unlike the agent-visible
    /// strict `backend` above. Unknown tags are ignored. Never advertised.
    #[serde(default)]
    #[schemars(skip)]
    pub preferred_backend: Option<String>,
    /// Request exact per-word timestamps when the chosen backend can emit them
    /// (whisper.cpp → `-ojf`). Defaults to `true` — the backend's best
    /// precision, at no extra engine cost; pass `false` to force the SRT-style
    /// (interpolated) output instead. OpenAI Whisper is SRT-only and ignores
    /// it either way; check `word_timing` in the result for what you got.
    #[serde(default)]
    pub word_timestamps: Option<bool>,
    /// Injected by the TS MCP host (sole state owner) — see DetectSilencesArgs.
    /// `skip_serializing` keeps the slice out of the tool's log details.
    #[serde(default, skip_serializing)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default, skip_serializing)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
}

#[cfg(feature = "speech")]
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

/// Resolved source-audio coordinates for a `transcribe_clip` call.
#[cfg(feature = "speech")]
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
#[cfg(feature = "speech")]
fn resolve_clip_audio_source(
    layer: Option<&crate::state::Layer>,
    media: Option<&crate::state::MediaItem>,
    layer_id: LayerId,
    t_start_arg: Option<i64>,
    t_end_arg: Option<i64>,
) -> Result<ResolvedClipAudio, McpToolError> {
    use crate::state::{AudioParams, VideoClipParams};

    let layer = layer
        .ok_or_else(|| McpToolError::invalid_params(format!("layer {layer_id} not found"), None))?;

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
        LayerParams::Audio(AudioParams {
            media,
            src_in_us,
            src_out_us,
            ..
        }) => (*media, *src_in_us, *src_out_us),
        _ => {
            return Err(McpToolError::invalid_params(
                format!(
                    "layer {layer_id} kind is not transcribable — pass a VideoClip or Audio layer",
                ),
                None,
            ));
        }
    };

    let media = media.ok_or_else(|| {
        McpToolError::invalid_params(
            format!(
                "layer {layer_id} references missing media {media_id} (project state is inconsistent)",
            ),
            None,
        )
    })?;
    if media.metadata.audio.is_none() {
        return Err(McpToolError::invalid_params(
            format!("media {media_id} has no audio stream — transcription needs audio",),
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
#[cfg(feature = "speech")]
async fn write_voiceover_atomic(dest: &std::path::Path, bytes: &[u8]) -> Result<(), anyhow::Error> {
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

/// Map a `speech::SpeechError` to an `McpToolError` so the agent sees a structured
/// failure (missing key, invalid key, rate-limited, too-large payload) with
/// actionable recovery steps in the message.
#[cfg(feature = "speech")]
fn map_speech_error(e: speech::SpeechError) -> McpToolError {
    use speech::SpeechError as E;
    let message = e.to_string();
    match e {
        E::MissingKey { .. } | E::InvalidKey { .. } => McpToolError::invalid_request(message, None),
        E::PayloadTooLarge { .. } => McpToolError::invalid_params(message, None),
        E::RateLimited { .. } | E::Provider { .. } | E::Network(_) => {
            McpToolError::internal_error(message, None)
        }
        E::Io(_) | E::AudioExtract(_) | E::Parse(_) => {
            McpToolError::internal_error(message, None)
        }
        // Local CLI-sidecar failures (whisper.cpp / FunASR): the message already
        // carries the exit code + engine stderr / the spawn cause / the timeout.
        E::EngineExit { .. } | E::Spawn { .. } | E::Timeout { .. } => {
            McpToolError::internal_error(message, None)
        }
    }
}

/// JSON envelope `transcribe_clip` returns: the normalized transcript
/// (`segments` with per-word spans, detected `language`, `word_timing`
/// provenance), the `backend` tag that actually served the request (so a
/// fallback pick is visible, not silent), PLUS a rendered `srt` field. The
/// agent inspects `segments` for word-level editing and pipes `srt` straight
/// into `apply_subtitles` (which still expects an SRT body). Borrows the
/// transcript so we serialize without cloning the segment vec.
#[cfg(feature = "speech")]
#[derive(Serialize)]
struct TranscribeClipResult<'a> {
    backend: &'a str,
    segments: &'a [speech::Segment],
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<&'a str>,
    word_timing: speech::WordTiming,
    srt: String,
}

#[cfg(feature = "speech")]
pub(super) async fn transcribe_clip(
    b: &Backend,
    args: TranscribeClipArgs,
) -> Result<ToolResult, McpToolError> {
    let log_op_id = uuid::Uuid::now_v7();
    let log_args = serde_json::to_value(&args).ok();
    b.log_slot.emit(crate::logs::LogEntryInput {
        level: crate::logs::LogLevel::Info,
        category: crate::logs::LogCategory::Mcp,
        source: crate::logs::LogSource::Agent {
            client: "mcp".into(),
        },
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
            source: crate::logs::LogSource::Agent {
                client: "mcp".into(),
            },
            message: "MCP: transcribe_clip done".into(),
            op_id: Some(log_op_id),
            op_state: Some(crate::logs::OpState::Ok),
            ..Default::default()
        }),
        Err(e) => b.log_slot.emit(crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Error,
            category: crate::logs::LogCategory::Mcp,
            source: crate::logs::LogSource::Agent {
                client: "mcp".into(),
            },
            message: format!("MCP: transcribe_clip failed: {e}"),
            op_id: Some(log_op_id),
            op_state: Some(crate::logs::OpState::Err),
            ..Default::default()
        }),
    }
    result
}

#[cfg(feature = "speech")]
async fn transcribe_clip_inner(
    b: &Backend,
    args: TranscribeClipArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let resolved = resolve_clip_audio_source(
        args.layer.as_ref(),
        args.media.as_ref(),
        layer_id,
        args.t_start_us,
        args.t_end_us,
    )?;

    // Explicit `backend` arg → STRICT (that engine or an error naming its
    // gap; never a silent substitute — the caller may have chosen local for
    // privacy). Unknown tag → clean invalid_params, matched against the stable
    // `as_str` wire tag (not the serde form), same idiom as
    // commands::speech::parse_backend.
    let explicit = match args.backend.as_deref() {
        None => None,
        Some(tag) => Some(
            speech::SpeechBackend::all()
                .iter()
                .copied()
                .find(|b| b.as_str() == tag)
                .ok_or_else(|| {
                    McpToolError::invalid_params(
                        format!(
                            "unknown backend {tag:?}; expected \"openai\", \"whisper_cpp\", or \"funasr\""
                        ),
                        None,
                    )
                })?,
        ),
    };
    // Host-injected user preference → SOFT hint for the resolver's
    // preference-then-availability walk. Unknown/absent tags fall to None.
    let preferred = args.preferred_backend.as_deref().and_then(|tag| {
        speech::SpeechBackend::all()
            .iter()
            .copied()
            .find(|b| b.as_str() == tag)
    });

    let (used_backend, transcriber) = {
        let cfg = b.speech_config.lock().expect("speech_config poisoned");
        match explicit {
            Some(b) => (
                b,
                // Strict-resolution failures are the caller's/config's to fix
                // (wrong choice or missing key/binary/model) → invalid_request,
                // not internal_error.
                speech::resolve_transcriber_exact(b, &cfg)
                    .map_err(|e| McpToolError::invalid_request(e.to_string(), None))?,
            ),
            None => speech::resolve_transcriber(preferred, &cfg).ok_or_else(|| {
                McpToolError::invalid_request(speech::NO_TRANSCRIBER_CONFIGURED, None)
            })?,
        }
    };

    let audio_path = speech::audio_extract::extract_audio_window(
        &b.cache,
        &resolved.source_path,
        &resolved.source_hash,
        resolved.source_in_us,
        resolved.source_out_us,
    )
    .await
    .map_err(|e| McpToolError::internal_error(format!("audio extract: {e:#}"), None))?;

    let raw = transcriber
        .transcribe(speech::TranscribeRequest {
            audio_path,
            language: args.language,
            // Default TRUE: exact word timing costs the engine nothing extra
            // (whisper.cpp computes token offsets regardless; `-ojf` just emits
            // them), and word-level editing is the point of the normalized
            // transcript. `false` is an explicit opt-down to SRT style;
            // SRT-only backends (OpenAI) ignore the hint either way.
            want_word_timing: args.word_timestamps.unwrap_or(true),
        })
        .await
        .map_err(map_speech_error)?;

    // Normalize the backend's raw style → one Transcript, then place the
    // audio-slice-relative times on the timeline.
    let mut transcript = speech::parse_raw(raw).map_err(map_speech_error)?;
    transcript.shift(resolved.timeline_start_us);

    let srt = transcript.render_srt();
    let result = TranscribeClipResult {
        backend: used_backend.as_str(),
        segments: &transcript.segments,
        language: transcript.language.as_deref(),
        word_timing: transcript.word_timing,
        srt,
    };
    ToolResult::json(&result)
}

// ============================================================
// Video-understanding tool: describe_clip. Gated on feature = "speech" (reuses
// jobs ffmpeg for frame sampling + the speech HTTP client for cloud/BYO). The
// architectural twin of transcribe_clip; see native/src/vlm/.
// ============================================================

#[cfg(feature = "speech")]
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct DescribeClipArgs {
    /// Target VideoClip layer id.
    pub layer_id: String,
    /// Optional window start in timeline microseconds. Defaults to the layer's
    /// `t_start_us`. Must lie within the layer.
    #[serde(default)]
    pub t_start_us: Option<i64>,
    /// Optional window end in timeline microseconds. Defaults to the layer's
    /// `t_end_us`. Must lie within the layer.
    #[serde(default)]
    pub t_end_us: Option<i64>,
    /// Frames sampled per second across the window (default 1.0). Higher = finer
    /// temporal detail at more cost; capped so the frame set fits the model's
    /// context.
    #[serde(default)]
    pub fps: Option<f64>,
    /// Prompt focus: `"general"` (default) or `"shot-type"` (biases `tags`
    /// toward shot type / camera).
    #[serde(default)]
    pub focus: Option<String>,
    /// Optional STRICT backend override: `"qwen3_vl"` | `"minicpm_v"` |
    /// `"byo_endpoint"` | `"cloud"`. When set, that engine serves the request or
    /// the call errors naming its exact gap — it never substitutes another
    /// engine, so an explicit local choice can never leak frames to the cloud.
    /// When omitted, selection is preference then availability. Unknown → rejected.
    #[serde(default)]
    pub backend: Option<String>,
    /// Injected by the TS MCP host from the user's Settings preferred VLM engine
    /// — a SOFT hint (falls back by availability). Never advertised.
    #[serde(default)]
    #[schemars(skip)]
    pub preferred_backend: Option<String>,
    /// Injected by the TS MCP host: the merged video-understanding backend
    /// config snapshot (cloud key + local paths + endpoint), keyed by backend
    /// tag. The subsystem is stateless (ADR 0024) — unlike transcribe_clip, VLM
    /// config is not held on `Backend`; it rides in with the call. `#[schemars(skip)]`
    /// keeps it out of the advertised schema; empty → "no backend available".
    #[serde(default)]
    #[schemars(skip)]
    pub vlm_config: std::collections::HashMap<String, crate::vlm::BackendConfig>,
    /// Injected by the TS MCP host (sole state owner) — see DetectSilencesArgs.
    #[serde(default)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
}

/// Resolved source-video coordinates for a `describe_clip` call.
#[cfg(feature = "speech")]
#[derive(Debug)]
struct ResolvedClipVideo {
    source_path: std::path::PathBuf,
    source_hash: String,
    /// Source-relative microseconds: the window mapped onto the source.
    source_in_us: i64,
    source_out_us: i64,
}

/// Find a VideoClip layer, validate the requested timeline window lies inside
/// it, and map that window onto the source media's coordinate space. Mirrors
/// `resolve_clip_audio_source` but video-only (frames, not audio).
#[cfg(feature = "speech")]
fn resolve_clip_video_source(
    layer: Option<&crate::state::Layer>,
    media: Option<&crate::state::MediaItem>,
    layer_id: LayerId,
    t_start_arg: Option<i64>,
    t_end_arg: Option<i64>,
) -> Result<ResolvedClipVideo, McpToolError> {
    use crate::state::VideoClipParams;

    let layer = layer
        .ok_or_else(|| McpToolError::invalid_params(format!("layer {layer_id} not found"), None))?;

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
                        "describe_clip does not yet support speed != 1.0 (layer speed={speed}); \
                         split off a speed-1 segment first",
                    ),
                    None,
                ));
            }
            (*media, *src_in_us, *src_out_us)
        }
        _ => {
            return Err(McpToolError::invalid_params(
                format!("layer {layer_id} kind is not describable — pass a VideoClip layer"),
                None,
            ));
        }
    };

    let media = media.ok_or_else(|| {
        McpToolError::invalid_params(
            format!(
                "layer {layer_id} references missing media {media_id} (project state is inconsistent)",
            ),
            None,
        )
    })?;
    if !matches!(media.kind, crate::state::MediaKind::Video) {
        return Err(McpToolError::invalid_params(
            format!("media {media_id} is not a video — describe_clip needs a video source"),
            None,
        ));
    }

    let t_start = t_start_arg.unwrap_or(layer.t_start_us);
    let t_end = t_end_arg.unwrap_or(layer.t_end_us);
    if t_end <= t_start {
        return Err(McpToolError::invalid_params(
            format!(
                "description window must have positive duration (t_start_us={t_start}, t_end_us={t_end})",
            ),
            None,
        ));
    }
    if t_start < layer.t_start_us || t_end > layer.t_end_us {
        return Err(McpToolError::invalid_params(
            format!(
                "description window [{t_start}, {t_end}] is outside layer range [{}, {}]",
                layer.t_start_us, layer.t_end_us,
            ),
            None,
        ));
    }

    let source_in = src_in_us + (t_start - layer.t_start_us);
    let source_out = src_in_us + (t_end - layer.t_start_us);
    if source_out > src_out_us {
        return Err(McpToolError::invalid_params(
            format!(
                "description window maps past the layer's source range (source_out={source_out} > src_out_us={src_out_us})",
            ),
            None,
        ));
    }

    Ok(ResolvedClipVideo {
        source_path: media.path_abs.clone(),
        source_hash: media.file_hash_blake3.clone(),
        source_in_us: source_in,
        source_out_us: source_out,
    })
}

/// Map a `vlm::VlmError` to a structured `McpToolError` — mirror of
/// `map_speech_error`.
#[cfg(feature = "speech")]
fn map_vlm_error(e: crate::vlm::VlmError) -> McpToolError {
    use crate::vlm::VlmError as E;
    let message = e.to_string();
    match e {
        E::MissingKey { .. } | E::InvalidKey { .. } | E::MissingEndpoint { .. } => {
            McpToolError::invalid_request(message, None)
        }
        E::RateLimited { .. } | E::Provider { .. } | E::Network(_) => {
            McpToolError::internal_error(message, None)
        }
        E::Io(_) | E::FrameExtract(_) | E::Parse(_) => McpToolError::internal_error(message, None),
        E::EngineExit { .. } | E::Spawn { .. } | E::Timeout { .. } => {
            McpToolError::internal_error(message, None)
        }
    }
}

/// Persist a `DescriptionCache` JSON atomically (temp → promote), mirroring
/// `write_voiceover_atomic`.
#[cfg(feature = "speech")]
async fn write_description_atomic(
    dest: &std::path::Path,
    cache: &crate::vlm::DescriptionCache,
) -> Result<(), anyhow::Error> {
    use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path};
    use anyhow::Context;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("ensure {}", parent.display()))?;
    }
    let body = serde_json::to_vec_pretty(cache).context("serialize description cache")?;
    let tmp = temp_path(dest);
    let _ = tokio::fs::remove_file(&tmp).await;
    tokio::fs::write(&tmp, &body)
        .await
        .with_context(|| format!("write {}", tmp.display()))?;
    if !cached_ok(&tmp) {
        discard_temp(dest);
        anyhow::bail!("description cache is empty after write");
    }
    promote_temp(dest)?;
    Ok(())
}

#[cfg(feature = "speech")]
pub(super) async fn describe_clip(
    b: &Backend,
    args: DescribeClipArgs,
) -> Result<ToolResult, McpToolError> {
    let log_op_id = uuid::Uuid::now_v7();
    b.log_slot.emit(crate::logs::LogEntryInput {
        level: crate::logs::LogLevel::Info,
        category: crate::logs::LogCategory::Mcp,
        source: crate::logs::LogSource::Agent { client: "mcp".into() },
        message: "MCP: describe_clip started".into(),
        op_id: Some(log_op_id),
        op_state: Some(crate::logs::OpState::Started),
        details: Some(serde_json::json!({
            "layer_id": args.layer_id,
            "backend": args.backend,
            "fps": args.fps,
            "focus": args.focus,
        })),
        ..Default::default()
    });
    let result = describe_clip_inner(b, args).await;
    b.log_slot.emit(crate::logs::LogEntryInput {
        level: if result.is_ok() { crate::logs::LogLevel::Info } else { crate::logs::LogLevel::Error },
        category: crate::logs::LogCategory::Mcp,
        source: crate::logs::LogSource::Agent { client: "mcp".into() },
        message: match &result {
            Ok(_) => "MCP: describe_clip done".into(),
            Err(e) => format!("MCP: describe_clip failed: {e}"),
        },
        op_id: Some(log_op_id),
        op_state: Some(if result.is_ok() { crate::logs::OpState::Ok } else { crate::logs::OpState::Err }),
        ..Default::default()
    });
    result
}

#[cfg(feature = "speech")]
async fn describe_clip_inner(
    b: &Backend,
    args: DescribeClipArgs,
) -> Result<ToolResult, McpToolError> {
    use crate::vlm;

    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let resolved = resolve_clip_video_source(
        args.layer.as_ref(),
        args.media.as_ref(),
        layer_id,
        args.t_start_us,
        args.t_end_us,
    )?;

    // Explicit `backend` → STRICT; unknown tag → clean invalid_params. Matched
    // against the stable `as_str` wire tag (not the serde form).
    let explicit = match args.backend.as_deref() {
        None => None,
        Some(tag) => Some(
            vlm::VlmBackend::all()
                .iter()
                .copied()
                .find(|b| b.as_str() == tag)
                .ok_or_else(|| {
                    McpToolError::invalid_params(
                        format!(
                            "unknown backend {tag:?}; expected \"qwen3_vl\", \"minicpm_v\", \"byo_endpoint\", or \"cloud\""
                        ),
                        None,
                    )
                })?,
        ),
    };
    let preferred = args
        .preferred_backend
        .as_deref()
        .and_then(|tag| vlm::VlmBackend::all().iter().copied().find(|b| b.as_str() == tag));

    let cfg = &args.vlm_config;
    let (used_backend, describer) = match explicit {
        Some(be) => (
            be,
            vlm::resolve_scene_describer_exact(be, cfg)
                .map_err(|e| McpToolError::invalid_request(e.to_string(), None))?,
        ),
        None => vlm::resolve_scene_describer(preferred, cfg)
            .ok_or_else(|| McpToolError::invalid_request(vlm::NO_DESCRIBER_CONFIGURED, None))?,
    };
    let model = vlm::model_label(used_backend, cfg.get(used_backend.as_str()));

    let fps = args.fps.unwrap_or(1.0);
    if !(fps.is_finite() && fps > 0.0 && fps <= 30.0) {
        return Err(McpToolError::invalid_params(
            format!("fps {fps} must be in (0.0, 30.0]"),
            None,
        ));
    }
    let focus = vlm::Focus::parse(args.focus.as_deref());
    let fps_milli = (fps * 1000.0).round() as u32;

    let key = vlm::cache_key(&resolved.source_hash, used_backend, &model, fps_milli, focus);
    let dest = b.cache.description(&key);

    // Range-lazy: load the prior cache; if the window is already covered, reuse
    // it with NO engine spawn (acceptance #2).
    let mut cache: vlm::DescriptionCache = match tokio::fs::read(&dest).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => vlm::DescriptionCache::default(),
    };

    if !cache.covers(resolved.source_in_us, resolved.source_out_us) {
        // Uncovered → sample the window's frames and describe it once.
        let anchors = vlm::frame_extract::plan_anchors(
            resolved.source_in_us,
            resolved.source_out_us,
            fps,
        );
        let tmp = tempfile::Builder::new()
            .prefix("weftcut-vlm")
            .tempdir()
            .map_err(|e| McpToolError::internal_error(format!("temp dir: {e}"), None))?;
        let frames = vlm::frame_extract::sample_frames(
            &resolved.source_path,
            resolved.source_in_us,
            tmp.path(),
            &anchors,
        )
        .await
        .map_err(map_vlm_error)?;

        let raw = describer
            .describe(vlm::DescribeRequest { frames, focus })
            .await
            .map_err(map_vlm_error)?;
        let mut fresh = vlm::parse_raw(raw).map_err(map_vlm_error)?;
        // Parser output is window-relative; place it on source-absolute time.
        vlm::shift_segments(&mut fresh, resolved.source_in_us);

        cache.merge_window(resolved.source_in_us, resolved.source_out_us, fresh);
        write_description_atomic(&dest, &cache)
            .await
            .map_err(|e| McpToolError::internal_error(format!("persist description: {e:#}"), None))?;
    }

    let result = vlm::SceneDescription {
        backend: used_backend.as_str().to_string(),
        model,
        segments: cache.segments_in(resolved.source_in_us, resolved.source_out_us),
    };
    ToolResult::json(&result)
}

/// TTS compute half of the `synthesize_speech` hybrid.
/// Validates the text, picks the synthesizer, checks the content-addressed
/// cache, synthesizes+writes the audio if needed, probes it for duration,
/// and builds the `MediaItem`. Does NOT write to the project actor — that is
/// the TS host's job. Returns `(MediaItem, cached)`.
#[cfg(feature = "speech")]
pub(crate) async fn synthesize_speech_audio(
    b: &Backend,
    args: &SynthesizeSpeechArgs,
) -> Result<(crate::state::MediaItem, bool), McpToolError> {
    use crate::cache::cached_ok;
    use crate::io::probe;
    use crate::state::{new_id, DecodeRoute, MediaItem, MediaKind};

    if args.text.trim().is_empty() {
        return Err(McpToolError::invalid_params("text is empty", None));
    }

    let synthesizer = {
        let cfg = b.speech_config.lock().expect("speech_config poisoned");
        // `preferred: None` — TTS has one capable backend (OpenAI), so there is
        // no preference to honor; the resolver's availability walk suffices.
        speech::resolve_synthesizer(None, &cfg)
    }
    .ok_or_else(|| McpToolError::invalid_request(speech::NO_SYNTHESIZER_CONFIGURED, None))?;

    let cache_key = speech::backends::openai::tts_cache_key(&args.text, &args.voice, args.speed);
    // Cache extension hardcoded "mp3": the only TTS provider pins
    // `response_format=mp3`. The `debug_assert!` below trips in dev the first time
    // a provider returns a different format — fix the extension-from-response here.
    // TODO: pull extension from `resp.format` once a non-mp3 TTS provider lands.
    let dest = b.cache.voiceover(&cache_key, "mp3");
    let cached = cached_ok(&dest);
    if !cached {
        let resp = synthesizer
            .synthesize(speech::SynthesizeRequest {
                text: args.text.clone(),
                voice: args.voice.clone(),
                speed: args.speed,
            })
            .await
            .map_err(map_speech_error)?;
        debug_assert_eq!(
            resp.format,
            speech::AudioFormat::Mp3,
            "TTS cache extension assumes mp3 output; update it before adding non-mp3 providers",
        );
        write_voiceover_atomic(&dest, &resp.audio)
            .await
            .map_err(|e| McpToolError::internal_error(format!("write voiceover: {e:#}"), None))?;
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
        let stat = std::fs::metadata(&probe_path).map_err(|e| format!("stat voiceover: {e}"))?;
        Ok(MediaItem {
            id: new_id(),
            label: Some(format!("voiceover-{}", &cache_key_clone[..8])),
            path_abs: probe_path,
            path_rel: None,
            kind: MediaKind::Audio,
            metadata,
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: cache_key_clone,
            file_size: stat.len(),
            file_mtime: stat
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
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

/// `synthesize_speech` Rust handler is a stub — the tool routes through the
/// hybrid orchestrator (synthesize_speech_compute napi compute → TS-actor
/// add_media_item + add Audio layer write); the schema stays so `listTools`
/// advertises it, but the TS host intercepts the call before dispatch reaches
/// this handler. The compute half (`synthesize_speech_audio`) stays — the napi
/// `synthesize_speech_compute` calls it.
#[cfg(feature = "speech")]
pub(super) async fn synthesize_speech(
    _b: &Backend,
    _args: SynthesizeSpeechArgs,
) -> Result<ToolResult, McpToolError> {
    Err(McpToolError::internal_error(
        "synthesize_speech is handled by the host process (TS actor hybrid)".to_string(),
        None,
    ))
}
