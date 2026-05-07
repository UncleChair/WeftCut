//! Export pipeline — drive ffmpeg with the IR-compiled plan.
//!
//! Phase 1.12 MVP: one preset (H.264/AAC MP4), one render at a time, progress
//! reported via Tauri events. Hardware encoder detection, render queues,
//! ProRes/GIF presets are Phase 3 work per the original roadmap numbering.
//!
//! Progress comes from `ffmpeg -progress pipe:1 -nostats` which emits clean
//! key=value lines (vs. the noisy default stderr `frame=...` text). Each
//! `progress=continue|end` line ends one block; we accumulate the keys and
//! emit one `export:progress` Tauri event per block.

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

    let total_us = project.composition.duration_us.max(1_000_000);

    // Write the filter graph to a temp file — long graphs can blow argv limits.
    let script_path = std::env::temp_dir().join(format!(
        "videtor-export-{}.txt",
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::write(&script_path, &plan.filter_graph).context("write filter script")?;

    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-y") // overwrite
        .arg("-hide_banner")
        .arg("-nostats");

    for input in &plan.inputs {
        cmd.arg("-i").arg(input);
    }

    cmd.arg("-filter_complex_script").arg(&script_path);

    for map in &plan.maps {
        cmd.arg("-map").arg(map);
    }

    // MVP encoder preset: software H.264 + AAC. Hardware-encoder probing comes
    // in the Phase 3 hwaccel rewrite.
    cmd.args(["-c:v", "libx264", "-preset", "medium", "-crf", "20"]);
    cmd.args(["-pix_fmt", "yuv420p"]);
    cmd.args(["-c:a", "aac", "-b:a", "192k"]);

    // -progress pipe:1 → clean key=value blocks on stdout, one per ~0.5s.
    cmd.args(["-progress", "pipe:1"]);

    cmd.arg(output);

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    info!("ffmpeg export starting → {}", output.display());
    let mut child = cmd.spawn().context("spawn ffmpeg")?;

    let stdout = child.stdout.take().context("take ffmpeg stdout")?;
    let stderr = child.stderr.take().context("take ffmpeg stderr")?;

    // Stream the cleaner -progress key=value lines.
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
                        // Despite the name `out_time_ms` is microseconds in
                        // most ffmpeg builds; trust whichever lands first.
                        if let Ok(us) = value.parse::<i64>() {
                            snapshot.current_time_us = us;
                        }
                    }
                    "speed" => {
                        // "1.02x" → 1.02
                        let trimmed = value.trim_end_matches('x');
                        if let Ok(s) = trimmed.parse::<f64>() {
                            snapshot.speed = s;
                        }
                    }
                    "progress" => {
                        snapshot.progress =
                            ((snapshot.current_time_us as f64) / (total_us as f64)).clamp(0.0, 1.0);
                        let _ = app_progress.emit(EVENT_PROGRESS, snapshot.clone());
                    }
                    _ => {}
                }
            }
        }
    });

    // Drain stderr just to keep the pipe from filling. Keep last few lines so
    // we can surface them on failure.
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
    let _ = app.emit(
        EVENT_COMPLETE,
        ExportComplete {
            output_path: output.to_string_lossy().to_string(),
            duration_us: total_us,
        },
    );

    Ok(())
}

/// Convenience wrapper that swallows path conversion + emits an error event on
/// failure so the UI can show a toast even when the awaiting handle isn't.
pub async fn export_to_mp4_logged(app: AppHandle, project: &Project, output: PathBuf) {
    if let Err(e) = export_to_mp4(app.clone(), project, &output).await {
        let msg = format!("{e:#}");
        warn!("export failed: {msg}");
        let _ = app.emit(EVENT_ERROR, &msg);
    }
}
