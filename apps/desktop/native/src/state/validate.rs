//! Project invariants. Runs after every successful mutation; rejects the
//! commit when violated.
//!
//! Design: `docs/data-model.md` "Validation invariants". Motif-prop schema
//! validation lives with the rasterizer manifest loader and is intentionally
//! not covered here.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::animated::Animated;
use super::ids::{GroupId, KeyframeId, LayerId, MediaId, TrackId, TransitionId};
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

    #[error("duplicate layer id {layer}")]
    DuplicateLayerId { layer: LayerId },

    #[error("transition {transition} references unknown layer {layer}")]
    TransitionLayerMissing {
        transition: TransitionId,
        layer: LayerId,
    },

    #[error("transition {transition} from_layer and to_layer must be distinct ({layer})")]
    TransitionSelfReference {
        transition: TransitionId,
        layer: LayerId,
    },

    #[error(
        "transition {transition} from_layer {from} and to_layer {to} are on different tracks"
    )]
    TransitionCrossTrack {
        transition: TransitionId,
        from: LayerId,
        to: LayerId,
    },

    #[error(
        "transition {transition} duration {duration}us must equal layer overlap {overlap}us"
    )]
    TransitionDurationMismatch {
        transition: TransitionId,
        duration: TimeUs,
        overlap: TimeUs,
    },

    #[error(
        "transition {transition} duration {duration}us must be positive and not exceed either layer's length"
    )]
    TransitionDurationOutOfRange {
        transition: TransitionId,
        duration: TimeUs,
    },

    #[error("layer {layer} is in more than one transition on the same side")]
    LayerInMultipleTransitions { layer: LayerId },

    #[error("duplicate transition id {transition}")]
    DuplicateTransitionId { transition: TransitionId },

    #[error("group {group} references unknown layer {layer}")]
    GroupMemberMissing { group: GroupId, layer: LayerId },

    #[error("layer {layer} appears in more than one group ({first} and {second})")]
    LayerInMultipleGroups {
        layer: LayerId,
        first: GroupId,
        second: GroupId,
    },

    #[error("duplicate group id {group}")]
    DuplicateGroupId { group: GroupId },

    #[error("group {group} has fewer than 2 members — should have been auto-dissolved")]
    GroupBelowMinSize { group: GroupId, members: usize },

}

pub fn validate(project: &Project) -> Result<(), ValidationError> {
    validate_composition(project)?;

    let authorized = validate_transitions(project)?;
    let mut seen_layers: HashSet<LayerId> = HashSet::new();

    for track in project.tracks.iter() {
        validate_track(project, track, &mut seen_layers, &authorized)?;
    }
    validate_groups(project, &seen_layers)?;
    Ok(())
}

/// Group invariants (`docs/groups.md`):
///   1. Every `Group.members` LayerId resolves to a real layer.
///   2. A LayerId appears in at most one group.
///   3. Group IDs are unique.
///   4. Every group has ≥ 2 members (groups below the threshold should have
///      been auto-dissolved by the actor; surfacing them here catches drift).
fn validate_groups(
    project: &Project,
    known_layers: &HashSet<LayerId>,
) -> Result<(), ValidationError> {
    let mut seen_ids: HashSet<GroupId> = HashSet::new();
    let mut layer_to_group: HashMap<LayerId, GroupId> = HashMap::new();

    for g in project.groups.iter() {
        if !seen_ids.insert(g.id) {
            return Err(ValidationError::DuplicateGroupId { group: g.id });
        }
        if g.members.len() < 2 {
            return Err(ValidationError::GroupBelowMinSize {
                group: g.id,
                members: g.members.len(),
            });
        }
        for &m in g.members.iter() {
            if !known_layers.contains(&m) {
                return Err(ValidationError::GroupMemberMissing {
                    group: g.id,
                    layer: m,
                });
            }
            if let Some(&first) = layer_to_group.get(&m) {
                return Err(ValidationError::LayerInMultipleGroups {
                    layer: m,
                    first,
                    second: g.id,
                });
            }
            layer_to_group.insert(m, g.id);
        }
    }

    // No effect-class compatibility check here: the per-layer effects subsystem
    // isn't built yet (future `layer.effects`). When it lands, effect routing is
    // an effect-add-time / planner concern, not a commit-time invariant.

    Ok(())
}

/// Pair of layer ids that are allowed to overlap, with the authorized
/// duration. Lookup is unordered (insertion order doesn't matter).
fn pair(a: LayerId, b: LayerId) -> (LayerId, LayerId) {
    if a <= b { (a, b) } else { (b, a) }
}

type AuthorizedOverlaps = HashMap<(LayerId, LayerId), TimeUs>;

/// Walk `project.transitions`, validate each entry against the project, and
/// return a map of {pair of layer ids → authorized overlap duration} so the
/// per-track overlap check can exempt them.
fn validate_transitions(project: &Project) -> Result<AuthorizedOverlaps, ValidationError> {
    // Index layers by id and capture (track_id, t_start, t_end) so the
    // per-transition check stays O(1) instead of O(layers).
    let mut layer_index: HashMap<LayerId, (TrackId, TimeUs, TimeUs)> = HashMap::new();
    for track in project.tracks.iter() {
        for layer in track.layers.iter() {
            layer_index.insert(layer.id, (track.id, layer.t_start_us, layer.t_end_us));
        }
    }

    let mut authorized: AuthorizedOverlaps = HashMap::new();
    let mut seen_ids: HashSet<TransitionId> = HashSet::new();
    // A layer can be at most ONE outgoing source and ONE incoming target.
    // Both sides separately so a layer can be the receiver from one neighbor
    // AND the source for another (B in an A→B→C chain).
    let mut as_from: HashSet<LayerId> = HashSet::new();
    let mut as_to: HashSet<LayerId> = HashSet::new();

    for tr in project.transitions.iter() {
        if !seen_ids.insert(tr.id) {
            return Err(ValidationError::DuplicateTransitionId { transition: tr.id });
        }
        if tr.from_layer == tr.to_layer {
            return Err(ValidationError::TransitionSelfReference {
                transition: tr.id,
                layer: tr.from_layer,
            });
        }
        let (from_track, from_start, from_end) = *layer_index
            .get(&tr.from_layer)
            .ok_or(ValidationError::TransitionLayerMissing {
                transition: tr.id,
                layer: tr.from_layer,
            })?;
        let (to_track, to_start, to_end) = *layer_index
            .get(&tr.to_layer)
            .ok_or(ValidationError::TransitionLayerMissing {
                transition: tr.id,
                layer: tr.to_layer,
            })?;
        if from_track != to_track {
            return Err(ValidationError::TransitionCrossTrack {
                transition: tr.id,
                from: tr.from_layer,
                to: tr.to_layer,
            });
        }
        let from_len = (from_end - from_start).max(0);
        let to_len = (to_end - to_start).max(0);
        if tr.duration_us <= 0 || tr.duration_us > from_len || tr.duration_us > to_len {
            return Err(ValidationError::TransitionDurationOutOfRange {
                transition: tr.id,
                duration: tr.duration_us,
            });
        }
        let overlap_start = from_start.max(to_start);
        let overlap_end = from_end.min(to_end);
        let overlap = (overlap_end - overlap_start).max(0);
        if overlap != tr.duration_us {
            return Err(ValidationError::TransitionDurationMismatch {
                transition: tr.id,
                duration: tr.duration_us,
                overlap,
            });
        }
        if !as_from.insert(tr.from_layer) {
            return Err(ValidationError::LayerInMultipleTransitions {
                layer: tr.from_layer,
            });
        }
        if !as_to.insert(tr.to_layer) {
            return Err(ValidationError::LayerInMultipleTransitions {
                layer: tr.to_layer,
            });
        }
        authorized.insert(pair(tr.from_layer, tr.to_layer), tr.duration_us);
    }
    Ok(authorized)
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
    authorized: &AuthorizedOverlaps,
) -> Result<(), ValidationError> {
    // Snapshot layers sorted by start time; the data-model invariant says they
    // *should* already be sorted, but validation shouldn't depend on that.
    let mut sorted: Vec<&Layer> = track.layers.iter().collect();
    sorted.sort_by_key(|l| l.t_start_us);

    // The within-track overlap invariant is per-class, not per-track:
    // Visual-class layers (video / image / color / motif
    // / text / subtitle) can't overlap with each other on the same
    // track; Audio layers can't overlap with each other; but a Visual
    // layer and an Audio layer CAN coexist at the same time slot
    // (enables AE-style combined-row rendering for AV pairs imported
    // onto the same track). Track previous-seen per class as we walk
    // the sorted layer list.
    let mut prev_visual: Option<&Layer> = None;
    let mut prev_audio: Option<&Layer> = None;

    for layer in sorted.iter() {
        if !seen_layers.insert(layer.id) {
            return Err(ValidationError::DuplicateLayerId { layer: layer.id });
        }
        validate_layer(project, layer)?;

        let class = layer_overlap_class(&layer.params);
        let prev = match class {
            OverlapClass::Visual => prev_visual.as_ref(),
            OverlapClass::Audio => prev_audio.as_ref(),
        }
        .copied();

        if let Some(prev) = prev {
            if layer.t_start_us < prev.t_end_us {
                // Overlap detected within the same class. Reject UNLESS
                // a transition authorizes it AND the overlap length
                // matches what the transition declares. (Cross-class
                // overlap never reaches here — see prev_visual /
                // prev_audio split above.)
                let overlap = prev.t_end_us - layer.t_start_us;
                let key = pair(prev.id, layer.id);
                let allowed = authorized.get(&key).copied().unwrap_or(0);
                if allowed != overlap {
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

        // Update the per-class "last seen" pointer. We pick whichever
        // ends later so the next iteration's overlap check is against
        // the longest-reaching prior layer of the same class — handles
        // the case where a long clip starts earlier than a short one.
        match class {
            OverlapClass::Visual => {
                prev_visual = Some(match prev_visual {
                    Some(p) if p.t_end_us >= layer.t_end_us => p,
                    _ => layer,
                });
            }
            OverlapClass::Audio => {
                prev_audio = Some(match prev_audio {
                    Some(p) if p.t_end_us >= layer.t_end_us => p,
                    _ => layer,
                });
            }
        }
    }
    Ok(())
}

/// Class used for the within-track overlap rule (V.2). Visual covers
/// every layer kind that contributes to the video output frame
/// (VideoClip, ImageOverlay, Color, Motif, Text). Audio is the only
/// audio-class. New layer kinds added later default to Visual unless
/// they're audio-only.
#[derive(Copy, Clone, PartialEq, Eq)]
enum OverlapClass {
    Visual,
    Audio,
}

fn layer_overlap_class(params: &super::layer::LayerParams) -> OverlapClass {
    use super::layer::LayerParams;
    match params {
        LayerParams::Audio(_) => OverlapClass::Audio,
        LayerParams::VideoClip(_)
        | LayerParams::ImageOverlay(_)
        | LayerParams::Color(_)
        | LayerParams::Motif(_)
        | LayerParams::Text(_) => OverlapClass::Visual,
    }
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
        LayerParams::Motif(p) => {
            check_animated(layer.id, &p.opacity, duration)?;
            check_transform(layer.id, &p.transform, duration)?;
            // motif_id / props_schema are not validated here (done with the manifest loader).
        }
        LayerParams::Audio(p) => {
            check_media_ref(project, layer.id, p.media)?;
            check_src_range(project, layer.id, p.media, p.src_in_us, p.src_out_us)?;
            check_animated(layer.id, &p.gain_db, duration)?;
            check_animated(layer.id, &p.pan, duration)?;
        }
        LayerParams::Color(_) => {
            // No referenced ranges or animated props.
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

/// Keyframe times are intentionally NOT range-checked against the layer
/// duration. Trimming a clip deliberately pushes keyframes out of
/// `[0, duration]` (head-trim → negative `t_us`, tail-trim → beyond
/// `duration`) and KEEPS them in data so the trim is non-destructive and
/// reversible (keyframe-authoring spec §6). `Animated::value_at` clamps
/// out-of-range keys at eval and the UI hides/dims them, so an out-of-range
/// `t_us` is valid stored state, not a defect. Kept as a typed seam for
/// future keyframe invariants (the params still thread through unused).
fn check_animated<T: Clone>(
    _layer: LayerId,
    _anim: &Animated<T>,
    _duration: TimeUs,
) -> Result<(), ValidationError> {
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
    use crate::state::ids::new_id;
    use crate::state::layer::{ColorParams, Layer, LayerParams, VideoClipParams};
    use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
    use crate::state::project::Project;
    use crate::state::track::Track;
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
                ..Default::default()
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
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
        let mut track = Track::new();
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
        let mut track = Track::new();
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
        let mut t1 = Track::new();
        t1.layers.push_back(color_layer(0, 3_000_000));
        let mut t2 = Track::new();
        t2.layers.push_back(color_layer(1_000_000, 2_000_000));
        p.tracks.push_back(t1);
        p.tracks.push_back(t2);
        validate(&p).expect("overlap on different tracks is allowed");
    }

    #[test]
    fn allows_visual_and_audio_on_same_track_at_same_time() {
        // V.2 (A/B-roll v2): different overlap classes can coexist
        // at the same time slot on the same track. This enables the
        // AE-style combined-row rendering for AV pairs from import —
        // both layers live on one track, validation accepts it.
        use crate::state::audio_role::AudioRole;
        use crate::state::layer::AudioParams;
        let mut p = blank();
        // Need a media item so the Audio layer's media_id resolves.
        let media = dummy_video_media(5_000_000);
        let media_id = media.id;
        p.media_pool.insert(media_id, media);

        let mut track = Track::new();
        // VideoClip-equivalent stand-in: the existing color_layer helper
        // makes a Visual-class layer; we use that for the visual side.
        track.layers.push_back(color_layer(0, 3_000_000));
        // Audio layer overlapping the same window — different class.
        let audio = Layer {
            id: new_id(),
            label: None,
            t_start_us: 0,
            t_end_us: 3_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::Audio(AudioParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: 3_000_000,
                gain_db: Animated::Static(0.0),
                pan: Animated::Static(0.0),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
                role: AudioRole::Dialogue,
            }),
        };
        track.layers.push_back(audio);
        p.tracks.push_back(track);
        validate(&p).expect("V + A on same track at same time is allowed under V.2");
    }

    #[test]
    fn rejects_two_audio_layers_overlapping_on_same_track() {
        // V.2 negative case: same-class overlap still rejected. Two
        // audio layers can't share a time slot on one track (one
        // waveform per audio bus position).
        use crate::state::audio_role::AudioRole;
        use crate::state::layer::AudioParams;
        let mut p = blank();
        let media = dummy_video_media(5_000_000);
        let media_id = media.id;
        p.media_pool.insert(media_id, media);

        let mut track = Track::new();
        let mk_audio = |id_seed: u8, t_start: TimeUs, t_end: TimeUs| Layer {
            id: new_id(),
            label: Some(format!("audio-{id_seed}")),
            t_start_us: t_start,
            t_end_us: t_end,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::Audio(AudioParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: t_end - t_start,
                gain_db: Animated::Static(0.0),
                pan: Animated::Static(0.0),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
                role: AudioRole::Dialogue,
            }),
        };
        track.layers.push_back(mk_audio(1, 0, 3_000_000));
        track.layers.push_back(mk_audio(2, 2_000_000, 4_000_000));
        p.tracks.push_back(track);
        assert!(matches!(
            validate(&p),
            Err(ValidationError::LayerOverlap { .. })
        ));
    }

    #[test]
    fn rejects_dangling_media_reference() {
        let mut p = blank();
        let mut track = Track::new();
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
                fade_in_us: 0,
                fade_out_us: 0,
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

        let mut track = Track::new();
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
                fade_in_us: 0,
                fade_out_us: 0,
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

        let mut track = Track::new();
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
                fade_in_us: 0,
                fade_out_us: 0,
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
    fn accepts_out_of_range_keyframe() {
        // Out-of-range keyframe times are valid stored state by design:
        // trimming keeps keyframes that fall outside [0, duration] (negative
        // after a head-trim, beyond duration after a tail-trim) so the trim is
        // non-destructive (keyframe-authoring spec §6). The validator must NOT
        // reject them — value_at clamps at eval, the UI hides them.
        let mut p = blank();
        let mut track = Track::new();
        let mut layer = color_layer(0, 1_000_000);
        // Two out-of-range keys on a 1s layer: one before the start (negative,
        // as a head-trim would produce) and one beyond the end (as a tail-trim
        // would produce).
        let before = Keyframe {
            id: new_id(),
            t_us: -2_000_000,
            value: 0.0_f64,
            interp: Interpolation::Linear,
        };
        let beyond = Keyframe {
            id: new_id(),
            t_us: 5_000_000,
            value: 1.0_f64,
            interp: Interpolation::Linear,
        };
        layer.params = LayerParams::ImageOverlay(crate::state::layer::ImageOverlayParams {
            media: {
                // Insert a media so MissingMedia / src-range checks don't fire first.
                let m = dummy_video_media(10_000_000);
                let id = m.id;
                p.media_pool.insert(id, m);
                id
            },
            transform: Transform::default(),
            opacity: Animated::Keyframed(imbl::vector![before, beyond]),
            blend_mode: Default::default(),
            fade_in_us: 0,
            fade_out_us: 0,
        });
        track.layers.push_back(layer);
        p.tracks.push_back(track);
        assert!(validate(&p).is_ok(), "out-of-range keyframes must validate");
    }

    #[test]
    fn rejects_duplicate_layer_id() {
        let mut p = blank();
        let mut t1 = Track::new();
        let mut t2 = Track::new();
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

    // ============================================================
    // Transitions
    // ============================================================

    use crate::state::transition::{Transition, TransitionKind};

    fn pair_of_overlapping_layers(
        a_start: TimeUs,
        a_end: TimeUs,
        b_start: TimeUs,
        b_end: TimeUs,
    ) -> (Project, LayerId, LayerId) {
        let mut p = blank();
        let mut t = Track::new();
        let a = color_layer(a_start, a_end);
        let b = color_layer(b_start, b_end);
        let a_id = a.id;
        let b_id = b.id;
        t.layers.push_back(a);
        t.layers.push_back(b);
        p.tracks.push_back(t);
        (p, a_id, b_id)
    }

    #[test]
    fn transition_authorizes_layer_overlap() {
        let (mut p, a, b) =
            pair_of_overlapping_layers(0, 3_000_000, 2_000_000, 5_000_000);
        // Overlap = 1s; without a transition this would error LayerOverlap.
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a,
            to_layer: b,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        validate(&p).expect("transition authorizes the overlap");
    }

    #[test]
    fn transition_with_wrong_duration_rejects() {
        let (mut p, a, b) =
            pair_of_overlapping_layers(0, 3_000_000, 2_000_000, 5_000_000);
        // Actual overlap = 1s, transition claims 2s. Mismatch → reject.
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a,
            to_layer: b,
            duration_us: 2_000_000,
            kind: TransitionKind::Crossfade,
        });
        assert!(matches!(
            validate(&p),
            Err(ValidationError::TransitionDurationMismatch { .. })
        ));
    }

    #[test]
    fn transition_rejects_self_reference() {
        let (mut p, a, _b) =
            pair_of_overlapping_layers(0, 3_000_000, 2_000_000, 5_000_000);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a,
            to_layer: a,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        assert!(matches!(
            validate(&p),
            Err(ValidationError::TransitionSelfReference { .. })
        ));
    }

    #[test]
    fn transition_rejects_unknown_layer() {
        let (mut p, a, _b) =
            pair_of_overlapping_layers(0, 3_000_000, 2_000_000, 5_000_000);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a,
            to_layer: new_id(),
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        assert!(matches!(
            validate(&p),
            Err(ValidationError::TransitionLayerMissing { .. })
        ));
    }

    #[test]
    fn transition_rejects_cross_track_layers() {
        let mut p = blank();
        let mut t1 = Track::new();
        let mut t2 = Track::new();
        let a = color_layer(0, 3_000_000);
        let b = color_layer(0, 3_000_000);
        let a_id = a.id;
        let b_id = b.id;
        t1.layers.push_back(a);
        t2.layers.push_back(b);
        p.tracks.push_back(t1);
        p.tracks.push_back(t2);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a_id,
            to_layer: b_id,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        assert!(matches!(
            validate(&p),
            Err(ValidationError::TransitionCrossTrack { .. })
        ));
    }

    #[test]
    fn transition_rejects_zero_duration() {
        let (mut p, a, b) =
            pair_of_overlapping_layers(0, 3_000_000, 2_000_000, 5_000_000);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a,
            to_layer: b,
            duration_us: 0,
            kind: TransitionKind::Crossfade,
        });
        assert!(matches!(
            validate(&p),
            Err(ValidationError::TransitionDurationOutOfRange { .. })
        ));
    }

    #[test]
    fn transition_rejects_duration_exceeding_layer_length() {
        // Both layers 1s long, transition claims 2s → over-range.
        let (mut p, a, b) =
            pair_of_overlapping_layers(0, 1_000_000, 0, 1_000_000);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a,
            to_layer: b,
            duration_us: 2_000_000,
            kind: TransitionKind::Crossfade,
        });
        assert!(matches!(
            validate(&p),
            Err(ValidationError::TransitionDurationOutOfRange { .. })
        ));
    }

    #[test]
    fn rejects_layer_in_two_transitions_on_same_side() {
        // Layer B receives from two different sources A and C → invalid.
        let mut p = blank();
        let mut t = Track::new();
        let a = color_layer(0, 3_000_000);
        let b = color_layer(2_000_000, 5_000_000);
        let c = color_layer(4_000_000, 7_000_000);
        let a_id = a.id;
        let b_id = b.id;
        let c_id = c.id;
        t.layers.push_back(a);
        t.layers.push_back(b);
        t.layers.push_back(c);
        p.tracks.push_back(t);
        // Both transitions name B as the incoming side.
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a_id,
            to_layer: b_id,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: c_id,
            to_layer: b_id,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        assert!(matches!(
            validate(&p),
            Err(ValidationError::LayerInMultipleTransitions { .. })
        ));
    }

    #[test]
    fn chain_a_to_b_to_c_is_valid() {
        // B is the receiver from A AND the sender to C — that's fine (two
        // different sides). Layer A is only a sender, C is only a receiver.
        let mut p = blank();
        let mut t = Track::new();
        let a = color_layer(0, 3_000_000);
        let b = color_layer(2_000_000, 5_000_000);
        let c = color_layer(4_000_000, 7_000_000);
        let a_id = a.id;
        let b_id = b.id;
        let c_id = c.id;
        t.layers.push_back(a);
        t.layers.push_back(b);
        t.layers.push_back(c);
        p.tracks.push_back(t);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a_id,
            to_layer: b_id,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: b_id,
            to_layer: c_id,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        validate(&p).expect("A→B→C chain is valid");
    }

    #[test]
    fn rejects_duplicate_transition_id() {
        let (mut p, a, b) =
            pair_of_overlapping_layers(0, 3_000_000, 2_000_000, 5_000_000);
        let dup_id = new_id();
        p.transitions.push_back(Transition {
            id: dup_id,
            from_layer: a,
            to_layer: b,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        p.transitions.push_back(Transition {
            id: dup_id,
            from_layer: a,
            to_layer: b,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        assert!(matches!(
            validate(&p),
            Err(ValidationError::DuplicateTransitionId { .. })
        ));
    }

    // ============================================================
    // Groups (`docs/groups.md`)
    // ============================================================

    use crate::state::group::Group;

    fn add_layer_to_new_video_track(p: &mut Project, l: Layer) -> LayerId {
        let id = l.id;
        let mut t = Track::new();
        t.layers.push_back(l);
        p.tracks.push_back(t);
        id
    }

    #[test]
    fn group_with_two_valid_members_validates() {
        let mut p = blank();
        let a = add_layer_to_new_video_track(&mut p, color_layer(0, 1_000_000));
        let b = add_layer_to_new_video_track(&mut p, color_layer(2_000_000, 3_000_000));
        p.groups.push_back(Group::from_iter(new_id(), None, [a, b]));
        validate(&p).expect("valid group should pass");
    }

    #[test]
    fn group_referencing_missing_layer_rejects() {
        let mut p = blank();
        let a = add_layer_to_new_video_track(&mut p, color_layer(0, 1_000_000));
        let ghost = new_id();
        p.groups.push_back(Group::from_iter(new_id(), None, [a, ghost]));
        assert!(matches!(
            validate(&p),
            Err(ValidationError::GroupMemberMissing { .. })
        ));
    }

    #[test]
    fn layer_in_two_groups_rejects() {
        let mut p = blank();
        let a = add_layer_to_new_video_track(&mut p, color_layer(0, 1_000_000));
        let b = add_layer_to_new_video_track(&mut p, color_layer(2_000_000, 3_000_000));
        let c = add_layer_to_new_video_track(&mut p, color_layer(4_000_000, 5_000_000));
        p.groups.push_back(Group::from_iter(new_id(), None, [a, b]));
        // `a` joins a second group → invariant violated.
        p.groups.push_back(Group::from_iter(new_id(), None, [a, c]));
        assert!(matches!(
            validate(&p),
            Err(ValidationError::LayerInMultipleGroups { .. })
        ));
    }

    #[test]
    fn duplicate_group_id_rejects() {
        let mut p = blank();
        let a = add_layer_to_new_video_track(&mut p, color_layer(0, 1_000_000));
        let b = add_layer_to_new_video_track(&mut p, color_layer(2_000_000, 3_000_000));
        let c = add_layer_to_new_video_track(&mut p, color_layer(4_000_000, 5_000_000));
        let d = add_layer_to_new_video_track(&mut p, color_layer(6_000_000, 7_000_000));
        let dup = new_id();
        p.groups.push_back(Group::from_iter(dup, None, [a, b]));
        p.groups.push_back(Group::from_iter(dup, None, [c, d]));
        assert!(matches!(
            validate(&p),
            Err(ValidationError::DuplicateGroupId { .. })
        ));
    }

    #[test]
    fn group_below_min_size_rejects() {
        let mut p = blank();
        let a = add_layer_to_new_video_track(&mut p, color_layer(0, 1_000_000));
        // Single-member "group" — actor should have auto-dissolved it.
        p.groups.push_back(Group::from_iter(new_id(), None, [a]));
        assert!(matches!(
            validate(&p),
            Err(ValidationError::GroupBelowMinSize { members: 1, .. })
        ));
    }

    #[test]
    fn index_groups_maps_each_member_to_its_group() {
        let g1 = new_id();
        let g2 = new_id();
        let a = new_id();
        let b = new_id();
        let c = new_id();
        let groups: imbl::Vector<Group> = imbl::vector![
            Group::from_iter(g1, None, [a, b]),
            Group::from_iter(g2, None, [c, new_id()]),
        ];
        let idx = crate::state::group::index_groups(&groups);
        assert_eq!(idx.get(&a), Some(&g1));
        assert_eq!(idx.get(&b), Some(&g1));
        assert_eq!(idx.get(&c), Some(&g2));
    }

}

