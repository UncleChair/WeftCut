//! Audio waveform peaks. Decodes the source to stereo f32 PCM via ffmpeg,
//! builds the finest min/max/RMS level, decimates it into a power-of-two
//! mipmap pyramid, and writes a compact binary file (VPEAKS) the timeline
//! can scan in one mmap at whatever zoom-appropriate resolution it needs.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::process::NoConsoleWindow;

use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path, CacheLayout};
use crate::state::{MediaItem, MediaKind};

pub const MAGIC: &[u8; 8] = b"VPEAKS\0\0";
pub const SAMPLE_RATE: u32 = 22_050;

/// On-disk format version, written into the header. Only the current
/// version has a reader; the cache filename's version tag (see
/// `cache::CacheLayout::waveform`) drives regeneration when the format
/// changes, so there is no legacy reader to keep in sync.
pub const FORMAT_VERSION: u32 = 4;
/// Finest stored LOD. Coarser levels halve this until ~1/sec.
pub const BASE_PEAKS_PER_SECOND: u32 = 1000;
pub const BASE_FRAMES_PER_PEAK: u32 = SAMPLE_RATE / BASE_PEAKS_PER_SECOND;
pub const MAX_CHANNELS: usize = 2;

const HEADER_FIXED_BYTES: u64 = 8 + 4 + 4 + 4 + 4; // magic+version+rate+channels+level_count
const LEVEL_ENTRY_BYTES: u64 = 4 + 4 + 8; // frames_per_peak + peak_count + data_offset

/// One resolution level's peaks for all channels, planar: `mins[ch]`,
/// `maxs[ch]`, `rmss[ch]`.
#[derive(Clone, Debug)]
pub struct LevelData {
    pub channels: u32,
    pub peak_count: u32,
    pub mins: Vec<Vec<i16>>,
    pub maxs: Vec<Vec<i16>>,
    pub rmss: Vec<Vec<u16>>,
}

#[derive(Clone, Copy, Debug)]
pub struct PeakLevel {
    pub frames_per_peak: u32,
    pub peak_count: u32,
}

impl PeakLevel {
    pub fn peaks_per_second(self, sample_rate: u32) -> f64 {
        sample_rate as f64 / self.frames_per_peak as f64
    }
}

#[derive(Clone, Debug)]
pub struct PeaksHeader {
    pub sample_rate: u32,
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

#[inline]
pub fn quantize_rms(v: f32) -> u16 {
    (v.clamp(0.0, 1.0) * u16::MAX as f32).round() as u16
}

#[inline]
pub fn dequantize_rms(v: u16) -> f32 {
    v as f32 / u16::MAX as f32
}

/// Write a peaks file. `levels` is finest-first; each entry pairs a
/// PCM frames-per-peak with its channel-planar min/max/rms data.
pub async fn write_peaks(
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
        offset += (channels as u64) * (d.peak_count as u64) * 6; // min i16 + max i16 + rms u16 per window
    }

    let mut buf: Vec<u8> = Vec::with_capacity(offset as usize);
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    buf.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&(levels.len() as u32).to_le_bytes());
    for (i, (frames_per_peak, d)) in levels.iter().enumerate() {
        buf.extend_from_slice(&frames_per_peak.to_le_bytes());
        buf.extend_from_slice(&d.peak_count.to_le_bytes());
        buf.extend_from_slice(&offsets[i].to_le_bytes());
    }
    for (_, d) in levels {
        for ch in 0..channels as usize {
            for w in 0..d.peak_count as usize {
                buf.extend_from_slice(&d.mins[ch][w].to_le_bytes());
                buf.extend_from_slice(&d.maxs[ch][w].to_le_bytes());
                buf.extend_from_slice(&d.rmss[ch][w].to_le_bytes());
            }
        }
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

pub fn read_header(path: &std::path::Path) -> Result<PeaksHeader> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut fixed = [0u8; HEADER_FIXED_BYTES as usize];
    f.read_exact(&mut fixed).context("read fixed header")?;
    if &fixed[..8] != MAGIC {
        anyhow::bail!("bad magic in peaks file");
    }
    let version = u32::from_le_bytes(fixed[8..12].try_into().unwrap());
    if version != FORMAT_VERSION {
        anyhow::bail!("unsupported peaks version {version}");
    }
    let sample_rate = u32::from_le_bytes(fixed[12..16].try_into().unwrap());
    if sample_rate == 0 {
        anyhow::bail!("invalid zero sample rate in peaks file");
    }
    let channels = u32::from_le_bytes(fixed[16..20].try_into().unwrap());
    let level_count = u32::from_le_bytes(fixed[20..24].try_into().unwrap()) as usize;
    let mut table = vec![0u8; level_count * LEVEL_ENTRY_BYTES as usize];
    f.read_exact(&mut table).context("read level table")?;
    let mut levels = Vec::with_capacity(level_count);
    for i in 0..level_count {
        let base = i * LEVEL_ENTRY_BYTES as usize;
        let frames_per_peak = u32::from_le_bytes(table[base..base + 4].try_into().unwrap());
        if frames_per_peak == 0 {
            anyhow::bail!("invalid zero frames_per_peak for level {i}");
        }
        levels.push(PeakLevel {
            frames_per_peak,
            peak_count: u32::from_le_bytes(table[base + 4..base + 8].try_into().unwrap()),
        });
    }
    if levels.is_empty() {
        anyhow::bail!("peaks file has no levels");
    }
    Ok(PeaksHeader {
        sample_rate,
        channels,
        levels,
    })
}

/// One channel's min/max/rms windows for one LOD level.
pub struct PeaksRange {
    pub peaks_per_second: f64,
    pub min: Vec<i16>,
    pub max: Vec<i16>,
    pub rms: Vec<u16>,
}

/// Read `count` (min,max,rms) windows for one channel of one level, starting
/// at `start_peak`. Clamps the range to the level's peak_count. Returns the
/// level's peaks_per_second alongside the windows — the header is already
/// parsed here, so callers must not re-open the file just to resolve it.
pub fn read_range(
    path: &std::path::Path,
    level_idx: usize,
    channel: usize,
    start_peak: u32,
    count: u32,
) -> Result<PeaksRange> {
    use std::io::{Read, Seek, SeekFrom};
    let header = read_header(path)?;
    let level = *header
        .levels
        .get(level_idx)
        .ok_or_else(|| anyhow!("level {level_idx} out of range"))?;
    if channel >= header.channels as usize {
        anyhow::bail!(
            "channel {channel} out of range (file has {} channels)",
            header.channels
        );
    }
    let ch = channel;
    let start = start_peak.min(level.peak_count);
    let end = (start + count).min(level.peak_count);
    let n = (end - start) as usize;
    if n == 0 {
        return Ok(PeaksRange {
            peaks_per_second: level.peaks_per_second(header.sample_rate),
            min: Vec::new(),
            max: Vec::new(),
            rms: Vec::new(),
        });
    }

    // data_offset lives in the on-disk table; recompute it the same way write did.
    let table_bytes = LEVEL_ENTRY_BYTES * header.levels.len() as u64;
    let mut level_start = HEADER_FIXED_BYTES + table_bytes;
    for l in &header.levels[..level_idx] {
        level_start += (header.channels as u64) * (l.peak_count as u64) * 6;
    }
    let channel_start = level_start + (ch as u64) * (level.peak_count as u64) * 6;
    let seek_to = channel_start + (start as u64) * 6;

    let mut f = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    f.seek(SeekFrom::Start(seek_to))
        .context("seek peaks range")?;
    let mut bytes = vec![0u8; n * 6];
    f.read_exact(&mut bytes).context("read peaks range")?;
    let mut min = Vec::with_capacity(n);
    let mut max = Vec::with_capacity(n);
    let mut rms = Vec::with_capacity(n);
    for w in 0..n {
        let b = w * 6;
        min.push(i16::from_le_bytes([bytes[b], bytes[b + 1]]));
        max.push(i16::from_le_bytes([bytes[b + 2], bytes[b + 3]]));
        rms.push(u16::from_le_bytes([bytes[b + 4], bytes[b + 5]]));
    }
    Ok(PeaksRange {
        peaks_per_second: level.peaks_per_second(header.sample_rate),
        min,
        max,
        rms,
    })
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
        .args(["-hide_banner", "-nostats", "-loglevel", "error", "-i"])
        .arg(&media.path_abs)
        .args([
            "-vn",
            "-ac",
            "2",
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
    // Downmix target is 2ch; a mono source still decodes to 2 identical channels
    // under `-ac 2`, so the reader/writer path is uniform.
    let channels = MAX_CHANNELS;
    let finest = compute_finest_level(&mut stdout, channels).await?;

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

    let pyramid = build_pyramid(finest);
    write_peaks(&tmp, channels as u32, &pyramid).await?;
    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!("waveform peaks file is empty after write");
    }
    promote_temp(&dest)?;
    cache.notify_write();
    Ok(dest)
}

/// Decode interleaved stereo f32 PCM from ffmpeg's stdout into the finest
/// (highest-resolution) min/max/rms level. One peak window is
/// `SAMPLE_RATE / BASE_PEAKS_PER_SECOND` frames; `decimate`/`decimate_rms`/
/// `build_pyramid` derive every coarser LOD from this level, so it's the
/// only pass that touches the raw PCM stream.
async fn compute_finest_level(
    stdout: &mut tokio::process::ChildStdout,
    channels: usize,
) -> Result<LevelData> {
    let frames_per_peak = BASE_FRAMES_PER_PEAK as usize;
    let mut mins: Vec<Vec<i16>> = vec![Vec::new(); channels];
    let mut maxs: Vec<Vec<i16>> = vec![Vec::new(); channels];
    let mut rmss: Vec<Vec<u16>> = vec![Vec::new(); channels];
    let mut cur_min = vec![f32::MAX; channels];
    let mut cur_max = vec![f32::MIN; channels];
    let mut cur_sq = vec![0.0f64; channels];
    let mut frames_in_window = 0usize;
    let mut ch = 0usize;

    // 64 KiB read chunks — multiple of 4 (one f32 = 4 bytes), big enough to
    // amortize syscall overhead.
    let mut buf = vec![0u8; 64 * 1024];
    let mut leftover = [0u8; 4];
    let mut leftover_len = 0usize;

    fn consume(
        sample: f32,
        channels: usize,
        ch: &mut usize,
        frames_in_window: &mut usize,
        frames_per_peak: usize,
        cur_min: &mut [f32],
        cur_max: &mut [f32],
        cur_sq: &mut [f64],
        mins: &mut [Vec<i16>],
        maxs: &mut [Vec<i16>],
        rmss: &mut [Vec<u16>],
    ) {
        cur_min[*ch] = cur_min[*ch].min(sample);
        cur_max[*ch] = cur_max[*ch].max(sample);
        cur_sq[*ch] += (sample as f64) * (sample as f64);
        *ch += 1;
        if *ch == channels {
            *ch = 0;
            *frames_in_window += 1;
            if *frames_in_window >= frames_per_peak {
                for c in 0..channels {
                    mins[c].push(quantize(if cur_min[c] == f32::MAX {
                        0.0
                    } else {
                        cur_min[c]
                    }));
                    maxs[c].push(quantize(if cur_max[c] == f32::MIN {
                        0.0
                    } else {
                        cur_max[c]
                    }));
                    rmss[c].push(quantize_rms(
                        (cur_sq[c] / frames_per_peak as f64).sqrt() as f32
                    ));
                    cur_min[c] = f32::MAX;
                    cur_max[c] = f32::MIN;
                    cur_sq[c] = 0.0;
                }
                *frames_in_window = 0;
            }
        }
    }

    loop {
        let n = stdout.read(&mut buf).await.context("read ffmpeg stdout")?;
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
                let s = f32::from_le_bytes(leftover);
                consume(
                    s,
                    channels,
                    &mut ch,
                    &mut frames_in_window,
                    frames_per_peak,
                    &mut cur_min,
                    &mut cur_max,
                    &mut cur_sq,
                    &mut mins,
                    &mut maxs,
                    &mut rmss,
                );
            }
        }
        let aligned = slice.len() - (slice.len() % 4);
        for chunk in slice[..aligned].chunks_exact(4) {
            let s = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            consume(
                s,
                channels,
                &mut ch,
                &mut frames_in_window,
                frames_per_peak,
                &mut cur_min,
                &mut cur_max,
                &mut cur_sq,
                &mut mins,
                &mut maxs,
                &mut rmss,
            );
        }
        // Save trailing < 4 bytes for the next iteration.
        let tail = &slice[aligned..];
        leftover_len = tail.len();
        leftover[..leftover_len].copy_from_slice(tail);
    }
    // Flush a partial trailing window — divides by its actual frame count,
    // not `frames_per_peak`, since it never reached a full window.
    if frames_in_window > 0 {
        for c in 0..channels {
            mins[c].push(quantize(if cur_min[c] == f32::MAX {
                0.0
            } else {
                cur_min[c]
            }));
            maxs[c].push(quantize(if cur_max[c] == f32::MIN {
                0.0
            } else {
                cur_max[c]
            }));
            rmss[c].push(quantize_rms(
                (cur_sq[c] / frames_in_window as f64).sqrt() as f32
            ));
        }
    }
    let peak_count = mins[0].len() as u32;
    Ok(LevelData {
        channels: channels as u32,
        peak_count,
        mins,
        maxs,
        rmss,
    })
}

/// Halve resolution by pairwise min/max. An odd trailing window is paired
/// with itself so `out_len == mins.len().div_ceil(2)`.
fn decimate(mins: &[i16], maxs: &[i16]) -> (Vec<i16>, Vec<i16>) {
    let out_len = mins.len().div_ceil(2);
    let mut dmin = Vec::with_capacity(out_len);
    let mut dmax = Vec::with_capacity(out_len);
    let mut i = 0;
    while i < mins.len() {
        let j = (i + 1).min(mins.len() - 1);
        dmin.push(mins[i].min(mins[j]));
        dmax.push(maxs[i].max(maxs[j]));
        i += 2;
    }
    (dmin, dmax)
}

/// Halve resolution by pairwise RMS-of-RMS: `sqrt((a² + b²) / 2)` is the RMS
/// of the two equal-length windows concatenated. An odd trailing window
/// pairs with itself, which reduces to the identity (`sqrt((a²+a²)/2) = a`),
/// matching `decimate`'s self-pairing convention.
fn decimate_rms(rmss: &[u16]) -> Vec<u16> {
    let out_len = rmss.len().div_ceil(2);
    let mut out = Vec::with_capacity(out_len);
    let mut i = 0;
    while i < rmss.len() {
        let j = (i + 1).min(rmss.len() - 1);
        let a = dequantize_rms(rmss[i]) as f64;
        let b = dequantize_rms(rmss[j]) as f64;
        out.push(quantize_rms((((a * a) + (b * b)) / 2.0).sqrt() as f32));
        i += 2;
    }
    out
}

/// Build the finest-first LOD pyramid. The on-disk timebase is the exact
/// number of source PCM frames represented by each peak; each subsequent
/// level doubles that value while its peak_count is halved via
/// `decimate`, down to ~1/sec (or a single window, whichever is reached first).
fn build_pyramid(finest: LevelData) -> Vec<(u32, LevelData)> {
    let channels = finest.channels as usize;
    let mut out: Vec<(u32, LevelData)> = vec![(BASE_FRAMES_PER_PEAK, finest)];
    let mut frames_per_peak = BASE_FRAMES_PER_PEAK;
    loop {
        let (_, prev) = out.last().unwrap();
        if prev.peak_count <= 1 || frames_per_peak >= SAMPLE_RATE {
            break;
        }
        let mut mins = Vec::with_capacity(channels);
        let mut maxs = Vec::with_capacity(channels);
        let mut rmss = Vec::with_capacity(channels);
        for c in 0..channels {
            let (dmin, dmax) = decimate(&prev.mins[c], &prev.maxs[c]);
            mins.push(dmin);
            maxs.push(dmax);
            rmss.push(decimate_rms(&prev.rmss[c]));
        }
        let peak_count = mins[0].len() as u32;
        frames_per_peak = frames_per_peak.saturating_mul(2);
        out.push((
            frames_per_peak,
            LevelData {
                channels: channels as u32,
                peak_count,
                mins,
                maxs,
                rmss,
            },
        ));
    }
    out
}

/// Max-abs peaks plus their exact PCM timebase for compatibility consumers
/// such as silence detection and the legacy whole-waveform command.
pub struct PeaksFile {
    pub peaks: Vec<f32>,
    pub sample_rate: u32,
    pub frames_per_peak: u32,
}

pub fn read_peaks_file(path: &std::path::Path) -> Result<PeaksFile> {
    let header = read_header(path)?;
    // Pick the level nearest 100 peaks/sec while remaining at or above it.
    // Crucially, return that level's exact rational timebase rather than
    // resampling it to a nominal integer rate.
    const TARGET_PEAKS_PER_SECOND: f64 = 100.0;
    let (level_idx, level) = header
        .levels
        .iter()
        .enumerate()
        .filter(|(_, l)| l.peaks_per_second(header.sample_rate) >= TARGET_PEAKS_PER_SECOND)
        .last()
        .map(|(i, l)| (i, *l))
        .unwrap_or((0, header.levels[0]));

    let range = read_range(path, level_idx, 0, 0, level.peak_count)?;
    let peaks = range
        .min
        .iter()
        .zip(&range.max)
        .map(|(&min, &max)| dequantize(min).abs().max(dequantize(max).abs()))
        .collect();
    Ok(PeaksFile {
        peaks,
        sample_rate: header.sample_rate,
        frames_per_peak: level.frames_per_peak,
    })
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

    /// 1-second 1 kHz sine wave WAV via lavfi.
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
        assert!(path.to_string_lossy().ends_with(".v4.peaks"));

        let header = read_header(&path).expect("header");
        assert_eq!(header.channels, 2);
        assert_eq!(header.sample_rate, SAMPLE_RATE);
        assert_eq!(header.levels[0].frames_per_peak, BASE_FRAMES_PER_PEAK);
        // ~1s source at 1000/sec ≈ ~1000 finest windows (±a few for alignment).
        assert!(
            (990..=1010).contains(&header.levels[0].peak_count),
            "expected ~1000 finest peaks, got {}",
            header.levels[0].peak_count
        );

        // Constant 1 kHz sine: every finest window has a full cycle, so max ≈ const,
        // well above the noise floor and below clipping.
        let range = read_range(&path, 0, 0, 0, header.levels[0].peak_count).expect("range");
        let peak = range
            .max
            .iter()
            .map(|v| dequantize(*v))
            .fold(0.0_f32, f32::max);
        assert!(peak > 0.05, "peak {peak} too low — pipeline likely broken");
        assert!(peak <= 1.01, "peak {peak} clipped");

        // Constant-amplitude sine: per-window RMS should converge on peak/sqrt(2)
        // once averaged across the whole clip (individual windows wobble with
        // cycle-boundary phase).
        let avg_rms = range
            .rms
            .iter()
            .map(|v| dequantize_rms(*v) as f64)
            .sum::<f64>()
            / range.rms.len() as f64;
        let ratio = avg_rms / peak as f64;
        assert!(
            (ratio - 0.707).abs() < 0.05,
            "rms/peak ratio {ratio} not close to 1/sqrt(2)"
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
    fn v4_write_read_header_and_range() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("test.v4.peaks");

        // Two levels, stereo. Finest: 4 windows; coarse: 2 windows.
        let fine = LevelData {
            channels: 2,
            peak_count: 4,
            mins: vec![vec![-1000, -2000, -3000, -4000], vec![-10, -20, -30, -40]],
            maxs: vec![vec![1000, 2000, 3000, 4000], vec![10, 20, 30, 40]],
            rmss: vec![vec![100, 200, 300, 400], vec![1, 2, 3, 4]],
        };
        let coarse = LevelData {
            channels: 2,
            peak_count: 2,
            mins: vec![vec![-2000, -4000], vec![-20, -40]],
            maxs: vec![vec![2000, 4000], vec![20, 40]],
            rmss: vec![vec![150, 350], vec![1, 3]],
        };
        let levels = vec![
            (BASE_FRAMES_PER_PEAK, fine),
            (BASE_FRAMES_PER_PEAK * 2, coarse),
        ];
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async { write_peaks(&path, 2, &levels).await })
            .unwrap();

        let header = read_header(&path).expect("header");
        assert_eq!(header.channels, 2);
        assert_eq!(header.levels.len(), 2);
        assert_eq!(header.sample_rate, SAMPLE_RATE);
        assert_eq!(header.levels[0].frames_per_peak, BASE_FRAMES_PER_PEAK);
        assert_eq!(header.levels[0].peak_count, 4);
        assert_eq!(header.levels[1].frames_per_peak, BASE_FRAMES_PER_PEAK * 2);

        // Range read: level 0, channel 1, windows [1,3). The level's pps rides
        // along so callers don't need a second header read; rms round-trips
        // alongside min/max.
        let range = read_range(&path, 0, 1, 1, 2).expect("range");
        assert_eq!(
            range.peaks_per_second,
            SAMPLE_RATE as f64 / BASE_FRAMES_PER_PEAK as f64
        );
        assert_eq!(range.min, vec![-20, -30]);
        assert_eq!(range.max, vec![20, 30]);
        assert_eq!(range.rms, vec![2, 3]);

        // Coarse level reports its own pps.
        let range = read_range(&path, 1, 0, 0, 2).expect("coarse range");
        assert_eq!(
            range.peaks_per_second,
            SAMPLE_RATE as f64 / (BASE_FRAMES_PER_PEAK * 2) as f64
        );
        assert_eq!(range.rms, vec![150, 350]);

        // Clamp past the end.
        let range = read_range(&path, 0, 0, 3, 10).expect("clamped range");
        assert_eq!(range.min, vec![-4000]);
        assert_eq!(range.rms, vec![400]);

        // Fully past-end start_peak -> empty result (start clamps to peak_count,
        // n = 0) but pps is still reported.
        let range = read_range(&path, 0, 0, 10, 5).expect("past-end start");
        assert_eq!(
            range.peaks_per_second,
            SAMPLE_RATE as f64 / BASE_FRAMES_PER_PEAK as f64
        );
        assert!(range.min.is_empty() && range.max.is_empty() && range.rms.is_empty());

        // Out-of-range channel is an error, not a silent clamp.
        assert!(read_range(&path, 0, 5, 0, 2).is_err());
    }

    #[test]
    fn decimate_halves_and_preserves_envelope() {
        // 4 windows -> 2 windows. Each output min/max spans its two children.
        let mins = vec![-3, -1, -7, -2];
        let maxs = vec![2, 5, 1, 9];
        let (dmin, dmax) = decimate(&mins, &maxs);
        assert_eq!(dmin, vec![-3, -7]); // min(-3,-1)=-3 ; min(-7,-2)=-7
        assert_eq!(dmax, vec![5, 9]); // max(2,5)=5 ; max(1,9)=9

        // RMS-of-RMS: sqrt((0.6² + 0.8²) / 2) = sqrt(0.5) = 1/sqrt(2) ≈ 0.707.
        // "0.707" is a 3-decimal display rounding of 1/sqrt(2) (0.70710678...);
        // at u16 precision that display truncation alone is ~7 quanta, so the
        // tolerance covers it, not just decimation rounding.
        let rmss = vec![quantize_rms(0.6), quantize_rms(0.8)];
        let drms = decimate_rms(&rmss)[0];
        let expected = quantize_rms(0.707);
        assert!(
            (drms as i32 - expected as i32).abs() <= 10,
            "decimate_rms({rmss:?})[0] = {drms}, expected ~{expected}"
        );
    }

    #[test]
    fn read_peaks_file_returns_exact_timebase_and_maxabs() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("c.v4.peaks");
        // Finest level at 1000/sec, 1000 windows, channel 0 has a big negative
        // excursion so max-abs must pick up |min|, not just max.
        let mut mins = vec![0i16; 1000];
        let mut maxs = vec![0i16; 1000];
        mins[500] = quantize(-0.9);
        maxs[10] = quantize(0.4);
        let rmss = vec![vec![0u16; 1000]];
        let finest = LevelData {
            channels: 1,
            peak_count: 1000,
            mins: vec![mins],
            maxs: vec![maxs],
            rmss,
        };
        let pyramid = build_pyramid(finest);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async { write_peaks(&path, 1, &pyramid).await })
            .unwrap();

        let peaks_file = read_peaks_file(&path).expect("compat read");
        assert_eq!(peaks_file.sample_rate, SAMPLE_RATE);
        assert_eq!(peaks_file.frames_per_peak, BASE_FRAMES_PER_PEAK * 8);
        // The selected exact level is 22050/176 = 125.284... peaks/sec.
        assert_eq!(peaks_file.peaks.len(), 125);
        let big = peaks_file.peaks.iter().cloned().fold(0.0_f32, f32::max);
        assert!(
            (big - 0.9).abs() < 0.05,
            "max-abs lost the negative excursion: {big}"
        );
    }

    #[test]
    fn build_pyramid_is_finest_first_and_shrinks() {
        let finest = LevelData {
            channels: 1,
            peak_count: 8,
            mins: vec![vec![-1; 8]],
            maxs: vec![vec![1; 8]],
            rmss: vec![vec![quantize_rms(0.5); 8]],
        };
        let pyramid = build_pyramid(finest);
        assert_eq!(pyramid[0].0, BASE_FRAMES_PER_PEAK);
        // Frames per peak strictly increases while peak_count shrinks.
        for w in pyramid.windows(2) {
            assert_eq!(w[1].0, w[0].0 * 2, "timebase must double exactly");
            assert!(w[1].1.peak_count <= w[0].1.peak_count);
            assert_eq!(w[1].1.rmss[0].len(), w[1].1.peak_count as usize);
        }
        assert!(pyramid.last().unwrap().1.peak_count >= 1);
    }

    #[test]
    fn long_duration_lods_preserve_exact_pcm_timebase() {
        // Same decoded frame count as the 124.9s regression asset. Every LOD
        // must cover the source with less than one peak of tail padding.
        let source_frames: u64 = 2_754_663;
        let finest_count = source_frames.div_ceil(BASE_FRAMES_PER_PEAK as u64) as usize;
        let finest = LevelData {
            channels: 1,
            peak_count: finest_count as u32,
            mins: vec![vec![0; finest_count]],
            maxs: vec![vec![0; finest_count]],
            rmss: vec![vec![0; finest_count]],
        };
        let pyramid = build_pyramid(finest);
        for (frames_per_peak, level) in pyramid {
            let covered_frames = level.peak_count as u64 * frames_per_peak as u64;
            assert!(covered_frames >= source_frames);
            assert!(
                covered_frames - source_frames < frames_per_peak as u64,
                "level {frames_per_peak} padded by more than one peak"
            );
            let pps = SAMPLE_RATE as f64 / frames_per_peak as f64;
            let covered_seconds = level.peak_count as f64 / pps;
            let exact_seconds = covered_frames as f64 / SAMPLE_RATE as f64;
            assert!((covered_seconds - exact_seconds).abs() < 1e-12);
        }
    }
}
