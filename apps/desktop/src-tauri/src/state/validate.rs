//! Project invariants. Runs after every successful mutation; rejects the
//! commit when violated.
//!
//! Design: `docs/data-model.md` "Validation invariants". Template-prop schema
//! validation lives elsewhere (Phase 5, alongside the rasterizer manifest
//! loader) and is intentionally not covered here.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::animated::Animated;
use super::ids::{EffectId, KeyframeId, LayerId, MediaId, TrackId};
use super::layer::{Layer, LayerParams};
use super::project::Project;
use super::time::TimeUs;
use super::track::Track;
use super::transform::Transform;

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ValidationError {
    #[error("composition width and height must be positive; got {width}x{height}")]
    InvalidCanvas { width: u32, height: u32 },

    #[error("composition fps must be positive on both axes; got {num}/{den}")]
    InvalidFps { num: u32, den: u32 },

    #[error("layer {layer} time range invalid: t_start={t_start} must be < t_end={t_end}")]
    InvalidLayerRange {
        layer: LayerId,
        t_start: TimeUs,
        t_end: TimeUs,
    },

    #[error(
        "layer {b} would overlap layer {a} on track {track} at [{a_start}, {a_end}) vs [{b_start}, {b_end})"
    )]
    LayerOverlap {
        track: TrackId,
        a: LayerId,
        a_start: TimeUs,
        a_end: TimeUs,
        b: LayerId,
        b_start: TimeUs,
        b_end: TimeUs,
    },

    #[error("layer {layer} references missing media {media}")]
    MissingMedia { layer: LayerId, media: MediaId },

    #[error(
        "layer {layer} src range invalid: src_in={src_in} must be in [0, src_out) and src_out={src_out}"
    )]
    InvalidSrcRange {
        layer: LayerId,
        src_in: TimeUs,
        src_out: TimeUs,
    },

    #[error(
        "layer {layer} src range [{src_in}, {src_out}) exceeds media duration {media_duration}"
    )]
    SrcRangeExceedsMedia {
        layer: LayerId,
        src_in: TimeUs,
        src_out: TimeUs,
        media_duration: TimeUs,
    },

    #[error(
        "layer {layer} keyframe {keyframe} at t={t}us is outside [0, duration={duration}us]"
    )]
    KeyframeOutOfRange {
        layer: LayerId,
        keyframe: KeyframeId,
        t: TimeUs,
        duration: TimeUs,
    },

    #[error("duplicate layer id {layer}")]
    DuplicateLayerId { layer: LayerId },

    #[error("duplicate effect id {effect} on layer {layer}")]
    DuplicateEffectId { layer: LayerId, effect: EffectId },
}

pub fn validate(project: &Project) -> Result<(), ValidationError> {
    validate_composition(project)?;

    let mut seen_layers: HashSet<LayerId> = HashSet::new();

    for track in project.tracks.iter() {
        validate_track(project, track, &mut seen_layers)?;
    }
    Ok(())
}

fn validate_composition(p: &Project) -> Result<(), ValidationError> {
    let c = &p.composition;
    if c.width == 0 || c.height == 0 {
        return Err(ValidationError::InvalidCanvas {
            width: c.width,
            height: c.height,
        });
    }
    if c.fps.num == 0 || c.fps.den == 0 {
        return Err(ValidationError::InvalidFps {
            num: c.fps.num,
            den: c.fps.den,
        });
    }
    Ok(())
}

fn validate_track(
    project: &Project,
    track: &Track,
    seen_layers: &mut HashSet<LayerId>,
) -> Result<(), ValidationError> {
    // Snapshot layers sorted by start time; the data-model invariant says they
    // *should* already be sorted, but validation shouldn't depend on that.
    let mut sorted: Vec<&Layer> = track.layers.iter().collect();
    sorted.sort_by_key(|l| l.t_start_us);

    for (idx, layer) in sorted.iter().enumerate() {
        if !seen_layers.insert(layer.id) {
            return Err(ValidationError::DuplicateLayerId { layer: layer.id });
        }
        validate_layer(project, layer)?;

        if let Some(prev) = sorted.get(idx.wrapping_sub(1)) {
            if idx > 0 && layer.t_start_us < prev.t_end_us {
                return Err(ValidationError::LayerOverlap {
                    track: track.id,
                    a: prev.id,
                    a_start: prev.t_start_us,
                    a_end: prev.t_end_us,
                    b: layer.id,
                    b_start: layer.t_start_us,
                    b_end: layer.t_end_us,
                });
            }
        }
    }
    Ok(())
}

fn validate_layer(project: &Project, layer: &Layer) -> Result<(), ValidationError> {
    if layer.t_start_us >= layer.t_end_us {
        return Err(ValidationError::InvalidLayerRange {
            layer: layer.id,
            t_start: layer.t_start_us,
            t_end: layer.t_end_us,
        });
    }
    let duration = layer.t_end_us - layer.t_start_us;

    let mut seen_effects: HashSet<EffectId> = HashSet::new();
    for effect in layer.effects.iter() {
        if !seen_effects.insert(effect.id) {
            return Err(ValidationError::DuplicateEffectId {
                layer: layer.id,
                effect: effect.id,
            });
        }
    }

    match &layer.params {
        LayerParams::VideoClip(p) => {
            check_media_ref(project, layer.id, p.media)?;
            check_src_range(project, layer.id, p.media, p.src_in_us, p.src_out_us)?;
            check_animated(layer.id, &p.opacity, duration)?;
            check_transform(layer.id, &p.transform, duration)?;
        }
        LayerParams::ImageOverlay(p) => {
            check_media_ref(project, layer.id, p.media)?;
            check_animated(layer.id, &p.opacity, duration)?;
            check_transform(layer.id, &p.transform, duration)?;
        }
        LayerParams::Text(p) => {
            check_animated(layer.id, &p.opacity, duration)?;
            check_animated(layer.id, &p.color, duration)?;
            check_transform(layer.id, &p.transform, duration)?;
        }
        LayerParams::Template(p) => {
            check_animated(layer.id, &p.opacity, duration)?;
            check_transform(layer.id, &p.transform, duration)?;
            // template_id / props_schema validation is Phase 5.
        }
        LayerParams::Audio(p) => {
            check_media_ref(project, layer.id, p.media)?;
            check_src_range(project, layer.id, p.media, p.src_in_us, p.src_out_us)?;
            check_animated(layer.id, &p.gain_db, duration)?;
            check_animated(layer.id, &p.pan, duration)?;
        }
        LayerParams::Subtitles(_) | LayerParams::Color(_) => {
            // No referenced ranges or animated props yet.
        }
    }
    Ok(())
}

fn check_media_ref(
    project: &Project,
    layer: LayerId,
    media: MediaId,
) -> Result<(), ValidationError> {
    if !project.media_pool.contains_key(&media) {
        return Err(ValidationError::MissingMedia { layer, media });
    }
    Ok(())
}

fn check_src_range(
    project: &Project,
    layer: LayerId,
    media_id: MediaId,
    src_in_us: TimeUs,
    src_out_us: TimeUs,
) -> Result<(), ValidationError> {
    if src_in_us < 0 || src_in_us >= src_out_us {
        return Err(ValidationError::InvalidSrcRange {
            layer,
            src_in: src_in_us,
            src_out: src_out_us,
        });
    }
    if let Some(media) = project.media_pool.get(&media_id) {
        if let Some(media_duration) = media.metadata.duration_us {
            if src_out_us > media_duration {
                return Err(ValidationError::SrcRangeExceedsMedia {
                    layer,
                    src_in: src_in_us,
                    src_out: src_out_us,
                    media_duration,
                });
            }
        }
    }
    Ok(())
}

fn check_animated<T: Clone>(
    layer: LayerId,
    anim: &Animated<T>,
    duration: TimeUs,
) -> Result<(), ValidationError> {
    if let Animated::Keyframed(kfs) = anim {
        for kf in kfs.iter() {
            if kf.t_us < 0 || kf.t_us > duration {
                return Err(ValidationError::KeyframeOutOfRange {
                    layer,
                    keyframe: kf.id,
                    t: kf.t_us,
                    duration,
                });
            }
        }
    }
    Ok(())
}

fn check_transform(
    layer: LayerId,
    t: &Transform,
    duration: TimeUs,
) -> Result<(), ValidationError> {
    check_animated(layer, &t.x, duration)?;
    check_animated(layer, &t.y, duration)?;
    check_animated(layer, &t.scale_x, duration)?;
    check_animated(layer, &t.scale_y, duration)?;
    check_animated(layer, &t.rotation_deg, duration)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::state::animated::{Animated, Interpolation, Keyframe};
    use crate::state::color::Rgba;
    use crate::state::effect::{Effect, EffectParams};
    use crate::state::ids::new_id;
    use crate::state::layer::{ColorParams, Layer, LayerParams, VideoClipParams};
    use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
    use crate::state::project::Project;
    use crate::state::track::{Track, TrackKind};
    use crate::state::transform::Transform;

    fn blank() -> Project {
        Project::new_blank("test")
    }

    fn color_layer(t_start: TimeUs, t_end: TimeUs) -> Layer {
        Layer {
            id: new_id(),
            label: None,
            t_start_us: t_start,
            t_end_us: t_end,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Color(ColorParams {
                color: Animated::Static(Rgba::WHITE),
                width: 1920,
                height: 1080,
            }),
        }
    }

    fn dummy_video_media(duration_us: TimeUs) -> MediaItem {
        MediaItem {
            id: new_id(),
            label: None,
            path_abs: "/tmp/x.mp4".into(),
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

    #[test]
    fn empty_project_validates() {
        validate(&blank()).expect("empty project should validate");
    }

    #[test]
    fn rejects_zero_canvas() {
        let mut p = blank();
        p.composition.width = 0;
        assert!(matches!(
            validate(&p),
            Err(ValidationError::InvalidCanvas { width: 0, .. })
        ));
    }

    #[test]
    fn rejects_zero_fps_denominator() {
        let mut p = blank();
        p.composition.fps.den = 0;
        assert!(matches!(
            validate(&p),
            Err(ValidationError::InvalidFps { den: 0, .. })
        ));
    }

    #[test]
    fn rejects_inverted_layer_range() {
        let mut p = blank();
        let mut track = Track::new(TrackKind::Video);
        track.layers.push_back(color_layer(5_000_000, 1_000_000));
        p.tracks.push_back(track);
        assert!(matches!(
            validate(&p),
            Err(ValidationError::InvalidLayerRange { .. })
        ));
    }

    #[test]
    fn rejects_overlapping_layers_on_same_track() {
        let mut p = blank();
        let mut track = Track::new(TrackKind::Video);
        track.layers.push_back(color_layer(0, 3_000_000));
        track.layers.push_back(color_layer(2_000_000, 4_000_000));
        p.tracks.push_back(track);
        assert!(matches!(
            validate(&p),
            Err(ValidationError::LayerOverlap { .. })
        ));
    }

    #[test]
    fn allows_overlap_across_different_tracks() {
        let mut p = blank();
        let mut t1 = Track::new(TrackKind::Video);
        t1.layers.push_back(color_layer(0, 3_000_000));
        let mut t2 = Track::new(TrackKind::Video);
        t2.layers.push_back(color_layer(1_000_000, 2_000_000));
        p.tracks.push_back(t1);
        p.tracks.push_back(t2);
        validate(&p).expect("overlap on different tracks is allowed");
    }

    #[test]
    fn rejects_dangling_media_reference() {
        let mut p = blank();
        let mut track = Track::new(TrackKind::Video);
        let layer = Layer {
            params: LayerParams::VideoClip(VideoClipParams {
                media: new_id(), // never imported into media_pool
                src_in_us: 0,
                src_out_us: 1_000_000,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: Default::default(),
                speed: 1.0,
            }),
            ..color_layer(0, 1_000_000)
        };
        track.layers.push_back(layer);
        p.tracks.push_back(track);
        assert!(matches!(
            validate(&p),
            Err(ValidationError::MissingMedia { .. })
        ));
    }

    #[test]
    fn rejects_src_range_beyond_media_duration() {
        let mut p = blank();
        let media = dummy_video_media(5_000_000);
        let media_id = media.id;
        p.media_pool.insert(media_id, media);

        let mut track = Track::new(TrackKind::Video);
        let layer = Layer {
            params: LayerParams::VideoClip(VideoClipParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: 10_000_000, // exceeds 5s media
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: Default::default(),
                speed: 1.0,
            }),
            ..color_layer(0, 5_000_000)
        };
        track.layers.push_back(layer);
        p.tracks.push_back(track);
        assert!(matches!(
            validate(&p),
            Err(ValidationError::SrcRangeExceedsMedia { .. })
        ));
    }

    #[test]
    fn rejects_inverted_src_range() {
        let mut p = blank();
        let media = dummy_video_media(10_000_000);
        let media_id = media.id;
        p.media_pool.insert(media_id, media);

        let mut track = Track::new(TrackKind::Video);
        let layer = Layer {
            params: LayerParams::VideoClip(VideoClipParams {
                media: media_id,
                src_in_us: 5_000_000,
                src_out_us: 1_000_000,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: Default::default(),
                speed: 1.0,
            }),
            ..color_layer(0, 1_000_000)
        };
        track.layers.push_back(layer);
        p.tracks.push_back(track);
        assert!(matches!(
            validate(&p),
            Err(ValidationError::InvalidSrcRange { .. })
        ));
    }

    #[test]
    fn rejects_keyframe_outside_layer_duration() {
        let mut p = blank();
        let mut track = Track::new(TrackKind::Video);
        let mut layer = color_layer(0, 1_000_000);
        // Keyframe at 5s on a 1s layer.
        let bad_kf = Keyframe {
            id: new_id(),
            t_us: 5_000_000,
            value: 1.0_f64,
            interp: Interpolation::Linear,
        };
        layer.params = LayerParams::ImageOverlay(crate::state::layer::ImageOverlayParams {
            media: {
                // Insert a media to not trigger MissingMedia first.
                let m = dummy_video_media(10_000_000);
                let id = m.id;
                p.media_pool.insert(id, m);
                id
            },
            transform: Transform::default(),
            opacity: Animated::Keyframed(imbl::vector![bad_kf]),
            blend_mode: Default::default(),
        });
        track.layers.push_back(layer);
        p.tracks.push_back(track);
        assert!(matches!(
            validate(&p),
            Err(ValidationError::KeyframeOutOfRange { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_effect_id() {
        let mut p = blank();
        let mut track = Track::new(TrackKind::Video);
        let mut layer = color_layer(0, 1_000_000);
        let same_id = new_id();
        let mk_effect = || Effect {
            id: same_id,
            enabled: true,
            params: EffectParams::Blur {
                radius: Animated::Static(1.0),
            },
        };
        layer.effects.push_back(mk_effect());
        layer.effects.push_back(mk_effect());
        track.layers.push_back(layer);
        p.tracks.push_back(track);
        assert!(matches!(
            validate(&p),
            Err(ValidationError::DuplicateEffectId { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_layer_id() {
        let mut p = blank();
        let mut t1 = Track::new(TrackKind::Video);
        let mut t2 = Track::new(TrackKind::Video);
        let dup_layer = color_layer(0, 1_000_000);
        t1.layers.push_back(dup_layer.clone());
        t2.layers.push_back(dup_layer);
        p.tracks.push_back(t1);
        p.tracks.push_back(t2);
        assert!(matches!(
            validate(&p),
            Err(ValidationError::DuplicateLayerId { .. })
        ));
    }
}

