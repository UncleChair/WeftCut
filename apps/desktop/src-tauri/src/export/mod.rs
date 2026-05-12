//! Export pipeline — drive ffmpeg with the IR-compiled plan.
//!
//! Phase 3: presets (H264 1080p, H264 4K, ProRes, GIF), hardware encoder
//! detection with software fallback, in-memory render queue (serial FIFO).
//! Progress comes from `ffmpeg -progress pipe:1 -nostats` — clean key=value
//! lines vs the noisy default stderr text. Each `progress=continue|end`
//! line ends one block; we emit one `export:progress` Tauri event per block.

mod hwencoder;
mod preset;
mod queue;

pub use hwencoder::{HwEncoderCache, HwEncoderProbe, probe_hw_encoders};
pub use preset::ExportPreset;
pub use queue::{ExportQueue, ExportQueueItem};

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::{info, warn};

use crate::ir::{RenderTarget, emit_ffmpeg, lower, materialize_inline_subtitles};
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
    preset: ExportPreset,
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
    // Materialize inline subtitle bodies before lowering. The cache lives in
    // app-managed state; if the export path is invoked from a context that
    // didn't manage it (some tests do this), fall back to a tempdir-rooted
    // layout so the materialization step doesn't hard-fail on absence.
    let inline_subs = {
        let cache = app
            .try_state::<crate::cache::CacheLayout>()
            .map(|s| s.inner().clone())
            .unwrap_or_else(|| {
                let fallback = std::env::temp_dir().join("videtor-export-cache");
                let layout = crate::cache::CacheLayout::new(fallback);
                let _ = layout.ensure_dirs();
                layout
            });
        materialize_inline_subtitles(project, &cache).context("materialize inline subtitles")?
    };
    let graph = lower(project, target, &inline_subs).context("lower IR")?;
    let plan = emit_ffmpeg(&graph);

    let total_us = project.composition.duration_us.max(1_000_000);

    // Write the filter graph to a temp file — long graphs can blow argv limits.
    let script_path = std::env::temp_dir().join(format!(
        "videtor-export-{}.txt",
        uuid::Uuid::now_v7().simple()
    ));
    let mut graph_body = plan.filter_graph.clone();
    if let Some(suffix) = preset.filter_graph_suffix() {
        // Make sure we re-use the [vfinal] label by appending a suffix that
        // splits/palettes the existing terminal stream. Trim trailing
        // newlines so the join is clean.
        while graph_body.ends_with('\n') {
            graph_body.pop();
        }
        graph_body.push_str(suffix);
    }
    std::fs::write(&script_path, &graph_body).context("write filter script")?;

    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-y") // overwrite
        .arg("-hide_banner")
        .arg("-nostats");

    for input in &plan.inputs {
        for arg in input.cli_args() {
            cmd.arg(arg);
        }
    }

    cmd.arg("-filter_complex_script").arg(&script_path);

    // Preset may override the final video label (e.g. GIF emits [vgif]).
    let final_v_label = preset.final_video_label();
    cmd.arg("-map").arg(final_v_label);
    if preset.has_audio() {
        for map in &plan.maps {
            // Skip the video map — we already added the (possibly-renamed)
            // version above.
            if map.starts_with("[v") {
                continue;
            }
            cmd.arg("-map").arg(map);
        }
    }

    // HW encoder selection. We resolve through the AppHandle-managed cache
    // when available (probed once at startup) and fall back to a fresh probe
    // only if the cache isn't installed (e.g. tests calling run_render
    // directly without going through the Tauri setup hook). Per-export probes
    // would otherwise add up to several seconds on hosts where some
    // candidates time out.
    let hw = match app.try_state::<HwEncoderCache>() {
        Some(c) => c.get().await,
        None => probe_hw_encoders().await.recommended,
    };
    preset.apply_to_command(&mut cmd, hw);

    // -progress pipe:1 → clean key=value blocks on stdout, one per ~0.5s.
    cmd.args(["-progress", "pipe:1"]);

    cmd.arg(output);

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    info!(
        "ffmpeg export starting → {} (preset={:?}, hw={:?})",
        output.display(),
        preset,
        hw
    );
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
    export_with_preset_logged(app, project, output, ExportPreset::default()).await
}

pub async fn export_with_preset_logged(
    app: AppHandle,
    project: &Project,
    output: PathBuf,
    preset: ExportPreset,
) {
    if let Err(e) = run_render(app.clone(), project, &output, preset).await {
        let msg = format!("{e:#}");
        warn!("export failed: {msg}");
        let _ = app.emit(EVENT_ERROR, &msg);
    }
}
