//! Render graph IR. Audio-only post P12-b — the visual half (lavfi
//! compositor, materialize, raster) was deleted with the Pixi-renderer
//! migration. The audio chain survives because Pixi exports route through
//! Rust for an audio-only m4a that gets stream-copy-muxed with the
//! WebCodecs-produced video.mp4.
//!
//! Pipeline: `lower → emit_ffmpeg`.

#![allow(unused_imports)]

pub mod emit_ffmpeg;
pub mod graph;
pub mod lower;
pub mod node;
pub mod target;

pub use emit_ffmpeg::{FfmpegPlan, emit as emit_ffmpeg};
pub use graph::IRGraph;
pub use lower::{LowerError, lower};
pub use node::{IRNode, InputIdx, NodeId, StreamKind};
pub use target::{Quality, RenderTarget};

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;
    use crate::state::{
        animated::Animated,
        composition::Composition,
        layer::{AudioParams, Layer, LayerParams},
        media::{MediaItem, MediaKind, MediaMetadata},
        project::Project,
        time::Rational,
        track::Track,
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

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
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
            t_start_us: 1_000_000,
            t_end_us: 4_000_000,
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
            }),
        };
        let track = Track {
            id: track_id,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            role: None,
            transient: false,
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
