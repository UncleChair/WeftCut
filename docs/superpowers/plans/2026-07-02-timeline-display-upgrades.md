# Timeline Display Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the visual-quality gap on timeline clip content — a two-tone stereo RMS waveform and a temporally-accurate, zoom-adaptive video filmstrip — while keeping the native data pipeline exactly as architected.

**Architecture:** Display-layer strategies are adopted from the clipcombo comparison (2026-07-02): canonical-height thumbnail decode, temporal tile positioning, flicker-free stale-while-revalidate repaint, min/max+RMS two-tone envelope, amplitude floor. The data side is deliberately NOT adopted from clipcombo: generation stays native ffmpeg, caching stays blake3-keyed disk files, orchestration stays the generic `TileEngine`.

**Tech Stack:** Rust (ffmpeg sidecar, VPEAKS binary format, napi commands), TypeScript/React (TileEngine producers, canvas render), Vitest + cargo test.

This supersedes the "Follow-up plans" section of
`docs/superpowers/plans/2026-07-02-timeline-waveform-engine.md` and reorganizes
the remaining timeline-content work as:

- **Plan A — Waveform display upgrades — SHIPPED** (merged to main through
  `006d7571`, user-verified in the real app; kept below as the record of the
  bound decisions). Post-ship fixes folded in: stereo-lane gating on source
  channel metadata (`MediaSummary.audio_channels` — the generator's `-ac 2`
  makes the peaks header always report 2 channels), and a TileEngine fix (LRU
  touches only ready slots; a pending-slot touch stale-dropped in-flight
  fetches and wedged tiles forever — deterministic under dual-channel fetch).
- **Plan B — Filmstrip tile engine** (design locked below; expand into its own
  task-by-task plan at pickup). Additional intake from the Plan-A field
  incident: an engine-subscribe-path test (the invalidation→refetch linchpin
  has no coverage), and error-tile re-request (T6-M1).
- **Plan C — Disk-cache LRU + zoom ceiling** (carried forward, scope amended)

## Global Constraints

- **Data side is fixed** (our approach beats clipcombo's here; do not revisit):
  native ffmpeg generation in `apps/desktop/native/src/jobs/`, blake3
  content-hash disk caches under `CacheLayout`, `TileEngine` (renderer)
  orchestration with byte-budget LRU + `media:job_complete` invalidation, IPC
  via `napi_backend.rs` string commands. Explicitly NOT adopted from clipcombo:
  IndexedDB persistence, mediabunny/browser-side decode, main-thread
  `scheduler.yield` decoding, mixed-mono-only peaks.
- **Display strategies adopted from clipcombo** (apply consistently in both
  plans): (1) never blank already-rendered content — repaint synchronously from
  ready cache entries, fetch misses on a debounce; (2) decode thumbnails at one
  canonical height so lane height/zoom never changes a cache key; (3) position
  content at its true source time; (4) draw quiet-but-present signal visibly
  (amplitude floor, RMS core).
- Engine-pair rule does not apply here (no animation-engine math is touched),
  but the comment-style rubric (`docs/comment-style.md`) and evergreen-docs
  convention (no dates/phases in `docs/*.md`) do.
- Stage commits by explicit path only; parallel sessions may be editing this
  checkout.
- Gates for every task: `cargo test --lib --features jobs` (in
  `apps/desktop/native`), `npx tsc -b` + `npx vitest run` (in `apps/desktop`).

---

# Plan A — Waveform display upgrades

**What the user sees today:** a single-color min/max bar chart of the LEFT
channel only, which blanks to a placeholder during zoom LOD switches.
**What ships:** a two-tone envelope (soft min/max fill + bright RMS core),
stereo lanes when the slice is tall enough, both channels merged when it is
not, a 1px visibility floor, no blanking during zoom, and DPR-change redraw.

Data-side change is confined to ONE addition: an RMS plane in the peaks file
(VPEAKS v3). Everything else (decode command, pyramid shape, tile IPC, TileEngine)
is untouched in structure.

### VPEAKS v3 format (decided)

- Per window: `min: i16, max: i16, rms: u16` — 6 bytes (was 4). Channel-planar
  layout unchanged, so a channel range read stays one contiguous `seek+read`.
- `rms` quantization: `round(clamp(v, 0, 1) * u16::MAX)`.
- Finest-level RMS: `sqrt(sum(sample²)/frames_in_window)` accumulated in the
  same single PCM pass that already computes min/max.
- Pyramid RMS decimation: children `a, b` → `sqrt((a² + b²) / 2)` (RMS of the
  concatenated equal windows); odd tail pairs with itself (value unchanged).
- Header layout unchanged (magic, version=3, rate, channels, level table).
- Cache filename `{hash}.v2.peaks` → `{hash}.v3.peaks` (`cache/mod.rs`), so v2
  files simply orphan and every waveform regenerates lazily on first request.
  Orphan sweep belongs to Plan C.
- No v2 reader is kept (same convention as the v1→v2 bump: single-version
  reader, filename tag drives regeneration).
- Size check: 1000 pps × 2ch × 6B = 12 KB/s of source audio ≈ 43 MB per source
  hour — acceptable.

### Task A1: VPEAKS v3 in Rust (format + generation + range read)

**Files:**
- Modify: `apps/desktop/native/src/jobs/waveform.rs`
- Modify: `apps/desktop/native/src/cache/mod.rs` (waveform cache filename)
- Tests: in-file `mod tests` of `waveform.rs`

**Interfaces:**
- Consumes: existing `LevelData`, `write_v2_with_pps`, `read_v2_header`,
  `read_v2_range`, `compute_finest_level`, `decimate`, `build_pyramid`.
- Produces (later tasks rely on these exact names):
  - `pub const FORMAT_VERSION: u32 = 3;` (replaces `FORMAT_VERSION_V2`)
  - `LevelData` gains `pub rmss: Vec<Vec<u16>>`
  - `pub fn quantize_rms(v: f32) -> u16` / `pub fn dequantize_rms(v: u16) -> f32`
  - Version-free names (the version lives in the constant, not the function
    name): `write_peaks(path, channels, levels)` (was `write_v2_with_pps`),
    `read_header(path) -> Result<PeaksHeader>` (was `read_v2_header`/`V2Header`),
    `read_range(path, level_idx, channel, start_peak, count) -> Result<PeaksRange>`
    (was `read_v2_range`), where
    `pub struct PeaksRange { pub peaks_per_second: u32, pub min: Vec<i16>, pub max: Vec<i16>, pub rms: Vec<u16> }`.

- [ ] **Step 1: Write the failing tests** — update `v2_write_read_header_and_range`
  (rename `v3_...`) to build `LevelData` with `rmss`, write via `write_peaks`,
  and assert `read_range(...).rms` round-trips; extend
  `waveform_roundtrip_against_real_ffmpeg` with an RMS assertion: for the 1 kHz
  constant-amplitude sine fixture, finest-level RMS ≈ peak/√2 — assert
  `(rms / peak - 0.707).abs() < 0.05` using dequantized values; extend
  `decimate_halves_and_preserves_envelope` with an RMS case
  (`decimate_rms(&[quantize_rms(0.6), quantize_rms(0.8)])[0]` ≈
  `quantize_rms(0.707)` within ±2 quanta).
- [ ] **Step 2: `cargo test --lib --features jobs waveform`** — compile failure
  on the new fields/names is the expected RED for a format change.
- [ ] **Step 3: Implement.** Byte-offset multipliers `* 4` → `* 6` in
  `write_peaks` offset computation and `read_range`
  (`level_start`/`channel_start`/`seek_to`/buffer len); write order per window
  `[min, max, rms]`; bump the version constant; `compute_finest_level` gains a
  `cur_sq: Vec<f64>` accumulator and per-window
  `rms = sqrt(cur_sq[c] / frames_in_window as f64)` (partial trailing window
  divides by its actual frame count); `decimate_rms(rmss: &[u16]) -> Vec<u16>`
  implements the sqrt-mean-square pairing; `build_pyramid` decimates all three
  planes; `read_peaks_file` (frozen MCP shim — output contract must NOT change)
  destructures the new `PeaksRange` and keeps computing max-abs from min/max only.
  `cache/mod.rs`: `waveforms/{hash}.v2.peaks` → `waveforms/{hash}.v3.peaks`.
- [ ] **Step 4: `cargo test --lib --features jobs`** — full suite green
  (mechanical rename call sites in `commands/media.rs` are part of this task;
  `get_waveform_tile`/`get_waveform_levels` compile against the new names but
  their payloads change in Task A2).
- [ ] **Step 5: Commit** `feat(waveform): VPEAKS v3 — RMS plane alongside min/max`

### Task A2: RMS through the IPC tile surface

**Files:**
- Modify: `apps/desktop/native/src/commands/media.rs` (`WaveformTile` + `get_waveform_tile`)
- Modify: `apps/desktop/src/renderer/ipc/index.ts` (`WaveformTile` type)

**Interfaces:**
- Produces: Rust `WaveformTile { peaks_per_second, min: Vec<f32>, max: Vec<f32>, rms: Vec<f32> }`
  (rms dequantized 0..1); TS `WaveformTile { peaksPerSecond: number; min: number[]; max: number[]; rms: number[] }`.

- [ ] **Step 1:** Failing Rust assertion: extend the `v3` roundtrip test with a
  `get_waveform_tile`-level check if a Backend-less harness exists; otherwise
  the compile-level contract (struct field) + Task A3's TS test carries it.
- [ ] **Step 2:** Add `rms` to the Rust struct (dequantize via `dequantize_rms`)
  and the TS type. `get_waveform_levels` unchanged.
- [ ] **Step 3:** Gates: `cargo test --lib --features jobs`, `npx tsc -b`.
- [ ] **Step 4: Commit** `feat(waveform): expose rms in get_waveform_tile`

### Task A3: RMS + channel count through the producer

**Files:**
- Modify: `apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.ts`
- Test: `apps/desktop/src/renderer/timeline/tileEngine/WaveformTileProducer.test.ts`

**Interfaces:**
- Produces: `WaveformWindow` gains `rms: Float32Array`;
  `getWaveformChannelCount(mediaId: string): Promise<number>` (reads the cached
  levels promise — same `levelsCache`, so it shares the invalidation fix).

- [ ] **Step 1: Failing test** (mocked `../../ipc`, same style as the
  levels-cache invalidation test): drive `ensureWaveformWindow` to ready with
  mocked tiles carrying known `rms` arrays; assert the assembled window's `rms`
  slice equals the expected `[startPeak, endPeak)` values. Second test:
  `getWaveformChannelCount` returns `channels` from the levels response and is
  served from cache (one `getWaveformLevels` call for two invocations).
- [ ] **Step 2:** `npx vitest run src/renderer/timeline/tileEngine` — RED.
- [ ] **Step 3:** Implement: `TileValue`/`bytes` include rms; assembly copies
  rms like min/max; export the channel-count helper.
- [ ] **Step 4:** Vitest green; `npx tsc -b`.
- [ ] **Step 5: Commit** `feat(timeline): waveform window assembly carries rms + channel count`

### Task A4: Two-tone stereo render

**Files:**
- Modify: `apps/desktop/src/renderer/timeline/TimelineWaveform.tsx`
- Test: `apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx`

**Interfaces:**
- Produces (exported pure helpers, unit-testable without canvas):
  - `computeLanes(heightPx: number, channels: number): Array<{ channel: number | "merged"; midY: number; ampPx: number }>`
    — 2 lanes (L top / R bottom, midlines at h/4 and 3h/4, amp h/4−1) when
    `channels === 2 && heightPx >= STEREO_LANES_MIN_PX` (**28**), else 1 merged
    lane (midline h/2, amp h/2−1).
  - `mergeStereo(a: WaveformWindow, b: WaveformWindow): WaveformWindow` —
    per-peak `min(a.min,b.min)`, `max(a.max,b.max)`, `max(a.rms,b.rms)`.
- Render rules (in `drawTile`, per lane, per CSS px column):
  - envelope: fill `mid − hi·amp .. mid − lo·amp` at `rgba(255,255,255,0.42)`,
    bar height floor 1px (existing `Math.max(1, …)` behavior kept);
  - RMS core: fill `mid − rms·amp .. mid + rms·amp` at `rgba(255,255,255,0.88)`,
    floored to 1px whenever `rms > 0`;
  - placeholder (no window): unchanged center line.

- [ ] **Step 1: Failing tests** for `computeLanes` (28px threshold both sides,
  mono forces merged) and `mergeStereo` (element-wise expectations incl. rms max).
- [ ] **Step 2:** RED, then implement helpers + the two-pass column loop; fetch
  ch0 + ch1 windows when `getWaveformChannelCount(mediaId) === 2` (merged lane
  consumes `mergeStereo`; stereo lanes consume each window directly).
- [ ] **Step 3:** Green + `npx tsc -b`; hand-check in the real app (import a
  stereo music file; confirm L/R lanes at full row height, merged envelope on a
  half-height slice, RMS core visibly brighter).
- [ ] **Step 4: Commit** `feat(timeline): two-tone stereo RMS waveform render`

### Task A5: Stale-while-revalidate zoom + DPR-change redraw

**Files:**
- Modify: `apps/desktop/src/renderer/timeline/TimelineWaveform.tsx` (`useWindowData`)
- Test: `apps/desktop/src/renderer/timeline/TimelineWaveform.test.tsx`

Behavior (mirrors clipcombo's flicker-free rule, adapted to our hook):
- On dependency change (`pxPerSec`, src window), the previous ready window is
  KEPT and drawn stretched to the new geometry; state stays `"ready-stale"`
  internally but `data-state` continues to report `ready` (tests key off it).
- The re-fetch fires on a **120 ms** debounce (`WAVEFORM_REFETCH_DEBOUNCE_MS`);
  mount and `mediaId` changes fetch immediately. Engine `subscribe`
  notifications (tile arrivals, invalidation) also run immediately — only
  param-churn is debounced.
- The placeholder gradient renders only when there is no window at all.
- DPR: a `matchMedia(`(resolution: ${devicePixelRatio}dppx)`)` change listener
  bumps a redraw counter included in the draw effect deps (re-arm the listener
  after each change — the query string embeds the old DPR).

- [ ] **Step 1: Failing hook tests** (fake timers): (a) after a `pxPerSec` prop
  change the previously-ready window is still returned and exactly one
  `ensureWaveformWindow` call lands after 120 ms; (b) a `mediaId` change calls
  immediately.
- [ ] **Step 2:** RED → implement → GREEN; `npx tsc -b`; real-app hand-check:
  Ctrl-wheel zoom on a long audio clip never flashes the placeholder.
- [ ] **Step 3: Commit** `feat(timeline): waveform stale-while-revalidate zoom + DPR redraw`

### Task A6: Evergreen doc writeback

- [ ] Update `docs/timeline-content-preview.md` Audio section + Implementation
  Notes to describe the shipped reality after A1–A5 (tile engine, VPEAKS v3
  two-tone render, stereo lanes) — evergreen tone, no dates/versions-as-history.
- [ ] Commit `docs(timeline): refresh content-preview doc for the v3 waveform display`

**Out of scope for Plan A** (recorded, deliberate): gain/fade-modulated
amplitude (waveform showing "what will be heard" — needs Animated gain
evaluation in the render path; revisit after Plan B), live-trim src window
during drag (preview reads committed params today), sample-level finest LOD.

---

# Plan B — Filmstrip tile engine (design locked; expand into tasks at pickup)

Replaces the 10-poster stretched `<img>` filmstrip with real tiles on the
existing `TileEngine`. This section fixes the design so the implementation plan
can be written without re-research; verify the two **[verify]** items against
the code before task breakdown.

**Display design (adopted from clipcombo):**
- **Canonical decode height** `FILMSTRIP_TILE_HEIGHT_PX = 256`: tiles are
  decoded/cached at 256 px height regardless of lane height or zoom; lane
  rendering rescales. Lane height is never part of a cache key.
- **Temporal positioning:** a tile drawn at source time `t` sits at
  `x = (t − srcInUs) / (srcOutUs − srcInUs) × clipWidthPx`, drawn at natural
  aspect (width = laneHeight × aspect), clipped by the lane box. No equal-width
  flex, no `object-cover` stretch.
- **Flicker-free:** every render paints synchronously from ready `ImageBitmap`s;
  gaps keep the existing sprocket-texture placeholder; missing tiles are
  requested on a `FILMSTRIP_FETCH_DEBOUNCE_MS = 140` debounce; on LOD change,
  coarser ready tiles keep drawing until finer ones land (grid alignment makes
  the coarser twin of even indices exact: lod k index 2j ≙ lod k+1 index j).

**Data design (ours, not clipcombo's):**
- **Time-grid keying, not I-frame anchoring.** clipcombo anchors on I-frames
  because browser seek-to-arbitrary-time is expensive; native ffmpeg `-ss` on
  our dense-keyframe proxy is not. A power-of-two grid gives zoom-stable keys:
  `spacingUs(lod) = FILMSTRIP_BASE_SPACING_US << lod` with
  `FILMSTRIP_BASE_SPACING_US = 250_000`, `lod ∈ [0, 12]` (250 ms … 1024 s).
  Tile `index` samples the frame at `index × spacingUs(lod)` in SOURCE time.
  LOD selection: `desiredSpacingUs = thumbWidthPx / pxPerSec × 1e6` (thumbWidth
  = laneHeight × aspect, 16/9 fallback) → `lod = clamp(round(log2(desired / base)), 0, 12)`.
- **Rust command** `get_filmstrip_tile(item, lod, index) -> { path, widthPx, heightPx }`:
  extract-on-demand with skip-if-cached; disk cache
  `<cacheRoot>/filmstrip/{blake3}/{lod}/{index:06}.jpg` written temp→promote;
  ffmpeg `-ss {t} -i {src} -frames:v 1 -vf scale=-2:256 -q:v 5` with
  `no_console_window()`.
- **Proxy-wait rule** (design Q9 option (i), carried forward): decode source =
  the proxy when `decode_route` is Proxied; if the proxy file is not ready yet,
  return the `not_ready` sentinel — do NOT fall back to the original (heavy
  originals are exactly why proxies exist). Direct-route media extracts from
  the original. **[verify]** the exact `decode_route` shape for resolving the
  proxy path, and whether proxy completion emits `media:job_complete` and with
  which `kind` string (`jobs/mod.rs` lowercased `JobKind`).
- **TileEngine extension:** producers gain `invalidateOn?: string[]` — extra
  `media:job_complete` kinds that invalidate this producer's tiles. Filmstrip
  registers `invalidateOn: [<proxy job kind>]` so proxy completion flips
  `not_ready` tiles. (The waveform producer needs no entry.)
- **Producer:** kind `"filmstrip"`; `fetch` = `get_filmstrip_tile` →
  `fetch(convertFileSrc(path))` → `createImageBitmap`; value
  `{ bitmap: ImageBitmap, tUs: number }`; `bytes = bitmap.width × bitmap.height × 4`;
  `dispose = bitmap.close()`; producer-side in-flight cap
  `FILMSTRIP_MAX_CONCURRENT_FETCHES = 4` (one ffmpeg spawn per miss — do not
  stampede).
- **Removal:** `TimelineFilmstrip`'s manifest cache/listener machinery and the
  `get_media_thumbnails` command + TS wrapper are deleted (the 10-frame
  manifest has no consumer left). `jobs/thumbnails.rs` and
  `get_media_thumbnail` (base64 `004.jpg`) STAY — the media-pool poster uses
  them.
- Render architecture mirrors `TimelineWaveform`: 2048 px canvas segments,
  `content-visibility: auto`, DPR-scaled backing store, `IntersectionObserver`
  gating via the existing `usePreviewResourceGate`.

**Gates at pickup:** Rust grid/cache/command unit tests + real-ffmpeg extract
test; TS producer/layout pure-fn tests; component placeholder + temporal-layout
tests; real-app visual acceptance (trimmed short clip shows the correct frames
at correct positions, zoom-in densifies, no blanking while zooming).

---

# Plan C — Disk-cache LRU + zoom ceiling (carried forward, scope amended)

Unchanged from the original follow-up, plus one addition:

- Rust disk-cache byte budget + LRU eviction across
  `<cacheRoot>/{filmstrip,thumbnails,waveforms}` (filmstrip tiles become the
  growth source once Plan B ships).
- **Amended:** sweep orphaned `{hash}.v2.peaks` files left behind by the v3
  filename bump (Plan A).
- Raise `MAX_PX_PER_SEC` 800 → 2000 in `timeline/geometry.ts`. Note: at
  2000 px/s the desired waveform density (~1333 peaks/s) exceeds the stored
  finest level (1000/s) — the envelope stretches slightly instead of gaining
  detail. Accepted; sample-level rendering stays out of scope.

---

## Self-Review Notes

- **Spec coverage:** every display gap from the clipcombo comparison maps to a
  task: mono-only render → A3/A4; single-tone bars → A1–A4; zoom blanking → A5;
  DPR staleness → A5; 10-poster stretch/no temporal positioning/no zoom
  density/not-on-engine → Plan B; disk growth + v2 orphans → Plan C. The two
  already-fixed bugs (pinned levels cache, per-tile header re-read) are NOT
  re-listed — they shipped ahead of this plan.
- **Type consistency:** `PeaksRange`/`read_range`/`write_peaks` (A1) are the
  names A2 consumes; `WaveformWindow.rms` (A3) is what A4's `mergeStereo`
  consumes; `getWaveformChannelCount` (A3) is what A4's lane selection consumes.
- **Placeholders:** Plan B is intentionally a locked design, not an
  implementation plan — its two open items are marked **[verify]** and gate its
  task breakdown, nothing in Plan A depends on them.
