# Disk-Cache LRU + Cache Hygiene (Plan C) — Design

**Goal:** Bound the on-disk growth of cheap-to-regenerate media derivatives
(filmstrip tiles, thumbnails, waveform peaks), sweep stale artifacts left by
format bumps, make the filmstrip disk cache provenance-aware, isolate the
TileEngine memory budget per producer, and raise the timeline zoom ceiling.

This is Plan C of `docs/superpowers/plans/2026-07-02-timeline-display-upgrades.md`,
scope-settled 2026-07-02: the two Plan-B intake items (provenance-less disk
key, filmstrip domination of the shared engine budget) are IN scope alongside
the original three items.

## Scope

1. **Disk LRU** across `<cacheRoot>/{filmstrip,thumbnails,waveforms}` —
   2 GiB shared budget, mtime-as-LRU-clock, background debounced sweep.
2. **Hygiene rules** in the same sweep pass: orphaned `.peaks` versions,
   aged `.tmp` leftovers, pre-provenance filmstrip layout.
3. **Filmstrip provenance tag** in the disk key:
   `filmstrip/{hash}/{tag}/{lod}/{index:06}.jpg`, `tag ∈ {orig, quick, full}`.
4. **TileEngine per-producer budgets**: filmstrip 160 MB + waveform 32 MB
   (total unchanged at 192 MB).
5. **`MAX_PX_PER_SEC` 800 → 2000** in `timeline/geometry.ts`.

## Non-goals (recorded, deliberate)

- **No LRU over** `proxies/` (minutes-long transcode to regenerate),
  `audio/` conform PCM (playback-critical; eviction would stall the mixer),
  `voiceover/` + `transcribe-audio/` (eviction re-pays API cost),
  `frames/` (same growth shape as filmstrip but MCP-driven and currently
  small; revisit if agent-driven frame extraction becomes heavy),
  `inline-subs/` (reserved scaffolding, unused).
- **No settings surface** for the budget. Hardcoded constant; promote to
  `ProjectSettings` only when a real need appears.
- **No proxy-recipe version in the provenance tag** (q4→q5 bumps leave
  old-recipe pixels cached under `quick`): recipe bumps are rare and the
  delta is re-encode-grade; not worth leaking recipe numbers into tile keys.
- **No sidecar index** (JSON/SQLite). The filesystem is the database; see
  Decisions.
- **No sample-level waveform rendering.** At 2000 px/s the desired peak
  density (~1333/s) exceeds the stored finest level (1000/s); the envelope
  stretches slightly instead of gaining detail. Accepted.

## Section 1 — Disk LRU core (Rust)

New module `native/src/cache/disk_lru.rs`, owned by `CacheLayout` (a new
`Arc<SweepState>` field): every job already holds a `CacheLayout` clone, so
instrumentation needs no new plumbing.

**Constants:**

- `DISK_CACHE_BUDGET_BYTES = 2 GiB` — shared across the three dirs.
- Low-water mark 90%: when over budget, evict down to ~1.8 GiB so the next
  few writes don't immediately re-trigger.
- `TOUCH_THROTTLE = 1 h` — a cache hit only rewrites mtime when the current
  mtime is more than an hour old (relatime semantics; keeps the hot path to
  one `metadata()` call in the common case).
- Sweep debounce 60 s.

**Eviction units** (enumerate all units, sort by mtime ascending, delete
oldest-first until under the low-water mark):

- `waveforms/{hash}.v3.peaks` — per file.
- `filmstrip/{hash}/{tag}/{lod}/{index:06}.jpg` — per file (tiles regenerate
  independently); empty `{lod}`/`{tag}`/`{hash}` dirs are removed afterwards.
- `thumbnails/{hash}/` — the whole dir is ONE unit; its mtime is the max
  over contained files. The 10 posters are a set (~200 KB per media);
  partial eviction would leave the poster surface half-broken for no
  meaningful byte savings.

**Touch points** (reading a cache entry counts as "use"): a new helper
`cache::touch_if_stale(path)` called from

- `jobs/filmstrip.rs::extract_tile` — the disk-cache-hit branch;
- `commands/media.rs::get_waveform_tile` / `get_waveform_levels` — next to
  peaks-path resolution;
- the `get_media_thumbnail` poster read (touching `004.jpg` is enough — the
  dir unit keys on the max file mtime).

Files being written need no touch: they are born with a fresh mtime.

**Triggers:**

1. `CacheLayout::set_workspace` (project open/save-as) enqueues one full
   sweep — no debounce, runs promptly in the background.
2. `notify_write()` — called by the three writers (filmstrip tile promote,
   waveform `write_peaks`, thumbnails job completion). Debounces 60 s, then
   runs the sweep on `spawn_blocking` (the walk is sync `std::fs`; possibly
   ~100k files — keep it off the async workers). A scheduled sweep re-reads
   the CURRENT cache root when it runs; the workspace may have moved
   underneath it, in which case sweeping the new root is correct and the old
   root is abandoned wholesale anyway.

**Race posture (documented, not locked):** the sweep can delete a tile whose
path the renderer just received but has not fetched yet → `fetch()` 404s →
the TileEngine parks the slot as `error` → the existing 5 s cooldown retry
re-extracts. Worst case of a wrong eviction is one ~90 ms ffmpeg run; that
buys zero cross-process coordination. Fresh files sort newest and are only
reachable when everything older has already been evicted.

**Observability:** one info line per sweep that evicted anything
("disk cache: evicted N files / M MB in X ms"), via the existing logging
path (LogBus if already at hand in the call site, else `tracing::info!`).

## Section 2 — Hygiene rules (same directory walk)

- **Orphaned peaks versions:** any `waveforms/*.peaks` whose filename does
  not match the current `{hash}.v3.peaks` pattern is deleted unconditionally
  — current code cannot read it (single-version reader convention).
- **Aged `.tmp`:** any `*.tmp` under the three dirs with mtime older than
  1 h is deleted (interrupted-ffmpeg leftovers). The age floor protects
  in-flight temp writes; no tile/peaks/thumbnail job runs anywhere near an
  hour.
- **Pre-provenance filmstrip layout:** entries under `filmstrip/{hash}/`
  that are not one of the three tag dirs (i.e. the old `{hash}/{lod}/...`
  layout) are deleted. One-time migration in effect; the rule is harmless
  to keep.

Rationale for folding these into the LRU walk instead of separate boot
hooks: the traversal is the dominant cost; extra per-entry rules are free,
and all three rules key on filenames only — no file ever needs opening.

## Section 3 — Filmstrip provenance tag

**Disk key change:** `filmstrip/{hash}/{lod}/{index:06}.jpg` →
`filmstrip/{hash}/{tag}/{lod}/{index:06}.jpg` with `tag ∈ {orig, quick, full}`.

- `commands/media.rs::filmstrip_decode_source` returns `(PathBuf, SrcTag)`;
  `jobs/filmstrip.rs::extract_tile` takes the tag;
  `CacheLayout::filmstrip_tile` gains the tag segment. The renderer is
  untouched — the tile path is opaque to it.
- **What this fixes and what it doesn't:** quick-first resolution stays
  (the quick proxy's short scrub GOP makes fast `-ss` seeks land closer,
  and at 256 px decode height quick-vs-full is visually nil — quick IS a
  legitimate tile source while it exists). So quick pixels continuing to
  serve after the full proxy lands is BY DESIGN, not the defect. The tag
  fixes ROUTE-TRANSITION staleness: tiles extracted from the original while
  a media was `Bypass` no longer keep serving after the media is
  route-corrected to `Proxied` — the refetch misses (different tag) and
  re-extracts from the proxy. Side benefits: the disk state is
  self-describing, and tiles from a no-longer-preferred source become
  orphans that the LRU collects under pressure.

## Section 4 — TileEngine per-producer budgets (TS)

`TileProducer` gains optional `budgetBytes?: number`; `TileEngine` accounts
bytes per producer kind, and `evictToBudget` evicts oldest-touched READY
slots WITHIN the kind that is over ITS budget. Allocation: filmstrip 160 MB,
waveform 32 MB — total footprint unchanged at 192 MB.

Sizing: waveform tiles ~48 KB → ~680 tiles in 32 MB, far above what the
viewport-bounded fetch can request; filmstrip bitmaps ~466 KB → ~350 tiles
in 160 MB, ~3× headroom over the field-measured 117 visible slots. Effect:
filmstrip byte pressure can no longer evict waveform tiles (today's churn
source); each producer's eviction behavior is isolated and predictable.

## Section 5 — Zoom ceiling

`timeline/geometry.ts`: `MAX_PX_PER_SEC` 800 → 2000. Check for tests
pinning 800 during implementation. Waveform envelope stretch past
1000 peaks/s is accepted (see Non-goals).

## Section 6 — Testing & gates

- **Rust** (tempdir + `File::set_times` to forge mtimes): eviction order +
  low-water stop; thumbnails dir-unit accounting; `.tmp` age rule; orphaned
  peaks rule; pre-provenance layout rule; touch throttle; filmstrip tag in
  `cache/mod.rs`, `jobs/filmstrip.rs`, `commands/media.rs` existing tests.
- **TS:** per-kind budget eviction tests in the existing TileEngine test
  file; the debounce is tested at the "notifications coalesce" level if
  extracted as a pure decision function, not as end-to-end timing.
- **Gates (unchanged):** `cargo test --lib --features jobs` in
  `apps/desktop/native`; `npx tsc -b` + `npx vitest run` in `apps/desktop`.
- **Hand check:** with a test-constructed small budget, import media,
  confirm the sweep log line and that timeline tiles self-heal (re-extract)
  after eviction.

## Decisions

- **mtime-as-LRU-clock over FIFO and sidecar index.** FIFO punishes the
  most-used content (hot old tiles evict and re-extract repeatedly) to save
  only a dozen lines of touch logic. A sidecar index (JSON/SQLite) is a
  second source of truth that must survive crashes, manual cache deletion,
  and concurrent writers — over-engineering for a cache whose miss cost is
  one cheap ffmpeg run. The filesystem-as-database posture only works
  because wrong eviction has zero correctness cost; that same criterion is
  why `proxies/` and `voiceover/` are excluded.
- **Three dirs, not four+.** `frames/` shares the growth shape but not the
  current magnitude; per user decision it stays out until MCP-driven
  extraction gets heavy.
- **2 GiB hardcoded.** Generous for tens of media (a fully-swept 212 s
  clip's filmstrip is ~20–30 MB; waveforms ~43 MB/source-hour), still a
  real bound for marathon sessions. No settings UI (YAGNI).
- **Both Plan-B intake items in scope** (user decision 2026-07-02): the
  provenance tag synergizes with the LRU (stale-source tiles become
  collectable orphans), and the budget partition is a small TS change.
