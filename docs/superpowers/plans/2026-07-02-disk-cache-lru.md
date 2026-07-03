# Disk-Cache LRU + Cache Hygiene (Plan C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound on-disk growth of the cheap-to-regenerate derivative caches (filmstrip/thumbnails/waveforms, 2 GiB shared budget), sweep stale artifacts, make the filmstrip disk key provenance-aware, partition the TileEngine memory budget per producer, and raise the timeline zoom ceiling to 2000 px/s.

**Architecture:** mtime-as-LRU-clock — a cache read refreshes the file's mtime (throttled), a background debounced sweep enumerates the three dirs, applies filename-keyed hygiene rules, and deletes oldest-mtime units until under a low-water mark. No sidecar index, no cross-process locking: a wrong eviction costs one ~90 ms ffmpeg re-run and the renderer's existing error-retry heals it. Approved design: `docs/superpowers/specs/2026-07-02-disk-cache-lru-design.md`.

**Tech Stack:** Rust (std::fs walk, tokio spawn/spawn_blocking, tracing), TypeScript (TileEngine, vitest).

## Global Constraints

- Gates for every task: `cargo test --lib --features jobs` (run in `apps/desktop/native`), `npx tsc -b` + `npx vitest run` (run in `apps/desktop`). Rust-only tasks may skip the TS gates and vice versa, EXCEPT the final task runs all.
- Stage commits by explicit path only (`git add <paths>`); parallel sessions may be editing this checkout. Re-check `git status` before each commit.
- Comment style per `docs/comment-style.md`: evergreen summary/why/landmine/pointer comments only; no changelog comments ("was X, now Y").
- Never pipe the cargo gate through `tail`/`head` (masks failures).
- Budget/threshold values are FIXED by the approved spec — do not tune them: 2 GiB disk budget, 90% low-water, 1 h touch throttle, 1 h `.tmp` age floor, 60 s sweep debounce, 160 MB filmstrip + 32 MB waveform engine budgets, `MAX_PX_PER_SEC = 2000`.
- Do NOT sweep `proxies/`, `audio/`, `voiceover/`, `transcribe-audio/`, `frames/`, `inline-subs/` — deliberate non-goals (see spec).

---

### Task 1: Filmstrip provenance tag in the disk key

The tile disk key becomes `filmstrip/{hash}/{tag}/{lod}/{index:06}.jpg` where `tag` names the decode source that produced the pixels. This fixes route-transition staleness (tiles extracted from the original while a media was `Bypass` kept serving after the media was route-corrected to `Proxied`) and makes old-source tiles into orphans the LRU can collect. Quick-first preference is unchanged and deliberate (short scrub GOP = accurate fast `-ss`; at 256 px decode height quick-vs-full is visually nil).

**Files:**
- Modify: `apps/desktop/native/src/cache/mod.rs` (enum + `filmstrip_tile` + its doc comment + layout test)
- Modify: `apps/desktop/native/src/jobs/filmstrip.rs` (`extract_tile` signature + tests)
- Modify: `apps/desktop/native/src/commands/media.rs` (`filmstrip_decode_source` returns a tuple + `get_filmstrip_tile` + tests)

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `pub enum FilmstripSrc { Orig, Quick, Full }` in `cache/mod.rs`, with `pub fn as_str(self) -> &'static str` (`"orig"`/`"quick"`/`"full"`) and `pub const DIR_NAMES: [&'static str; 3] = ["orig", "quick", "full"]` (Task 2's sweep uses `DIR_NAMES` to recognize tag dirs).
  - `CacheLayout::filmstrip_tile(&self, hash: &str, src: FilmstripSrc, lod: u32, index: u32) -> PathBuf`
  - `extract_tile(cache, src, src_tag: FilmstripSrc, hash, duration_us, lod, index)`
  - `filmstrip_decode_source(item) -> Result<(PathBuf, FilmstripSrc), String>`

- [ ] **Step 1: Write the failing tests.** In `cache/mod.rs`'s `layout_paths_are_content_addressable`, replace the `filmstrip_tile` assertion:

```rust
        assert_eq!(
            layout.filmstrip_tile("abc", FilmstripSrc::Quick, 3, 7),
            tmp.path().join("filmstrip").join("abc").join("quick").join("3").join("000007.jpg"),
        );
```

(add `FilmstripSrc` to the test module's `use super::*;` — already covered by the glob import). In `commands/media.rs`, update the three decode-source tests to destructure the tuple and assert tags:

```rust
    #[cfg(feature = "jobs")]
    #[test]
    fn filmstrip_source_bypass_and_direct_export_use_original() {
        use crate::cache::FilmstripSrc;
        let mut item = filmstrip_test_item(
            std::path::PathBuf::from("orig.mp4"),
            MediaKind::Video,
            DecodeRoute::Bypass,
        );
        assert_eq!(
            filmstrip_decode_source(&item).unwrap(),
            (std::path::PathBuf::from("orig.mp4"), FilmstripSrc::Orig),
        );
        item.decode_route = DecodeRoute::DirectExport { quick_proxy: None };
        assert_eq!(
            filmstrip_decode_source(&item).unwrap(),
            (std::path::PathBuf::from("orig.mp4"), FilmstripSrc::Orig),
        );
    }
```

In `filmstrip_source_proxied_waits_never_falls_back`, the two success assertions become:

```rust
        assert_eq!(filmstrip_decode_source(&item).unwrap(), (quick.clone(), crate::cache::FilmstripSrc::Quick));
```

```rust
        assert_eq!(filmstrip_decode_source(&item).unwrap(), (full.clone(), crate::cache::FilmstripSrc::Full));
```

(the two `unwrap_err() == "not_ready"` assertions and `filmstrip_rejects_non_video` are unchanged). In `jobs/filmstrip.rs`, update both extract tests to pass a tag — in `extract_then_cache_hit` and `tail_index_clamps_into_source` every `extract_tile(&cache, &video, "…", …)` call becomes `extract_tile(&cache, &video, crate::cache::FilmstripSrc::Orig, "…", …)`.

- [ ] **Step 2: Run to verify RED.** In `apps/desktop/native`: `cargo test --lib --features jobs filmstrip` — expect compile errors (`FilmstripSrc` not found / wrong arity), which is the expected RED for a signature change.

- [ ] **Step 3: Implement.** In `cache/mod.rs`, above `impl CacheLayout`:

```rust
/// Which decode source produced a filmstrip tile's pixels. Part of the tile's
/// disk key: when a media's decode route changes (e.g. Bypass ->
/// route-corrected Proxied), tiles from the old source stop matching and
/// re-extract; the stale-source orphans age out via the disk LRU. The tag
/// deliberately does NOT carry the proxy recipe version (see the design
/// spec's non-goals).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilmstripSrc {
    Orig,
    Quick,
    Full,
}

impl FilmstripSrc {
    /// The exhaustive set of valid tag dir names under `filmstrip/{hash}/`.
    /// The disk-LRU sweep treats anything else there as pre-provenance
    /// layout and deletes it.
    pub const DIR_NAMES: [&'static str; 3] = ["orig", "quick", "full"];

    pub fn as_str(self) -> &'static str {
        match self {
            FilmstripSrc::Orig => "orig",
            FilmstripSrc::Quick => "quick",
            FilmstripSrc::Full => "full",
        }
    }
}
```

Replace `filmstrip_tile` (and update the `filmstrip_root` doc comment's key shape sentence from "`{lod}/{index:06}.jpg`" to "`{tag}/{lod}/{index:06}.jpg` (tag = decode source: orig/quick/full)"):

```rust
    pub fn filmstrip_tile(&self, hash: &str, src: FilmstripSrc, lod: u32, index: u32) -> PathBuf {
        self.filmstrip_root()
            .join(hash)
            .join(src.as_str())
            .join(lod.to_string())
            .join(format!("{index:06}.jpg"))
    }
```

In `jobs/filmstrip.rs`, add the parameter (keep the arg order `cache, src, src_tag, hash, duration_us, lod, index`) and thread it to the cache path:

```rust
pub async fn extract_tile(
    cache: &CacheLayout,
    src: &Path,
    src_tag: crate::cache::FilmstripSrc,
    hash: &str,
    duration_us: Option<i64>,
    lod: u32,
    index: u32,
) -> Result<PathBuf> {
    validate_lod(lod)?;

    // Cache hit first: an already-extracted tile must stay reachable even
    // when the ffmpeg sidecar is broken — only the miss path needs ffmpeg.
    let dest = cache.filmstrip_tile(hash, src_tag, lod, index);
```

(rest of the function body unchanged). In `commands/media.rs`:

```rust
#[cfg(feature = "jobs")]
pub fn filmstrip_decode_source(item: &MediaItem) -> Result<(PathBuf, crate::cache::FilmstripSrc), String> {
    use crate::cache::FilmstripSrc;
    if !matches!(item.kind, MediaKind::Video) {
        return Err("filmstrip tiles only valid for Video media".to_string());
    }
    match &item.decode_route {
        state::DecodeRoute::Bypass | state::DecodeRoute::DirectExport { .. } => {
            Ok((item.path_abs.clone(), FilmstripSrc::Orig))
        }
        state::DecodeRoute::Proxied { quick_proxy, full_proxy, .. } => {
            [(quick_proxy, FilmstripSrc::Quick), (full_proxy, FilmstripSrc::Full)]
                .into_iter()
                .filter_map(|(p, tag)| p.as_ref().map(|p| (p, tag)))
                .find(|(p, _)| crate::cache::cached_ok(p))
                .map(|(p, tag)| (p.clone(), tag))
                .ok_or_else(|| "not_ready".to_string())
        }
    }
}
```

and in `get_filmstrip_tile`:

```rust
    let (src, src_tag) = filmstrip_decode_source(&args.item)?;
    filmstrip::validate_lod(args.lod).map_err(|e| format!("{e:#}"))?;
    let duration_us = args.item.metadata.duration_us;
    let hash = args.item.file_hash_blake3.clone();
    let path = filmstrip::extract_tile(&backend.cache, &src, src_tag, &hash, duration_us, args.lod, args.index)
        .await
        .map_err(|e| format!("extract filmstrip tile: {e:#}"))?;
```

- [ ] **Step 4: Run gate.** `cargo test --lib --features jobs` — full suite green (the two ffmpeg-dependent filmstrip tests self-skip when ffmpeg is absent; on this machine ffmpeg is on PATH so they run).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/cache/mod.rs apps/desktop/native/src/jobs/filmstrip.rs apps/desktop/native/src/commands/media.rs
git commit -m "feat(filmstrip): provenance tag in the tile disk key"
```

---

### Task 2: Disk-LRU sweep core (hygiene rules + eviction)

Pure synchronous fs logic with injectable budget and clock — no tokio, no scheduling (that's Task 3). Deletes are best-effort: a locked/vanished file just stays for the next sweep.

**Files:**
- Create: `apps/desktop/native/src/cache/disk_lru.rs`
- Modify: `apps/desktop/native/src/cache/mod.rs` (add `pub mod disk_lru;` — `cache/mod.rs` is `cache/` module root, so the new file sits alongside it)
- Tests: in-file `mod tests` of `disk_lru.rs`

**Interfaces:**
- Consumes: `CacheLayout::{waveforms_dir, filmstrip_root, thumbnails_root}` (existing), `FilmstripSrc::DIR_NAMES` (Task 1).
- Produces (Task 3 relies on these exact names):
  - `pub const DISK_CACHE_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;`
  - `pub const SWEEP_DEBOUNCE: Duration = Duration::from_secs(60);`
  - `pub struct SweepReport { pub units_deleted: usize, pub bytes_deleted: u64 }` (derives `Debug, Default`)
  - `pub struct SweepState` with `pub fn try_schedule(&self) -> bool` / `pub fn finish(&self)` (derives `Default`)
  - `pub fn sweep(layout: &CacheLayout, budget_bytes: u64, now: SystemTime) -> SweepReport`

- [ ] **Step 1: Write the failing tests.** Create `disk_lru.rs` with the module skeleton (constants + types compiling, `sweep` body `todo!()` is NOT allowed — write the real signature returning `SweepReport::default()` so tests compile and FAIL rather than panic) and this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::FilmstripSrc;
    use std::fs;
    use tempfile::TempDir;

    fn set_mtime(path: &Path, when: SystemTime) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(when)).unwrap();
    }

    fn hours_ago(now: SystemTime, h: u64) -> SystemTime {
        now - Duration::from_secs(h * 3600)
    }

    /// Write a filmstrip tile of `bytes` zeros and stamp its mtime.
    fn put_tile(layout: &CacheLayout, hash: &str, lod: u32, index: u32, bytes: usize, mtime: SystemTime) -> PathBuf {
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
        let v2 = l.waveforms_dir().join("aaa.v2.peaks");
        let v3 = l.waveform("aaa");
        fs::write(&v2, b"old").unwrap();
        fs::write(&v3, b"new").unwrap();
        let report = sweep(&l, u64::MAX, now);
        assert!(!v2.exists(), "unreadable old-version peaks are orphans");
        assert!(v3.exists());
        assert_eq!(report.units_deleted, 1);
    }

    #[test]
    fn aged_tmp_deleted_fresh_tmp_kept() {
        let (_tmp, l) = layout();
        let now = SystemTime::now();
        let aged = l.waveforms_dir().join("a.v3.peaks.tmp");
        fs::write(&aged, b"zzz").unwrap();
        set_mtime(&aged, hours_ago(now, 2));
        let fresh = put_tile(&l, "h", 0, 0, 10, now); // reuse tile helper dirs
        let fresh_tmp = fresh.with_extension("jpg.tmp");
        fs::write(&fresh_tmp, b"mid-write").unwrap();
        sweep(&l, u64::MAX, now);
        assert!(!aged.exists(), "interrupted-job leftover");
        assert!(fresh_tmp.exists(), "mid-write temp is protected by the age floor");
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
        assert!(!old.exists(), "pre-provenance layout is unreachable by the key scheme");
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
```

- [ ] **Step 2: Run to verify RED.** `cargo test --lib --features jobs disk_lru` — expect the behavior tests to FAIL (stub `sweep` deletes nothing); `sweep_state_coalesces_until_finished` may already pass once `SweepState` is written — that's fine.

- [ ] **Step 3: Implement the module.** Full content of `disk_lru.rs` (above the test module):

```rust
//! Disk-cache LRU sweep + filename-keyed hygiene for the cheap-to-regenerate
//! derivative dirs: `filmstrip/`, `thumbnails/`, `waveforms/`.
//! Design: `docs/superpowers/specs/2026-07-02-disk-cache-lru-design.md`.
//!
//! The filesystem is the database: a cache read refreshes mtime
//! (`cache::touch_if_stale`), this sweep sorts units by mtime and deletes
//! oldest-first until under the low-water mark. A wrong eviction costs one
//! ~90 ms ffmpeg re-run — the renderer's fetch of a just-deleted tile 404s,
//! parks the slot as error, and the TileEngine retry cooldown re-extracts —
//! so there is no cross-process coordination and two overlapping sweeps are
//! harmless (all deletes are best-effort).
//!
//! Deliberately NOT swept: `proxies/` (minutes to regenerate), `audio/`
//! conform PCM (playback-critical), `voiceover/` + `transcribe-audio/`
//! (eviction re-pays API cost), `frames/` (small until MCP-driven extraction
//! gets heavy), `inline-subs/` (unused scaffolding).

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
/// the caller that should spawn the sweep task; `finish` re-arms it (called
/// when the debounce window closes, BEFORE the walk runs, so writes landing
/// during a long walk can schedule the next one).
#[derive(Default)]
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

/// `waveforms/`: `{hash}.v3.peaks` files are LRU units. Any other `.peaks`
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
        } else if name.ends_with(".v3.peaks") {
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
fn collect_filmstrip(root: &Path, now: SystemTime, report: &mut SweepReport, units: &mut Vec<Unit>) {
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
                    let Ok(meta) = tile_entry.metadata() else { continue };
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
fn collect_thumbnails(root: &Path, now: SystemTime, report: &mut SweepReport, units: &mut Vec<Unit>) {
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
        units.push(Unit { path, bytes, mtime, is_dir: true });
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
```

Add to `cache/mod.rs` (below the module doc, above `use std::fs;`):

```rust
pub mod disk_lru;
```

Note `low_water` is computed `budget / 10 * 9` (divide first) to avoid overflow near `u64::MAX` — the `orphaned_peaks_versions_deleted_even_under_budget` test passes `u64::MAX` as the budget.

- [ ] **Step 4: Run gate.** `cargo test --lib --features jobs disk_lru` — all 8 tests green, then the full `cargo test --lib --features jobs`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/cache/disk_lru.rs apps/desktop/native/src/cache/mod.rs
git commit -m "feat(cache): disk-LRU sweep + hygiene rules for derivative caches"
```

---

### Task 3: Sweep scheduling + writer notifications

Wire the sweep into runtime: debounced background scheduling on `CacheLayout`, a prompt sweep on workspace open, `notify_write()` at the three derivative writers, and one log line per non-empty sweep.

**Files:**
- Modify: `apps/desktop/native/src/cache/mod.rs` (`sweeper` field, `notify_write`/`sweep_soon`/`schedule_sweep`, `set_workspace` hook, tokio tests)
- Modify: `apps/desktop/native/src/jobs/filmstrip.rs` (notify after promote)
- Modify: `apps/desktop/native/src/jobs/waveform.rs` (notify after promote)
- Modify: `apps/desktop/native/src/jobs/thumbnails.rs` (notify after dir promote)

**Interfaces:**
- Consumes: `disk_lru::{sweep, SweepState, SweepReport, DISK_CACHE_BUDGET_BYTES, SWEEP_DEBOUNCE}` (Task 2).
- Produces: `CacheLayout::notify_write(&self)` and `CacheLayout::sweep_soon(&self)` — both no-ops outside a tokio runtime.

- [ ] **Step 1: Write the failing test.** In `cache/mod.rs`'s `mod tests`:

```rust
    /// End-to-end scheduling proof via a hygiene rule (budget-independent):
    /// sweep_soon must delete an orphaned v2 peaks file in the background.
    #[tokio::test]
    async fn sweep_soon_runs_hygiene_in_background() {
        let tmp = TempDir::new().unwrap();
        let layout = CacheLayout::new(tmp.path().to_path_buf());
        layout.ensure_dirs().unwrap();
        let orphan = layout.waveforms_dir().join("aaa.v2.peaks");
        fs::write(&orphan, b"old").unwrap();

        layout.sweep_soon();
        for _ in 0..200 {
            if !orphan.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(!orphan.exists(), "background sweep never ran");
    }
```

- [ ] **Step 2: Run to verify RED.** `cargo test --lib --features jobs sweep_soon` — compile error (`sweep_soon` not found) is the expected RED.

- [ ] **Step 3: Implement.** In `cache/mod.rs`, add the field (and initialize it in `new()`):

```rust
#[derive(Clone, Debug)]
pub struct CacheLayout {
    /// Current cache root. Swapped by `set_workspace` when the user opens or
    /// saves a project to a folder. Reads clone-by-value; never hand out a
    /// borrowed reference to the locked value or callers will deadlock on
    /// the next swap.
    root: Arc<RwLock<PathBuf>>,
    /// Debounce latch for background disk-LRU sweeps (`cache::disk_lru`).
    sweeper: Arc<disk_lru::SweepState>,
}
```

(`SweepState` has no `Debug` derive — add `#[derive(Debug, Default)]` to it in `disk_lru.rs` so the layout's derive keeps compiling.) In `new()`:

```rust
        Self {
            root: Arc::new(RwLock::new(root)),
            sweeper: Arc::new(disk_lru::SweepState::default()),
        }
```

Methods on `impl CacheLayout`:

```rust
    /// Writers call this after landing a new derivative file. Debounced: the
    /// first call schedules a sweep `SWEEP_DEBOUNCE` later; calls inside the
    /// window coalesce. Outside a tokio runtime (sync unit tests) it is a
    /// no-op — the next workspace open sweeps anyway.
    pub fn notify_write(&self) {
        self.schedule_sweep(disk_lru::SWEEP_DEBOUNCE);
    }

    /// Prompt full sweep (workspace open): hygiene rules + budget eviction,
    /// no debounce. Also a no-op outside a runtime.
    pub fn sweep_soon(&self) {
        self.schedule_sweep(std::time::Duration::ZERO);
    }

    fn schedule_sweep(&self, delay: std::time::Duration) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        if !self.sweeper.try_schedule() {
            return;
        }
        let layout = self.clone();
        handle.spawn(async move {
            tokio::time::sleep(delay).await;
            // Re-arm BEFORE the walk: writes landing during a long sweep can
            // schedule the next one. The walk re-reads the CURRENT root, so a
            // workspace swap mid-schedule just sweeps the new root.
            layout.sweeper.finish();
            let l2 = layout.clone();
            let report = tokio::task::spawn_blocking(move || {
                disk_lru::sweep(&l2, disk_lru::DISK_CACHE_BUDGET_BYTES, std::time::SystemTime::now())
            })
            .await
            .unwrap_or_default();
            if report.units_deleted > 0 {
                tracing::info!(
                    units = report.units_deleted,
                    mb = report.bytes_deleted / (1024 * 1024),
                    "disk cache sweep evicted"
                );
            }
        });
    }
```

In `set_workspace`, replace the tail call:

```rust
        self.ensure_dirs()?;
        // Workspace open is the prompt-sweep trigger: hygiene + budget
        // eviction run once in the background.
        self.sweep_soon();
        Ok(())
```

Writer notifications — `jobs/filmstrip.rs` (`extract_tile`, after `promote_temp`):

```rust
    promote_temp(&dest)?;
    cache.notify_write();
    Ok(dest)
```

`jobs/waveform.rs` (`run`, after `promote_temp`):

```rust
    promote_temp(&dest)?;
    cache.notify_write();
    Ok(dest)
```

`jobs/thumbnails.rs` (`run`, after the `tokio::fs::rename(&tmp_dir, &dest_dir)` promote):

```rust
    cache.notify_write();
    Ok(dest_dir)
```

- [ ] **Step 4: Run gate.** `cargo test --lib --features jobs` — the new tokio test green, the existing SYNC `set_workspace_swaps_root_and_creates_dirs` test still green (no runtime → `sweep_soon` no-ops).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/cache/mod.rs apps/desktop/native/src/cache/disk_lru.rs apps/desktop/native/src/jobs/filmstrip.rs apps/desktop/native/src/jobs/waveform.rs apps/desktop/native/src/jobs/thumbnails.rs
git commit -m "feat(cache): debounced background sweep scheduling + writer notifications"
```

---

### Task 4: mtime touch on cache reads

mtime is the LRU clock, so every read of a swept-cache entry must refresh it — throttled so hot paths stay at one metadata read.

**Files:**
- Modify: `apps/desktop/native/src/cache/mod.rs` (`TOUCH_THROTTLE` + `touch_if_stale` + test)
- Modify: `apps/desktop/native/src/jobs/filmstrip.rs` (hit-branch touch + test)
- Modify: `apps/desktop/native/src/commands/media.rs` (touch in `get_media_thumbnail`, `get_waveform_peaks`, `get_waveform_levels`, `get_waveform_tile`)
- Modify: `apps/desktop/native/src/mcp/tools.rs` (touch in `detect_silences` — it reads the peaks file via `jobs::read_peaks_file`, bypassing `get_waveform_peaks`; found by Task 4's review, amended into the plan: the original reader enumeration missed this fifth swept-cache read path)

**Interfaces:**
- Produces: `pub const TOUCH_THROTTLE: Duration = Duration::from_secs(60 * 60);` and `pub fn touch_if_stale(path: &Path)` in `cache/mod.rs`.

- [ ] **Step 1: Write the failing tests.** In `cache/mod.rs` tests (add `use std::time::{Duration, SystemTime};` to the test module and the `set_mtime` helper from Task 2's test module — duplicated here, it's 3 lines):

```rust
    fn set_mtime(path: &Path, when: SystemTime) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(when)).unwrap();
    }

    #[test]
    fn touch_if_stale_updates_only_stale_mtimes() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("tile.jpg");
        fs::write(&path, b"x").unwrap();
        let now = SystemTime::now();

        // 30 min old: inside TOUCH_THROTTLE, must NOT be rewritten.
        set_mtime(&path, now - Duration::from_secs(30 * 60));
        touch_if_stale(&path);
        let m = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(m < now - Duration::from_secs(29 * 60), "fresh mtime rewritten");

        // 2 h old: stale, must be refreshed to ~now.
        set_mtime(&path, now - Duration::from_secs(2 * 3600));
        touch_if_stale(&path);
        let m = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(m > now - Duration::from_secs(60), "stale mtime not refreshed");
    }
```

In `jobs/filmstrip.rs` tests (this exercises the hit branch WITHOUT ffmpeg — the cache-hit check precedes the ffmpeg-installed check):

```rust
    #[tokio::test]
    async fn cache_hit_refreshes_stale_mtime() {
        use std::time::{Duration, SystemTime};
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let dest = cache.filmstrip_tile("h", crate::cache::FilmstripSrc::Orig, 2, 1);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, b"jpg").unwrap();
        let f = std::fs::File::options().write(true).open(&dest).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(2 * 3600))).unwrap();
        drop(f);

        // Hit path returns before any ffmpeg concern: src may not exist.
        let p = extract_tile(&cache, Path::new("missing.mp4"), crate::cache::FilmstripSrc::Orig, "h", None, 2, 1)
            .await
            .expect("cache hit");
        assert_eq!(p, dest);
        let m = std::fs::metadata(&dest).unwrap().modified().unwrap();
        assert!(m > SystemTime::now() - Duration::from_secs(60), "hit must touch the LRU clock");
    }
```

- [ ] **Step 2: Run to verify RED.** `cargo test --lib --features jobs touch_if_stale` and `cargo test --lib --features jobs cache_hit_refreshes` — compile error / assertion failure is the RED.

- [ ] **Step 3: Implement.** In `cache/mod.rs` (near `cached_ok`; add `use std::time::{Duration, SystemTime};` to the imports):

```rust
/// How stale a cache entry's mtime must be before a read refreshes it —
/// relatime semantics: hot-path hits stay at one metadata read.
pub const TOUCH_THROTTLE: Duration = Duration::from_secs(60 * 60);

/// Mark a swept-cache file as recently used by bumping its mtime. mtime IS
/// the disk-LRU clock (`cache::disk_lru`): reads that skip this age out as
/// if unused. Best-effort — errors are ignored (worst case the file evicts
/// and regenerates). A future mtime (clock skew) counts as stale so it
/// normalizes back to now.
pub fn touch_if_stale(path: &Path) {
    let now = SystemTime::now();
    let Ok(meta) = fs::metadata(path) else { return };
    let stale = match meta.modified() {
        Ok(m) => now.duration_since(m).map(|age| age > TOUCH_THROTTLE).unwrap_or(true),
        Err(_) => true,
    };
    if !stale {
        return;
    }
    if let Ok(f) = fs::File::options().write(true).open(path) {
        let _ = f.set_times(fs::FileTimes::new().set_modified(now));
    }
}
```

`jobs/filmstrip.rs` hit branch:

```rust
    let dest = cache.filmstrip_tile(hash, src_tag, lod, index);
    if cached_ok(&dest) {
        crate::cache::touch_if_stale(&dest);
        return Ok(dest);
    }
```

`commands/media.rs` — one line in each of the four readers, right after the path is resolved:

```rust
pub async fn get_media_thumbnail(item: MediaItem) -> Result<String, String> {
    let dir = item.thumbnails_dir.clone().ok_or_else(|| "not_ready".to_string())?;
    let path = dir.join("004.jpg");
    crate::cache::touch_if_stale(&path);
```

```rust
pub async fn get_waveform_peaks(item: MediaItem) -> Result<WaveformPeaks, String> {
    let path = item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    crate::cache::touch_if_stale(&path);
```

```rust
pub async fn get_waveform_levels(item: MediaItem) -> Result<WaveformLevels, String> {
    let path = item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    crate::cache::touch_if_stale(&path);
```

```rust
pub async fn get_waveform_tile(args: WaveformTileArgs) -> Result<WaveformTile, String> {
    let path = args.item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    crate::cache::touch_if_stale(&path);
```

- [ ] **Step 4: Run gate.** `cargo test --lib --features jobs` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/cache/mod.rs apps/desktop/native/src/jobs/filmstrip.rs apps/desktop/native/src/commands/media.rs
git commit -m "feat(cache): mtime touch on derivative cache reads"
```

---

### Task 5: TileEngine per-producer byte budgets (TS)

Eviction becomes per producer kind: filmstrip bitmap pressure can no longer evict waveform tiles. Producers without a declared budget keep the engine-wide default, so every existing test stays green unmodified.

**Files:**
- Modify: `apps/desktop/src/renderer/timeline/tileEngine/TileEngine.ts`
- Modify: `apps/desktop/src/renderer/timeline/tileEngine/FilmstripTileProducer.ts`
- Modify: `apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.ts`
- Test: `apps/desktop/src/renderer/timeline/tileEngine/TileEngine.test.ts`

**Interfaces:**
- Produces: `TileProducer.budgetBytes?: number`; `export const FILMSTRIP_TILE_BUDGET_BYTES = 160 * 1024 * 1024` (FilmstripTileProducer.ts); `export const WAVEFORM_TILE_BUDGET_BYTES = 32 * 1024 * 1024` (WaveformTileProducer.ts).

- [ ] **Step 1: Write the failing test** in `TileEngine.test.ts`:

```ts
  it("evicts per producer kind: one kind's pressure leaves other kinds alone", async () => {
    const big = Array.from({ length: 80 }, (_, i) => i); // 640 bytes
    const a = makeProducer({ kind: "a", budgetBytes: 800 });
    const b = makeProducer({ kind: "b", budgetBytes: 10_000 });
    engine.register(a.producer);
    engine.register(b.producer);

    const kb: TileKey = { mediaId: "m", kind: "b", lod: 0, index: 0 };
    engine.request(kb); b.resolve("0:0", big); await Promise.resolve();

    const ka0: TileKey = { mediaId: "m", kind: "a", lod: 0, index: 0 };
    const ka1: TileKey = { mediaId: "m", kind: "a", lod: 0, index: 1 };
    engine.request(ka0); a.resolve("0:0", big); await Promise.resolve();
    engine.request(ka1); a.resolve("0:1", big); await Promise.resolve();

    // kind a is over ITS 800-byte budget (1280) -> evicts its own oldest.
    // kind b's tile is the globally oldest touch but must be untouched.
    expect(engine.get(kb)?.state).toBe("ready");
    expect(engine.get(ka0)).toBeUndefined();
    expect(engine.get(ka1)?.state).toBe("ready");
  });
```

- [ ] **Step 2: Run to verify RED.** In `apps/desktop`: `npx vitest run src/renderer/timeline/tileEngine/TileEngine.test.ts` — the new test FAILS (global budget evicts `kb`, the globally-oldest ready slot).

- [ ] **Step 3: Implement.** In `TileEngine.ts`, extend the producer interface:

```ts
  /// Byte budget for this producer's ready tiles. Producers without one share
  /// the engine-wide default. Eviction is per kind: one producer's byte
  /// pressure never evicts another's tiles (filmstrip bitmaps ~466 KB would
  /// otherwise churn the ~48 KB waveform tiles out).
  budgetBytes?: number;
```

Replace `private totalBytes = 0;` with `private bytesByKind = new Map<string, number>();`, and the three touch points:

```ts
        const bytes = producer.bytes(value);
        slot.entry = { state: "ready", value };
        slot.bytes = bytes;
        this.bytesByKind.set(key.kind, (this.bytesByKind.get(key.kind) ?? 0) + bytes);
        this.evictToBudget(ks, key.kind);
        this.notify(key.mediaId);
```

```ts
  private freeSlot(ks: string, slot: Slot<unknown>): void {
    if (slot.entry.state === "ready") {
      this.producers.get(slot.key.kind)?.dispose?.(slot.entry.value);
      this.bytesByKind.set(slot.key.kind, (this.bytesByKind.get(slot.key.kind) ?? 0) - slot.bytes);
    }
    this.slots.delete(ks);
  }

  private evictToBudget(protectKs: string, kind: string): void {
    const budget = this.producers.get(kind)?.budgetBytes ?? this.budgetBytes;
    const kindBytes = () => this.bytesByKind.get(kind) ?? 0;
    if (kindBytes() <= budget) return;
    const ready = [...this.slots.entries()]
      .filter(([ks, s]) => ks !== protectKs && s.key.kind === kind && s.entry.state === "ready")
      .sort((a, b) => a[1].version - b[1].version); // oldest touch first
    for (const [ks, slot] of ready) {
      if (kindBytes() <= budget) break;
      this.freeSlot(ks, slot);
    }
  }
```

In `FilmstripTileProducer.ts`, near the other exported constants:

```ts
/// Engine-side bitmap budget. 256 px bitmaps run ~466 KB — a dedicated pool
/// (~350 tiles, ~3x the field-measured visible-slot count) keeps their
/// pressure off the waveform tiles.
export const FILMSTRIP_TILE_BUDGET_BYTES = 160 * 1024 * 1024;
```

and in the `engine.register<FilmstripTileValue>({ ... })` literal add `budgetBytes: FILMSTRIP_TILE_BUDGET_BYTES,` after `invalidateOn`. In `WaveformTileProducer.ts`:

```ts
/// Engine-side budget for waveform tiles (~48 KB each -> ~680 tiles, far
/// above what the viewport-bounded fetch can request at once).
export const WAVEFORM_TILE_BUDGET_BYTES = 32 * 1024 * 1024;
```

and add `budgetBytes: WAVEFORM_TILE_BUDGET_BYTES,` after `kind: WAVEFORM_KIND,` in its `engine.register<TileValue>({ ... })` literal.

- [ ] **Step 4: Run gates.** `npx vitest run src/renderer/timeline/tileEngine` (all green, including the untouched pre-existing eviction test) then `npx tsc -b` and the full `npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/timeline/tileEngine/TileEngine.ts apps/desktop/src/renderer/timeline/tileEngine/TileEngine.test.ts apps/desktop/src/renderer/timeline/tileEngine/FilmstripTileProducer.ts apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.ts
git commit -m "feat(timeline): per-producer TileEngine byte budgets"
```

---

### Task 6: Raise the zoom ceiling

Constant change, no new test (the clamp logic in `useTimelineView` consumes the constant symbolically and is already covered).

**Files:**
- Modify: `apps/desktop/src/renderer/timeline/geometry.ts:17`

- [ ] **Step 1: Edit.** Replace the constant (line 17) and annotate the accepted tradeoff:

```ts
// 2000 px/s exceeds the waveform's stored finest LOD (1000 peaks/s): past
// ~1333 px/s the envelope stretches instead of gaining detail — accepted;
// the filmstrip (the ceiling's driver) keeps densifying to lod 0.
export const MAX_PX_PER_SEC = 2000;
```

- [ ] **Step 2: Run gates.** `npx tsc -b` and full `npx vitest run` — if any test pinned the 800 ceiling it fails here; per the pre-plan grep none does (the `800`s in test files are `pxPerSec` sample values, not ceiling assertions), so expect green.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/timeline/geometry.ts
git commit -m "feat(timeline): raise zoom ceiling to 2000 px/s"
```

---

### Task 7: Doc + comment writeback

**Files:**
- Modify: `apps/desktop/native/src/cache/mod.rs` (the `filmstrip_root` doc comment)
- Modify: `docs/timeline-content-preview.md` ("Visibility and Caching" section)

- [ ] **Step 1: Update `filmstrip_root`'s doc comment** — the sentence "Growth is bounded by the disk-cache LRU (follow-up plan); tiles are ~15-25 KB JPGs." becomes:

```rust
    /// disk-cache LRU sweep (`cache::disk_lru`) bounds growth; tiles are
    /// ~15-25 KB JPGs.
```

(keep the rest of the comment, including the Task-1 key-shape update, intact).

- [ ] **Step 2: Add one bullet** to `docs/timeline-content-preview.md`'s "Visibility and Caching" list, after "- Cache waveform peaks by `mediaId`.":

```markdown
- Disk-side, the filmstrip/thumbnail/waveform caches share a 2 GiB budget:
  reads refresh file mtimes and a background sweep evicts oldest-first
  (`native/src/cache/disk_lru.rs`).
```

Evergreen tone: no dates, no plan references.

- [ ] **Step 3: Run all gates.** `cargo test --lib --features jobs` (native), `npx tsc -b` + `npx vitest run` (desktop) — doc-only changes, but this is the plan's final green checkpoint.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/native/src/cache/mod.rs docs/timeline-content-preview.md
git commit -m "docs(timeline): describe the disk-cache LRU"
```

---

## Final verification (after all tasks)

- Real-app smoke (optional but recommended; needs the addon rebuilt — CLOSE the dev app first, then `npm run napi:build`, never piped): open a workspace with prior imports and confirm (a) a `disk cache sweep evicted` log line appears if any `*.v2.peaks` orphans existed, (b) timeline filmstrip + waveform still render, (c) after deleting a tile JPG by hand the strip self-heals within the 5 s retry.
- The spec's hand-check with a tiny budget is covered by `evicts_oldest_first_down_to_low_water` (unit-level, injected budget) — no app-level budget override exists by design.

## Self-Review Notes

- **Spec coverage:** §1 disk-LRU core → Tasks 2 (walk/eviction) + 3 (triggers/observability) + 4 (touch); §2 hygiene → Task 2; §3 provenance tag → Task 1; §4 engine budgets → Task 5; §5 zoom ceiling → Task 6; testing §6 → per-task steps; evergreen writeback → Task 7.
- **Ordering:** Task 1 before Task 2 because the sweep's pre-provenance rule consumes `FilmstripSrc::DIR_NAMES`; Task 2 before 3 (scheduler calls `sweep`); Task 4 independent after 1 (touches the tagged hit path).
- **Type consistency:** `FilmstripSrc` (T1) ↔ `DIR_NAMES` use (T2) ↔ hit-path test (T4); `SweepState::{try_schedule, finish}` (T2) ↔ `schedule_sweep` (T3); `SweepReport.units_deleted/bytes_deleted` (T2) ↔ log line (T3); `budgetBytes` (T5 interface) ↔ both producer literals (T5).
- **Known crumbs accepted:** `set_mtime` test helper duplicated in `disk_lru.rs` and `cache/mod.rs` test modules (3 lines each; sharing would need a test-support module for no real gain).
