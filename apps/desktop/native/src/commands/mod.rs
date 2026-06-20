//! Command surface — the UI's view onto the project actor, exposed through
//! `Backend::dispatch`.
//!
//! Design intent: keep these wrappers thin. The actor + handle hold all logic;
//! commands just translate UI calls into actor messages and shape responses for
//! the frontend. The response *view* structs (`ProjectSummary` & friends) live
//! here; the async command bodies that build them live in the submodules.

use serde::Serialize;

use crate::state::{
    self, Animated, LayerParams, Rgba, SubtitlesSource,
    track::TrackRole,
};

pub mod query;
pub mod mutations;
pub mod history;
pub mod persistence;
pub mod prefs;
#[cfg(feature = "jobs")]
pub mod media;
#[cfg(feature = "export")]
pub mod export;
#[cfg(feature = "cloud")]
pub mod cloud;
#[cfg(feature = "motifs")]
pub mod motifs;
#[cfg(feature = "motifs")]
pub mod motif_authoring;

#[cfg(feature = "cloud")]
#[derive(Serialize, Clone)]
pub struct ApiKeyStatus {
    pub provider: String,
    pub label: String,
    pub configured: bool,
}

#[derive(Serialize, Clone)]
pub struct ProjectSummary {
    pub project_id: String,
    pub name: String,
    pub composition: CompositionSummary,
    pub track_count: usize,
    pub layer_count: usize,
    pub duration_us: i64,
    pub history: HistoryView,
    pub media: Vec<MediaSummary>,
    pub tracks: Vec<TrackSummary>,
    /// Sparse markers along the timeline. Surfaced so the agent-mode
    /// mini timeline can render them as pips above the scrub bar.
    pub markers: Vec<MarkerSummary>,
    /// Layer groups (`docs/groups.md`). UI uses these to render the
    /// tinted group indicator + lookup the membership for click-selects-
    /// whole-group behavior.
    pub groups: Vec<GroupSummary>,
    /// Per-role mix-bus settings (`docs/audio.md`). Always all four roles
    /// in canonical order (Dialogue, Music, Sfx, Voiceover) with defaults
    /// filled, so the Mixer UI can render every bus without probing the map.
    pub audio_roles: Vec<RoleMixView>,
}

#[derive(Serialize, Clone)]
pub struct GroupSummary {
    pub id: String,
    pub label: Option<String>,
    pub layer_ids: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct MarkerSummary {
    pub id: String,
    pub t_us: i64,
    /// `Some(end)` when this is a region marker.
    pub end_t_us: Option<i64>,
    pub label: String,
    /// Hex `#rrggbb` derived from the marker's `color` field for
    /// straightforward CSS consumption.
    pub color_hint: String,
}

#[derive(Serialize, Clone)]
pub struct TrackSummary {
    pub id: String,
    /// Dominant layer-class label for the track (`"Video"` when any visual-class
    /// layer is present, `"Audio"` when audio-only, `"Subtitle"` for subtitle-only,
    /// `"Video"` when empty). Transitional: tracks are kind-agnostic, so this is
    /// derived for the UI's kind-based styling, not a stored property.
    pub kind: String,
    pub label: Option<String>,
    pub enabled: bool,
    pub locked: bool,
    /// Track-level audio mute — silences Audio layers in preview and
    /// export; video output is unaffected.
    pub muted: bool,
    /// Track-level solo — when any track is soloed, only soloed tracks
    /// are audible; `muted` wins over `solo`.
    pub solo: bool,
    /// A/B-roll role stamp (`docs/data-model.md`). Serializes as the
    /// kebab-case variant name when present (`"a-roll" | "b-roll" |
    /// "audio-a" | "audio-b"`) or `null` for additional/legacy tracks. The
    /// UI uses this to drive the AB display-mode filter and the role-aware
    /// AV promotion path.
    pub role: Option<String>,
    /// True when this track was spawned by the "fresh hidden track per import"
    /// path and is therefore subject to auto-prune. The UI can
    /// use this to render the track-header chrome differently (it's
    /// going to disappear the moment its layer is dragged off).
    pub transient: bool,
    pub layers: Vec<LayerSummary>,
}

#[derive(Serialize, Clone)]
pub struct LayerSummary {
    pub id: String,
    pub label: Option<String>,
    pub t_start_us: i64,
    pub t_end_us: i64,
    /// Discriminant of LayerParams ("VideoClip", "Color", "Audio", ...).
    pub kind: String,
    /// Optional hex `#rrggbb` derived from the layer's content (e.g. ColorParams)
    /// or a stable hash of the layer id for visual differentiation.
    pub color_hint: String,
    pub enabled: bool,
    pub locked: bool,
    /// UI-friendly snapshot of the kind-specific params. Read by the property
    /// panel; mutates flow back through `update_layer_params` with the
    /// matching `LayerParamsPatch` variant.
    pub params: LayerParamsView,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind")]
pub enum LayerParamsView {
    VideoClip(VideoClipView),
    ImageOverlay(ImageOverlayView),
    Text(TextView),
    Color(ColorView),
    Audio(AudioView),
    Subtitles(SubtitlesView),
    Motif(MotifView),
}

#[derive(Serialize, Clone)]
pub struct MotifView {
    pub motif_id: String,
    /// Canvas-space pixel offset. Animated fields ship the FULL track
    /// (`{mode, value}` wire shape — TS mirror `AnimTrack<T>`); resolution
    /// to a scalar happens per frame in the renderer (`render/resolveView.ts`),
    /// never at this boundary.
    pub x: Animated<f64>,
    pub y: Animated<f64>,
    pub scale_x: Animated<f64>,
    pub scale_y: Animated<f64>,
    pub opacity: Animated<f64>,
    pub src_in_us: i64,
    /// Validated props the user set on this motif instance. Keys match the
    /// motif manifest's `props_schema`; values are whatever JSON shape that
    /// schema permits (string / number / color-as-string). Serialized for the
    /// capture host (see renderer `render/motifs/host.ts`).
    pub props: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Clone)]
pub struct VideoClipView {
    pub media_id: String,
    pub media_label: String,
    pub src_in_us: i64,
    pub src_out_us: i64,
    pub x: Animated<f64>,
    pub y: Animated<f64>,
    pub scale_x: Animated<f64>,
    pub scale_y: Animated<f64>,
    pub opacity: Animated<f64>,
    pub speed: f64,
    pub flip_h: bool,
    pub flip_v: bool,
    pub fade_in_us: u64,
    pub fade_out_us: u64,
}

#[derive(Serialize, Clone)]
pub struct ImageOverlayView {
    pub media_id: String,
    pub media_label: String,
    pub x: Animated<f64>,
    pub y: Animated<f64>,
    pub scale_x: Animated<f64>,
    pub scale_y: Animated<f64>,
    pub opacity: Animated<f64>,
    pub fade_in_us: u64,
    pub fade_out_us: u64,
}

#[derive(Serialize, Clone)]
pub struct TextView {
    pub content: String,
    pub font_family: String,
    pub font_size_px: f32,
    pub weight: u16,
    pub italic: bool,
    pub color: Animated<Rgba>,
    pub align: state::TextAlign,
    pub x: Animated<f64>,
    pub y: Animated<f64>,
    pub anchor_x: f64,
    pub anchor_y: f64,
    pub opacity: Animated<f64>,
    pub shadow: Option<state::Shadow>,
    pub outline: Option<state::Outline>,
}

#[derive(Serialize, Clone)]
pub struct ColorView {
    pub color: Animated<Rgba>,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Clone)]
pub struct AudioView {
    pub media_id: String,
    pub media_label: String,
    pub src_in_us: i64,
    pub src_out_us: i64,
    pub gain_db: Animated<f64>,
    pub pan: Animated<f64>,
    pub fade_in_us: u64,
    pub fade_out_us: u64,
    pub mute: bool,
    pub role: String, // "dialogue" | "music" | "sfx" | "voiceover"
}

#[derive(Serialize, Clone)]
pub struct RoleMixView {
    pub role: String,
    pub gain_db: f64,
    pub muted: bool,
    pub solo: bool,
}

#[derive(Serialize, Clone)]
pub struct SubtitlesView {
    pub source_kind: String,
    pub source_value: String,
}

#[derive(Serialize, Clone)]
pub struct MediaSummary {
    pub id: String,
    pub label: String,
    pub path: String,
    pub kind: String,
    pub duration_us: Option<i64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub size_bytes: u64,
    /// True when `path_abs` resolves to a real file on disk right now.
    /// Per workspace-redesign Q5/Q9, the UI shows a "missing media" badge
    /// when this is false (project opens anyway; layers referencing the
    /// missing item render placeholders).
    pub available: bool,
    /// Absolute path of the proxy MP4 produced by `jobs/proxy.rs`, when
    /// one exists. `None` until the background job completes (or for
    /// media kinds that don't get proxied — e.g. audio-only sources).
    /// DOM preview falls back to `path` when this is `None`.
    pub proxy_path: Option<String>,
    /// Fast preview-only proxy. Export intentionally ignores this path.
    pub quick_proxy_path: Option<String>,
    /// True when the workspace copy is safe for direct WebCodecs use and no
    /// generated proxy is required.
    pub proxy_bypassed: bool,
    /// True when export may decode the original directly (preview still uses
    /// a generated proxy). See `MediaItem::export_uses_original`.
    pub export_uses_original: bool,
    /// Source video codec (e.g. "h264", "hevc", "prores"), `None` for
    /// audio/image. Raw passthrough from `metadata.video` — display-only.
    pub codec: Option<String>,
    /// Source pixel format (e.g. "yuv420p", "yuv420p10le"), `None` for
    /// audio/image. Raw passthrough — display-only.
    pub pix_fmt: Option<String>,
    /// Source color matrix (e.g. "bt709", "bt601"), `None` when unknown.
    pub color_matrix: Option<String>,
    /// Source color range ("tv" / "pc"), `None` when unknown.
    pub color_range: Option<String>,
    /// Source color primaries (e.g. "bt709"), `None` when unknown.
    pub color_primaries: Option<String>,
    /// Source color transfer characteristics (e.g. "bt709"), `None` when unknown.
    pub color_transfer: Option<String>,
    /// Absolute path of the canonical conformed PCM (`jobs/conform.rs`),
    /// when the conform job has completed. The preview mixer Range-reads
    /// this file; `None` means the audio layer is not yet playable.
    pub conform_path: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct CompositionSummary {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// Mirrors `Composition.duration_pinned`. UI uses it to render the
    /// "Pin composition duration" toggle state in the menu.
    pub duration_pinned: bool,
}

#[derive(Serialize, Clone)]
pub struct HistoryView {
    pub cursor: usize,
    pub len: usize,
    pub can_undo: bool,
    pub can_redo: bool,
    /// `Some(reason)` while the agent has taken the revert lock.
    /// Frontend surfaces this as a badge in the agent-mode record
    /// panel header and as a disabled-tooltip on Undo / Redo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
}

/// Pure builder for the project IPC view. Kept separate from the async
/// `project_summary` command so it can be unit-tested without a live actor.
pub(crate) fn build_project_summary(
    snap: &state::Project,
    history: &state::HistoryStatus,
) -> ProjectSummary {
    let layer_count = snap.tracks.iter().map(|t| t.layers.len()).sum();

    let mut media: Vec<MediaSummary> = snap
        .media_pool
        .values()
        .map(|m| {
            let label = m
                .label
                .clone()
                .or_else(|| {
                    m.path_abs
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                })
                .unwrap_or_else(|| m.path_abs.to_string_lossy().to_string());
            let proxy_path = m
                .proxy_path
                .as_ref()
                .and_then(|p| p.is_file().then(|| p.to_string_lossy().to_string()));
            let quick_proxy_path = m
                .quick_proxy_path
                .as_ref()
                .and_then(|p| p.is_file().then(|| p.to_string_lossy().to_string()));
            let conform_path = m
                .conform_path
                .as_ref()
                .and_then(|p| p.is_file().then(|| p.to_string_lossy().to_string()));
            MediaSummary {
                id: m.id.to_string(),
                label,
                path: m.path_abs.to_string_lossy().to_string(),
                kind: format!("{:?}", m.kind),
                duration_us: m.metadata.duration_us,
                width: m.metadata.video.as_ref().map(|v| v.width),
                height: m.metadata.video.as_ref().map(|v| v.height),
                size_bytes: m.file_size,
                available: m.path_abs.is_file(),
                proxy_path,
                quick_proxy_path,
                proxy_bypassed: m.proxy_bypassed,
                export_uses_original: m.export_uses_original,
                codec: m.metadata.video.as_ref().map(|v| v.codec.clone()),
                pix_fmt: m.metadata.video.as_ref().map(|v| v.pix_fmt.clone()),
                color_matrix: m.metadata.video.as_ref().and_then(|v| v.color_matrix.clone()),
                color_range: m.metadata.video.as_ref().and_then(|v| v.color_range.clone()),
                color_primaries: m.metadata.video.as_ref().and_then(|v| v.color_primaries.clone()),
                color_transfer: m.metadata.video.as_ref().and_then(|v| v.color_transfer.clone()),
                conform_path,
            }
        })
        .collect();
    // Stable display order: most recently imported first.
    media.sort_by(|a, b| b.id.cmp(&a.id));

    let tracks: Vec<TrackSummary> = snap
        .tracks
        .iter()
        .map(|t| TrackSummary {
            id: t.id.to_string(),
            // Derive `kind` from the track's layers: visual-class layers win;
            // audio-only tracks report "Audio"; empty
            // tracks report "Video" so the existing UI still styles
            // the reserved A/B-roll rows as video lanes by default.
            kind: derive_track_kind_label(t),
            label: t.label.clone(),
            enabled: t.enabled,
            locked: t.locked,
            muted: t.muted,
            solo: t.solo,
            role: t.role.map(|r| match r {
                TrackRole::ARoll => "a-roll".to_string(),
                TrackRole::BRoll => "b-roll".to_string(),
                TrackRole::AudioA => "audio-a".to_string(),
                TrackRole::AudioB => "audio-b".to_string(),
            }),
            transient: t.transient,
            layers: t
                .layers
                .iter()
                .map(|l| LayerSummary {
                    id: l.id.to_string(),
                    label: l.label.clone(),
                    t_start_us: l.t_start_us,
                    t_end_us: l.t_end_us,
                    kind: layer_kind(&l.params),
                    color_hint: layer_color_hint(l),
                    enabled: l.enabled,
                    locked: l.locked,
                    params: layer_params_view(&l.params, &snap.media_pool),
                })
                .collect(),
        })
        .collect();

    let markers = snap
        .markers
        .iter()
        .map(|m| MarkerSummary {
            id: m.id.to_string(),
            t_us: m.t_us,
            end_t_us: m.end_t_us,
            label: m.label.clone(),
            color_hint: format!("#{:02x}{:02x}{:02x}", m.color.r, m.color.g, m.color.b),
        })
        .collect();

    let groups: Vec<GroupSummary> = snap
        .groups
        .iter()
        .map(|g| GroupSummary {
            id: g.id.to_string(),
            label: g.label.clone(),
            layer_ids: g.members.iter().map(|m| m.to_string()).collect(),
        })
        .collect();

    // Always emit all four roles in canonical order, defaults filled, so the
    // Mixer UI never has to probe the sparse `audio_roles` map itself.
    let audio_roles: Vec<RoleMixView> = crate::state::audio_role::AudioRole::ALL
        .iter()
        .map(|&r| {
            let s = snap.role_mix(r);
            RoleMixView {
                role: r.as_str().to_string(),
                gain_db: s.gain_db,
                muted: s.muted,
                solo: s.solo,
            }
        })
        .collect();

    ProjectSummary {
        project_id: snap.project_id.to_string(),
        name: snap.metadata.name.clone(),
        composition: CompositionSummary {
            width: snap.composition.width,
            height: snap.composition.height,
            fps_num: snap.composition.fps.num,
            fps_den: snap.composition.fps.den,
            duration_pinned: snap.composition.duration_pinned,
        },
        track_count: snap.tracks.len(),
        layer_count,
        duration_us: snap.composition.duration_us,
        history: HistoryView {
            cursor: history.cursor,
            len: history.len,
            can_undo: history.can_undo,
            can_redo: history.can_redo,
            lock_reason: history.lock_reason.clone(),
        },
        media,
        tracks,
        markers,
        groups,
        audio_roles,
    }
}

fn layer_params_view(
    params: &LayerParams,
    media_pool: &imbl::HashMap<state::MediaId, state::MediaItem>,
) -> LayerParamsView {
    let media_label_for = |id: &state::MediaId| -> String {
        media_pool
            .get(id)
            .and_then(|m| {
                m.label.clone().or_else(|| {
                    m.path_abs
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                })
            })
            .unwrap_or_else(|| id.to_string())
    };
    match params {
        LayerParams::VideoClip(p) => LayerParamsView::VideoClip(VideoClipView {
            media_id: p.media.to_string(),
            media_label: media_label_for(&p.media),
            src_in_us: p.src_in_us,
            src_out_us: p.src_out_us,
            x: p.transform.x.clone(),
            y: p.transform.y.clone(),
            scale_x: p.transform.scale_x.clone(),
            scale_y: p.transform.scale_y.clone(),
            opacity: p.opacity.clone(),
            speed: p.speed,
            flip_h: p.flip_h,
            flip_v: p.flip_v,
            fade_in_us: p.fade_in_us,
            fade_out_us: p.fade_out_us,
        }),
        LayerParams::ImageOverlay(p) => LayerParamsView::ImageOverlay(ImageOverlayView {
            media_id: p.media.to_string(),
            media_label: media_label_for(&p.media),
            x: p.transform.x.clone(),
            y: p.transform.y.clone(),
            scale_x: p.transform.scale_x.clone(),
            scale_y: p.transform.scale_y.clone(),
            opacity: p.opacity.clone(),
            fade_in_us: p.fade_in_us,
            fade_out_us: p.fade_out_us,
        }),
        LayerParams::Text(p) => LayerParamsView::Text(TextView {
            content: p.content.clone(),
            font_family: p.font.family.clone(),
            font_size_px: p.font.size_px,
            weight: p.font.weight,
            italic: p.font.italic,
            color: p.color.clone(),
            align: p.align,
            x: p.transform.x.clone(),
            y: p.transform.y.clone(),
            anchor_x: p.transform.anchor.0,
            anchor_y: p.transform.anchor.1,
            opacity: p.opacity.clone(),
            shadow: p.shadow.clone(),
            outline: p.outline.clone(),
        }),
        LayerParams::Color(p) => LayerParamsView::Color(ColorView {
            color: p.color.clone(),
            width: p.width,
            height: p.height,
        }),
        LayerParams::Audio(p) => LayerParamsView::Audio(AudioView {
            media_id: p.media.to_string(),
            media_label: media_label_for(&p.media),
            src_in_us: p.src_in_us,
            src_out_us: p.src_out_us,
            gain_db: p.gain_db.clone(),
            pan: p.pan.clone(),
            fade_in_us: p.fade_in_us,
            fade_out_us: p.fade_out_us,
            mute: p.mute,
            role: p.role.as_str().to_string(),
        }),
        LayerParams::Subtitles(p) => {
            let (kind, value) = match &p.source {
                SubtitlesSource::Media(id) => ("Media".to_string(), id.to_string()),
                SubtitlesSource::InlineAss(s) => ("InlineAss".to_string(), s.clone()),
                SubtitlesSource::InlineSrt(s) => ("InlineSrt".to_string(), s.clone()),
            };
            LayerParamsView::Subtitles(SubtitlesView {
                source_kind: kind,
                source_value: value,
            })
        }
        LayerParams::Motif(p) => {
            // imbl::HashMap<String, Value> → serde_json::Map. The values
            // are already serde_json::Value; we just need to materialize
            // the map into a serializable shape.
            let mut props = serde_json::Map::new();
            for (k, v) in p.props.iter() {
                props.insert(k.clone(), v.clone());
            }
            LayerParamsView::Motif(MotifView {
                motif_id: p.motif_id.clone(),
                x: p.transform.x.clone(),
                y: p.transform.y.clone(),
                scale_x: p.transform.scale_x.clone(),
                scale_y: p.transform.scale_y.clone(),
                opacity: p.opacity.clone(),
                src_in_us: p.src_in_us,
                props,
            })
        }
    }
}

fn layer_kind(params: &LayerParams) -> String {
    match params {
        LayerParams::VideoClip(_) => "VideoClip",
        LayerParams::ImageOverlay(_) => "ImageOverlay",
        LayerParams::Text(_) => "Text",
        LayerParams::Motif(_) => "Motif",
        LayerParams::Audio(_) => "Audio",
        LayerParams::Subtitles(_) => "Subtitles",
        LayerParams::Color(_) => "Color",
    }
    .to_string()
}

/// Transitional helper. Derives a `TrackKind`-like label from the track's
/// layers so the UI can keep its kind-based styling (`.kind-video`,
/// `.kind-audio`) while tracks are kind-agnostic.
///
/// Rules:
///   - any visual-class layer present → "Video"
///   - audio-only → "Audio"
///   - empty → "Video" (so reserved A/B-roll rows on a blank project
///     still style as video lanes — keeps the timeline visual stable)
fn derive_track_kind_label(track: &crate::state::Track) -> String {
    let mut has_visual = false;
    let mut has_audio = false;
    for layer in track.layers.iter() {
        match &layer.params {
            LayerParams::Audio(_) => has_audio = true,
            LayerParams::VideoClip(_)
            | LayerParams::ImageOverlay(_)
            | LayerParams::Color(_)
            | LayerParams::Motif(_)
            | LayerParams::Text(_) => has_visual = true,
            LayerParams::Subtitles(_) => {
                // Subtitle-only tracks should style as Subtitle so the
                // existing `.kind-subtitle` CSS still applies. If the
                // track also has video, video wins.
                if !has_visual {
                    return "Subtitle".to_string();
                }
            }
        }
    }
    if has_visual {
        "Video".to_string()
    } else if has_audio {
        "Audio".to_string()
    } else {
        "Video".to_string()
    }
}

fn layer_color_hint(layer: &crate::state::Layer) -> String {
    // Prefer the actual ColorParams color when the layer is a Color clip; otherwise
    // derive a stable color from the layer id so blocks look distinct.
    if let LayerParams::Color(p) = &layer.params {
        let rgba = match &p.color {
            crate::state::Animated::Static(c) => *c,
            crate::state::Animated::Keyframed(kfs) => {
                kfs.iter().next().map(|kf| kf.value).unwrap_or(crate::state::Rgba::BLACK)
            }
        };
        return format!("#{:02x}{:02x}{:02x}", rgba.r, rgba.g, rgba.b);
    }
    // Hash the UUID bytes for a stable hue.
    let bytes = layer.id.as_bytes();
    let hue = ((bytes[0] as u32) << 8 | bytes[1] as u32) % 360;
    hsl_to_hex(hue as f32, 0.55, 0.55)
}

fn hsl_to_hex(h: f32, s: f32, l: f32) -> String {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match h as u32 {
        0..=59 => (c, x, 0.0),
        60..=119 => (x, c, 0.0),
        120..=179 => (0.0, c, x),
        180..=239 => (0.0, x, c),
        240..=299 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    format!(
        "#{:02x}{:02x}{:02x}",
        ((r + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((g + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((b + m) * 255.0).round().clamp(0.0, 255.0) as u8,
    )
}


// ---- Mutation command Args structs ----

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparateAudioToNewTrackArgs {
    pub layer_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddColorLayerArgs {
    pub track_id: Option<String>,
    pub color: Option<crate::state::Rgba>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub t_start_us: crate::state::time::TimeUs,
    pub duration_us: Option<crate::state::time::TimeUs>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMediaLayerArgs {
    pub track_id: String,
    pub media_id: String,
    pub t_start_us: crate::state::time::TimeUs,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTextLayerArgs {
    pub track_id: Option<String>,
    pub content: Option<String>,
    pub t_start_us: crate::state::time::TimeUs,
    pub duration_us: Option<crate::state::time::TimeUs>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSubtitlesLayerArgs {
    pub media_id: String,
    pub t_start_us: crate::state::time::TimeUs,
    pub duration_us: crate::state::time::TimeUs,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLayerArgs {
    pub layer_id: String,
    pub patch: crate::state::actor::LayerPatch,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLayerParamsArgs {
    pub layer_id: String,
    pub patch: crate::state::actor::LayerParamsPatch,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLayerParamTrackArgs {
    pub layer_id: String,
    pub param_key: String,
    pub track: crate::state::animated::Animated<f64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLayerParamTracksArgs {
    pub layer_id: String,
    pub entries: Vec<(String, crate::state::animated::Animated<f64>)>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveLayerArgs {
    pub layer_id: String,
    pub new_track_id: String,
    pub new_t_start_us: crate::state::time::TimeUs,
    pub escape_group: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimLayerArgs {
    pub layer_id: String,
    pub edge: String,
    pub new_t_us: crate::state::time::TimeUs,
    pub escape_group: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitLayerGroupedArgs {
    pub layer_id: String,
    pub at_t_us: crate::state::time::TimeUs,
    pub escape_group: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupsCreateArgs {
    pub layer_ids: Vec<String>,
    pub label: Option<String>,
    pub reassign: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupsDissolveArgs {
    pub group_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateLayerArgs {
    pub layer_id: String,
    pub t_offset_us: crate::state::time::TimeUs,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLayerArgs {
    pub layer_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCompositionArgs {
    pub patch: crate::state::actor::CompositionPatch,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTrackFlagsArgs {
    pub track_id: String,
    pub patch: crate::state::TrackFlagsPatch,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRoleGainArgs {
    pub role: crate::state::audio_role::AudioRole,
    pub gain_db: f64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRoleFlagsArgs {
    pub role: crate::state::audio_role::AudioRole,
    pub patch: crate::state::audio_role::RoleFlagsPatch,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCheckpointArgs {
    pub checkpoint_id: String,
}

#[cfg(debug_assertions)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugSimulateAgentSessionArgs {
    pub reason: String,
}

#[cfg(debug_assertions)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLockHistoryArgs {
    pub reason: String,
}

// ---- Persistence command Args structs ----

/// `project_save_as` / `project_open`: a single workspace `.vproj` path.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathArgs {
    pub path: String,
}

#[cfg(feature = "jobs")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaIdArgs {
    pub media_id: String,
}

#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAudioOnlyArgs {
    pub output_path: String,
    pub audio: crate::export::AudioEncodeSpec,
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}

#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxExportArgs {
    pub video_path: String,
    pub audio_path: String,
    pub output_path: String,
    pub transcode: Option<crate::commands::export::TranscodeSpec>,
}

#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConformArgs {
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}

/// `project_new_workspace`: keys mirror `ipc/index.ts` (`parentFolder`,
/// `name`, `width`, `height`, `fpsNum`, `fpsDen`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWorkspaceArgs {
    pub parent_folder: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
}

#[cfg(test)]
mod text_view_tests {
    use super::*;
    use crate::state::{
        Animated, FontSpec, Outline, Rgba, Shadow, TextAlign, TextBackend, TextParams, Transform,
    };

    fn make_styled_text() -> TextParams {
        TextParams {
            content: "hi".into(),
            font: FontSpec {
                family: "Liberation Sans".into(),
                size_px: 54.0,
                weight: 700,
                italic: true,
            },
            color: Animated::Static(Rgba::WHITE),
            align: TextAlign::Center,
            transform: Transform {
                anchor: (0.5, 1.0),
                ..Default::default()
            },
            opacity: Animated::Static(1.0),
            shadow: Some(Shadow {
                color: Rgba::BLACK,
                offset_x: 2.0,
                offset_y: 2.0,
                blur: 2.0,
            }),
            outline: Some(Outline {
                color: Rgba::BLACK,
                width: 3.0,
            }),
            intro: None,
            outro: None,
            backend_hint: TextBackend::DrawText,
        }
    }

    #[test]
    fn text_view_carries_outline_shadow_align_anchor() {
        let params = LayerParams::Text(make_styled_text());
        let pool: imbl::HashMap<state::MediaId, state::MediaItem> = imbl::HashMap::new();
        let view = layer_params_view(&params, &pool);
        let LayerParamsView::Text(v) = view else {
            panic!("expected Text view");
        };
        assert_eq!(v.weight, 700);
        assert!(v.italic);
        assert_eq!(v.anchor_y, 1.0);
        assert!(v.outline.is_some());
        assert!(v.shadow.is_some());
    }
}
