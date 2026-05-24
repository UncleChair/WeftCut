//! Audio-only export + stream-copy mux. The Pixi renderer is the video
//! source; Rust fills in audio.m4a and `ffmpeg -c copy` stitches them.
//!
//! Post P12-d — the legacy full-render ffmpeg-compositor pipeline (presets,
//! HW encoder cache, export queue, progress events, `compile_project`
//! debug view) was deleted with the IR visual half. Only the two paths
//! the Pixi export orchestrator actually invokes survive.

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
    let plan = emit_ffmpeg(&graph);

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

#[cfg(test)]
mod tests {
    use super::mux_args;
    use tempfile::TempDir;

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
