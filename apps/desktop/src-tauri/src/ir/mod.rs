//! Render graph IR: resolve → pre-rasterize → lower → optimize → validate → emit.
//!
//! One IR, two emit targets: ffmpeg `-filter_complex_script` for export and
//! libmpv `--lavfi-complex` for live preview. Identical pixels at different scales.
//!
//! Phase 1.10 MVP scope: `Color`, `VideoClip`, `AudioParams`, `Overlay` chain,
//! `Amix`, ffmpeg emitter. Image/Text/Template/Subtitles, optimization passes,
//! libmpv emitter, hwaccel rewrite, and per-frame `Animated<T>` evaluation are
//! follow-ons.
//!
//! Design: `docs/rendering.md` part 1.

pub mod emit_ffmpeg;
pub mod emit_mpv;
pub mod graph;
pub mod lower;
pub mod node;
pub mod target;

pub use emit_ffmpeg::{FfmpegPlan, emit as emit_ffmpeg};
pub use emit_mpv::{MpvPlan, emit as emit_mpv};
pub use graph::IRGraph;
pub use lower::{LowerError, lower};
pub use node::{IRNode, InputIdx, NodeId, PixFmt, StreamKind};
pub use target::{Quality, RenderTarget};

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;
    use crate::state::{
        animated::Animated,
        color::Rgba,
        composition::Composition,
        layer::{AudioParams, ColorParams, Layer, LayerParams, VideoClipParams},
        media::{MediaItem, MediaKind, MediaMetadata},
        project::{Project, ProjectMetadata},
        time::Rational,
        track::{Track, TrackKind},
        transform::Transform,
    };

    fn fixture_target() -> RenderTarget {
        RenderTarget::full(1920, 1080, Rational::FPS_30, 48_000, 2)
    }

    fn fixture_media(id: Uuid, path: &str, kind: MediaKind, duration_us: i64) -> MediaItem {
        MediaItem {
            id,
            label: None,
            path_abs: path.into(),
            path_rel: None,
            kind,
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

    fn project_with_one_clip() -> Project {
        let media_id = Uuid::parse_str("01900000-0000-7000-8000-000000000001").unwrap();
        let track_id = Uuid::parse_str("01900000-0000-7000-8000-000000000002").unwrap();
        let layer_id = Uuid::parse_str("01900000-0000-7000-8000-000000000003").unwrap();

        let media = fixture_media(media_id, "/m/a.mp4", MediaKind::Video, 10_000_000);

        let layer = Layer {
            id: layer_id,
            label: None,
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
                blend_mode: Default::default(),
                speed: 1.0,
            }),
        };

        let track = Track {
            id: track_id,
            kind: TrackKind::Video,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 64,
            layers: imbl::vector![layer],
        };

        Project {
            schema_version: 1,
            project_id: Uuid::parse_str("01900000-0000-7000-8000-000000000000").unwrap(),
            metadata: ProjectMetadata {
                name: "ir-mvp".into(),
                created_at: Utc::now(),
                modified_at: Utc::now(),
                description: None,
            },
            composition: Composition {
                width: 1920,
                height: 1080,
                fps: Rational::FPS_30,
                duration_us: 5_000_000,
                sample_rate: 48_000,
                channels: 2,
                color_space: Default::default(),
                background: Rgba::BLACK,
            },
            media_pool: imbl::HashMap::unit(media_id, media),
            tracks: imbl::vector![track],
            markers: imbl::Vector::new(),
            settings: Default::default(),
        }
    }

    #[test]
    fn empty_project_emits_minimal_color_canvas() {
        let p = Project::new_blank("empty");
        let g = lower(&p, fixture_target()).expect("lower");
        // Color base + OutV. No audio.
        assert_eq!(g.inputs.len(), 0);
        assert!(g.video_out.is_some());
        assert!(g.audio_out.is_none());

        let plan = emit_ffmpeg(&g);
        assert!(plan.inputs.is_empty());
        assert!(plan.filter_graph.contains("color=c="));
        assert!(plan.filter_graph.contains("[vfinal]"));
        assert_eq!(plan.maps, vec!["[vfinal]"]);
    }

    #[test]
    fn one_video_clip_lowers_to_decode_scale_fps_setpts_overlay() {
        let p = project_with_one_clip();
        let g = lower(&p, fixture_target()).expect("lower");
        assert_eq!(g.inputs.len(), 1);
        assert_eq!(g.inputs[0].to_str().unwrap(), "/m/a.mp4");

        // Should contain: Color base, DecodeV, Scale, Fps, SetPts, Overlay, OutV.
        let kinds: Vec<&str> = g
            .nodes
            .iter()
            .map(|n| match n {
                IRNode::Color { .. } => "Color",
                IRNode::DecodeV { .. } => "DecodeV",
                IRNode::Scale { .. } => "Scale",
                IRNode::Fps { .. } => "Fps",
                IRNode::SetPts { .. } => "SetPts",
                IRNode::Overlay { .. } => "Overlay",
                IRNode::OutV { .. } => "OutV",
                _ => "other",
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "Color", "DecodeV", "Scale", "Fps", "SetPts", "Overlay", "OutV"
            ]
        );
    }

    #[test]
    fn ffmpeg_emit_matches_expected_clip_pipeline() {
        let p = project_with_one_clip();
        let g = lower(&p, fixture_target()).expect("lower");
        let plan = emit_ffmpeg(&g);

        assert_eq!(plan.inputs, vec!["/m/a.mp4".to_string()]);
        assert_eq!(plan.maps, vec!["[vfinal]".to_string()]);

        let expected = "\
color=c=0x000000@1.000000:s=1920x1080:r=30:d=5 [c1]
[0:v] trim=0:5,setpts=PTS-STARTPTS [v2]
[v2] scale=1920:1080 [scale3]
[scale3] fps=30 [fps4]
[fps4] setpts=PTS-STARTPTS [pts5]
[c1][pts5] overlay=x=0:y=0:enable='between(t,0,5)':eof_action=pass [s6]
[s6] format=yuv420p [vfinal]
";
        assert_eq!(plan.filter_graph, expected);
    }

    #[test]
    fn audio_layer_emits_amix_with_one_input() {
        let media_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000aa").unwrap();
        let track_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000ab").unwrap();
        let layer_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000ac").unwrap();
        let media = fixture_media(media_id, "/m/voice.wav", MediaKind::Audio, 4_000_000);

        let layer = Layer {
            id: layer_id,
            label: None,
            t_start_us: 1_000_000, // 1s offset
            t_end_us: 4_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Audio(AudioParams {
                media: media_id,
                src_in_us: 0,
                src_out_us: 3_000_000,
                gain_db: Animated::Static(0.0),
                pan: Animated::Static(0.0),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
            }),
        };
        let track = Track {
            id: track_id,
            kind: TrackKind::Audio,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 48,
            layers: imbl::vector![layer],
        };

        let mut p = Project::new_blank("audio-only");
        p.composition.duration_us = 4_000_000;
        p.media_pool.insert(media_id, media);
        p.tracks.push_back(track);

        let g = lower(&p, fixture_target()).expect("lower");
        let plan = emit_ffmpeg(&g);
        assert!(plan.maps.contains(&"[aout]".to_string()));
        // Single audio source: no amix node, OutA wraps the Adelay directly.
        assert!(plan.filter_graph.contains("atrim=0:3"));
        assert!(plan.filter_graph.contains("adelay=1000|1000"));
        assert!(plan.filter_graph.contains("aresample=48000 [aout]"));
        assert!(!plan.filter_graph.contains("amix="));
    }
}
