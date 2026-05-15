//! Render graph IR: resolve â†’ pre-rasterize â†’ lower â†’ optimize â†’ validate â†’ emit.
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

// The `pub use` re-exports below expose the IR's public surface. Some are
// only consumed by tests / future phases / external callers â€” silence
// unused-import warnings for this re-export module rather than peppering
// individual lines.
#![allow(unused_imports)]

pub mod emit_ffmpeg;
pub mod emit_mpv;
pub mod emit_webcodecs;
pub mod graph;
pub mod lower;
pub mod materialize;
pub mod node;
pub mod segments;
pub mod target;

pub use emit_ffmpeg::{FfmpegPlan, emit as emit_ffmpeg};
pub use emit_mpv::{MpvPlan, emit as emit_mpv};
pub use emit_webcodecs::{
    RECIPE_SCHEMA_VERSION, RecipeCanvas, RecipeClip, RecipeImage, RecipeRaster, RecipeTransform,
    WebcodecsRecipe, emit as emit_webcodecs,
};
pub use graph::IRGraph;
pub use lower::{LowerError, lower, lower_range};
pub use segments::{MAX_SEGMENT_US, SegmentRange, compute_segment_boundaries};
pub use materialize::{
    InlineSubPaths, MaterializeError, TemplateRenderInfo, TemplateRenders,
    materialize_inline_subtitles, materialize_templates,
};
pub use node::{FadeKind, IRNode, InputIdx, NodeId, PixFmt, StreamKind};
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
        ids::new_id,
        layer::{
            AudioParams, ColorParams, FontSpec, ImageOverlayParams, Layer, LayerParams, TextAlign,
            TextBackend, TextParams, VideoClipParams,
        },
        media::{MediaItem, MediaKind, MediaMetadata},
        project::{Project, ProjectMetadata},
        time::Rational,
        track::{Track, TrackKind},
        transform::Transform,
        transition::{Transition, TransitionKind},
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
                fade_in_us: 0,
                fade_out_us: 0,
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
            transitions: imbl::Vector::new(),
            groups: imbl::Vector::new(),
            settings: Default::default(),
        }
    }

    #[test]
    fn empty_project_emits_minimal_color_canvas() {
        let p = Project::new_blank("empty");
        let g = lower(&p, fixture_target(), &Default::default(), &Default::default()).expect("lower");
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
        let g = lower(&p, fixture_target(), &Default::default(), &Default::default()).expect("lower");
        assert_eq!(g.inputs.len(), 1);
        assert_eq!(g.inputs[0].path.to_str().unwrap(), "/m/a.mp4");
        assert_eq!(g.inputs[0].framerate, None);

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
        let g = lower(&p, fixture_target(), &Default::default(), &Default::default()).expect("lower");
        let plan = emit_ffmpeg(&g);

        assert_eq!(plan.inputs.len(), 1);
        assert_eq!(plan.inputs[0].path, "/m/a.mp4");
        assert_eq!(plan.inputs[0].framerate, None);
        assert_eq!(plan.maps, vec!["[vfinal]".to_string()]);

        let expected = "\
color=c=0x000000@1.000000:s=1920x1080:r=30:d=5 [c1];
[0:v] trim=0:5,setpts=PTS-STARTPTS [v2];
[v2] scale=1920:1080 [scale3];
[scale3] fps=30 [fps4];
[fps4] setpts=PTS-STARTPTS [pts5];
[c1][pts5] overlay=x=0:y=0:enable='between(t,0,5)':eof_action=pass [s6];
[s6] format=yuv420p [vfinal]";
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

        let g = lower(&p, fixture_target(), &Default::default(), &Default::default()).expect("lower");
        let plan = emit_ffmpeg(&g);
        assert!(plan.maps.contains(&"[aout]".to_string()));
        // Single audio source: no amix node, OutA wraps the Adelay directly.
        assert!(plan.filter_graph.contains("atrim=0:3"));
        assert!(plan.filter_graph.contains("adelay=1000|1000"));
        assert!(plan.filter_graph.contains("aresample=48000 [aout]"));
        assert!(!plan.filter_graph.contains("amix="));
    }

    #[test]
    fn image_overlay_lowers_to_loop_trim_setpts_overlay() {
        let media_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000b1").unwrap();
        let track_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000b2").unwrap();
        let layer_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000b3").unwrap();

        // Image media has no inherent duration; metadata.duration_us = None.
        let media = MediaItem {
            id: media_id,
            label: None,
            path_abs: "/m/logo.png".into(),
            path_rel: None,
            kind: MediaKind::Image,
            metadata: MediaMetadata {
                duration_us: None,
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
        };

        let mut overlay_transform = Transform::default();
        // Position the overlay 100,200 from origin to confirm it lands in `overlay=`.
        overlay_transform.x = Animated::Static(100.0);
        overlay_transform.y = Animated::Static(200.0);

        let layer = Layer {
            id: layer_id,
            label: None,
            t_start_us: 1_000_000,
            t_end_us: 4_000_000, // 3s on screen
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::ImageOverlay(ImageOverlayParams {
                media: media_id,
                transform: overlay_transform,
                opacity: Animated::Static(1.0),
                blend_mode: Default::default(),
                fade_in_us: 0,
                fade_out_us: 0,
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

        let mut p = Project::new_blank("image-overlay");
        p.composition.duration_us = 4_000_000;
        p.media_pool.insert(media_id, media);
        p.tracks.push_back(track);

        let g = lower(&p, fixture_target(), &Default::default(), &Default::default()).expect("lower");
        assert_eq!(g.inputs.len(), 1);
        assert!(matches!(
            g.nodes.iter().find(|n| matches!(n, IRNode::ImageDecode { .. })),
            Some(IRNode::ImageDecode { duration_us: 3_000_000, .. })
        ));

        let plan = emit_ffmpeg(&g);
        // Looped + trimmed image stream
        assert!(
            plan.filter_graph
                .contains("loop=loop=-1:size=1,trim=duration=3,setpts=PTS-STARTPTS"),
            "graph missing image loop/trim:\n{}",
            plan.filter_graph
        );
        // Placed at t=1 onto the base
        assert!(plan.filter_graph.contains("setpts=PTS-STARTPTS+1/TB"));
        // Overlay at the requested coordinates and gated to the layer span
        assert!(plan.filter_graph.contains("overlay=x=100:y=200"));
        assert!(plan.filter_graph.contains("between(t,1,4)"));
    }

    #[test]
    fn text_layer_emits_drawtext_with_escaping_and_gating() {
        let track_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000d1").unwrap();
        let layer_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000d2").unwrap();

        let mut text_transform = Transform::default();
        text_transform.x = Animated::Static(50.0);
        text_transform.y = Animated::Static(900.0);

        let layer = Layer {
            id: layer_id,
            label: None,
            t_start_us: 2_000_000,
            t_end_us: 5_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Text(TextParams {
                // Includes a colon and apostrophe to exercise drawtext_escape.
                content: "It's: title".to_string(),
                font: FontSpec {
                    family: "Arial".to_string(),
                    size_px: 96.0,
                    weight: 700,
                    italic: false,
                },
                color: Animated::Static(Rgba::WHITE),
                align: TextAlign::Center,
                transform: text_transform,
                opacity: Animated::Static(1.0),
                shadow: None,
                outline: None,
                intro: None,
                outro: None,
                backend_hint: TextBackend::DrawText,
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

        let mut p = Project::new_blank("text-only");
        p.composition.duration_us = 5_000_000;
        p.tracks.push_back(track);

        let g = lower(&p, fixture_target(), &Default::default(), &Default::default()).expect("lower");
        // No external inputs for a text-only project.
        assert!(g.inputs.is_empty());
        // Should contain a DrawText node.
        assert!(g.nodes.iter().any(|n| matches!(n, IRNode::DrawText { .. })));

        let plan = emit_ffmpeg(&g);
        // Apostrophe escaped via close-escape-reopen ('\''); colon stays literal
        // inside single quotes.
        assert!(
            plan.filter_graph.contains("text='It'\\''s: title'"),
            "graph missing canonically-escaped text:\n{}",
            plan.filter_graph
        );
        // Format-string expansion suppressed so `%{pts}` etc render literally.
        assert!(plan.filter_graph.contains("expansion=none"));
        // Font resolution differs by host OS â€” Windows ships ffmpeg builds
        // without a fontconfig default, so we emit `fontfile=` instead of
        // `font=`. See `drawtext_font_option`.
        #[cfg(target_os = "windows")]
        assert!(
            plan.filter_graph
                .contains("fontfile='C\\:/Windows/Fonts/arial.ttf'"),
            "graph missing Windows fontfile path (with escaped colon):\n{}",
            plan.filter_graph
        );
        #[cfg(not(target_os = "windows"))]
        assert!(plan.filter_graph.contains("font='Arial'"));
        assert!(plan.filter_graph.contains("fontsize=96"));
        assert!(plan.filter_graph.contains("x=50:y=900"));
        assert!(plan.filter_graph.contains("between(t,2,5)"));
    }

    /// Run a graph through ffmpeg, check exit status and produced bytes.
    /// Skips when ffmpeg isn't on PATH. Returns `None` if skipped, `Some(ok)`
    /// if it ran. Used by the sanity tests below.
    fn run_graph_through_ffmpeg(
        graph: &str,
        inputs: &[&str],
        map: &str,
        out_format: &str,
        codec: &[&str],
    ) -> Option<(bool, std::path::PathBuf, String)> {
        use std::process::{Command, Stdio};
        let probe = Command::new("ffmpeg").arg("-version").output().ok()?;
        if !probe.status.success() {
            return None;
        }
        let id = uuid::Uuid::now_v7().simple();
        let script = std::env::temp_dir().join(format!("weftcut-test-graph-{id}.txt"));
        let out = std::env::temp_dir().join(format!("weftcut-test-out-{id}.{out_format}"));
        std::fs::write(&script, graph).expect("write script");

        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"]);
        for input in inputs {
            cmd.arg("-i").arg(input);
        }
        cmd.arg("-filter_complex_script").arg(&script);
        cmd.arg("-map").arg(map);
        for arg in codec {
            cmd.arg(arg);
        }
        cmd.arg(&out);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let result = cmd.output().expect("run ffmpeg");
        let _ = std::fs::remove_file(&script);
        let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
        Some((result.status.success(), out, stderr))
    }

    /// Smoke test: feed the empty-project graph to ffmpeg via stdin and confirm
    /// the parser accepts it. Skipped unless ffmpeg is on PATH; protects against
    /// regressions like the missing `;` separator that broke export silently
    /// for Phase 1 because the existing tests only checked string contents.
    #[test]
    fn empty_project_graph_parses_through_ffmpeg() {
        use std::process::{Command, Stdio};
        let Ok(probe) = Command::new("ffmpeg").arg("-version").output() else {
            eprintln!("ffmpeg not on PATH â€” skipping graph-parse smoke test");
            return;
        };
        if !probe.status.success() {
            eprintln!("ffmpeg returned non-zero â€” skipping");
            return;
        }
        let p = Project::new_blank("empty");
        let g = lower(&p, fixture_target(), &Default::default(), &Default::default()).expect("lower");
        let plan = emit_ffmpeg(&g);

        // -filter_complex_script reads from stdin when given `-`. Map the only
        // output, write to /dev/null (`-f null -`) so we don't produce a file.
        let script_path = std::env::temp_dir()
            .join(format!("weftcut-test-graph-{}.txt", uuid::Uuid::now_v7().simple()));
        std::fs::write(&script_path, &plan.filter_graph).expect("write script");

        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"])
            .arg("-filter_complex_script")
            .arg(&script_path);
        for m in &plan.maps {
            cmd.arg("-map").arg(m);
        }
        cmd.args(["-t", "0.1", "-f", "null", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let out = cmd.output().expect("run ffmpeg");
        let _ = std::fs::remove_file(&script_path);
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            panic!(
                "ffmpeg rejected emit_ffmpeg graph (this would have broken export):\n--- graph ---\n{}\n--- stderr ---\n{}",
                plan.filter_graph, stderr
            );
        }
    }

    /// End-to-end sanity: a project with Color base + Text layer compiles to
    /// a graph that ffmpeg actually renders to a non-empty mp4. This is the
    /// Phase 3 exit-criteria test ("output plays correctly") at the
    /// generated-bytes level â€” proving the file is parseable + readable
    /// downstream is the user-visible spec, but a zero-size file is the
    /// fastest discriminator and catches the "filter graph silently
    /// produced no output" class of bug.
    #[test]
    fn text_only_project_renders_to_nonempty_mp4_through_ffmpeg() {
        let track_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000e1").unwrap();
        let layer_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000e2").unwrap();
        let mut text_transform = Transform::default();
        text_transform.x = Animated::Static(40.0);
        text_transform.y = Animated::Static(40.0);
        let layer = Layer {
            id: layer_id,
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Text(TextParams {
                content: "HELLO".to_string(),
                font: FontSpec {
                    family: "Arial".to_string(),
                    size_px: 64.0,
                    weight: 700,
                    italic: false,
                },
                color: Animated::Static(Rgba::WHITE),
                align: TextAlign::Center,
                transform: text_transform,
                opacity: Animated::Static(1.0),
                shadow: None,
                outline: None,
                intro: None,
                outro: None,
                backend_hint: TextBackend::DrawText,
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
        let mut p = Project::new_blank("text-render");
        p.composition.duration_us = 1_000_000;
        p.tracks.push_back(track);
        let g = lower(&p, fixture_target(), &Default::default(), &Default::default()).expect("lower");
        let plan = emit_ffmpeg(&g);

        let Some((ok, out, stderr)) = run_graph_through_ffmpeg(
            &plan.filter_graph,
            &[],
            "[vfinal]",
            "mp4",
            &[
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-t",
                "1",
            ],
        ) else {
            eprintln!("ffmpeg not on PATH â€” skipping render test");
            return;
        };
        assert!(ok, "ffmpeg failed:\n--- graph ---\n{}\n--- stderr ---\n{}", plan.filter_graph, stderr);
        let meta = std::fs::metadata(&out).expect("read output mp4 metadata");
        let size = meta.len();
        let _ = std::fs::remove_file(&out);
        assert!(
            size > 1024,
            "output mp4 is suspiciously small ({size} bytes), graph likely produced no frames\n--- graph ---\n{}",
            plan.filter_graph
        );
    }

    /// Subtitle path-escape sanity: write a tiny SRT to disk, build a project
    /// that points to it, and verify ffmpeg renders without erroring. The
    /// most likely failure mode is a path containing a Windows drive letter
    /// (`C:`) tripping the lavfi parser; if `subtitles_path_escape` ever
    /// regresses, this catches it before users do.
    #[test]
    fn subtitles_layer_renders_through_ffmpeg() {
        let id = uuid::Uuid::now_v7().simple();
        let srt_path = std::env::temp_dir().join(format!("weftcut-test-subs-{id}.srt"));
        std::fs::write(
            &srt_path,
            "1\n00:00:00,000 --> 00:00:01,000\nhello\n\n",
        )
        .expect("write srt");
        let media_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000f1").unwrap();
        let track_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000f2").unwrap();
        let layer_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000f3").unwrap();
        let media = MediaItem {
            id: media_id,
            label: None,
            path_abs: srt_path.clone(),
            path_rel: None,
            kind: MediaKind::Subtitle,
            metadata: MediaMetadata {
                duration_us: None,
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
        };
        let layer = Layer {
            id: layer_id,
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Subtitles(crate::state::SubtitlesParams {
                source: crate::state::SubtitlesSource::Media(media_id),
            }),
        };
        let track = Track {
            id: track_id,
            kind: TrackKind::Subtitle,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 32,
            layers: imbl::vector![layer],
        };
        let mut p = Project::new_blank("subs-render");
        p.composition.duration_us = 1_000_000;
        p.media_pool.insert(media_id, media);
        p.tracks.push_back(track);

        let g = match lower(&p, fixture_target(), &Default::default(), &Default::default()) {
            Ok(g) => g,
            Err(e) => {
                let _ = std::fs::remove_file(&srt_path);
                panic!("lower failed: {e}");
            }
        };
        let plan = emit_ffmpeg(&g);
        let Some((ok, out, stderr)) = run_graph_through_ffmpeg(
            &plan.filter_graph,
            &[],
            "[vfinal]",
            "mp4",
            &[
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-t",
                "1",
            ],
        ) else {
            let _ = std::fs::remove_file(&srt_path);
            eprintln!("ffmpeg not on PATH â€” skipping subtitle render test");
            return;
        };
        let _ = std::fs::remove_file(&srt_path);
        if !ok {
            let _ = std::fs::remove_file(&out);
            panic!(
                "ffmpeg rejected subtitles graph:\n--- graph ---\n{}\n--- stderr ---\n{}",
                plan.filter_graph, stderr
            );
        }
        let meta = std::fs::metadata(&out).expect("read output mp4 metadata");
        let size = meta.len();
        let _ = std::fs::remove_file(&out);
        assert!(
            size > 1024,
            "subs output mp4 is suspiciously small ({size} bytes)\n--- graph ---\n{}",
            plan.filter_graph
        );
    }

    /// Inline-source subtitles travel through `materialize_inline_subtitles`
    /// before `lower` â€” the materialization writes a content-addressed file
    /// to the cache and `lower` reads the path from the side map. End-to-end
    /// through actual ffmpeg ensures the grammar at the seam holds, not just
    /// that string substitution doesn't crash.
    #[test]
    fn inline_subtitles_materialize_and_render_through_ffmpeg() {
        use crate::cache::CacheLayout;
        use tempfile::TempDir;

        let cache_root = TempDir::new().unwrap();
        let cache = CacheLayout::new(cache_root.path().to_path_buf());
        cache.ensure_dirs().unwrap();

        let track_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000a1").unwrap();
        let layer_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000a2").unwrap();
        let body = "1\n00:00:00,000 --> 00:00:01,000\nhello inline\n\n";
        let layer = Layer {
            id: layer_id,
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Subtitles(crate::state::SubtitlesParams {
                source: crate::state::SubtitlesSource::InlineSrt(body.to_string()),
            }),
        };
        let track = Track {
            id: track_id,
            kind: TrackKind::Subtitle,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 32,
            layers: imbl::vector![layer],
        };
        let mut p = Project::new_blank("inline-subs");
        p.composition.duration_us = 1_000_000;
        p.tracks.push_back(track);

        let inline_subs = materialize_inline_subtitles(&p, &cache).expect("materialize");
        assert_eq!(inline_subs.len(), 1);
        let g = lower(&p, fixture_target(), &inline_subs, &Default::default()).expect("lower");
        let plan = emit_ffmpeg(&g);

        let Some((ok, out, stderr)) = run_graph_through_ffmpeg(
            &plan.filter_graph,
            &[],
            "[vfinal]",
            "mp4",
            &[
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-t",
                "1",
            ],
        ) else {
            eprintln!("ffmpeg not on PATH â€” skipping inline-subs render test");
            return;
        };
        if !ok {
            let _ = std::fs::remove_file(&out);
            panic!(
                "ffmpeg rejected inline-subs graph:\n--- graph ---\n{}\n--- stderr ---\n{}",
                plan.filter_graph, stderr
            );
        }
        let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&out);
        assert!(
            size > 1024,
            "inline-subs output mp4 is suspiciously small ({size} bytes)\n--- graph ---\n{}",
            plan.filter_graph
        );
    }

    /// End-to-end smoke for crossfade transitions: two overlapping Color
    /// layers with an authorized Transition lower to a graph that ffmpeg
    /// renders into a non-empty mp4. Catches regressions in the alpha-fade
    /// + Format(yuva420p) emission seams which string-only tests miss
    /// (the `;` separator bug from Phase 1 â†’ Phase 2 lived in exactly this
    /// gap).
    ///
    /// What this test does NOT verify: the visual blend math. ffmpeg's
    /// `overlay` filter with a yuva420p top and yuv420p base should produce
    /// `out = top*alpha + base*(1-alpha)` â€” verifying that requires frame
    /// extraction + pixel sampling, which we don't do here. A future ffmpeg
    /// version changing overlay semantics would silently pass this test
    /// while breaking visual output.
    #[test]
    fn crossfade_transition_renders_through_ffmpeg() {
        let track_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000d1").unwrap();
        let a_id = new_id();
        let b_id = new_id();

        let a = Layer {
            id: a_id,
            label: None,
            t_start_us: 0,
            t_end_us: 3_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Color(ColorParams {
                color: Animated::Static(Rgba::WHITE),
                width: 1920,
                height: 1080,
            }),
        };
        let b = Layer {
            id: b_id,
            label: None,
            t_start_us: 2_000_000, // overlap by 1s with a's tail
            t_end_us: 5_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Color(ColorParams {
                color: Animated::Static(Rgba::BLACK),
                width: 1920,
                height: 1080,
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
            layers: imbl::vector![a, b],
        };
        let mut p = Project::new_blank("crossfade");
        p.composition.duration_us = 5_000_000;
        p.tracks.clear();
        p.tracks.push_back(track);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a_id,
            to_layer: b_id,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });

        // Validate first so the test fails loudly if the validation rule
        // ever drifts away from "authorized overlap with matching duration".
        crate::state::validate::validate(&p).expect("validation");

        let g = lower(&p, fixture_target(), &Default::default(), &Default::default()).expect("lower");
        let plan = emit_ffmpeg(&g);

        // The emitted graph MUST contain the alpha-fade clause and a
        // format=yuva420p conversion before it. Asserting these strings
        // is the cheap unit-test layer; ffmpeg invocation below is the
        // real load-bearing check.
        assert!(
            plan.filter_graph.contains("alpha=1"),
            "expected `alpha=1` in graph:\n{}",
            plan.filter_graph,
        );
        assert!(
            plan.filter_graph.contains("format=yuva420p"),
            "expected `format=yuva420p` before alpha fade:\n{}",
            plan.filter_graph,
        );

        let Some((ok, out, stderr)) = run_graph_through_ffmpeg(
            &plan.filter_graph,
            &[],
            "[vfinal]",
            "mp4",
            &[
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-t",
                "5",
            ],
        ) else {
            eprintln!("ffmpeg not on PATH â€” skipping crossfade render test");
            return;
        };
        if !ok {
            let _ = std::fs::remove_file(&out);
            panic!(
                "ffmpeg rejected crossfade graph:\n--- graph ---\n{}\n--- stderr ---\n{}",
                plan.filter_graph, stderr
            );
        }
        let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&out);
        assert!(
            size > 1024,
            "crossfade output mp4 is suspiciously small ({size} bytes)\n--- graph ---\n{}",
            plan.filter_graph,
        );
    }

    /// Stage E2 smoke: a Project with a Template layer + a hand-built
    /// `TemplateRenders` map (pointing at a fixture PNG sequence so the
    /// test doesn't depend on a webview) flows through
    /// `lower → emit_ffmpeg → ffmpeg` into a non-empty mp4. Catches
    /// regressions across the full Template → PngSeq → Overlay seam
    /// without needing an offscreen webview in CI.
    #[test]
    fn template_layer_renders_through_ffmpeg() {
        use crate::ir::materialize::{TemplateRenderInfo, TemplateRenders};
        use crate::state::layer::TemplateParams;
        use crate::state::transform::Transform;
        use std::process::Command;
        use tempfile::TempDir;

        let Ok(probe) = Command::new("ffmpeg").arg("-version").output() else {
            eprintln!("ffmpeg not on PATH — skipping template smoke");
            return;
        };
        if !probe.status.success() {
            eprintln!("ffmpeg returned non-zero — skipping template smoke");
            return;
        }

        // Fixture: three transparent-magenta PNG frames, mimicking what
        // `raster::render` would have written for a 0.3s @ 10 fps render.
        let dir = TempDir::new().unwrap();
        let pattern = dir.path().join("frame_%05d.png");
        let gen = Command::new("ffmpeg")
            .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi"])
            .arg("-i")
            .arg("color=c=0x00000000:s=320x180:d=0.3:r=10")
            .args(["-vf", "drawbox=x=80:y=40:w=160:h=100:color=0xff44aa@0.85:t=fill"])
            .args(["-frames:v", "3"])
            .arg(&pattern)
            .output()
            .expect("generate fixture PNGs");
        assert!(gen.status.success(), "fixture: {}", String::from_utf8_lossy(&gen.stderr));

        // Build a Project with a single Template layer.
        let track_id = Uuid::parse_str("01900000-0000-7000-8000-000000000fe1").unwrap();
        let layer_id = Uuid::parse_str("01900000-0000-7000-8000-000000000fe2").unwrap();
        let template = TemplateParams {
            template_id: "lower-third-simple".into(),
            template_version: 1,
            props: imbl::HashMap::new(),
            transform: Transform::default(),
            opacity: Animated::Static(1.0),
        };
        let layer = Layer {
            id: layer_id,
            label: None,
            t_start_us: 0,
            t_end_us: 300_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Template(template),
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
        let mut p = Project::new_blank("template-smoke");
        p.composition.duration_us = 300_000;
        p.tracks.clear();
        p.tracks.push_back(track);

        // Hand-build the TemplateRenders the way `materialize_templates`
        // would after a real webview render — skip the async webview hop.
        let mut renders = TemplateRenders::new();
        renders.insert(
            layer_id,
            TemplateRenderInfo {
                pattern_path: pattern.clone(),
                frame_count: 3,
                fps_num: 10,
                fps_den: 1,
                duration_us: 300_000,
                width: 800,
                height: 200,
            },
        );

        let g = lower(&p, fixture_target(), &Default::default(), &renders).expect("lower");
        let plan = emit_ffmpeg(&g);

        // Sanity: the input must carry the framerate flag; the graph must
        // include format=yuva420p (template alpha) AND an overlay that
        // composites onto the Color base.
        assert_eq!(plan.inputs.len(), 1, "one PngSeq input");
        assert_eq!(plan.inputs[0].framerate, Some((10, 1)));
        assert!(
            plan.filter_graph.contains("format=yuva420p"),
            "expected format=yuva420p in template graph:\n{}",
            plan.filter_graph,
        );
        assert!(
            plan.filter_graph.contains("overlay="),
            "expected overlay= in template graph:\n{}",
            plan.filter_graph,
        );

        let script = std::env::temp_dir()
            .join(format!("weftcut-tmpl-graph-{}.txt", Uuid::now_v7().simple()));
        let out_path = std::env::temp_dir()
            .join(format!("weftcut-tmpl-out-{}.mp4", Uuid::now_v7().simple()));
        std::fs::write(&script, &plan.filter_graph).expect("write script");

        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"]);
        for input in &plan.inputs {
            for arg in input.cli_args() {
                cmd.arg(arg);
            }
        }
        cmd.arg("-filter_complex_script").arg(&script);
        for m in &plan.maps {
            cmd.arg("-map").arg(m);
        }
        cmd.args([
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", "0.3",
        ])
        .arg(&out_path);

        let out = cmd.output().expect("run ffmpeg");
        let _ = std::fs::remove_file(&script);
        if !out.status.success() {
            let _ = std::fs::remove_file(&out_path);
            panic!(
                "ffmpeg rejected template graph:\n--- graph ---\n{}\n--- stderr ---\n{}",
                plan.filter_graph,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let size = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&out_path);
        assert!(
            size > 512,
            "template mp4 suspiciously small ({size} bytes)\n--- graph ---\n{}",
            plan.filter_graph,
        );
    }

    /// Stage E1 smoke: a hand-built IR with a `PngSeq` overlay on top of a
    /// `Color` base renders through ffmpeg into a non-empty mp4, and the
    /// alpha=true branch emits the `format=yuva420p` conversion the overlay
    /// needs to composite per-frame alpha correctly.
    #[test]
    fn pngseq_overlay_renders_through_ffmpeg() {
        use crate::ir::node::{IRNode, PixFmt};
        use crate::state::color::Rgba;
        use std::process::Command;
        use tempfile::TempDir;

        let Ok(probe) = Command::new("ffmpeg").arg("-version").output() else {
            eprintln!("ffmpeg not on PATH â€” skipping pngseq smoke");
            return;
        };
        if !probe.status.success() {
            eprintln!("ffmpeg returned non-zero â€” skipping pngseq smoke");
            return;
        }

        // Fixture: three RGBA PNG frames with a magenta-on-transparent dot.
        // `color=color=...@0.0` gives a transparent base, then drawbox lays
        // down a translucent square so there's actually a non-zero alpha
        // region to composite. We feed PNGs (not a video) to mirror what
        // `raster::render` writes to the cache.
        let dir = TempDir::new().unwrap();
        let pattern = dir.path().join("frame_%05d.png");
        let gen = Command::new("ffmpeg")
            .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi"])
            .arg("-i")
            .arg("color=c=0x00000000:s=320x180:d=0.3:r=10")
            .args(["-vf", "drawbox=x=80:y=40:w=160:h=100:color=0xff44aa@0.85:t=fill"])
            .args(["-frames:v", "3"])
            .arg(&pattern)
            .output()
            .expect("generate fixture PNGs");
        assert!(
            gen.status.success(),
            "fixture generation failed: {}",
            String::from_utf8_lossy(&gen.stderr)
        );

        // Hand-build the IR: Color base â†’ PngSeq (alpha) â†’ Scale â†’ SetPts â†’
        // Overlay â†’ OutV(yuv420p).
        let target = RenderTarget::full(320, 180, Rational::new(30, 1), 48000, 2);
        let mut g = IRGraph::new(target);

        let base = g.add_node(IRNode::Color {
            rgba: Rgba::rgb(20, 22, 30),
            width: 320,
            height: 180,
            fps_num: 30,
            fps_den: 1,
            duration_us: 1_000_000,
        });

        let pngseq_input = g.add_png_seq(&pattern, 10, 1);
        let pngseq = g.add_node(IRNode::PngSeq {
            input: pngseq_input,
            duration_us: 300_000,
            alpha: true,
        });
        let scaled = g.add_node(IRNode::Scale {
            in_: pngseq,
            width: 320,
            height: 180,
        });
        let placed = g.add_node(IRNode::SetPts {
            in_: scaled,
            offset_us: 0,
        });
        let composited = g.add_node(IRNode::Overlay {
            base,
            top: placed,
            x: 0,
            y: 0,
            gate_start_us: 0,
            gate_end_us: 300_000,
        });
        let out_v = g.add_node(IRNode::OutV {
            in_: composited,
            label: "vfinal".into(),
            pix_fmt: PixFmt::Yuv420p,
        });
        g.video_out = Some(out_v);

        let plan = emit_ffmpeg(&g);

        // The emit shape must include the alpha-preservation `format=yuva420p`
        // step. Without it, ffmpeg drops alpha at the trim node and the
        // overlay paints opaque magenta over the base.
        assert!(
            plan.filter_graph.contains("format=yuva420p"),
            "expected format=yuva420p in pngseq alpha graph:\n{}",
            plan.filter_graph
        );

        // Input must carry `-framerate 10/1` per InputSpec.
        assert_eq!(plan.inputs.len(), 1);
        assert_eq!(plan.inputs[0].framerate, Some((10, 1)));

        // Run end-to-end and assert non-empty mp4.
        let script = std::env::temp_dir()
            .join(format!("weftcut-pngseq-graph-{}.txt", Uuid::now_v7().simple()));
        let out_path = std::env::temp_dir()
            .join(format!("weftcut-pngseq-out-{}.mp4", Uuid::now_v7().simple()));
        std::fs::write(&script, &plan.filter_graph).expect("write script");

        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"]);
        for input in &plan.inputs {
            for arg in input.cli_args() {
                cmd.arg(arg);
            }
        }
        cmd.arg("-filter_complex_script").arg(&script);
        for m in &plan.maps {
            cmd.arg("-map").arg(m);
        }
        cmd.args([
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", "0.3",
        ])
        .arg(&out_path);

        let out = cmd.output().expect("run ffmpeg");
        let _ = std::fs::remove_file(&script);
        if !out.status.success() {
            let _ = std::fs::remove_file(&out_path);
            panic!(
                "ffmpeg rejected pngseq graph:\n--- graph ---\n{}\n--- stderr ---\n{}",
                plan.filter_graph,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let size = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&out_path);
        assert!(
            size > 512,
            "pngseq mp4 is suspiciously small ({size} bytes)\n--- graph ---\n{}",
            plan.filter_graph,
        );
    }

    #[test]
    fn image_overlay_emits_vid_label_for_mpv() {
        let media_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000c1").unwrap();
        let track_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000c2").unwrap();
        let layer_id = Uuid::parse_str("01900000-0000-7000-8000-0000000000c3").unwrap();

        let media = MediaItem {
            id: media_id,
            label: None,
            path_abs: "/m/logo.png".into(),
            path_rel: None,
            kind: MediaKind::Image,
            metadata: MediaMetadata {
                duration_us: None,
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
        };

        let layer = Layer {
            id: layer_id,
            label: None,
            t_start_us: 0,
            t_end_us: 2_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::ImageOverlay(ImageOverlayParams {
                media: media_id,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                blend_mode: Default::default(),
                fade_in_us: 0,
                fade_out_us: 0,
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

        let mut p = Project::new_blank("image-mpv");
        p.composition.duration_us = 2_000_000;
        p.media_pool.insert(media_id, media);
        p.tracks.push_back(track);

        let g = lower(&p, fixture_target(), &Default::default(), &Default::default()).expect("lower");
        let plan = emit_mpv(&g);
        assert_eq!(plan.primary.as_deref(), Some("/m/logo.png"));
        assert!(plan.lavfi_complex.contains("[vid1] loop=loop=-1:size=1"));
        assert!(plan.lavfi_complex.trim_end().ends_with("[vo]"));
    }
}
