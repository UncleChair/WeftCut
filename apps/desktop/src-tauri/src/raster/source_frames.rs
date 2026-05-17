//! Source frame extraction for html-render-groups (decision 4 of
//! `docs/html-render-groups.md`). For each VideoClip member of an
//! html-cap group, ffmpeg pre-extracts one PNG per output frame at
//! the project canvas fps inside the group's source window. The
//! offscreen raster's composition HTML references the frames via
//! `<img src="source/<layer-id>/frame_NNNNN.png">` and the embedded
//! engine swaps the `src` per `__seek(t)`.
//!
//! ffmpeg owns frame-exact decode (decision 4: "kills the cross-
//! platform decode axis for the export side entirely"). The output
//! is 5-digit-padded, 0-indexed, so the engine can compute the
//! correct frame for any tLayerUs via `floor(tLayerUs * fps / 1e6)`.
//!
//! Caching: extraction runs only when the parent html-group cache
//! misses (per `html_group::materialize_group`'s manifest-keyed cache
//! check). The frames live in the same per-group cache dir and are
//! invalidated together with the rasterized output.

use std::path::Path;
use std::process::Stdio;

use ffmpeg_sidecar::paths::ffmpeg_path;
use tokio::process::Command;

/// Compute the number of output frames an extraction will produce for
/// a given source window + fps. Used by the materializer to populate
/// `CompositionLayerParams::VideoClip.frame_count` before extraction
/// actually runs — the engine reads it to clamp `frame_idx` at the
/// last available frame.
pub fn frame_count(src_in_us: i64, src_out_us: i64, fps_num: u32, fps_den: u32) -> usize {
    let dur_us = (src_out_us - src_in_us).max(0);
    let dur_s = dur_us as f64 / 1_000_000.0;
    let fps_num = fps_num.max(1) as f64;
    let fps_den = fps_den.max(1) as f64;
    let fps = fps_num / fps_den;
    ((dur_s * fps).ceil() as usize).max(1)
}

/// Extract source frames for one VideoClip member into `out_dir`.
/// Recreates `out_dir` on every call (no incremental extraction in
/// v1; the parent html-group cache handles cross-run reuse).
///
/// Output files: `out_dir/frame_00000.png`, `out_dir/frame_00001.png`,
/// ... N files. Cross-checking the count happens at the call site.
pub async fn extract(
    media_path: &Path,
    src_in_us: i64,
    src_out_us: i64,
    fps_num: u32,
    fps_den: u32,
    out_dir: &Path,
) -> Result<(), String> {
    if out_dir.exists() {
        std::fs::remove_dir_all(out_dir)
            .map_err(|e| format!("clean source frame dir {}: {e}", out_dir.display()))?;
    }
    std::fs::create_dir_all(out_dir)
        .map_err(|e| format!("create source frame dir {}: {e}", out_dir.display()))?;

    let in_s = src_in_us.max(0) as f64 / 1_000_000.0;
    let dur_us = (src_out_us - src_in_us).max(1);
    let dur_s = dur_us as f64 / 1_000_000.0;

    let pattern = out_dir.join("frame_%05d.png");

    // `-ss` BEFORE `-i` is the fast input-side seek — less accurate
    // than `-ss` after `-i` (which is decode-then-seek) but our window
    // is bounded by `-t` anyway and the per-output-frame timing comes
    // from the `fps` filter's output cadence, not from input-side
    // seek precision. The thumbnail job uses the same shape.
    let fps_filter = format!("fps={}/{}", fps_num.max(1), fps_den.max(1));
    let status = Command::new(ffmpeg_path())
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"])
        .args(["-ss", &format!("{in_s:.6}")])
        .arg("-i")
        .arg(media_path)
        .args(["-t", &format!("{dur_s:.6}")])
        .args([
            "-an",
            "-vf",
            &fps_filter,
            "-fps_mode",
            "passthrough",
            "-start_number",
            "0",
        ])
        .arg(&pattern)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("spawn ffmpeg for source frame extraction: {e}"))?;

    if !status.success() {
        return Err(format!(
            "ffmpeg exited with {status} during source frame extraction"
        ));
    }
    Ok(())
}

/// Best-effort PNG conversion for an `ImageOverlay` source. Reads
/// `media_path` and writes one `frame_00000.png` into `out_dir`.
/// Going through ffmpeg normalizes the output format so the engine's
/// `<img src="source/<lid>/frame_00000.png">` works regardless of
/// the original media's container (HEIC, AVIF, etc. that some webviews
/// can't decode natively).
pub async fn extract_single_image(media_path: &Path, out_dir: &Path) -> Result<(), String> {
    if out_dir.exists() {
        std::fs::remove_dir_all(out_dir)
            .map_err(|e| format!("clean image dir {}: {e}", out_dir.display()))?;
    }
    std::fs::create_dir_all(out_dir)
        .map_err(|e| format!("create image dir {}: {e}", out_dir.display()))?;

    let out_path = out_dir.join("frame_00000.png");
    let status = Command::new(ffmpeg_path())
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"])
        .arg("-i")
        .arg(media_path)
        .args(["-frames:v", "1"])
        .arg(&out_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("spawn ffmpeg for image normalization: {e}"))?;

    if !status.success() {
        return Err(format!(
            "ffmpeg exited with {status} during image normalization"
        ));
    }
    Ok(())
}
