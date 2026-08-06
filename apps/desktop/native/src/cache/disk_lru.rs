//! Disk-cache LRU sweep + filename-keyed hygiene for the cheap-to-regenerate
//! derivative dirs: `filmstrip/`, `thumbnails/`, `waveforms/`.
//! Design: `docs/timeline-content-preview.md`.
//!
//! The filesystem is the database: a cache read refreshes mtime
//! (`cache::touch_if_stale`), this sweep sorts units by mtime and deletes
//! oldest-first until under the low-water mark. A wrong eviction costs one
//! ~90 ms ffmpeg re-run — the renderer's fetch of a just-deleted tile 404s,
//! parks the slot as error, and the TileEngine retry cooldown re-extracts —
//! so there is no cross-process coordination and two overlapping sweeps are
//! harmless (all deletes are best-effort).
//!
//! Nothing else under `Cache/` is swept — the rule is cheap-to-regenerate
//! only. Every other dir is either expensive to rebuild (`proxies/`, `audio/`
//! conform PCM, `shots/`), re-pays an API cost on eviction (`voiceover/`,
//! `transcribe-audio/`, `descriptions/`), or too small to be worth the risk
//! (`frames/`, `inline-subs/`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use super::{CacheLayout, FilmstripSrc};

/// Shared budget across the three swept dirs.
pub const DISK_CACHE_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Eviction target once over budget (90% of it), so the next few writes
/// don't immediately re-trigger a sweep.
const LOW_WATER_NUM: u64 = 9;
const LOW_WATER_DEN: u64 = 10;
/// `.tmp` entries younger than this may be mid-write; older ones are
/// interrupted-job leftovers. No tile/peaks/thumbnail job runs anywhere
/// near an hour.
const TMP_MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// Debounce window for write-triggered sweeps.
pub const SWEEP_DEBOUNCE: Duration = Duration::from_secs(60);

#[derive(Debug, Default)]
pub struct SweepReport {
    pub units_deleted: usize,
    pub bytes_deleted: u64,
}

/// Debounce latch for scheduled sweeps: `try_schedule` returns true only for
/// the caller that should spawn the sweep task; `finish` re-arms it. The
/// re-arm ordering is load-bearing — see `CacheLayout::schedule_sweep`.
#[derive(Debug, Default)]
pub struct SweepState {
    scheduled: AtomicBool,
}

impl SweepState {
    pub fn try_schedule(&self) -> bool {
        !self.scheduled.swap(true, Ordering::SeqCst)
    }

    pub fn finish(&self) {
        self.scheduled.store(false, Ordering::SeqCst);
    }
}

/// One evictable unit: a single file (peaks file, filmstrip tile) or a whole
/// directory (a media's thumbnail set — the 10 posters live and die together).
struct Unit {
    path: PathBuf,
    bytes: u64,
    mtime: SystemTime,
    is_dir: bool,
}

/// Full sweep: hygiene rules first (they delete regardless of budget), then
/// LRU eviction of the oldest units until under the low-water mark.
pub fn sweep(layout: &CacheLayout, budget_bytes: u64, now: SystemTime) -> SweepReport {
    let mut report = SweepReport::default();
    let mut units: Vec<Unit> = Vec::new();

    collect_waveforms(&layout.waveforms_dir(), now, &mut report, &mut units);
    collect_filmstrip(&layout.filmstrip_root(), now, &mut report, &mut units);
    collect_thumbnails(&layout.thumbnails_root(), now, &mut report, &mut units);

    let mut total: u64 = units.iter().map(|u| u.bytes).sum();
    if total > budget_bytes {
        let low_water = budget_bytes / LOW_WATER_DEN * LOW_WATER_NUM;
        units.sort_by_key(|u| u.mtime);
        for unit in &units {
            if total <= low_water {
                break;
            }
            let ok = if unit.is_dir {
                fs::remove_dir_all(&unit.path).is_ok()
            } else {
                fs::remove_file(&unit.path).is_ok()
            };
            if ok {
                total = total.saturating_sub(unit.bytes);
                report.units_deleted += 1;
                report.bytes_deleted += unit.bytes;
            }
        }
    }
    prune_empty_dirs(&layout.filmstrip_root());
    report
}

/// Missing/unreadable dirs iterate as empty — the sweep never errors.
fn read_dir_entries(dir: &Path) -> impl Iterator<Item = fs::DirEntry> {
    fs::read_dir(dir).into_iter().flatten().flatten()
}

/// `waveforms/`: `{hash}.v4.peaks` files are LRU units. Any other `.peaks`
/// version is an orphan from a format bump — the single-version reader
/// cannot open it — and is deleted unconditionally.
fn collect_waveforms(dir: &Path, now: SystemTime, report: &mut SweepReport, units: &mut Vec<Unit>) {
    for entry in read_dir_entries(dir) {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if name.ends_with(".tmp") {
            delete_if_aged_tmp(&path, &meta, now, report);
        } else if name.ends_with(".v4.peaks") {
            units.push(file_unit(path, &meta));
        } else if name.ends_with(".peaks") && fs::remove_file(&path).is_ok() {
            report.units_deleted += 1;
            report.bytes_deleted += meta.len();
        }
    }
}

/// `filmstrip/{hash}/{tag}/{lod}/{index:06}.jpg`: tiles are per-file LRU
/// units. Anything under `{hash}/` that is not a known provenance tag dir is
/// the pre-provenance layout (or a stray file) — unreachable by the current
/// key scheme — and is deleted unconditionally.
fn collect_filmstrip(
    root: &Path,
    now: SystemTime,
    report: &mut SweepReport,
    units: &mut Vec<Unit>,
) {
    for hash_entry in read_dir_entries(root) {
        let hash_path = hash_entry.path();
        if !hash_path.is_dir() {
            if let Ok(meta) = hash_entry.metadata() {
                delete_if_aged_tmp(&hash_path, &meta, now, report);
            }
            continue;
        }
        for tag_entry in read_dir_entries(&hash_path) {
            let tag_path = tag_entry.path();
            let tag_name = tag_entry.file_name().to_string_lossy().into_owned();
            if !(tag_path.is_dir() && FilmstripSrc::DIR_NAMES.contains(&tag_name.as_str())) {
                let bytes = entry_size(&tag_path);
                let ok = if tag_path.is_dir() {
                    fs::remove_dir_all(&tag_path).is_ok()
                } else {
                    fs::remove_file(&tag_path).is_ok()
                };
                if ok {
                    report.units_deleted += 1;
                    report.bytes_deleted += bytes;
                }
                continue;
            }
            for lod_entry in read_dir_entries(&tag_path) {
                for tile_entry in read_dir_entries(&lod_entry.path()) {
                    let Ok(meta) = tile_entry.metadata() else {
                        continue;
                    };
                    if !meta.is_file() {
                        continue;
                    }
                    let name = tile_entry.file_name().to_string_lossy().into_owned();
                    let tile_path = tile_entry.path();
                    if name.ends_with(".tmp") {
                        delete_if_aged_tmp(&tile_path, &meta, now, report);
                    } else if name.ends_with(".jpg") {
                        units.push(file_unit(tile_path, &meta));
                    }
                }
            }
        }
    }
}

/// `thumbnails/{hash}/` is ONE unit (the 10-poster set), keyed on the max
/// file mtime inside — the poster read's touch refreshes the whole set.
/// `{hash}.tmp/` dirs from interrupted jobs follow the aged-.tmp rule.
fn collect_thumbnails(
    root: &Path,
    now: SystemTime,
    report: &mut SweepReport,
    units: &mut Vec<Unit>,
) {
    for entry in read_dir_entries(root) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let (bytes, mtime) = dir_stats(&path);
        if name.ends_with(".tmp") {
            if age_of(mtime, now) > TMP_MAX_AGE && fs::remove_dir_all(&path).is_ok() {
                report.units_deleted += 1;
                report.bytes_deleted += bytes;
            }
            continue;
        }
        units.push(Unit {
            path,
            bytes,
            mtime,
            is_dir: true,
        });
    }
}

fn file_unit(path: PathBuf, meta: &fs::Metadata) -> Unit {
    Unit {
        path,
        bytes: meta.len(),
        mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        is_dir: false,
    }
}

/// A future mtime (clock skew) reads as age zero: never "aged", sorts last.
fn age_of(mtime: SystemTime, now: SystemTime) -> Duration {
    now.duration_since(mtime).unwrap_or(Duration::ZERO)
}

fn delete_if_aged_tmp(path: &Path, meta: &fs::Metadata, now: SystemTime, report: &mut SweepReport) {
    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    if age_of(mtime, now) > TMP_MAX_AGE && fs::remove_file(path).is_ok() {
        report.units_deleted += 1;
        report.bytes_deleted += meta.len();
    }
}

/// Recursive (total file bytes, max file mtime). An empty dir reports
/// UNIX_EPOCH — sorts oldest, which is right for an empty leftover.
fn dir_stats(dir: &Path) -> (u64, SystemTime) {
    let mut bytes = 0u64;
    let mut mtime = SystemTime::UNIX_EPOCH;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in read_dir_entries(&d) {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                bytes += meta.len();
                if let Ok(m) = meta.modified() {
                    if m > mtime {
                        mtime = m;
                    }
                }
            }
        }
    }
    (bytes, mtime)
}

fn entry_size(path: &Path) -> u64 {
    if path.is_dir() {
        dir_stats(path).0
    } else {
        fs::metadata(path).map(|m| m.len()).unwrap_or(0)
    }
}

/// Remove now-empty `{lod}`/`{tag}`/`{hash}` dirs left behind by tile
/// eviction. `fs::remove_dir` refuses non-empty dirs, so blunt is safe.
fn prune_empty_dirs(root: &Path) {
    for hash_entry in read_dir_entries(root) {
        let hash_path = hash_entry.path();
        if !hash_path.is_dir() {
            continue;
        }
        for tag_entry in read_dir_entries(&hash_path) {
            let tag_path = tag_entry.path();
            if !tag_path.is_dir() {
                continue;
            }
            for lod_entry in read_dir_entries(&tag_path) {
                let _ = fs::remove_dir(lod_entry.path());
            }
            let _ = fs::remove_dir(tag_path);
        }
        let _ = fs::remove_dir(hash_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::FilmstripSrc;
    use std::fs;
    use tempfile::TempDir;

    fn set_mtime(path: &Path, when: SystemTime) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(when))
            .unwrap();
    }

    fn hours_ago(now: SystemTime, h: u64) -> SystemTime {
        now - Duration::from_secs(h * 3600)
    }

    /// Write a filmstrip tile of `bytes` zeros and stamp its mtime.
    fn put_tile(
        layout: &CacheLayout,
        hash: &str,
        lod: u32,
        index: u32,
        bytes: usize,
        mtime: SystemTime,
    ) -> PathBuf {
        let p = layout.filmstrip_tile(hash, FilmstripSrc::Quick, lod, index);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, vec![0u8; bytes]).unwrap();
        set_mtime(&p, mtime);
        p
    }

    fn layout() -> (TempDir, CacheLayout) {
        let tmp = TempDir::new().unwrap();
        let l = CacheLayout::new(tmp.path().to_path_buf());
        l.ensure_dirs().unwrap();
        (tmp, l)
    }

    #[test]
    fn under_budget_deletes_nothing() {
        let (_tmp, l) = layout();
        let now = SystemTime::now();
        let t = put_tile(&l, "h", 0, 0, 400, hours_ago(now, 5));
        let report = sweep(&l, 1000, now);
        assert!(t.exists());
        assert_eq!(report.units_deleted, 0);
        assert_eq!(report.bytes_deleted, 0);
    }

    #[test]
    fn evicts_oldest_first_down_to_low_water() {
        let (_tmp, l) = layout();
        let now = SystemTime::now();
        // 4 x 400 B = 1600 B > 1000 B budget; low water 900 B.
        // Deleting the 4h tile leaves 1200 (> 900), the 3h tile leaves 800 (stop).
        let t4 = put_tile(&l, "h", 0, 0, 400, hours_ago(now, 4));
        let t3 = put_tile(&l, "h", 0, 1, 400, hours_ago(now, 3));
        let t2 = put_tile(&l, "h", 0, 2, 400, hours_ago(now, 2));
        let t1 = put_tile(&l, "h", 0, 3, 400, hours_ago(now, 1));
        let report = sweep(&l, 1000, now);
        assert!(!t4.exists() && !t3.exists());
        assert!(t2.exists() && t1.exists());
        assert_eq!(report.units_deleted, 2);
        assert_eq!(report.bytes_deleted, 800);
    }

    #[test]
    fn thumbnail_set_is_one_unit_keyed_on_max_file_mtime() {
        let (_tmp, l) = layout();
        let now = SystemTime::now();
        let dir = l.thumbnails("h");
        fs::create_dir_all(&dir).unwrap();
        for i in 0..2 {
            let p = l.thumbnail("h", i);
            fs::write(&p, vec![0u8; 200]).unwrap();
            set_mtime(&p, hours_ago(now, 5));
        }
        let tile = put_tile(&l, "h", 0, 0, 400, hours_ago(now, 1));
        // total 800 > 500 budget; low water 450. The 5h-old thumbnail SET
        // (one 400 B unit) goes first; 400 <= 450 stops before the tile.
        let report = sweep(&l, 500, now);
        assert!(!dir.exists(), "whole thumbnail dir evicted as one unit");
        assert!(tile.exists());
        assert_eq!(report.units_deleted, 1);
        assert_eq!(report.bytes_deleted, 400);
    }

    #[test]
    fn orphaned_peaks_versions_deleted_even_under_budget() {
        let (_tmp, l) = layout();
        let now = SystemTime::now();
        let v3 = l.waveforms_dir().join("aaa.v3.peaks");
        let v4 = l.waveform("aaa");
        fs::write(&v3, b"old").unwrap();
        fs::write(&v4, b"new").unwrap();
        let report = sweep(&l, u64::MAX, now);
        assert!(!v3.exists(), "unreadable old-version peaks are orphans");
        assert!(v4.exists());
        assert_eq!(report.units_deleted, 1);
    }

    #[test]
    fn aged_tmp_deleted_fresh_tmp_kept() {
        let (_tmp, l) = layout();
        let now = SystemTime::now();
        let aged = l.waveforms_dir().join("a.v4.peaks.tmp");
        fs::write(&aged, b"zzz").unwrap();
        set_mtime(&aged, hours_ago(now, 2));
        let fresh = put_tile(&l, "h", 0, 0, 10, now); // reuse tile helper dirs
        let fresh_tmp = fresh.with_extension("jpg.tmp");
        fs::write(&fresh_tmp, b"mid-write").unwrap();
        sweep(&l, u64::MAX, now);
        assert!(!aged.exists(), "interrupted-job leftover");
        assert!(
            fresh_tmp.exists(),
            "mid-write temp is protected by the age floor"
        );
    }

    #[test]
    fn pre_provenance_filmstrip_layout_deleted() {
        let (_tmp, l) = layout();
        let now = SystemTime::now();
        // Old layout: {hash}/{lod}/{index}.jpg — lod dir directly under hash.
        let old = l.filmstrip_root().join("h").join("3");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("000001.jpg"), b"old-layout").unwrap();
        let tagged = put_tile(&l, "h", 3, 1, 10, now);
        sweep(&l, u64::MAX, now);
        assert!(
            !old.exists(),
            "pre-provenance layout is unreachable by the key scheme"
        );
        assert!(tagged.exists());
    }

    #[test]
    fn eviction_prunes_empty_filmstrip_dirs() {
        let (_tmp, l) = layout();
        let now = SystemTime::now();
        let t = put_tile(&l, "gone", 0, 0, 400, hours_ago(now, 9));
        put_tile(&l, "kept", 0, 0, 100, now);
        sweep(&l, 200, now);
        assert!(!t.exists());
        assert!(
            !l.filmstrip_root().join("gone").exists(),
            "empty hash/tag/lod dirs pruned after eviction"
        );
    }

    #[test]
    fn sweep_state_coalesces_until_finished() {
        let s = SweepState::default();
        assert!(s.try_schedule(), "first caller schedules");
        assert!(!s.try_schedule(), "second caller coalesces");
        s.finish();
        assert!(s.try_schedule(), "re-armed after the window");
    }
}
