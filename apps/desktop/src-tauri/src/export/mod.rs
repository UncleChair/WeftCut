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

/// Stream-copy mux of one video file + one audio file into a single
/// MP4. Runs `ffmpeg -y -i video -i audio -c copy out`.
pub async fn mux_to_file(
    video_path: &Path,
    audio_path: &Path,
    output: &Path,
) -> Result<()> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg is not installed");
    }
    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-y")
        .arg("-hide_banner")
        .arg("-nostats")
        .arg("-i")
        .arg(video_path)
        .arg("-i")
        .arg(audio_path)
        .arg("-c")
        .arg("copy")
        .arg(output);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    info!(
        "ffmpeg mux: {} + {} → {}",
        video_path.display(),
        audio_path.display(),
        output.display()
    );
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
