//! Per-segment fMP4 encoder + whole-timeline audio encoder (Phase A2).
//!
//! `render_segment` produces a single fMP4 file at `<dest>` containing one
//! segment's worth of timeline. The output is self-contained (ftyp + moov
//! + moof + mdat in one file); A4's MSE driver will extract the init box
//! client-side via mp4box.js so the same bytes hit the SourceBuffer.
//!
//! Software H.264 encoder for A2 baseline — A3 wires in the existing
//! HwEncoderCache for hardware acceleration. At proxy resolution (540p),
//! software ultrafast hits ~20–40× realtime which is good enough to ship.
//!
//! `render_audio` produces the whole-timeline AAC m4a. Audio is NOT
//! segmented — see decision S4 in `docs/preview-segmented-cache.md`.

use std::path::Path;
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tauri::{AppHandle, Manager};
use tokio::process::Command;
use tracing::{info, warn};

use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path, CacheLayout};
use crate::ir::{
    emit_ffmpeg, lower, lower_range, materialize_inline_subtitles, RenderTarget,
};
use crate::state::Project;

/// Render `[in_us, out_us]` of `project` to a self-contained fMP4 file at
/// `dest`. Returns immediately on cache hit (`cached_ok`). Atomic via
/// `.tmp` + rename — partial writes never leave broken bytes at `dest`.
///
/// Audio is dropped: segments are video-only by design.
/// Proxies are substituted (per-clip 540p H.264) when available, mirroring
/// the whole-timeline preview path's load-bearing optimization.
pub async fn render_segment(
    app: &AppHandle,
    project: &Project,
    in_us: i64,
    out_us: i64,
    dest: &Path,
) -> Result<()> {
    if cached_ok(dest) {
        return Ok(());
    }
    if !ffmpeg_is_installed() {
        anyhow::bail!(
            "ffmpeg is not installed. Install via `winget install -e --id Gyan.FFmpeg` \
             (Windows), `brew install ffmpeg` (macOS), or your distro's package."
        );
    }

    let cache = app
        .try_state::<CacheLayout>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| anyhow::anyhow!("CacheLayout not managed by app"))?;

    // Materialize side-maps — same shape as the whole-timeline preview.
    let inline_subs = materialize_inline_subtitles(project, &cache)
        .context("materialize inline subtitles")?;
    let template_renders = crate::ir::materialize_templates(project, &cache, app)
        .await
        .context("materialize templates")?;

    // Proxy substitution makes the encode cheap on 4K sources.
    let project_for_render = super::with_proxies_substituted(project);

    let target = RenderTarget::full(
        project.composition.width,
        project.composition.height,
        project.composition.fps,
        project.composition.sample_rate,
        project.composition.channels,
    );
    let graph = lower_range(
        &project_for_render,
        target,
        &inline_subs,
        &template_renders,
        in_us,
        out_us,
    )
    .context("lower_range")?;
    let plan = emit_ffmpeg(&graph);

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create {}", parent.display()))?;
    }

    let tmp = temp_path(dest);
    discard_temp(dest); // clean any stale tmp from a prior crash

    // Long lavfi graphs blow argv limits; write to a temp script file.
    let script_path = std::env::temp_dir().join(format!(
        "weftcut-segment-{}.txt",
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::write(&script_path, &plan.filter_graph).context("write filter script")?;

    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-y")
        .arg("-hide_banner")
        .arg("-nostats")
        .arg("-loglevel")
        .arg("error");
    for input in &plan.inputs {
        for arg in input.cli_args() {
            cmd.arg(arg);
        }
    }
    cmd.arg("-filter_complex_script").arg(&script_path);
    // Video-only mapping. The IR's audio side is empty for segments
    // (rebase drops Audio tracks) so there's nothing to map for audio.
    cmd.arg("-map").arg("[vfinal]");

    // H.264 High Profile @ L4.0 — matches the manifest's `avc1.640028`
    // codec string. The MSE driver pins on this exactly; a mismatch
    // silently rejects appendBuffer() bytes (decision M1).
    cmd.args([
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-profile:v", "high",
        "-level:v", "4.0",
        "-pix_fmt", "yuv420p",
    ]);
    // Force IDR at segment start so the segment is independently decodable.
    // Disabling scene-change detection keeps GOP boundaries from drifting
    // mid-segment.
    cmd.args([
        "-force_key_frames",
        "expr:eq(n,0)",
        "-sc_threshold",
        "0",
    ]);
    // fMP4 mux flags. `empty_moov` puts an empty moov at the start (codec
    // params, no movie data); subsequent boxes are moof+mdat fragments.
    // `default_base_moof` lets the moof carry absolute offsets so each
    // fragment is positionally self-describing — required for MSE
    // appendBuffer() across out-of-order arrivals.
    cmd.args([
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
    ]);
    cmd.arg(&tmp);

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    info!(
        "preview segment render → {} ({}us..{}us)",
        dest.display(),
        in_us,
        out_us
    );
    let output = cmd.output().await.context("spawn ffmpeg")?;
    let _ = std::fs::remove_file(&script_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&tmp);
        anyhow::bail!(
            "ffmpeg segment render failed:\n--- graph ---\n{}\n--- stderr ---\n{}",
            plan.filter_graph,
            stderr
        );
    }

    promote_temp(dest).context("promote segment temp")?;
    Ok(())
}

/// Render the project's whole-timeline audio to `<dest>` as AAC m4a. The
/// preview audio is intentionally NOT segmented — see decision S4.
///
/// Uses the existing whole-timeline `lower()` (which produces both video
/// and audio outputs) and asks ffmpeg to map only `[aout]`. If the project
/// has no audio tracks, returns Ok without producing a file — the
/// orchestrator treats a missing audio file as "no audio in this
/// composition" (the React side already handles the no-audio case).
pub async fn render_audio(
    app: &AppHandle,
    project: &Project,
    dest: &Path,
) -> Result<()> {
    if cached_ok(dest) {
        return Ok(());
    }
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg is not installed.");
    }

    let cache = app
        .try_state::<CacheLayout>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| anyhow::anyhow!("CacheLayout not managed by app"))?;

    let inline_subs = materialize_inline_subtitles(project, &cache)
        .context("materialize inline subtitles")?;
    let template_renders = crate::ir::materialize_templates(project, &cache, app)
        .await
        .context("materialize templates")?;
    let project_for_render = super::with_proxies_substituted(project);

    let target = RenderTarget::full(
        project.composition.width,
        project.composition.height,
        project.composition.fps,
        project.composition.sample_rate,
        project.composition.channels,
    );
    let graph = lower(&project_for_render, target, &inline_subs, &template_renders)
        .context("lower")?;

    // No audio in the project → skip cleanly.
    if graph.audio_out.is_none() {
        warn!("render_audio: project has no audio_out — skipping");
        return Ok(());
    }
    let plan = emit_ffmpeg(&graph);

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create {}", parent.display()))?;
    }
    let tmp = temp_path(dest);
    discard_temp(dest);

    let script_path = std::env::temp_dir().join(format!(
        "weftcut-audio-{}.txt",
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::write(&script_path, &plan.filter_graph).context("write audio script")?;

    let mut cmd = Command::new(ffmpeg_path());
    cmd.arg("-y")
        .arg("-hide_banner")
        .arg("-nostats")
        .arg("-loglevel")
        .arg("error");
    for input in &plan.inputs {
        for arg in input.cli_args() {
            cmd.arg(arg);
        }
    }
    cmd.arg("-filter_complex_script").arg(&script_path);
    // Audio-only mapping.
    cmd.arg("-map").arg("[aout]");
    // AAC-LC matches the manifest's `mp4a.40.2` codec string.
    cmd.args([
        "-c:a", "aac",
        "-b:a", "192k",
        "-profile:a", "aac_low",
        "-movflags", "+faststart",
        "-f", "mp4",
    ]);
    cmd.arg(&tmp);

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    info!("preview audio render → {}", dest.display());
    let output = cmd.output().await.context("spawn ffmpeg")?;
    let _ = std::fs::remove_file(&script_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&tmp);
        anyhow::bail!(
            "ffmpeg audio render failed:\n--- graph ---\n{}\n--- stderr ---\n{}",
            plan.filter_graph,
            stderr
        );
    }

    promote_temp(dest).context("promote audio temp")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    // The encoder is hard to unit-test in isolation because it depends on
    // an `AppHandle` (for CacheLayout) and a real ffmpeg binary. The
    // load-bearing smoke test is run by the orchestrator's integration
    // path in `preview/segmented.rs` (A2.g), which spins up a test
    // CacheLayout and verifies the produced files. We keep that test
    // there rather than duplicating the AppHandle scaffolding here.
}
