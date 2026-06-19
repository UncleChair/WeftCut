//! Extract a `[in_us, out_us)` audio slice from a source media file as
//! mono 16 kHz 16-bit PCM WAV — the canonical input shape for OpenAI Whisper
//! and the natural lowest-common-denominator for any future transcription
//! provider we add.
//!
//! Output is content-addressed and reused across calls. Hash composition is
//! `blake3([source_hash.as_bytes(), in_us.to_le_bytes(), out_us.to_le_bytes()].concat())` —
//! pinned here so Stage 5+ never re-derives it differently. Files land in
//! `<cache>/transcribe-audio/<hash>.wav` (see `cache::CacheLayout`).
//!
//! Atomic via the shared `temp_path / promote_temp / discard_temp` triad,
//! same as the jobs module. Acquires `jobs::ffmpeg_sem()` so cloud extracts
//! compete fairly with background derivative ffmpegs rather than spawning
//! unbounded parallelism on import-heavy moments.
//!
//! Size envelope at 16 kHz mono pcm_s16le: 32 KB/sec, so the Whisper 25 MB
//! upload cap is ~13 minutes per single extract. Stage 5 (`transcribe_clip`)
//! is the layer that surfaces `PayloadTooLarge` against that envelope; this
//! module just produces the file.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
use crate::jobs;

/// Whisper (and Deepgram/AssemblyAI) input rate. 16 kHz mono is the smallest
/// shape that keeps transcription accuracy.
pub const SAMPLE_RATE_HZ: u32 = 16_000;

/// Slice `[in_us, out_us)` of `source` into a mono 16 kHz WAV and return
/// the cached path. `source_hash` is the upstream `MediaItem.file_hash_blake3`
/// — we never re-hash the source here (the import path already did it).
pub async fn extract_audio_window(
    cache: &CacheLayout,
    source: &Path,
    source_hash: &str,
    in_us: i64,
    out_us: i64,
) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot extract audio for transcription");
    }
    if in_us < 0 {
        anyhow::bail!("audio window in_us must be non-negative (got {in_us})");
    }
    if out_us <= in_us {
        anyhow::bail!(
            "audio window must have positive duration (in_us={in_us}, out_us={out_us})"
        );
    }

    let hash = window_hash(source_hash, in_us, out_us);
    let dest = cache.transcribe_audio(&hash);
    if cached_ok(&dest) {
        return Ok(dest);
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("ensure {}", parent.display()))?;
    }
    let tmp = temp_path(&dest);
    let _ = tokio::fs::remove_file(&tmp).await;

    let in_s = us_to_seconds(in_us);
    let dur_s = us_to_seconds(out_us - in_us);

    let _permit = jobs::ffmpeg_sem()
        .acquire()
        .await
        .context("acquire ffmpeg slot for audio extract")?;

    // -ss AFTER -i for sample-accurate seek (input-side -ss is faster but
    // keyframe-aligned; transcription wants the actual requested window).
    let mut child = Command::new(ffmpeg_path())
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-i"])
        .arg(source)
        .args([
            "-ss", &in_s,
            "-t", &dur_s,
            "-vn",
            "-ac", "1",
            "-ar", &SAMPLE_RATE_HZ.to_string(),
            "-c:a", "pcm_s16le",
            "-f", "wav",
        ])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("spawn ffmpeg for audio extract")?;

    let output = child
        .wait_with_output()
        .await
        .context("await ffmpeg for audio extract")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg exited with {} for audio extract: {}",
            output.status,
            stderr.trim()
        );
    }
    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!("audio extract produced an empty WAV");
    }
    promote_temp(&dest)?;
    Ok(dest)
}

fn window_hash(source_hash: &str, in_us: i64, out_us: i64) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(source_hash.as_bytes());
    hasher.update(&in_us.to_le_bytes());
    hasher.update(&out_us.to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

fn us_to_seconds(us: i64) -> String {
    // ffmpeg accepts decimal seconds; 6 decimal places preserve full us
    // precision. Callers guarantee `us >= 0` (asserted above).
    debug_assert!(us >= 0);
    format!("{}.{:06}", us / 1_000_000, us % 1_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn make_test_source(dest: &Path, duration_s: u32) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args([
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", &format!("sine=frequency=1000:duration={duration_s}"),
                "-ac", "2",
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

    /// Crack the WAV header just enough to verify channels + sample rate +
    /// bits/sample. RIFF layout: bytes 0..4 = "RIFF", 8..12 = "WAVE", then a
    /// sequence of chunks. ffmpeg writes "fmt " first; we depend on that
    /// (matching how the file is produced above).
    fn parse_wav_format(path: &Path) -> Result<(u16, u32, u16)> {
        let bytes = std::fs::read(path)?;
        anyhow::ensure!(bytes.len() >= 44, "wav too short ({} bytes)", bytes.len());
        anyhow::ensure!(&bytes[0..4] == b"RIFF", "not RIFF");
        anyhow::ensure!(&bytes[8..12] == b"WAVE", "not WAVE");
        anyhow::ensure!(&bytes[12..16] == b"fmt ", "first chunk not fmt ");
        let channels = u16::from_le_bytes([bytes[22], bytes[23]]);
        let sample_rate =
            u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
        let bits_per_sample = u16::from_le_bytes([bytes[34], bytes[35]]);
        Ok((channels, sample_rate, bits_per_sample))
    }

    /// Real-ffmpeg smoke per `memory/feedback_emit_smoke_tests.md`: string-
    /// matching the args is not enough — invoke the tool and verify the
    /// output. Extracts a 2-sec mono slice from a 5-sec stereo source and
    /// checks the WAV header.
    #[tokio::test]
    async fn audio_extract_window_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping audio_extract smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let source = tmp.path().join("src.wav");
        make_test_source(&source, 5).await.expect("test fixture");

        let path = extract_audio_window(
            &cache,
            &source,
            "src-hash-stable",
            1_000_000,
            3_000_000,
        )
        .await
        .expect("audio extract");
        assert!(cached_ok(&path), "wav not written");
        assert!(
            path.starts_with(cache.transcribe_audio_dir()),
            "output not under transcribe-audio cache dir: {}",
            path.display(),
        );

        let (channels, sample_rate, bits) =
            parse_wav_format(&path).expect("parse wav header");
        assert_eq!(channels, 1, "must be mono for Whisper input");
        assert_eq!(sample_rate, SAMPLE_RATE_HZ, "must be 16 kHz");
        assert_eq!(bits, 16, "must be 16-bit PCM");

        // 2 sec * 16000 Hz * 2 bytes ≈ 64000 data bytes + 44-byte header.
        // Allow generous slack — ffmpeg's `-t` isn't sample-perfect.
        let size = std::fs::metadata(&path).unwrap().len() as i64;
        assert!(
            (50_000..=80_000).contains(&size),
            "expected ~64KB output, got {size} bytes",
        );

        // Second call hits the content-addressed cache.
        let path2 = extract_audio_window(
            &cache,
            &source,
            "src-hash-stable",
            1_000_000,
            3_000_000,
        )
        .await
        .expect("audio extract second call");
        assert_eq!(path, path2);
    }

    #[test]
    fn window_hash_is_deterministic_and_window_sensitive() {
        let a = window_hash("hash-a", 0, 1_000_000);
        let b = window_hash("hash-a", 0, 1_000_000);
        assert_eq!(a, b, "deterministic");
        let c = window_hash("hash-a", 0, 2_000_000);
        assert_ne!(a, c, "different end → different hash");
        let d = window_hash("hash-a", 500_000, 1_000_000);
        assert_ne!(a, d, "different start → different hash");
        let e = window_hash("hash-b", 0, 1_000_000);
        assert_ne!(a, e, "different source → different hash");
    }

    #[tokio::test]
    async fn rejects_zero_duration_window() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let err = extract_audio_window(
            &cache,
            &tmp.path().join("any.wav"),
            "x",
            1_000_000,
            1_000_000,
        )
        .await
        .expect_err("zero window");
        assert!(
            format!("{err:#}").contains("positive duration"),
            "unexpected error: {err:#}",
        );
    }

    #[tokio::test]
    async fn rejects_negative_in_us() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let err = extract_audio_window(
            &cache,
            &tmp.path().join("any.wav"),
            "x",
            -1,
            1_000_000,
        )
        .await
        .expect_err("negative in_us");
        assert!(
            format!("{err:#}").contains("non-negative"),
            "unexpected error: {err:#}",
        );
    }

    #[test]
    fn us_to_seconds_renders_microsecond_precision() {
        assert_eq!(us_to_seconds(0), "0.000000");
        assert_eq!(us_to_seconds(1_500_000), "1.500000");
        assert_eq!(us_to_seconds(123), "0.000123");
        assert_eq!(us_to_seconds(3_600_000_000), "3600.000000");
    }
}
