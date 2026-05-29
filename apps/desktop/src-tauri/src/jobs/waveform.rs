//! Audio waveform peaks. Decodes the source to mono f32 PCM at 22050 Hz via
//! ffmpeg, computes max-abs per peak window, writes a compact binary file the
//! timeline can scan in one mmap.
//!
//! File layout (little-endian):
//! ```text
//! magic:          [u8; 8]   = b"VPEAKS\0\0"
//! version:        u32       = 1
//! sample_rate:    u32       = 22050
//! samples_per_peak: u32     = 220 (= sample_rate / 100; ~100 peaks/sec)
//! peak_count:     u32
//! peaks:          [f32; peak_count]   (max abs per window, in [0.0, 1.0])
//! ```
//!
//! For a 1-hour clip the peaks file is `60 * 60 * 100 * 4` bytes ≈ 1.4 MB —
//! fits in memory comfortably, scans in milliseconds.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
use crate::state::{MediaItem, MediaKind};

pub const MAGIC: &[u8; 8] = b"VPEAKS\0\0";
pub const VERSION: u32 = 1;
pub const SAMPLE_RATE: u32 = 22_050;
pub const PEAKS_PER_SECOND: u32 = 100;
pub const SAMPLES_PER_PEAK: usize = (SAMPLE_RATE / PEAKS_PER_SECOND) as usize;

pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot generate waveform");
    }
    if !matches!(media.kind, MediaKind::Video | MediaKind::Audio) {
        anyhow::bail!("waveform only valid for Video / Audio media");
    }
    if media.metadata.audio.is_none() && matches!(media.kind, MediaKind::Video) {
        // Video file without an audio stream — skip silently rather than fail.
        // The caller can still return Ok(()) at the spawn layer; we surface
        // it as a hard error here so the spawner can decide.
        anyhow::bail!("video media has no audio stream");
    }

    let dest = cache.waveform(&media.file_hash_blake3);
    if cached_ok(&dest) {
        return Ok(dest);
    }

    let tmp = temp_path(&dest);
    let _ = tokio::fs::remove_file(&tmp).await;

    let mut child = Command::new(ffmpeg_path())
        .args([
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "error",
            "-i",
        ])
        .arg(&media.path_abs)
        .args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "f32le",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn ffmpeg for waveform")?;

    let mut stdout = child.stdout.take().expect("stdout was piped");
    let peaks = compute_peaks(&mut stdout).await?;

    let output = child
        .wait_with_output()
        .await
        .context("await ffmpeg for waveform")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg exited with {} for waveform: {}",
            output.status,
            stderr.trim()
        );
    }

    write_peaks_file(&tmp, &peaks).await?;
    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!("waveform peaks file is empty after write");
    }
    promote_temp(&dest)?;
    Ok(dest)
}

async fn compute_peaks(stdout: &mut tokio::process::ChildStdout) -> Result<Vec<f32>> {
    let mut peaks: Vec<f32> = Vec::new();
    let mut current_max: f32 = 0.0;
    let mut samples_in_window: usize = 0;
    // 64 KiB read chunks — multiple of 4 (one f32 = 4 bytes), big enough to
    // amortize syscall overhead.
    let mut buf = vec![0u8; 64 * 1024];
    let mut leftover = [0u8; 4];
    let mut leftover_len = 0usize;

    loop {
        let n = stdout
            .read(&mut buf)
            .await
            .context("read ffmpeg stdout")?;
        if n == 0 {
            break;
        }
        let mut slice = &buf[..n];
        // Consume any leftover bytes from a prior read that didn't end on a
        // 4-byte boundary.
        if leftover_len > 0 {
            let need = 4 - leftover_len;
            let take = need.min(slice.len());
            leftover[leftover_len..leftover_len + take].copy_from_slice(&slice[..take]);
            leftover_len += take;
            slice = &slice[take..];
            if leftover_len == 4 {
                let sample = f32::from_le_bytes(leftover);
                current_max = current_max.max(sample.abs());
                samples_in_window += 1;
                if samples_in_window >= SAMPLES_PER_PEAK {
                    peaks.push(current_max);
                    current_max = 0.0;
                    samples_in_window = 0;
                }
                leftover_len = 0;
            }
        }
        let aligned_len = slice.len() - (slice.len() % 4);
        for chunk in slice[..aligned_len].chunks_exact(4) {
            let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            current_max = current_max.max(sample.abs());
            samples_in_window += 1;
            if samples_in_window >= SAMPLES_PER_PEAK {
                peaks.push(current_max);
                current_max = 0.0;
                samples_in_window = 0;
            }
        }
        // Save trailing < 4 bytes for the next iteration.
        let tail = &slice[aligned_len..];
        leftover_len = tail.len();
        leftover[..leftover_len].copy_from_slice(tail);
    }
    if samples_in_window > 0 {
        peaks.push(current_max);
    }
    Ok(peaks)
}

async fn write_peaks_file(path: &std::path::Path, peaks: &[f32]) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut buf: Vec<u8> = Vec::with_capacity(8 + 16 + peaks.len() * 4);
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&VERSION.to_le_bytes());
    buf.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    buf.extend_from_slice(&(SAMPLES_PER_PEAK as u32).to_le_bytes());
    buf.extend_from_slice(&(peaks.len() as u32).to_le_bytes());
    for p in peaks {
        buf.extend_from_slice(&p.to_le_bytes());
    }
    let mut f = tokio::fs::File::create(path)
        .await
        .with_context(|| format!("create {}", path.display()))?;
    f.write_all(&buf)
        .await
        .with_context(|| format!("write {}", path.display()))?;
    f.flush()
        .await
        .with_context(|| format!("flush {}", path.display()))?;
    Ok(())
}

/// Read a peaks file and return the peaks array. Used by the future timeline
/// renderer + the `media://{id}/waveform` MCP resource.
pub fn read_peaks_file(path: &std::path::Path) -> Result<Vec<f32>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .with_context(|| format!("open {}", path.display()))?
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {}", path.display()))?;
    if bytes.len() < 8 + 16 {
        anyhow::bail!("peaks file too small ({} bytes)", bytes.len());
    }
    if &bytes[..8] != MAGIC {
        anyhow::bail!("bad magic in peaks file");
    }
    let version = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    if version != VERSION {
        anyhow::bail!("unsupported peaks version {version}");
    }
    let count = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
    let body = &bytes[24..];
    if body.len() < count * 4 {
        anyhow::bail!(
            "peaks file truncated: header claims {count} peaks, body has {} bytes",
            body.len()
        );
    }
    let mut peaks = Vec::with_capacity(count);
    for chunk in body[..count * 4].chunks_exact(4) {
        peaks.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(peaks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

    use crate::state::{AudioStreamMeta, MediaKind, MediaMetadata, new_id};

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// 1-second 1 kHz sine wave WAV via lavfi.
    async fn make_test_audio(dest: &std::path::Path) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args([
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", "sine=frequency=1000:duration=1",
                "-ac", "1",
                "-ar", "44100",
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
    async fn waveform_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping waveform smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let audio = tmp.path().join("source.wav");
        make_test_audio(&audio).await.expect("test fixture");

        let media = MediaItem {
            id: new_id(),
            label: Some("source.wav".into()),
            path_abs: audio,
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: Some(AudioStreamMeta {
                    sample_rate: 44100,
                    channels: 1,
                    codec: "pcm_s16le".into(),
                }),
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "deadbeef-wf".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let path = run(&cache, &media).await.expect("waveform run");
        assert!(cached_ok(&path));

        let peaks = read_peaks_file(&path).expect("read peaks");
        // 1-second source, ~100 peaks/sec = ~100 peaks (within +/- 1 for
        // window alignment).
        assert!(
            (98..=102).contains(&peaks.len()),
            "expected ~100 peaks, got {}",
            peaks.len()
        );
        // For a constant-amplitude 1 kHz sine, every peak window contains
        // multiple full cycles, so max-abs should be ~constant across the
        // file. Don't assert the absolute value (lavfi's `sine` filter
        // default amplitude is implementation-defined); assert peaks are
        // non-zero, all roughly equal, and below clipping.
        let max = peaks.iter().cloned().fold(0.0_f32, f32::max);
        let min = peaks.iter().cloned().fold(f32::MAX, f32::min);
        assert!(max > 0.05, "max peak {max} too low — pipeline likely broken");
        assert!(max <= 1.01, "max peak {max} clipped");
        assert!(
            max - min < max * 0.1,
            "peaks vary too much (min={min}, max={max}) — should be flat for constant sine",
        );
    }

    #[tokio::test]
    async fn rejects_video_without_audio() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

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
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "noaudio".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let err = run(&cache, &media).await.expect_err("video without audio");
        assert!(format!("{err:#}").contains("no audio stream"));
    }

    #[test]
    fn peaks_file_round_trip_offline() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("test.peaks");
        let original = vec![0.1, 0.5, 0.95, 0.0, 1.0];
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async { write_peaks_file(&path, &original).await })
            .unwrap();
        let read_back = read_peaks_file(&path).expect("read back");
        assert_eq!(original, read_back);
    }
}
