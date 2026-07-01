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

use anyhow::{Context, Result, anyhow};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::process::NoConsoleWindow;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
use crate::state::{MediaItem, MediaKind};

pub const MAGIC: &[u8; 8] = b"VPEAKS\0\0";
pub const VERSION: u32 = 1;
pub const SAMPLE_RATE: u32 = 22_050;
pub const PEAKS_PER_SECOND: u32 = 100;
pub const SAMPLES_PER_PEAK: usize = (SAMPLE_RATE / PEAKS_PER_SECOND) as usize;

/// v2 on-disk format version, written into the header. Distinct from the v1
/// `VERSION` (= 1) so both readers compile during the migration; the v1
/// constant is removed in Task 3 once no code reads the v1 layout.
pub const FORMAT_VERSION_V2: u32 = 2;
/// Finest stored LOD. Coarser levels halve this until ~1/sec.
pub const BASE_PEAKS_PER_SECOND: u32 = 1000;
pub const MAX_CHANNELS: usize = 2;

const HEADER_FIXED_BYTES: u64 = 8 + 4 + 4 + 4 + 4; // magic+version+rate+channels+level_count
const LEVEL_ENTRY_BYTES: u64 = 4 + 4 + 8; // pps + peak_count + data_offset

/// One resolution level's peaks for all channels, planar: `mins[ch]`, `maxs[ch]`.
#[derive(Clone, Debug)]
pub struct LevelData {
    pub channels: u32,
    pub peak_count: u32,
    pub mins: Vec<Vec<i16>>,
    pub maxs: Vec<Vec<i16>>,
}

#[derive(Clone, Copy, Debug)]
pub struct PeakLevel {
    pub peaks_per_second: u32,
    pub peak_count: u32,
}

#[derive(Clone, Debug)]
pub struct V2Header {
    pub channels: u32,
    pub levels: Vec<PeakLevel>,
}

#[inline]
pub fn quantize(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

#[inline]
pub fn dequantize(v: i16) -> f32 {
    v as f32 / i16::MAX as f32
}

/// Write a v2 peaks file. `levels` is finest-first; each entry pairs a
/// peaks-per-second with its channel-planar min/max data.
pub async fn write_v2_with_pps(
    path: &std::path::Path,
    channels: u32,
    levels: &[(u32, LevelData)],
) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    // Compute data offsets: header + level table, then each level's bytes.
    let table_bytes = LEVEL_ENTRY_BYTES * levels.len() as u64;
    let mut offset = HEADER_FIXED_BYTES + table_bytes;
    let mut offsets = Vec::with_capacity(levels.len());
    for (_, d) in levels {
        offsets.push(offset);
        offset += (channels as u64) * (d.peak_count as u64) * 4; // 2×i16 per window
    }

    let mut buf: Vec<u8> = Vec::with_capacity(offset as usize);
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&FORMAT_VERSION_V2.to_le_bytes());
    buf.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&(levels.len() as u32).to_le_bytes());
    for (i, (pps, d)) in levels.iter().enumerate() {
        buf.extend_from_slice(&pps.to_le_bytes());
        buf.extend_from_slice(&d.peak_count.to_le_bytes());
        buf.extend_from_slice(&offsets[i].to_le_bytes());
    }
    for (_, d) in levels {
        for ch in 0..channels as usize {
            for w in 0..d.peak_count as usize {
                buf.extend_from_slice(&d.mins[ch][w].to_le_bytes());
                buf.extend_from_slice(&d.maxs[ch][w].to_le_bytes());
            }
        }
    }

    let mut f = tokio::fs::File::create(path)
        .await
        .with_context(|| format!("create {}", path.display()))?;
    f.write_all(&buf).await.with_context(|| format!("write {}", path.display()))?;
    f.flush().await.with_context(|| format!("flush {}", path.display()))?;
    Ok(())
}

pub fn read_v2_header(path: &std::path::Path) -> Result<V2Header> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut fixed = [0u8; HEADER_FIXED_BYTES as usize];
    f.read_exact(&mut fixed).context("read v2 fixed header")?;
    if &fixed[..8] != MAGIC {
        anyhow::bail!("bad magic in peaks file");
    }
    let version = u32::from_le_bytes(fixed[8..12].try_into().unwrap());
    if version != FORMAT_VERSION_V2 {
        anyhow::bail!("unsupported peaks version {version}");
    }
    let channels = u32::from_le_bytes(fixed[16..20].try_into().unwrap());
    let level_count = u32::from_le_bytes(fixed[20..24].try_into().unwrap()) as usize;
    let mut table = vec![0u8; level_count * LEVEL_ENTRY_BYTES as usize];
    f.read_exact(&mut table).context("read v2 level table")?;
    let mut levels = Vec::with_capacity(level_count);
    for i in 0..level_count {
        let base = i * LEVEL_ENTRY_BYTES as usize;
        levels.push(PeakLevel {
            peaks_per_second: u32::from_le_bytes(table[base..base + 4].try_into().unwrap()),
            peak_count: u32::from_le_bytes(table[base + 4..base + 8].try_into().unwrap()),
        });
    }
    Ok(V2Header { channels, levels })
}

/// Read `count` (min,max) windows for one channel of one level, starting at
/// `start_peak`. Clamps the range to the level's peak_count.
pub fn read_v2_range(
    path: &std::path::Path,
    level_idx: usize,
    channel: usize,
    start_peak: u32,
    count: u32,
) -> Result<(Vec<i16>, Vec<i16>)> {
    use std::io::{Read, Seek, SeekFrom};
    let header = read_v2_header(path)?;
    let level = *header
        .levels
        .get(level_idx)
        .ok_or_else(|| anyhow!("level {level_idx} out of range"))?;
    let ch = channel.min(header.channels.saturating_sub(1) as usize);
    let start = start_peak.min(level.peak_count);
    let end = (start + count).min(level.peak_count);
    let n = (end - start) as usize;
    if n == 0 {
        return Ok((Vec::new(), Vec::new()));
    }

    // data_offset lives in the on-disk table; recompute it the same way write did.
    let table_bytes = LEVEL_ENTRY_BYTES * header.levels.len() as u64;
    let mut level_start = HEADER_FIXED_BYTES + table_bytes;
    for l in &header.levels[..level_idx] {
        level_start += (header.channels as u64) * (l.peak_count as u64) * 4;
    }
    let channel_start = level_start + (ch as u64) * (level.peak_count as u64) * 4;
    let seek_to = channel_start + (start as u64) * 4;

    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    f.seek(SeekFrom::Start(seek_to)).context("seek v2 range")?;
    let mut bytes = vec![0u8; n * 4];
    f.read_exact(&mut bytes).context("read v2 range")?;
    let mut mins = Vec::with_capacity(n);
    let mut maxs = Vec::with_capacity(n);
    for w in 0..n {
        let b = w * 4;
        mins.push(i16::from_le_bytes([bytes[b], bytes[b + 1]]));
        maxs.push(i16::from_le_bytes([bytes[b + 2], bytes[b + 3]]));
    }
    Ok((mins, maxs))
}

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
        .no_console_window()
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

/// Read a peaks file and return the peaks array. Consumed by the waveform media
/// command, the `detect_silences` MCP tool, and the `media://{id}/waveform`
/// MCP resource.
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

    use crate::state::{AudioStreamMeta, DecodeRoute, MediaKind, MediaMetadata, new_id};

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
                    start_pts_us: None,
                }),
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
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
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
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

    #[test]
    fn v2_write_read_header_and_range() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("test.v2.peaks");

        // Two levels, stereo. Finest: 4 windows; coarse: 2 windows.
        let fine = LevelData {
            channels: 2,
            peak_count: 4,
            mins: vec![vec![-1000, -2000, -3000, -4000], vec![-10, -20, -30, -40]],
            maxs: vec![vec![1000, 2000, 3000, 4000], vec![10, 20, 30, 40]],
        };
        let coarse = LevelData {
            channels: 2,
            peak_count: 2,
            mins: vec![vec![-2000, -4000], vec![-20, -40]],
            maxs: vec![vec![2000, 4000], vec![20, 40]],
        };
        let levels = vec![
            (BASE_PEAKS_PER_SECOND, fine),
            (BASE_PEAKS_PER_SECOND / 2, coarse),
        ];
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            write_v2_with_pps(&path, 2, &levels).await
        }).unwrap();

        let header = read_v2_header(&path).expect("header");
        assert_eq!(header.channels, 2);
        assert_eq!(header.levels.len(), 2);
        assert_eq!(header.levels[0].peaks_per_second, BASE_PEAKS_PER_SECOND);
        assert_eq!(header.levels[0].peak_count, 4);
        assert_eq!(header.levels[1].peaks_per_second, BASE_PEAKS_PER_SECOND / 2);

        // Range read: level 0, channel 1, windows [1,3)
        let (mins, maxs) = read_v2_range(&path, 0, 1, 1, 2).expect("range");
        assert_eq!(mins, vec![-20, -30]);
        assert_eq!(maxs, vec![20, 30]);

        // Clamp past the end.
        let (mins, _) = read_v2_range(&path, 0, 0, 3, 10).expect("clamped range");
        assert_eq!(mins, vec![-4000]);
    }
}
