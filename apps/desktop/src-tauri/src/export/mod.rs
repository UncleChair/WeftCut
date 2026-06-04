//! Audio-only export + stream-copy mux. The Pixi renderer is the video
//! source; Rust fills in audio.m4a and `ffmpeg -c copy` stitches them.
//!
//! Post P12-d — the legacy full-render ffmpeg-compositor pipeline (presets,
//! HW encoder cache, export queue, progress events, `compile_project`
//! debug view) was deleted with the IR visual half. Only the two paths
//! the Pixi export orchestrator actually invokes survive.

mod hwencoder;
pub use hwencoder::{HwEncoderCache, TargetCodec};

use std::path::Path;
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::{info, warn};

use crate::ir::{RenderTarget, emit_ffmpeg, lower};
use crate::state::Project;

/// Audio-only export. Produces an `.m4a` (AAC) at `output` containing
/// just the project's audio chain. The PixiJS export Worker emits
/// `video.mp4` via WebCodecs; this fills in `audio.m4a`; `mux_to_file`
/// combines them with `ffmpeg -c copy`.
///
/// `_app` is taken to keep the call-site signature stable with the
/// Tauri command; this routine emits no events of its own — the JS
/// orchestrator drives the ExportPanel state.
pub async fn export_audio_only(
    _app: AppHandle,
    project: &Project,
    output: &Path,
) -> Result<()> {
    if !ffmpeg_is_installed() {
        anyhow::bail!(
            "ffmpeg is not installed. Install via `winget install -e --id Gyan.FFmpeg` (Windows), \
             `brew install ffmpeg` (macOS), or your distro's package."
        );
    }

    let target = RenderTarget::full(
        project.composition.width,
        project.composition.height,
        project.composition.fps,
        project.composition.sample_rate,
        project.composition.channels,
    );
    let graph = lower(project, target).context("lower IR")?;
    let plan = emit_ffmpeg(&graph, None); // window wired in the next task

    if plan.maps.is_empty() {
        // No audio layers — produce nothing. The Pixi mux step
        // tolerates a missing audio file by stream-copy muxing
        // video-only.
        warn!("audio-only export: project has no audio layers; skipping ffmpeg");
        return Ok(());
    }

    let script_path = std::env::temp_dir().join(format!(
        "weftcut-export-{}.txt",
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::write(&script_path, &plan.filter_graph).context("write filter script")?;

    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-y").arg("-hide_banner").arg("-nostats");

    for input in &plan.inputs {
        for arg in input.cli_args() {
            cmd.arg(arg);
        }
    }

    cmd.arg("-filter_complex_script").arg(&script_path);

    for map in &plan.maps {
        cmd.arg("-map").arg(map);
    }
    cmd.args(["-c:a", "aac", "-b:a", "192k"]);

    cmd.arg(output);

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    info!("ffmpeg audio-only export starting → {}", output.display());
    let mut child = cmd.spawn().context("spawn ffmpeg")?;

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

    let status = child.wait().await.context("await ffmpeg")?;
    let stderr_tail = stderr_task.await.unwrap_or_default();

    let _ = std::fs::remove_file(&script_path);

    if !status.success() {
        warn!("ffmpeg exited with {}\nstderr tail:\n{}", status, stderr_tail);
        anyhow::bail!(
            "ffmpeg exited {}. Tail:\n{}",
            status,
            stderr_tail.lines().rev().take(8).collect::<Vec<_>>().join("\n")
        );
    }

    info!("ffmpeg audio-only export complete → {}", output.display());
    Ok(())
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

/// Stream-copy mux of one video file (+ optional audio) into a single
/// MP4. Runs `ffmpeg -y -i video [-i audio] -c copy out`. When
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

/// Tauri event emitted while ffmpeg transcodes the video (ffmpeg-path codecs
/// like HEVC). Payload: an `f64` percent in 0.0..=1.0.
pub const EVENT_TRANSCODE_PROGRESS: &str = "export:transcode_progress";

/// Transcode `video_path` (the WebCodecs H.264 mezzanine) to `encoder` and
/// mux with `audio_path` into `output` (container = output extension). Parses
/// `-progress pipe:1` and emits `EVENT_TRANSCODE_PROGRESS` against `duration_us`.
pub async fn transcode_and_mux(
    app: &AppHandle,
    encoder: &str,
    codec: TargetCodec,
    bitrate: u64,
    cbr: bool,
    duration_us: i64,
    video_path: &Path,
    audio_path: &Path,
    output: &Path,
) -> Result<()> {
    use tauri::Emitter;
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
    for arg in video_encode_args(encoder, bitrate, cbr) {
        cmd.arg(arg);
    }
    // HEVC in MP4/MOV must carry the `hvc1` fourcc; ffmpeg defaults to `hev1`,
    // which Apple/Premiere/WebView2 refuse to play.
    for arg in hvc1_tag_args(codec, output) {
        cmd.arg(arg);
    }
    // Audio is already AAC from export_audio_only → stream-copy it.
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
    let app_for_progress = app.clone();
    let total_us = duration_us.max(1) as f64;
    let progress_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(v) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<f64>() {
                    let pct = (us / total_us).clamp(0.0, 1.0);
                    let _ = app_for_progress.emit(EVENT_TRANSCODE_PROGRESS, pct);
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
    let _ = app.emit(EVENT_TRANSCODE_PROGRESS, 1.0_f64);
    Ok(())
}

/// HEVC in MP4/MOV needs the `hvc1` fourcc tag; ffmpeg defaults to `hev1`
/// which Apple/Premiere/WebView2 won't play. MKV uses no such tag, and other
/// codecs (H.264 `avc1`, AV1 `av01`) already get correct defaults.
fn hvc1_tag_args(codec: TargetCodec, output: &Path) -> Vec<std::ffi::OsString> {
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
/// maxrate/minrate + a 2× bufsize. Software encoders get a speed preset so
/// AV1/HEVC don't take minutes.
fn video_encode_args(encoder: &str, bitrate: u64, cbr: bool) -> Vec<std::ffi::OsString> {
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
    // Speed presets for the slow software encoders only.
    match encoder {
        "libsvtav1" => {
            a.push("-preset".into());
            a.push("8".into());
        }
        "libx265" | "libx264" => {
            a.push("-preset".into());
            a.push("medium".into());
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
    use tempfile::TempDir;

    #[test]
    fn video_encode_args_vbr_software() {
        let argv = video_encode_args("libx265", 8_000_000, false);
        let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx265"));
        assert!(s.windows(2).any(|w| w[0] == "-b:v" && w[1] == "8000000"));
        assert!(!s.iter().any(|a| a == "-minrate"));
    }

    #[test]
    fn video_encode_args_cbr_pins_rate() {
        let argv = video_encode_args("hevc_nvenc", 8_000_000, true);
        let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "hevc_nvenc"));
        assert!(s.windows(2).any(|w| w[0] == "-maxrate" && w[1] == "8000000"));
        assert!(s.windows(2).any(|w| w[0] == "-minrate" && w[1] == "8000000"));
        assert!(s.windows(2).any(|w| w[0] == "-bufsize" && w[1] == "16000000"));
    }

    #[test]
    fn video_encode_args_sets_software_preset() {
        let argv = video_encode_args("libsvtav1", 4_000_000, false);
        let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-preset" && w[1] == "8"));
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

    /// Regression for the no-audio export path: `mux_to_file` must NOT
    /// pass `-i audio_path` to ffmpeg when the audio file doesn't
    /// exist. The previous shape always emitted both `-i`s, so projects
    /// with no audio layers (where `export_audio_only` early-returns
    /// without writing audio.m4a) failed at the mux step with
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
