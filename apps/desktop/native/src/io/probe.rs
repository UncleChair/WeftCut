//! Media probing — file hashing + ffprobe-backed metadata extraction.
//!
//! Graceful when ffprobe isn't installed: imports succeed with empty metadata
//! and a warning. The user (or a re-import after installing ffmpeg) backfills.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use ffmpeg_sidecar::ffprobe::{ffprobe_is_installed, ffprobe_path};
use serde::Deserialize;
use tracing::warn;

use crate::state::media::{AudioStreamMeta, MediaKind, MediaMetadata, VideoStreamMeta};

#[derive(Debug, Clone)]
pub struct FileFacts {
    pub size: u64,
    pub mtime_secs: u64,
    pub blake3_hex: String,
}

/// File size + mtime only — used at import time when full blake3 hashing is
/// deferred until the workspace copy lands.
pub fn stat_file(path: &Path) -> Result<(u64, u64)> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("stat {}", path.display()))?;
    let size = metadata.len();
    let mtime_secs = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok((size, mtime_secs))
}

pub fn hash_and_stat(path: &Path) -> Result<FileFacts> {
    let (size, mtime_secs) = stat_file(path)?;

    let mut hasher = blake3::Hasher::new();
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).context("read for hash")?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(FileFacts {
        size,
        mtime_secs,
        blake3_hex: hasher.finalize().to_hex().to_string(),
    })
}

pub fn probe_metadata(path: &Path) -> MediaMetadata {
    if !ffprobe_is_installed() {
        warn!(
            "ffprobe not installed; importing {} without metadata",
            path.display()
        );
        return MediaMetadata::default();
    }

    let output = Command::new(ffprobe_path())
        .args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            warn!(
                "ffprobe exited {} for {}: {}",
                o.status,
                path.display(),
                String::from_utf8_lossy(&o.stderr)
            );
            return MediaMetadata::default();
        }
        Err(e) => {
            warn!("ffprobe spawn failed for {}: {e}", path.display());
            return MediaMetadata::default();
        }
    };

    match serde_json::from_slice::<RawProbe>(&output.stdout) {
        Ok(probe) => probe.into_metadata(),
        Err(e) => {
            warn!("ffprobe JSON parse failed for {}: {e}", path.display());
            MediaMetadata::default()
        }
    }
}

/// Seconds of source scanned to estimate the keyframe interval. A few
/// seconds is enough to see several keyframes at any normal GOP; long-GOP
/// sources (the ones we care about demoting) show 0–1 keyframes in this
/// window and are reported as "long" via the 1-keyframe fallback below.
const KEYFRAME_SCAN_SECONDS: f64 = 12.0;

/// Estimate the source's largest keyframe interval, in SECONDS, by scanning
/// the first few seconds with ffprobe. `-skip_frame nokey` makes ffprobe emit
/// only keyframes (fast — no full decode). Returns `None` only when the probe
/// yields nothing usable (ffprobe missing / parse failure); callers treat
/// `None` as "unknown" and do NOT demote on it. Used by `proxy_decision`: a
/// long-GOP source scrubs badly when decoded directly, so it gets a short-GOP
/// scrub proxy instead of being bypassed.
pub fn probe_max_keyframe_gap_secs(path: &Path) -> Option<f64> {
    if !ffprobe_is_installed() {
        return None;
    }
    let output = Command::new(ffprobe_path())
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-skip_frame", "nokey",
            "-read_intervals", "%+12",
            "-show_entries", "frame=pts_time",
            "-of", "csv=p=0",
        ])
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let ts: Vec<f64> = stdout
        .lines()
        .filter_map(|l| l.trim().parse::<f64>().ok())
        .collect();
    max_keyframe_gap_secs(&ts, KEYFRAME_SCAN_SECONDS)
}

/// Largest gap (seconds) between consecutive keyframe timestamps.
///   - 0 timestamps → `None` (probe gave nothing; caller treats as unknown).
///   - 1 timestamp  → `Some(window)` — only one keyframe in the scan window,
///     so the GOP is at least the window length: definitely "long".
///   - ≥2           → `Some(max consecutive gap)`.
/// Pure + testable; `probe_max_keyframe_gap_secs` is the ffprobe wrapper.
fn max_keyframe_gap_secs(timestamps: &[f64], window_secs: f64) -> Option<f64> {
    match timestamps.len() {
        0 => None,
        1 => Some(window_secs),
        _ => {
            let mut sorted: Vec<f64> = timestamps.to_vec();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let mut max_gap = 0.0_f64;
            for w in sorted.windows(2) {
                max_gap = max_gap.max(w[1] - w[0]);
            }
            Some(max_gap)
        }
    }
}

/// Codecs ffprobe reports for still-image files — single-frame OR multi-frame
/// (animated GIF, animated WebP, APNG all classify as Image and are looped by
/// the renderer with no proxy). `mjpeg` is the one ambiguous exception: it can
/// be a still/sequence JPEG *or* motion-JPEG inside a movie container; the
/// container check in `detect_kind` resolves the ambiguity.
const STILL_IMAGE_CODECS: &[&str] = &["png", "apng", "mjpeg", "webp", "gif", "bmp", "tiff"];

/// Container/demuxer names whose payload is a single (possibly animated) still
/// image rather than a movie. Distinguishes an animated GIF/WebP/APNG/AVIF
/// (→ Image, looped by the renderer) from a real video that merely uses an
/// image codec (motion-JPEG in .avi → Video). ffprobe joins alternatives with
/// commas ("mov,mp4,m4a,3gp,3g2,mj2"), so match any comma-separated part.
const IMAGE_CONTAINERS: &[&str] = &[
    "gif", "webp_pipe", "webp", "png_pipe", "apng", "image2", "image2pipe",
    "bmp_pipe", "tiff_pipe", "avif",
];

fn container_is_image(format_name: Option<&str>) -> bool {
    match format_name {
        Some(fmt) => fmt.split(',').any(|p| IMAGE_CONTAINERS.contains(&p.trim())),
        None => false,
    }
}

pub fn detect_kind(path: &Path, metadata: &MediaMetadata) -> MediaKind {
    if let Some(v) = &metadata.video {
        let codec = v.codec.as_str();
        let image_container = container_is_image(metadata.container_format.as_deref());
        // Dedicated still-image codecs route to Image regardless of frame count:
        // a multi-frame GIF/WebP/APNG is an *animated image*, looped from its
        // decoded frames with no proxy. `mjpeg` is the one ambiguous codec —
        // motion-JPEG inside a movie container is real video.
        if STILL_IMAGE_CODECS.contains(&codec) {
            if codec == "mjpeg" {
                let animated = v.nb_frames.is_some_and(|n| n > 1)
                    || metadata.duration_us.is_some_and(|d| d >= 500_000);
                // LANDMINE: do NOT simplify to `!animated`. The `&& !image_container`
                // guard is load-bearing: `image2`/`image2pipe` are in IMAGE_CONTAINERS,
                // and a still or sequence JPEG probes as codec `mjpeg` + format `image2`
                // (animated = false, image_container = true → Image). A motion-JPEG
                // movie (.avi) has a non-image container, so only THAT path reaches
                // Video. Removing the guard would misclassify .avi mjpeg as Image.
                return if animated && !image_container {
                    MediaKind::Video
                } else {
                    MediaKind::Image
                };
            }
            return MediaKind::Image;
        }
        // AVIF (still or animated) carries an av1/hevc stream — the codec can't
        // tell it from a movie, so key off the container.
        if image_container {
            return MediaKind::Image;
        }
        return MediaKind::Video;
    }
    if metadata.audio.is_some() {
        return MediaKind::Audio;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "mov" | "mkv" | "webm" | "avi" | "m4v" => MediaKind::Video,
        "wav" | "mp3" | "flac" | "aac" | "ogg" | "m4a" | "opus" => MediaKind::Audio,
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "avif" | "apng" => {
            MediaKind::Image
        }
        "srt" | "ass" | "vtt" => MediaKind::Subtitle,
        _ => MediaKind::Video,
    }
}

#[derive(Deserialize)]
struct RawProbe {
    #[serde(default)]
    format: RawFormat,
    #[serde(default)]
    streams: Vec<RawStream>,
}

#[derive(Deserialize, Default)]
struct RawFormat {
    duration: Option<String>,
    format_name: Option<String>,
}

/// Stream disposition flags — only `attached_pic` matters here (embedded
/// cover art in mp3/m4a/flac/ogg probes as a video stream carrying it).
#[derive(Deserialize, Default)]
struct RawDisposition {
    #[serde(default)]
    attached_pic: u8,
}

#[derive(Deserialize)]
#[serde(tag = "codec_type", rename_all = "lowercase")]
enum RawStream {
    Video {
        width: Option<u32>,
        height: Option<u32>,
        r_frame_rate: Option<String>,
        codec_name: Option<String>,
        pix_fmt: Option<String>,
        duration: Option<String>,
        nb_frames: Option<String>,
        color_space: Option<String>,
        color_range: Option<String>,
        color_primaries: Option<String>,
        color_transfer: Option<String>,
        #[serde(default)]
        disposition: RawDisposition,
    },
    Audio {
        sample_rate: Option<String>,
        channels: Option<u8>,
        codec_name: Option<String>,
        duration: Option<String>,
    },
    #[serde(other)]
    Other,
}

fn duration_seconds_to_us(s: &str) -> Option<i64> {
    s.parse::<f64>().ok().map(|v| (v * 1_000_000.0) as i64)
}

impl RawProbe {
    fn into_metadata(self) -> MediaMetadata {
        let container_format = self.format.format_name;
        let format_duration_us = self
            .format
            .duration
            .as_deref()
            .and_then(duration_seconds_to_us);

        // Take the max across format and per-stream durations. mvhd's
        // movie duration (= ffprobe's `format.duration`) is often shorter
        // than the sample-table extent on H.264 sources that use B-frame
        // reorder: the reorder offset pushes the last sample's CTS past
        // mvhd's nominal end, so the renderer demuxes frames whose PTS
        // > `format.duration` — and a clip's `t_end_us` derived from the
        // shorter mvhd value cuts those trailing frames out of the
        // playable range. Stream-level `duration` is derived from
        // stsd/stts/ctts and includes the offset, so it's the source of
        // truth for the visible timeline extent we want here.
        let mut max_duration_us = format_duration_us;
        let mut consider = |s: Option<&str>| {
            if let Some(us) = s.and_then(duration_seconds_to_us) {
                max_duration_us = Some(max_duration_us.map_or(us, |cur| cur.max(us)));
            }
        };

        let mut video = None;
        let mut audio = None;
        for stream in self.streams {
            // Embedded cover art (mp3/m4a/flac/ogg) probes as a video stream
            // with `attached_pic` set. It is neither video evidence nor a
            // duration source — skip it entirely.
            if let RawStream::Video { disposition, .. } = &stream {
                if disposition.attached_pic != 0 {
                    continue;
                }
            }
            match stream {
                RawStream::Video {
                    width,
                    height,
                    r_frame_rate,
                    codec_name,
                    pix_fmt,
                    duration,
                    nb_frames,
                    color_space,
                    color_range,
                    color_primaries,
                    color_transfer,
                    disposition: _,
                } if video.is_none() => {
                    consider(duration.as_deref());
                    let (num, den) = parse_rational(r_frame_rate.as_deref().unwrap_or("0/1"));
                    video = Some(VideoStreamMeta {
                        width: width.unwrap_or(0),
                        height: height.unwrap_or(0),
                        fps_num: num,
                        fps_den: den,
                        codec: codec_name.unwrap_or_default(),
                        pix_fmt: pix_fmt.unwrap_or_default(),
                        nb_frames: nb_frames.as_deref().and_then(|s| s.parse().ok()),
                        color_matrix: clean_color(color_space),
                        color_range: clean_color(color_range),
                        color_primaries: clean_color(color_primaries),
                        color_transfer: clean_color(color_transfer),
                    });
                }
                RawStream::Audio {
                    sample_rate,
                    channels,
                    codec_name,
                    duration,
                } if audio.is_none() => {
                    consider(duration.as_deref());
                    audio = Some(AudioStreamMeta {
                        sample_rate: sample_rate
                            .as_deref()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0),
                        channels: channels.unwrap_or(0),
                        codec: codec_name.unwrap_or_default(),
                    });
                }
                RawStream::Video { duration, .. } | RawStream::Audio { duration, .. } => {
                    consider(duration.as_deref());
                }
                RawStream::Other => {}
            }
        }
        MediaMetadata {
            duration_us: max_duration_us,
            video,
            audio,
            container_format,
        }
    }
}

fn clean_color(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty() && v != "unknown")
}

fn parse_rational(s: &str) -> (u32, u32) {
    if let Some((n, d)) = s.split_once('/') {
        let num: u32 = n.parse().unwrap_or(0);
        let den: u32 = d.parse().unwrap_or(1);
        (num, den.max(1))
    } else {
        (s.parse().unwrap_or(0), 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn stat_file_reads_size_and_mtime() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.bin");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"hello").unwrap();
        drop(f);

        let (size, _mtime) = stat_file(&path).unwrap();
        assert_eq!(size, 5);
    }

    #[test]
    fn hash_is_deterministic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.bin");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"hello weftcut").unwrap();
        drop(f);

        let a = hash_and_stat(&path).unwrap();
        let b = hash_and_stat(&path).unwrap();
        assert_eq!(a.blake3_hex, b.blake3_hex);
        assert_eq!(a.size, 13);
    }

    #[test]
    fn detect_kind_falls_back_to_extension() {
        let empty = MediaMetadata::default();
        assert_eq!(
            detect_kind(Path::new("/x/movie.mov"), &empty),
            MediaKind::Video
        );
        assert_eq!(
            detect_kind(Path::new("/x/song.mp3"), &empty),
            MediaKind::Audio
        );
        assert_eq!(
            detect_kind(Path::new("/x/poster.png"), &empty),
            MediaKind::Image
        );
        assert_eq!(
            detect_kind(Path::new("/x/captions.srt"), &empty),
            MediaKind::Subtitle
        );
    }

    #[test]
    fn stream_duration_overrides_shorter_format_duration() {
        // H.264 with 2-frame B-reorder offset: mvhd duration (`format`)
        // is 10s but the sample table extends to ~10.067s. Probe should
        // take the longer value so the clip's `t_end_us` covers the
        // trailing reordered frames.
        let json = r#"{
            "format": { "duration": "10.000000" },
            "streams": [
                {
                    "codec_type": "video",
                    "width": 1920,
                    "height": 1080,
                    "r_frame_rate": "30/1",
                    "codec_name": "h264",
                    "pix_fmt": "yuv420p",
                    "duration": "10.066667"
                }
            ]
        }"#;
        let probe: RawProbe = serde_json::from_str(json).unwrap();
        let meta = probe.into_metadata();
        assert_eq!(meta.duration_us, Some(10_066_667));
    }

    #[test]
    fn format_duration_used_when_stream_duration_missing() {
        let json = r#"{
            "format": { "duration": "5.000000" },
            "streams": [
                {
                    "codec_type": "video",
                    "width": 640,
                    "height": 480,
                    "r_frame_rate": "30/1",
                    "codec_name": "h264",
                    "pix_fmt": "yuv420p"
                }
            ]
        }"#;
        let probe: RawProbe = serde_json::from_str(json).unwrap();
        let meta = probe.into_metadata();
        assert_eq!(meta.duration_us, Some(5_000_000));
    }

    #[test]
    fn longer_format_duration_wins_over_shorter_stream() {
        // The reverse case — some containers carry trailing audio padding
        // past the video stream. Take the longest, regardless of source.
        let json = r#"{
            "format": { "duration": "8.500000" },
            "streams": [
                {
                    "codec_type": "video",
                    "width": 640,
                    "height": 480,
                    "r_frame_rate": "30/1",
                    "codec_name": "h264",
                    "pix_fmt": "yuv420p",
                    "duration": "8.000000"
                }
            ]
        }"#;
        let probe: RawProbe = serde_json::from_str(json).unwrap();
        let meta = probe.into_metadata();
        assert_eq!(meta.duration_us, Some(8_500_000));
    }

    #[test]
    fn detect_kind_prefers_probe_streams_over_extension() {
        let with_video = MediaMetadata {
            duration_us: Some(1_000_000),
            video: Some(VideoStreamMeta {
                width: 1920,
                height: 1080,
                fps_num: 30,
                fps_den: 1,
                codec: "h264".into(),
                pix_fmt: "yuv420p".into(),
                nb_frames: None,
                color_matrix: None,
                color_range: None,
                color_primaries: None,
                color_transfer: None,
            }),
            audio: None,
            ..Default::default()
        };
        // Even with `.bin` extension the probe wins.
        assert_eq!(
            detect_kind(Path::new("/x/blob.bin"), &with_video),
            MediaKind::Video
        );
    }

    #[test]
    fn parses_color_tags_from_streams() {
        let json = r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,
          "r_frame_rate":"30/1","codec_name":"h264","pix_fmt":"yuv420p",
          "color_space":"smpte170m","color_range":"tv"}]}"#;
        let meta = serde_json::from_slice::<RawProbe>(json.as_bytes()).unwrap().into_metadata();
        let v = meta.video.unwrap();
        assert_eq!(v.color_matrix.as_deref(), Some("smpte170m"));
        assert_eq!(v.color_range.as_deref(), Some("tv"));
        assert_eq!(v.color_primaries, None);
    }

    #[test]
    fn drops_unknown_color_tags() {
        let json = r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,
          "r_frame_rate":"30/1","codec_name":"h264","pix_fmt":"yuv420p",
          "color_space":"unknown","color_range":"unknown"}]}"#;
        let v = serde_json::from_slice::<RawProbe>(json.as_bytes()).unwrap().into_metadata().video.unwrap();
        assert_eq!(v.color_matrix, None);
        assert_eq!(v.color_range, None);
    }

    /// Build MediaMetadata exactly the way `probe_metadata` does — through the
    /// RawProbe JSON parser — so these tests pin the REAL classification path
    /// for captured ffprobe output, not hand-built structs.
    fn meta_from_probe_json(json: &str) -> MediaMetadata {
        serde_json::from_str::<RawProbe>(json)
            .expect("probe JSON")
            .into_metadata()
    }

    /// mp3 with embedded cover art (very common in the wild): ffprobe reports
    /// a SECOND stream — mjpeg video with `disposition.attached_pic: 1`.
    /// Album art is not video evidence: it must not populate metadata.video,
    /// and the file must classify as Audio. (Captured from a real
    /// `ffprobe -print_format json` run, trimmed to the fields we parse.)
    #[test]
    fn attached_pic_cover_art_is_not_video_evidence() {
        let json = r#"{
            "format": { "format_name": "mp3", "duration": "2.000000" },
            "streams": [
                {
                    "codec_type": "audio", "codec_name": "mp3",
                    "sample_rate": "44100", "channels": 1,
                    "duration": "2.000000",
                    "disposition": { "attached_pic": 0 }
                },
                {
                    "codec_type": "video", "codec_name": "mjpeg",
                    "width": 320, "height": 240, "pix_fmt": "yuvj444p",
                    "r_frame_rate": "90000/1", "duration": "2.000000",
                    "disposition": { "attached_pic": 1 }
                }
            ]
        }"#;
        let meta = meta_from_probe_json(json);
        assert!(meta.video.is_none(), "album art must not become video meta");
        assert!(meta.audio.is_some());
        assert_eq!(
            detect_kind(Path::new("/x/song.mp3"), &meta),
            MediaKind::Audio
        );
    }

    /// Still images probe as a single video stream (png_pipe / image2 /
    /// webp_pipe / 1-frame gif). They must classify as Image, not Video —
    /// otherwise import routes them into the proxy/WebCodecs pipeline and
    /// the ImageOverlay path is unreachable whenever ffprobe is installed.
    #[test]
    fn still_images_classify_as_image_despite_probe_video_stream() {
        // (json, file) per format — trimmed from real ffprobe output. PNG and
        // WebP report no duration at all; JPEG and single-frame GIF report one
        // frame's worth (1/25 s). GIF also reports nb_frames.
        let cases: &[(&str, &str)] = &[
            (
                r#"{
                    "format": { "format_name": "png_pipe" },
                    "streams": [{
                        "codec_type": "video", "codec_name": "png",
                        "width": 320, "height": 240, "pix_fmt": "rgb24",
                        "r_frame_rate": "25/1",
                        "disposition": { "attached_pic": 0 }
                    }]
                }"#,
                "/x/chart.png",
            ),
            (
                r#"{
                    "format": { "format_name": "image2", "duration": "0.040000" },
                    "streams": [{
                        "codec_type": "video", "codec_name": "mjpeg",
                        "width": 320, "height": 240, "pix_fmt": "yuvj444p",
                        "r_frame_rate": "25/1", "duration": "0.040000",
                        "disposition": { "attached_pic": 0 }
                    }]
                }"#,
                "/x/photo.jpg",
            ),
            (
                r#"{
                    "format": { "format_name": "webp_pipe" },
                    "streams": [{
                        "codec_type": "video", "codec_name": "webp",
                        "width": 320, "height": 240, "pix_fmt": "argb",
                        "r_frame_rate": "25/1",
                        "disposition": { "attached_pic": 0 }
                    }]
                }"#,
                "/x/chart.webp",
            ),
            (
                r#"{
                    "format": { "format_name": "gif", "duration": "0.040000" },
                    "streams": [{
                        "codec_type": "video", "codec_name": "gif",
                        "width": 320, "height": 240, "pix_fmt": "bgra",
                        "r_frame_rate": "100/1", "nb_frames": "1",
                        "duration": "0.040000",
                        "disposition": { "attached_pic": 0 }
                    }]
                }"#,
                "/x/chart.gif",
            ),
            (
                r#"{
                    "format": { "format_name": "bmp_pipe" },
                    "streams": [{
                        "codec_type": "video", "codec_name": "bmp",
                        "width": 320, "height": 240, "pix_fmt": "bgr24",
                        "r_frame_rate": "25/1",
                        "disposition": { "attached_pic": 0 }
                    }]
                }"#,
                "/x/chart.bmp",
            ),
        ];
        for (json, file) in cases {
            let meta = meta_from_probe_json(json);
            assert_eq!(
                detect_kind(Path::new(file), &meta),
                MediaKind::Image,
                "{file} must classify as Image"
            );
        }
    }

    /// Animated still-image formats are *animated images*: they classify as
    /// Image (looped by the renderer, no proxy), NOT Video. Covers GIF, animated
    /// WebP, APNG, and animated AVIF (whose stream codec is av1 — caught by the
    /// container, not the codec).
    #[test]
    fn animated_still_image_formats_classify_as_image() {
        let cases: &[(&str, &str)] = &[
            (
                r#"{ "format": { "format_name": "gif", "duration": "2.0" },
                     "streams": [{ "codec_type": "video", "codec_name": "gif",
                       "width": 160, "height": 120, "pix_fmt": "bgra",
                       "r_frame_rate": "5/1", "nb_frames": "10", "duration": "2.0",
                       "disposition": { "attached_pic": 0 } }] }"#,
                "/x/anim.gif",
            ),
            (
                r#"{ "format": { "format_name": "webp_pipe", "duration": "1.2" },
                     "streams": [{ "codec_type": "video", "codec_name": "webp",
                       "width": 200, "height": 200, "pix_fmt": "argb",
                       "r_frame_rate": "10/1", "nb_frames": "12", "duration": "1.2",
                       "disposition": { "attached_pic": 0 } }] }"#,
                "/x/anim.webp",
            ),
            (
                r#"{ "format": { "format_name": "apng", "duration": "1.0" },
                     "streams": [{ "codec_type": "video", "codec_name": "apng",
                       "width": 64, "height": 64, "pix_fmt": "rgba",
                       "r_frame_rate": "10/1", "nb_frames": "10", "duration": "1.0",
                       "disposition": { "attached_pic": 0 } }] }"#,
                "/x/anim.apng",
            ),
            (
                r#"{ "format": { "format_name": "avif", "duration": "1.0" },
                     "streams": [{ "codec_type": "video", "codec_name": "av1",
                       "width": 320, "height": 240, "pix_fmt": "yuv420p",
                       "r_frame_rate": "24/1", "nb_frames": "24", "duration": "1.0",
                       "disposition": { "attached_pic": 0 } }] }"#,
                "/x/anim.avif",
            ),
        ];
        for (json, file) in cases {
            let meta = meta_from_probe_json(json);
            assert_eq!(
                detect_kind(Path::new(file), &meta),
                MediaKind::Image,
                "{file} must classify as Image"
            );
        }
    }

    /// A real movie that uses an image codec stays Video. av1-in-mp4 is a normal
    /// AV1 video (container is mov/mp4, not avif); motion-JPEG .avi is real video
    /// (codec mjpeg but a movie container) — the `mjpeg_motion_video_stays_video`
    /// test below pins that leg.
    #[test]
    fn av1_in_mp4_stays_video() {
        let json = r#"{
            "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "10.0" },
            "streams": [{ "codec_type": "video", "codec_name": "av1",
              "width": 1920, "height": 1080, "pix_fmt": "yuv420p",
              "r_frame_rate": "30/1", "nb_frames": "300", "duration": "10.0",
              "disposition": { "attached_pic": 0 } }]
        }"#;
        let meta = meta_from_probe_json(json);
        assert_eq!(detect_kind(Path::new("/x/clip.mp4"), &meta), MediaKind::Video);
    }

    /// Motion-JPEG video (e.g. .avi capture): codec mjpeg like a still JPEG,
    /// but a real duration — stays Video.
    #[test]
    fn mjpeg_motion_video_stays_video() {
        let json = r#"{
            "format": { "format_name": "avi", "duration": "10.000000" },
            "streams": [{
                "codec_type": "video", "codec_name": "mjpeg",
                "width": 640, "height": 480, "pix_fmt": "yuvj422p",
                "r_frame_rate": "30/1", "nb_frames": "300",
                "duration": "10.000000",
                "disposition": { "attached_pic": 0 }
            }]
        }"#;
        let meta = meta_from_probe_json(json);
        assert_eq!(
            detect_kind(Path::new("/x/capture.avi"), &meta),
            MediaKind::Video
        );
    }

    /// Extension fallback (no ffprobe metadata) over the full lists, including
    /// the formats the import dialog doesn't offer, plus the Video default.
    #[test]
    fn detect_kind_extension_fallback_full_matrix() {
        let empty = MediaMetadata::default();
        let cases: &[(&str, MediaKind)] = &[
            ("/x/a.m4v", MediaKind::Video),
            ("/x/a.webm", MediaKind::Video),
            ("/x/a.opus", MediaKind::Audio),
            ("/x/a.m4a", MediaKind::Audio),
            ("/x/a.flac", MediaKind::Audio),
            ("/x/a.ogg", MediaKind::Audio),
            ("/x/a.webp", MediaKind::Image),
            ("/x/a.bmp", MediaKind::Image),
            ("/x/a.tiff", MediaKind::Image),
            ("/x/a.gif", MediaKind::Image),
            ("/x/a.avif", MediaKind::Image),
            ("/x/a.apng", MediaKind::Image),
            ("/x/a.ass", MediaKind::Subtitle),
            ("/x/a.vtt", MediaKind::Subtitle),
            ("/x/a.unknown-ext", MediaKind::Video),
            ("/x/no-extension", MediaKind::Video),
        ];
        for (file, want) in cases {
            assert_eq!(detect_kind(Path::new(file), &empty), *want, "{file}");
        }
    }

    /// End-to-end against the REAL ffprobe: generate one sample per media
    /// shape with ffmpeg and assert `probe_metadata` + `detect_kind` classify
    /// it correctly. The JSON-fixture tests above pin the parsing logic; this
    /// one catches ffprobe OUTPUT drift (new field names, changed defaults).
    /// Self-skips (whole test or per-case) when ffmpeg/an encoder is missing.
    #[test]
    fn detect_kind_against_real_ffprobe() {
        use std::process::Command as StdCommand;
        let ffmpeg_ok = StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ffmpeg_ok || !ffprobe_is_installed() {
            eprintln!("ffmpeg/ffprobe not on PATH — skipping real-probe classification");
            return;
        }
        let dir = TempDir::new().unwrap();
        let gen = |args: &[&str], out: &std::path::Path| -> bool {
            StdCommand::new("ffmpeg")
                .args(["-y", "-hide_banner", "-loglevel", "error"])
                .args(args)
                .arg(out)
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };

        let png = dir.path().join("chart.png");
        assert!(
            gen(
                &["-f", "lavfi", "-i", "testsrc2=size=64x48:rate=1:duration=1", "-frames:v", "1"],
                &png
            ),
            "png fixture"
        );

        // (file, ffmpeg args, expected kind, expect_video_meta)
        let mut cases: Vec<(std::path::PathBuf, MediaKind, bool)> = vec![(png.clone(), MediaKind::Image, true)];
        let png_arg = png.to_str().unwrap().to_string();
        let derived: &[(&str, Vec<String>, MediaKind, bool)] = &[
            ("chart.jpg", vec!["-i".into(), png_arg.clone()], MediaKind::Image, true),
            ("chart.gif", vec!["-i".into(), png_arg.clone()], MediaKind::Image, true),
            (
                "anim.gif",
                vec!["-f".into(), "lavfi".into(), "-i".into(), "testsrc2=size=64x48:rate=5:duration=2".into()],
                MediaKind::Image,
                true,
            ),
            (
                "plain.wav",
                vec!["-f".into(), "lavfi".into(), "-i".into(), "sine=frequency=1000:duration=1".into(), "-ac".into(), "1".into()],
                MediaKind::Audio,
                false,
            ),
            (
                "plain.mp3",
                vec!["-f".into(), "lavfi".into(), "-i".into(), "sine=frequency=1000:duration=1".into(), "-ac".into(), "1".into()],
                MediaKind::Audio,
                false,
            ),
            // mp3 with embedded cover art: the attached_pic stream must be
            // ignored (no video meta, classifies Audio).
            (
                "cover.mp3",
                vec![
                    "-f".into(), "lavfi".into(), "-i".into(), "sine=frequency=1000:duration=1".into(),
                    "-i".into(), png_arg.clone(),
                    "-map".into(), "0:a".into(), "-map".into(), "1:v".into(),
                    "-c:v".into(), "mjpeg".into(),
                    "-disposition:v".into(), "attached_pic".into(),
                ],
                MediaKind::Audio,
                false,
            ),
            (
                "plain.m4a",
                vec!["-f".into(), "lavfi".into(), "-i".into(), "sine=frequency=1000:duration=1".into(), "-c:a".into(), "aac".into()],
                MediaKind::Audio,
                false,
            ),
        ];
        for (name, args, kind, has_video) in derived {
            let out = dir.path().join(name);
            let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            if !gen(&argv, &out) {
                // Encoder missing on this build (e.g. no libmp3lame) — skip
                // the case rather than fail the suite.
                eprintln!("ffmpeg could not generate {name} — skipping case");
                continue;
            }
            cases.push((out, *kind, *has_video));
        }

        for (file, want, has_video) in &cases {
            let meta = probe_metadata(file);
            assert_eq!(
                meta.video.is_some(),
                *has_video,
                "{} video-meta presence",
                file.display()
            );
            assert_eq!(
                &detect_kind(file, &meta),
                want,
                "{} classification (meta: video={:?} audio={:?} dur={:?})",
                file.display(),
                meta.video.as_ref().map(|v| (&v.codec, v.nb_frames)),
                meta.audio.as_ref().map(|a| &a.codec),
                meta.duration_us,
            );
        }
    }

    #[test]
    fn keyframe_gap_handles_each_arity() {
        // No keyframes parsed → unknown.
        assert_eq!(max_keyframe_gap_secs(&[], 12.0), None);
        // Single keyframe in the window → at least the window length (long).
        assert_eq!(max_keyframe_gap_secs(&[0.0], 12.0), Some(12.0));
        // Regular ~0.2 s GOP → small max gap.
        let dense: Vec<f64> = (0..40).map(|i| i as f64 * 0.2).collect();
        assert!((max_keyframe_gap_secs(&dense, 12.0).unwrap() - 0.2).abs() < 1e-9);
        // Sparse / unsorted: reports the LARGEST consecutive gap (~6 s).
        assert!((max_keyframe_gap_secs(&[6.0, 0.0], 12.0).unwrap() - 6.0).abs() < 1e-9);
    }
}
