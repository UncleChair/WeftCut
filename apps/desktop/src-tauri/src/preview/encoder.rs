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

use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path};
use crate::export::{HwEncoder, HwEncoderCache};
use crate::ir::{
    emit_ffmpeg, lower, lower_range, InlineSubPaths, RenderTarget, TemplateRenders,
};
use crate::state::Project;

use super::codec::CodecProfile;
use super::queue::CancelHandle;

/// Render `[in_us, out_us]` of `project` to a self-contained fMP4 file at
/// `dest`. Returns immediately on cache hit (`cached_ok`). Atomic via
/// `.tmp` + rename — partial writes never leave broken bytes at `dest`.
///
/// Audio is dropped: segments are video-only by design.
/// Proxies are substituted (per-clip 540p H.264) when available, mirroring
/// the whole-timeline preview path's load-bearing optimization.
///
/// **Cancellation**: when `cancel.cancel()` fires mid-encode, the ffmpeg
/// child is dropped (kill_on_drop terminates the process). The partial
/// `.tmp` file is cleaned up; `dest` remains untouched. Caller treats the
/// returned error as "cancelled, don't emit a `segment_error` event" by
/// checking `cancel.is_cancelled()` after the call.
/// `prefer_sw=true` skips the HW encoder probe and forces libx264. Used
/// by the orchestrator's auto-retry on `HwEncoderRejected` failures.
/// `profile` picks codec + container (H.264 fMP4 on Win/Mac, VP9 WebM
/// on Linux).
pub async fn render_segment(
    app: &AppHandle,
    project: &Project,
    inline_subs: &InlineSubPaths,
    template_renders: &TemplateRenders,
    in_us: i64,
    out_us: i64,
    dest: &Path,
    cancel: &CancelHandle,
    prefer_sw: bool,
    profile: CodecProfile,
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
        inline_subs,
        template_renders,
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

    match profile {
        CodecProfile::H264Mp4 => {
            // Pick HW encoder if probed and not forced to SW.
            let hw = if prefer_sw {
                None
            } else {
                match app.try_state::<HwEncoderCache>() {
                    Some(c) => c.get().await,
                    None => None,
                }
            };
            apply_h264_segment_encoder(&mut cmd, hw);
            cmd.args(["-force_key_frames", "expr:eq(n,0)", "-sc_threshold", "0"]);
            // fMP4 fragmented mux for MSE.
            cmd.args([
                "-movflags",
                "+frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
            ]);
        }
        CodecProfile::Vp9Webm => {
            // libvpx-vp9 software encode — VAAPI exists but is brittle
            // across distros + needs `-vaapi_device` setup we don't yet
            // thread. Realtime deadline matches "preview speed" tuning.
            cmd.args([
                "-c:v", "libvpx-vp9",
                "-b:v", "0",
                "-crf", "35",
                "-deadline", "realtime",
                "-cpu-used", "5",
                "-row-mt", "1",
                "-tile-columns", "4",
                "-frame-parallel", "1",
                "-force_key_frames", "expr:eq(n,0)",
            ]);
            // WebM cluster-based segmentation — MSE consumes natively.
            cmd.args(["-f", "webm"]);
        }
    }
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
    let child = cmd.spawn().context("spawn ffmpeg")?;
    // Race the ffmpeg run against cancellation. `wait_with_output(self)`
    // consumes the Child into its future; dropping that future drops the
    // Child, and `kill_on_drop(true)` set above terminates the process.
    // The cancel arm cannot reference `child` directly — the wait arm
    // already moved it.
    let output = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            // wait_with_output future gets dropped here on select's
            // ordinary cleanup → Child drops → kill_on_drop fires.
            let _ = std::fs::remove_file(&script_path);
            let _ = std::fs::remove_file(&tmp);
            anyhow::bail!("segment render cancelled");
        }
        result = child.wait_with_output() => {
            result.context("wait ffmpeg")?
        }
    };
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
    _app: &AppHandle,
    project: &Project,
    inline_subs: &InlineSubPaths,
    template_renders: &TemplateRenders,
    dest: &Path,
    cancel: &CancelHandle,
    profile: CodecProfile,
) -> Result<()> {
    if cached_ok(dest) {
        return Ok(());
    }
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg is not installed.");
    }

    let project_for_render = super::with_proxies_substituted(project);

    let target = RenderTarget::full(
        project.composition.width,
        project.composition.height,
        project.composition.fps,
        project.composition.sample_rate,
        project.composition.channels,
    );
    let graph = lower(&project_for_render, target, inline_subs, template_renders)
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
    match profile {
        CodecProfile::H264Mp4 => {
            cmd.args([
                "-c:a", "aac",
                "-b:a", "192k",
                "-profile:a", "aac_low",
                "-movflags", "+faststart",
                "-f", "mp4",
            ]);
        }
        CodecProfile::Vp9Webm => {
            cmd.args([
                "-c:a", "libopus",
                "-b:a", "128k",
                "-f", "webm",
            ]);
        }
    }
    cmd.arg(&tmp);

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    info!("preview audio render → {}", dest.display());
    let child = cmd.spawn().context("spawn ffmpeg")?;
    let output = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            // wait_with_output future drops on select cleanup → Child
            // drops → kill_on_drop terminates ffmpeg.
            let _ = std::fs::remove_file(&script_path);
            let _ = std::fs::remove_file(&tmp);
            anyhow::bail!("audio render cancelled");
        }
        result = child.wait_with_output() => {
            result.context("wait ffmpeg")?
        }
    };
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

/// Append H.264 encoder flags tuned for preview segments. Uses the host's
/// detected HW encoder when probed; falls back to libx264 ultrafast
/// otherwise. Profile/level pinned to High@L4.0 so the produced bytes
/// match the manifest's `avc1.640028` codec string regardless of which
/// concrete encoder ran. MSE silently rejects appendBuffer() on codec
/// mismatch — decision M1 in `docs/preview-segmented-cache.md`.
///
/// Preview tunings differ from `export/preset.rs::apply_h264`:
/// 1. Quality tilted toward speed (CQ ~25, ultrafast preset). Preview
///    bitrate doesn't matter — local file, plays once.
/// 2. NVENC `-preset p1` (fastest) vs export's `p5` (balanced).
/// 3. NO `-pix_fmt yuv420p` here — already applied via the IR's
///    `format=yuv420p` clause baked into emit_ffmpeg's terminal node.
fn apply_h264_segment_encoder(cmd: &mut Command, hw: Option<HwEncoder>) {
    match hw {
        Some(HwEncoder::Nvenc) => {
            cmd.args([
                "-c:v", "h264_nvenc",
                "-preset", "p1",
                "-tune", "ll",
                "-cq", "25",
                "-profile:v", "high",
                "-level:v", "4.0",
            ]);
        }
        Some(HwEncoder::Qsv) => {
            cmd.args([
                "-c:v", "h264_qsv",
                "-preset", "veryfast",
                "-global_quality", "25",
                "-profile:v", "high",
                "-level:v", "4.0",
            ]);
        }
        Some(HwEncoder::Amf) => {
            cmd.args([
                "-c:v", "h264_amf",
                "-quality", "speed",
                "-rc", "cqp",
                "-qp_i", "25",
                "-qp_p", "25",
                "-profile:v", "high",
                "-level:v", "4.0",
            ]);
        }
        Some(HwEncoder::VideoToolbox) => {
            cmd.args([
                "-c:v", "h264_videotoolbox",
                "-realtime", "1",
                "-q:v", "55",
                "-profile:v", "high",
                "-level:v", "4.0",
            ]);
        }
        Some(HwEncoder::Vaapi) => {
            // VAAPI requires `-vaapi_device` setup we'd thread separately
            // — keep on libx264 for A3; revisit when Linux HW path is
            // exercised in A6.
            cmd.args([
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "25",
                "-profile:v", "high",
                "-level:v", "4.0",
            ]);
        }
        None => {
            cmd.args([
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "25",
                "-profile:v", "high",
                "-level:v", "4.0",
            ]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Command;

    fn cmd_args(hw: Option<HwEncoder>) -> Vec<String> {
        let mut c = Command::new("dummy");
        apply_h264_segment_encoder(&mut c, hw);
        c.as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn libx264_fallback_pins_profile_level() {
        let args = cmd_args(None);
        assert!(args.contains(&"libx264".to_string()));
        // The High@L4.0 pin must survive on every code path or the
        // manifest's `avc1.640028` codec string will mismatch the bytes.
        let joined = args.join(" ");
        assert!(joined.contains("-profile:v high"), "args={joined}");
        assert!(joined.contains("-level:v 4.0"), "args={joined}");
    }

    #[test]
    fn each_hw_encoder_pins_profile_level() {
        for hw in [
            HwEncoder::Nvenc,
            HwEncoder::Qsv,
            HwEncoder::Amf,
            HwEncoder::VideoToolbox,
            HwEncoder::Vaapi,
        ] {
            let args = cmd_args(Some(hw));
            let joined = args.join(" ");
            assert!(
                joined.contains("-profile:v high"),
                "{hw:?}: profile missing from {joined}",
            );
            assert!(
                joined.contains("-level:v 4.0"),
                "{hw:?}: level missing from {joined}",
            );
        }
    }
}
