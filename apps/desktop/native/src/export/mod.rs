//! Audio-only export + final mux/transcode. The Pixi/WebCodecs worker streams
//! the video temp file; Rust fills in an optional audio temp file and ffmpeg
//! writes the user's output.
//!
//! Post P12-d — the legacy full-render ffmpeg-compositor pipeline (presets,
//! HW encoder cache, export queue, progress events, `compile_project`
//! debug view) was deleted with the IR visual half. Only the two paths
//! the Pixi export orchestrator actually invokes survive.

mod hwencoder;
pub use hwencoder::{HwEncoderCache, TargetCodec};
pub mod videosink;

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};

use crate::events::EventSink;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::{info, warn};

use crate::state::Project;

/// Audio encode parameters passed from the renderer. `sample_rate`/`channels`
/// are `None` to follow the composition. A serde struct so the backend command
/// can take it directly.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioEncodeSpec {
    pub codec: String, // "aac" | "opus"
    pub bitrate: u64,  // bits per second
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
}

/// Build the `-c:a ... -b:a ...` audio-encode args. AAC is the default; "opus"
/// maps to libopus (MKV-only, enforced renderer-side).
fn audio_encode_args(codec: &str, bitrate_bps: u64) -> Vec<std::ffi::OsString> {
    use std::ffi::OsString;
    let enc = if codec == "opus" { "libopus" } else { "aac" };
    vec![
        "-c:a".into(),
        OsString::from(enc),
        "-b:a".into(),
        bitrate_bps.to_string().into(),
    ]
}

/// Audio-only export. Produces an audio-only file at `output` (AAC `.m4a` or
/// Opus `.mka`) containing the project's mixed audio. The mix itself happens
/// in Rust (`audio::mix`, sample-accurate over conform PCM); ffmpeg's role is
/// reduced to the encode tail — `alimiter` ceiling + AAC/Opus encode. The
/// PixiJS export Worker streams the temp video file; `mux_to_file` /
/// `transcode_and_mux` combine them. ADR 0019.
pub async fn export_audio_only(
    project: &Project,
    output: &Path,
    audio: &AudioEncodeSpec,
    window_us: Option<(i64, i64)>,
) -> Result<bool> {
    mix_and_encode(project, output, audio, window_us).await
}

/// The AppHandle-free core of `export_audio_only`, separated for direct
/// integration testing.
async fn mix_and_encode(
    project: &Project,
    output: &Path,
    audio: &AudioEncodeSpec,
    window_us: Option<(i64, i64)>,
) -> Result<bool> {
    use crate::audio::mix::{MIX_BLOCK_FRAMES, mix_block, plan_for_project};

    if !ffmpeg_is_installed() {
        anyhow::bail!(
            "ffmpeg is not installed. Install via `winget install -e --id Gyan.FFmpeg` (Windows), \
             `brew install ffmpeg` (macOS), or your distro's package."
        );
    }

    let plan = plan_for_project(project, window_us).map_err(|e| anyhow::anyhow!("{e}"))?;
    let total_frames = (plan.window_end_frame - plan.window_start_frame).max(0);
    if plan.layers.is_empty() || total_frames == 0 {
        // No audio layers (or an empty window) — produce nothing. The Pixi
        // mux step tolerates a missing audio file by stream-copy muxing
        // video-only.
        warn!("audio-only export: no audio layers in range; skipping ffmpeg");
        return Ok(false);
    }

    let target_sr = audio.sample_rate.unwrap_or(project.composition.sample_rate);
    let target_ch = audio.channels.unwrap_or(2).clamp(1, 2);

    // Create the output's parent dir if missing. Audio-only export sends this
    // straight to the dialog's location (defaults to `<workspace>/output`,
    // which may not exist on first export) rather than a temp file. Without
    // this, ffmpeg can't open the output and exits at once — surfacing only as
    // a broken-pipe on the PCM stdin write. Mirrors `mux_export`.
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create output dir {}", parent.display()))?;
        }
    }

    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(["-y", "-hide_banner", "-nostats"])
        .args(["-f", "f32le", "-ar", "48000", "-ac", "2", "-i", "-"])
        // −1 dB sample-peak ceiling answers overlap summing past full scale;
        // `level=0` disables alimiter's auto-normalize (defaults ON — the
        // known trap). True-peak oversampling is future work (docs/audio.md).
        .args(["-af", "alimiter=limit=0.891:level=0"])
        .args(["-ar", &target_sr.to_string(), "-ac", &target_ch.to_string()]);
    for arg in audio_encode_args(&audio.codec, audio.bitrate) {
        cmd.arg(arg);
    }
    cmd.arg(output);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    info!("audio mix+encode starting → {}", output.display());
    let mut child = cmd.spawn().context("spawn ffmpeg")?;
    let mut stdin = child.stdin.take().context("take ffmpeg stdin")?;
    let stderr = child.stderr.take().context("take ffmpeg stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            tail.push(line);
            if tail.len() > 50 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });

    // The mixer is synchronous file I/O — run it on a blocking thread and
    // feed blocks through a channel to the async stdin writer.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<f32>>(4);
    let mix_task = tokio::task::spawn_blocking(move || -> Result<()> {
        let mut readers = plan
            .layers
            .iter()
            .map(|l| crate::audio::conform_reader::ConformReader::open(&l.conform_path))
            .collect::<Result<Vec<_>>>()?;
        let mut done: i64 = 0;
        while done < total_frames {
            let frames = MIX_BLOCK_FRAMES.min((total_frames - done) as usize);
            let mut out = vec![0f32; frames * 2];
            mix_block(
                &plan,
                &mut readers,
                plan.window_start_frame + done,
                frames,
                &mut out,
            )?;
            if tx.blocking_send(out).is_err() {
                break; // ffmpeg died; the stderr tail reports below
            }
            done += frames as i64;
        }
        Ok(())
    });

    use tokio::io::AsyncWriteExt;
    while let Some(block) = rx.recv().await {
        let mut bytes = Vec::with_capacity(block.len() * 4);
        for s in &block {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        if let Err(e) = stdin.write_all(&bytes).await {
            warn!("ffmpeg stdin write failed: {e}");
            break;
        }
    }
    drop(stdin); // EOF → ffmpeg finalizes the file
    mix_task.await.context("join mixer")??;

    let status = child.wait().await.context("await ffmpeg")?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    if !status.success() {
        warn!("ffmpeg exited with {}\nstderr tail:\n{}", status, stderr_tail);
        anyhow::bail!(
            "ffmpeg exited {}. Tail:\n{}",
            status,
            stderr_tail.lines().rev().take(8).collect::<Vec<_>>().join("\n")
        );
    }
    info!("audio mix+encode complete → {}", output.display());
    Ok(true)
}

/// Build the ffmpeg argv for `mux_to_file`. Extracted out of the async
/// fn so the omit-`-i audio`-when-missing decision is unit-testable
/// without shelling out to ffmpeg.
fn mux_args(
    video_path: &Path,
    audio_path: &Path,
    output: &Path,
) -> Vec<std::ffi::OsString> {
    use std::ffi::OsString;
    let mut args: Vec<OsString> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-i".into(),
        video_path.into(),
    ];
    if audio_path.exists() {
        args.push("-i".into());
        args.push(audio_path.into());
    }
    args.push("-c".into());
    args.push("copy".into());
    args.push(output.into());
    args
}

/// Stream-copy mux of one video file (+ optional audio) into the chosen
/// output container. Runs `ffmpeg -y -i video [-i audio] -c copy out`. When
/// `audio_path` doesn't exist the audio input is omitted — taken on
/// projects with no audio layers, where `export_audio_only` returns
/// without producing anything.
pub async fn mux_to_file(
    video_path: &Path,
    audio_path: &Path,
    output: &Path,
) -> Result<()> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg is not installed");
    }
    let has_audio = audio_path.exists();
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(mux_args(video_path, audio_path, output));
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if has_audio {
        info!(
            "ffmpeg mux: {} + {} → {}",
            video_path.display(),
            audio_path.display(),
            output.display()
        );
    } else {
        info!(
            "ffmpeg mux (video-only, no audio track): {} → {}",
            video_path.display(),
            output.display()
        );
    }
    let mut child = cmd.spawn().context("spawn ffmpeg mux")?;
    let stderr = child.stderr.take().context("take ffmpeg stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            tail.push(line);
            if tail.len() > 50 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });
    let status = child.wait().await.context("await ffmpeg mux")?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    if !status.success() {
        anyhow::bail!(
            "ffmpeg mux exited {}. Tail:\n{}",
            status,
            stderr_tail.lines().rev().take(8).collect::<Vec<_>>().join("\n")
        );
    }
    Ok(())
}

/// napi event emitted while ffmpeg transcodes the video (ffmpeg-path codecs
/// like HEVC). Payload: an `f64` percent in 0.0..=1.0.
pub const EVENT_TRANSCODE_PROGRESS: &str = "export:transcode_progress";

/// Transcode `video_path` (the WebCodecs H.264 mezzanine) to `encoder` and
/// mux with `audio_path` into `output` (container = output extension). Parses
/// `-progress pipe:1` and emits `EVENT_TRANSCODE_PROGRESS` against `duration_us`.
pub async fn transcode_and_mux(
    events: &Arc<dyn EventSink>,
    encoder: &str,
    codec: TargetCodec,
    bitrate: u64,
    cbr: bool,
    gop: u64,
    duration_us: i64,
    video_path: &Path,
    audio_path: &Path,
    output: &Path,
) -> Result<()> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg is not installed");
    }
    let has_audio = audio_path.exists();
    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-y").arg("-hide_banner").arg("-nostats");
    cmd.arg("-i").arg(video_path);
    if has_audio {
        cmd.arg("-i").arg(audio_path);
    }
    for arg in video_encode_args(encoder, bitrate, cbr, gop) {
        cmd.arg(arg);
    }
    // HEVC in MP4/MOV must carry the `hvc1` fourcc; ffmpeg defaults to `hev1`,
    // which Apple/Premiere/Chromium/Electron refuse to play.
    for arg in hvc1_tag_args(codec, output) {
        cmd.arg(arg);
    }
    // Audio is already encoded by export_audio_only; stream-copy it.
    if has_audio {
        cmd.args(["-c:a", "copy"]);
    }
    // Machine-readable progress on stdout.
    cmd.args(["-progress", "pipe:1"]);
    cmd.arg(output);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    info!(
        "ffmpeg transcode ({encoder}): {} -> {}",
        video_path.display(),
        output.display()
    );
    let mut child = cmd.spawn().context("spawn ffmpeg transcode")?;

    // Parse `-progress` key=value lines from stdout; emit percent.
    let stdout = child.stdout.take().context("take ffmpeg stdout")?;
    let events_for_progress = events.clone();
    let total_us = duration_us.max(1) as f64;
    let progress_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(v) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<f64>() {
                    let pct = (us / total_us).clamp(0.0, 1.0);
                    events_for_progress.emit(EVENT_TRANSCODE_PROGRESS, serde_json::json!(pct));
                }
            }
        }
    });

    let stderr = child.stderr.take().context("take ffmpeg stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            tail.push(line);
            if tail.len() > 50 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });

    let status = child.wait().await.context("await ffmpeg transcode")?;
    let _ = progress_task.await;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    if !status.success() {
        anyhow::bail!(
            "ffmpeg transcode exited {}. Tail:\n{}",
            status,
            stderr_tail.lines().rev().take(8).collect::<Vec<_>>().join("\n")
        );
    }
    events.emit(EVENT_TRANSCODE_PROGRESS, serde_json::json!(1.0));
    Ok(())
}

/// HEVC in MP4/MOV needs the `hvc1` fourcc tag; ffmpeg defaults to `hev1`
/// which Apple/Premiere/Chromium/Electron won't play. MKV uses no such tag, and other
/// codecs (H.264 `avc1`, AV1 `av01`) already get correct defaults.
pub(crate) fn hvc1_tag_args(codec: TargetCodec, output: &Path) -> Vec<std::ffi::OsString> {
    let ext = output
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(codec, TargetCodec::Hevc) && (ext == "mp4" || ext == "mov") {
        vec!["-tag:v".into(), "hvc1".into()]
    } else {
        Vec::new()
    }
}

/// Build the ffmpeg `-c:v …` video-encode args for a transcode. `encoder` is
/// the resolved ffmpeg encoder name (HW like `hevc_nvenc` or software like
/// `libx265`). VBR uses `-b:v` as the average target; CBR additionally pins
/// maxrate/minrate + a 2× bufsize. `gop` pins the keyframe interval (frames) so
/// the ffmpeg output matches the WebCodecs path's cadence. Software encoders
/// get a speed preset so AV1/HEVC don't take minutes.
pub(crate) fn video_encode_args(encoder: &str, bitrate: u64, cbr: bool, gop: u64) -> Vec<std::ffi::OsString> {
    use std::ffi::OsString;
    let mut a: Vec<OsString> = vec!["-c:v".into(), encoder.into()];
    a.push("-b:v".into());
    a.push(bitrate.to_string().into());
    if cbr {
        a.push("-maxrate".into());
        a.push(bitrate.to_string().into());
        a.push("-minrate".into());
        a.push(bitrate.to_string().into());
        a.push("-bufsize".into());
        a.push((bitrate * 2).to_string().into());
    }
    // Pin the keyframe interval. `-g` (max GOP) + `-keyint_min` (min GOP) force
    // a fixed cadence across encoders; `-sc_threshold 0` (added below for x264/
    // x265) stops scene-cut detection from inserting extra keyframes.
    let g = gop.max(1).to_string();
    a.push("-g".into());
    a.push(g.clone().into());
    a.push("-keyint_min".into());
    a.push(g.into());
    // Speed presets for the slow software encoders only.
    match encoder {
        "libsvtav1" => {
            a.push("-preset".into());
            a.push("8".into());
        }
        "libx265" | "libx264" => {
            a.push("-preset".into());
            a.push("medium".into());
            a.push("-sc_threshold".into());
            a.push("0".into());
        }
        "libvpx-vp9" => {
            a.push("-deadline".into());
            a.push("good".into());
            a.push("-cpu-used".into());
            a.push("4".into());
        }
        _ => {} // HW encoders: no preset (their defaults are already fast)
    }
    a
}

#[cfg(test)]
mod tests {
    use super::mux_args;
    use super::video_encode_args;

    #[test]
    fn audio_encode_args_aac_and_opus() {
        let aac = super::audio_encode_args("aac", 192_000);
        let a: Vec<String> = aac.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert_eq!(a, vec!["-c:a", "aac", "-b:a", "192000"]);

        let opus = super::audio_encode_args("opus", 128_000);
        let o: Vec<String> = opus.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert_eq!(o, vec!["-c:a", "libopus", "-b:a", "128000"]);
    }
    use tempfile::TempDir;

    #[test]
    fn video_encode_args_vbr_software() {
        let argv = video_encode_args("libx265", 8_000_000, false, 60);
        let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx265"));
        assert!(s.windows(2).any(|w| w[0] == "-b:v" && w[1] == "8000000"));
        assert!(!s.iter().any(|a| a == "-minrate"));
        // GOP pinned: -g/-keyint_min at the requested frame count, scene-cut off.
        assert!(s.windows(2).any(|w| w[0] == "-g" && w[1] == "60"));
        assert!(s.windows(2).any(|w| w[0] == "-keyint_min" && w[1] == "60"));
        assert!(s.windows(2).any(|w| w[0] == "-sc_threshold" && w[1] == "0"));
    }

    #[test]
    fn video_encode_args_cbr_pins_rate() {
        let argv = video_encode_args("hevc_nvenc", 8_000_000, true, 48);
        let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "hevc_nvenc"));
        assert!(s.windows(2).any(|w| w[0] == "-maxrate" && w[1] == "8000000"));
        assert!(s.windows(2).any(|w| w[0] == "-minrate" && w[1] == "8000000"));
        assert!(s.windows(2).any(|w| w[0] == "-bufsize" && w[1] == "16000000"));
        assert!(s.windows(2).any(|w| w[0] == "-g" && w[1] == "48"));
        // HW encoder: no -sc_threshold (that's an x264/x265 option only).
        assert!(!s.iter().any(|a| a == "-sc_threshold"));
    }

    #[test]
    fn video_encode_args_sets_software_preset() {
        let argv = video_encode_args("libsvtav1", 4_000_000, false, 120);
        let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-preset" && w[1] == "8"));
        assert!(s.windows(2).any(|w| w[0] == "-g" && w[1] == "120"));
    }

    #[test]
    fn hvc1_tag_only_for_hevc_in_mp4_mov() {
        use super::hvc1_tag_args;
        use super::TargetCodec;
        use std::path::Path;
        assert_eq!(hvc1_tag_args(TargetCodec::Hevc, Path::new("o.mp4")).len(), 2);
        assert_eq!(hvc1_tag_args(TargetCodec::Hevc, Path::new("o.mov")).len(), 2);
        assert!(hvc1_tag_args(TargetCodec::Hevc, Path::new("o.mkv")).is_empty());
        assert!(hvc1_tag_args(TargetCodec::Av1, Path::new("o.mp4")).is_empty());
        assert!(hvc1_tag_args(TargetCodec::H264, Path::new("o.mov")).is_empty());
    }

    /// End-to-end over the Rust mixer + ffmpeg encode tail: two overlapping
    /// flat mono conform layers (0.3 + 0.2) mix to (0.5·cos(π/4)) per
    /// channel, encode to AAC, decode back, and the mid-file peak must land
    /// within lossy-codec tolerance of the analytic value. Self-skips
    /// without ffmpeg on PATH.
    #[tokio::test]
    async fn mix_and_encode_two_layer_roundtrip() {
        use crate::audio::conform_reader::write_vconf;
        use crate::state::{
            animated::Animated,
            audio_role::AudioRole,
            layer::{AudioParams, Layer, LayerParams},
            media::{MediaItem, MediaKind, MediaMetadata},
            project::Project,
            track::Track,
        };
        use chrono::Utc;
        use uuid::Uuid;

        let ffmpeg_ok = std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ffmpeg_ok {
            eprintln!("ffmpeg not on PATH — skipping mix_and_encode smoke");
            return;
        }

        let tmp = TempDir::new().unwrap();
        let n = 48_000usize; // 1 s
        let c1 = tmp.path().join("a.conform");
        let c2 = tmp.path().join("b.conform");
        write_vconf(&c1, 1, &vec![0.3f32; n]);
        write_vconf(&c2, 1, &vec![0.2f32; n]);

        let mk_media = |id: Uuid, conform: &std::path::Path| MediaItem {
            id,
            label: Some("tone".into()),
            path_abs: "/m/tone.wav".into(),
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
            },
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: Some(conform.to_path_buf()),
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        let mk_layer = |id: Uuid, media: Uuid| Layer {
            id,
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::Audio(AudioParams {
                media,
                src_in_us: 0,
                src_out_us: 1_000_000,
                gain_db: Animated::Static(0.0),
                pan: Animated::Static(0.0),
                fade_in_us: 0,
                fade_out_us: 0,
                mute: false,
                role: AudioRole::Dialogue,
            }),
        };

        let m1 = Uuid::parse_str("01900000-0000-7000-8000-0000000000d1").unwrap();
        let m2 = Uuid::parse_str("01900000-0000-7000-8000-0000000000d2").unwrap();
        let mut p = Project::new_blank("mix-roundtrip");
        p.composition.duration_us = 1_000_000;
        p.media_pool.insert(m1, mk_media(m1, &c1));
        p.media_pool.insert(m2, mk_media(m2, &c2));
        p.tracks.push_back(Track {
            id: Uuid::parse_str("01900000-0000-7000-8000-0000000000d3").unwrap(),
            label: None,
            enabled: true,
            locked: false,
            muted: false,
            solo: false,
            removable: true,
            role: None,
            transient: false,
            height_px: 48,
            layers: imbl::vector![
                mk_layer(
                    Uuid::parse_str("01900000-0000-7000-8000-0000000000d4").unwrap(),
                    m1
                ),
                mk_layer(
                    Uuid::parse_str("01900000-0000-7000-8000-0000000000d5").unwrap(),
                    m2
                )
            ],
        });

        // Output into a not-yet-created nested dir. Audio-only export targets
        // the dialog's location (`<workspace>/output`), which may not exist on
        // first export; mix_and_encode must create it. Regression guard: ffmpeg
        // used to die with a broken-pipe on the PCM write when the dir was
        // missing (it couldn't open the output file).
        let out = tmp.path().join("nested").join("output").join("mix.m4a");
        let spec = super::AudioEncodeSpec {
            codec: "aac".into(),
            bitrate: 192_000,
            sample_rate: Some(48_000),
            channels: Some(2),
        };
        let produced = super::mix_and_encode(&p, &out, &spec, None)
            .await
            .expect("mix_and_encode");
        assert!(produced, "two audio layers in range -> should produce a file");
        assert!(out.is_file() && std::fs::metadata(&out).unwrap().len() > 0);

        // Decode back to f32 and inspect the middle 50% (skips AAC priming
        // and end padding).
        let decoded = std::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(&out)
            .args(["-f", "f32le", "-ac", "2", "-ar", "48000", "-"])
            .output()
            .expect("decode back");
        assert!(decoded.status.success());
        let bytes = decoded.stdout;
        let total = bytes.len() / 4;
        let q = total / 4;
        let mut peak = 0f32;
        for i in q..(3 * q) {
            let s = f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
            peak = peak.max(s.abs());
        }
        let expect = 0.5 * std::f32::consts::FRAC_PI_4.cos(); // ≈ 0.35355
        assert!(
            (peak - expect).abs() < expect * 0.10,
            "decoded mid-file peak {peak}, expected ≈{expect}"
        );
    }

    /// Regression for the no-audio export path: `mux_to_file` must NOT
    /// pass `-i audio_path` to ffmpeg when the audio file doesn't
    /// exist. The previous shape always emitted both `-i`s, so projects
    /// with no audio layers (where `export_audio_only` early-returns
    /// without writing an audio temp file) failed at the mux step with
    /// "No such file or directory".
    #[test]
    fn mux_args_omits_audio_input_when_audio_missing() {
        let tmp = TempDir::new().unwrap();
        let video = tmp.path().join("v.mp4");
        std::fs::write(&video, b"").unwrap();
        let audio_missing = tmp.path().join("does-not-exist.m4a");
        let output = tmp.path().join("o.mp4");

        let argv: Vec<String> = mux_args(&video, &audio_missing, &output)
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            argv.iter().filter(|a| *a == "-i").count(),
            1,
            "expected exactly one `-i` input (video-only), got argv: {argv:?}"
        );
        let audio_missing_str = audio_missing.to_string_lossy().into_owned();
        assert!(
            !argv.contains(&audio_missing_str),
            "missing audio path must not appear in argv: {argv:?}"
        );
        let video_str = video.to_string_lossy().into_owned();
        let output_str = output.to_string_lossy().into_owned();
        assert!(argv.contains(&video_str), "video path missing: {argv:?}");
        assert!(argv.contains(&output_str), "output path missing: {argv:?}");
    }

    #[test]
    fn mux_args_includes_audio_input_when_audio_present() {
        let tmp = TempDir::new().unwrap();
        let video = tmp.path().join("v.mp4");
        let audio = tmp.path().join("a.m4a");
        std::fs::write(&video, b"").unwrap();
        std::fs::write(&audio, b"").unwrap();
        let output = tmp.path().join("o.mp4");

        let argv: Vec<String> = mux_args(&video, &audio, &output)
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            argv.iter().filter(|a| *a == "-i").count(),
            2,
            "expected two `-i` inputs (video + audio), got argv: {argv:?}"
        );
        assert!(
            argv.contains(&video.to_string_lossy().into_owned()),
            "video path missing: {argv:?}"
        );
        assert!(
            argv.contains(&audio.to_string_lossy().into_owned()),
            "audio path missing: {argv:?}"
        );
    }
}
