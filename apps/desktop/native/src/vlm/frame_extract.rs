//! Sample still frames from a source video for the video-understanding sidecar.
//!
//! The input contract is a set of *timed frames*, not a video file (see
//! [`super::describer`]). We own the sampling so the timestamps become a quantity
//! WE define (the whole premise of the ticket 06 design): given a source window
//! `[in_us, out_us]` and a sampling `fps`, we midpoint-sample N frames, extract
//! each as a downscaled PNG, and return them tagged with their **window-relative**
//! timestamp.
//!
//! One ffmpeg child per frame, under `jobs::ffmpeg_sem()`. Frames land in a
//! caller-owned temp dir (RAII-cleaned once the sidecar has read them), not the
//! persistent cache — the *description* is what we cache, not the frames.

use std::path::Path;
use std::process::Stdio;

use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::process::NoConsoleWindow;

use super::describer::TimedFrame;
use super::error::VlmError;

/// Longest side of an extracted frame, in pixels: enough detail for
/// description, small enough to fit the KV budget [`MAX_FRAMES`] documents.
const MAX_SIDE: u32 = 768;

/// Hard cap on frames per clip. The context is capped at 8192 tokens (KV-cache
/// OOM guard, ticket 06), which comfortably holds ~8–16 downscaled frames plus
/// generation; beyond that we'd overflow. A longer clip samples coarser rather
/// than spawning an OOM.
pub const MAX_FRAMES: usize = 16;

/// Plan the sampling anchors for `[in_us, out_us]` at `fps`: midpoint sampling
/// (no exact-boundary frames), N = round(duration_s * fps) clamped to
/// `[1, MAX_FRAMES]`. Returns window-relative anchor times in µs. Pure so the
/// sampling contract is unit-testable without ffmpeg.
pub fn plan_anchors(in_us: i64, out_us: i64, fps: f64) -> Vec<i64> {
    let range_us = (out_us - in_us).max(0);
    if range_us == 0 {
        return vec![0];
    }
    let range_s = range_us as f64 / 1_000_000.0;
    let n = ((range_s * fps).round() as i64).clamp(1, MAX_FRAMES as i64) as usize;
    (0..n)
        .map(|i| {
            // Midpoint of the i-th of n equal sub-spans, window-relative.
            let frac = (i as f64 + 0.5) / n as f64;
            (frac * range_us as f64).round() as i64
        })
        .collect()
}

/// Extract one downscaled PNG per planned anchor into `out_dir`, returning the
/// [`TimedFrame`]s (window-relative time + path). `source_in_us` is where the
/// window starts in the SOURCE; anchors are window-relative, so the absolute
/// seek time is `source_in_us + anchor`.
pub async fn sample_frames(
    source: &Path,
    source_in_us: i64,
    out_dir: &Path,
    anchors: &[i64],
) -> Result<Vec<TimedFrame>, VlmError> {
    if !ffmpeg_is_installed() {
        return Err(VlmError::FrameExtract(
            "ffmpeg not installed; cannot sample frames for description".into(),
        ));
    }
    tokio::fs::create_dir_all(out_dir).await.map_err(VlmError::Io)?;

    let mut frames = Vec::with_capacity(anchors.len());
    for (i, &anchor_us) in anchors.iter().enumerate() {
        let abs_us = (source_in_us + anchor_us).max(0);
        let abs_s = abs_us as f64 / 1_000_000.0;
        let path = out_dir.join(format!("f{i:02}.png"));

        let _permit = crate::jobs::ffmpeg_sem()
            .acquire()
            .await
            .map_err(|e| VlmError::FrameExtract(format!("acquire ffmpeg slot: {e}")))?;

        // -ss BEFORE -i = fast keyframe seek (matches spike.mjs + jobs/frame.rs);
        // description is robust to thumbnail-grade seek accuracy.
        let output = Command::new(ffmpeg_path())
            .no_console_window()
            .kill_on_drop(true)
            .args([
                "-nostdin",
                "-hide_banner",
                "-nostats",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                &format!("{abs_s:.3}"),
                "-i",
            ])
            .arg(source)
            .args([
                "-frames:v",
                "1",
                "-vf",
                &format!("scale='min({MAX_SIDE},iw)':-2"),
                "-q:v",
                "2",
                "-update",
                "1",
                "-f",
                "image2",
            ])
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| VlmError::FrameExtract(format!("spawn ffmpeg for frame @{abs_s}s: {e}")))?;

        if !output.status.success() || !crate::cache::cached_ok(&path) {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(VlmError::FrameExtract(format!(
                "ffmpeg frame extract @{abs_s}s failed ({}): {}",
                output.status,
                stderr.trim()
            )));
        }
        frames.push(TimedFrame {
            t_us: anchor_us,
            path,
        });
    }
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_anchors_midpoint_samples_at_fps() {
        // 4 s window at 1 fps → 4 frames, midpoints at 0.5/1.5/2.5/3.5 s.
        let a = plan_anchors(0, 4_000_000, 1.0);
        assert_eq!(a, vec![500_000, 1_500_000, 2_500_000, 3_500_000]);
    }

    #[test]
    fn plan_anchors_clamps_to_at_least_one_and_max_frames() {
        // Sub-frame window still yields one anchor.
        assert_eq!(plan_anchors(0, 100_000, 1.0).len(), 1);
        // Very long window at high fps clamps to MAX_FRAMES.
        assert_eq!(plan_anchors(0, 600_000_000, 5.0).len(), MAX_FRAMES);
        // Zero-duration window → a single anchor at 0.
        assert_eq!(plan_anchors(5_000_000, 5_000_000, 1.0), vec![0]);
    }

    #[test]
    fn plan_anchors_are_window_relative() {
        // Anchors do not include the source offset — they are 0-based.
        let a = plan_anchors(10_000_000, 12_000_000, 1.0);
        assert!(a.iter().all(|&t| t >= 0 && t <= 2_000_000));
    }
}
