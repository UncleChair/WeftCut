//! Proxy generation. Transcodes a source to an H.264/AAC mp4 — the EXPORT
//! master for codecs WebCodecs can't decode directly. Preview reads the
//! lighter quick proxy, not this. Output at `<cache>/proxies/<file_hash>.mp4`.
//! See ADR 0011.
//!
//! Encode is always software (libx264): proxies must be portable across
//! machines, so HW-encoder selection is reserved for the user's exports.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
use crate::jobs::hwaccel;
use crate::state::MediaItem;

/// Maximum export-master height. Sources taller than this scale down (bounds
/// the worst-case 8K encode); sources shorter stay native (no upscaling).
const PROXY_HEIGHT_CAP: u32 = 2160;

/// Keyframe spacing (frames) for the full proxy. Short and fixed so any scrub
/// target decodes at most `PROXY_GOP_FRAMES - 1` frames from its keyframe,
/// bounding seek latency regardless of source fps — the enabler for
/// frame-accurate live scrubbing. `-bf 0` is kept so PTS=DTS holds: re-enabling
/// B-frames would push the proxy's last PTS past the source duration and the
/// auto-pause last-frame snap would land two frames early. A denser-keyframe
/// proxy is ~50% larger, but proxies are local-only and export re-encodes. See
/// ADR 0008.
/// Shared with the quick (scrub) proxy.
pub const PROXY_GOP_FRAMES: u32 = 6;

/// Bump whenever the proxy ffmpeg args change in a way that affects playback,
/// scrub, or color: `io::load_from_dir` invalidates any proxy whose stored
/// `proxy_format_version` is older, and the background job re-encodes it.
///
/// Current format: export master, source-resolution H.264 capped at 2160p,
/// High profile, `-bf 0` (PTS=DTS), short fixed GOP (`PROXY_GOP_FRAMES`), and
/// source color tags asserted with `+write_colr` so mediabunny reads a `colr`
/// atom. See ADR 0008, 0011, 0014.
pub const PROXY_FORMAT_VERSION: u32 = 7;

/// Output-side ffmpeg args asserting the SOURCE's ffprobe color tags on a
/// proxy re-encode. The transcode preserves the source's actual colorimetry
/// (the filter chain never converts matrix/range), but x264 records it only in
/// the SPS VUI — and pure-container demuxers (mediabunny) read only the mp4
/// `colr` atom, never the VUI. Asserting the tags explicitly (plus
/// `+write_colr` on the muxer) emits that colr atom, so proxy decodes get the
/// real matrix/range instead of falling back to the bt709/limited resolution
/// default (the full-range/601 proxy misread the color-conformance gate
/// caught). Only tags ffprobe actually reported are asserted; missing fields
/// are left for ffmpeg to infer.
pub fn source_color_args(media: &MediaItem) -> Vec<String> {
    let Some(v) = media.metadata.video.as_ref() else {
        return Vec::new();
    };
    let mut args = Vec::new();
    let mut push = |flag: &str, val: &Option<String>| {
        if let Some(val) = val {
            args.push(flag.to_string());
            args.push(val.clone());
        }
    };
    push("-colorspace", &v.color_matrix);
    push("-color_primaries", &v.color_primaries);
    push("-color_trc", &v.color_transfer);
    push("-color_range", &v.color_range);
    args
}

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

    // `scale=-2:'min(ih,N)'` caps height without upscaling; the `-2` rounds
    // width to even (libx264 requires even dims). High profile + yuv420p give
    // WebCodecs a universally-decodable `avc1.640028` stream; `+faststart`
    // puts the moov atom up front so the renderer can parse before the write
    // completes. Height-cap / GOP / `-bf 0` rationale: see the constants above.
    let scale_filter = format!("scale=-2:'min(ih,{PROXY_HEIGHT_CAP})'");
    let gop = PROXY_GOP_FRAMES.to_string();
    let input = media.path_abs.clone();
    let color_args = source_color_args(media);
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
            "18",
            "-profile:v",
            "high",
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
            "+faststart+write_colr",
            "-f",
            "mp4",
        ]);
        // Source color tags → VUI AND (with +write_colr) the mp4 colr atom;
        // see `source_color_args`.
        cmd.args(&color_args);
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

    use crate::state::{MediaKind, MediaMetadata, VideoStreamMeta, new_id};

    fn video_with_color(
        matrix: Option<&str>,
        range: Option<&str>,
        primaries: Option<&str>,
        transfer: Option<&str>,
    ) -> MediaItem {
        MediaItem {
            id: new_id(),
            label: None,
            path_abs: "clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(10_000_000),
                video: Some(VideoStreamMeta {
                    width: 1920,
                    height: 1080,
                    fps_num: 30,
                    fps_den: 1,
                    codec: "h264".into(),
                    pix_fmt: "yuvj420p".into(),
                    nb_frames: None,
                    color_matrix: matrix.map(Into::into),
                    color_range: range.map(Into::into),
                    color_primaries: primaries.map(Into::into),
                    color_transfer: transfer.map(Into::into),
                }),
                audio: None,
            },
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "abc".into(),
            file_size: 1,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    // The proxy re-encode preserves the source's colorimetry (verified: ffmpeg
    // carries matrix/range through scale + libx264), so the recipe must ASSERT
    // the source's ffprobe tags on the output — that plus `+write_colr` is what
    // puts a colr atom in the mp4 for mediabunny (which never parses SPS VUI).

    #[test]
    fn source_color_args_full_range_source_asserts_all_tags() {
        let m = video_with_color(Some("bt709"), Some("pc"), Some("bt709"), Some("bt709"));
        assert_eq!(
            source_color_args(&m),
            vec![
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-color_range",
                "pc",
            ]
        );
    }

    #[test]
    fn source_color_args_partial_tags_emit_only_known_flags() {
        // The ltd fixtures carry only a matrix; range/primaries/transfer are
        // unset and must be OMITTED (ffmpeg keeps its own inference) rather
        // than asserted wrong.
        let m = video_with_color(Some("smpte170m"), None, None, None);
        assert_eq!(source_color_args(&m), vec!["-colorspace", "smpte170m"]);
    }

    #[test]
    fn source_color_args_untagged_source_emits_nothing() {
        let m = video_with_color(None, None, None, None);
        assert!(source_color_args(&m).is_empty());
    }

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
            conform_path: None,
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
        // `-bf 0` must produce a B-frame-free stream. Without it,
        // libx264's preset-fast default of 3 B-frames pushes the proxy's
        // last frame's PTS past mvhd duration,
        // and the renderer's auto-pause snap lands on the third-to-last
        // frame.
        let b_frames = stdout.lines().filter(|l| l.trim() == "B").count();
        assert_eq!(
            b_frames, 0,
            "proxy should have 0 B-frames with -bf 0 (got {b_frames}). \
             Preserving B-frames carries the CTS reorder offset into the proxy."
        );
    }

    /// The proxy must stay color-readable to mediabunny: source ffprobe tags
    /// asserted on the encode + a colr atom in the mp4 (mediabunny never
    /// parses the SPS VUI). This is the integration guard for the machinery
    /// behind the color-conformance gate's proxy-decode path — the e2e color
    /// fixtures DirectExport since yuvj420p joined the bypass whitelist, so
    /// without this test a dropped color arg would go unnoticed until a
    /// proxy-routed source (HEVC/VP9/10-bit) mis-renders.
    #[tokio::test]
    async fn proxy_carries_source_color_tags_and_colr_atom() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping proxy color smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        // A full-range 601 source — the combination the resolution default
        // gets maximally wrong (bt709/limited).
        let video = tmp.path().join("source_601full.mp4");
        let status = Command::new("ffmpeg")
            .args([
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", "testsrc=duration=1:size=640x360:rate=30",
                "-vf", "format=rgb24,scale=out_color_matrix=smpte170m:out_range=pc,format=yuv420p",
                "-colorspace", "smpte170m",
                "-color_primaries", "smpte170m",
                "-color_trc", "smpte170m",
                "-color_range", "pc",
                "-c:v", "libx264",
                "-preset", "ultrafast",
            ])
            .arg(&video)
            .status()
            .await
            .expect("spawn ffmpeg for 601full fixture");
        assert!(status.success(), "601full fixture ffmpeg failed: {status}");

        let mut media = MediaItem {
            id: new_id(),
            label: Some("source_601full.mp4".into()),
            path_abs: video,
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
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "colrsmoke".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        // Color tags as `probe.rs` would fill them from the fixture above.
        media.metadata.video = Some(
            video_with_color(
                Some("smpte170m"),
                Some("pc"),
                Some("smpte170m"),
                Some("smpte170m"),
            )
            .metadata
            .video
            .unwrap(),
        );

        let proxy_path = run(&cache, &media).await.expect("proxy run");

        // 1. ffprobe sees the asserted tags on the proxy stream.
        let out = Command::new("ffprobe")
            .args([
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=color_space,color_range",
                "-of", "csv=p=0",
            ])
            .arg(&proxy_path)
            .output()
            .await
            .expect("ffprobe color tags");
        assert!(out.status.success(), "ffprobe rejected the proxy output");
        let tags = String::from_utf8_lossy(&out.stdout);
        assert!(
            tags.contains("smpte170m") && tags.contains("pc"),
            "proxy lost the source color tags (got: {})",
            tags.trim()
        );

        // 2. The mp4 carries a colr atom (what mediabunny actually reads).
        let bytes = tokio::fs::read(&proxy_path).await.unwrap();
        assert!(
            bytes.windows(4).any(|w| w == b"colr"),
            "proxy mp4 has no colr atom — mediabunny would fall back to the \
             bt709/limited resolution default"
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
            conform_path: None,
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

    async fn make_sized_video(dest: &std::path::Path, size: &str) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi"])
            .arg("-i")
            .arg(format!("testsrc=duration=1:size={size}:rate=30"))
            .args(["-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-t", "1"])
            .arg(dest)
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("sized fixture ffmpeg failed: {status}");
        }
        Ok(())
    }

    #[tokio::test]
    async fn proxy_preserves_source_resolution_above_1080() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping resolution smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let src = tmp.path().join("src1440.mp4");
        make_sized_video(&src, "2560x1440").await.expect("fixture");

        let media = MediaItem {
            id: new_id(),
            label: Some("src1440.mp4".into()),
            path_abs: src,
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
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "res1440".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let proxy_path = run(&cache, &media).await.expect("proxy run");
        let out = Command::new("ffprobe")
            .args([
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=height",
                "-of", "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(&proxy_path)
            .output()
            .await
            .expect("ffprobe height");
        let height: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0);
        assert_eq!(height, 1440, "master must preserve 1440p source res, not cap to 1080");
    }
}
