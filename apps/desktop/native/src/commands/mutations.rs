//! Layer/track/composition mutation commands -- re-signed from commands_legacy.rs.
//! Bodies are copied verbatim; only the signature changes (the napi `Backend` carries the managed state).

use uuid::Uuid;

use crate::napi_backend::Backend;
use crate::state::{
    self, Actor, ColorParams, CommandError, LayerParams, MediaKind, Rgba,
    SubtitlesParams, SubtitlesSource, TrackFlagsPatch,
    actor::{CompositionPatch, LayerParamsPatch, LayerPatch},
    animated::Animated,
    audio_role::AudioRole,
    time::TimeUs,
};

/// A/B-roll v2 V.7: right-click "Separate audio to new track".
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
            3_000_000,
        ),
        MediaKind::Subtitle => (
            LayerParams::Subtitles(SubtitlesParams {
                source: SubtitlesSource::Media(media),
            }),
            10_000_000,
        ),
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

pub async fn add_subtitles_layer(
    backend: &Backend,
    media_id: String,
    t_start_us: TimeUs,
    duration_us: TimeUs,
) -> Result<String, String> {
    let handle = backend.project()?;
    let media = Uuid::parse_str(&media_id).map_err(|e| format!("media_id: {e}"))?;
    let snap = handle.snapshot().await;
    let media_item = snap
        .media_pool
        .get(&media)
        .ok_or_else(|| "media not found in pool".to_string())?;
    if !matches!(media_item.kind, MediaKind::Subtitle) {
        return Err(format!(
            "media {media_id} is {:?}, expected Subtitle",
            media_item.kind
        ));
    }
    let track_id = match snap.tracks.last() {
        Some(t) => t.id,
        None => handle
            .add_track(Actor::User, Some("Overlay".into()))
            .await
            .map_err(|e: CommandError| e.to_string())?,
    };
    let span = duration_us.max(100_000);
    let params = LayerParams::Subtitles(SubtitlesParams {
        source: SubtitlesSource::Media(media),
    });
    handle
        .add_layer(Actor::User, track_id, params, t_start_us, t_start_us + span)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
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

pub async fn move_layer(
    backend: &Backend,
    layer_id: String,
    new_track_id: String,
    new_t_start_us: TimeUs,
    escape_group: Option<bool>,
) -> Result<(), String> {
    let handle = backend.project()?;
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let tid = Uuid::parse_str(&new_track_id).map_err(|e| format!("new_track_id: {e}"))?;
    handle
        .move_layer(
            Actor::User,
            lid,
            tid,
            new_t_start_us,
            escape_group.unwrap_or(false),
        )
        .await
        .map_err(|e: CommandError| e.to_string())
}

pub async fn trim_layer(
    backend: &Backend,
    layer_id: String,
    edge: String,
    new_t_us: TimeUs,
    escape_group: Option<bool>,
) -> Result<(), String> {
    let handle = backend.project()?;
    let lid = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    let parsed_edge = match edge.to_ascii_lowercase().as_str() {
        "in" | "start" => crate::state::actor::LayerEdge::In,
        "out" | "end" => crate::state::actor::LayerEdge::Out,
        other => return Err(format!("unknown edge '{other}' (expected 'in' or 'out')")),
    };
    handle
        .trim_layer(
            Actor::User,
            lid,
            parsed_edge,
            new_t_us,
            escape_group.unwrap_or(false),
        )
        .await
        .map_err(|e: CommandError| e.to_string())
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
    layer_id: String,
    t_offset_us: TimeUs,
) -> Result<String, String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .duplicate_layer(Actor::User, id, t_offset_us)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}

pub async fn delete_layer(
    backend: &Backend,
    layer_id: String,
) -> Result<(), String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&layer_id).map_err(|e| format!("layer_id: {e}"))?;
    handle
        .delete_layer(Actor::User, id)
        .await
        .map_err(|e: CommandError| e.to_string())
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

pub async fn add_marker(
    backend: &Backend,
    t_us: TimeUs,
    end_t_us: Option<TimeUs>,
    label: String,
    color: Rgba,
) -> Result<String, String> {
    let handle = backend.project()?;
    handle
        .add_marker(Actor::User, t_us, end_t_us, label, color)
        .await
        .map(|id| id.to_string())
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