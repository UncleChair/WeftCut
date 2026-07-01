# Timeline Waveform Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed-resolution, single-canvas timeline waveform with an on-demand, multi-resolution (LOD-pyramid) tile engine so the waveform stays crisp and detailed at every zoom level, with the 4096px canvas cap and the 100-peaks/sec detail wall removed.

**Architecture:** A new multi-resolution peaks file (VPEAKS **v2**: min/max envelope, up to 2 channels, a power-of-two LOD pyramid) is generated in one Rust decode pass and mmap-sliced on demand. A **generic renderer-side `TileEngine`** (cache + request coalescing + byte-budget LRU + `media:job_complete` invalidation) orchestrates fetches; a **`WaveformTileProducer`** plugs into it to pick the right LOD for the current zoom and fetch just the visible peak range. `TimelineWaveform` renders the assembled min/max data into **fixed-width tile canvases** (bounded size, DPR-correct, offscreen tiles culled via `content-visibility`), drawing a true positive/negative envelope.

This is **Plan 1 of 3**. Plan 2 adds `FilmstripTileProducer` (video thumbnails) on this same engine; Plan 3 adds disk-cache LRU eviction and raises `MAX_PX_PER_SEC`. See "Follow-up plans" at the end.

**Tech Stack:** Rust (napi-rs backend, `jobs` feature, ffmpeg sidecar), TypeScript + React (renderer), Vitest, Canvas 2D.

## Global Constraints

- **Node toolchain is fixed:** v22.20.0 via fnm. Do NOT install/switch Node, and do NOT touch `electron-builder`. (See `~/.claude/CLAUDE.md`.)
- **Editing Rust source:** use the Edit/Write tools, never PowerShell `Set-Content` — it writes cp1252 and mangles the em-dashes in existing Rust comments. If you must use PowerShell, pass `-Encoding UTF8`.
- **Authoritative build/test commands (override any per-task command that disagrees).** npm cwd is `apps/desktop/`.
  - **Rust tests (napi crate):** `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud <filter>`. A **bare `cargo test` does NOT compile** this crate (a feature-gated napi callback needs the full feature set) — always pass `--features jobs,export,mcp,cloud`, even for the pure format unit tests, because they live in the same crate.
  - **TS single-file tests:** `cd apps/desktop && npx vitest run <path>` (the engine/producer/waveform tests here are not wasm-backed, so no `build:wasm` prereq).
  - **TS typecheck:** `cd apps/desktop && npm run typecheck` (= `tsc -b`).
  - **Native addon rebuild after any Rust change:** `cd apps/desktop && npm run napi:build` (NOT `npm run build`, which is electron-vite).
- **Staging discipline (parallel sessions edit this checkout):** stage by **explicit path only** — never `git add -A`/`git add .`. Re-check `git status` before every commit. Leave `.gitignore` and `skills-lock.json` (another session's WIP) untouched. Do not push; the user merges locally.
- **MCP contract is frozen:** `crate::jobs::read_peaks_file(path) -> Result<Vec<f32>>` must keep returning **max-abs f32 peaks at 100/sec** (`PEAKS_PER_SECOND = 100`). `mcp/tools.rs` (detect_silences) and any `media://{id}/waveform` consumer call it and MUST NOT need edits. Preserve the signature and semantics; only the internal file it reads changes.
- **Comment style is evergreen** (`docs/comment-style.md`): no dates, no commit hashes, no "changed from…" changelogs in source. Explain why, not history.
- **After Rust changes, rebuild the native addon:** `npm run napi:build` in `apps/desktop` before running any TS test that dispatches to Rust. Format-only Rust unit tests run via `cargo test` without a rebuild.
- **camelCase over the IPC boundary:** Rust serde structs crossing to TS use `#[serde(rename_all = "camelCase")]`; TS args objects use camelCase keys. The TS state actor resolves `{ mediaId }` → `{ item }` via `single-media-forward.ts`.
- **Progressive enhancement:** a missing/`not_ready` waveform must never throw into the render path — it degrades to a center-line placeholder, exactly as today.

---

## File Structure

**Rust (backend):**
- `apps/desktop/native/src/jobs/waveform.rs` — MODIFY. VPEAKS v2 format constants, stereo decode, mipmap pyramid builder, v2 writer, level/range readers, and a v2-backed `read_peaks_file` compat shim. This file owns the entire peaks-on-disk format.
- `apps/desktop/native/src/cache/mod.rs` — MODIFY. Bump the waveform cache filename to `{hash}.v2.peaks` so old v1 files are ignored and regenerated (mirrors the existing `quick-q4` versioned-filename precedent).
- `apps/desktop/native/src/commands/media.rs` — MODIFY. Add `get_waveform_levels` (header table) and `get_waveform_tile` (range read) commands + their arg structs. Keep `get_waveform_peaks` (now reads v2 compat).
- `apps/desktop/native/src/napi_backend.rs` — MODIFY. Register the two new dispatch arms (`napi_backend.rs:416` match).

**TypeScript (main / bridge):**
- `apps/desktop/src/main/state/single-media-forward.ts` — MODIFY. Register the two new channels and pass through their extra (non-`mediaId`) args.
- `apps/desktop/src/renderer/ipc/index.ts` — MODIFY. Add `WaveformLevels` / `WaveformTile` types and `getWaveformLevels` / `getWaveformTile` calls.

**TypeScript (renderer / timeline):**
- `apps/desktop/src/renderer/timeline/tileEngine/TileEngine.ts` — CREATE. Generic tile orchestration: cache, coalescing, versioned stale-drop, byte-budget LRU with `dispose`, `media:job_complete` invalidation. Producer-agnostic — Plan 2's filmstrip reuses it unchanged.
- `apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.ts` — CREATE. LOD selection from `pxPerSec`, tile-range math, assembly of a window's min/max envelope from fetched tiles.
- `apps/desktop/src/renderer/timeline/TimelineWaveform.tsx` — REWRITE. Consume the engine + producer; render fixed-width DPR-correct tile canvases with a true min/max envelope; center-line placeholder while `pending`/`not_ready`.

**Tests (new/updated):**
- `apps/desktop/native/src/jobs/waveform.rs` `#[cfg(test)]` — v2 roundtrip, pyramid decimation, compat shim.
- `apps/desktop/src/renderer/timeline/tileEngine/TileEngine.test.ts` — CREATE.
- `apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.test.ts` — CREATE.
- `apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx` — MODIFY.

---

## Task 1: VPEAKS v2 format — writer + readers (pure, offline)

Define the on-disk multi-resolution format and its pure read/write helpers. No ffmpeg, no decode — just bytes in, structs out. This locks the format every other task depends on.

**Files:**
- Modify: `apps/desktop/native/src/jobs/waveform.rs` (constants + `PeakLevel`, `V2Header`, `write_v2`, `read_v2_header`, `read_v2_range`)
- Test: same file, `#[cfg(test)]` module

**Interfaces:**
- Produces:
  - `pub const VERSION: u32 = 2;` `pub const SAMPLE_RATE: u32 = 22_050;` `pub const BASE_PEAKS_PER_SECOND: u32 = 1000;` `pub const PEAKS_PER_SECOND: u32 = 100;` (compat const, unchanged value) `pub const MAX_CHANNELS: usize = 2;`
  - `pub struct PeakLevel { pub peaks_per_second: u32, pub peak_count: u32 }`
  - `pub struct V2Header { pub channels: u32, pub levels: Vec<PeakLevel> }` (level index 0 = finest)
  - `pub struct LevelData { pub channels: u32, pub peak_count: u32, /* per channel, per window */ pub mins: Vec<Vec<i16>>, pub maxs: Vec<Vec<i16>> }`
  - `fn quantize(sample: f32) -> i16` / `fn dequantize(v: i16) -> f32`
  - `async fn write_v2(path: &Path, channels: u32, levels: &[LevelData]) -> Result<()>`
  - `fn read_v2_header(path: &Path) -> Result<V2Header>`
  - `fn read_v2_range(path: &Path, level_idx: usize, channel: usize, start_peak: u32, count: u32) -> Result<(Vec<i16>, Vec<i16>)>` (returns `(mins, maxs)`)

**On-disk layout (little-endian):**
```text
magic:        [u8;8] = b"VPEAKS\0\0"
version:      u32 = 2
sample_rate:  u32 = 22050
channels:     u32               (1 or 2)
level_count:  u32
-- level table (level_count entries, index 0 = finest):
   peaks_per_second: u32
   peak_count:       u32        (windows per channel at this level)
   data_offset:      u64        (absolute byte offset of this level's data)
-- data section, per level (table order), CHANNEL-PLANAR:
   channel 0: [ min:i16, max:i16 ] * peak_count
   channel 1: [ min:i16, max:i16 ] * peak_count   (only if channels == 2)
```
Channel-planar means a single-channel range read is one contiguous `seek + read`.

- [ ] **Step 1: Write the failing format-roundtrip test**

Add to the `#[cfg(test)] mod tests` in `waveform.rs`:

```rust
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
        let level_data: Vec<LevelData> = levels.iter().map(|(_, d)| d.clone()).collect();

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            write_v2_with_pps(&path, 2, &levels).await
        }).unwrap();
        let _ = level_data; // silence unused if not needed

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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml v2_write_read_header_and_range`
Expected: FAIL — `write_v2_with_pps`, `read_v2_header`, `read_v2_range`, `LevelData`, `V2Header`, `PeakLevel`, `BASE_PEAKS_PER_SECOND` not found.

- [ ] **Step 3: Implement the format constants, structs, and read/write helpers**

Replace the old header constants at the top of `waveform.rs` (the `MAGIC`/`VERSION`/`SAMPLE_RATE`/`PEAKS_PER_SECOND`/`SAMPLES_PER_PEAK` block) with:

```rust
pub const MAGIC: &[u8; 8] = b"VPEAKS\0\0";
pub const VERSION: u32 = 2;
pub const SAMPLE_RATE: u32 = 22_050;
/// Finest stored LOD. Coarser levels halve this until ~1/sec.
pub const BASE_PEAKS_PER_SECOND: u32 = 1000;
/// Compat resolution the MCP consumers (detect_silences, media://…/waveform)
/// still ask for via `read_peaks_file`. Unchanged so those call sites don't move.
pub const PEAKS_PER_SECOND: u32 = 100;
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
    buf.extend_from_slice(&VERSION.to_le_bytes());
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
    if version != VERSION {
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
```

Ensure `use anyhow::{Context, Result, anyhow};` is present at the top (add `anyhow` to the existing `use anyhow::{Context, Result};`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml v2_write_read_header_and_range`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/jobs/waveform.rs
git commit -m "feat(waveform): VPEAKS v2 multi-resolution min/max format + readers"
```

---

## Task 2: Stereo decode + mipmap pyramid generation

Rewrite `waveform::run` to decode stereo PCM once, build the finest min/max level, decimate it into a power-of-two pyramid, and write the v2 file. Also bump the cache filename so old v1 files are ignored.

**Files:**
- Modify: `apps/desktop/native/src/cache/mod.rs:125` (the `waveform` path fn)
- Modify: `apps/desktop/native/src/jobs/waveform.rs` (`run`, new `compute_finest_level`, `decimate`, `build_pyramid`; delete the old `compute_peaks` / `write_peaks_file` bodies superseded by v2)
- Test: `waveform.rs` `#[cfg(test)]` (pyramid decimation unit test + real-ffmpeg smoke updated for v2)

**Interfaces:**
- Consumes: `write_v2_with_pps`, `LevelData`, `quantize`, `BASE_PEAKS_PER_SECOND`, `SAMPLE_RATE`, `MAX_CHANNELS` (Task 1).
- Produces:
  - `fn decimate(mins: &[i16], maxs: &[i16]) -> (Vec<i16>, Vec<i16>)` — halve resolution by pairwise min/max.
  - `fn build_pyramid(finest: LevelData) -> Vec<(u32, LevelData)>` — finest-first pyramid down to ~1/sec.
  - `run` now writes a v2 file at `cache.waveform(hash)` (filename `{hash}.v2.peaks`).

- [ ] **Step 1: Write the failing decimation test**

Add to `waveform.rs` tests:

```rust
    #[test]
    fn decimate_halves_and_preserves_envelope() {
        // 4 windows -> 2 windows. Each output min/max spans its two children.
        let mins = vec![-3, -1, -7, -2];
        let maxs = vec![2, 5, 1, 9];
        let (dmin, dmax) = decimate(&mins, &maxs);
        assert_eq!(dmin, vec![-3, -7]); // min(-3,-1)=-3 ; min(-7,-2)=-7
        assert_eq!(dmax, vec![5, 9]);   // max(2,5)=5 ; max(1,9)=9
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml -- decimate_halves build_pyramid_is`
Expected: FAIL — `decimate` / `build_pyramid` not found.

- [ ] **Step 3: Implement decode-to-pyramid and rewrite `run`**

In `cache/mod.rs`, change the `waveform` path fn so old caches are bypassed:

```rust
    /// Multi-resolution audio peaks file (VPEAKS v2). The `v2` segment is the
    /// format version — bumped when the on-disk layout changes so stale v1
    /// caches are regenerated, not misread (mirrors `quick_proxy`'s recipe tag).
    pub fn waveform(&self, hash: &str) -> PathBuf {
        self.waveforms_dir().join(format!("{hash}.v2.peaks"))
    }
```

In `waveform.rs`, replace `compute_peaks` and `write_peaks_file` with the pyramid pipeline, and rewrite `run`'s decode args to stereo and its write to v2:

```rust
/// Decode arg change: `-ac 2` (stereo, downmix >2ch) instead of `-ac 1`.
/// The rest of `run` up to reading stdout stays; swap the ffmpeg `-ac` value
/// to "2" and replace the peaks computation + write with the block below.
async fn compute_finest_level(
    stdout: &mut tokio::process::ChildStdout,
    channels: usize,
) -> Result<LevelData> {
    // Interleaved f32 frames: `channels` samples per frame. One peak window is
    // SAMPLE_RATE / BASE_PEAKS_PER_SECOND frames.
    let frames_per_peak = (SAMPLE_RATE / BASE_PEAKS_PER_SECOND) as usize;
    let mut mins: Vec<Vec<i16>> = vec![Vec::new(); channels];
    let mut maxs: Vec<Vec<i16>> = vec![Vec::new(); channels];
    let mut cur_min = vec![f32::MAX; channels];
    let mut cur_max = vec![f32::MIN; channels];
    let mut frames_in_window = 0usize;
    let mut ch = 0usize;

    let mut buf = vec![0u8; 64 * 1024];
    let mut leftover = [0u8; 4];
    let mut leftover_len = 0usize;

    let mut consume = |sample: f32,
                       ch: &mut usize,
                       frames_in_window: &mut usize,
                       cur_min: &mut [f32],
                       cur_max: &mut [f32],
                       mins: &mut [Vec<i16>],
                       maxs: &mut [Vec<i16>]| {
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
    };

    loop {
        let n = stdout.read(&mut buf).await.context("read ffmpeg stdout")?;
        if n == 0 {
            break;
        }
        let mut slice = &buf[..n];
        if leftover_len > 0 {
            let need = 4 - leftover_len;
            let take = need.min(slice.len());
            leftover[leftover_len..leftover_len + take].copy_from_slice(&slice[..take]);
            leftover_len += take;
            slice = &slice[take..];
            if leftover_len == 4 {
                let s = f32::from_le_bytes(leftover);
                consume(s, &mut ch, &mut frames_in_window, &mut cur_min, &mut cur_max, &mut mins, &mut maxs);
                leftover_len = 0;
            }
        }
        let aligned = slice.len() - (slice.len() % 4);
        for chunk in slice[..aligned].chunks_exact(4) {
            let s = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            consume(s, &mut ch, &mut frames_in_window, &mut cur_min, &mut cur_max, &mut mins, &mut maxs);
        }
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
```

Then in `run`, change the ffmpeg `-ac` value from `"1"` to `"2"`, and replace the peaks-compute-and-write block (the `let peaks = compute_peaks(...)` through `promote_temp` region) with:

```rust
    let mut stdout = child.stdout.take().expect("stdout was piped");
    // Downmix target is 2ch; a mono source still decodes to 2 identical channels
    // under `-ac 2`, so the reader/writer path is uniform.
    let channels = MAX_CHANNELS;
    let finest = compute_finest_level(&mut stdout, channels).await?;

    let output = child.wait_with_output().await.context("await ffmpeg for waveform")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        discard_temp(&dest);
        anyhow::bail!("ffmpeg exited with {} for waveform: {}", output.status, stderr.trim());
    }

    let pyramid = build_pyramid(finest);
    write_v2_with_pps(&tmp, channels as u32, &pyramid).await?;
    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!("waveform peaks file is empty after write");
    }
    promote_temp(&dest)?;
    Ok(dest)
```

Delete the now-unused `compute_peaks` and `write_peaks_file` functions.

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml -- decimate_halves build_pyramid_is v2_write_read`
Expected: PASS.

- [ ] **Step 5: Update + run the real-ffmpeg smoke test**

Replace the body of `waveform_roundtrip_against_real_ffmpeg` (the assertions after `run`) with v2-aware checks:

```rust
        let path = run(&cache, &media).await.expect("waveform run");
        assert!(cached_ok(&path));
        assert!(path.to_string_lossy().ends_with(".v2.peaks"));

        let header = read_v2_header(&path).expect("v2 header");
        assert_eq!(header.channels, 2);
        assert_eq!(header.levels[0].peaks_per_second, BASE_PEAKS_PER_SECOND);
        // ~1s source at 1000/sec ≈ ~1000 finest windows (±a few for alignment).
        assert!((990..=1010).contains(&header.levels[0].peak_count),
            "expected ~1000 finest peaks, got {}", header.levels[0].peak_count);

        // Constant 1 kHz sine: every finest window has a full cycle, so max ≈ const,
        // well above the noise floor and below clipping.
        let (_mins, maxs) = read_v2_range(&path, 0, 0, 0, header.levels[0].peak_count).expect("range");
        let peak = maxs.iter().map(|v| dequantize(*v)).fold(0.0_f32, f32::max);
        assert!(peak > 0.05, "peak {peak} too low — pipeline likely broken");
        assert!(peak <= 1.01, "peak {peak} clipped");
```

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs -- waveform_roundtrip_against_real_ffmpeg`
Expected: PASS (or a skip line if ffmpeg is not on PATH).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/native/src/jobs/waveform.rs apps/desktop/native/src/cache/mod.rs
git commit -m "feat(waveform): stereo decode + LOD mipmap pyramid, v2 cache filename"
```

---

## Task 3: v2-backed `read_peaks_file` compat shim (keeps MCP working)

`read_peaks_file` must keep returning **100/sec max-abs f32** so `mcp/tools.rs` (detect_silences) and the waveform resource are untouched. Reimplement it on top of v2: read the level nearest-and-≥ 100/sec, aggregate to exactly 100/sec, and return `max(|min|, max)` per window.

**Files:**
- Modify: `apps/desktop/native/src/jobs/waveform.rs` (`read_peaks_file`)
- Test: `waveform.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `read_v2_header`, `read_v2_range`, `dequantize`, `PEAKS_PER_SECOND`, `BASE_PEAKS_PER_SECOND` (Tasks 1–2).
- Produces: `pub fn read_peaks_file(path: &Path) -> Result<Vec<f32>>` — **unchanged signature/semantics** (100/sec max-abs), now v2-backed. `jobs/mod.rs:31` re-export (`pub use waveform::read_peaks_file;`) stays valid.

- [ ] **Step 1: Write the failing compat test**

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml read_peaks_file_returns_100hz`
Expected: FAIL — old `read_peaks_file` reads the v1 layout and will mis-parse / assert-fail.

- [ ] **Step 3: Reimplement `read_peaks_file` on v2**

Replace the whole `read_peaks_file` fn body:

```rust
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

    let (mins, maxs) = read_v2_range(path, level_idx, 0, 0, level.peak_count)?;
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
```

- [ ] **Step 4: Run to verify it passes, plus the existing offline roundtrip test name**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml read_peaks_file_returns_100hz`
Expected: PASS.

Note: the old `peaks_file_round_trip_offline` test asserted the v1 `write_peaks_file`/`read_peaks_file` pair. Delete that test — its subject (`write_peaks_file`) no longer exists; Task 1's `v2_write_read_header_and_range` and this task's compat test cover the replacement.

- [ ] **Step 5: Verify MCP consumer still compiles against the unchanged signature**

Run: `cargo build --manifest-path apps/desktop/native/Cargo.toml --features jobs,mcp`
Expected: builds clean. `mcp/tools.rs:172` (`jobs::read_peaks_file`) and `:250` (`PEAKS_PER_SECOND`) are untouched and still resolve.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/native/src/jobs/waveform.rs
git commit -m "feat(waveform): v2-backed read_peaks_file compat shim (MCP unchanged)"
```

---

## Task 4: `get_waveform_levels` + `get_waveform_tile` commands (Rust + IPC)

Expose the level table and range reads to the renderer. Add the arg passthrough so a channel needs more than just `mediaId`.

**Files:**
- Modify: `apps/desktop/native/src/commands/media.rs` (two async fns + `WaveformTileArgs`, `WaveformLevels`, `WaveformTile` serde structs)
- Modify: `apps/desktop/native/src/napi_backend.rs:449` (two dispatch arms, after the `get_waveform_peaks` arm)
- Modify: `apps/desktop/src/main/state/single-media-forward.ts` (register channels + pass through extra args)
- Modify: `apps/desktop/src/renderer/ipc/index.ts` (types + calls)
- Test: `napi_backend.rs` `#[cfg(test)]` (dispatch smoke) + `single-media-forward.test.ts`

**Interfaces:**
- Consumes: `read_v2_header`, `read_v2_range`, `dequantize` (Tasks 1–2).
- Produces (Rust, camelCase serde):
  - `WaveformLevels { channels: u32, levels: Vec<WaveformLevelInfo> }`, `WaveformLevelInfo { level: u32, peaksPerSecond: u32, peakCount: u32 }`
  - `WaveformTile { peaksPerSecond: u32, min: Vec<f32>, max: Vec<f32> }`
  - `get_waveform_levels(item) -> Result<WaveformLevels, String>`
  - `get_waveform_tile(args: WaveformTileArgs) -> Result<WaveformTile, String>`
- Produces (TS):
  - `getWaveformLevels(mediaId): Promise<WaveformLevels>`
  - `getWaveformTile(mediaId, level, channel, startPeak, count): Promise<WaveformTile>`

- [ ] **Step 1: Write the failing dispatch smoke test**

Add to `napi_backend.rs` tests (near the existing `get_waveform_peaks` dispatch test at `:544`):

```rust
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_waveform_levels_not_ready_without_path() {
        let sink = std::sync::Arc::new(crate::events::VecEventSink::new());
        let b = Backend::new_for_test(sink as std::sync::Arc<dyn crate::events::EventSink>);
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let item = crate::commands::media::tests_support::mirror_only_item(id); // waveform_path: None
        let args = serde_json::json!({ "item": item }).to_string();
        let err = b.dispatch("get_waveform_levels", &args).await.unwrap_err();
        assert_eq!(err, "not_ready");
    }
```

(If exposing `mirror_only_item` cross-module is awkward, inline a minimal `MediaItem` with `waveform_path: None` as the existing `get_waveform_peaks` dispatch test does — match that test's construction.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs get_waveform_levels_not_ready`
Expected: FAIL — unknown command `get_waveform_levels` returns an "unknown command" error, not `not_ready`.

- [ ] **Step 3: Implement the Rust commands + structs**

In `commands/media.rs`, add near `WaveformPeaks`:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformLevelInfo {
    pub level: u32,
    pub peaks_per_second: u32,
    pub peak_count: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformLevels {
    pub channels: u32,
    pub levels: Vec<WaveformLevelInfo>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformTile {
    pub peaks_per_second: u32,
    pub min: Vec<f32>,
    pub max: Vec<f32>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformTileArgs {
    pub item: MediaItem,
    pub level: u32,
    pub channel: u32,
    pub start_peak: u32,
    pub count: u32,
}

pub async fn get_waveform_levels(item: MediaItem) -> Result<WaveformLevels, String> {
    let path = item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    let header = tokio::task::spawn_blocking(move || crate::jobs::waveform::read_v2_header(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("read header: {e:#}"))?;
    Ok(WaveformLevels {
        channels: header.channels,
        levels: header
            .levels
            .iter()
            .enumerate()
            .map(|(i, l)| WaveformLevelInfo {
                level: i as u32,
                peaks_per_second: l.peaks_per_second,
                peak_count: l.peak_count,
            })
            .collect(),
    })
}

pub async fn get_waveform_tile(args: WaveformTileArgs) -> Result<WaveformTile, String> {
    let path = args.item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    let WaveformTileArgs { level, channel, start_peak, count, .. } = args;
    let (mins, maxs) = tokio::task::spawn_blocking(move || {
        crate::jobs::waveform::read_v2_range(&path, level as usize, channel as usize, start_peak, count)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(|e| format!("read tile: {e:#}"))?;
    // Resolve the level's pps from the header so the renderer can map peaks→time.
    let hdr_path = args.item.waveform_path.clone().unwrap();
    let peaks_per_second = tokio::task::spawn_blocking(move || crate::jobs::waveform::read_v2_header(&hdr_path))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("read header: {e:#}"))?
        .levels
        .get(level as usize)
        .map(|l| l.peaks_per_second)
        .ok_or_else(|| "level out of range".to_string())?;
    Ok(WaveformTile {
        peaks_per_second,
        min: mins.iter().map(|v| crate::jobs::waveform::dequantize(*v)).collect(),
        max: maxs.iter().map(|v| crate::jobs::waveform::dequantize(*v)).collect(),
    })
}
```

In `napi_backend.rs`, add after the `get_waveform_peaks` arm (`:449`):

```rust
            #[cfg(feature = "jobs")]
            "get_waveform_levels" => {
                let a: crate::commands::MediaItemArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_waveform_levels(a.item).await)
            }
            #[cfg(feature = "jobs")]
            "get_waveform_tile" => {
                let a: crate::commands::media::WaveformTileArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_waveform_tile(a).await)
            }
```

- [ ] **Step 4: Run the dispatch smoke test**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs get_waveform_levels_not_ready`
Expected: PASS.

- [ ] **Step 5: Add the TS forwarding + IPC (write failing forward test first)**

Add to `apps/desktop/src/main/state/__tests__/single-media-forward.test.ts`:

```ts
  it('passes through extra args for get_waveform_tile', () => {
    const pool = { m1: { id: 'm1' } as unknown as MediaItem };
    const out = resolveSingleMediaArgs(
      { mediaId: 'm1', level: 2, channel: 1, startPeak: 0, count: 2048 } as never,
      pool,
    );
    expect(out.item).toBe(pool.m1);
    expect(out).toMatchObject({ level: 2, channel: 1, startPeak: 0, count: 2048 });
  });
```

Run: `npx vitest run apps/desktop/src/main/state/__tests__/single-media-forward.test.ts`
Expected: FAIL — extra args are dropped by the current `{ item }`-only return.

Then update `single-media-forward.ts`:

```ts
export const SINGLE_MEDIA_CHANNELS: ReadonlySet<string> = new Set([
  'get_media_thumbnail', 'get_media_thumbnails', 'get_waveform_peaks',
  'get_waveform_levels', 'get_waveform_tile', 'ensure_full_proxy', 'ensure_conform',
])

export function resolveSingleMediaArgs(
  args: { mediaId?: string } & Record<string, unknown>,
  pool: Record<string, MediaItem>,
): { item: MediaItem } & Record<string, unknown> {
  const { mediaId, ...rest } = args
  const id = mediaId ?? ''
  const item = pool[id]
  if (!item) throw new Error(`media ${id} not found`)
  return { item, ...rest }
}
```

And add to `renderer/ipc/index.ts` after `getWaveformPeaks`:

```ts
export interface WaveformLevels {
  channels: number;
  levels: Array<{ level: number; peaksPerSecond: number; peakCount: number }>;
}

/// Header-only read of the media's peaks LOD table. Rejects "not_ready" until
/// the waveform job has produced the v2 file.
export async function getWaveformLevels(mediaId: string): Promise<WaveformLevels> {
  return invoke<WaveformLevels>("get_waveform_levels", { mediaId });
}

export interface WaveformTile {
  peaksPerSecond: number;
  /// Parallel arrays; each value is a normalized sample in [-1, 1].
  min: number[];
  max: number[];
}

/// Read `count` (min,max) windows for one channel of one LOD level, starting at
/// `startPeak`. The range is clamped to the level's peak count backend-side.
export async function getWaveformTile(
  mediaId: string,
  level: number,
  channel: number,
  startPeak: number,
  count: number,
): Promise<WaveformTile> {
  return invoke<WaveformTile>("get_waveform_tile", {
    mediaId, level, channel, startPeak, count,
  });
}
```

- [ ] **Step 6: Run the forward test + rebuild native**

Run: `npx vitest run apps/desktop/src/main/state/__tests__/single-media-forward.test.ts`
Expected: PASS.
Run: `cd apps/desktop && npm run napi:build`
Expected: native addon rebuilds clean (needed before the TS engine talks to the new commands).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/native/src/commands/media.rs apps/desktop/native/src/napi_backend.rs \
        apps/desktop/src/main/state/single-media-forward.ts \
        apps/desktop/src/main/state/__tests__/single-media-forward.test.ts \
        apps/desktop/src/renderer/ipc/index.ts
git commit -m "feat(waveform): get_waveform_levels + get_waveform_tile commands + IPC"
```

---

## Task 5: Generic `TileEngine` (cache, coalescing, versioned stale-drop, LRU, invalidation)

The producer-agnostic orchestration core. This is the part we justified building once (Plan 2's filmstrip reuses it). Behavior mirrors — and replaces — the ad-hoc `cache/listeners/requestVersions/installJobListenerOnce` skeleton currently duplicated in `TimelineWaveform`/`TimelineFilmstrip`.

**Files:**
- Create: `apps/desktop/src/renderer/timeline/tileEngine/TileEngine.ts`
- Test: `apps/desktop/src/renderer/timeline/tileEngine/TileEngine.test.ts`

**Interfaces:**
- Consumes: `listen` from `@/bridge/events`, `MEDIA_JOB_EVENTS` from `../../ipc`.
- Produces:
  - `interface TileProducer<T> { kind: string; fetch(key: TileKey): Promise<T>; bytes(value: T): number; dispose?(value: T): void }`
  - `interface TileKey { mediaId: string; kind: string; lod: number; index: number }`
  - `type TileEntry<T> = { state: "pending" } | { state: "ready"; value: T } | { state: "not_ready" } | { state: "error"; message: string }`
  - `class TileEngine` with: `register<T>(producer: TileProducer<T>)`, `get<T>(key: TileKey): TileEntry<T> | undefined`, `request(key: TileKey): void`, `subscribe(mediaId: string, cb: () => void): () => void`, `invalidateMedia(mediaId: string, kind: string): void`. Byte-budget LRU with `dispose` on eviction. `media:job_complete` listener installed on construction.
  - `const tileEngine = new TileEngine(DEFAULT_TILE_BUDGET_BYTES)` singleton export.

- [ ] **Step 1: Write failing engine tests**

Create `TileEngine.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TileEngine, type TileProducer, type TileKey } from "./TileEngine";

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));

function makeProducer(overrides: Partial<TileProducer<number[]>> = {}): {
  producer: TileProducer<number[]>;
  calls: TileKey[];
  resolve: (k: string, v: number[]) => void;
} {
  const calls: TileKey[] = [];
  const pending = new Map<string, (v: number[]) => void>();
  const producer: TileProducer<number[]> = {
    kind: "test",
    fetch: (key) => {
      calls.push(key);
      return new Promise<number[]>((res) => pending.set(`${key.lod}:${key.index}`, res));
    },
    bytes: (v) => v.length * 8,
    ...overrides,
  };
  return { producer, calls, resolve: (k, v) => pending.get(k)?.(v) };
}

describe("TileEngine", () => {
  let engine: TileEngine;
  beforeEach(() => { engine = new TileEngine(1000); });

  it("coalesces duplicate in-flight requests for the same key", async () => {
    const { producer, calls } = makeProducer();
    engine.register(producer);
    const key: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 0 };
    engine.request(key);
    engine.request(key);
    expect(calls.length).toBe(1);
    expect(engine.get(key)?.state).toBe("pending");
  });

  it("stores ready values and notifies subscribers", async () => {
    const { producer, resolve } = makeProducer();
    engine.register(producer);
    const cb = vi.fn();
    engine.subscribe("m", cb);
    const key: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 0 };
    engine.request(key);
    resolve("0:0", [1, 2, 3]);
    await Promise.resolve();
    expect(engine.get(key)).toEqual({ state: "ready", value: [1, 2, 3] });
    expect(cb).toHaveBeenCalled();
  });

  it("evicts least-recently-used entries past the byte budget and calls dispose", async () => {
    const disposed: number[][] = [];
    const { producer, resolve } = makeProducer({ dispose: (v) => disposed.push(v) });
    engine.register(producer);
    // budget 1000 bytes; each [.. x 80] = 640 bytes. Two fit? 1280 > 1000 -> evict first.
    const big = Array.from({ length: 80 }, (_, i) => i);
    const k0: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 0 };
    const k1: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 1 };
    engine.request(k0); resolve("0:0", big); await Promise.resolve();
    engine.get(k0); // touch
    engine.request(k1); resolve("0:1", big); await Promise.resolve();
    expect(engine.get(k1)?.state).toBe("ready");
    expect(engine.get(k0)).toBeUndefined(); // evicted
    expect(disposed.length).toBe(1);
  });

  it("invalidateMedia drops that media's entries for the kind", async () => {
    const { producer, resolve } = makeProducer();
    engine.register(producer);
    const key: TileKey = { mediaId: "m", kind: "test", lod: 0, index: 0 };
    engine.request(key); resolve("0:0", [1]); await Promise.resolve();
    expect(engine.get(key)?.state).toBe("ready");
    engine.invalidateMedia("m", "test");
    expect(engine.get(key)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/desktop/src/renderer/timeline/tileEngine/TileEngine.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `TileEngine`**

Create `TileEngine.ts`:

```ts
import { listen } from "@/bridge/events";
import { MEDIA_JOB_EVENTS } from "../../ipc";

export interface TileKey {
  mediaId: string;
  kind: string;
  lod: number;
  index: number;
}

export type TileEntry<T> =
  | { state: "pending" }
  | { state: "ready"; value: T }
  | { state: "not_ready" }
  | { state: "error"; message: string };

export interface TileProducer<T> {
  /// Matches `media:job_complete.kind` and `TileKey.kind`.
  kind: string;
  fetch(key: TileKey): Promise<T>;
  bytes(value: T): number;
  /// Called when an entry is evicted or invalidated. Use for ImageBitmap.close().
  dispose?(value: T): void;
}

export const DEFAULT_TILE_BUDGET_BYTES = 192 * 1024 * 1024;

function keyStr(k: TileKey): string {
  return `${k.mediaId} ${k.kind} ${k.lod} ${k.index}`;
}

interface Slot<T> {
  key: TileKey;
  entry: TileEntry<T>;
  bytes: number;
  /// Monotonic touch counter for LRU; also the request version for stale-drop.
  version: number;
}

export class TileEngine {
  private producers = new Map<string, TileProducer<unknown>>();
  private slots = new Map<string, Slot<unknown>>();
  private listeners = new Map<string, Set<() => void>>();
  private totalBytes = 0;
  private clock = 0;
  private jobListenerInstalled = false;

  constructor(private budgetBytes = DEFAULT_TILE_BUDGET_BYTES) {
    void this.installJobListenerOnce();
  }

  register<T>(producer: TileProducer<T>): void {
    this.producers.set(producer.kind, producer as TileProducer<unknown>);
  }

  get<T>(key: TileKey): TileEntry<T> | undefined {
    const slot = this.slots.get(keyStr(key));
    if (!slot) return undefined;
    slot.version = ++this.clock; // touch for LRU
    return slot.entry as TileEntry<T>;
  }

  request(key: TileKey): void {
    const ks = keyStr(key);
    const existing = this.slots.get(ks);
    if (existing && (existing.entry.state === "pending" || existing.entry.state === "ready" || existing.entry.state === "error")) {
      return; // coalesce; not_ready is retried on job_complete, so allow re-request only then
    }
    const producer = this.producers.get(key.kind);
    if (!producer) return;
    const version = ++this.clock;
    this.slots.set(ks, { key, entry: { state: "pending" }, bytes: 0, version });
    producer
      .fetch(key)
      .then((value) => {
        const slot = this.slots.get(ks);
        if (!slot || slot.version !== version) {
          // Stale: a newer request/invalidation replaced this slot. Drop, but
          // dispose the just-fetched value so we don't leak it.
          producer.dispose?.(value);
          return;
        }
        const bytes = producer.bytes(value);
        slot.entry = { state: "ready", value };
        slot.bytes = bytes;
        this.totalBytes += bytes;
        this.evictToBudget(ks);
        this.notify(key.mediaId);
      })
      .catch((e: unknown) => {
        const slot = this.slots.get(ks);
        if (!slot || slot.version !== version) return;
        const message = typeof e === "string" ? e : String(e);
        slot.entry = message.includes("not_ready")
          ? { state: "not_ready" }
          : { state: "error", message };
        this.notify(key.mediaId);
      });
  }

  subscribe(mediaId: string, cb: () => void): () => void {
    let set = this.listeners.get(mediaId);
    if (!set) { set = new Set(); this.listeners.set(mediaId, set); }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set && set.size === 0) this.listeners.delete(mediaId);
    };
  }

  invalidateMedia(mediaId: string, kind: string): void {
    for (const [ks, slot] of this.slots) {
      if (slot.key.mediaId === mediaId && slot.key.kind === kind) {
        this.freeSlot(ks, slot);
      }
    }
    this.notify(mediaId);
  }

  private freeSlot(ks: string, slot: Slot<unknown>): void {
    if (slot.entry.state === "ready") {
      this.producers.get(slot.key.kind)?.dispose?.(slot.entry.value);
      this.totalBytes -= slot.bytes;
    }
    this.slots.delete(ks);
  }

  private evictToBudget(protectKs: string): void {
    if (this.totalBytes <= this.budgetBytes) return;
    const ready = [...this.slots.entries()]
      .filter(([ks, s]) => ks !== protectKs && s.entry.state === "ready")
      .sort((a, b) => a[1].version - b[1].version); // oldest touch first
    for (const [ks, slot] of ready) {
      if (this.totalBytes <= this.budgetBytes) break;
      this.freeSlot(ks, slot);
    }
  }

  private notify(mediaId: string): void {
    this.listeners.get(mediaId)?.forEach((cb) => cb());
  }

  private async installJobListenerOnce(): Promise<void> {
    if (this.jobListenerInstalled) return;
    this.jobListenerInstalled = true;
    await listen<{ media_id: string; kind: string }>(
      MEDIA_JOB_EVENTS.complete,
      (event) => {
        const kind = event.payload?.kind;
        const mediaId = event.payload?.media_id;
        if (!kind || !mediaId) return;
        // Only kinds that map to a registered producer are ours.
        if (!this.producers.has(kind)) return;
        this.invalidateMedia(mediaId, kind);
      },
    );
  }
}

export const tileEngine = new TileEngine();
```

- [ ] **Step 4: Run to verify tests pass**

Run: `npx vitest run apps/desktop/src/renderer/timeline/tileEngine/TileEngine.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/timeline/tileEngine/TileEngine.ts \
        apps/desktop/src/renderer/timeline/tileEngine/TileEngine.test.ts
git commit -m "feat(timeline): generic TileEngine (coalesce, LRU, invalidation)"
```

---

## Task 6: `WaveformTileProducer` — LOD selection + window assembly

Register a producer that picks the right LOD for the current `pxPerSec`, fetches the covering tiles, and assembles a window's min/max envelope. Pure logic + one IPC call; fully unit-testable with a mocked IPC.

**Files:**
- Create: `apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.ts`
- Test: `apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.test.ts`

**Interfaces:**
- Consumes: `getWaveformLevels`, `getWaveformTile`, `WaveformLevels` (Task 4); `TileEngine`, `TileKey`, `tileEngine` (Task 5).
- Produces:
  - `const WAVEFORM_KIND = "waveform"`, `const TILE_PEAKS = 2048`, `const PX_PER_PEAK_TARGET = 1.5`
  - `function chooseLevel(levels: WaveformLevels["levels"], pxPerSec: number): number` — index of the finest-enough level.
  - `function tileRangeForWindow(peaksPerSecond: number, srcInUs: number, srcOutUs: number): { firstTile: number; lastTile: number; startPeak: number; endPeak: number }`
  - `interface WaveformWindow { peaksPerSecond: number; startPeak: number; min: Float32Array; max: Float32Array }`
  - `function registerWaveformProducer(engine?: TileEngine): void`
  - `async function ensureWaveformWindow(mediaId, channel, srcInUs, srcOutUs, pxPerSec, engine?): Promise<WaveformWindow | "pending" | "not_ready">` — requests the covering tiles, assembles ready ones; returns `"pending"` until all are ready.

- [ ] **Step 1: Write failing producer-logic tests**

Create `WaveformTileProducer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { chooseLevel, tileRangeForWindow, TILE_PEAKS } from "./WaveformTileProducer";

describe("chooseLevel", () => {
  const levels = [
    { level: 0, peaksPerSecond: 1000, peakCount: 60000 },
    { level: 1, peaksPerSecond: 500, peakCount: 30000 },
    { level: 2, peaksPerSecond: 250, peakCount: 15000 },
    { level: 3, peaksPerSecond: 125, peakCount: 7500 },
  ];
  it("picks the coarsest level still >= desired density", () => {
    // pxPerSec 80 -> desired ≈ 80/1.5 ≈ 53 pps -> coarsest >= 53 is 125 (idx 3)
    expect(chooseLevel(levels, 80)).toBe(3);
  });
  it("picks a finer level as zoom increases", () => {
    // pxPerSec 800 -> desired ≈ 533 pps -> coarsest >= 533 is 1000 (idx 0)
    expect(chooseLevel(levels, 800)).toBe(0);
    // pxPerSec 400 -> desired ≈ 266 -> coarsest >= 266 is 500 (idx 1)
    expect(chooseLevel(levels, 400)).toBe(1);
  });
  it("clamps to finest when desired exceeds all levels", () => {
    expect(chooseLevel(levels, 100000)).toBe(0);
  });
});

describe("tileRangeForWindow", () => {
  it("maps a src window to peak indices and tile indices", () => {
    // 1000 pps, window [1.0s, 3.0s) -> peaks [1000, 3000)
    const r = tileRangeForWindow(1000, 1_000_000, 3_000_000);
    expect(r.startPeak).toBe(1000);
    expect(r.endPeak).toBe(3000);
    expect(r.firstTile).toBe(Math.floor(1000 / TILE_PEAKS)); // 0
    expect(r.lastTile).toBe(Math.floor((3000 - 1) / TILE_PEAKS)); // 1
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the producer**

Create `WaveformTileProducer.ts`:

```ts
import {
  getWaveformLevels,
  getWaveformTile,
  type WaveformLevels,
} from "../../ipc";
import { tileEngine, type TileEngine, type TileKey } from "./TileEngine";

export const WAVEFORM_KIND = "waveform";
/// One fetched tile = this many (min,max) windows. Bounds IPC payload size.
export const TILE_PEAKS = 2048;
/// Aim for ~1.5 timeline px per peak window at the chosen LOD.
export const PX_PER_PEAK_TARGET = 1.5;

/// Index of the coarsest level whose density still meets the on-screen demand,
/// so we ship the least data that looks crisp. Levels are finest-first.
export function chooseLevel(
  levels: WaveformLevels["levels"],
  pxPerSec: number,
): number {
  const desired = pxPerSec / PX_PER_PEAK_TARGET;
  let chosen = 0; // finest fallback
  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i].peaksPerSecond >= desired) { chosen = i; break; }
  }
  return chosen;
}

export function tileRangeForWindow(
  peaksPerSecond: number,
  srcInUs: number,
  srcOutUs: number,
): { firstTile: number; lastTile: number; startPeak: number; endPeak: number } {
  const lo = Math.min(srcInUs, srcOutUs);
  const hi = Math.max(srcInUs, srcOutUs);
  const startPeak = Math.max(0, Math.floor((lo / 1_000_000) * peaksPerSecond));
  const endPeak = Math.max(startPeak + 1, Math.ceil((hi / 1_000_000) * peaksPerSecond));
  return {
    startPeak,
    endPeak,
    firstTile: Math.floor(startPeak / TILE_PEAKS),
    lastTile: Math.floor((endPeak - 1) / TILE_PEAKS),
  };
}

export interface WaveformWindow {
  peaksPerSecond: number;
  startPeak: number;
  min: Float32Array;
  max: Float32Array;
}

interface TileValue {
  peaksPerSecond: number;
  min: number[];
  max: number[];
}

// Level tables are cheap + immutable per media file; cache them so we don't
// re-read the header on every window assembly.
const levelsCache = new Map<string, Promise<WaveformLevels>>();
function fetchLevels(mediaId: string): Promise<WaveformLevels> {
  let p = levelsCache.get(mediaId);
  if (!p) {
    p = getWaveformLevels(mediaId).catch((e) => { levelsCache.delete(mediaId); throw e; });
    levelsCache.set(mediaId, p);
  }
  return p;
}

let registered = false;
export function registerWaveformProducer(engine: TileEngine = tileEngine): void {
  if (registered) return;
  registered = true;
  engine.register<TileValue>({
    kind: WAVEFORM_KIND,
    // `lod` encodes level; `index` encodes channel*BIG + tileIndex.
    fetch: async (key: TileKey) => {
      const channel = Math.floor(key.index / 1_000_000);
      const tileIndex = key.index % 1_000_000;
      const tile = await getWaveformTile(
        key.mediaId, key.lod, channel, tileIndex * TILE_PEAKS, TILE_PEAKS,
      );
      return { peaksPerSecond: tile.peaksPerSecond, min: tile.min, max: tile.max };
    },
    bytes: (v) => (v.min.length + v.max.length) * 8,
  });
}

function tileKey(mediaId: string, level: number, channel: number, tileIndex: number): TileKey {
  return { mediaId, kind: WAVEFORM_KIND, lod: level, index: channel * 1_000_000 + tileIndex };
}

/// Request + assemble the min/max envelope for a src window at the LOD that
/// suits `pxPerSec`. Returns "pending" until every covering tile is ready, or
/// "not_ready" if the waveform file isn't generated yet.
export async function ensureWaveformWindow(
  mediaId: string,
  channel: number,
  srcInUs: number,
  srcOutUs: number,
  pxPerSec: number,
  engine: TileEngine = tileEngine,
): Promise<WaveformWindow | "pending" | "not_ready"> {
  let levels: WaveformLevels;
  try {
    levels = await fetchLevels(mediaId);
  } catch (e) {
    return typeof e === "string" && e.includes("not_ready") ? "not_ready" : "pending";
  }
  if (levels.levels.length === 0) return "not_ready";

  const level = chooseLevel(levels.levels, pxPerSec);
  const pps = levels.levels[level].peaksPerSecond;
  const { firstTile, lastTile, startPeak, endPeak } = tileRangeForWindow(pps, srcInUs, srcOutUs);

  // Request all covering tiles; collect ready ones.
  const tiles: (TileValue | null)[] = [];
  let anyMissing = false;
  let notReady = false;
  for (let t = firstTile; t <= lastTile; t++) {
    const key = tileKey(mediaId, level, channel, t);
    const entry = engine.get<TileValue>(key);
    if (!entry) { engine.request(key); anyMissing = true; tiles.push(null); continue; }
    if (entry.state === "ready") { tiles.push(entry.value); continue; }
    if (entry.state === "not_ready") { notReady = true; tiles.push(null); continue; }
    // pending or error -> treat as missing
    anyMissing = true;
    tiles.push(null);
  }
  if (notReady) return "not_ready";
  if (anyMissing || tiles.some((x) => x === null)) return "pending";

  // Assemble the [startPeak, endPeak) slice.
  const total = endPeak - startPeak;
  const min = new Float32Array(total);
  const max = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const globalPeak = startPeak + i;
    const t = Math.floor(globalPeak / TILE_PEAKS);
    const within = globalPeak % TILE_PEAKS;
    const tile = tiles[t - firstTile]!;
    min[i] = tile.min[within] ?? 0;
    max[i] = tile.max[within] ?? 0;
  }
  return { peaksPerSecond: pps, startPeak, min, max };
}
```

- [ ] **Step 4: Run to verify the logic tests pass**

Run: `npx vitest run apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.ts \
        apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.test.ts
git commit -m "feat(timeline): WaveformTileProducer (LOD selection + window assembly)"
```

---

## Task 7: Rewrite `TimelineWaveform` — tiled DPR canvas + min/max envelope

Replace the single capped canvas with a DPR-correct render driven by the engine. Draw a true positive/negative envelope. Remove `MAX_WAVEFORM_CANVAS_WIDTH`. Split wide clips into fixed-width tile canvases so no single canvas is huge and offscreen ones are culled.

**Files:**
- Rewrite: `apps/desktop/src/renderer/timeline/TimelineWaveform.tsx`
- Modify: `apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx`
- The component already receives `mediaId, srcInUs, srcOutUs, layerWidthPx, layerHeightPx, colorHint, enabled` from `TimelineVisualPreview.tsx:139` — add one prop: `pxPerSec: number`. Update the call site to pass it (it already has `pxPerSec` available in `LayerBlock` → thread it through `TimelineVisualPreview`).

**Interfaces:**
- Consumes: `ensureWaveformWindow`, `registerWaveformProducer`, `WaveformWindow` (Task 6); `tileEngine` (Task 5).
- Produces: same default export `TimelineWaveform`, now with a `pxPerSec` prop. `data-testid="timeline-waveform"` and `data-state` retained for existing tests.

- [ ] **Step 1: Update the failing component test**

In `TimelineWaveform.test.tsx`, keep the "renders center-line placeholder while not ready" test, and add a state-driven one. Representative additions (adapt imports/mocks to the file's existing harness):

```tsx
  it("exposes data-state=ready once the engine resolves a window", async () => {
    // Mock the producer boundary so no real IPC is needed.
    vi.mock("./tileEngine/WaveformTileProducer", () => ({
      registerWaveformProducer: vi.fn(),
      ensureWaveformWindow: vi.fn(async () => ({
        peaksPerSecond: 1000, startPeak: 0,
        min: new Float32Array([-0.5, -0.7]), max: new Float32Array([0.5, 0.7]),
      })),
    }));
    const { findByTestId } = render(
      <TimelineWaveform
        mediaId="m" srcInUs={0} srcOutUs={2_000_000}
        layerWidthPx={200} layerHeightPx={40} colorHint="#123" enabled pxPerSec={80}
      />,
    );
    const el = await findByTestId("timeline-waveform");
    await vi.waitFor(() => expect(el.getAttribute("data-state")).toBe("ready"));
  });

  it("does not create a canvas wider than the tile width", () => {
    const { getAllByTestId } = render(
      <TimelineWaveform
        mediaId="m" srcInUs={0} srcOutUs={600_000_000}
        layerWidthPx={200000} layerHeightPx={40} colorHint="#123" enabled pxPerSec={800}
      />,
    );
    for (const c of getAllByTestId("timeline-waveform-tile") as HTMLCanvasElement[]) {
      expect(c.width).toBeLessThanOrEqual(2048 * window.devicePixelRatio);
    }
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx`
Expected: FAIL — component has no `pxPerSec` prop / no per-tile canvases yet.

- [ ] **Step 3: Rewrite the component**

Replace `TimelineWaveform.tsx` entirely:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { tileEngine } from "./tileEngine/TileEngine";
import {
  ensureWaveformWindow,
  registerWaveformProducer,
  type WaveformWindow,
} from "./tileEngine/WaveformTileProducer";

registerWaveformProducer();

/// Max CSS width of one render tile canvas. Fixed + small so no single canvas
/// approaches the browser's element-size limit; offscreen tiles are cheap and
/// (with content-visibility) skip rasterization.
const RENDER_TILE_PX = 2048;

type RenderState = "pending" | "not_ready" | "ready";

function useWindowData(
  mediaId: string,
  srcInUs: number,
  srcOutUs: number,
  pxPerSec: number,
  enabled: boolean,
): { state: RenderState; window: WaveformWindow | null } {
  const [result, setResult] = useState<{ state: RenderState; window: WaveformWindow | null }>(
    { state: "pending", window: null },
  );
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = () => {
      void ensureWaveformWindow(mediaId, 0, srcInUs, srcOutUs, pxPerSec).then((r) => {
        if (cancelled) return;
        if (r === "pending") setResult({ state: "pending", window: null });
        else if (r === "not_ready") setResult({ state: "not_ready", window: null });
        else setResult({ state: "ready", window: r });
      });
    };
    const unsub = tileEngine.subscribe(mediaId, run);
    run();
    return () => { cancelled = true; unsub(); };
  }, [mediaId, srcInUs, srcOutUs, pxPerSec, enabled]);
  return result;
}

function drawTile(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  win: WaveformWindow | null,
  tileStartPx: number,
  totalWidthPx: number,
) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const mid = cssHeight / 2;

  if (!win || win.min.length === 0) {
    ctx.strokeStyle = "rgba(255,255,255,0.34)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(cssWidth, mid);
    ctx.stroke();
    return;
  }

  // Map this tile's px range [tileStartPx, tileStartPx+cssWidth) to peak indices.
  const peaks = win.min.length;
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  const amp = cssHeight / 2 - 1;
  for (let px = 0; px < cssWidth; px++) {
    const gpx = tileStartPx + px;
    const p0 = Math.floor((gpx / totalWidthPx) * peaks);
    const p1 = Math.max(p0 + 1, Math.floor(((gpx + 1) / totalWidthPx) * peaks));
    let lo = 0, hi = 0;
    for (let p = p0; p < p1 && p < peaks; p++) {
      lo = Math.min(lo, win.min[p]);
      hi = Math.max(hi, win.max[p]);
    }
    const yTop = mid - hi * amp;
    const yBot = mid - lo * amp;
    ctx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));
  }
}

export function TimelineWaveform({
  mediaId, srcInUs, srcOutUs, layerWidthPx, layerHeightPx, colorHint, enabled, pxPerSec,
}: {
  mediaId: string;
  srcInUs: number;
  srcOutUs: number;
  layerWidthPx: number;
  layerHeightPx: number;
  colorHint: string;
  enabled: boolean;
  pxPerSec: number;
}) {
  const { state, window: win } = useWindowData(mediaId, srcInUs, srcOutUs, pxPerSec, enabled);
  const totalWidthPx = Math.max(1, Math.ceil(layerWidthPx));
  const height = Math.max(1, Math.ceil(layerHeightPx));

  const tiles = useMemo(() => {
    const n = Math.max(1, Math.ceil(totalWidthPx / RENDER_TILE_PX));
    return Array.from({ length: n }, (_, i) => ({
      startPx: i * RENDER_TILE_PX,
      widthPx: Math.min(RENDER_TILE_PX, totalWidthPx - i * RENDER_TILE_PX),
    }));
  }, [totalWidthPx]);

  return (
    <div
      data-testid="timeline-waveform"
      data-state={enabled ? state : "disabled"}
      className="flex h-full w-full overflow-hidden"
      style={{
        backgroundColor: colorHint,
        backgroundImage:
          state === "ready"
            ? undefined
            : "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(0,0,0,0.14))",
      }}
    >
      {tiles.map((tile) => (
        <WaveformTileCanvas
          key={tile.startPx}
          widthPx={tile.widthPx}
          height={height}
          win={state === "ready" ? win : null}
          tileStartPx={tile.startPx}
          totalWidthPx={totalWidthPx}
        />
      ))}
    </div>
  );
}

function WaveformTileCanvas({
  widthPx, height, win, tileStartPx, totalWidthPx,
}: {
  widthPx: number;
  height: number;
  win: WaveformWindow | null;
  tileStartPx: number;
  totalWidthPx: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    drawTile(c, widthPx, height, win, tileStartPx, totalWidthPx);
  }, [widthPx, height, win, tileStartPx, totalWidthPx]);
  return (
    <canvas
      ref={ref}
      data-testid="timeline-waveform-tile"
      style={{
        width: `${widthPx}px`,
        height: `${height}px`,
        contentVisibility: "auto",
        containIntrinsicSize: `${widthPx}px ${height}px`,
      }}
    />
  );
}
```

- [ ] **Step 4: Thread `pxPerSec` through the call site**

In `TimelineVisualPreview.tsx`, add `pxPerSec: number` to the component's props, and pass it to `<TimelineWaveform … pxPerSec={pxPerSec} />` (the `Audio` case at `:139`). In `LayerBlock.tsx:496`, pass `pxPerSec={pxPerSec}` to `<TimelineVisualPreview>` (it already has `pxPerSec` in scope at `:98`).

- [ ] **Step 5: Run the component test + typecheck**

Run: `npx vitest run apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx`
Expected: PASS.
Run: `cd apps/desktop && npx tsc -b --noEmit`
Expected: no type errors (the new `pxPerSec` prop is wired through both call sites).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/timeline/TimelineWaveform.tsx \
        apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx \
        apps/desktop/src/renderer/timeline/TimelineVisualPreview.tsx \
        apps/desktop/src/renderer/timeline/LayerBlock.tsx
git commit -m "feat(timeline): DPR tiled min/max waveform render on the tile engine"
```

---

## Task 8: End-to-end verification

Confirm the whole path works against the real backend and the full suites are green.

**Files:** none (verification only).

- [ ] **Step 1: Full Rust suite (jobs + mcp features)**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs,mcp waveform`
Expected: PASS. Confirm `read_peaks_file` / detect_silences tests (if any in `mcp`) still pass.

- [ ] **Step 2: Full renderer timeline suite**

Run: `npx vitest run apps/desktop/src/renderer/timeline`
Expected: PASS.

- [ ] **Step 3: Rebuild native + typecheck**

Run: `cd apps/desktop && npm run napi:build && npx tsc -b --noEmit`
Expected: both clean.

- [ ] **Step 4: Manual smoke (per `reference_dev_app_cdp_driving`)**

Launch the dev app, import a stereo audio clip and a video-with-audio clip, and confirm on the timeline:
- The waveform shows a real positive/negative envelope (not a solid blob).
- Zooming in with Ctrl+wheel keeps sharpening detail past the old 200 px/sec wall (no stair-stepping), and a long clip past 4096px is crisp (no blur).
- A clip with no generated waveform yet shows the center-line placeholder, then fills in when `media:job_complete{kind:"waveform"}` fires.

- [ ] **Step 5: Final commit (only if smoke fixes were needed; stage explicit paths)**

```bash
# Stage ONLY files you changed, by explicit path — never `git add -A`.
git add apps/desktop/src/renderer/timeline/<changed-file> ...
git commit -m "test(waveform): e2e verification of the tiled waveform engine"
```

---

## Self-Review Notes (author checklist, done)

- **Spec coverage:** VPEAKS v2 min/max + stereo + mipmap (Tasks 1–2); mmap/seek range reads (Task 1); L0-as-base + MCP-unchanged compat (Task 3); on-demand tiles + generic engine + coalescing + LRU + invalidation (Tasks 4–5); LOD-by-zoom + source-time keying (Task 6); DPR + 4096-cap removal + min/max render + bounded tile canvases (Task 7). Sample-level windowed-PCM fallback is intentionally **out of scope** (deferred P2 per the design); the finest stored level (1000/sec) is the ceiling here.
- **Placeholders:** none — every step ships real code/commands.
- **Type consistency:** `WaveformTile`/`WaveformLevels` names, `getWaveformTile` arg order `(mediaId, level, channel, startPeak, count)`, `TileKey.index = channel*1_000_000 + tileIndex`, and `WAVEFORM_KIND = "waveform"` (matching `media:job_complete.kind`) are consistent across Tasks 4–7.

## Follow-up plans (not in this plan)

- **Plan 2 — Filmstrip tiles:** `FilmstripTileProducer` (Rust ffmpeg seek-extract, eager coarse base + lazy fine tiles, prefer-proxy, source-time keyed) registered on this same `TileEngine`; canvas filmstrip render with temporal frame positioning; `dispose` = `ImageBitmap.close()`. Requires the proxy-wait generation rule (design Q9 option (i)).
- **Plan 3 — Disk LRU + zoom ceiling:** Rust disk-cache budget + LRU eviction (thumbnail tiles are the growth source); raise `MAX_PX_PER_SEC` 800 → 2000 in `geometry.ts`.
