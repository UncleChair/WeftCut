//! Export audio mixer — MixPlan construction from the project and the
//! block-pull summing loop. Replaces the lavfi audio IR (ADR 0019).
//!
//! Time discipline: everything converts to the 48 kHz frame domain ONCE via
//! `us_to_frame`, then all placement/trim math is integer frames — the audio
//! analog of the video `frameGrid` rule.

use std::path::PathBuf;

use anyhow::Result;

use crate::audio::conform_reader::ConformReader;
use crate::audio::envelope::{Envelope, pan_frame, sample_gain, sample_pan};
use crate::state::Project;
use crate::state::layer::LayerParams;

pub const MIX_SAMPLE_RATE: i64 = 48_000;
pub const MIX_BLOCK_FRAMES: usize = 65_536;

/// µs → 48 kHz frame index, round-half-up. 48 000 frames / 1 000 000 µs
/// reduces to 48/1000, so this is exact on the grid.
pub fn us_to_frame(us: i64) -> i64 {
    (us * 48 + 500).div_euclid(1000)
}

#[derive(Debug)]
pub struct MixLayer {
    pub label: String,
    pub conform_path: PathBuf,
    /// Layer start on the composition frame grid.
    pub start_frame: i64,
    /// Source in/out on the conform frame grid.
    pub src_in_frame: i64,
    pub src_out_frame: i64,
    /// Linear gain (gain_db × fades), layer-local time domain.
    pub gain: Envelope,
    pub pan: Envelope,
}

impl MixLayer {
    pub fn end_frame(&self) -> i64 {
        self.start_frame + (self.src_out_frame - self.src_in_frame)
    }
}

#[derive(Debug)]
pub struct MixPlan {
    /// Export window on the composition frame grid (half-open).
    pub window_start_frame: i64,
    pub window_end_frame: i64,
    pub layers: Vec<MixLayer>,
}

#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error(
        "audio layer on media \"{0}\" has no conform cache yet — wait for the conform job or run ensure_conform"
    )]
    ConformMissing(String),
    #[error("layer references missing media {0}")]
    MissingMedia(String),
}

/// Walk every enabled, non-muted, non-locked Audio layer — applying
/// track-level gates (mute and solo) before layer-level gates — and
/// resolve envelopes. When any enabled track is soloed, only soloed
/// tracks contribute to the plan; mute wins over solo.
pub fn plan_for_project(
    project: &Project,
    window_us: Option<(i64, i64)>,
) -> Result<MixPlan, PlanError> {
    let (w_start_us, w_end_us) = window_us.unwrap_or((0, project.composition.duration_us));
    let mut layers = Vec::new();
    // Track-level solo set (timeline redesign spec §3): when any ENABLED
    // track is soloed, only soloed tracks are audible. Disabled tracks'
    // solo flags don't gate the mix.
    let any_solo = project.tracks.iter().any(|t| t.enabled && t.solo);
    for track in project.tracks.iter() {
        if !track.enabled {
            continue;
        }
        // Track-level audio gates (spec §3). Mute wins over solo; an
        // empty solo set takes the normal path.
        if track.muted {
            continue;
        }
        if any_solo && !track.solo {
            continue;
        }
        for layer in track.layers.iter() {
            if !layer.enabled || layer.locked {
                continue;
            }
            let LayerParams::Audio(p) = &layer.params else {
                continue;
            };
            if p.mute {
                continue;
            }
            let media = project
                .media_pool
                .get(&p.media)
                .ok_or_else(|| PlanError::MissingMedia(p.media.to_string()))?;
            let label = media
                .label
                .clone()
                .unwrap_or_else(|| media.path_abs.display().to_string());
            let conform_path = media
                .conform_path
                .clone()
                .filter(|c| crate::cache::cached_ok(c))
                .ok_or_else(|| PlanError::ConformMissing(label.clone()))?;
            let span_us = p.src_out_us - p.src_in_us;
            layers.push(MixLayer {
                label,
                conform_path,
                start_frame: us_to_frame(layer.t_start_us),
                src_in_frame: us_to_frame(p.src_in_us),
                src_out_frame: us_to_frame(p.src_out_us),
                gain: sample_gain(
                    &p.gain_db,
                    p.fade_in_us as i64,
                    p.fade_out_us as i64,
                    span_us,
                ),
                pan: sample_pan(&p.pan, span_us),
            });
        }
    }
    Ok(MixPlan {
        window_start_frame: us_to_frame(w_start_us),
        window_end_frame: us_to_frame(w_end_us),
        layers,
    })
}

/// Sum one output block (stereo interleaved f32) starting at absolute
/// composition frame `block_start`. `readers` parallels `plan.layers`.
/// `out` has length `frames * 2` and is zeroed by the caller.
pub fn mix_block(
    plan: &MixPlan,
    readers: &mut [ConformReader],
    block_start: i64,
    frames: usize,
    out: &mut [f32],
) -> Result<()> {
    for (layer, reader) in plan.layers.iter().zip(readers.iter_mut()) {
        let layer_end = layer.end_frame();
        if block_start + frames as i64 <= layer.start_frame || block_start >= layer_end {
            continue;
        }
        let src_start = block_start - layer.start_frame + layer.src_in_frame;
        let data = reader.read_frames(src_start, frames)?;
        let ch = reader.header.channels as usize;
        for k in 0..frames {
            let comp_f = block_start + k as i64;
            if comp_f < layer.start_frame || comp_f >= layer_end {
                continue;
            }
            let local_f = comp_f - layer.start_frame;
            let local_us = local_f * 1_000_000 / MIX_SAMPLE_RATE;
            let g = layer.gain.eval(local_us);
            let p = layer.pan.eval(local_us);
            let frame = &data[k * ch..k * ch + ch];
            let scaled: [f32; 2] = match ch {
                1 => [frame[0] * g, frame[0] * g],
                _ => [frame[0] * g, frame[1] * g],
            };
            let (l, r) = pan_frame(p, &scaled[..ch.min(2)]);
            out[k * 2] += l;
            out[k * 2 + 1] += r;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::conform_reader::{ConformReader, write_vconf};
    use crate::state::animated::Animated;
    use crate::state::layer::{AudioParams, Layer, LayerParams};
    use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
    use crate::state::project::{Project, ProjectMetadata, ProjectSettings, SCHEMA_VERSION};
    use crate::state::track::Track;
    use tempfile::TempDir;

    fn flat_mono_conform(
        dir: &std::path::Path,
        name: &str,
        value: f32,
        frames: usize,
    ) -> PathBuf {
        let p = dir.join(name);
        write_vconf(&p, 1, &vec![value; frames]);
        p
    }

    fn plain_layer(path: PathBuf, start_frame: i64, n_frames: i64) -> MixLayer {
        MixLayer {
            label: "test".into(),
            conform_path: path,
            start_frame,
            src_in_frame: 0,
            src_out_frame: n_frames,
            gain: Envelope::constant(1.0, n_frames * 1_000_000 / MIX_SAMPLE_RATE),
            pan: Envelope::constant(0.0, n_frames * 1_000_000 / MIX_SAMPLE_RATE),
        }
    }

    #[test]
    fn us_to_frame_is_exact_on_the_grid() {
        assert_eq!(us_to_frame(0), 0);
        assert_eq!(us_to_frame(1_000_000), 48_000);
        assert_eq!(us_to_frame(20_833), 1_000); // 1000 frames = 20833.3µs
    }

    #[test]
    fn single_centered_mono_layer_equal_power() {
        let tmp = TempDir::new().unwrap();
        let p = flat_mono_conform(tmp.path(), "a.conform", 0.5, 100);
        let plan = MixPlan {
            window_start_frame: 0,
            window_end_frame: 100,
            layers: vec![plain_layer(p.clone(), 0, 100)],
        };
        let mut readers = vec![ConformReader::open(&p).unwrap()];
        let mut out = vec![0f32; 100 * 2];
        mix_block(&plan, &mut readers, 0, 100, &mut out).unwrap();
        // mono center: each side = 0.5 · cos(π/4) ≈ 0.35355
        assert!((out[0] - 0.35355).abs() < 1e-4);
        assert!((out[1] - 0.35355).abs() < 1e-4);
    }

    #[test]
    fn placement_offsets_and_silence_gaps() {
        let tmp = TempDir::new().unwrap();
        let p = flat_mono_conform(tmp.path(), "a.conform", 0.4, 10);
        let plan = MixPlan {
            window_start_frame: 0,
            window_end_frame: 30,
            layers: vec![plain_layer(p.clone(), 10, 10)],
        };
        let mut readers = vec![ConformReader::open(&p).unwrap()];
        let mut out = vec![0f32; 30 * 2];
        mix_block(&plan, &mut readers, 0, 30, &mut out).unwrap();
        assert_eq!(out[9 * 2], 0.0, "before layer start: silence");
        assert!(out[10 * 2] > 0.2, "at layer start: signal");
        assert!(out[19 * 2] > 0.2, "last layer frame: signal");
        assert_eq!(out[20 * 2], 0.0, "past layer end: silence");
    }

    #[test]
    fn overlapping_layers_sum() {
        let tmp = TempDir::new().unwrap();
        let p1 = flat_mono_conform(tmp.path(), "a.conform", 0.3, 50);
        let p2 = flat_mono_conform(tmp.path(), "b.conform", 0.2, 50);
        let plan = MixPlan {
            window_start_frame: 0,
            window_end_frame: 50,
            layers: vec![
                plain_layer(p1.clone(), 0, 50),
                plain_layer(p2.clone(), 0, 50),
            ],
        };
        let mut readers = vec![
            ConformReader::open(&p1).unwrap(),
            ConformReader::open(&p2).unwrap(),
        ];
        let mut out = vec![0f32; 50 * 2];
        mix_block(&plan, &mut readers, 0, 50, &mut out).unwrap();
        let expect = (0.3 + 0.2) * (std::f32::consts::FRAC_PI_4).cos();
        assert!((out[0] - expect).abs() < 1e-4);
    }

    // ── plan_for_project mute/solo helpers ──────────────────────────────────

    /// Build a minimal `Project` with two Audio tracks, one layer each.
    /// Both conform files are written into `dir`. The returned `Project`
    /// is valid for `plan_for_project` — media pool entries point at real
    /// non-zero files so `cached_ok` passes.
    fn two_audio_tracks_project(dir: &std::path::Path) -> Project {
        let now = chrono::Utc::now();

        // Conform files for each track
        let conform_a = dir.join("a.conform");
        let conform_b = dir.join("b.conform");
        write_vconf(&conform_a, 1, &vec![0.5f32; 48_000]);
        write_vconf(&conform_b, 1, &vec![0.3f32; 48_000]);

        let media_id_a = uuid::Uuid::new_v4();
        let media_id_b = uuid::Uuid::new_v4();

        let make_media =
            |id: uuid::Uuid, conform: std::path::PathBuf| -> MediaItem {
                MediaItem {
                    id,
                    label: None,
                    path_abs: conform.clone(),
                    path_rel: None,
                    kind: MediaKind::Audio,
                    metadata: MediaMetadata::default(),
                    proxy_path: None,
                    proxy_format_version: 0,
                    quick_proxy_path: None,
                    proxy_bypassed: false,
                    export_uses_original: false,
                    waveform_path: None,
                    conform_path: Some(conform),
                    thumbnails_dir: None,
                    file_hash_blake3: "0000000000000000".into(),
                    file_size: 1,
                    file_mtime: 0,
                    imported_at: now,
                }
            };

        let make_audio_layer = |media_id: uuid::Uuid| -> Layer {
            Layer {
                id: uuid::Uuid::new_v4(),
                label: None,
                t_start_us: 0,
                t_end_us: 1_000_000,
                enabled: true,
                locked: false,
                metadata: imbl::HashMap::new(),
                params: LayerParams::Audio(AudioParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    gain_db: Animated::Static(0.0),
                    pan: Animated::Static(0.0),
                    fade_in_us: 0,
                    fade_out_us: 0,
                    mute: false,
                }),
            }
        };

        let track_a = Track {
            id: uuid::Uuid::new_v4(),
            label: Some("A".into()),
            enabled: true,
            locked: false,
            muted: false,
            solo: false,
            removable: true,
            role: None,
            transient: false,
            height_px: 64,
            layers: imbl::vector![make_audio_layer(media_id_a)],
        };
        let track_b = Track {
            id: uuid::Uuid::new_v4(),
            label: Some("B".into()),
            enabled: true,
            locked: false,
            muted: false,
            solo: false,
            removable: true,
            role: None,
            transient: false,
            height_px: 64,
            layers: imbl::vector![make_audio_layer(media_id_b)],
        };

        let mut media_pool = imbl::HashMap::new();
        media_pool.insert(media_id_a, make_media(media_id_a, conform_a));
        media_pool.insert(media_id_b, make_media(media_id_b, conform_b));

        Project {
            schema_version: SCHEMA_VERSION,
            project_id: uuid::Uuid::new_v4(),
            metadata: ProjectMetadata {
                name: "mute/solo test".into(),
                created_at: now,
                modified_at: now,
                description: None,
            },
            composition: crate::state::composition::Composition::default(),
            media_pool,
            tracks: imbl::vector![track_a, track_b],
            markers: imbl::Vector::new(),
            transitions: imbl::Vector::new(),
            groups: imbl::Vector::new(),
            settings: ProjectSettings::default(),
        }
    }

    #[test]
    fn muted_track_is_skipped() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // Mute track A
        project.tracks[0].muted = true;
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 1, "muted track A must be excluded");
        assert_eq!(
            plan.layers[0].conform_path,
            tmp.path().join("b.conform"),
            "track B (b.conform) must be the surviving layer"
        );
    }

    #[test]
    fn solo_silences_non_solo_tracks() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // Solo track A only
        project.tracks[0].solo = true;
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 1, "only soloed track A should play");
        assert_eq!(
            plan.layers[0].conform_path,
            tmp.path().join("a.conform"),
            "track A (a.conform) must be the surviving layer"
        );
    }

    #[test]
    fn disabled_track_solo_does_not_gate() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // Disabled tracks' solo flags don't gate the mix.
        project.tracks[0].enabled = false;
        project.tracks[0].solo = true;
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(
            plan.layers.len(),
            1,
            "disabled track A's solo must not silence track B"
        );
    }

    #[test]
    fn mute_wins_over_solo() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // Track A: solo AND muted — mute wins, A is excluded; B is silenced by
        // the solo set ⇒ no layers at all.
        project.tracks[0].solo = true;
        project.tracks[0].muted = true;
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 0, "mute wins over solo; nothing plays");
    }

    #[test]
    fn gain_envelope_applies_per_sample() {
        let tmp = TempDir::new().unwrap();
        let n = 48_000i64; // 1 s
        let p = flat_mono_conform(tmp.path(), "a.conform", 1.0, n as usize);
        let mut layer = plain_layer(p.clone(), 0, n);
        // fade-in across the full second
        layer.gain = crate::audio::envelope::sample_gain(
            &crate::state::animated::Animated::Static(0.0),
            1_000_000,
            0,
            1_000_000,
        );
        let plan = MixPlan {
            window_start_frame: 0,
            window_end_frame: n,
            layers: vec![layer],
        };
        let mut readers = vec![ConformReader::open(&p).unwrap()];
        let mut out = vec![0f32; n as usize * 2];
        mix_block(&plan, &mut readers, 0, n as usize, &mut out).unwrap();
        let half = (std::f32::consts::FRAC_PI_4).cos();
        assert!(out[0].abs() < 1e-3, "t=0 fade-in is silent");
        let mid = out[(n as usize / 2) * 2];
        assert!(
            (mid - 0.5 * half).abs() < 2e-3,
            "midpoint ≈ half gain, got {mid}"
        );
    }
}
