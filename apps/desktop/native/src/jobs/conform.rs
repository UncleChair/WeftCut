//! Canonical audio conform — decodes any audio-bearing source once, at
//! import, into 48 kHz f32le interleaved PCM (`VCONF` header + raw frames).
//! Both the preview mixer (weftcut-media:// Range windows) and the export mixer
//! (direct frame-offset reads) consume this file and never decode audio
//! themselves. Spec: docs/audio.md §The conform cache.
//!
//! File layout (little-endian):
//! ```text
//! magic:        [u8; 8]  = b"VCONF\0\0\0"
//! version:      u32      = 1 (CONFORM_FORMAT_VERSION)
//! sample_rate:  u32      = 48000
//! channels:     u32      (1 | 2 — mono stays mono, >2ch downmix to stereo)
//! frame_count:  u64
//! data:         interleaved f32le samples (frame_count * channels * 4 bytes)
//! ```

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::process::NoConsoleWindow;

use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path, CacheLayout};
use crate::state::{MediaItem, MediaKind};

pub const MAGIC: &[u8; 8] = b"VCONF\0\0\0";
pub const CONFORM_FORMAT_VERSION: u32 = 1;
pub const CONFORM_SAMPLE_RATE: u32 = 48_000;
pub const HEADER_LEN: u64 = 28;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConformHeader {
    pub version: u32,
    pub sample_rate: u32,
    pub channels: u32,
    pub frame_count: u64,
}

impl ConformHeader {
    pub fn byte_offset_of_frame(&self, frame: u64) -> u64 {
        HEADER_LEN + frame * self.channels as u64 * 4
    }
}

pub fn read_header(path: &Path) -> Result<ConformHeader> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut head = [0u8; HEADER_LEN as usize];
    f.read_exact(&mut head)
        .with_context(|| format!("read header of {}", path.display()))?;
    if &head[..8] != MAGIC {
        anyhow::bail!("bad magic in conform file {}", path.display());
    }
    let version = u32::from_le_bytes(head[8..12].try_into().unwrap());
    if version != CONFORM_FORMAT_VERSION {
        anyhow::bail!("unsupported conform version {version}");
    }
    let sample_rate = u32::from_le_bytes(head[12..16].try_into().unwrap());
    let channels = u32::from_le_bytes(head[16..20].try_into().unwrap());
    if channels == 0 || channels > 2 {
        anyhow::bail!("conform channels {channels} out of range");
    }
    let frame_count = u64::from_le_bytes(head[20..28].try_into().unwrap());
    Ok(ConformHeader {
        version,
        sample_rate,
        channels,
        frame_count,
    })
}

pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot conform audio");
    }
    let Some(audio_meta) = media.metadata.audio.as_ref() else {
        anyhow::bail!("media has no audio stream");
    };
    if !matches!(media.kind, MediaKind::Video | MediaKind::Audio) {
        anyhow::bail!("conform only valid for Video / Audio media");
    }

    let dest = cache.audio_conform(&media.file_hash_blake3);
    if cached_ok(&dest) {
        // Format-version check: stale versions regenerate.
        if read_header(&dest)
            .map(|h| h.version == CONFORM_FORMAT_VERSION)
            .unwrap_or(false)
        {
            return Ok(dest);
        }
        let _ = tokio::fs::remove_file(&dest).await;
    }

    // Mono stays mono; everything else (stereo and >2ch) lands stereo.
    let out_channels: u32 = if audio_meta.channels <= 1 { 1 } else { 2 };

    let tmp = temp_path(&dest);
    let _ = tokio::fs::remove_file(&tmp).await;

    let mut child = Command::new(ffmpeg_path())
        .no_console_window()
        // Reap on future-drop so no orphan keeps writing the shared temp; see
        // hwaccel.rs.
        .kill_on_drop(true)
        .args(["-hide_banner", "-nostats", "-loglevel", "error", "-i"])
        .arg(&media.path_abs)
        .args([
            "-vn",
            "-ac",
            &out_channels.to_string(),
            "-ar",
            &CONFORM_SAMPLE_RATE.to_string(),
            "-f",
            "f32le",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn ffmpeg for conform")?;

    let mut stdout = child.stdout.take().expect("stdout was piped");

    // Stream to the temp file with a placeholder frame_count, then patch
    // the header once the byte total is known.
    let mut f = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("create {}", tmp.display()))?;
    let mut head = Vec::with_capacity(HEADER_LEN as usize);
    head.extend_from_slice(MAGIC);
    head.extend_from_slice(&CONFORM_FORMAT_VERSION.to_le_bytes());
    head.extend_from_slice(&CONFORM_SAMPLE_RATE.to_le_bytes());
    head.extend_from_slice(&out_channels.to_le_bytes());
    head.extend_from_slice(&0u64.to_le_bytes()); // frame_count patched below
    f.write_all(&head).await.context("write conform header")?;

    let mut total_bytes: u64 = 0;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = stdout.read(&mut buf).await.context("read ffmpeg stdout")?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n]).await.context("write conform data")?;
        total_bytes += n as u64;
    }

    let output = child
        .wait_with_output()
        .await
        .context("await ffmpeg for conform")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        drop(f);
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg exited with {} for conform: {}",
            output.status,
            stderr.trim()
        );
    }

    let bytes_per_frame = out_channels as u64 * 4;
    if total_bytes % bytes_per_frame != 0 {
        // Truncate a torn trailing frame rather than fail — ffmpeg's f32le
        // stream is frame-aligned in practice; this is belt-and-braces.
        total_bytes -= total_bytes % bytes_per_frame;
    }
    let frame_count = total_bytes / bytes_per_frame;
    if frame_count == 0 {
        drop(f);
        discard_temp(&dest);
        anyhow::bail!(
            "conform produced zero frames for {}",
            media.path_abs.display()
        );
    }

    use tokio::io::AsyncSeekExt;
    f.seek(std::io::SeekFrom::Start(20))
        .await
        .context("seek to frame_count")?;
    f.write_all(&frame_count.to_le_bytes())
        .await
        .context("patch frame_count")?;
    f.flush().await.context("flush conform")?;
    drop(f);

    promote_temp(&dest)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

    use crate::state::{new_id, AudioStreamMeta, DecodeRoute, MediaKind, MediaMetadata};

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// 1-second 1 kHz MONO sine at 44.1 kHz — exercises both the resample
    /// (44.1→48k) and the mono-stays-mono channel policy.
    async fn make_test_audio(dest: &std::path::Path) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:duration=1",
                "-ac",
                "1",
                "-ar",
                "44100",
            ])
            .arg(dest)
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("fixture ffmpeg failed: {status}");
        }
        Ok(())
    }

    fn media_for(path: PathBuf, channels: u8, hash: &str) -> MediaItem {
        MediaItem {
            id: new_id(),
            label: Some("source.wav".into()),
            path_abs: path,
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: Some(AudioStreamMeta {
                    sample_rate: 44100,
                    channels,
                    codec: "pcm_s16le".into(),
                    start_pts_us: None,
                }),
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: hash.into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn conform_mono_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping conform smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let audio = tmp.path().join("source.wav");
        make_test_audio(&audio).await.expect("fixture");

        let path = run(&cache, &media_for(audio, 1, "deadbeef-cf"))
            .await
            .expect("conform");
        assert!(cached_ok(&path));

        let h = read_header(&path).expect("header");
        assert_eq!(h.sample_rate, CONFORM_SAMPLE_RATE);
        assert_eq!(h.channels, 1, "mono source must stay mono");
        // 1 s at 48 kHz, resampler edge tolerance.
        assert!(
            (47_900..=48_100).contains(&(h.frame_count as i64)),
            "expected ~48000 frames, got {}",
            h.frame_count
        );
        // Body length must match the header exactly.
        let len = std::fs::metadata(&path).unwrap().len();
        assert_eq!(len, h.byte_offset_of_frame(h.frame_count));
        // Sanity on content: a sine's max |sample| is well above silence
        // and below clipping.
        let bytes = std::fs::read(&path).unwrap();
        let mut max = 0.0_f32;
        for c in bytes[HEADER_LEN as usize..].chunks_exact(4) {
            max = max.max(f32::from_le_bytes([c[0], c[1], c[2], c[3]]).abs());
        }
        assert!(max > 0.05 && max <= 1.01, "max sample {max}");
    }

    /// The conform contract across the audio formats the import dialog
    /// offers (wav/mp3/flac/m4a/ogg) plus opus: every one must decode to a
    /// well-formed 48 kHz mono VCONF. The decoder is ffmpeg's auto-discovery
    /// (no allowlist in `run`), so this is the test that actually pins the
    /// supported-format range. Lossy codecs carry encoder priming/padding, so
    /// their frame-count tolerance is wider than the lossless ones'.
    #[tokio::test]
    async fn conform_format_matrix_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping conform format matrix");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        // (file, extra encode args, lossless). 1 s of 1 kHz mono sine;
        // 44.1 kHz source except opus (libopus wants 48 k).
        let cases: &[(&str, &[&str], bool)] = &[
            ("tone.wav", &[], true),
            ("tone.flac", &[], true),
            ("tone.mp3", &[], false),
            ("tone.m4a", &["-c:a", "aac"], false),
            ("tone.ogg", &["-c:a", "libvorbis"], false),
            ("tone.opus", &["-c:a", "libopus"], false),
        ];
        for (name, extra, lossless) in cases {
            let src = tmp.path().join(name);
            let rate = if *name == "tone.opus" {
                "48000"
            } else {
                "44100"
            };
            let status = Command::new("ffmpeg")
                .args(["-y", "-hide_banner", "-loglevel", "error"])
                .args(["-f", "lavfi", "-i", "sine=frequency=1000:duration=1"])
                .args(["-ac", "1", "-ar", rate])
                .args(*extra)
                .arg(&src)
                .status()
                .await
                .expect("spawn ffmpeg");
            if !status.success() {
                // Encoder not in this ffmpeg build (e.g. no libmp3lame) —
                // skip the case rather than fail the suite.
                eprintln!("ffmpeg could not encode {name} — skipping case");
                continue;
            }

            let path = run(&cache, &media_for(src, 1, &format!("hash-{name}")))
                .await
                .unwrap_or_else(|e| panic!("conform {name}: {e:#}"));
            let h = read_header(&path).expect("header");
            assert_eq!(h.sample_rate, CONFORM_SAMPLE_RATE, "{name}");
            assert_eq!(h.channels, 1, "{name}: mono stays mono");
            let range = if *lossless {
                47_900..=48_100
            } else {
                46_000..=50_500
            };
            assert!(
                range.contains(&(h.frame_count as i64)),
                "{name}: expected ~48000 frames, got {}",
                h.frame_count
            );
            let len = std::fs::metadata(&path).unwrap().len();
            assert_eq!(
                len,
                h.byte_offset_of_frame(h.frame_count),
                "{name}: body length"
            );
            let bytes = std::fs::read(&path).unwrap();
            let mut max = 0.0_f32;
            for c in bytes[HEADER_LEN as usize..].chunks_exact(4) {
                max = max.max(f32::from_le_bytes([c[0], c[1], c[2], c[3]]).abs());
            }
            assert!(max > 0.05 && max <= 1.01, "{name}: max sample {max}");
        }
    }

    #[tokio::test]
    async fn rejects_media_without_audio() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let mut m = media_for(tmp.path().join("nope.mp4"), 1, "noaudio");
        m.kind = MediaKind::Video;
        m.metadata.audio = None;
        let err = run(&cache, &m).await.expect_err("no audio stream");
        assert!(format!("{err:#}").contains("no audio stream"));
    }
}
