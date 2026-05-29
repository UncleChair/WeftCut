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

pub fn detect_kind(path: &Path, metadata: &MediaMetadata) -> MediaKind {
    if metadata.video.is_some() {
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
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" => MediaKind::Image,
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
            match stream {
                RawStream::Video {
                    width,
                    height,
                    r_frame_rate,
                    codec_name,
                    pix_fmt,
                    duration,
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
        }
    }
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
            }),
            audio: None,
        };
        // Even with `.bin` extension the probe wins.
        assert_eq!(
            detect_kind(Path::new("/x/blob.bin"), &with_video),
            MediaKind::Video
        );
    }
}
