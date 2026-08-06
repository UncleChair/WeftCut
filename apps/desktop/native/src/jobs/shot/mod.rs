//! Deterministic shot layer: split a source video into shots (the spans between
//! cuts) and attach cheap per-shot pixel stats. Tier-1 of the scene-analysis
//! design — always on, zero new deps. See
//! `.scratch/scene-content-analysis/spec.md` (Subsystem A) and the
//! `analyze_clip` MCP tool.
//!
//! Owns: cut detection behind the [`ShotDetector`] seam (ffmpeg today; a learned
//! detector like TransNetV2 can swap in behind the same trait), shot assembly,
//! brightness / motion / sharpness + black / freeze / fade flags, and the VSHOT
//! write-through cache
//! ([`cached_source_report`]) shared by the `analyze_clip` tool and the
//! `media://{id}/analysis` resource. The cache stores ONE whole-source report
//! per (source, params); callers clip it to a layer window with [`clip_report`].
//!
//! ffmpeg's `scene` score is an internal detail — the public surface says
//! "shot" / "cut".

use std::path::Path;
use std::process::Stdio;

use anyhow::{Context, Result};

/// Pairwise perceptual frame similarity (pHash + MSSIM) behind the standalone
/// `compare_frames` tool — a pure function, not part of the cut/stats pipeline.
pub(crate) mod sim;
use async_trait::async_trait;
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use image::RgbImage;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::cache::CacheLayout;
use crate::process::NoConsoleWindow;
use crate::state::MediaItem;

/// Downscaled width for per-shot stat frames. Luma / Laplacian / SSIM are
/// scale-tolerant, so a small frame keeps extraction cheap and the numbers
/// comparable across sources of any resolution.
const STAT_FRAME_WIDTH: u32 = 320;

// Event-flag tolerances, deliberately loose: SSIM and luma differ slightly
// across ffmpeg builds / scalers, so exact thresholds would flap cross-machine.
// See the determinism note in the spec.
const BLACK_LUMA: f64 = 0.02; // mean luma below this ⇒ effectively black
const FREEZE_SSIM: f64 = 0.985; // adjacent-sample SSIM at/above this ⇒ no motion
const FADE_DARK_LUMA: f64 = 0.10; // one boundary end must be near-black for a fade
const FADE_MIN_DELTA: f64 = 0.15; // and the luma ramp must span at least this much

/// Tuning for one shot-detection run.
pub struct ShotOpts {
    /// Cut threshold in [0,1]: a frame whose detector score exceeds it starts a
    /// new shot. Lower = more (finer) cuts.
    pub sensitivity: f32,
    /// Interior cuts closer than this to the previous shot boundary are dropped,
    /// so no returned shot is shorter than it (window edges excepted).
    pub min_shot_us: i64,
    /// Sample each shot's frames for brightness / motion / sharpness. Off =
    /// timing only, no frame decode.
    pub stats: bool,
    /// Derive black / freeze / fade flags per shot (uses the same samples as
    /// `stats`).
    pub events: bool,
}

/// A detected cut: the source-absolute time a new shot begins plus the raw
/// detector confidence (ffmpeg `lavfi.scene_score`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cut {
    pub t_us: i64,
    pub score: f32,
}

/// A per-shot event flag. (De)serializes to/from the lowercase tag the tool
/// advertises; `Deserialize` is what lets the cached VSHOT JSON round-trip back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShotFlag {
    Black,
    Freeze,
    Fade,
}

/// One shot. `brightness` / `motion` / `sharpness` are `None` unless the stats
/// pass ran; `flags` is empty unless the events pass ran.
///
/// The raw stat floats are ADVISORY, not cross-machine bit-stable — they derive
/// from ffmpeg's swscale RGB output, which varies by ffmpeg build / SIMD. The
/// event `flags` are the deterministic signal (threshold-absorbed — see the flag
/// constants above); any gate on exact stat values must use a tolerance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shot {
    pub index: usize,
    pub t_start_us: i64,
    pub t_end_us: i64,
    /// A representative cover-frame time (the shot midpoint).
    pub keyframe_t_us: i64,
    pub brightness: Option<f64>,
    pub motion: Option<f64>,
    pub sharpness: Option<f64>,
    pub flags: Vec<ShotFlag>,
}

/// The shot list plus the raw cut signal, both clipped to the analyzed window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShotReport {
    pub shots: Vec<Shot>,
    pub cut_scores: Vec<Cut>,
}

/// Cut-detection seam. `detect` scans the WHOLE video (no window) so the caller
/// can cache one source-keyed result and clip it per layer; the window lives in
/// [`analyze`]. A learned detector (e.g. TransNetV2) swaps in behind this trait
/// without touching the tool signature.
#[async_trait]
pub trait ShotDetector: Send + Sync {
    async fn detect(&self, proxy: &Path, opts: &ShotOpts) -> Result<Vec<Cut>>;
}

/// ffmpeg-CLI detector: `select='gt(scene,T)',metadata=print` over the whole
/// video, parsing `lavfi.scene_score` frames into cuts.
pub struct FfmpegShotDetector;

#[async_trait]
impl ShotDetector for FfmpegShotDetector {
    async fn detect(&self, proxy: &Path, opts: &ShotOpts) -> Result<Vec<Cut>> {
        if !ffmpeg_is_installed() {
            anyhow::bail!("ffmpeg not installed; cannot detect shots");
        }
        let _permit = crate::jobs::ffmpeg_sem()
            .acquire()
            .await
            .context("acquire ffmpeg slot")?;

        // `metadata=print` writes to the log (stderr), NOT a file: a temp path
        // can't be embedded in the filtergraph without Windows drive-colon /
        // backslash escaping, and `file=-` collides with the null muxer on
        // stdout. So run at info level and parse the captured stderr.
        let vf = format!("select='gt(scene,{})',metadata=print", opts.sensitivity);
        let output = Command::new(ffmpeg_path())
            .no_console_window()
            .kill_on_drop(true)
            .args([
                "-nostdin",
                "-hide_banner",
                "-nostats",
                "-loglevel",
                "info",
                "-i",
            ])
            .arg(proxy)
            .args(["-an", "-sn", "-vf", &vf, "-f", "null", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .context("spawn ffmpeg for shot detection")?;
        if !output.status.success() {
            anyhow::bail!(
                "ffmpeg exited with {} during shot detection: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(parse_scene_cuts(&String::from_utf8_lossy(&output.stderr)))
    }
}

/// Full shot analysis for one video over the source window `[src_in_us,
/// src_out_us]`: detect cuts (whole file), assemble shots inside the window,
/// and — per `opts` — attach stats / flags. All timestamps are source-absolute.
pub async fn analyze(
    video: &Path,
    src_in_us: i64,
    src_out_us: i64,
    opts: &ShotOpts,
) -> Result<ShotReport> {
    let detector = FfmpegShotDetector;
    let mut cuts = detector.detect(video, opts).await?;
    // ffmpeg emits in temporal order, but sort defensively — build_shots and the
    // min-spacing filter assume ascending cut times.
    cuts.sort_by_key(|c| c.t_us);

    let cut_times: Vec<i64> = cuts.iter().map(|c| c.t_us).collect();
    let spans = build_shots(&cut_times, src_in_us, src_out_us, opts.min_shot_us);

    // The raw cut signal within the window (no min-spacing) — the honest
    // detector output alongside the cleaned shot list.
    let cut_scores: Vec<Cut> = cuts
        .into_iter()
        .filter(|c| c.t_us > src_in_us && c.t_us < src_out_us)
        .collect();

    let tmp = if opts.stats || opts.events {
        Some(
            tempfile::Builder::new()
                .prefix("weftcut-shot")
                .tempdir()
                .context("shot stat temp dir")?,
        )
    } else {
        None
    };

    let mut shots = Vec::with_capacity(spans.len());
    for (index, (t_start_us, t_end_us)) in spans.into_iter().enumerate() {
        let keyframe_t_us = t_start_us + (t_end_us - t_start_us) / 2;
        let mut shot = Shot {
            index,
            t_start_us,
            t_end_us,
            keyframe_t_us,
            brightness: None,
            motion: None,
            sharpness: None,
            flags: Vec::new(),
        };
        if let Some(dir) = &tmp {
            attach_stats(&mut shot, video, dir.path(), opts).await?;
        }
        shots.push(shot);
    }
    Ok(ShotReport { shots, cut_scores })
}

/// The content-addressed VSHOT cache key: `blake3(source_hash | tier |
/// sensitivity | min_shot_us | stats | events)`. The source content hash makes a
/// relink / content change auto-invalidate (the key changes with it); the
/// detection params are folded in because they change the report, so a call at a
/// new sensitivity gets a fresh entry instead of a stale hit. `tier` is which
/// physical input [`pick_source`] chose (quick proxy / full proxy / original):
/// ffmpeg `scene` scores shift with resolution + compression, so a report
/// computed on the ORIGINAL before the proxy job finished must NOT alias the
/// later proxy-based report — folding the tier gives each its own entry, and a
/// read after the proxy lands recomputes on the proxy instead of returning the
/// stale original-based cuts. The layer WINDOW is deliberately absent — the
/// cached report is whole-source and clipped per layer at read time, so one
/// entry serves every layer on the source. Mirrors `vlm::cache_key`.
pub fn cache_key(source_hash: &str, tier: &str, opts: &ShotOpts) -> String {
    let mut h = blake3::Hasher::new();
    h.update(source_hash.as_bytes());
    h.update(b"\0");
    h.update(tier.as_bytes());
    h.update(b"\0");
    h.update(&opts.sensitivity.to_le_bytes());
    h.update(b"\0");
    h.update(&opts.min_shot_us.to_le_bytes());
    h.update(b"\0");
    h.update(&[opts.stats as u8, opts.events as u8]);
    h.finalize().to_hex().to_string()
}

/// Pick the video the detector runs on plus a tier tag for the cache key: the
/// 720p quick proxy if built (`"quick"`), else the full proxy (`"full"`), else
/// the original source (`"orig"`). The detector is scale-tolerant, so a proxy
/// keeps the whole-file decode cheap; the tag is folded into [`cache_key`] so a
/// report computed on one tier never aliases another (see cache_key). (Shared by
/// the tool AND the resource so both use one compute-on-miss path.)
fn pick_source(cache: &CacheLayout, media: &MediaItem) -> (std::path::PathBuf, &'static str) {
    let quick = cache.quick_proxy(&media.file_hash_blake3);
    if crate::cache::cached_ok(&quick) {
        return (quick, "quick");
    }
    let full = cache.proxy(&media.file_hash_blake3);
    if crate::cache::cached_ok(&full) {
        return (full, "full");
    }
    (media.path_abs.clone(), "orig")
}

/// The WHOLE-source shot report for `media` under `opts`, from the VSHOT cache —
/// computed and written through on a miss. This is the single compute-on-miss
/// path shared by the `analyze_clip` tool and the `media://{id}/analysis`
/// resource: the report spans the entire source `[0, duration_us]`
/// (source-absolute), so both callers clip it to their window with
/// [`clip_report`] and any second call on the same source + params skips ffmpeg.
/// A corrupt/partial sidecar is treated as a miss (recompute), so a killed write
/// self-heals.
pub async fn cached_source_report(
    cache: &CacheLayout,
    media: &MediaItem,
    opts: &ShotOpts,
) -> Result<ShotReport> {
    // Resolve the physical input first — its tier is part of the key (see
    // `cache_key`).
    let (video, tier) = pick_source(cache, media);
    let path = cache.shot(&cache_key(&media.file_hash_blake3, tier, opts));
    crate::cache::touch_if_stale(&path);
    if crate::cache::cached_ok(&path) {
        match read_report(&path) {
            Ok(report) => return Ok(report),
            Err(e) => tracing::warn!("VSHOT cache {} unreadable, recomputing: {e:#}", path.display()),
        }
    }

    // Whole-source scan: the detector is window-agnostic, so we analyze the full
    // content window and cache that once. A source with no probed duration can't
    // be scanned — bail with an actionable message rather than caching an empty
    // (and later-wrong) report.
    let duration_us = media.metadata.duration_us.unwrap_or_default();
    if duration_us <= 0 {
        anyhow::bail!(
            "media {} has no known duration — re-import it so ffprobe can measure the source before analyzing shots",
            media.id
        );
    }
    let report = analyze(&video, 0, duration_us, opts).await?;
    write_report_atomic(&path, &report).await?;
    cache.notify_write();
    Ok(report)
}

/// Clip a WHOLE-source report to the layer window `[in_us, out_us]` (mirrors how
/// `detect_silences` clips its regions to the same window). Each whole-source
/// shot is intersected with the window: shots with no overlap are dropped,
/// straddling shots are truncated to the window edge, and the survivors are
/// re-indexed from 0. Per-shot stats/flags carry over UNCHANGED — they describe
/// the shot as a whole, and recomputing them would re-sample frames and defeat
/// the cache. `keyframe_t_us` is kept when it still lands inside the clipped
/// span, else recomputed as that span's midpoint so the cover-frame time is
/// always inside the shot. `cut_scores` keeps only cuts strictly inside the
/// window.
pub fn clip_report(report: &ShotReport, in_us: i64, out_us: i64) -> ShotReport {
    let mut shots = Vec::new();
    for s in &report.shots {
        let t_start_us = s.t_start_us.max(in_us);
        let t_end_us = s.t_end_us.min(out_us);
        if t_end_us <= t_start_us {
            continue;
        }
        let keyframe_t_us = if (t_start_us..=t_end_us).contains(&s.keyframe_t_us) {
            s.keyframe_t_us
        } else {
            t_start_us + (t_end_us - t_start_us) / 2
        };
        shots.push(Shot {
            index: shots.len(),
            t_start_us,
            t_end_us,
            keyframe_t_us,
            brightness: s.brightness,
            motion: s.motion,
            sharpness: s.sharpness,
            flags: s.flags.clone(),
        });
    }
    let cut_scores = report
        .cut_scores
        .iter()
        .filter(|c| c.t_us > in_us && c.t_us < out_us)
        .cloned()
        .collect();
    ShotReport { shots, cut_scores }
}

/// Read a cached whole-source `ShotReport` back from its JSON sidecar.
fn read_report(path: &Path) -> Result<ShotReport> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parse shot report {}", path.display()))
}

/// Persist a `ShotReport` JSON atomically (temp → promote), mirroring
/// `write_description_atomic` — a killed write leaves a `<dest>.tmp` the next run
/// discards, never a half-written `<dest>` that `cached_ok` would trust.
async fn write_report_atomic(dest: &Path, report: &ShotReport) -> Result<()> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("ensure {}", parent.display()))?;
    }
    let body = serde_json::to_vec_pretty(report).context("serialize shot report")?;
    let tmp = crate::cache::temp_path(dest);
    let _ = tokio::fs::remove_file(&tmp).await;
    tokio::fs::write(&tmp, &body)
        .await
        .with_context(|| format!("write {}", tmp.display()))?;
    if !crate::cache::cached_ok(&tmp) {
        crate::cache::discard_temp(dest);
        anyhow::bail!("shot report cache is empty after write");
    }
    crate::cache::promote_temp(dest)?;
    Ok(())
}

/// Sample a shot's start / mid / end frames and fill in the requested stats and
/// flags. Endpoints are inset slightly so they sit inside the shot rather than
/// on a cut boundary shared with the neighbour.
async fn attach_stats(shot: &mut Shot, video: &Path, dir: &Path, opts: &ShotOpts) -> Result<()> {
    let dur = (shot.t_end_us - shot.t_start_us).max(0);
    let inset = (dur / 8).clamp(0, 250_000);
    let t_start = shot.t_start_us + inset;
    let t_mid = shot.keyframe_t_us;
    let t_end = (shot.t_end_us - inset).max(t_start);

    let idx = shot.index;
    let f_start = extract_rgb(video, t_start, &dir.join(format!("s{idx}_a.png"))).await?;
    let f_mid = extract_rgb(video, t_mid, &dir.join(format!("s{idx}_m.png"))).await?;
    let f_end = extract_rgb(video, t_end, &dir.join(format!("s{idx}_z.png"))).await?;

    let l_start = mean_luma(&f_start);
    let l_mid = mean_luma(&f_mid);
    let l_end = mean_luma(&f_end);

    if opts.stats {
        shot.brightness = Some(l_mid);
        shot.sharpness = Some(var_laplacian(&f_mid));
        shot.motion = Some(motion_between(&f_start, &f_end));
    }
    if opts.events {
        let mut flags = Vec::new();
        if l_start < BLACK_LUMA && l_mid < BLACK_LUMA && l_end < BLACK_LUMA {
            flags.push(ShotFlag::Black);
        }
        if ssim(&f_start, &f_mid) >= FREEZE_SSIM && ssim(&f_mid, &f_end) >= FREEZE_SSIM {
            flags.push(ShotFlag::Freeze);
        }
        if is_fade(l_start, l_mid, l_end) {
            flags.push(ShotFlag::Fade);
        }
        shot.flags = flags;
    }
    Ok(())
}

/// Extract one downscaled RGB frame at source-absolute `t_us`. Fast input-side
/// `-ss` seek (thumbnail-grade accuracy is fine for stats) — mirrors
/// `jobs::frame` / `vlm::frame_extract`. `pub(crate)` so the `compare_frames`
/// tool samples its two frames through the same PNG extract as the shot stats.
pub(crate) async fn extract_rgb(video: &Path, t_us: i64, dest: &Path) -> Result<RgbImage> {
    let t_s = (t_us.max(0) as f64) / 1_000_000.0;
    let _permit = crate::jobs::ffmpeg_sem()
        .acquire()
        .await
        .context("acquire ffmpeg slot")?;
    let output = Command::new(ffmpeg_path())
        .no_console_window()
        .kill_on_drop(true)
        .args([
            "-nostdin",
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            &format!("{t_s:.3}"),
            "-i",
        ])
        .arg(video)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={STAT_FRAME_WIDTH}:-2"),
            "-pix_fmt",
            "rgb24",
            "-c:v",
            "png",
            "-update",
            "1",
            "-f",
            "image2",
        ])
        .arg(dest)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("spawn ffmpeg for shot stat frame")?;
    if !output.status.success() || !crate::cache::cached_ok(dest) {
        anyhow::bail!(
            "ffmpeg stat-frame extract @{t_s}s failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(image::open(dest)
        .with_context(|| format!("decode {}", dest.display()))?
        .to_rgb8())
}

/// Parse ffmpeg `metadata=print` log output into cuts. Each detected frame logs
/// a `... pts_time:<seconds> ...` line followed by a `lavfi.scene_score=<f>`
/// line; we pair them. Tolerant of the `[Parsed_metadata_N @ ..]` log prefix
/// and of an unpaired trailing line.
pub(crate) fn parse_scene_cuts(log: &str) -> Vec<Cut> {
    let mut cuts = Vec::new();
    let mut pending_time: Option<i64> = None;
    for line in log.lines() {
        if let Some(t_us) = parse_pts_time_us(line) {
            pending_time = Some(t_us);
        } else if let Some(score) = parse_scene_score(line) {
            if let Some(t_us) = pending_time.take() {
                cuts.push(Cut { t_us, score });
            }
        }
    }
    cuts
}

fn parse_pts_time_us(line: &str) -> Option<i64> {
    let idx = line.find("pts_time:")?;
    let tok: String = line[idx + "pts_time:".len()..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    let secs: f64 = tok.parse().ok()?;
    Some((secs * 1_000_000.0).round() as i64)
}

fn parse_scene_score(line: &str) -> Option<f32> {
    let idx = line.find("scene_score=")?;
    line[idx + "scene_score=".len()..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect::<String>()
        .parse()
        .ok()
}

/// Assemble shots from sorted cut times, clipped to `[in_us, out_us]`. Interior
/// cuts within `min_shot_us` of the previous boundary are dropped and a final
/// sub-min sliver is trimmed; the window edges are hard boundaries.
pub(crate) fn build_shots(
    cuts_us: &[i64],
    in_us: i64,
    out_us: i64,
    min_shot_us: i64,
) -> Vec<(i64, i64)> {
    if out_us <= in_us {
        return Vec::new();
    }
    let mut bounds = vec![in_us];
    let mut last = in_us;
    for &c in cuts_us {
        if c <= in_us || c >= out_us || c - last < min_shot_us {
            continue;
        }
        bounds.push(c);
        last = c;
    }
    // A trailing shot shorter than min_shot_us is folded into its predecessor by
    // dropping the opening cut.
    if bounds.len() > 1 && out_us - last < min_shot_us {
        bounds.pop();
    }
    bounds.push(out_us);
    bounds.windows(2).map(|w| (w[0], w[1])).collect()
}

/// Mean Rec.601 luma in [0,1].
fn mean_luma(img: &RgbImage) -> f64 {
    let mut sum = 0.0f64;
    for p in img.pixels() {
        sum += 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
    }
    let n = (img.width() as f64 * img.height() as f64).max(1.0);
    sum / n / 255.0
}

/// Variance of the Laplacian of luma — a focus/sharpness proxy (higher =
/// sharper). Computed on [0,1] luma so it is resolution independent.
fn var_laplacian(img: &RgbImage) -> f64 {
    let w = img.width() as i64;
    let h = img.height() as i64;
    if w < 3 || h < 3 {
        return 0.0;
    }
    let luma = |x: i64, y: i64| -> f64 {
        let p = img.get_pixel(x as u32, y as u32);
        (0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64) / 255.0
    };
    let mut vals = Vec::with_capacity(((w - 2) * (h - 2)) as usize);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            vals.push(luma(x - 1, y) + luma(x + 1, y) + luma(x, y - 1) + luma(x, y + 1)
                - 4.0 * luma(x, y));
        }
    }
    let n = vals.len() as f64;
    if n == 0.0 {
        return 0.0;
    }
    let mean = vals.iter().sum::<f64>() / n;
    vals.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n
}

/// MSSIM in [0,1]; 1.0 == identical. Same algorithm the conformance harness
/// uses. Unequal dimensions (a sampling bug) degrade to 0.0 rather than panic.
fn ssim(a: &RgbImage, b: &RgbImage) -> f64 {
    image_compare::rgb_similarity_structure(&image_compare::Algorithm::MSSIMSimple, a, b)
        .map(|r| r.score)
        .unwrap_or(0.0)
}

/// Coarse motion proxy: how much the shot's endpoints differ, `1 - SSIM` in
/// [0,1] (1 = completely different).
fn motion_between(a: &RgbImage, b: &RgbImage) -> f64 {
    (1.0 - ssim(a, b)).clamp(0.0, 1.0)
}

/// A fade is a monotonic luma ramp across the shot that starts or ends near
/// black and spans a meaningful range.
fn is_fade(l_start: f64, l_mid: f64, l_end: f64) -> bool {
    let monotonic =
        (l_start <= l_mid && l_mid <= l_end) || (l_start >= l_mid && l_mid >= l_end);
    let span = (l_end - l_start).abs();
    let touches_black = l_start.min(l_end) < FADE_DARK_LUMA;
    monotonic && span >= FADE_MIN_DELTA && touches_black
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_scene_cuts_pairs_time_and_score() {
        let log = "\
[Parsed_metadata_1 @ 0x1] frame:0    pts:52224   pts_time:2.176000
[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.408033
[Parsed_metadata_1 @ 0x1] frame:1    pts:96000   pts_time:4.000000
[Parsed_metadata_1 @ 0x1] lavfi.scene_score=0.512000
";
        let cuts = parse_scene_cuts(log);
        assert_eq!(cuts.len(), 2);
        assert_eq!(cuts[0].t_us, 2_176_000);
        assert!((cuts[0].score - 0.408033).abs() < 1e-5);
        assert_eq!(cuts[1].t_us, 4_000_000);
    }

    #[test]
    fn parse_scene_cuts_ignores_lines_without_a_time_score_pair() {
        // A stray score with no preceding time is dropped; a time then a score
        // pairs into one cut.
        let log = "lavfi.scene_score=0.9\npts_time:1.0 trailing junk\nlavfi.scene_score=0.3\n";
        let cuts = parse_scene_cuts(log);
        assert_eq!(cuts.len(), 1);
        assert_eq!(cuts[0].t_us, 1_000_000);
        assert!((cuts[0].score - 0.3).abs() < 1e-6);
    }

    #[test]
    fn build_shots_spans_window_with_interior_cuts() {
        let shots = build_shots(&[2_000_000, 4_000_000], 0, 6_000_000, 500_000);
        assert_eq!(
            shots,
            vec![(0, 2_000_000), (2_000_000, 4_000_000), (4_000_000, 6_000_000)]
        );
    }

    #[test]
    fn build_shots_drops_cuts_closer_than_min_shot() {
        // 2.0s then 2.1s (too close) then 4.0s → the 2.1s cut is merged away.
        let shots = build_shots(&[2_000_000, 2_100_000, 4_000_000], 0, 6_000_000, 500_000);
        assert_eq!(
            shots,
            vec![(0, 2_000_000), (2_000_000, 4_000_000), (4_000_000, 6_000_000)]
        );
    }

    #[test]
    fn build_shots_clips_to_window_and_ignores_outside_cuts() {
        // 1s is before the window start (3s); 5s is inside [3s, 8s].
        let shots = build_shots(&[1_000_000, 5_000_000], 3_000_000, 8_000_000, 500_000);
        assert_eq!(shots, vec![(3_000_000, 5_000_000), (5_000_000, 8_000_000)]);
    }

    #[test]
    fn build_shots_trims_final_sliver() {
        // A cut at 5.8s would leave a 0.2s tail (< 0.5s min) → drop it.
        let shots = build_shots(&[5_800_000], 0, 6_000_000, 500_000);
        assert_eq!(shots, vec![(0, 6_000_000)]);
    }

    #[test]
    fn build_shots_empty_window_is_empty() {
        assert!(build_shots(&[1_000_000], 5_000_000, 5_000_000, 500_000).is_empty());
    }

    #[test]
    fn mean_luma_of_black_and_white() {
        let black = RgbImage::from_pixel(8, 8, image::Rgb([0, 0, 0]));
        let white = RgbImage::from_pixel(8, 8, image::Rgb([255, 255, 255]));
        assert!(mean_luma(&black) < 1e-6);
        assert!((mean_luma(&white) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn var_laplacian_flat_is_zero_high_freq_is_positive() {
        let flat = RgbImage::from_pixel(16, 16, image::Rgb([128, 128, 128]));
        assert!(var_laplacian(&flat) < 1e-9);
        let checker = RgbImage::from_fn(16, 16, |x, y| {
            if (x + y) % 2 == 0 {
                image::Rgb([0, 0, 0])
            } else {
                image::Rgb([255, 255, 255])
            }
        });
        assert!(var_laplacian(&checker) > 0.0);
    }

    #[test]
    fn is_fade_detects_ramp_from_or_to_black() {
        assert!(is_fade(0.0, 0.3, 0.6)); // fade in from black
        assert!(is_fade(0.6, 0.3, 0.0)); // fade out to black
        assert!(!is_fade(0.5, 0.5, 0.5)); // flat, no ramp
        assert!(!is_fade(0.4, 0.5, 0.6)); // ramp, but never near black
        assert!(!is_fade(0.0, 0.6, 0.3)); // non-monotonic
    }

    // ── VSHOT cache: (de)serialize + source-keyed path + window clip ─────────

    fn opts(sensitivity: f32, min_shot_us: i64, stats: bool, events: bool) -> ShotOpts {
        ShotOpts { sensitivity, min_shot_us, stats, events }
    }

    /// A whole-source report: shot0 [0,2s] (black), shot1 [2s,6s], one cut at 2s.
    fn sample_report() -> ShotReport {
        ShotReport {
            shots: vec![
                Shot {
                    index: 0,
                    t_start_us: 0,
                    t_end_us: 2_000_000,
                    keyframe_t_us: 1_000_000,
                    brightness: Some(0.5),
                    motion: Some(0.1),
                    sharpness: Some(3.0),
                    flags: vec![ShotFlag::Black],
                },
                Shot {
                    index: 1,
                    t_start_us: 2_000_000,
                    t_end_us: 6_000_000,
                    keyframe_t_us: 4_000_000,
                    brightness: Some(0.7),
                    motion: Some(0.2),
                    sharpness: Some(9.0),
                    flags: vec![],
                },
            ],
            cut_scores: vec![Cut { t_us: 2_000_000, score: 0.5 }],
        }
    }

    fn test_media(hash: &str, duration_us: Option<i64>) -> MediaItem {
        serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::now_v7(),
            "label": null,
            "path_abs": "/nonexistent.mp4",
            "path_rel": null,
            "kind": "Video",
            "metadata": crate::state::MediaMetadata { duration_us, ..Default::default() },
            "decode_route": { "route": "bypass" },
            "waveform_path": null,
            "conform_path": null,
            "thumbnails_dir": null,
            "file_hash_blake3": hash,
            "file_size": 0,
            "file_mtime": 0,
            "imported_at": chrono::Utc::now(),
        }))
        .unwrap()
    }

    #[test]
    fn shot_report_json_round_trips() {
        let bytes = serde_json::to_vec(&sample_report()).unwrap();
        let back: ShotReport = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.shots.len(), 2);
        assert_eq!(back.shots[0].flags, vec![ShotFlag::Black]);
        assert_eq!(back.shots[0].brightness, Some(0.5));
        assert_eq!(back.shots[1].t_end_us, 6_000_000);
        assert_eq!(back.cut_scores.len(), 1);
        assert_eq!(back.cut_scores[0].t_us, 2_000_000);
    }

    #[test]
    fn shot_flag_serde_uses_lowercase_tags() {
        assert_eq!(serde_json::to_string(&ShotFlag::Freeze).unwrap(), "\"freeze\"");
        let f: ShotFlag = serde_json::from_str("\"fade\"").unwrap();
        assert_eq!(f, ShotFlag::Fade);
    }

    #[test]
    fn cache_key_depends_on_source_tier_and_every_param() {
        let base = cache_key("h", "quick", &opts(0.4, 500_000, true, true));
        assert_eq!(base, cache_key("h", "quick", &opts(0.4, 500_000, true, true))); // deterministic
        assert_ne!(base, cache_key("h2", "quick", &opts(0.4, 500_000, true, true))); // source hash
        assert_ne!(base, cache_key("h", "orig", &opts(0.4, 500_000, true, true))); // source tier
        assert_ne!(base, cache_key("h", "quick", &opts(0.2, 500_000, true, true))); // sensitivity
        assert_ne!(base, cache_key("h", "quick", &opts(0.4, 1_000_000, true, true))); // min_shot_us
        assert_ne!(base, cache_key("h", "quick", &opts(0.4, 500_000, false, true))); // stats pass
        assert_ne!(base, cache_key("h", "quick", &opts(0.4, 500_000, true, false))); // events pass
    }

    #[test]
    fn clip_report_truncates_reindexes_and_carries_stats() {
        // Window [1s,5s]: shot0 [0,2]→[1,2], shot1 [2,6]→[2,5]; the 2s cut is
        // strictly inside → kept. Stats/flags carry over unchanged.
        let clipped = clip_report(&sample_report(), 1_000_000, 5_000_000);
        assert_eq!(clipped.shots.len(), 2);
        assert_eq!(
            (clipped.shots[0].index, clipped.shots[0].t_start_us, clipped.shots[0].t_end_us),
            (0, 1_000_000, 2_000_000)
        );
        assert_eq!(
            (clipped.shots[1].index, clipped.shots[1].t_start_us, clipped.shots[1].t_end_us),
            (1, 2_000_000, 5_000_000)
        );
        assert_eq!(clipped.shots[0].brightness, Some(0.5));
        assert_eq!(clipped.shots[0].flags, vec![ShotFlag::Black]);
        assert_eq!(clipped.shots[0].keyframe_t_us, 1_000_000); // still inside [1,2]
        assert_eq!(clipped.cut_scores.len(), 1);
    }

    #[test]
    fn clip_report_drops_shots_outside_window_and_filters_edge_cuts() {
        // Window [3s,5s]: only shot1 [2,6] overlaps → [3,5]; shot0 gone. The 2s
        // cut is ≤ the window start → dropped (strict interior only).
        let clipped = clip_report(&sample_report(), 3_000_000, 5_000_000);
        assert_eq!(clipped.shots.len(), 1);
        assert_eq!(
            (clipped.shots[0].t_start_us, clipped.shots[0].t_end_us),
            (3_000_000, 5_000_000)
        );
        assert!(clipped.cut_scores.is_empty());
    }

    #[test]
    fn clip_report_recomputes_keyframe_that_falls_outside_the_clip() {
        let report = ShotReport {
            shots: vec![Shot {
                index: 0,
                t_start_us: 0,
                t_end_us: 10_000_000,
                keyframe_t_us: 5_000_000, // whole-shot midpoint, outside the clip below
                brightness: None,
                motion: None,
                sharpness: None,
                flags: vec![],
            }],
            cut_scores: vec![],
        };
        let clipped = clip_report(&report, 0, 2_000_000);
        assert_eq!(clipped.shots.len(), 1);
        assert_eq!(clipped.shots[0].t_end_us, 2_000_000);
        // 5s is outside [0,2s] → recomputed to the clipped-span midpoint (1s).
        assert_eq!(clipped.shots[0].keyframe_t_us, 1_000_000);
    }

    /// The source-keyed cache path: a pre-seeded sidecar at
    /// `shot(cache_key(hash, tier, opts))` is a HIT that round-trips without ffmpeg,
    /// proving write-through storage and the per-source key.
    #[tokio::test]
    async fn cached_source_report_hits_source_keyed_sidecar() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let o = opts(0.4, 500_000, true, true);
        let media = test_media("cafef00d", Some(6_000_000));

        // No proxy exists for this media in the temp cache, so pick_source uses
        // the original → tier "orig"; pre-seed the sidecar at that exact key.
        let path = cache.shot(&cache_key(&media.file_hash_blake3, "orig", &o));
        write_report_atomic(&path, &sample_report()).await.unwrap();
        assert!(crate::cache::cached_ok(&path));

        // HIT: reads the sidecar, never spawns ffmpeg (path /nonexistent.mp4).
        let got = cached_source_report(&cache, &media, &o).await.unwrap();
        assert_eq!(got.shots.len(), 2);
        assert_eq!(got.shots[1].t_end_us, 6_000_000);

        // A different source hash addresses a DIFFERENT sidecar (source-keyed).
        assert_ne!(path, cache.shot(&cache_key("beadfeed", "orig", &o)));
    }

    /// A source with no probed duration can't be whole-scanned — a MISS bails
    /// with an actionable message instead of caching an empty (later-wrong)
    /// report.
    #[tokio::test]
    async fn cached_source_report_errors_without_duration() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let media = test_media("nodur", None);
        let err = cached_source_report(&cache, &media, &opts(0.4, 500_000, true, true))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no known duration"), "got: {err:#}");
    }
}
