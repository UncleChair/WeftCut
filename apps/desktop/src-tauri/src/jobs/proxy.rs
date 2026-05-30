//! Proxy generation. Transcodes a video to a 1080p-capped H.264/AAC mp4
//! that the PixiJS + WebCodecs renderer decodes for both preview and
//! export. Output sits at `<cache>/proxies/<file_hash>.mp4`.
//!
//! Encoder: libx264 -preset fast -crf 22 + AAC 128k, capped at 1080p
//! height (sources shorter stay native; never upscale). Software
//! encode is intentional — proxies should be portable across machines,
//! and the real HW-encoder selection is reserved for the user's
//! exports.
//!
//! GOP is a short fixed frame count (`PROXY_GOP_FRAMES`) so any scrub
//! target decodes at most a few frames from its keyframe — the enabler
//! for frame-accurate live scrubbing. This shortens the WebCodecs
//! decoder's seek-to-IDR-then-decode-forward tail from ~1 s (the prior
//! `round(source_fps)` GOP) to a few frames. See ADR 0008, which
//! revisits the 1 s-GOP rationale in ADR 0003 (whose no-reset-on-
//! forward-GOP-crossing behavior is retained, and more load-bearing
//! now that crossings are more frequent).

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
use crate::jobs::hwaccel;
use crate::state::MediaItem;

/// Maximum proxy height. Sources taller than this scale down; sources
/// shorter stay at native resolution (no upscaling).
const PROXY_HEIGHT_CAP: u32 = 1080;

/// Keyframe spacing (frames) for the full proxy. Short + fixed so any
/// scrub target decodes at most `PROXY_GOP_FRAMES - 1` frames from its
/// keyframe, bounding seek latency to a handful of frames regardless of
/// source fps — the enabler for frame-accurate live scrubbing. Replaces
/// the prior `round(source_fps)` (~1 s) GOP. `-bf 0` is retained, so
/// PTS=DTS holds and the auto-pause last-frame snap is unaffected.
/// Cost: a denser-keyframe proxy is ~50% larger, but proxies are
/// local-only cache and export re-encodes (so exported files are
/// unaffected). See ADR 0008. Shared with the quick (scrub) proxy.
pub const PROXY_GOP_FRAMES: u32 = 6;

/// Bump whenever the proxy ffmpeg args change in a way that affects
/// playback / scrub behavior. `io::load_from_dir` compares each
/// `MediaItem.proxy_format_version` against this constant on open
/// and invalidates older proxies so the existing background job
/// re-encodes them. See `docs/pixi-renderer-plan.md` (P1).
///
/// Versions:
///   0 — pre-versioning / legacy. ~8 s GOP from libx264 defaults.
///   1 — `-g 30 -keyint_min 30` for ~1 s keyframe spacing; 540p cap.
///   2 — 1080p cap (replaces 540p) for the PixiJS + WebCodecs renderer
///       which uses the proxy as the master decode source for preview
///       AND export. High profile / Level 4.2 / yuv420p so WebCodecs'
///       `avc1.640028` config decodes universally.
///   3 — GOP scales with source fps (`-g <round(fps)>`) so 60 fps
///       source proxies stay at 1 s GOP, not 0.5 s. See ADR 0003.
///   4 — `-bf 0` disables B-frames in the proxy. Preset-fast's default
///       3 B-frames carries a 2-frame CTS reorder offset through to
///       the proxy: the proxy's last frame's PTS lands ~67 ms past
///       the source's mvhd duration (which is what ffprobe reports
///       as `format.duration` and what `MediaItem.duration_us` /
///       layer `t_end_us` are sized to). The renderer's auto-pause
///       snap then targets the source-time corresponding to
///       `t_end_us − 1 µs`, which falls in the THIRD-to-last frame's
///       interval because the trailing two frames sit past the
///       clip's playable range. Disabling B-frames in the proxy
///       eliminates the reorder offset entirely — every frame's
///       PTS equals its DTS, the proxy's last frame lands inside
///       `t_end_us`, and the snap correctly paints it. Proxies are
///       local-only preview artifacts so the ~10–20 % size hit is
///       acceptable.
///   5 — short fixed GOP (`-g {PROXY_GOP_FRAMES} -keyint_min …`)
///       replacing the `round(fps)` ~1 s GOP, so any scrub target
///       decodes at most a few frames from its keyframe — frame-
///       accurate live scrubbing. `-bf 0` retained. ~50% larger
///       proxy; export unaffected (re-encodes). See ADR 0008.
pub const PROXY_FORMAT_VERSION: u32 = 5;

pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot generate proxy");
    }

    let dest = cache.proxy(&media.file_hash_blake3);
    if cached_ok(&dest) {
        return Ok(dest);
    }
    let tmp = temp_path(&dest);
    // Wipe any prior interrupted attempt.
    let _ = tokio::fs::remove_file(&tmp).await;

    // -vf scale=-2:'min(ih,N)' caps height at PROXY_HEIGHT_CAP without
    // upscaling sources that are already smaller; width auto-rounded to
    // even (libx264 requires even dims). High profile + Level 4.2 +
    // yuv420p gives WebCodecs a universally-decodable `avc1.640028`
    // stream. GOP = PROXY_GOP_FRAMES (short, fixed) keeps a keyframe
    // every few frames so any scrub target decodes at most a handful of
    // frames from its IDR — frame-accurate live scrubbing (ADR 0008).
    // -movflags +faststart puts the moov atom up front so the renderer
    // can parse the file before it's fully written.
    let scale_filter = format!("scale=-2:'min(ih,{PROXY_HEIGHT_CAP})'");
    let gop = PROXY_GOP_FRAMES.to_string();
    let input = media.path_abs.clone();
    let tmp = tmp.clone();

    let output = hwaccel::output_with_hw_decode_fallback("full proxy", |hw, cmd| {
        cmd.args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"]);
        if hw {
            hwaccel::push_hwaccel_args(cmd);
        }
        cmd.arg("-i").arg(&input).args([
            "-vf",
            &scale_filter,
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "22",
            "-profile:v",
            "high",
            "-level:v",
            "4.2",
            "-g",
            &gop,
            "-keyint_min",
            &gop,
            "-bf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ]);
        cmd.arg(&tmp)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
    })
    .await
    .context("full proxy transcode")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg exited with {} for proxy generation: {}",
            output.status,
            stderr.trim()
        );
    }

    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg returned success but proxy output is missing or zero bytes at {}",
            tmp.display()
        );
    }

    promote_temp(&dest)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

    use crate::state::{MediaKind, MediaMetadata, new_id};

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn make_test_video(dest: &std::path::Path) -> Result<()> {
        // Video-only fixture (no audio) — keeps the test focused on video
        // proxy generation; the proxy job's audio handling is a feature
        // not the contract under test here.
        //
        // 6 seconds at 30 fps (180 frames) so the keyframe-density
        // assertion below can confirm the short scrub GOP is applied
        // (~180/PROXY_GOP_FRAMES keyframes) vs the old ~1 s GOP (~6) or
        // libx264's default -g 250 (1 keyframe for the whole clip).
        let status = Command::new("ffmpeg")
            .args([
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", "testsrc=duration=6:size=640x360:rate=30",
                "-pix_fmt", "yuv420p",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-t", "6",
            ])
            .arg(dest)
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("test fixture ffmpeg failed: {status}");
        }
        Ok(())
    }

    #[tokio::test]
    async fn proxy_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping proxy smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let video = tmp.path().join("source.mp4");
        make_test_video(&video).await.expect("test fixture");

        let media = MediaItem {
            id: new_id(),
            label: Some("source.mp4".into()),
            path_abs: video,
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(6_000_000),
                video: None,
                audio: None,
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "deadbeef".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let proxy_path = run(&cache, &media).await.expect("proxy run");
        assert!(cached_ok(&proxy_path), "proxy file missing or empty");
        // Sanity check it's actually a real mp4 — re-probe with ffprobe.
        let out = Command::new("ffprobe")
            .args([
                "-v", "quiet", "-print_format", "json", "-show_format",
            ])
            .arg(&proxy_path)
            .output()
            .await
            .expect("ffprobe");
        assert!(out.status.success(), "ffprobe rejected the proxy output");

        // Verify the scrub-friendly GOP density (ADR 0008). With the
        // short fixed GOP (`PROXY_GOP_FRAMES`) a 6 s / 30 fps (180-frame)
        // source yields ~180/PROXY_GOP_FRAMES keyframes — far denser than
        // the prior ~1 s GOP (~6) or libx264's default -g 250 (1). The
        // lower bound is derived from the GOP so it tracks future tuning
        // while still cleanly rejecting the old 1 s-GOP behavior.
        let kf = Command::new("ffprobe")
            .args([
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "frame=pict_type",
                "-of", "csv=p=0",
            ])
            .arg(&proxy_path)
            .output()
            .await
            .expect("ffprobe keyframe count");
        assert!(kf.status.success(), "ffprobe keyframe scan failed");
        let stdout = String::from_utf8_lossy(&kf.stdout);
        let i_frames = stdout.lines().filter(|l| l.trim() == "I").count();
        // 180 frames / GOP, with a 1/3 margin for encoder edge choices.
        let expected_min = (180 / PROXY_GOP_FRAMES as usize) * 2 / 3;
        assert!(
            i_frames >= expected_min,
            "proxy should have >= {expected_min} keyframes for 6s @ 30fps with -g {PROXY_GOP_FRAMES} \
             (got {i_frames}); the short scrub GOP isn't being applied.\n{stdout}"
        );
        // PROXY_FORMAT_VERSION 4: `-bf 0` must produce a B-frame-free
        // stream. Without it, libx264's preset-fast default of 3 B-
        // frames pushes the proxy's last frame's PTS past mvhd duration,
        // and the renderer's auto-pause snap lands on the third-to-last
        // frame.
        let b_frames = stdout.lines().filter(|l| l.trim() == "B").count();
        assert_eq!(
            b_frames, 0,
            "proxy should have 0 B-frames with -bf 0 (got {b_frames}). \
             Preserving B-frames carries the CTS reorder offset into the proxy."
        );
    }

    #[tokio::test]
    async fn skip_when_proxy_cached() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let hash = "preexist";
        let dest = cache.proxy(hash);
        tokio::fs::create_dir_all(dest.parent().unwrap()).await.unwrap();
        tokio::fs::write(&dest, b"already here").await.unwrap();

        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("nope.mp4"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: hash.into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let returned = run(&cache, &media).await.expect("cache hit");
        assert_eq!(returned, dest);
        // File untouched.
        assert_eq!(tokio::fs::read(&dest).await.unwrap(), b"already here");
    }

}
