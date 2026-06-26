//! Layer/track/composition mutation commands. Each parses its string args,
//! resolves the project handle from the napi `Backend`, and calls the actor.
//!
//! Step 1a (command-surface unification — see
//! `docs/superpowers/plans/2026-06-22-pipeline-seam-abstractions.md`): commands
//! are being migrated to take an explicit `actor: Actor` and return
//! `CommandError`, so the MCP tool layer can delegate here instead of
//! re-implementing each mutation. A converted command is the single
//! implementation shared by the napi UI dispatch (which passes `Actor::User`
//! and flattens the error to a string) and the MCP adapter (which passes
//! `Actor::Agent` and renders the error via `map_command_error`). Unconverted
//! commands still hardcode `Actor::User` and return `String`.

use uuid::Uuid;

use crate::napi_backend::Backend;
use crate::state::{
    self, Actor, ColorParams, CommandError, CompositionPatch, LayerEdge, LayerParamsPatch,
    LayerPatch, LayerParams, MediaKind, Rgba, TrackFlagsPatch,
    animated::Animated,
    audio_role::AudioRole,
    time::TimeUs,
};

/// Step 1a: parse a UUID argument into a `CommandError`, so the shared command
/// layer can return one structured error type that both the napi UI dispatch
/// and the MCP adapter render to their own wire shape. Replaces the per-site
/// `Uuid::parse_str(..).map_err(|e| format!(..))`.
fn parse_uuid(s: &str, field: &str) -> Result<Uuid, CommandError> {
    Uuid::parse_str(s).map_err(|e| CommandError::InvalidArgument {
        field: field.to_string(),
        detail: e.to_string(),
    })
}

/// Step 1a: parse a layer-edge name. Accepts the union of the spellings the UI
/// and MCP historically allowed (the MCP set was the superset).
fn parse_layer_edge(s: &str) -> Result<LayerEdge, CommandError> {
    match s.to_ascii_lowercase().as_str() {
        "in" | "start" | "t_start" | "t_start_us" => Ok(LayerEdge::In),
        "out" | "end" | "t_end" | "t_end_us" => Ok(LayerEdge::Out),
        other => Err(CommandError::InvalidArgument {
            field: "edge".to_string(),
            detail: format!("unknown edge '{other}' (expected 'in' or 'out')"),
        }),
    }
}

/// Right-click "Separate audio to new track": moves the layer's audio onto a
/// fresh track. See docs/groups.md / the A/B-roll redesign note.
pub async fn separate_audio_to_new_track(
    backend: &Backend,
    layer_id: String,
) -> Result<String, String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .separate_audio_to_new_track(Actor::User, id)
        .await
        .map(|t| t.to_string())
        .map_err(|e: CommandError| e.to_string())
}

pub async fn add_track(backend: &Backend) -> Result<String, String> {
    let handle = backend.project()?;
    let id = handle
        .add_track(Actor::User, Some("Track".into()))
        .await
        .map_err(|e: CommandError| e.to_string())?;
    Ok(id.to_string())
}

pub async fn add_media_layer(
    backend: &Backend,
    track_id: String,
    media_id: String,
    t_start_us: TimeUs,
) -> Result<String, String> {
    let handle = backend.project()?;
    let track = Uuid::parse_str(&track_id).map_err(|e| format!("track_id: {e}"))?;
    let media = Uuid::parse_str(&media_id).map_err(|e| format!("media_id: {e}"))?;

    let snap = handle.snapshot().await;
    let media_item = snap
        .media_pool
        .get(&media)
        .ok_or_else(|| "media not found in pool".to_string())?;

    let total_src = media_item.metadata.duration_us.unwrap_or(2_000_000);

    let (params, span_us) = match media_item.kind {
        MediaKind::Video => (
            LayerParams::VideoClip(state::layer::VideoClipParams {
                media,
                src_in_us: 0,
                src_out_us: total_src,
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
            total_src,
        ),
        MediaKind::Audio => (
            LayerParams::Audio(state::layer::AudioParams {
                media,
                src_in_us: 0,
                src_out_us: total_src,
                gain_db: Animated::Static(0.0),
                pan: Animated::Static(0.0),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
                role: AudioRole::Music,
            }),
            total_src,
        ),
        MediaKind::Image => (
            LayerParams::ImageOverlay(state::layer::ImageOverlayParams {
                media,
                transform: Default::default(),
                opacity: Animated::Static(1.0),
                blend_mode: Default::default(),
                fade_in_us: 0,
                fade_out_us: 0,
            }),
            image_layer_span_us(&media_item.metadata),
        ),
        // MediaKind::Subtitle files are consumed at import via import_media →
        // import_subtitles and never reach add_media_layer.
        MediaKind::Subtitle => return Err("subtitle files are imported via import_media, not add_media_layer".to_string()),
    };

    let t_end_us = t_start_us + span_us;

    let video_layer_id = handle
        .add_layer(Actor::User, track, params, t_start_us, t_end_us)
        .await
        .map_err(|e: CommandError| e.to_string())?;

    if matches!(media_item.kind, MediaKind::Video)
        && media_item.metadata.audio.is_some()
        && snap.settings.auto_pair_audio_on_import
    {
        let audio_params = LayerParams::Audio(state::layer::AudioParams {
            media,
            src_in_us: 0,
            src_out_us: total_src,
            gain_db: Animated::Static(0.0),
            pan: Animated::Static(0.0),
            fade_in_us: 0,
            fade_out_us: 0,
            mute: false,
            role: AudioRole::Dialogue,
        });
        let audio_layer_id = handle
            .add_layer(
                Actor::User,
                track,
                audio_params,
                t_start_us,
                t_end_us,
            )
            .await
            .map_err(|e: CommandError| e.to_string())?;
        handle
            .groups_create(
                Actor::User,
                vec![video_layer_id, audio_layer_id],
                None,
                false,
            )
            .await
            .map_err(|e: CommandError| e.to_string())?;
    }

    Ok(video_layer_id.to_string())
}

pub async fn add_demo_color_layer(backend: &Backend) -> Result<String, String> {
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let track_id = match snap.tracks.front() {
        Some(t) => t.id,
        None => handle
            .add_track(Actor::User, Some("Track".into()))
            .await
            .map_err(|e: CommandError| e.to_string())?,
    };
    let snap = handle.snapshot().await;
    let track = snap
        .tracks
        .iter()
        .find(|t| t.id == track_id)
        .expect("track just created");
    let t_start = track.layers.last().map(|l| l.t_end_us).unwrap_or(0);
    let t_end = t_start + 2_000_000;

    let params = LayerParams::Color(ColorParams {
        color: Animated::Static(demo_color(track.layers.len())),
        width: snap.composition.width,
        height: snap.composition.height,
    });

    let layer_id = handle
        .add_layer(Actor::User, track_id, params, t_start, t_end)
        .await
        .map_err(|e: CommandError| e.to_string())?;
    Ok(layer_id.to_string())
}

/// Default timeline span (µs) for a freshly-placed Image layer. An *animated*
/// image (multi-frame GIF/WebP/APNG/AVIF) defaults to one native loop so the
/// user sees the whole animation once, then stretches freely — it loops to
/// fill. A still image keeps the 3 s default. "Animated" mirrors `detect_kind`'s
/// signal: a multi-frame stream AND a known (>0) source duration.
fn image_layer_span_us(metadata: &state::media::MediaMetadata) -> TimeUs {
    const STILL_IMAGE_SPAN_US: TimeUs = 3_000_000;
    let multi_frame = metadata
        .video
        .as_ref()
        .and_then(|v| v.nb_frames)
        .is_some_and(|n| n > 1);
    match metadata.duration_us {
        Some(d) if d > 0 && (multi_frame || d >= 500_000) => d,
        _ => STILL_IMAGE_SPAN_US,
    }
}

const DEFAULT_LAYER_DURATION_US: TimeUs = 5_000_000;

fn pick_free_overlay_track(
    tracks: &imbl::Vector<state::Track>,
    t_start_us: TimeUs,
    t_end_us: TimeUs,
) -> Option<state::ids::TrackId> {
    tracks
        .iter()
        .rev()
        .filter(|t| t.role.is_none())
        .find(|t| {
            t.layers
                .iter()
                .all(|l| !(t_start_us < l.t_end_us && l.t_start_us < t_end_us))
        })
        .map(|t| t.id)
}

async fn resolve_overlay_track(
    handle: &state::ProjectHandle,
    t_start_us: TimeUs,
    t_end_us: TimeUs,
) -> Result<state::ids::TrackId, String> {
    let snap = handle.snapshot().await;
    if let Some(id) = pick_free_overlay_track(&snap.tracks, t_start_us, t_end_us) {
        return Ok(id);
    }
    handle
        .add_track(Actor::User, Some("Overlay".into()))
        .await
        .map_err(|e: CommandError| e.to_string())
}

async fn add_text_layer_impl(
    handle: &state::ProjectHandle,
    track_id: Option<String>,
    content: Option<String>,
    t_start_us: TimeUs,
    duration_us: Option<TimeUs>,
) -> Result<String, String> {
    let span = duration_us.unwrap_or(DEFAULT_LAYER_DURATION_US).max(100_000);
    let t_end = t_start_us + span;
    let track = match track_id {
        Some(s) => Uuid::parse_str(&s).map_err(|e| format!("track_id: {e}"))?,
        None => resolve_overlay_track(handle, t_start_us, t_end).await?,
    };
    let params = LayerParams::Text(state::layer::TextParams {
        content: content.unwrap_or_else(|| "Text".to_string()),
        font: state::layer::FontSpec {
            family: "Arial".to_string(),
            size_px: 72.0,
            weight: 400,
            italic: false,
        },
        color: Animated::Static(Rgba::WHITE),
        align: state::layer::TextAlign::Center,
        transform: Default::default(),
        opacity: Animated::Static(1.0),
        shadow: None,
        outline: None,
        intro: None,
        outro: None,
        backend_hint: state::layer::TextBackend::DrawText,
    });
    handle
        .add_layer(Actor::User, track, params, t_start_us, t_end)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

pub async fn add_text_layer(
    backend: &Backend,
    track_id: Option<String>,
    content: Option<String>,
    t_start_us: TimeUs,
    duration_us: Option<TimeUs>,
) -> Result<String, String> {
    let handle = backend.project()?;
    add_text_layer_impl(handle, track_id, content, t_start_us, duration_us).await
}

pub async fn add_demo_text_layer(backend: &Backend) -> Result<String, String> {
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let track_id = match snap.tracks.last() {
        Some(t) => t.id,
        None => handle
            .add_track(Actor::User, Some("Overlay".into()))
            .await
            .map_err(|e: CommandError| e.to_string())?,
    };
    let snap = handle.snapshot().await;
    let track = snap
        .tracks
        .iter()
        .find(|t| t.id == track_id)
        .expect("track just created");
    let t_start = track.layers.last().map(|l| l.t_end_us).unwrap_or(0);
    let t_end = t_start + 3_000_000;

    let params = LayerParams::Text(state::layer::TextParams {
        content: "TEXT".to_string(),
        font: state::layer::FontSpec {
            family: "Arial".to_string(),
            size_px: 96.0,
            weight: 700,
            italic: false,
        },
        color: Animated::Static(Rgba::WHITE),
        align: state::layer::TextAlign::Center,
        transform: Default::default(),
        opacity: Animated::Static(1.0),
        shadow: None,
        outline: None,
        intro: None,
        outro: None,
        backend_hint: state::layer::TextBackend::DrawText,
    });
    handle
        .add_layer(Actor::User, track_id, params, t_start, t_end)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

async fn add_color_layer_impl(
    handle: &state::ProjectHandle,
    track_id: Option<String>,
    color: Option<Rgba>,
    width: Option<u32>,
    height: Option<u32>,
    t_start_us: TimeUs,
    duration_us: Option<TimeUs>,
) -> Result<String, String> {
    let span = duration_us.unwrap_or(DEFAULT_LAYER_DURATION_US).max(100_000);
    let t_end = t_start_us + span;
    let snap = handle.snapshot().await;
    let track = match track_id {
        Some(s) => Uuid::parse_str(&s).map_err(|e| format!("track_id: {e}"))?,
        None => resolve_overlay_track(handle, t_start_us, t_end).await?,
    };
    let params = LayerParams::Color(ColorParams {
        color: Animated::Static(color.unwrap_or(Rgba::BLACK)),
        width: width.unwrap_or(snap.composition.width),
        height: height.unwrap_or(snap.composition.height),
    });
    handle
        .add_layer(Actor::User, track, params, t_start_us, t_end)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

pub async fn add_color_layer(
    backend: &Backend,
    track_id: Option<String>,
    color: Option<Rgba>,
    width: Option<u32>,
    height: Option<u32>,
    t_start_us: TimeUs,
    duration_us: Option<TimeUs>,
) -> Result<String, String> {
    let handle = backend.project()?;
    add_color_layer_impl(handle, track_id, color, width, height, t_start_us, duration_us).await
}

pub async fn update_layer(
    backend: &Backend,
    layer_id: String,
    patch: LayerPatch,
) -> Result<(), String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .update_layer(Actor::User, id, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

pub async fn update_layer_params(
    backend: &Backend,
    layer_id: String,
    patch: LayerParamsPatch,
) -> Result<(), String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .update_layer_params(Actor::User, id, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

pub async fn update_layer_param_track(
    backend: &Backend,
    layer_id: String,
    param_key: String,
    track: Animated<f64>,
) -> Result<(), String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .update_layer_param_track(Actor::User, id, param_key, track)
        .await
        .map_err(|e: CommandError| e.to_string())
}

pub async fn update_layer_param_tracks(
    backend: &Backend,
    layer_id: String,
    entries: Vec<(String, Animated<f64>)>,
) -> Result<(), String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .update_layer_param_tracks(Actor::User, id, entries)
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// Append an effect (catalog `kind`) to a layer's chain. The effect starts with
/// empty params; the renderer seeds defaults lazily on first param edit
/// (apply_update_layer_param_track). Returns the new effect id. Mirrors the
/// `add_effect` MCP tool but for the renderer's invoke() path.
pub async fn add_effect(backend: &Backend, layer_id: String, kind: String) -> Result<String, String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let effect = crate::state::effect::Effect {
        id: crate::state::ids::new_id(),
        kind,
        enabled: true,
        params: std::collections::BTreeMap::new(),
    };
    handle
        .add_effect(Actor::User, id, effect)
        .await
        .map(|eid| eid.to_string())
        .map_err(|e: CommandError| e.to_string())
}

/// Patch an effect (`{ enabled?, params? }`). The UI uses only `enabled`; param
/// edits go through update_layer_param_track.
pub async fn update_effect(
    backend: &Backend,
    layer_id: String,
    effect_id: String,
    patch: crate::state::effect::EffectPatch,
) -> Result<(), String> {
    let handle = backend.project()?;
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let eid = Uuid::parse_str(&effect_id).map_err(|e| format!("effect_id: {e}"))?;
    handle
        .update_effect(Actor::User, lid, eid, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// Reorder an effect within its layer's chain (0 = applied first).
pub async fn move_effect(
    backend: &Backend,
    layer_id: String,
    effect_id: String,
    new_index: usize,
) -> Result<(), String> {
    let handle = backend.project()?;
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let eid = Uuid::parse_str(&effect_id).map_err(|e| format!("effect_id: {e}"))?;
    handle
        .move_effect(Actor::User, lid, eid, new_index)
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// Remove an effect from a layer's chain by id.
pub async fn remove_effect(backend: &Backend, layer_id: String, effect_id: String) -> Result<(), String> {
    let handle = backend.project()?;
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let eid = Uuid::parse_str(&effect_id).map_err(|e| format!("effect_id: {e}"))?;
    handle
        .remove_effect(Actor::User, lid, eid)
        .await
        .map_err(|e: CommandError| e.to_string())
}

pub async fn move_layer(
    backend: &Backend,
    actor: Actor,
    layer_id: String,
    new_track_id: String,
    new_t_start_us: TimeUs,
    escape_group: Option<bool>,
) -> Result<(), CommandError> {
    let handle = backend.project().map_err(CommandError::Backend)?;
    let lid = parse_uuid(&layer_id, "layer_id")?;
    let tid = parse_uuid(&new_track_id, "new_track_id")?;
    handle
        .move_layer(actor, lid, tid, new_t_start_us, escape_group.unwrap_or(false))
        .await
}

pub async fn trim_layer(
    backend: &Backend,
    actor: Actor,
    layer_id: String,
    edge: String,
    new_t_us: TimeUs,
    escape_group: Option<bool>,
) -> Result<(), CommandError> {
    let handle = backend.project().map_err(CommandError::Backend)?;
    let lid = parse_uuid(&layer_id, "layer_id")?;
    let parsed_edge = parse_layer_edge(&edge)?;
    handle
        .trim_layer(
            actor,
            lid,
            parsed_edge,
            new_t_us,
            escape_group.unwrap_or(false),
        )
        .await
}

pub async fn split_layer_grouped(
    backend: &Backend,
    layer_id: String,
    at_t_us: TimeUs,
    escape_group: Option<bool>,
) -> Result<(String, String), String> {
    let handle = backend.project()?;
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let (left, right) = handle
        .split_layer(Actor::User, lid, at_t_us, escape_group.unwrap_or(false))
        .await
        .map_err(|e: CommandError| e.to_string())?;
    Ok((left.to_string(), right.to_string()))
}

pub async fn groups_create(
    backend: &Backend,
    layer_ids: Vec<String>,
    label: Option<String>,
    reassign: Option<bool>,
) -> Result<String, String> {
    let handle = backend.project()?;
    let ids: Vec<state::LayerId> = layer_ids
        .into_iter()
        .map(|s| Uuid::parse_str(&s).map_err(|e| format!("layer_id: {e}")))
        .collect::<Result<_, _>>()?;
    let gid = handle
        .groups_create(Actor::User, ids, label, reassign.unwrap_or(false))
        .await
        .map_err(|e: CommandError| e.to_string())?;
    Ok(gid.to_string())
}

pub async fn groups_dissolve(
    backend: &Backend,
    group_id: String,
) -> Result<(), String> {
    let handle = backend.project()?;
    let gid = Uuid::parse_str(&group_id).map_err(|e| format!("group_id: {e}"))?;
    handle
        .groups_dissolve(Actor::User, gid)
        .await
        .map_err(|e: CommandError| e.to_string())
}

pub async fn duplicate_layer(
    backend: &Backend,
    actor: Actor,
    layer_id: String,
    t_offset_us: TimeUs,
) -> Result<state::LayerId, CommandError> {
    let handle = backend.project().map_err(CommandError::Backend)?;
    let id = parse_uuid(&layer_id, "layer_id")?;
    handle.duplicate_layer(actor, id, t_offset_us).await
}

pub async fn delete_layer(
    backend: &Backend,
    actor: Actor,
    layer_id: String,
) -> Result<(), CommandError> {
    let handle = backend.project().map_err(CommandError::Backend)?;
    let id = parse_uuid(&layer_id, "layer_id")?;
    handle.delete_layer(actor, id).await
}

pub async fn set_composition(
    backend: &Backend,
    patch: CompositionPatch,
) -> Result<(), String> {
    let handle = backend.project()?;
    handle
        .set_composition(Actor::User, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

pub async fn fit_composition_to_layers(backend: &Backend) -> Result<(), String> {
    let handle = backend.project()?;
    handle
        .fit_composition_to_layers(Actor::User)
        .await
        .map_err(|e: CommandError| e.to_string())
}

pub async fn update_track_flags(
    backend: &Backend,
    track_id: String,
    patch: TrackFlagsPatch,
) -> Result<(), String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&track_id).map_err(|e| format!("track_id: {e}"))?;
    handle
        .update_track_flags(Actor::User, id, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

pub async fn set_role_gain(
    backend: &Backend,
    role: AudioRole,
    gain_db: f64,
) -> Result<(), String> {
    let handle = backend.project()?;
    handle
        .set_role_gain(Actor::User, role, gain_db)
        .await
        .map_err(|e: CommandError| e.to_string())
}

pub async fn update_role_flags(
    backend: &Backend,
    role: AudioRole,
    patch: crate::state::audio_role::RoleFlagsPatch,
) -> Result<(), String> {
    let handle = backend.project()?;
    handle
        .update_role_flags(Actor::User, role, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

fn demo_color(idx: usize) -> Rgba {
    const PALETTE: [Rgba; 6] = [
        Rgba::rgb(96, 165, 250),
        Rgba::rgb(244, 114, 182),
        Rgba::rgb(74, 222, 128),
        Rgba::rgb(251, 191, 36),
        Rgba::rgb(167, 139, 250),
        Rgba::rgb(248, 113, 113),
    ];
    PALETTE[idx % PALETTE.len()]
}

/// Batch-restyle all Text layers on the named caption track in one undo entry.
pub async fn restyle_caption_track(
    backend: &Backend,
    track_id: String,
    patch: crate::state::CaptionStylePatch,
) -> Result<(), String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&track_id).map_err(|e| format!("track_id: {e}"))?;
    handle
        .restyle_caption_track(Actor::User, id, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// Pure parse half of the subtitle chokepoint: validate the body, sniff/apply
/// the format, run the parser, and return the cues + simplified flag. No actor
/// write — the caller (import_subtitles or the TS hybrid) applies the write.
pub fn parse_subtitle_cues(
    body: &str,
    format: Option<crate::subtitles::SubFormat>,
) -> Result<(Vec<crate::subtitles::Cue>, bool), String> {
    if body.trim().is_empty() {
        return Err("subtitle body is empty".into());
    }
    let fmt = format.unwrap_or_else(|| crate::subtitles::sniff(body));
    let parsed = crate::subtitles::parse(body, fmt);
    if parsed.cues.is_empty() {
        return Err("no cues parsed from subtitle body".into());
    }
    Ok((parsed.cues, parsed.simplified))
}

/// THE chokepoint: parse a subtitle body and build a caption track. Shared by
/// file import (commands::media), MCP apply_subtitles, and transcribe. Returns
/// the new track id and whether any ASS styling was simplified (lossy).
pub async fn import_subtitles(
    backend: &Backend,
    body: String,
    format: Option<crate::subtitles::SubFormat>,
    label: Option<String>,
) -> Result<(String, bool), String> {
    let (cues, simplified) = parse_subtitle_cues(&body, format)?;
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let (w, h) = (snap.composition.width, snap.composition.height);
    let track_id = handle
        .add_caption_track(Actor::User, cues, w, h, label)
        .await
        .map_err(|e: CommandError| e.to_string())?;
    Ok((track_id.to_string(), simplified))
}

#[cfg(test)]
mod image_span_tests {
    use super::image_layer_span_us;
    use crate::state::media::{MediaMetadata, VideoStreamMeta};

    fn video_meta(nb_frames: Option<u64>) -> VideoStreamMeta {
        VideoStreamMeta {
            width: 100,
            height: 100,
            fps_num: 10,
            fps_den: 1,
            codec: "gif".into(),
            pix_fmt: "bgra".into(),
            nb_frames,
            color_matrix: None,
            color_range: None,
            color_primaries: None,
            color_transfer: None,
        }
    }

    #[test]
    fn animated_image_spans_one_native_loop() {
        let meta = MediaMetadata {
            duration_us: Some(2_000_000),
            video: Some(video_meta(Some(10))),
            audio: None,
            container_format: Some("gif".into()),
        };
        assert_eq!(image_layer_span_us(&meta), 2_000_000);
    }

    #[test]
    fn still_image_keeps_default_span() {
        // No duration, single-frame-ish: a plain still image.
        let meta = MediaMetadata {
            duration_us: None,
            video: Some(video_meta(Some(1))),
            audio: None,
            container_format: Some("png_pipe".into()),
        };
        assert_eq!(image_layer_span_us(&meta), 3_000_000);
    }

    #[test]
    fn animated_without_duration_falls_back_to_default() {
        // Multi-frame but the demuxer reported no duration — can't loop to an
        // unknown length, so fall back to the still default.
        let meta = MediaMetadata {
            duration_us: None,
            video: Some(video_meta(Some(8))),
            audio: None,
            container_format: Some("webp_pipe".into()),
        };
        assert_eq!(image_layer_span_us(&meta), 3_000_000);
    }

    #[test]
    fn single_frame_with_long_duration_uses_native_duration() {
        let meta = MediaMetadata {
            duration_us: Some(600_000),
            video: Some(video_meta(Some(1))),
            audio: None,
            container_format: Some("avif".into()),
        };
        assert_eq!(image_layer_span_us(&meta), 600_000);
    }
}

#[cfg(test)]
mod import_subtitles_tests {
    use super::import_subtitles;
    use std::sync::Arc;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn import_subtitles_builds_caption_track_from_srt() {
        let b = crate::napi_backend::Backend::new_for_test(Arc::new(
            crate::events::VecEventSink::new(),
        ));
        b.init().await.unwrap();
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
        let (track_id, simplified) = import_subtitles(&b, srt.into(), None, Some("Captions".into()))
            .await
            .expect("import_subtitles");
        assert!(!simplified);
        let snap = b.project().unwrap().snapshot().await;
        let track = snap
            .tracks
            .iter()
            .find(|t| t.id.to_string() == track_id)
            .expect("track");
        assert_eq!(track.layers.len(), 1);
    }
}

/// Step 1a: the shared command layer now parses raw args into
/// `CommandError::InvalidArgument` (replacing the per-surface `String` /
/// `McpToolError` parse errors). Lock that contract — it is the one new code
/// path the delegation introduced and has no other coverage. Behavior of the
/// commands themselves is covered by `state::actor::tests`.
#[cfg(test)]
mod arg_parsing_tests {
    use crate::state::{Actor, CommandError};
    use std::sync::Arc;

    fn test_backend() -> crate::napi_backend::Backend {
        crate::napi_backend::Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_layer_rejects_bad_layer_uuid() {
        let b = test_backend();
        b.init().await.unwrap();
        let err = super::move_layer(
            &b,
            Actor::User,
            "not-a-uuid".into(),
            "also-not-a-uuid".into(),
            0,
            None,
        )
        .await
        .expect_err("a malformed layer_id must be rejected before the actor call");
        assert!(
            matches!(&err, CommandError::InvalidArgument { field, .. } if field == "layer_id"),
            "expected InvalidArgument{{ field: \"layer_id\" }}, got {err:?}",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn trim_layer_rejects_bad_edge() {
        let b = test_backend();
        b.init().await.unwrap();
        // Valid-format (but nonexistent) layer_id so parsing reaches the edge;
        // the bad edge must fail before any actor call.
        let layer_id = uuid::Uuid::now_v7().to_string();
        let err = super::trim_layer(&b, Actor::User, layer_id, "sideways".into(), 0, None)
            .await
            .expect_err("an unknown edge must be rejected");
        assert!(
            matches!(&err, CommandError::InvalidArgument { field, .. } if field == "edge"),
            "expected InvalidArgument{{ field: \"edge\" }}, got {err:?}",
        );
    }
}
