//! Project state, single-writer actor, history, persistence.
//!
//! Design: `docs/data-model.md`.
//!
//! Phase 1 build order (`docs/data-model.md` "Implementation footprint"):
//!   1. Type definitions + JSON round-trip.        ← here
//!   2. Single-writer actor with `add_layer` / `delete_layer` only.
//!   3. History (snapshot ring + named checkpoints).
//!   4. Validation invariants.
//!   5. Full mutation surface.
//!   6. Save/load with `schema_version: 1`.
//!   7. MCP resource serialization + tool wiring.
//!   8. UI bridge.

// The `pub use` block below re-exports the state crate's whole surface for
// consumers (commands, MCP, tests, future phases). Many are not yet wired
// in the lib build but are intentionally public.
#![allow(unused_imports)]

pub mod actor;
pub mod animated;
pub mod color;
pub mod composition;
pub mod effect;
pub mod group;
pub mod history;
pub mod ids;
pub mod layer;
pub mod marker;
pub mod media;
pub mod project;
pub mod time;
pub mod track;
pub mod transform;
pub mod transition;
pub mod validate;

pub use actor::{
    Actor, AudioPatch, ChangeEvent, ColorPatch, CommandError, CompositionPatch, DiffHint,
    DryRunOp, DryRunOutput, EntityRef, HistoryStatus, ImageOverlayPatch, LayerParamsPatch,
    LayerPatch, MarkerPatch, MediaDerivativesPatch, ProjectActor, ProjectHandle, TextPatch,
    VideoClipPatch, spawn,
};
pub use history::{HistoryEntry, HistoryEntrySummary, HistoryView, NamedCheckpoint, NamedCheckpointSummary};
pub use validate::{ValidationError, validate as validate_project};

pub use animated::{Animated, Interpolation, Keyframe};
pub use color::{ColorSpace, Rgba};
pub use composition::Composition;
pub use effect::{Effect, EffectKind, EffectParams};
pub use group::{Group, index_groups};
pub use ids::{
    CheckpointId, EffectId, GroupId, KeyframeId, LayerId, MarkerId, MediaId, OpId, TrackId,
    TransitionId, new_id,
};
pub use layer::{
    AudioParams, ColorParams, FontSpec, ImageOverlayParams, Layer, LayerParams, Outline, Shadow,
    SubtitlesParams, SubtitlesSource, TemplateParams, TextAlign, TextAnimPreset, TextBackend,
    TextParams, VideoClipParams,
};
pub use marker::Marker;
pub use media::{AudioStreamMeta, MediaItem, MediaKind, MediaMetadata, VideoStreamMeta};
pub use project::{Project, ProjectMetadata, ProjectSettings, SCHEMA_VERSION};
pub use time::{Rational, TimeUs, US_PER_MS, US_PER_SEC};
pub use track::{Track, TrackKind};
pub use transform::{BlendMode, Rect, Transform};
pub use transition::{Transition, TransitionKind};

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn fixture_project() -> Project {
        // Stable values so the round-trip is deterministic — no `now()` calls.
        let media_id = uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000001").unwrap();
        let track_id = uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000002").unwrap();
        let layer_id = uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000003").unwrap();

        let media = MediaItem {
            id: media_id,
            label: Some("intro.mp4".into()),
            path_abs: "/media/intro.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(10_000_000),
                video: Some(VideoStreamMeta {
                    width: 1920,
                    height: 1080,
                    fps_num: 30,
                    fps_den: 1,
                    codec: "h264".into(),
                    pix_fmt: "yuv420p".into(),
                }),
                audio: Some(AudioStreamMeta {
                    sample_rate: 48_000,
                    channels: 2,
                    codec: "aac".into(),
                }),
            },
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0000000000000000".into(),
            file_size: 12_345_678,
            file_mtime: 1_700_000_000,
            imported_at: chrono::Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
        };

        let layer = Layer {
            id: layer_id,
            label: Some("intro clip".into()),
            t_start_us: 0,
            t_end_us: 5_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::VideoClip(VideoClipParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: 5_000_000,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: BlendMode::Normal,
                speed: 1.0,
                fade_in_us: 0,
                fade_out_us: 0,
            }),
        };

        let track = Track {
            id: track_id,
            kind: TrackKind::Video,
            label: Some("V1".into()),
            enabled: true,
            locked: false,
            removable: true,
            height_px: 64,
            layers: imbl::vector![layer],
        };

        Project {
            schema_version: SCHEMA_VERSION,
            project_id: uuid::Uuid::parse_str("01900000-0000-7000-8000-000000000000").unwrap(),
            metadata: ProjectMetadata {
                name: "Round-trip fixture".into(),
                created_at: chrono::Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
                modified_at: chrono::Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
                description: None,
            },
            composition: Composition::default(),
            media_pool: imbl::HashMap::unit(media_id, media),
            tracks: imbl::vector![track],
            markers: imbl::Vector::new(),
            transitions: imbl::Vector::new(),
            groups: imbl::Vector::new(),
            settings: ProjectSettings::default(),
        }
    }

    #[test]
    fn project_json_round_trip() {
        let original = fixture_project();
        let json = serde_json::to_string_pretty(&original).expect("serialize");
        let parsed: Project = serde_json::from_str(&json).expect("deserialize");
        let again = serde_json::to_string_pretty(&parsed).expect("serialize again");
        assert_eq!(json, again, "round-trip JSON should be byte-identical");
    }

    #[test]
    fn blank_project_round_trips() {
        let p = Project::new_blank("untitled");
        let json = serde_json::to_string(&p).expect("serialize");
        let parsed: Project = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(p.schema_version, parsed.schema_version);
        assert_eq!(p.project_id, parsed.project_id);
    }
}
