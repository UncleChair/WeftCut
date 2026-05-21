//! Export pipeline — drive ffmpeg with the IR-compiled plan.
//!
//! Audio-only post P12-b — the IR visual half was deleted with the
//! Pixi-renderer migration. The full-render path (`run_render` /
//! `export_to_mp4` / `export_with_preset_logged`) now produces an
//! audio-only file too; the legacy `ExportPanel` wrappers + the
//! ffmpeg-export queue + their TS callers should be deleted in
//! P12-c. The path that's actually correct today is
//! `export_audio_only → mux_to_file` driven from the Pixi export
//! orchestrator.

mod hwencoder;
mod preset;
mod queue;

pub use hwencoder::{HwEncoder, HwEncoderCache, HwEncoderProbe, probe_hw_encoders};
pub use preset::ExportPreset;
pub use queue::{ExportQueue, ExportQueueItem};

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::{info, warn};

use crate::ir::{RenderTarget, emit_ffmpeg, lower};
use crate::state::Project;

pub const EVENT_PROGRESS: &str = "export:progress";
pub const EVENT_COMPLETE: &str = "export:complete";
pub const EVENT_ERROR: &str = "export:error";
pub const EVENT_QUEUE: &str = "export:queue";

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    /// 0.0 .. 1.0; clamped.
    pub progress: f64,
    pub current_time_us: i64,
    pub frame: u64,
    pub fps: f64,
    pub speed: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportComplete {
    pub output_path: String,
    pub duration_us: i64,
}

pub async fn export_to_mp4(app: AppHandle, project: &Project, output: &Path) -> Result<()> {
    run_render(app, project, output, ExportPreset::default()).await
}

pub async fn run_render(
    app: AppHandle,
    project: &Project,
    output: &Path,
    _preset: ExportPreset,
) -> Result<()> {
    run_render_inner(app, project, output, true).await
}

/// Silent variant — no `export:*` events. Same audio-only emit as
/// `run_render`.
pub async fn run_render_silent(
    app: AppHandle,
    project: &Project,
    output: &Path,
    _preset: ExportPreset,
) -> Result<()> {
    run_render_inner(app, project, output, false).await
}

/// Audio-only export. Produces an `.m4a` (AAC) at `output` containing
/// just the project's audio chain. Used by the PixiJS export path:
/// the Worker emits video.mp4 via WebCodecs; this fills in audio.m4a;
/// `mux_to_file` combines them with `ffmpeg -c copy`.
pub async fn export_audio_only(
    app: AppHandle,
    project: &Project,
    output: &Path,
) -> Result<()> {
    run_render_inner(app, project, output, false).await
}

async fn run_render_inner(
    app: AppHandle,
    project: &Project,
    output: &Path,
    emit_events: bool,
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
        // Audio-only export with no audio layers: produce nothing. The
        // Pixi mux step tolerates a missing audio file by stream-copy
        // muxing video-only.
        warn!("audio-only export: project has no audio layers; skipping ffmpeg");
        if emit_events {
            let _ = app.emit(
                EVENT_COMPLETE,
                ExportComplete {
                    output_path: output.to_string_lossy().to_string(),
                    duration_us: project.composition.duration_us.max(1_000_000),
                },
            );
        }
        return Ok(());
    }

    let total_us = project.composition.duration_us.max(1_000_000);

    let script_path = std::env::temp_dir().join(format!(
        "weftcut-export-{}.txt",
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::write(&script_path, &plan.filter_graph).context("write filter script")?;

    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-y")
        .arg("-hide_banner")
        .arg("-nostats");

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

    cmd.args(["-progress", "pipe:1"]);

    cmd.arg(output);

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    info!("ffmpeg audio-only export starting → {}", output.display());
    let mut child = cmd.spawn().context("spawn ffmpeg")?;

    let stdout = child.stdout.take().context("take ffmpeg stdout")?;
    let stderr = child.stderr.take().context("take ffmpeg stderr")?;

    let app_progress = app.clone();
    let progress_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut snapshot = ExportProgress::default();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim();
                match key {
                    "frame" => {
                        if let Ok(n) = value.parse::<u64>() {
                            snapshot.frame = n;
                        }
                    }
                    "fps" => {
                        if let Ok(f) = value.parse::<f64>() {
                            snapshot.fps = f;
                        }
                    }
                    "out_time_us" | "out_time_ms" => {
                        if let Ok(us) = value.parse::<i64>() {
                            snapshot.current_time_us = us;
                        }
                    }
                    "speed" => {
                        let trimmed = value.trim_end_matches('x');
                        if let Ok(s) = trimmed.parse::<f64>() {
                            snapshot.speed = s;
                        }
                    }
                    "progress" => {
                        snapshot.progress =
                            ((snapshot.current_time_us as f64) / (total_us as f64)).clamp(0.0, 1.0);
                        if emit_events {
                            let _ = app_progress.emit(EVENT_PROGRESS, snapshot.clone());
                        }
                    }
                    _ => {}
                }
            }
        }
    });

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
    let _ = progress_task.await;
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

    info!("ffmpeg export complete → {}", output.display());
    if emit_events {
        let _ = app.emit(
            EVENT_COMPLETE,
            ExportComplete {
                output_path: output.to_string_lossy().to_string(),
                duration_us: total_us,
            },
        );
    }

    Ok(())
}

/// Stream-copy mux of one video file + one audio file into a single
/// MP4. Runs `ffmpeg -y -i video -i audio -c copy out`. Used by the
/// PixiJS export path to combine the Worker's video.mp4 with the
/// audio-only Rust export.
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

pub async fn export_to_mp4_logged(app: AppHandle, project: &Project, output: PathBuf) {
    export_with_preset_logged(app, project, output, ExportPreset::default()).await
}

pub async fn export_with_preset_logged(
    app: AppHandle,
    project: &Project,
    output: PathBuf,
    preset: ExportPreset,
) {
    let log_op_id = uuid::Uuid::now_v7();
    crate::logs::emit_via_app(
        &app,
        crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Info,
            category: crate::logs::LogCategory::Export,
            source: crate::logs::LogSource::User,
            message: format!("Export started: {}", output.display()),
            op_id: Some(log_op_id),
            op_state: Some(crate::logs::OpState::Started),
            details: Some(serde_json::json!({
                "output": output.to_string_lossy(),
                "preset": format!("{preset:?}"),
            })),
            ..Default::default()
        },
    );
    match run_render(app.clone(), project, &output, preset).await {
        Ok(()) => {
            crate::logs::emit_via_app(
                &app,
                crate::logs::LogEntryInput {
                    level: crate::logs::LogLevel::Info,
                    category: crate::logs::LogCategory::Export,
                    source: crate::logs::LogSource::User,
                    message: format!("Export complete: {}", output.display()),
                    op_id: Some(log_op_id),
                    op_state: Some(crate::logs::OpState::Ok),
                    ..Default::default()
                },
            );
        }
        Err(e) => {
            let msg = format!("{e:#}");
            warn!("export failed: {msg}");
            let _ = app.emit(EVENT_ERROR, &msg);
            crate::logs::emit_via_app(
                &app,
                crate::logs::LogEntryInput {
                    level: crate::logs::LogLevel::Error,
                    category: crate::logs::LogCategory::Export,
                    source: crate::logs::LogSource::User,
                    message: format!("Export failed: {msg}"),
                    op_id: Some(log_op_id),
                    op_state: Some(crate::logs::OpState::Err),
                    ..Default::default()
                },
            );
        }
    }
}
