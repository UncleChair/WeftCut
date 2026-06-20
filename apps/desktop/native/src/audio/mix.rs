//! Export audio mixer — MixPlan construction from the project and the
//! block-pull summing loop. Replaces the lavfi audio IR (ADR 0019).
//!
//! Time discipline: everything converts to the 48 kHz frame domain ONCE via
//! `us_to_frame`, then all placement/trim math is integer frames — the audio
//! analog of the video `frameGrid` rule.

use std::path::PathBuf;

use anyhow::Result;
use uuid::Uuid;

use crate::audio::conform_reader::ConformReader;
use crate::audio::envelope::{Envelope, pan_frame, sample_gain, sample_pan};
use crate::state::Project;
use crate::state::audio_role::RoleMixSettings;
use crate::state::layer::{AudioParams, Layer, LayerParams};

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

// ── Role-gate primitives ────────────────────────────────────────────────────
// The canonical twin of `render/audio/roleGate.ts`. `audible_audio_layers`
// (gate) and `plan_for_project` (gain fold) call these, so the logic the export
// path runs IS the logic the cross-language golden locks
// (`render/audio/roleGate.golden.test.ts` + `tests::golden_vectors_match_fixture`
// share one fixture). Keep BYTE-FOR-BYTE in step with roleGate.ts.

/// True iff any role in the table is soloed. Absent roles can't be soloed, so a
/// partial/empty table answers correctly.
pub fn any_role_solo<'a>(roles: impl IntoIterator<Item = &'a RoleMixSettings>) -> bool {
    roles.into_iter().any(|r| r.solo)
}

/// A role is audible unless muted, or a solo set exists and it isn't soloed —
/// mute wins over solo. `role` is the RESOLVED settings (present, or the
/// `Project::role_mix` default for an absent role); resolving the absent case is
/// the caller's job, matching `role_mix`.
pub fn role_audible(role: &RoleMixSettings, any_solo: bool) -> bool {
    if role.muted {
        return false;
    }
    if any_solo && !role.solo {
        return false;
    }
    true
}

/// Linear gain for a role's `gain_db`, folded into each audible layer's gain
/// envelope (v1 has no per-role DSP). `f32` to match `db_to_linear` and
/// `Envelope::scale`; the TS twin computes in `f64`, so the golden compares
/// with an f32-width tolerance (same precision the envelope golden uses).
pub fn role_gain_linear(role: &RoleMixSettings) -> f32 {
    crate::audio::envelope::db_to_linear(role.gain_db)
}

/// Every audible audio layer in track order: whole-track disable gates
/// (`track.enabled`); audio mute/solo gating lives on ROLES, not tracks
/// (docs/audio.md) — role mute, the role solo set (mute wins over solo);
/// plus layer gates (enabled, unlocked, unmuted) and the half-open window
/// overlap. Shared by `plan_for_project` and `conform_waiting_media` so the
/// export-readiness gate and the mix plan can never disagree on selection.
fn audible_audio_layers<'a>(
    project: &'a Project,
    w_start_us: i64,
    w_end_us: i64,
) -> Vec<(&'a Layer, &'a AudioParams)> {
    // Role-level solo (docs/audio.md): when any role is soloed, only
    // soloed roles are audible. Mute wins over solo.
    let any_solo = any_role_solo(project.audio_roles.values());
    let mut out = Vec::new();
    for track in project.tracks.iter() {
        // Whole-track disable still gates (rule 1). Track mute/solo no
        // longer gate audio — that moved to roles.
        if !track.enabled {
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
            let role = project.role_mix(p.role);
            if !role_audible(&role, any_solo) {
                continue;
            }
            // Window gate (half-open [w_start, w_end)): a layer the mix will
            // never read must neither require a conform cache nor occupy a
            // reader slot — otherwise a range export hard-errors
            // (ConformMissing) on clips entirely outside the range.
            if layer.t_end_us <= w_start_us || layer.t_start_us >= w_end_us {
                continue;
            }
            out.push((layer, p));
        }
    }
    out
}

/// Walk every audible Audio layer (see `audible_audio_layers`) and resolve
/// envelopes into a `MixPlan`.
pub fn plan_for_project(
    project: &Project,
    window_us: Option<(i64, i64)>,
) -> Result<MixPlan, PlanError> {
    let (w_start_us, w_end_us) = window_us.unwrap_or((0, project.composition.duration_us));
    let mut layers = Vec::new();
    for (layer, p) in audible_audio_layers(project, w_start_us, w_end_us) {
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
        let role_gain = role_gain_linear(&project.role_mix(p.role));
        let mut gain = sample_gain(&p.gain_db, p.fade_in_us as i64, p.fade_out_us as i64, span_us);
        gain.scale(role_gain);
        layers.push(MixLayer {
            label,
            conform_path,
            start_frame: us_to_frame(layer.t_start_us),
            src_in_frame: us_to_frame(p.src_in_us),
            src_out_frame: us_to_frame(p.src_out_us),
            gain,
            pan: sample_pan(&p.pan, span_us),
        });
    }
    Ok(MixPlan {
        window_start_frame: us_to_frame(w_start_us),
        window_end_frame: us_to_frame(w_end_us),
        layers,
    })
}

/// Media ids (deduped, first-appearance order) of audible in-window audio
/// layers whose conform cache is absent or fails `cached_ok` — exactly the
/// set `plan_for_project` would `ConformMissing` on. The export-readiness
/// gate waits on these (kicking `ensure_conform`) before the audio stage.
/// Media without an audio stream can never conform and are excluded;
/// `plan_for_project` remains the backstop for that pathological case.
pub fn conform_waiting_media(project: &Project, window_us: Option<(i64, i64)>) -> Vec<Uuid> {
    let (w_start_us, w_end_us) = window_us.unwrap_or((0, project.composition.duration_us));
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (_, p) in audible_audio_layers(project, w_start_us, w_end_us) {
        if !seen.insert(p.media) {
            continue;
        }
        let Some(media) = project.media_pool.get(&p.media) else {
            continue; // plan_for_project reports MissingMedia
        };
        if media.metadata.audio.is_none() {
            continue;
        }
        let ready = media
            .conform_path
            .as_deref()
            .map(crate::cache::cached_ok)
            .unwrap_or(false);
        if !ready {
            out.push(p.media);
        }
    }
    out
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
    use crate::state::audio_role::{AudioRole, RoleMixSettings};
    use crate::state::layer::{AudioParams, Layer, LayerParams};
    use crate::state::media::{AudioStreamMeta, MediaItem, MediaKind, MediaMetadata};
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
                    metadata: MediaMetadata {
                        duration_us: Some(1_000_000),
                        video: None,
                        audio: Some(AudioStreamMeta {
                            sample_rate: 48_000,
                            channels: 1,
                            codec: "pcm_f32le".into(),
                        }),
                        ..Default::default()
                    },
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

        let make_audio_layer = |media_id: uuid::Uuid, role: crate::state::audio_role::AudioRole| -> Layer {
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
                    role,
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
            layers: imbl::vector![make_audio_layer(media_id_a, crate::state::audio_role::AudioRole::Dialogue)],
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
            layers: imbl::vector![make_audio_layer(media_id_b, crate::state::audio_role::AudioRole::Music)],
        };

        let mut media_pool = imbl::HashMap::new();
        media_pool.insert(media_id_a, make_media(media_id_a, conform_a));
        media_pool.insert(media_id_b, make_media(media_id_b, conform_b));

        // Real projects keep duration_us ≥ max(layer.t_end_us) (the ADR 0005
        // autofit guard holds even when pinned); the window gate relies on it
        // for the `None` ⇒ whole-project window.
        let composition = crate::state::composition::Composition {
            duration_us: 10_000_000,
            ..Default::default()
        };

        Project {
            schema_version: SCHEMA_VERSION,
            project_id: uuid::Uuid::new_v4(),
            metadata: ProjectMetadata {
                name: "mute/solo test".into(),
                created_at: now,
                modified_at: now,
                description: None,
            },
            composition,
            media_pool,
            tracks: imbl::vector![track_a, track_b],
            markers: imbl::Vector::new(),
            transitions: imbl::Vector::new(),
            groups: imbl::Vector::new(),
            audio_roles: imbl::HashMap::new(),
            settings: ProjectSettings::default(),
        }
    }

    fn set_role(p: &mut Project, role: AudioRole, s: RoleMixSettings) {
        p.audio_roles.insert(role, s);
    }

    #[test]
    fn muted_role_is_skipped() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        set_role(&mut project, AudioRole::Dialogue, RoleMixSettings { gain_db: 0.0, muted: true, solo: false });
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 1, "Dialogue role muted ⇒ only Music plays");
        assert_eq!(plan.layers[0].conform_path, tmp.path().join("b.conform"));
    }

    #[test]
    fn solo_silences_non_solo_roles() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        set_role(&mut project, AudioRole::Dialogue, RoleMixSettings { gain_db: 0.0, muted: false, solo: true });
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 1, "only soloed Dialogue plays");
        assert_eq!(plan.layers[0].conform_path, tmp.path().join("a.conform"));
    }

    #[test]
    fn role_mute_wins_over_solo() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        set_role(&mut project, AudioRole::Dialogue, RoleMixSettings { gain_db: 0.0, muted: true, solo: true });
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 0, "mute wins; Music silenced by the solo set");
    }

    #[test]
    fn role_gain_scales_output() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // +6.0206 dB ≈ ×2 on Dialogue only.
        set_role(&mut project, AudioRole::Dialogue, RoleMixSettings { gain_db: 6.0206, muted: false, solo: false });
        let plan = plan_for_project(&project, None).unwrap();
        let dialogue = plan.layers.iter().find(|l| l.conform_path == tmp.path().join("a.conform")).unwrap();
        assert!((dialogue.gain.eval(0) - 2.0).abs() < 1e-2, "Dialogue folded ×2");
        let music = plan.layers.iter().find(|l| l.conform_path == tmp.path().join("b.conform")).unwrap();
        assert!((music.gain.eval(0) - 1.0).abs() < 1e-3, "Music unchanged");
    }

    #[test]
    fn legacy_no_audio_roles_plays_both_at_unity() {
        let tmp = TempDir::new().unwrap();
        let project = two_audio_tracks_project(tmp.path()); // empty audio_roles
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 2);
        for l in &plan.layers {
            assert!((l.gain.eval(0) - 1.0).abs() < 1e-3);
        }
    }

    // ── conform_waiting_media ────────────────────────────────────────────────

    /// Media id behind the (single) audio layer of `project.tracks[track]`.
    fn layer_media(project: &Project, track: usize) -> uuid::Uuid {
        let LayerParams::Audio(p) = &project.tracks[track].layers[0].params else {
            unreachable!("fixture tracks carry audio layers");
        };
        p.media
    }

    #[test]
    fn waiting_lists_unconformed_in_window_media() {
        let tmp = TempDir::new().unwrap();
        let project = two_audio_tracks_project(tmp.path());
        assert!(
            conform_waiting_media(&project, None).is_empty(),
            "everything conformed ⇒ nothing to wait on"
        );
        std::fs::remove_file(tmp.path().join("b.conform")).unwrap();
        assert_eq!(
            conform_waiting_media(&project, None),
            vec![layer_media(&project, 1)],
            "track B's media lost its conform cache"
        );
    }

    #[test]
    fn waiting_skips_out_of_window_and_gated_layers() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        std::fs::remove_file(tmp.path().join("b.conform")).unwrap();
        // Out of window: the plan never reads it, so the gate never waits.
        project.tracks[1].layers[0].t_start_us = 2_000_000;
        project.tracks[1].layers[0].t_end_us = 3_000_000;
        assert!(conform_waiting_media(&project, Some((0, 1_000_000))).is_empty());
        project.tracks[1].layers[0].t_start_us = 0;
        project.tracks[1].layers[0].t_end_us = 1_000_000;
        // Muted role (track B carries the Music role).
        set_role(&mut project, AudioRole::Music, RoleMixSettings { gain_db: 0.0, muted: true, solo: false });
        assert!(conform_waiting_media(&project, None).is_empty());
        set_role(&mut project, AudioRole::Music, RoleMixSettings { gain_db: 0.0, muted: false, solo: false });
        // Locked layer.
        project.tracks[1].layers[0].locked = true;
        assert!(conform_waiting_media(&project, None).is_empty());
        project.tracks[1].layers[0].locked = false;
        // Solo'd out by the Dialogue role (track A).
        set_role(&mut project, AudioRole::Dialogue, RoleMixSettings { gain_db: 0.0, muted: false, solo: true });
        assert!(conform_waiting_media(&project, None).is_empty());
    }

    #[test]
    fn waiting_dedups_media_and_skips_streamless() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        std::fs::remove_file(tmp.path().join("b.conform")).unwrap();
        // A second layer of the same media ⇒ still one waiting entry.
        let mut extra = project.tracks[1].layers[0].clone();
        extra.id = uuid::Uuid::new_v4();
        project.tracks[1].layers.push_back(extra);
        assert_eq!(conform_waiting_media(&project, None).len(), 1);
        // Media with no audio stream can never conform ⇒ excluded from the
        // wait set (plan_for_project's ConformMissing stays the backstop).
        let id_b = layer_media(&project, 1);
        let mut media_b = project.media_pool.get(&id_b).unwrap().clone();
        media_b.metadata.audio = None;
        project.media_pool.insert(id_b, media_b);
        assert!(conform_waiting_media(&project, None).is_empty());
    }

    // ── plan_for_project window gating ──────────────────────────────────────

    #[test]
    fn plan_skips_unconformed_layer_outside_window() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // Track B's layer sits past the window and its conform cache is gone.
        // A window-limited plan must neither error on it nor include it — the
        // mix will never read a frame of it.
        project.tracks[1].layers[0].t_start_us = 2_000_000;
        project.tracks[1].layers[0].t_end_us = 3_000_000;
        std::fs::remove_file(tmp.path().join("b.conform")).unwrap();
        let plan = plan_for_project(&project, Some((0, 1_000_000))).unwrap();
        assert_eq!(plan.layers.len(), 1, "only the in-window layer plans");
        assert_eq!(plan.layers[0].conform_path, tmp.path().join("a.conform"));
    }

    #[test]
    fn plan_errors_on_unconformed_layer_inside_window() {
        let tmp = TempDir::new().unwrap();
        let project = two_audio_tracks_project(tmp.path());
        std::fs::remove_file(tmp.path().join("b.conform")).unwrap();
        let err = plan_for_project(&project, Some((0, 1_000_000))).unwrap_err();
        assert!(matches!(err, PlanError::ConformMissing(_)));
    }

    #[test]
    fn window_overlap_is_half_open() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // Track B's layer at [1s, 2s); track A's stays at [0, 1s).
        project.tracks[1].layers[0].t_start_us = 1_000_000;
        project.tracks[1].layers[0].t_end_us = 2_000_000;
        // Window [0, 1s): B's t_start == window end ⇒ B excluded.
        let plan = plan_for_project(&project, Some((0, 1_000_000))).unwrap();
        assert_eq!(plan.layers.len(), 1, "t_start == w_end is no overlap");
        // Window [2s, 3s): B's t_end == window start ⇒ both excluded.
        let plan = plan_for_project(&project, Some((2_000_000, 3_000_000))).unwrap();
        assert_eq!(plan.layers.len(), 0, "t_end == w_start is no overlap");
        // Window [1.5s, 2.5s): genuine partial overlap ⇒ B included.
        let plan = plan_for_project(&project, Some((1_500_000, 2_500_000))).unwrap();
        assert_eq!(plan.layers.len(), 1, "partial overlap plans the layer");
        assert_eq!(plan.layers[0].conform_path, tmp.path().join("b.conform"));
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

    /// Cross-language golden vectors for the role gate. The SAME fixture is
    /// asserted by `render/audio/roleGate.golden.test.ts` against the TS
    /// `roleGate.ts`; a verdict that passes one side and fails the other is
    /// drift in the mute/solo/gain rules — exactly what this catches. Exercises
    /// the SAME `any_role_solo`/`role_audible`/`role_gain_linear` the export path
    /// runs, with absent roles resolved to `role_mix`'s default. Regenerate the
    /// fixture only on an INTENTIONAL rule change, mirrored in roleGate.ts.
    #[test]
    fn golden_vectors_match_fixture() {
        use std::collections::HashMap;

        #[derive(serde::Deserialize)]
        struct RoleEntry {
            role: AudioRole,
            gain_db: f64,
            muted: bool,
            solo: bool,
        }
        #[derive(serde::Deserialize)]
        struct Query {
            role: AudioRole,
            audible: bool,
            gain_linear: f64,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            roles: Vec<RoleEntry>,
            any_solo: bool,
            queries: Vec<Query>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/renderer/render/audio/roleGateGolden.fixture.json"
        ))
        .expect("roleGate golden fixture parses");
        assert!(!fixture.cases.is_empty());

        for case in &fixture.cases {
            let table: HashMap<AudioRole, RoleMixSettings> = case
                .roles
                .iter()
                .map(|r| {
                    (
                        r.role,
                        RoleMixSettings { gain_db: r.gain_db, muted: r.muted, solo: r.solo },
                    )
                })
                .collect();
            let any_solo = any_role_solo(table.values());
            assert_eq!(any_solo, case.any_solo, "case `{}` any_solo", case.name);
            for q in &case.queries {
                // Absent role ⇒ role_mix default (unmuted/unsoloed, unity gain).
                let settings = table.get(&q.role).cloned().unwrap_or_default();
                assert_eq!(
                    role_audible(&settings, any_solo),
                    q.audible,
                    "case `{}` role {:?} audible",
                    case.name,
                    q.role
                );
                // f32 (Rust) vs f64 (TS/fixture): compare at f32 width, the
                // same precision the envelope golden locks db_to_linear at.
                let got = role_gain_linear(&settings) as f64;
                assert!(
                    (got - q.gain_linear).abs() < 1e-5,
                    "case `{}` role {:?} gain: got {got}, expect {}",
                    case.name,
                    q.role,
                    q.gain_linear
                );
            }
        }
    }
}
