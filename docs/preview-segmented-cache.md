# Preview segmented cache — design

**Status:** Designed 2026-05-15 via `/grill-me`. **Not yet implemented.** Phased plan at the bottom.

## Problem

Today's preview pipeline (per `preview/mod.rs` and workspace-redesign Phase D) is:

1. Every actor commit broadcasts.
2. `PreviewRenderer` debounces 1s, computes a single global `state_hash` over the whole lavfi graph + every media file's blake3 + canvas params.
3. If the hash changed, `export::run_render_silent` re-encodes the **entire timeline** end-to-end into one MP4 at `Cache/preview/<hash>.mp4`.
4. React `<PreviewSurface>` swaps `<video src>` on `preview:render_complete`.

The pathology: **the cache key is one bit, and the artifact is one file.** Trimming a 5-second clip in a 3-minute timeline invalidates the global hash and re-encodes 3 minutes of video. Editing latency scales with timeline duration, not with edit size.

## Architectural choice: A now, B.3 later

Three sub-architectures considered:

| | Effort | Trim-edit latency | Param-scrub latency | Cross-platform | Replaces preview path |
|---|---|---|---|---|---|
| **A** Segmented MP4 cache (this design) | 2–3 wk | 30–100× faster | per-segment encode | yes | additive |
| **B.1** libmpv lavfi real-time engine | 6–8 wk + risk | real-time | per-effect | tied to libmpv on each OS | yes, replaces |
| **B.3** WebCodecs + WebGL2 in-webview compositor | 4–5 wk | real-time | real-time on simple effects | weak on Linux WebKitGTK | yes, replaces |

**B.2** (custom native GL/WGPU) was rejected as out of scope (months of compositor work; no MCP-product payback).

**Decision: ship A first, layer B.3 on top later.** Reasons:

1. The user-visible pain is *granularity*, not the existence of pre-rendering. A solves the trim-edit case (~30–100× win) in 2–3 weeks; that wait is the dominant pain.
2. The rasterized-template path (`docs/rendering.md` Part 2) is unaffected by engine choice — templates pre-rasterize regardless. So B's real-time engine does NOT speed up the slow content; it only speeds up cuts and trims. A speeds those up too, just not to real-time.
3. A is the universal fallback. Even after B.3 ships, A's cached segments are what B.3 plays when the WebCodecs compositor can't keep up (heavy decoding, unsupported codecs, Linux WebKitGTK gaps). Pr / FCP / Resolve all do exactly this.
4. A is additive — if it fails, the old whole-timeline path still works. B.3 is replacement and harder to fall back from.

## Cross-platform constraints

Tauri 2's webview is NOT the same engine on every OS:

| Platform | WebView | Maintained by |
|---|---|---|
| Windows | WebView2 (Chromium evergreen) | Microsoft |
| macOS | WKWebView (Safari/WebKit) | Apple |
| Linux | WebKitGTK (WebKit fork) | GNOME |

Feature support matrix (as of early 2026):

| Feature | Win | Mac | Linux |
|---|---|---|---|
| WebGL2 | ✅ | ✅ | ✅ |
| WebGPU | ✅ | ✅ Safari 18+ | ⚠️ experimental |
| MSE | ✅ | ✅ | ✅ (H.264 needs GStreamer plugins) |
| WebCodecs VideoDecoder | ✅ stable, HW-accel | ✅ Safari 16.4+ | ⚠️ WebKitGTK 2.46+, partial, no consistent HW-accel |
| H.264 in `<video>` / MSE | ✅ | ✅ | ⚠️ needs `gstreamer1.0-libav` (absent on default Fedora) |

The asymmetry means:
- **A is universally implementable** — ffmpeg + MSE + `<video>` works on all three; only quirk is the H.264-on-Linux codec issue, addressed by emitting VP9 on Linux.
- **B.3 is Win/Mac-only initially.** Linux stays on A's segmented cache until WebKitGTK's WebCodecs matures (estimated 1–2 years).

---

# Option A — Segmented MP4 cache

## Segmentation strategy

**Hybrid: edit-bounded + max-length, transitions atomic.**

### Boundary kinds

| Source | Boundary type |
|---|---|
| Clip `in_us` / `out_us` on the timeline | Hard |
| Range-bounded effect `in_us` / `out_us` | Hard |
| Transition outer bounds | Hard, AND boundaries inside the transition window are dropped |
| Animated property keyframes | Soft — animation is interpolated inside a segment |
| Markers | Ignored — UI-only metadata |
| Canvas resolution / fps change | Invalidates everything |

Algorithm:

```
boundaries = {0, duration_us}
for clip in all_clips: boundaries += {clip.in, clip.out}
for effect in range_effects: boundaries += {effect.in, effect.out}
for tr in transitions:
    boundaries.drop_inside(tr.start, tr.end)
    boundaries += {tr.start, tr.end}
return sorted(boundaries)
```

The transition-collapse step is load-bearing: a crossfade spanning t=8.5..11 must NOT be split at t=10 (where the underlying clip ends), or the fade breaks. Drop interior boundaries; keep the outer pair.

### `MAX_SEGMENT_US = 5_000_000` (5 seconds)

After computing edit-bounded ranges, split any range longer than 5s at internal points. Rationale:

- 5s × HW-encoded 540p H.264 at ~10–20× realtime + ~400ms ffmpeg overhead ≈ 0.7–1s per segment. Sub-second feel.
- Transitions exceeding 5s win and are kept atomic (segment > MAX_SEGMENT_US permitted only for transitions). Default fade is 1s; long fades are rare; impact negligible.

This is configurable as a const (`preview::MAX_SEGMENT_US`) but NOT exposed to users.

## Audio: whole-timeline, not segmented

One AAC file per global hash at `Cache/preview/<global_hash>.audio.m4a`. AAC at 192kbps for 10 min ≈ 14 MB; encodes in 2–5s even on slow hardware. ffmpeg audio re-encode is cheap (~20–50× realtime).

Why not segment audio:
- `amix`, `aresample`, `volume` etc. carry filter state across frames; segmentation produces audible pops/glitches at boundaries without overlap-add crossfading.
- Crossfading audio at boundaries is its own non-trivial filter design.
- Whole-timeline encode is fast enough to be invisible at typical timeline lengths.

Edge case (50+ audio tracks with heavy effects): accept the cost in v1. Segment audio later if it actually becomes a problem.

## Codec branch per platform

| Platform | Container/codec | Reason |
|---|---|---|
| Windows | fMP4 / H.264 baseline-high profile (`avc1.640028`) + AAC | WebView2 + native ffmpeg HW encoders strong |
| macOS | fMP4 / H.264 (`avc1.640028`) + AAC | WKWebView has identical MSE+H.264 support |
| Linux | WebM / VP9 + Opus | WebKitGTK plays VP9 natively without GStreamer plugin install; H.264 is conditional on `gstreamer1.0-libav` (absent on default Fedora) |

Codec is selected at workspace-open time by a capability probe. The IR's emitter side cares only about the `ExportPreset` chosen; everything else is identical.

## Cache layout

```
<workspace>/Cache/preview/
  <global_hash>.manifest.json
  <global_hash>.init.mp4              # video init segment (codec params)
  <global_hash>.audio.m4a             # whole-timeline audio
  segments/
    <segment_hash>.m4s                # individual video segments (fMP4)
```

Segments dir is **flat across all manifests** — same content hash dedupes naturally across project states. Most edits touch one region; segments shared between manifests stay on disk and hit cache.

## Manifest schema

```jsonc
{
  "global_hash": "ab12...",
  "duration_us": 187_000_000,
  "canvas": { "width": 1920, "height": 1080, "fps_num": 30, "fps_den": 1 },
  "video": {
    "codec": "avc1.640028",
    "init_path": "ab12....init.mp4",
    "segments": [
      { "in_us": 0,         "out_us":  5_000_000, "hash": "11...", "status": "ready" },
      { "in_us": 5_000_000, "out_us":  9_000_000, "hash": "22...", "status": "pending" }
    ]
  },
  "audio": {
    "codec": "mp4a.40.2",
    "path": "ab12....audio.m4a",
    "status": "pending"
  }
}
```

Atomicity: `.tmp` + rename (same pattern as `cache::promote_temp`). The manifest is written **before** the segments exist; React reads it to know the timeline's expected layout and listens for per-segment status events.

## Diff algorithm (the load-bearing optimization)

```rust
fn diff_manifests(old: &Manifest, new: &Manifest) -> ManifestDiff {
    let old_by_hash: HashMap<&str, &Segment> =
        old.video.segments.iter().map(|s| (s.hash.as_str(), s)).collect();
    // Match segments by *content hash*, not by (in_us, out_us).
    // ...
}
```

**Segments dedup by content hash, not time range.** If a 2-second clip is inserted at t=5, every segment after t=5 shifts on the timeline, but their *content* is unchanged. Time-range matching would incorrectly invalidate everything after t=5; hash matching correctly says "0 new segments, just re-time the existing entries in the manifest."

This means `segment_hash` MUST NOT include the segment's absolute `in_us` / `out_us` in the timeline. It hashes only:
- The lavfi sub-graph that would render `[in_us, out_us]` translated to local-time `[0, dur]`.
- Every media file's blake3 referenced in that window.
- Canvas params.

A new IR pass `lower_range(project, target, in_us, out_us) → IRGraph` emits only the nodes touching the window. ~300–500 LoC including tests.

## Queue: parallelism, priority, cancellation

### Worker count

```rust
let concurrency = if using_hw_encoder {
    (num_cpus::get() / 2).min(HW_SESSION_CAP)   // HW_SESSION_CAP = 6
} else {
    num_cpus::get() / 2
};
```

`num_cpus / 2` because we want CPU headroom for the editor itself. `HW_SESSION_CAP = 6` because NVENC consumer cards cap at 8 sessions and contention beyond ~6 yields diminishing returns. AMD VCE and Intel QSV behave similarly.

Export queue (`export/queue.rs`) keeps `concurrency: 1` — opposite priority (user is waiting for foreground work but wants CPU left for editing during exports).

### Priority

Higher first:

1. Segment containing the current playhead
2. Segments inside the visible timeline region (scroll-left to scroll-right)
3. Segments adjacent to the playhead
4. Everything else, timeline order

Playhead position is already mirrored to Rust via `PreviewSurface.tsx`'s `seekTo` / `onTimeUpdate` flow. Visible-region needs a new event from the timeline panel to Rust (emit on scroll/zoom).

Priority is recomputed on every commit and on playhead/visible-region change. Already-running items don't re-order; only pending ones do.

### Cancellation

- **Obsolete pending** (hash not in new manifest): drop from queue immediately.
- **Obsolete running**: let it finish UNLESS the project state has advanced ≥ 2 commits beyond when the job was enqueued. The lazy default avoids the "user edits → sees progress → edits again → progress resets to 0" jitter that naive queues produce.
- **Disk full**: pauses the entire queue with a banner; resume on user action.

### Failure classification

```rust
enum SegmentFailureKind {
    Transient,                          // ffmpeg crashed, race, resource pressure
    HwEncoderRejected,                  // retry with SW preset
    SourceMissing { path: PathBuf },    // user has to relink media
    DiskFull,                           // pause queue, surface clearly
    Unrecoverable { detail: String },   // filter graph invalid, drawtext failure, etc.
}

fn classify(stderr: &str, exit_code: i32, dest_writable: bool) -> SegmentFailureKind
```

Classifier reads ffmpeg stderr (already captured in `export/mod.rs`). Auto-retry rules:
- `Transient` → retry once after 2s backoff. Classify the next error if it fails again.
- `HwEncoderRejected` → retry once with SW preset.
- Anything else → no auto-retry; surface immediately.

## MSE delivery (React side)

### Two SourceBuffers, not muxed

```
MediaSource
├── SourceBuffer(mime='video/mp4; codecs="avc1.640028"')   ← fMP4 segments
└── SourceBuffer(mime='audio/mp4; codecs="mp4a.40.2"')     ← one whole-timeline audio
```

Muxing audio into each video segment would force audio to re-encode per-segment, defeating the whole-timeline audio decision.

### Seek into not-yet-ready region

`<video>` stalls at the seek target showing "Rendering this range…" overlay (same component as today's `preview-rebuilding` indicator). The seek bumps that segment to the front of the priority queue. Worst-case wait: ~0.9s at 5s segment + HW encode.

Why not snap-to-nearest: confusing — playhead moves without user input.

### Manifest swap during playback

User edits while playing. New manifest lands; segment under the playhead has a new hash. Two stale-vs-fresh approaches:

- **Defer current-segment swap** (chosen): mark "currently playing" segment dirty; do the `remove` + `append` only when the playhead crosses out of it. The user briefly sees the old version of the segment they're already watching, then everything updates seamlessly when they pause or scrub.
- Immediate swap mid-decode causes MSE errors and visible glitches; rejected.
- Pause + replace + resume is jarring; rejected.

### Render-status bar (the "yellow/red bar" affordance)

Thin strip above the timeline, with one `<div>` per segment sized proportionally. Updates on every `segment_status_changed` event.

| Status | Visual |
|---|---|
| ready | faint white/transparent (everything's fine) |
| running | animated diagonal stripes, accent color |
| pending | solid accent, dimmer |
| failed | red |

Interactions:
- **Hover**: tooltip with status, range, error summary (if failed)
- **Left-click pending/running**: bump to top of priority queue
- **Left-click failed**: manual retry (re-enqueue, reset attempt counter)
- **Right-click**: context menu — Retry / Show error log / Skip this range / Reveal cache folder

### Failed-segment overlay in the preview

When the playhead enters a `failed` or `ignored` segment, the `<video>` cannot decode. The MSE driver pauses video and overlays:

- Previous segment's final frame, frozen
- Thin red strip across the top: "Preview unavailable for this range"
- Inline "Retry rendering" button — one-click retry from where the user is looking

Audio (whole-timeline) keeps playing. Crossing out of the failed segment un-pauses video and hides the overlay.

Seek directly into a failed segment uses the *next* segment's first frame instead (no "before" to draw from).

### Bulk actions in the status log

Per-failure entries surface in the existing `LogBus` console (`docs/status-log-system.md`) with:
- segment hash, range, classification, stderr snippet
- inline "Retry" button

Status log header gains "Retry all failed segments" — useful after a system-wide fix (user relinked media, freed disk space).

## Implementation details (no decision needed; recorded so they don't get re-litigated)

- **fMP4 mux flags**: `-movflags +frag_keyframe+empty_moov+default_base_moof+separate_moof`.
- **IDR at segment start**: `-force_key_frames "expr:eq(n,0)"` or `-g 1` for first frame.
- **Init segment extraction**: run ffmpeg with `-frames:v 0` + fMP4 mux flags once per global hash to produce the moov-only init segment.
- **Append serialization**: MSE forbids overlapping ops on a SourceBuffer; queue all `appendBuffer` / `remove` behind `updateend` events. Standard ~80 LoC helper.
- **Codec string exactness**: pinned to whatever `ExportPreset::PreviewSegment` emits. Mismatch silently rejects appends. Smoke-test early.
- **Init segment swap**: canvas-resolution change tears down `MediaSource`, rebuilds. Rare; detect via `canvas` field diff.
- **Pre-fetch**: prefetch next 1–2 segments ahead of playhead while playing to avoid MSE underrun.

---

# Option B.3 — WebCodecs real-time playback (later)

Layered on top of A, not replacing it. Enabled per-installation by a capability probe (see gating below).

## The stack

```
File (Cache/proxies/<hash>.mp4)
  ↓ fetch via convertFileSrc + Range
MP4Box.js demuxer → EncodedVideoChunk
  ↓
VideoDecoder (HW-accelerated) → VideoFrame
  ↓ ring buffer per active clip
At output frame time t:
  pick closest frame ≤ t per active clip
  ↓
WebGL2 compositor (fragment shader per layer):
  - bind clip frames as textures
  - bind raster template PNG-sequence frames as textures
  - apply transforms, opacity, blend modes
  ↓
<canvas> ← preview surface
```

Audio: WebAudio `AudioWorklet` mixer, or pragmatic shortcut — keep one whole-timeline AAC file (same as A) played in an off-screen `<audio>` synced to canvas clock via `AudioContext.currentTime` as master.

## Why B.3 not B.1 (libmpv) or B.2 (custom GL/WGPU)

1. **Rasterized templates already live in the webview's address space.** WebCodecs can use raster PNGs as WebGL textures directly. Libmpv has to round-trip via ffmpeg's `mf://`, which is the actual bottleneck in template-heavy content.
2. **No native FFI surface.** Avoids the libmpv close-path / HWND-embed / block_on-in-async bugs (`feedback_libmpv_close_path.md`, `feedback_libmpv_embed_hwnd.md`, `feedback_async_block_on_in_async.md`).
3. **Cross-platform falls out for free** on Win/Mac. Linux is the only weak spot — and A is the fallback there.
4. **Smaller new code surface.** B.3 emit target is a JSON composition recipe per frame (~400 LoC); libmpv variant would mean another lavfi flavor like `emit_mpv.rs` (767 LoC) with its own subtle differences.
5. **MCP agent inspection** — canvas is `readPixels()`-able. Future agent tools that ask "what does this frame look like?" become trivial.

## Capability gating

Four layers, in order of authority:

### 1. User preference

Settings entry persisted per workspace:
- **Auto (recommended)** — probe decides (default)
- **Real-time** — force B.3 on, bypassing pessimistic probe
- **Cached** — force A only, bug-report escape hatch

### 2. Startup capability probe (cached per session)

Runs on workspace open. Actually decodes a probe clip and composites it; pure `isConfigSupported` is insufficient because WebKitGTK can return `supported: true` for codecs the decoder then stalls on.

```ts
async function probeWebCodecsCapability(): Promise<CapabilityReport> {
  const cfg = { codec: "avc1.640028", codedWidth: 960, codedHeight: 540 };
  const sup = await VideoDecoder.isConfigSupported(cfg);
  if (!sup.supported) return { ok: false, reason: "isConfigSupported=false" };

  // Real decode of a tiny ~30KB H.264 test clip bundled in app resources.
  // Decode 1 keyframe + 1 delta, time it, fail if > 500ms (SW-only path).
  // Composite the resulting VideoFrame to OffscreenCanvas (WebGL2 sanity check).
}
```

Catches: API absent, codec rejected, decoder broken, SW-only too slow, WebGL2 missing.

### 3. Per-clip codec check

Even after probe succeeds, a user can import a clip with a codec the WebCodecs decoder doesn't handle (exotic HEVC profile, AV1 on a non-AV1 WebView). `VideoDecoder.isConfigSupported(clip_codec_string)` is called every time a clip enters the active timeline region. **A clip failing this check falls through to A's segmented cache for that clip only — other clips still play through B.3.** Per-clip fallback, not per-session.

### 4. Mid-session error fallback

Decoder errors mid-decode, or frames stall > 2s: degrade affected clip to segmented cache, log via LogBus, keep editor running.

### Why not just a platform check or build flag

- **Platform check** lies (stale WebView2 on Windows, macOS 12 without WebCodecs, distro variations on Linux).
- **Build flag** can't catch the "Win user with broken WebView2" case and makes B.3 untestable on Linux during dev.

Build keeps all the B.3 code in every platform's binary; runtime decides whether to use it.

---

# Phased implementation plan

Each phase independently shippable. A1–A3 are pure backend; A4–A5 are pure frontend; A6 is cross-platform validation. B.3 is its own milestone.

| Phase | Scope | Touches |
|---|---|---|
| **A1** IR foundations | `lower_range`, `segment_hash`, boundary computation, transition-collapse algorithm | Pure Rust, unit tests. No UI changes. |
| **A2** Manifest + per-segment encoder | Manifest schema, diff algorithm, per-segment ffmpeg invocations with fMP4 mux flags. Replaces `preview::render` behind a feature flag; old whole-timeline path remains for one release. | Tauri events: `preview:manifest_changed`, `preview:segment_ready`, `preview:segment_error`. |
| **A3** Queue + parallelism + failure | Priority queue with `min(num_cpus/2, HW_SESSION_CAP)` workers. Cancellation rules. Failure classification + auto-retry. | Extends `export/queue.rs`. |
| **A4** MSE driver | `<video src=blob:mediasource>` + SourceBuffer management + deferred current-segment swap + seek-into-pending stall+overlay. | Replaces today's `<video src=file>` flow in `PreviewSurface.tsx`. |
| **A5** Status bar + failure UX | Render-status bar above timeline, hover/click/context-menu, failed-segment preview overlay, status log integration, bulk retry. | New `preview/StatusBar.tsx`, hooks into `LogBus`. |
| **A6** Linux VP9 branch + cross-platform | VP9/WebM codec branch on Linux via capability probe at workspace open. Smoke tests on Win/Mac/Linux. Remove old whole-timeline preview path. | `ExportPreset::PreviewSegment` gains Linux variant. |
| **B.3** WebCodecs real-time playback | New IR emit target (`emit_webcodecs.rs` ~400 LoC). Decoder pool + WebGL2 compositor in TS. Audio sync. Capability gating layer (probe + per-clip + preference + mid-session fallback). | New `preview/webcodecs/` TS module. A6's MSE path remains the fallback. |

Suggested commit cadence: one PR per phase, each ~2–5 days. Feature-flag A1–A5 behind `WEFTCUT_PREVIEW_SEGMENTED=1` so they can land incrementally without disturbing users; flip on by default once A6 closes.

## Decisions log

| # | Decision | Value |
|---|---|---|
| 1 | Architecture choice | A first (segmented MP4), B.3 later (WebCodecs real-time) — not B.1 (libmpv) |
| 2 | Segmentation strategy | Edit-bounded + max-length hybrid; transitions atomic |
| 3 | MAX_SEGMENT_US | 5 seconds |
| 4 | Audio | Whole-timeline single AAC file per global hash |
| 5 | Codec branch | H.264 fMP4 (Win/Mac); VP9 WebM (Linux) selected at workspace open |
| 6 | Cache layout | `<workspace>/Cache/preview/`; segments dir flat across manifests for dedup |
| 7 | Manifest | JSON, `.tmp` + rename, references segments by content hash |
| 8 | Segment hash inputs | Local-time lavfi sub-graph + referenced media blake3 + canvas params — NOT absolute position |
| 9 | Diff algorithm | Match by segment hash, not by time range |
| 10 | Queue concurrency (preview) | `min(num_cpus/2, HW_SESSION_CAP)`; HW_SESSION_CAP = 6 |
| 11 | Queue concurrency (export) | 1 (unchanged) |
| 12 | Priority | playhead > visible region > playhead-adjacent > timeline order |
| 13 | Cancellation | Let running jobs finish unless ≥ 2 commits stale |
| 14 | Failure classes | Transient / HwEncoderRejected / SourceMissing / DiskFull / Unrecoverable |
| 15 | Auto-retry | Once for Transient (after 2s) and HwEncoderRejected (with SW preset) |
| 16 | MSE layout | Two SourceBuffers (video + audio), not muxed |
| 17 | Seek into pending | Stall + overlay + priority bump (no snap-to-nearest) |
| 18 | Manifest swap during playback | Defer current-segment swap until playhead crosses out |
| 19 | Failed-segment playback | Previous frozen frame + thin red strip + inline retry button |
| 20 | Status bar UI | Per-segment colored strip above timeline; hover/click/right-click interactive |
| 21 | B.3 gating | User preference + startup probe + per-clip check + mid-session fallback. NO build-time fragmentation. |
| 22 | B.3 platform support | Win/Mac at launch; Linux stays on A until WebKitGTK matures |

## See also

- `docs/rendering.md` — IR + ffmpeg emitter + rasterizer (Part 2 explains why templates pre-rasterize regardless of engine)
- `docs/workspace-redesign.md` — `<workspace>/Cache/` layout and the DOM-`<video>` preview transition (Phase D)
- `docs/status-log-system.md` — `LogBus` and console used for per-segment failure entries
- `apps/desktop/src-tauri/src/preview/mod.rs` — current whole-timeline implementation (to be replaced)
- `apps/desktop/src-tauri/src/cache/mod.rs` — cache layout helpers; gains `preview_segments_dir()` + `preview_manifest()` in A2
- `apps/desktop/src-tauri/src/export/queue.rs` — existing FIFO queue; gains parallelism + priority in A3
- `apps/desktop/src/preview/PreviewSurface.tsx` — current `<video src=file>` consumer; becomes MSE driver in A4
