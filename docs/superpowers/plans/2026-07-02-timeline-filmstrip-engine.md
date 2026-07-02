# Timeline Filmstrip Tile Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 10-poster stretched `<img>` filmstrip with real tiles on the existing `TileEngine` — temporally accurate, zoom-adaptive, flicker-free, extracted on demand from the correct decode source.

**Architecture:** A new Rust on-demand extractor (`jobs/filmstrip.rs`, modeled on `jobs/frame.rs`) writes canonical-height JPG tiles into a blake3-keyed disk cache; a new `get_filmstrip_tile` command rides the existing single-media stateless-compute seam; a new `FilmstripTileProducer` feeds `ImageBitmap`s into the shared `TileEngine`; a rewritten `TimelineFilmstrip` paints them at true source-time positions on canvas segments, mirroring `TimelineWaveform`'s render architecture. The engine gains `invalidateOn` (proxy completion flips `not_ready` tiles) and error-tile retry.

**Tech Stack:** Rust (ffmpeg sidecar, napi command), TypeScript/React (TileEngine producer, canvas render), Vitest + cargo test.

This is the task expansion of **Plan B** in
`docs/superpowers/plans/2026-07-02-timeline-display-upgrades.md`. The two
[verify] items that gated this breakdown are resolved below (Design
resolutions §1–§2); the display/data design is otherwise exactly as locked.

## Design resolutions (the two [verify] items + breakdown-time decisions)

1. **Proxy job kind strings** (`native/src/jobs/mod.rs` `JobKind`, serde
   `rename_all = "lowercase"` + explicit renames): full proxy completion emits
   `media:job_complete` with `kind: "proxy"`, quick proxy with
   `kind: "quick_proxy"`. Both carry `media_id`. The filmstrip producer
   registers `invalidateOn: ["proxy", "quick_proxy"]` — for a `Proxied` source
   either landing changes extraction availability.
2. **Proxy-path resolution:** none needed over IPC. `get_filmstrip_tile` is a
   `SINGLE_MEDIA_CHANNELS` channel (`src/main/index.ts` resolves `mediaId` →
   full `MediaItem` and forwards it), and `DecodeRoute` carries proxy paths
   inside its variants. Rust resolves locally: `Bypass` / `DirectExport` →
   `path_abs` (direct-route media extracts from the original, per the locked
   proxy-wait rule); `Proxied` → `quick_proxy` else `full_proxy` (same
   preference as the renderer's `resolveDecode` preview path), each guarded by
   `cached_ok`; neither on disk → `Err("not_ready")`, never the original.
3. **No ffmpeg-jobs semaphore for tile extracts** — parity with
   `jobs/frame.rs` (the on-demand MCP frame extractor also skips
   `ffmpeg_sem()`); interactive extracts must not queue behind proxy
   transcodes. Concurrency is bounded producer-side at
   `FILMSTRIP_MAX_CONCURRENT_FETCHES = 4`.
4. **Tail clamp:** `t_us = min(index * spacing, max(0, duration_us − 100_000))`
   when duration metadata is known — `-ss` at/past the last frame emits zero
   frames and would error; 100 ms of tail slack is thumbnail-grade acceptable.
5. **`widthPx`/`heightPx` in the response are informative** (derived from probe
   metadata scaled to 256 height). The producer sizes layout from
   `ImageBitmap.width/height` — the decoded truth.
6. **Fallback draw is a painter's pass, bidirectional:** consulted lods are
   `target ± 3` (clamped to `[0, 12]`), drawing every READY tile in each lod's
   visible range (`get()` only — never `request()` a non-target lod). Paint
   order: finer backfill first (`target−3`, `target−2`, `target−1`), then the
   coarse pass ending at target (`target+3` … `target+1`, `target`) so the
   target lod is always most authoritative and Plan-A's proven
   coarser-keeps-drawing zoom-in behavior is preserved. The finer direction
   exists because zoom-OUT raises the target lod: without it, previously-ready
   finer tiles fell outside the consulted range and the clip blanked until the
   debounced coarser fetch landed — violating the locked never-blank rule
   (amended during Task B5 review; the original coarser-only pass was a
   breakdown-time gap, not part of the locked design).
7. **Error-tile retry (T6-M1):** `TileEngine.request()` re-fetches an `error`
   slot once `ERROR_RETRY_COOLDOWN_MS = 5000` has elapsed since the failure;
   `ensureWaveformWindow` and the filmstrip request pass both call `request()`
   on error entries. Bounded: at most one retry per tile per cooldown window.
8. **The spacing formula is a 1-line Rust↔TS twin**
   (`FILMSTRIP_BASE_SPACING_US << lod`). Guarded by mirrored pinned-value tests
   (both sides assert lod 0 → 250_000, lod 12 → 1_024_000_000) + cross-pointer
   comments naming the twin file. No golden fixture — one shift does not merit
   the harness.

## Global Constraints

- **Data side is fixed:** native ffmpeg generation, blake3 content-hash disk
  caches under `CacheLayout`, `TileEngine` orchestration, string-command IPC
  via `napi_backend.rs`. NOT adopted from clipcombo: IndexedDB, browser-side
  decode, I-frame anchoring.
- **Display strategies (locked):** never blank already-rendered content
  (repaint synchronously from ready cache, fetch misses on a 140 ms debounce);
  canonical decode height 256 px (lane height/zoom never enters a cache key);
  true source-time positioning at natural aspect; grid keys
  `spacingUs(lod) = 250_000 << lod`, `lod ∈ [0, 12]`.
- **Proxy-wait rule (locked):** `Proxied` + no proxy on disk → `not_ready`
  sentinel; do NOT fall back to the original.
- Progressive enhancement: a missing/not_ready/error filmstrip must NEVER
  throw into render — degrade to the existing sprocket placeholder.
- camelCase over IPC (`serde rename_all = "camelCase"` on args/response); TS
  args camelCase.
- Comment style evergreen (`docs/comment-style.md`): no dates, commit hashes,
  or changelogs in source. Evergreen-docs convention for `docs/*.md`.
- Stage commits by EXPLICIT path only (never `git add -A`); re-check
  `git status` before each commit; do NOT push (user merges locally).
- Working branch: cut `feat/timeline-filmstrip-engine` from `main`.
- Implementer fences: no codex delegation, no formatters/format-on-save
  sweeps; touch only the files the task names.

**Gates for every task** (run from the repo root unless noted):
- Rust: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud`
  (a BARE `cargo test` does NOT compile the napi crate — always the full
  feature set).
- TS: `cd apps/desktop && npm run typecheck` and `npx vitest run` (single
  file first, full suite at task end).
- napi addon rebuild before anything runs the real app: CLOSE the dev app
  first, then `cd apps/desktop && npm run napi:build` — a running app locks
  the `.node` and the copy step fails; NEVER pipe the build (`| tail` masks
  the exit code).

---

### Task B1: Rust filmstrip tile extraction (`jobs/filmstrip.rs` + cache layout)

**Files:**
- Create: `apps/desktop/native/src/jobs/filmstrip.rs`
- Modify: `apps/desktop/native/src/jobs/mod.rs` (module decl only)
- Modify: `apps/desktop/native/src/cache/mod.rs` (filmstrip paths + ensure_dirs + tests)
- Test: in-file `mod tests` of `filmstrip.rs`, plus `cache/mod.rs` layout test

**Interfaces:**
- Consumes: `CacheLayout`, `cached_ok`, `temp_path`, `promote_temp`,
  `discard_temp`, `crate::process::NoConsoleWindow`, `ffmpeg_sidecar` paths.
- Produces (B2 relies on these exact names):
  - `pub const FILMSTRIP_BASE_SPACING_US: i64 = 250_000;`
  - `pub const FILMSTRIP_MAX_LOD: u32 = 12;`
  - `pub const FILMSTRIP_TILE_HEIGHT: u32 = 256;`
  - `pub fn spacing_us(lod: u32) -> i64`
  - `pub async fn extract_tile(cache: &CacheLayout, src: &Path, hash: &str, duration_us: Option<i64>, lod: u32, index: u32) -> anyhow::Result<PathBuf>`
  - `CacheLayout::filmstrip_root(&self) -> PathBuf`,
    `CacheLayout::filmstrip_tile(&self, hash: &str, lod: u32, index: u32) -> PathBuf`
    (layout `<root>/filmstrip/{hash}/{lod}/{index:06}.jpg`)

- [ ] **Step 1: Write the failing tests.** In `cache/mod.rs`'s existing
  `layout_paths_are_content_addressable` test add:

```rust
assert_eq!(
    layout.filmstrip_tile("abc", 3, 7),
    tmp.path().join("filmstrip").join("abc").join("3").join("000007.jpg"),
);
```

  and in `ensure_dirs_is_idempotent` add `assert!(layout.filmstrip_root().is_dir());`.
  Create `jobs/filmstrip.rs` with a `mod tests` holding:

```rust
#[test]
fn spacing_grid_is_pinned() {
    // Twin: renderer/timeline/tileEngine/FilmstripTileProducer.ts `spacingUs`.
    // Both sides pin the same endpoints so drift fails a test, not a user.
    assert_eq!(spacing_us(0), 250_000);
    assert_eq!(spacing_us(1), 500_000);
    assert_eq!(spacing_us(12), 1_024_000_000);
}

#[tokio::test]
async fn extract_then_cache_hit() {
    // Same shape as jobs/frame.rs::extract_then_cache_hit: lavfi testsrc 2s
    // fixture, extract lod=2 index=1 (t = 1_000_000 us), assert cached_ok,
    // re-extract, assert same path + unchanged file length.
}

#[tokio::test]
async fn tail_index_clamps_into_source() {
    // 2s fixture; lod such that index*spacing lands past EOF:
    // spacing_us(3) = 2_000_000, index 1 -> t = 2_000_000 >= duration.
    // With duration_us = Some(2_000_000) the extract must still produce a
    // non-empty JPG (clamped to duration - 100ms), not an ffmpeg error.
}

#[test]
fn rejects_lod_out_of_range() {
    // extract_tile is async; validate via a small pure helper or block_on —
    // simplest: make the lod check a pure `fn validate_lod(lod: u32) -> anyhow::Result<()>`
    // and assert validate_lod(13).is_err() && validate_lod(12).is_ok().
}
```

  Fixture helper: copy `make_test_video` verbatim from `jobs/frame.rs` tests
  (lavfi `testsrc=duration=2:size=640x360:rate=30`, libx264 ultrafast), and the
  `ffmpeg_available()` skip guard.

- [ ] **Step 2: Run to verify RED.**
  `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud filmstrip`
  Expected: compile failure (module/functions don't exist yet) — the expected
  RED for a new module.

- [ ] **Step 3: Implement.**
  `cache/mod.rs` (place next to `frames_root`/`frame`):

```rust
/// On-demand filmstrip tiles for the timeline, lazy-cached per source hash.
/// Keys mirror the renderer's time grid: `{lod}/{index:06}.jpg` where the
/// tile samples source time `index * (250ms << lod)`. Growth is bounded by
/// the disk-cache LRU (follow-up plan); tiles are ~15-25 KB JPGs.
pub fn filmstrip_root(&self) -> PathBuf {
    self.current_root().join("filmstrip")
}

pub fn filmstrip_tile(&self, hash: &str, lod: u32, index: u32) -> PathBuf {
    self.filmstrip_root().join(hash).join(lod.to_string()).join(format!("{index:06}.jpg"))
}
```

  Add `self.filmstrip_root()` to the `ensure_dirs` list.

  `jobs/mod.rs`: add `pub mod filmstrip;` beside the other module decls
  (no event/enqueue plumbing — extraction is on-demand, not a background job).

  `jobs/filmstrip.rs`:

```rust
//! On-demand filmstrip tile extraction for the timeline clip preview.
//!
//! Unlike the import-time thumbnail job (10 posters per media), tiles are
//! extracted lazily per (lod, index) time-grid key as the timeline scrolls
//! and zooms, and cached at `<cache>/filmstrip/<hash>/<lod>/<index:06>.jpg`.
//! Repeat hits skip ffmpeg entirely. Deliberately NOT behind `ffmpeg_sem()`:
//! interactive tile extracts must not queue behind proxy transcodes (same
//! stance as `jobs/frame.rs`); the renderer caps its own in-flight fetches.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
use crate::process::NoConsoleWindow;

/// Time-grid base spacing. Twin: renderer FilmstripTileProducer.ts
/// `FILMSTRIP_BASE_SPACING_US` / `spacingUs` — both sides pin the same
/// endpoints in tests.
pub const FILMSTRIP_BASE_SPACING_US: i64 = 250_000;
pub const FILMSTRIP_MAX_LOD: u32 = 12;
/// Canonical decode height: lane height / zoom never changes a cache key.
pub const FILMSTRIP_TILE_HEIGHT: u32 = 256;
/// `-ss` at/past the final frame emits zero frames; clamp tail requests this
/// far inside the source instead of erroring.
const TAIL_SLACK_US: i64 = 100_000;

pub fn spacing_us(lod: u32) -> i64 {
    FILMSTRIP_BASE_SPACING_US << lod
}

pub fn validate_lod(lod: u32) -> Result<()> {
    anyhow::ensure!(lod <= FILMSTRIP_MAX_LOD, "lod {lod} out of range 0..={FILMSTRIP_MAX_LOD}");
    Ok(())
}

/// Extract the tile at grid key `(lod, index)` from `src` and return the
/// cached JPG path. `src` is the already-resolved decode source (original or
/// proxy — the command layer applies the proxy-wait rule before calling).
pub async fn extract_tile(
    cache: &CacheLayout,
    src: &Path,
    hash: &str,
    duration_us: Option<i64>,
    lod: u32,
    index: u32,
) -> Result<PathBuf> {
    validate_lod(lod)?;
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot extract filmstrip tile");
    }

    let dest = cache.filmstrip_tile(hash, lod, index);
    if cached_ok(&dest) {
        return Ok(dest);
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create filmstrip cache dir {}", parent.display()))?;
    }

    let mut t_us = spacing_us(lod).saturating_mul(index as i64);
    if let Some(d) = duration_us {
        t_us = t_us.min((d - TAIL_SLACK_US).max(0));
    }
    let t_seconds = (t_us as f64) / 1_000_000.0;

    let tmp = temp_path(&dest);
    let _ = tokio::fs::remove_file(&tmp).await;

    // -ss BEFORE -i = fast keyframe seek (keyframe-bounded accuracy is fine
    // for thumbnail-grade tiles). scale=-2:256 keeps aspect at the canonical
    // height. -update 1 -f image2 forces a single-image output without a %d
    // pattern (same incantation as jobs/frame.rs).
    let output = Command::new(ffmpeg_path())
        .no_console_window()
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-ss", &format!("{t_seconds}"), "-i"])
        .arg(src)
        .args([
            "-frames:v", "1",
            "-vf", &format!("scale=-2:{FILMSTRIP_TILE_HEIGHT}"),
            "-q:v", "5",
            "-update", "1",
            "-f", "image2",
        ])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("spawn ffmpeg for filmstrip tile")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        discard_temp(&dest);
        anyhow::bail!("ffmpeg exited with {} for filmstrip tile: {}", output.status, stderr.trim());
    }
    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!("ffmpeg returned success but tile is missing or zero bytes at {}", tmp.display());
    }
    promote_temp(&dest)?;
    Ok(dest)
}
```

- [ ] **Step 4: Run to verify GREEN.**
  `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud filmstrip`
  then the full-suite gate. Expected: all pass (ffmpeg smoke tests self-skip
  when ffmpeg is absent, mirroring frame.rs).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src/jobs/filmstrip.rs apps/desktop/native/src/jobs/mod.rs apps/desktop/native/src/cache/mod.rs
git commit -m "feat(filmstrip): on-demand tile extraction on the 250ms<<lod time grid"
```

---

### Task B2: `get_filmstrip_tile` through the stateless-compute seam

**Files:**
- Modify: `apps/desktop/native/src/commands/media.rs` (args/response structs + command + tests)
- Modify: `apps/desktop/native/src/napi_backend.rs` (dispatch arm + mirror-free scan list)
- Modify: `apps/desktop/src/main/state/single-media-forward.ts` (channel entry)
- Modify: `apps/desktop/src/main/state/__tests__/single-media-forward.test.ts`
- Modify: `apps/desktop/src/renderer/ipc/index.ts` (TS wrapper + type)

**Interfaces:**
- Consumes: B1's `extract_tile`, `spacing_us`, `FILMSTRIP_TILE_HEIGHT`,
  `validate_lod`; `CacheLayout` via `backend.cache`; `DecodeRoute` +
  `MediaItem` from `crate::state`.
- Produces (B4 relies on these exact names):
  - Rust `pub async fn get_filmstrip_tile(backend: &Backend, args: FilmstripTileArgs) -> Result<FilmstripTile, String>`
    with `FilmstripTileArgs { item: MediaItem, lod: u32, index: u32 }` (camelCase)
    and `FilmstripTile { path: PathBuf, width_px: u32, height_px: u32 }` (camelCase → `widthPx`/`heightPx`);
  - `pub fn filmstrip_decode_source(item: &MediaItem) -> Result<PathBuf, String>` (unit-testable route resolution);
  - TS `getFilmstripTile(mediaId: string, lod: number, index: number): Promise<FilmstripTile>`
    with `interface FilmstripTile { path: string; widthPx: number; heightPx: number }`.

- [ ] **Step 1: Write the failing Rust tests** in `commands/media.rs`'s test
  module (pure — no Backend needed for the resolver):

```rust
#[test]
fn filmstrip_source_bypass_and_direct_export_use_original() {
    let mut item = /* build MediaItem like mirror_tests does, kind Video, path_abs "orig.mp4" */;
    item.decode_route = DecodeRoute::Bypass;
    assert_eq!(filmstrip_decode_source(&item).unwrap(), PathBuf::from("orig.mp4"));
    item.decode_route = DecodeRoute::DirectExport { quick_proxy: None };
    assert_eq!(filmstrip_decode_source(&item).unwrap(), PathBuf::from("orig.mp4"));
}

#[test]
fn filmstrip_source_proxied_waits_never_falls_back() {
    // Proxied with NO proxies -> "not_ready", NOT the original.
    // Proxied with quick_proxy pointing at a real temp file -> that file.
    // Proxied with only full_proxy on disk -> the full proxy.
    // Proxied with a quick_proxy path whose file is MISSING and no full ->
    // "not_ready" (stale route entry must not produce an ffmpeg error loop).
}

#[test]
fn filmstrip_rejects_non_video() {
    // kind Audio -> Err containing "filmstrip"
}
```

  Use `tempfile::TempDir` + `std::fs::write(path, b"x")` to make proxy files
  pass `cached_ok`. Build items with the same literal style as
  `jobs/thumbnails.rs` tests (all `MediaItem` fields spelled out).

- [ ] **Step 2: RED** — same cargo filter (`filmstrip_source`); compile
  failure on the missing fn is the expected RED.

- [ ] **Step 3: Implement in `commands/media.rs`:**

```rust
/// Timeline filmstrip tile. `path` is the cached JPG the renderer loads via
/// convertFileSrc; width/height are metadata-derived (informative — the
/// renderer sizes layout from the decoded ImageBitmap).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilmstripTile {
    pub path: PathBuf,
    pub width_px: u32,
    pub height_px: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilmstripTileArgs {
    pub item: MediaItem,
    pub lod: u32,
    pub index: u32,
}

/// The proxy-wait rule: Proxied media extract from a landed proxy and NEVER
/// fall back to the original (heavy originals are exactly why proxies exist);
/// direct routes extract from the original. Preference mirrors the renderer's
/// resolveDecode preview path (quick proxy first, then the full master).
pub fn filmstrip_decode_source(item: &MediaItem) -> Result<PathBuf, String> {
    if !matches!(item.kind, MediaKind::Video) {
        return Err("filmstrip tiles only valid for Video media".to_string());
    }
    match &item.decode_route {
        state::DecodeRoute::Bypass | state::DecodeRoute::DirectExport { .. } => Ok(item.path_abs.clone()),
        state::DecodeRoute::Proxied { quick_proxy, full_proxy, .. } => [quick_proxy, full_proxy]
            .into_iter()
            .flatten()
            .find(|p| crate::cache::cached_ok(p))
            .cloned()
            .ok_or_else(|| "not_ready".to_string()),
    }
}

pub async fn get_filmstrip_tile(backend: &Backend, args: FilmstripTileArgs) -> Result<FilmstripTile, String> {
    use crate::jobs::filmstrip;
    let src = filmstrip_decode_source(&args.item)?;
    filmstrip::validate_lod(args.lod).map_err(|e| format!("{e:#}"))?;
    let duration_us = args.item.metadata.duration_us;
    let hash = args.item.file_hash_blake3.clone();
    let path = filmstrip::extract_tile(&backend.cache, &src, &hash, duration_us, args.lod, args.index)
        .await
        .map_err(|e| format!("extract filmstrip tile: {e:#}"))?;
    let (width_px, height_px) = match args.item.metadata.video.as_ref() {
        Some(v) if v.height > 0 => {
            let w = (v.width as u64 * filmstrip::FILMSTRIP_TILE_HEIGHT as u64 / v.height as u64) as u32;
            (w & !1, filmstrip::FILMSTRIP_TILE_HEIGHT)
        }
        _ => (0, filmstrip::FILMSTRIP_TILE_HEIGHT),
    };
    Ok(FilmstripTile { path, width_px, height_px })
}
```

  `napi_backend.rs` dispatch arm (beside `get_waveform_tile`):

```rust
#[cfg(feature = "jobs")]
"get_filmstrip_tile" => {
    let a: crate::commands::media::FilmstripTileArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
    ser(crate::commands::media::get_filmstrip_tile(self, a).await)
}
```

  Add `"get_filmstrip_tile"` to the Phase-1 mirror-free scan list in
  `napi_backend.rs` (`for name in ["get_media_thumbnail", ...]`) — it is the
  same class of channel and must never grow a mirror read.

  `single-media-forward.ts`: add `'get_filmstrip_tile'` to
  `SINGLE_MEDIA_CHANNELS` (precedent: `get_waveform_tile` lives ONLY here, not
  in the router's `SLICE_INJECTED_READS` — the index.ts intercept runs before
  `routeChannel`).

  `single-media-forward.test.ts`: add a passthrough test mirroring the
  existing `get_waveform_tile` one:

```ts
it('passes through extra args for get_filmstrip_tile', () => {
  const pool = { m1: { id: 'm1' } as unknown as MediaItem }
  const out = resolveSingleMediaArgs({ mediaId: 'm1', lod: 4, index: 12 } as never, pool)
  expect(out.item).toBe(pool.m1)
  expect(out).toMatchObject({ lod: 4, index: 12 })
})
```

  `renderer/ipc/index.ts` (beside `getWaveformTile`):

```ts
export interface FilmstripTile {
  /// Absolute path of the cached tile JPG; load via convertFileSrc.
  path: string;
  /// Metadata-derived (informative); layout should trust the ImageBitmap.
  widthPx: number;
  heightPx: number;
}

/// Extract-on-demand filmstrip tile at time-grid key (lod, index). Rejects
/// "not_ready" while a Proxied source has no landed proxy (proxy-wait rule).
export async function getFilmstripTile(
  mediaId: string,
  lod: number,
  index: number,
): Promise<FilmstripTile> {
  return invoke<FilmstripTile>("get_filmstrip_tile", { mediaId, lod, index });
}
```

- [ ] **Step 4: GREEN + gates.** Full cargo gate; `npm run typecheck`;
  `npx vitest run src/main/state/__tests__/single-media-forward.test.ts`
  then the full vitest suite.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/src/commands/media.rs apps/desktop/native/src/napi_backend.rs apps/desktop/src/main/state/single-media-forward.ts apps/desktop/src/main/state/__tests__/single-media-forward.test.ts apps/desktop/src/renderer/ipc/index.ts
git commit -m "feat(filmstrip): get_filmstrip_tile command with the proxy-wait rule"
```

---

### Task B3: TileEngine `invalidateOn` + error-tile retry + subscribe-path coverage

**Files:**
- Modify: `apps/desktop/src/renderer/timeline/tileEngine/TileEngine.ts`
- Modify: `apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.ts` (request on error entries)
- Test: `apps/desktop/src/renderer/timeline/tileEngine/TileEngine.test.ts`
- Test: `apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx` (engine-subscribe-path test — the Plan-A intake item)

**Interfaces:**
- Produces (B4/B5 rely on):
  - `TileProducer` gains `invalidateOn?: string[]` — extra `media:job_complete`
    kinds that invalidate this producer's tiles;
  - `export const ERROR_RETRY_COOLDOWN_MS = 5000;` — `request()` re-fetches an
    `error` slot after this long.
- Waveform behavior is otherwise UNCHANGED (`data-state` semantics,
  coalescing, LRU-touch-ready-only all keep their current tests green).

- [ ] **Step 1: Write the failing engine tests** in `TileEngine.test.ts`
  (follow the file's existing fake-producer style):

```ts
it("invalidateOn kinds route job-complete events to the producer", () => {
  // register producer A {kind: "filmstrip", invalidateOn: ["proxy", "quick_proxy"]}
  // and producer B {kind: "waveform"} on a fresh engine; put one ready tile
  // of each into the engine; simulate the listener body by calling the same
  // path the event handler runs (expose via a small internal method
  // `handleJobComplete(mediaId, kind)` so tests don't need the bridge):
  //   engine.handleJobComplete("m1", "proxy")
  // assert: filmstrip tile slot gone + A.invalidate called; waveform tile
  // untouched. Then handleJobComplete("m1", "waveform") only clears B's.
});

it("re-requests an error slot only after the cooldown", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  // producer.fetch rejects once -> slot state "error"
  // request() again immediately -> fetch NOT called again (coalesced)
  vi.setSystemTime(ERROR_RETRY_COOLDOWN_MS);
  // request() -> fetch called again; a success replaces the slot with ready
});
```

  And the **engine-subscribe-path test** (A5-M2 — the invalidation→refetch
  linchpin that had zero coverage) in `TimelineWaveform.test.tsx`, using that
  file's existing mocked-ipc render harness and the SINGLETON `tileEngine`
  the hook subscribes to:

```ts
it("invalidateMedia notifies the subscribed hook and triggers an immediate refetch", async () => {
  // 1. render TimelineWaveform to data-state "ready" (existing harness)
  // 2. levels/tile mocks keep resolving; record call counts
  // 3. act(() => tileEngine.invalidateMedia(mediaId, "waveform"))
  // 4. assert getWaveformLevels was called again WITHOUT advancing the
  //    debounce timer (subscribe notifications bypass the 120ms debounce)
  // 5. assert data-state stayed "ready" throughout (stale window kept)
});
```

- [ ] **Step 2: RED** — `cd apps/desktop && npx vitest run src/renderer/timeline/tileEngine/TileEngine.test.ts src/renderer/timeline/TimelineWaveform.test.tsx`

- [ ] **Step 3: Implement.** In `TileEngine.ts`:

```ts
export interface TileProducer<T> {
  /// Matches `media:job_complete.kind` and `TileKey.kind`.
  kind: string;
  /// Extra `media:job_complete` kinds that also invalidate this producer's
  /// tiles — for producers whose pixels derive from another job's output
  /// (filmstrip tiles decode from the proxy the "proxy"/"quick_proxy" jobs
  /// produce). The waveform producer needs no entry: its own kind matches.
  invalidateOn?: string[];
  ...
}

/// A failed fetch parks the slot as `error`; `request()` retries it once this
/// cooldown has elapsed, so a transient failure (file mid-promote, ffmpeg
/// hiccup) heals without an invalidation, but a persistent one can't hot-loop.
export const ERROR_RETRY_COOLDOWN_MS = 5000;
```

  `Slot` gains `erroredAtMs?: number`. In `request()` replace the coalesce
  condition: `error` slots fall through (and get re-fetched) when
  `Date.now() - (existing.erroredAtMs ?? 0) >= ERROR_RETRY_COOLDOWN_MS`;
  pending/ready still always coalesce. In the `.catch` handler stamp
  `slot.erroredAtMs = Date.now()` alongside the error entry.

  Extract the job-listener body into an internal-but-testable method:

```ts
/** Route one media:job_complete to every producer it invalidates. Exposed for
 *  tests — the bridge listener is inert under vitest. */
handleJobComplete(mediaId: string, kind: string): void {
  for (const producer of this.producers.values()) {
    if (producer.kind === kind || producer.invalidateOn?.includes(kind)) {
      this.invalidateMedia(mediaId, producer.kind);
    }
  }
}
```

  and have `installJobListenerOnce` call `this.handleJobComplete(mediaId, kind)`
  (dropping the old `producers.has(kind)` guard — `handleJobComplete` is a
  no-op for unknown kinds).

  In `WaveformTileProducer.ts`'s `ensureWaveformWindow` tile loop, also
  re-request errored tiles (the engine's cooldown makes this safe):

```ts
if (entry.state === "error") { engine.request(key); anyMissing = true; tiles.push(null); continue; }
```

- [ ] **Step 4: GREEN + gates.** Target files, then full
  `npx vitest run` + `npm run typecheck`. The existing TileEngine regression
  suite (LRU-touch-ready-only, stale-drop, budget eviction) must stay green
  untouched.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/timeline/tileEngine/TileEngine.ts apps/desktop/src/renderer/timeline/tileEngine/TileEngine.test.ts apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.ts apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx
git commit -m "feat(timeline): TileEngine invalidateOn + error-tile retry cooldown"
```

---

### Task B4: FilmstripTileProducer (grid math + fetch pipeline + concurrency cap)

**Files:**
- Create: `apps/desktop/src/renderer/timeline/tileEngine/FilmstripTileProducer.ts`
- Test: `apps/desktop/src/renderer/timeline/tileEngine/FilmstripTileProducer.test.ts`

**Interfaces:**
- Consumes: B2's `getFilmstripTile` (`../../ipc`), `convertFileSrc`
  (`@/bridge/ipc`), B3's `invalidateOn`; `TileEngine`/`TileKey`.
- Produces (B5 relies on these exact names):
  - `export const FILMSTRIP_KIND = "filmstrip";`
  - `export const FILMSTRIP_TILE_HEIGHT_PX = 256;`
  - `export const FILMSTRIP_BASE_SPACING_US = 250_000;`
  - `export const FILMSTRIP_MAX_LOD = 12;`
  - `export const FILMSTRIP_MAX_CONCURRENT_FETCHES = 4;`
  - `export const FILMSTRIP_INVALIDATE_ON = ["proxy", "quick_proxy"];`
  - `export function spacingUs(lod: number): number`
  - `export function chooseFilmstripLod(thumbWidthPx: number, pxPerSec: number): number`
  - `export function filmstripThumbWidthPx(laneHeightPx: number, mediaWidth: number | null | undefined, mediaHeight: number | null | undefined): number`
  - `export function visibleTileRange(srcInUs: number, srcOutUs: number, spacing: number, thumbWidthUs: number, durationUs: number | null | undefined): { first: number; last: number }`
  - `export interface FilmstripTileValue { bitmap: ImageBitmap; tUs: number }`
  - `export function filmstripTileKey(mediaId: string, lod: number, index: number): TileKey`
  - `export function registerFilmstripProducer(engine?: TileEngine): void`

- [ ] **Step 1: Write the failing tests** (mock `../../ipc` and `@/bridge/ipc`
  exactly like `WaveformTileProducer.test.ts` mocks its ipc; additionally stub
  `global.fetch` to return `{ blob: async () => new Blob() }` and
  `global.createImageBitmap` to return a fake `{ width, height, close: vi.fn() }`):

```ts
it("pins the spacing grid (twin: native jobs/filmstrip.rs spacing_us)", () => {
  expect(spacingUs(0)).toBe(250_000);
  expect(spacingUs(1)).toBe(500_000);
  expect(spacingUs(12)).toBe(1_024_000_000);
});

it("chooses the lod whose spacing best matches one thumb width of screen time", () => {
  // thumbWidth 100px at 100 px/s -> desired 1_000_000us -> log2(4) = 2
  expect(chooseFilmstripLod(100, 100)).toBe(2);
  // extreme zoom-in clamps to 0; extreme zoom-out clamps to 12
  expect(chooseFilmstripLod(100, 1_000_000)).toBe(0);
  expect(chooseFilmstripLod(100, 0.000001)).toBe(12);
});

it("computes thumb width from natural aspect with a 16/9 fallback", () => {
  expect(filmstripThumbWidthPx(54, 1920, 1080)).toBe(96);
  expect(filmstripThumbWidthPx(54, null, null)).toBe(96); // 54 * 16/9 = 96
  expect(filmstripThumbWidthPx(54, 1080, 1920)).toBeCloseTo(30.375);
});

it("visibleTileRange covers exactly the tiles whose [t, t+thumbWidthUs) intersects the src window", () => {
  // spacing 1_000_000, thumbWidth 400_000us, window [1_200_000, 3_000_000):
  // tile 1 covers [1.0s,1.4s) -> intersects; tile 3 starts at 3.0s -> excluded
  expect(visibleTileRange(1_200_000, 3_000_000, 1_000_000, 400_000, null))
    .toEqual({ first: 1, last: 2 });
  // duration cap: 2.5s source cuts the last index to 2
  expect(visibleTileRange(0, 10_000_000, 1_000_000, 400_000, 2_500_000))
    .toEqual({ first: 0, last: 2 });
  // exact-boundary: window starting exactly at a tile's right edge excludes it
  expect(visibleTileRange(1_400_000, 3_000_000, 1_000_000, 400_000, null).first).toBe(2);
});

it("caps in-flight fetches at FILMSTRIP_MAX_CONCURRENT_FETCHES", async () => {
  // getFilmstripTile mock returns manually-resolvable deferreds; request 6
  // distinct keys on a fresh engine; assert only 4 ipc calls landed; resolve
  // one (and its fetch/createImageBitmap chain); await microtasks; assert a
  // 5th call landed.
});

it("fetch resolves path -> convertFileSrc -> ImageBitmap and reports bytes/dispose", async () => {
  // drive one key to ready; assert convertFileSrc received the ipc path,
  // value.tUs === index * spacingUs(lod), bytes === w*h*4, and
  // engine.invalidateMedia(mediaId, FILMSTRIP_KIND) calls bitmap.close().
});
```

- [ ] **Step 2: RED** — `npx vitest run src/renderer/timeline/tileEngine/FilmstripTileProducer.test.ts`

- [ ] **Step 3: Implement:**

```ts
import { getFilmstripTile } from "../../ipc";
import { convertFileSrc } from "@/bridge/ipc";
import { tileEngine, type TileEngine, type TileKey } from "./TileEngine";

export const FILMSTRIP_KIND = "filmstrip";
/// Canonical decode height — lane height / zoom never changes a cache key.
export const FILMSTRIP_TILE_HEIGHT_PX = 256;
/// Time-grid base spacing. Twin: native jobs/filmstrip.rs
/// FILMSTRIP_BASE_SPACING_US / spacing_us — both sides pin the same endpoints.
export const FILMSTRIP_BASE_SPACING_US = 250_000;
export const FILMSTRIP_MAX_LOD = 12;
/// Every miss spawns one ffmpeg on the native side — do not stampede.
export const FILMSTRIP_MAX_CONCURRENT_FETCHES = 4;
/// Proxy completion flips a Proxied source's not_ready tiles (proxy-wait rule).
export const FILMSTRIP_INVALIDATE_ON = ["proxy", "quick_proxy"];

export function spacingUs(lod: number): number {
  return FILMSTRIP_BASE_SPACING_US * 2 ** lod;
}

export function chooseFilmstripLod(thumbWidthPx: number, pxPerSec: number): number {
  if (thumbWidthPx <= 0 || pxPerSec <= 0) return FILMSTRIP_MAX_LOD;
  const desiredUs = (thumbWidthPx / pxPerSec) * 1e6;
  const lod = Math.round(Math.log2(desiredUs / FILMSTRIP_BASE_SPACING_US));
  return Math.max(0, Math.min(FILMSTRIP_MAX_LOD, lod));
}

export function filmstripThumbWidthPx(
  laneHeightPx: number,
  mediaWidth: number | null | undefined,
  mediaHeight: number | null | undefined,
): number {
  const aspect = mediaWidth && mediaHeight && mediaHeight > 0 ? mediaWidth / mediaHeight : 16 / 9;
  return laneHeightPx * aspect;
}

/// Indices whose tile box [t, t + thumbWidthUs) intersects [srcInUs, srcOutUs),
/// clamped to >= 0 and (when known) inside the source duration. Returns
/// first > last for an empty range.
export function visibleTileRange(
  srcInUs: number,
  srcOutUs: number,
  spacing: number,
  thumbWidthUs: number,
  durationUs: number | null | undefined,
): { first: number; last: number } {
  const lo = Math.min(srcInUs, srcOutUs);
  const hi = Math.max(srcInUs, srcOutUs);
  let first = Math.max(0, Math.floor((lo - thumbWidthUs) / spacing) + 1);
  let last = Math.ceil(hi / spacing) - 1;
  if (durationUs != null && durationUs > 0) {
    last = Math.min(last, Math.floor((durationUs - 1) / spacing));
  }
  return { first, last };
}

export interface FilmstripTileValue {
  bitmap: ImageBitmap;
  tUs: number;
}

export function filmstripTileKey(mediaId: string, lod: number, index: number): TileKey {
  return { mediaId, kind: FILMSTRIP_KIND, lod, index };
}

// Producer-side fetch gate: TileEngine issues fetches eagerly; this queue
// keeps at most FILMSTRIP_MAX_CONCURRENT_FETCHES ffmpeg extracts in flight.
let inFlight = 0;
const waiters: Array<() => void> = [];
async function acquireFetchSlot(): Promise<void> {
  if (inFlight < FILMSTRIP_MAX_CONCURRENT_FETCHES) { inFlight++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}
function releaseFetchSlot(): void {
  inFlight--;
  waiters.shift()?.();
}

let registered = false;
export function registerFilmstripProducer(engine: TileEngine = tileEngine): void {
  if (registered) return;
  registered = true;
  engine.register<FilmstripTileValue>({
    kind: FILMSTRIP_KIND,
    invalidateOn: FILMSTRIP_INVALIDATE_ON,
    fetch: async (key: TileKey) => {
      await acquireFetchSlot();
      try {
        const tile = await getFilmstripTile(key.mediaId, key.lod, key.index);
        const res = await fetch(convertFileSrc(tile.path));
        const bitmap = await createImageBitmap(await res.blob());
        return { bitmap, tUs: key.index * spacingUs(key.lod) };
      } finally {
        releaseFetchSlot();
      }
    },
    bytes: (v) => v.bitmap.width * v.bitmap.height * 4,
    dispose: (v) => v.bitmap.close(),
  });
}
```

- [ ] **Step 4: GREEN + gates** (file, then full vitest + typecheck).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/timeline/tileEngine/FilmstripTileProducer.ts apps/desktop/src/renderer/timeline/tileEngine/FilmstripTileProducer.test.ts
git commit -m "feat(timeline): filmstrip tile producer on the shared TileEngine"
```

---

### Task B5: TimelineFilmstrip rewrite — temporal canvas render, SWR debounce, DPR

**Files:**
- Rewrite: `apps/desktop/src/renderer/timeline/TimelineFilmstrip.tsx`
- Create: `apps/desktop/src/renderer/timeline/hooks/useDprVersion.ts` (extracted from TimelineWaveform)
- Modify: `apps/desktop/src/renderer/timeline/TimelineWaveform.tsx` (import the extracted hook; no behavior change)
- Modify: `apps/desktop/src/renderer/timeline/TimelineVisualPreview.tsx` (new props)
- Rewrite test: `apps/desktop/src/renderer/timeline/TimelineFilmstrip.test.ts` → `.test.tsx`
- Test: `apps/desktop/src/renderer/timeline/hooks/useDprVersion.test.ts`

**Interfaces:**
- Consumes: everything B4 exports; `tileEngine` singleton; B3's engine
  semantics (request-on-error is engine-internal).
- Produces:
  - `TimelineFilmstrip` new props:
    `{ mediaId, srcInUs, srcOutUs, layerWidthPx, layerHeightPx, pxPerSec, colorHint, enabled, mediaWidth?, mediaHeight?, mediaDurationUs? }`
  - `export const FILMSTRIP_FETCH_DEBOUNCE_MS = 140;`
  - exported pure helper (unit-testable without canvas):
    `export function tileDrawRect(tUs: number, srcInUs: number, srcOutUs: number, clipWidthPx: number, laneHeightPx: number, bmpWidth: number, bmpHeight: number): { x: number; w: number; h: number }`
  - `useDprVersion(): number` moved to `hooks/useDprVersion.ts` verbatim (doc
    comment travels with it), re-imported by `TimelineWaveform.tsx`.

Behavior specification (all locked-design rules):
- **Render pass (synchronous, never blanks):** compute
  `targetLod = chooseFilmstripLod(filmstripThumbWidthPx(layerHeightPx, mediaWidth, mediaHeight), pxPerSec)`;
  painter's pass over lods `min(targetLod + 3, 12) … targetLod` (coarse →
  fine): for each lod, for each index in
  `visibleTileRange(srcInUs, srcOutUs, spacingUs(lod), thumbWidthUs, mediaDurationUs)`,
  `engine.get()` (never `request()` for non-target lods) and `drawImage` ready
  bitmaps at `tileDrawRect(...)`. Canvas segments of 2048 CSS px
  (`RENDER_TILE_PX` pattern from TimelineWaveform), DPR-scaled backing store,
  `content-visibility: auto` + `containIntrinsicSize`.
- **Request pass (debounced):** only the TARGET lod's visible range; for each
  key `const e = engine.get(key); if (!e || e.state === "error") engine.request(key)`.
  Param churn (zoom/trim/height) debounces `FILMSTRIP_FETCH_DEBOUNCE_MS = 140`;
  mount, `mediaId` change, and engine `subscribe` notifications run
  immediately (same run/apply seam shape as `useWindowData`, with a
  closure-local timer + cancelled flag per effect).
- **Repaint trigger:** a `version` state bumped by the engine `subscribe`
  callback and by each completed request pass; the draw effect depends on
  `[version, geometry deps, dprVersion]`.
- **data-state:** `disabled` when `!enabled`; else `ready` if the draw pass
  painted ≥ 1 bitmap; else `not_ready` if any consulted target-lod slot is
  `not_ready` (proxy-wait); else `pending`. The sprocket placeholder
  background (existing CSS `repeating-linear-gradient`, `layerWidthPx >= 32`
  gate) stays on the container and shows through wherever no tile has landed.
- `tileDrawRect`: `x = (tUs − srcInUs) / (srcOutUs − srcInUs) × clipWidthPx`,
  `h = laneHeightPx`, `w = laneHeightPx × (bmpWidth / bmpHeight)`; degenerate
  `srcOutUs <= srcInUs` or `bmpHeight <= 0` returns `{ x: 0, w: 0, h: 0 }`
  (callers skip zero-width draws).
- `TimelineVisualPreview` adds
  `const videoMedia = useMediaById(layer.params.kind === "VideoClip" ? layer.params.media_id : null);`
  and passes `layerHeightPx`, `pxPerSec`,
  `mediaWidth={videoMedia?.width ?? undefined}`,
  `mediaHeight={videoMedia?.height ?? undefined}`,
  `mediaDurationUs={videoMedia?.duration_us ?? undefined}` to
  `<TimelineFilmstrip>` (prop pattern precedent: `mediaChannels` on
  `TimelineWaveform`).

- [ ] **Step 1: Write the failing tests.**
  `TimelineFilmstrip.test.tsx` (mock `../ipc` incl. `getFilmstripTile`,
  `@/bridge/ipc`, `@/bridge/events`; stub `fetch`/`createImageBitmap` as in
  B4; jsdom canvas `getContext` returns null so draws no-op — assertions go
  through `data-state`, engine request spies, and the pure helper):

```ts
it("tileDrawRect positions a tile at its true source time at natural aspect", () => {
  // clip 500px wide over src [2s, 12s); tile at t=7s, bitmap 455x256, lane 54px:
  // x = (7-2)/10 * 500 = 250; h = 54; w = 54 * 455/256 ≈ 95.98
  const r = tileDrawRect(7_000_000, 2_000_000, 12_000_000, 500, 54, 455, 256);
  expect(r.x).toBeCloseTo(250);
  expect(r.h).toBe(54);
  expect(r.w).toBeCloseTo(54 * 455 / 256);
  expect(tileDrawRect(0, 5_000_000, 5_000_000, 500, 54, 455, 256)).toEqual({ x: 0, w: 0, h: 0 });
});

it("renders disabled without touching the engine", () => { /* enabled=false -> data-state 'disabled', no ipc calls */ });

it("requests only the target lod's visible tiles, immediately on mount", () => {
  // spy engine.request via vi.spyOn(tileEngine, "request"); mount with a
  // geometry whose targetLod/range is hand-computed; assert the exact key set.
});

it("debounces param-churn requests and keeps drawing (no placeholder flash)", async () => {
  vi.useFakeTimers();
  // mount -> immediate pass; change pxPerSec twice quickly -> no new request
  // until 140ms elapse, then exactly one pass; data-state never leaves "ready"
  // once a tile was painted (drive one key to ready first).
});

it("re-runs the pass immediately on an engine subscribe notification", () => {
  // act(() => tileEngine.invalidateMedia(mediaId, FILMSTRIP_KIND)) -> request
  // pass re-ran without timer advance (mirrors B3's waveform linchpin test).
});

it("reports not_ready while the proxy-wait rule holds", async () => {
  // getFilmstripTile mock rejects "not_ready" -> data-state "not_ready";
  // then invalidate (proxy landed) + mock resolves -> "ready".
});
```

  `useDprVersion.test.ts`: arm/re-arm behavior (existing contract from Plan A:
  DPR change bumps version, re-arms a query embedding the NEW dpr) + the
  A5-M3 unmount assertion: unmount removes the active listener
  (`removeEventListener` spy called with the armed handler).

- [ ] **Step 2: RED** — `npx vitest run src/renderer/timeline/TimelineFilmstrip.test.tsx src/renderer/timeline/hooks/useDprVersion.test.ts`

- [ ] **Step 3: Implement.** Move `useDprVersion` (verbatim, with its doc
  comment) from `TimelineWaveform.tsx` to `hooks/useDprVersion.ts`; update the
  waveform import. Rewrite `TimelineFilmstrip.tsx` per the behavior spec:
  `registerFilmstripProducer()` at module level (mirrors
  `registerWaveformProducer()`); container div keeps
  `data-testid="timeline-filmstrip"` and the sprocket placeholder CSS; canvas
  segments mirror `WaveformTileCanvas`'s width/height/DPR/`contentVisibility`
  handling but draw bitmaps:

```ts
for (let lod = Math.min(targetLod + 3, FILMSTRIP_MAX_LOD); lod >= targetLod; lod--) {
  const spacing = spacingUs(lod);
  const { first, last } = visibleTileRange(srcInUs, srcOutUs, spacing, thumbWidthUs, mediaDurationUs);
  for (let i = first; i <= last; i++) {
    const entry = engine.get<FilmstripTileValue>(filmstripTileKey(mediaId, lod, i));
    if (entry?.state !== "ready") continue;
    const { bitmap, tUs } = entry.value;
    const r = tileDrawRect(tUs, srcInUs, srcOutUs, totalWidthPx, laneHeightPx, bitmap.width, bitmap.height);
    if (r.w <= 0) continue;
    ctx.drawImage(bitmap, r.x - segmentStartPx, 0, r.w, r.h);
  }
}
```

  Update `TimelineVisualPreview.tsx` props as specified; its existing test
  file may need the new mock fields — extend, don't weaken, existing
  assertions.

- [ ] **Step 4: GREEN + gates** — target files, then FULL `npx vitest run`
  (the old `TimelineFilmstrip.test.ts` selectFilmstripFrames suite is deleted
  by the rewrite) + `npm run typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/timeline/TimelineFilmstrip.tsx apps/desktop/src/renderer/timeline/TimelineFilmstrip.test.tsx apps/desktop/src/renderer/timeline/hooks/useDprVersion.ts apps/desktop/src/renderer/timeline/hooks/useDprVersion.test.ts apps/desktop/src/renderer/timeline/TimelineWaveform.tsx apps/desktop/src/renderer/timeline/TimelineVisualPreview.tsx
git rm apps/desktop/src/renderer/timeline/TimelineFilmstrip.test.ts
git commit -m "feat(timeline): filmstrip rebuilt on the tile engine — temporal placement, SWR zoom"
```

---

### Task B6: Delete the legacy 10-poster manifest path

The 10-frame manifest has no consumer after B5. `jobs/thumbnails.rs`, the
thumbnails background JOB, and `get_media_thumbnail` (singular — the
media-pool poster's base64 `004.jpg`) all STAY.

**Files:**
- Modify: `apps/desktop/native/src/commands/media.rs` (delete `get_media_thumbnails`, `ThumbnailManifest`, `ThumbnailFrame`, `TIMELINE_THUMB_COUNT`, and their `mirror_tests` cases)
- Modify: `apps/desktop/native/src/napi_backend.rs` (delete the dispatch arm; remove `"get_media_thumbnails"` from the mirror-free scan list)
- Modify: `apps/desktop/src/main/state/single-media-forward.ts` (remove the channel)
- Modify: `apps/desktop/src/main/state/router.ts` (remove from `SLICE_INJECTED_READS`)
- Modify: `apps/desktop/src/main/state/router.test.ts` (remove from `ALL_CHANNELS`)
- Modify: `apps/desktop/src/main/state/__tests__/single-media-forward.test.ts` (retarget the "includes timeline thumbnail manifests" case at `get_filmstrip_tile`)
- Modify: `apps/desktop/src/renderer/ipc/index.ts` (delete `getMediaThumbnails` + `TimelineThumbnailManifest`)

- [ ] **Step 1: Confirm zero remaining consumers.**
  `grep -rn "getMediaThumbnails\|TimelineThumbnailManifest\|get_media_thumbnails\|ThumbnailManifest" apps/desktop/src apps/desktop/native/src`
  Expected: hits ONLY in the files listed above (plus this plan). Any other
  hit = stop and report; do not delete around an unknown consumer.

- [ ] **Step 2: Delete in one sweep** (all files above). Keep
  `get_media_thumbnail` singular everywhere — verify the scan list still
  contains it and `jobs/thumbnails.rs` still compiles untouched.

- [ ] **Step 3: Gates.** Full cargo gate + `npm run typecheck` +
  full `npx vitest run`. The router partition gate (`router.test.ts`) passing
  is the proof the channel books are balanced.

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/native/src/commands/media.rs apps/desktop/native/src/napi_backend.rs apps/desktop/src/main/state/single-media-forward.ts apps/desktop/src/main/state/router.ts apps/desktop/src/main/state/router.test.ts apps/desktop/src/main/state/__tests__/single-media-forward.test.ts apps/desktop/src/renderer/ipc/index.ts
git commit -m "refactor(timeline): retire the 10-poster thumbnail manifest path"
```

---

### Task B7: Evergreen doc writeback + real-app visual acceptance

**Files:**
- Modify: `docs/timeline-content-preview.md` (Video/filmstrip section + Implementation Notes)

- [ ] **Step 1: Rewrite the Video section** to describe the shipped reality:
  tile engine + time-grid keys, canonical 256 px decode height, temporal
  positioning at natural aspect, proxy-wait rule, coarse-fallback zoom
  behavior, 140 ms debounce, disk cache layout. Evergreen tone — no dates,
  phases, or commit hashes. While in the file, fix the Plan-A rollup cosmetic
  A6-M1 (the "28 px" spacing inconsistency vs the file's "1px/16px"
  convention).

- [ ] **Step 2: Rebuild + real-app visual acceptance** (the gate the waveform
  incident taught us to respect):
  1. CLOSE the dev app. `cd apps/desktop && npm run napi:build` — read the
     full output, never piped.
  2. Launch the dev app; import a video with distinct scene changes.
  3. Verify: trimmed short clip shows the correct frames at correct positions
     (trim the clip's head — the filmstrip must shift, not stretch); zoom-in
     densifies tiles without ever blanking (coarser tiles keep drawing until
     finer land); a freshly-imported Proxied heavy source shows the sprocket
     placeholder until its proxy lands, then fills in without a reload;
     resize the track lane height — tiles rescale, no refetch storm
     (cache keys are height-independent).
  4. Screenshot via the CDP recipe (memory: reference_dev_app_cdp_driving) if
     the user is not available for hands-on confirmation.

- [ ] **Step 3: Commit.**

```bash
git add docs/timeline-content-preview.md
git commit -m "docs(timeline): refresh content-preview doc for the filmstrip tile engine"
```

---

## Out of scope (recorded, deliberate)

- Disk-cache LRU across `filmstrip/thumbnails/waveforms`, orphaned
  `.v2.peaks` sweep, `MAX_PX_PER_SEC` raise → **Plan C** (filmstrip tiles are
  the growth source that motivates it).
- Cross-lod disk dedupe (lod k index 2j and lod k+1 index j sample the same
  t_us — a t_us-keyed cache would share the file). Locked layout keeps
  `{lod}/{index:06}.jpg`; the overhead is bounded ≤ 2× and Plan C's LRU owns
  disk growth. Recorded as a Plan-C option, not a deviation.
- `-ss` start-PTS compensation for exotic containers whose content time 0 ≠
  container time 0 (parity with `jobs/frame.rs`, which also ignores it).
- Live-trim src window during drag; deferred Plan-A Minors not named here
  (A4-M1/M2/M3, A5-M1 for the waveform hook) stay deferred.

## Self-Review Notes

- **Spec coverage:** every locked Plan-B design bullet maps to a task:
  canonical height + grid + extraction → B1/B2; proxy-wait rule → B2;
  `invalidateOn` → B3; producer + concurrency cap → B4; temporal positioning
  + flicker-free + debounce + DPR → B5; manifest removal → B6; gates/visual
  acceptance + doc → B7. Plan-A intake: engine-subscribe-path test → B3;
  error-tile re-request (T6-M1) → B3; A5-M3 DPR unmount test + A6-M1 doc
  cosmetic → B5/B7. Both [verify] items resolved in Design resolutions §1–§2.
- **Type consistency:** `extract_tile`/`spacing_us`/`validate_lod` (B1) are
  what B2 calls; `getFilmstripTile`/`FilmstripTile{path,widthPx,heightPx}`
  (B2) is what B4's fetch consumes; `invalidateOn`/`ERROR_RETRY_COOLDOWN_MS`
  (B3) are what B4 registers / B5 relies on; every B4 export B5 consumes is
  named in B4's Produces block.
- **Placeholders:** test skeletons that describe assertions in comments
  (B1 roundtrip, B3 harness-embedded tests) name their exact oracle values
  and the existing test they mirror — the implementer copies a proven shape
  rather than inventing one.
