//! Audio waveform peaks. Decodes the source to stereo f32 PCM via ffmpeg,
//! builds the finest min/max level, decimates it into a power-of-two mipmap
//! pyramid, and writes a compact binary file (VPEAKS v2) the timeline can
//! scan in one mmap at whatever zoom-appropriate resolution it needs.

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
pub const SAMPLE_RATE: u32 = 22_050;
pub const PEAKS_PER_SECOND: u32 = 100;

/// v2 on-disk format version, written into the header — the only on-disk
/// version constant; there is no v1 reader left to keep in sync.
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
/// `start_peak`. Clamps the range to the level's peak_count. Returns the
/// level's peaks_per_second alongside the windows — the header is already
/// parsed here, so callers must not re-open the file just to resolve it.
pub fn read_v2_range(
    path: &std::path::Path,
    level_idx: usize,
    channel: usize,
    start_peak: u32,
    count: u32,
) -> Result<(u32, Vec<i16>, Vec<i16>)> {
    use std::io::{Read, Seek, SeekFrom};
    let header = read_v2_header(path)?;
    let level = *header
        .levels
        .get(level_idx)
        .ok_or_else(|| anyhow!("level {level_idx} out of range"))?;
    if channel >= header.channels as usize {
        anyhow::bail!("channel {channel} out of range (file has {} channels)", header.channels);
    }
    let ch = channel;
    let start = start_peak.min(level.peak_count);
    let end = (start + count).min(level.peak_count);
    let n = (end - start) as usize;
    if n == 0 {
        return Ok((level.peaks_per_second, Vec::new(), Vec::new()));
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
    Ok((level.peaks_per_second, mins, maxs))
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
    write_v2_with_pps(&tmp, channels as u32, &pyramid).await?;
    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!("waveform peaks file is empty after write");
    }
    promote_temp(&dest)?;
    Ok(dest)
}

/// Decode interleaved stereo f32 PCM from ffmpeg's stdout into the finest
/// (highest-resolution) min/max level. One peak window is
/// `SAMPLE_RATE / BASE_PEAKS_PER_SECOND` frames; `decimate`/`build_pyramid`
/// derive every coarser LOD from this level, so it's the only pass that
/// touches the raw PCM stream.
async fn compute_finest_level(
    stdout: &mut tokio::process::ChildStdout,
    channels: usize,
) -> Result<LevelData> {
    let frames_per_peak = (SAMPLE_RATE / BASE_PEAKS_PER_SECOND) as usize;
    let mut mins: Vec<Vec<i16>> = vec![Vec::new(); channels];
    let mut maxs: Vec<Vec<i16>> = vec![Vec::new(); channels];
    let mut cur_min = vec![f32::MAX; channels];
    let mut cur_max = vec![f32::MIN; channels];
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
        mins: &mut [Vec<i16>],
        maxs: &mut [Vec<i16>],
    ) {
        cur_min[*ch] = cur_min[*ch].min(sample);
        cur_max[*ch] = cur_max[*ch].max(sample);
        *ch += 1;
        if *ch == channels {
            *ch = 0;
            *frames_in_window += 1;
            if *frames_in_window >= frames_per_peak {
                for c in 0..channels {
                    mins[c].push(quantize(if cur_min[c] == f32::MAX { 0.0 } else { cur_min[c] }));
                    maxs[c].push(quantize(if cur_max[c] == f32::MIN { 0.0 } else { cur_max[c] }));
                    cur_min[c] = f32::MAX;
                    cur_max[c] = f32::MIN;
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
                    &mut mins,
                    &mut maxs,
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
                &mut mins,
                &mut maxs,
            );
        }
        // Save trailing < 4 bytes for the next iteration.
        let tail = &slice[aligned..];
        leftover_len = tail.len();
        leftover[..leftover_len].copy_from_slice(tail);
    }
    // Flush a partial trailing window.
    if frames_in_window > 0 {
        for c in 0..channels {
            mins[c].push(quantize(if cur_min[c] == f32::MAX { 0.0 } else { cur_min[c] }));
            maxs[c].push(quantize(if cur_max[c] == f32::MIN { 0.0 } else { cur_max[c] }));
        }
    }
    let peak_count = mins[0].len() as u32;
    Ok(LevelData { channels: channels as u32, peak_count, mins, maxs })
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

/// Build the finest-first LOD pyramid: `finest` at `BASE_PEAKS_PER_SECOND`,
/// each subsequent level's peaks-per-second and peak_count halved via
/// `decimate`, down to ~1/sec (or a single window, whichever is reached first).
fn build_pyramid(finest: LevelData) -> Vec<(u32, LevelData)> {
    let channels = finest.channels as usize;
    let mut out: Vec<(u32, LevelData)> = vec![(BASE_PEAKS_PER_SECOND, finest)];
    let mut pps = BASE_PEAKS_PER_SECOND;
    loop {
        let (_, prev) = out.last().unwrap();
        if prev.peak_count <= 1 || pps <= 1 {
            break;
        }
        let mut mins = Vec::with_capacity(channels);
        let mut maxs = Vec::with_capacity(channels);
        for c in 0..channels {
            let (dmin, dmax) = decimate(&prev.mins[c], &prev.maxs[c]);
            mins.push(dmin);
            maxs.push(dmax);
        }
        let peak_count = mins[0].len() as u32;
        pps = (pps / 2).max(1);
        out.push((pps, LevelData { channels: channels as u32, peak_count, mins, maxs }));
    }
    out
}

/// Back-compat reader for MCP (detect_silences, media://{id}/waveform).
/// Returns max-abs f32 peaks at `PEAKS_PER_SECOND` (100/sec), aggregated down
/// from the nearest v2 level whose resolution is >= 100/sec (channel 0).
pub fn read_peaks_file(path: &std::path::Path) -> Result<Vec<f32>> {
    let header = read_v2_header(path)?;
    // Levels are finest-first; pick the coarsest level still >= target so we
    // aggregate down, never up.
    let target = PEAKS_PER_SECOND;
    let (level_idx, level) = header
        .levels
        .iter()
        .enumerate()
        .filter(|(_, l)| l.peaks_per_second >= target)
        .last()
        .map(|(i, l)| (i, *l))
        .unwrap_or((0, header.levels[0]));

    let (_, mins, maxs) = read_v2_range(path, level_idx, 0, 0, level.peak_count)?;
    let src_pps = level.peaks_per_second as f64;
    let n_out = ((mins.len() as f64) * (target as f64) / src_pps).round() as usize;
    let n_out = n_out.max(1);
    let mut out = Vec::with_capacity(n_out);
    for i in 0..n_out {
        let start = ((i as f64) * (mins.len() as f64) / (n_out as f64)).floor() as usize;
        let end = (((i + 1) as f64) * (mins.len() as f64) / (n_out as f64)).ceil() as usize;
        let end = end.min(mins.len()).max(start + 1);
        let mut amp = 0.0_f32;
        for w in start..end {
            amp = amp.max(dequantize(mins[w]).abs()).max(dequantize(maxs[w]).abs());
        }
        out.push(amp);
    }
    Ok(out)
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
        assert!(path.to_string_lossy().ends_with(".v2.peaks"));

        let header = read_v2_header(&path).expect("v2 header");
        assert_eq!(header.channels, 2);
        assert_eq!(header.levels[0].peaks_per_second, BASE_PEAKS_PER_SECOND);
        // ~1s source at 1000/sec ≈ ~1000 finest windows (±a few for alignment).
        assert!(
            (990..=1010).contains(&header.levels[0].peak_count),
            "expected ~1000 finest peaks, got {}",
            header.levels[0].peak_count
        );

        // Constant 1 kHz sine: every finest window has a full cycle, so max ≈ const,
        // well above the noise floor and below clipping.
        let (_, _mins, maxs) = read_v2_range(&path, 0, 0, 0, header.levels[0].peak_count).expect("range");
        let peak = maxs.iter().map(|v| dequantize(*v)).fold(0.0_f32, f32::max);
        assert!(peak > 0.05, "peak {peak} too low — pipeline likely broken");
        assert!(peak <= 1.01, "peak {peak} clipped");
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

        // Range read: level 0, channel 1, windows [1,3). The level's pps rides
        // along so callers don't need a second header read.
        let (pps, mins, maxs) = read_v2_range(&path, 0, 1, 1, 2).expect("range");
        assert_eq!(pps, BASE_PEAKS_PER_SECOND);
        assert_eq!(mins, vec![-20, -30]);
        assert_eq!(maxs, vec![20, 30]);

        // Coarse level reports its own pps.
        let (pps, _, _) = read_v2_range(&path, 1, 0, 0, 2).expect("coarse range");
        assert_eq!(pps, BASE_PEAKS_PER_SECOND / 2);

        // Clamp past the end.
        let (_, mins, _) = read_v2_range(&path, 0, 0, 3, 10).expect("clamped range");
        assert_eq!(mins, vec![-4000]);

        // Fully past-end start_peak -> empty result (start clamps to peak_count,
        // n = 0) but pps is still reported.
        let (pps, mins, maxs) = read_v2_range(&path, 0, 0, 10, 5).expect("past-end start");
        assert_eq!(pps, BASE_PEAKS_PER_SECOND);
        assert!(mins.is_empty() && maxs.is_empty());

        // Out-of-range channel is an error, not a silent clamp.
        assert!(read_v2_range(&path, 0, 5, 0, 2).is_err());
    }

    #[test]
    fn decimate_halves_and_preserves_envelope() {
        // 4 windows -> 2 windows. Each output min/max spans its two children.
        let mins = vec![-3, -1, -7, -2];
        let maxs = vec![2, 5, 1, 9];
        let (dmin, dmax) = decimate(&mins, &maxs);
        assert_eq!(dmin, vec![-3, -7]); // min(-3,-1)=-3 ; min(-7,-2)=-7
        assert_eq!(dmax, vec![5, 9]); // max(2,5)=5 ; max(1,9)=9
    }

    #[test]
    fn read_peaks_file_returns_100hz_maxabs_from_v2() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("c.v2.peaks");
        // Finest level at 1000/sec, 1000 windows, channel 0 has a big negative
        // excursion so max-abs must pick up |min|, not just max.
        let mut mins = vec![0i16; 1000];
        let mut maxs = vec![0i16; 1000];
        mins[500] = quantize(-0.9);
        maxs[10] = quantize(0.4);
        let finest = LevelData { channels: 1, peak_count: 1000, mins: vec![mins], maxs: vec![maxs] };
        let pyramid = build_pyramid(finest);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async { write_v2_with_pps(&path, 1, &pyramid).await }).unwrap();

        let peaks = read_peaks_file(&path).expect("compat read");
        // 1000 finest windows @1000/sec -> ~100 windows @100/sec.
        assert!((98..=102).contains(&peaks.len()), "got {}", peaks.len());
        // The -0.9 excursion (window 500 -> ~window 50 @100/sec) must surface as ~0.9.
        let big = peaks.iter().cloned().fold(0.0_f32, f32::max);
        assert!((big - 0.9).abs() < 0.05, "max-abs lost the negative excursion: {big}");
    }

    #[test]
    fn build_pyramid_is_finest_first_and_shrinks() {
        let finest = LevelData {
            channels: 1,
            peak_count: 8,
            mins: vec![vec![-1; 8]],
            maxs: vec![vec![1; 8]],
        };
        let pyramid = build_pyramid(finest);
        assert_eq!(pyramid[0].0, BASE_PEAKS_PER_SECOND);
        // strictly decreasing pps, strictly decreasing peak_count until >= 1
        for w in pyramid.windows(2) {
            assert!(w[1].0 < w[0].0, "pps must decrease");
            assert!(w[1].1.peak_count <= w[0].1.peak_count);
        }
        assert!(pyramid.last().unwrap().1.peak_count >= 1);
    }
}
