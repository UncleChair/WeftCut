# preview-sw Phase 2 · Plan A — decode wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend native software-decode preview from ProRes-only to the full WebCodecs-blind family (DNxHD/DNxHR, MPEG-2, VC-1/WMV3), make software decode multithreaded, make seek correct for long-GOP sources, and confirm the frame-drop floor — all Rust-side, no new UX.

**Architecture:** The routing, transport (`DecodeRoute::NativeSw` → `SwSourceHandle` → `FrameRing`), and color model are already codec-agnostic (ADR 0029, Phase 1). Plan A widens one routing gate, adds decoder threading, replaces the intra-only seek burst with a unified "decode-forward-to-target" that is correct for every family, and locks the already-present compositor hold-last behavior with a test. The playback-resolution throttle + its UI are deliberately **out of scope** (that is Plan B).

**Tech Stack:** Rust (ffmpeg-next 8.1 behind the `preview-sw` Cargo feature), napi-rs addon, TypeScript renderer, Playwright `_electron` e2e, ffmpeg/ffprobe CLI for fixtures.

**Design of record:** `docs/superpowers/specs/2026-07-05-ffmpeg-sw-decode-blindspot-design.md` §4 (degrade stack) + §11.2 (Phase 2). This plan implements the codec-family + threading + long-GOP-seek + frame-drop-floor subset of Phase 2 only.

## Global Constraints

- **Node:** fnm-managed **v22.20.0** is the active default (`~\.claude\CLAUDE.md`). Do not switch versions.
- **Rust tests run with the feature union:** from `apps/desktop/native`, `cargo test --features jobs,export,mcp,cloud,preview-sw`. `jobs` is an effective baseline; omitting any of these fails to compile the crate's test build. `preview-sw` is required for this plan's modules.
- **napi build (only needed before the e2e tasks 4–5), one union flag:** from `apps/desktop/native`, `npx napi build --platform --release --features jobs,export,mcp,cloud,preview-sw` (ONE `--features` flag, not doubled). **Close the running app first** — it holds a lock on `index.*.node` (`reference_napi_build_lock_and_skew`). `index.*.node` + `index.d.ts` are gitignored. `preview-sw` stays **OUT** of the electron-ci feature union (`jobs,export,mcp,cloud` only) — it is a local-only path.
- **ffmpeg build env (PowerShell), set inline before any `cargo`/`napi` invocation:**
  ```powershell
  $env:FFMPEG_DIR="<Gyan.FFmpeg.Shared install>\ffmpeg-8.1.1-full_build-shared"  # exact path per memory reference_ffmpeg_next_windows_setup / the Phase-2 handoff line 50
  $env:LIBCLANG_PATH="C:\Program Files\LLVM\bin"
  $env:PATH="$env:FFMPEG_DIR\bin;$env:PATH"
  ```
  Confirm `FFMPEG_DIR` resolves to a directory containing `bin\avcodec-*.dll` before building.
- **ffmpeg/ffprobe on PATH for fixtures:** `npm run fetch-ffmpeg` from `apps/desktop` if not already present.
- **Single color model — do not regress:** `SwSourceHandle` derives `VideoColorSpace` from the MAPPED `sourceColor` (`ffprobeColorToWebCodecs`), never raw ffmpeg `.name()` strings. Plan A does not touch color; leave that path alone.
- **Compositor never auto-swaps a software clip to a proxy** (`ActiveClip.isSoftware` guard, `feedback_native_nle_conventions`). Plan A does not change routing after commit.
- **Parallel-sessions git discipline:** the user may edit this checkout concurrently. Stage by explicit path, re-check `git status` before each commit, and never `git add -A`.

---

### Task 1: Widen the preview route to the whole WebCodecs-blind family

**Files:**
- Modify: `apps/desktop/native/src/jobs/proxy_decision.rs` (add `codec_is_blindspot`, change the `decide()` gate at :92–101, fix the `non_family_codec_proxies_both` guard test, add per-family tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `pub fn codec_is_blindspot(codec: &str) -> bool` — true for `prores | dnxhd | mpeg2video | vc1 | wmv3`. `decide()` routes any such source to `preview = NativeFfmpeg, export = FullProxy` (export stays proxied; native export is Phase 3).

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/native/src/jobs/proxy_decision.rs`, inside `mod tests`, add per-family coverage and RE-POINT the existing `non_family_codec_proxies_both` guard (it currently uses `mpeg2video`, which this task promotes into the family). Replace that test and add the new ones:

```rust
    #[test]
    fn non_family_codec_proxies_both() {
        // A truly unhandled blind-spot codec — WebCodecs-blind on every machine
        // AND not in the native-sw family — still full-proxies on both axes.
        // (mpeg2video moved INTO the family in Phase 2; qtrle guards the fallback.)
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "qtrle".into();
        });
        assert_eq!(decide(&item, Some(0.2)), BOTH_PROXY);
    }

    #[test]
    fn blindspot_family_routes_preview_to_native_ffmpeg() {
        // Every WebCodecs-blind family previews natively (no proxy for preview),
        // export still proxies in Phase 2 (native export is Phase 3).
        for codec in ["prores", "dnxhd", "mpeg2video", "vc1", "wmv3"] {
            let item = video(|m| {
                m.metadata.video.as_mut().unwrap().codec = codec.into();
            });
            let r = decide(&item, Some(0.0));
            assert_eq!(r.preview, PreviewSource::NativeFfmpeg, "preview for {codec}");
            assert_eq!(r.export, ExportSource::FullProxy, "export for {codec}");
        }
    }

    #[test]
    fn codec_is_blindspot_matches_family_case_insensitively() {
        for c in ["ProRes", "DNxHD", "MPEG2VIDEO", "VC1", "WMV3"] {
            assert!(codec_is_blindspot(c), "{c} should be blindspot");
        }
        for c in ["h264", "av1", "hevc", "vp9", "qtrle"] {
            assert!(!codec_is_blindspot(c), "{c} should NOT be blindspot");
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
cd apps/desktop/native
cargo test --features jobs,export,mcp,cloud,preview-sw proxy_decision 2>&1 | Select-String -Pattern "test result|FAILED|error\["
```
Expected: FAIL — `codec_is_blindspot` does not exist (compile error), and `blindspot_family_routes_preview_to_native_ffmpeg` would fail for dnxhd/mpeg2video/vc1/wmv3.

- [ ] **Step 3: Add `codec_is_blindspot` and switch the `decide()` gate**

In `proxy_decision.rs`, add the family predicate immediately after `codec_is_prores` (around :233):

```rust
/// The WebCodecs-blind codec families a native ffmpeg SW decoder previews
/// directly (no proxy for preview). ProRes / DNxHD / DNxHR (ffprobe reports both
/// DNxHD and DNxHR as `dnxhd`) are intra-only; MPEG-2 / VC-1 / WMV3 (VC-1
/// Simple/Main) are long-GOP — the session's decode-forward-to-target seek
/// handles those. Export still proxies until the native-export phase (see
/// `decide`). VC-1/WMV3 have no ffmpeg *encoder*, so they are covered by this
/// routing gate + the codec-agnostic decoder, not a synthetic conformance
/// fixture (see the Phase-2 Plan A plan, Task 4).
pub fn codec_is_blindspot(codec: &str) -> bool {
    let c = codec.to_ascii_lowercase();
    codec_is_prores(&c) || matches!(c.as_str(), "dnxhd" | "mpeg2video" | "vc1" | "wmv3")
}
```

Then change the gate in `decide()` (currently :92–98) from `codec_is_prores` to `codec_is_blindspot`, and update the module-local comment above it (:87–91) to say "blind-spot family" instead of "ProRes":

```rust
    // WebCodecs-blind families (ProRes/DNxHD/MPEG-2/VC-1/WMV3) are never
    // `export_decodable_statically` nor `source_is_safe_to_bypass`, so the two
    // branches above always land them on `BOTH_PROXY`. A native ffmpeg SW decoder
    // previews them directly, so override the preview axis here. Export stays on
    // `FullProxy` until the native-export phase teaches export the same path.
    if media
        .metadata
        .video
        .as_ref()
        .map(|v| codec_is_blindspot(&v.codec))
        .unwrap_or(false)
    {
        route.preview = PreviewSource::NativeFfmpeg;
        route.export = ExportSource::FullProxy;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
cargo test --features jobs,export,mcp,cloud,preview-sw proxy_decision 2>&1 | Select-String -Pattern "test result|FAILED"
```
Expected: PASS — `test result: ok.` with all `proxy_decision` tests green (existing ProRes tests still pass; `prores_original_routes_preview_to_native_ffmpeg` is unaffected).

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop/native/src/jobs/proxy_decision.rs
git commit -m @'
feat(preview-sw): route the whole WebCodecs-blind family to native SW preview

Widen the native-SW preview gate from ProRes-only to codec_is_blindspot
(prores/dnxhd/mpeg2video/vc1/wmv3). Export still proxies (Phase 3 = native
export). Re-point the non_family guard test at qtrle.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 2: Multithreaded software decode

**Files:**
- Modify: `apps/desktop/native/src/preview_sw/decoder.rs` (add `decode_thread_count()` + thread flags in `open()`, expose `thread_count` on `SwVideoStream`, add tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SwVideoStream` gains `pub thread_count: i32` (the count libavcodec settled on after open). No API change to `next_frame`/`seek`. Decode output is byte-unchanged; only speed differs.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/native/src/preview_sw/decoder.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn decode_thread_count_is_positive_and_capped() {
        let n = super::decode_thread_count();
        assert!((1..=16).contains(&n), "thread count {n} out of [1,16]");
    }

    #[test]
    fn threaded_decode_still_yields_correct_first_frame() {
        // Threading must not change decode output: identical assertions to the
        // single-threaded decode test, plus the effective thread_count is set.
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_prores.mov");
        let mut s = SwVideoStream::open(p).expect("open");
        assert!(s.thread_count >= 1, "thread_count not set (got {})", s.thread_count);
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
        assert_eq!(f.nv12.len(), (320 * 240) + (320 * 240 / 2));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
cd apps/desktop/native
cargo test --features jobs,export,mcp,cloud,preview-sw preview_sw::decoder 2>&1 | Select-String -Pattern "test result|FAILED|error\["
```
Expected: FAIL — `decode_thread_count` does not exist and `SwVideoStream` has no `thread_count` field (compile errors).

- [ ] **Step 3: Add the thread-count helper and flags**

In `decoder.rs`, after the `use` block (around :18), add the flag constants and helper:

```rust
// FF_THREAD_FRAME (1) / FF_THREAD_SLICE (2) from libavcodec/avcodec.h. Literals,
// not ffs:: symbols: ffmpeg-sys-next does not re-export these #define flags
// uniformly across versions, and the values are ABI-stable across ffmpeg majors.
const FF_THREAD_FRAME: i32 = 1;
const FF_THREAD_SLICE: i32 = 2;

/// Threads to request for software decode: one per logical core, clamped to
/// [1, 16]. Parallel decode is the biggest lever for 4K SW throughput; libavcodec
/// sees diminishing returns past ~16 threads and each costs frame-buffer memory.
fn decode_thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .clamp(1, 16) as i32
}
```

- [ ] **Step 4: Set the flags before open and record the effective count**

In `SwVideoStream::open`, change the codec-context construction (currently :116–119) to set threading on the raw `AVCodecContext` **before** it is opened (mirroring `preview_gpu`'s raw-pointer pattern), then read back the settled count:

```rust
        let mut codec_ctx =
            ffmpeg_next::codec::context::Context::from_parameters(stream.parameters())
                .map_err(map)?;
        // Parallel decode: set on the raw context BEFORE avcodec_open2 reads it.
        // FRAME|SLICE lets libavcodec pick whichever the codec supports — slice
        // for intra ProRes/DNxHD (no output-latency, keeps scrub snappy), frame
        // for long-GOP MPEG-2/VC-1 throughput. Threaded decode is byte-identical
        // to single-thread; only speed changes. (Threading strategy: FRAME|SLICE
        // + a decode-bench seek-latency guard — Plan A design.)
        let requested_threads = decode_thread_count();
        unsafe {
            let raw = codec_ctx.as_mut_ptr();
            (*raw).thread_count = requested_threads;
            (*raw).thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
        }
        let mut decoder = codec_ctx.decoder().video().map_err(map)?;
        // Count libavcodec actually settled on (clamped to 1 for a codec without
        // threading support). Read via the raw context (as_mut_ptr is already used
        // by `seek`).
        let thread_count = unsafe { (*decoder.as_mut_ptr()).thread_count };
        let width = decoder.width();
        let height = decoder.height();
```

Add the field to the `SwVideoStream` struct (after `pub color: SwColorTags,` at :70):

```rust
    /// Threads libavcodec settled on after open (1 if the codec can't thread).
    pub thread_count: i32,
```

And set it in the `Ok(SwVideoStream { ... })` construction (after `color,` at :147):

```rust
            color,
            thread_count,
```

- [ ] **Step 5: Run the tests to verify they pass**

```powershell
cargo test --features jobs,export,mcp,cloud,preview-sw preview_sw::decoder 2>&1 | Select-String -Pattern "test result|FAILED"
```
Expected: PASS — both new tests plus the existing `decodes_first_prores_frame_to_nv12` (which now also exercises threaded decode) are green.

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop/native/src/preview_sw/decoder.rs
git commit -m @'
feat(preview-sw): multithreaded software decode (thread_count=cores, FRAME|SLICE)

Set thread_count/thread_type on the raw AVCodecContext before open — the biggest
4K SW-decode lever. Output is byte-identical; only speed changes. Effective count
read back onto SwVideoStream.thread_count. Seek-latency validated in Task 5.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 3: Unified decode-forward-to-target seek (long-GOP correctness)

**Files:**
- Create: `apps/desktop/native/tests/fixtures/tiny_mpeg2.mpg` (tiny long-GOP fixture, committed like `tiny_prores.mov`)
- Modify: `apps/desktop/native/src/preview_sw/session.rs` (rewrite `serve_request` = robust seek + decode-forward-to-target; add seek-retry consts; update the `LOOKAHEAD_FRAMES` doc; add a long-GOP session test)

**Interfaces:**
- Consumes: `SwVideoStream::next_frame() -> Result<Option<SwFrame>, String>` (each `SwFrame` carries `pts_us` + `dur_us`), `seek(target_us)` — **both unchanged** (`decoder.rs` is NOT touched; the seek-robustness is a wrapper in `serve_request`).
- Produces: `serve_request` now (a) re-seeks backward with a growing margin until it lands on a keyframe at/before `target_us` — needed because ffmpeg's BACKWARD seek overshoots on index-less MPEG-PS/TS — then (b) delivers the frame that **covers** `target_us` first, then a `LOOKAHEAD_FRAMES` forward burst. Correct for intra and long-GOP. No signature change.

- [ ] **Step 1: Generate the long-GOP fixture**

From the repo root, with ffmpeg on PATH (`npm run fetch-ffmpeg` from `apps/desktop` if needed):

```powershell
ffmpeg -y -f lavfi -i "testsrc2=size=320x240:rate=30" -t 2 `
  -c:v mpeg2video -g 15 -bf 2 -b:v 2M -pix_fmt yuv420p -an `
  apps/desktop/native/tests/fixtures/tiny_mpeg2.mpg
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 apps/desktop/native/tests/fixtures/tiny_mpeg2.mpg
```
Expected ffprobe output: `mpeg2video,320,240`. GOP 15 @30 fps = keyframes at frames 0/15/30/45; 60 frames total (2 s). This is the long-GOP vehicle for the seek test.

- [ ] **Step 2: Write the failing test**

In `apps/desktop/native/src/preview_sw/session.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn long_gop_request_forward_decodes_to_target() {
        // MPEG-2 is long-GOP (GOP 15 here): AVSEEK_FLAG_BACKWARD lands on a
        // keyframe well before the target, so serve_request must decode-forward to
        // the frame COVERING the target. Without that it would deliver the
        // keyframe at ~0.5 s.
        let got: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke {
                g2.lock().unwrap().push(frame.pts_us);
            }
        }));
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_mpeg2.mpg");
        reg.open("m1".into(), p.into()).expect("open");
        let _ = reg.request_frame_at("m1".into(), 800_000); // ~frame 24, mid-GOP
        std::thread::sleep(std::time::Duration::from_millis(500));
        let _ = reg.close("m1".into());
        let pts = got.lock().unwrap();
        assert!(!pts.is_empty(), "expected at least one frame poke");
        // FIRST delivered frame covers target 800_000, NOT the keyframe at ~500_000.
        assert!(
            pts[0] >= 700_000,
            "first delivered pts {} should cover target 800_000, not the keyframe (~500_000)",
            pts[0]
        );
        assert!(pts[0] <= 900_000, "first delivered pts {} overshot the target", pts[0]);
    }
```

- [ ] **Step 3: Run the test to verify it fails**

```powershell
cd apps/desktop/native
cargo test --features jobs,export,mcp,cloud,preview-sw preview_sw::session::tests::long_gop 2>&1 | Select-String -Pattern "test result|FAILED|panicked"
```
Expected: FAIL. Two possible signatures, both a fail: (a) if seek lands at/before target, the current burst emits the keyframe first (`pts[0]` ≈ 500_000 < 700_000); (b) on this MPEG-PS fixture ffmpeg's BACKWARD seek actually **overshoots forward**, so the current code emits `pts[0]` = 1_000_000 (> 900_000). Either way the test fails — the robust rewrite in Step 4 handles both.

- [ ] **Step 4: Rewrite `serve_request` with robust seek + decode-forward-to-target**

> **Amended after the Task-3 seek-overshoot finding.** ffmpeg's `av_seek_frame(..., BACKWARD)` is only approximate on index-less containers (MPEG-PS/TS): it estimates a byte offset and can **overshoot**, landing a keyframe AFTER the target (confirmed on `tiny_mpeg2.mpg`: seek to 800_000 µs lands on 1_000_000). A forward-only discard can't recover from that. So `serve_request` first probes the landed frame and re-seeks earlier with a growing margin until it lands at/before the target, then forward-decodes to the covering frame. `decoder.rs::seek()` is **unchanged** — this robustness is a wrapper in the session.

First add these consts next to `LOOKAHEAD_FRAMES` near the top of `session.rs`:

```rust
/// Largest number of backward re-seek attempts when a container's seek overshoots
/// the target. Index-less MPEG-PS/TS estimate the seek byte-offset and can land
/// AFTER the requested time; each retry steps the target back by a growing margin.
/// The final fallback (seek target 0) decodes from the start — always correct.
const MAX_SEEK_RETRIES: u32 = 6;
/// Initial backward step when re-seeking after an overshoot; doubles each retry.
/// ~1 s clears a typical (≤1 s) GOP overshoot in a single retry.
const SEEK_RETRY_MARGIN_US: i64 = 1_000_000;
```

Then replace the ENTIRE body of `serve_request` (the seek call at :110–119 AND the burst loop at :120–149) with:

```rust
    // --- Robust seek: land on a keyframe AT/BEFORE the target ---
    // ffmpeg's BACKWARD seek is only approximate on index-less containers
    // (MPEG-PS/TS): it estimates a byte offset and can overshoot, landing AFTER
    // the target. Probe the first decoded frame; if it's past the target, re-seek
    // earlier with a growing margin until it lands at/before (or we reach the file
    // start, always a valid at-or-before landing). Indexed containers (MOV/MP4)
    // land correctly on the first try — zero retries.
    let mut seek_target = target_us;
    let mut margin = SEEK_RETRY_MARGIN_US;
    let mut attempt = 0u32;
    let first_frame: SwFrame = loop {
        if let Err(e) = stream.seek(seek_target) {
            emit(
                sink,
                SwFramePoke::Error {
                    stream_id: stream_id.to_string(),
                    message: format!("seek to {seek_target}us failed: {e}"),
                },
            );
            return;
        }
        match stream.next_frame() {
            Ok(Some(f)) => {
                if f.pts_us > target_us && seek_target > 0 && attempt < MAX_SEEK_RETRIES {
                    // Overshoot — step the seek target back and retry.
                    seek_target = (target_us - margin).max(0);
                    margin = margin.saturating_mul(2);
                    attempt += 1;
                    continue;
                }
                break f; // landed at/before target (or can't/needn't retry further)
            }
            Ok(None) => {
                emit(sink, SwFramePoke::Eof { stream_id: stream_id.to_string() });
                return;
            }
            Err(e) => {
                emit(sink, SwFramePoke::Error { stream_id: stream_id.to_string(), message: e });
                return;
            }
        }
    };

    // --- Forward-decode from the landing to the frame covering target_us, then
    // emit the covering frame + a small forward lookahead. For intra families the
    // landing IS the covering frame (zero discards). The probed `first_frame` is
    // the first candidate, so it is never lost. ---
    let mut emitted = 0usize;
    let mut reached = false;
    let mut pending: Option<SwFrame> = Some(first_frame);
    loop {
        let frame = match pending.take() {
            Some(f) => f,
            None => match stream.next_frame() {
                Ok(Some(f)) => f,
                Ok(None) => {
                    emit(sink, SwFramePoke::Eof { stream_id: stream_id.to_string() });
                    break;
                }
                Err(e) => {
                    emit(sink, SwFramePoke::Error { stream_id: stream_id.to_string(), message: e });
                    break;
                }
            },
        };
        if !reached {
            // A frame whose interval ends at/before the target is in the past.
            // `.max(1)` guards a 0/unknown duration so the covering frame
            // (pts ≈ target) is never skipped.
            if frame.pts_us + frame.dur_us.max(1) <= target_us {
                continue;
            }
            reached = true;
        }
        emit(
            sink,
            SwFramePoke::Frame {
                stream_id: stream_id.to_string(),
                frame,
            },
        );
        emitted += 1;
        if emitted >= LOOKAHEAD_FRAMES {
            break;
        }
    }
```

Update the `LOOKAHEAD_FRAMES` doc comment (currently :37–43) to reflect the new meaning:

```rust
/// How many frames a single `request_frame_at` emits, starting at the frame that
/// covers the seek target. A "handful" pre-buffers a little playback smoothness
/// without decode-and-discarding a long tail; kept small so a rapid re-scrub
/// isn't stuck finishing a stale burst. `serve_request` decodes forward from the
/// seek's keyframe to the covering frame first (correct for both intra and
/// long-GOP), then emits up to this many frames.
const LOOKAHEAD_FRAMES: usize = 4;
```

- [ ] **Step 5: Run the tests to verify they pass**

```powershell
cargo test --features jobs,export,mcp,cloud,preview-sw preview_sw::session 2>&1 | Select-String -Pattern "test result|FAILED"
```
Expected: PASS — the new `long_gop_request_forward_decodes_to_target` AND the existing `open_then_request_delivers_a_frame` (intra ProRes, target 0 → zero discards → first pts 0) are both green.

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop/native/src/preview_sw/session.rs apps/desktop/native/tests/fixtures/tiny_mpeg2.mpg
git commit -m @'
feat(preview-sw): robust long-GOP seek (overshoot-safe + decode-forward-to-target)

serve_request now re-seeks backward with a growing margin until it lands on a
keyframe at/before the target (ffmpeg's BACKWARD seek overshoots on index-less
MPEG-PS/TS), then decodes forward to the frame covering the target. Correct for
intra (zero retries/discards, unchanged) and long-GOP MPEG-2/VC-1. Adds
tiny_mpeg2.mpg + a session test proving the covering frame, not an overshot or
pre-target keyframe, is delivered. decoder.rs::seek() unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 4: Per-family conformance + frame-drop-floor assertion (real app)

**Files:**
- Modify: `apps/desktop/e2e/scripts/gen-decode-bench-fixtures.mjs` (add `dnxhr-1080` + `mpeg2-1080` matrix rows)
- Create: `apps/desktop/e2e/electron/preview-sw-families.spec.ts` (parametrized DNxHR + MPEG-2 conformance + a frame-drop-tolerance step; leaves the proven ProRes `preview-sw-conformance.spec.ts` untouched)

**Interfaces:**
- Consumes: Task 1 routing (`native-sw` route for the family), Task 3 seek (covering frame for long-GOP), the `__weftcutTest` hook surface (`mediaDecodeRouteKind`, `activeClipProbe`, `weftcutSeekUs`, `capturePreviewFramePng`) and `./helpers/driver` exactly as `preview-sw-conformance.spec.ts` uses them.
- Produces: e2e proof that DNxHR (intra) and MPEG-2 (long-GOP, mid-GOP seek) preview through a live `SwSourceHandle` with SSIM ≥ 0.98, and that a `frameAt` miss holds the last frame (never blanks).

> **Rebuild the addon once before this task** (see Global Constraints): close the app, set the ffmpeg env, then `npx napi build --platform --release --features jobs,export,mcp,cloud,preview-sw` from `apps/desktop/native`. Tasks 1–3 validated via `cargo test` need no rebuild; this task exercises the addon at runtime.

- [ ] **Step 1: Add the family fixtures to the bench matrix**

In `apps/desktop/e2e/scripts/gen-decode-bench-fixtures.mjs`, append two rows to `BENCH_MATRIX` after the ProRes rows (after :46). DNxHR uses the `dnxhd` encoder/`dnxhr_hq` profile (ffprobe reports `dnxhd`); MPEG-2 is long-GOP:

```javascript
  // preview-sw Phase 2 families (Plan A). DNxHR = intra 8-bit 4:2:2; MPEG-2 =
  // long-GOP 8-bit 4:2:0 (exercises decode-forward-to-target seek). VC-1/WMV3
  // are omitted: ffmpeg has no VC-1/WMV3 encoder, so no synthetic fixture is
  // possible — they are covered by the routing test + codec-agnostic decoder.
  { name: "dnxhr-1080", ext: "mov", codec: "dnxhd", width: 1920, height: 1080, pixFmt: "yuv422p", durationUs: DUR_S * 1_000_000, encoder: "dnxhd",
    args: ["-c:v", "dnxhd", "-profile:v", "dnxhr_hq", "-pix_fmt", "yuv422p"] },
  { name: "mpeg2-1080", ext: "mpg", codec: "mpeg2video", width: 1920, height: 1080, pixFmt: "yuv420p", durationUs: DUR_S * 1_000_000, encoder: "mpeg2video",
    args: ["-c:v", "mpeg2video", "-b:v", "20M", "-g", "15", "-bf", "2", "-pix_fmt", "yuv420p"] },
```

- [ ] **Step 2: Generate + validate the fixtures**

```powershell
cd apps/desktop
node e2e/scripts/gen-decode-bench-fixtures.mjs
```
Expected: `ok     dnxhr-1080` and `ok     mpeg2-1080` (the script's own ffprobe `validate()` confirms codec/size/pix_fmt/duration). These land in `e2e/fixtures/decode-bench/` (gitignored, local-only — like the existing prores fixtures).

- [ ] **Step 3: Write the failing conformance spec**

Create `apps/desktop/e2e/electron/preview-sw-families.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, importAndPlaceMedia, invokeCmd, waitForHook } from './helpers/driver'

// Phase-2 Plan A conformance for the non-ProRes blind-spot families that CAN be
// synthesized: DNxHR (intra) and MPEG-2 (long-GOP). ProRes stays proven in
// preview-sw-conformance.spec.ts. VC-1/WMV3 have no ffmpeg encoder → covered by
// the Rust routing test + codec-agnostic decoder, not here. Reuses the
// decode-bench fixtures (e2e/scripts/gen-decode-bench-fixtures.mjs).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BENCH_DIR = path.resolve(__dirname, '../fixtures/decode-bench')
const OUT_DIR = path.resolve(os.tmpdir(), 'weftcut-e2e-preview-sw-families')
const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-preview-sw-families-proj')
const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
const SSIM_FLOOR = 0.98

function ffmpegBin(): string | null {
  const cand = process.env.FFMPEG || 'ffmpeg'
  const r = spawnSync(cand, ['-version'], { encoding: 'utf8' })
  return r.status === 0 ? cand : null
}
function parseSsimAll(stderr: string): number | null {
  const m = stderr.match(/All:\s*([0-9]*\.?[0-9]+)/)
  return m ? Number(m[1]) : null
}

interface FamilyCase {
  label: string
  fixture: string
  seekUs: number
  // Assert the delivered ring is the covering frame, not a pre-target keyframe.
  forwardDecodeFloorUs: number
}

async function runFamilyConformance(c: FamilyCase) {
  test.skip(!existsSync(c.fixture), `${c.label} fixture not found at ${c.fixture} — run gen-decode-bench-fixtures.mjs`)
  test.setTimeout(240_000)
  mkdirSync(PROJECT_PARENT, { recursive: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const { app, page } = await launchApp()
  let toggledOn = false
  try {
    await newProject(page, { parentFolder: PROJECT_PARENT, name: `${c.label}-${Date.now()}`, canvas: CANVAS })
    const after = (await invokeCmd(page, 'app_settings_set', {
      patch: { experimental_native_sw_decode: true },
    })) as { experimental_native_sw_decode: boolean }
    expect(after.experimental_native_sw_decode).toBe(true)
    toggledOn = true

    const { mediaId, layerId, kind } = await importAndPlaceMedia(page, { mediaAbsPath: c.fixture })
    expect(kind).toBe('Video')

    await waitForHook(page, 'mediaDecodeRouteKind')
    await page.waitForFunction(
      (id) => (window as { __weftcutTest: { mediaDecodeRouteKind(m: string): string | null } }).__weftcutTest.mediaDecodeRouteKind(id) === 'native-sw',
      mediaId,
      { timeout: 90_000, polling: 500 },
    )
    await page.waitForFunction(
      () => {
        try { (window as { __weftcutTest: { activeClipProbe(id?: string): unknown } }).__weftcutTest.activeClipProbe(); return true } catch { return false }
      },
      undefined,
      { timeout: 30_000, polling: 250 },
    )

    // Frame-drop floor: bind an initial frame, then seek far and confirm the
    // sprite STAYS bound (holds last) while decode catches up — never blanks.
    await page.evaluate((us) => (window as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us), 0)
    await page.waitForFunction(
      (id) => {
        const p = (window as { __weftcutTest: { activeClipProbe(id?: string): { sourceKind: string; spriteBound: boolean; ringSize: number } | null } }).__weftcutTest.activeClipProbe(id)
        return p && p.sourceKind === 'sw' && p.spriteBound && p.ringSize > 0 ? true : null
      },
      layerId,
      { timeout: 90_000, polling: 200 },
    )
    await page.evaluate((us) => (window as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us), 50_000_000)
    // Immediately (before the far frame can decode) the sprite must remain bound.
    const stillBound = await page.evaluate(
      (id) => (window as { __weftcutTest: { activeClipProbe(id?: string): { spriteBound: boolean } | null } }).__weftcutTest.activeClipProbe(id)?.spriteBound ?? false,
      layerId,
    )
    expect(stillBound, 'frame-drop floor: sprite must hold last frame on a frameAt miss').toBe(true)

    // Seek to the conformance target and wait until the ring holds the SEEKED frame.
    await page.evaluate((us) => (window as { __weftcutTest: { weftcutSeekUs(us: number): void } }).__weftcutTest.weftcutSeekUs(us), c.seekUs)
    const handle = await page.waitForFunction(
      ([id, target]) => {
        const p = (window as { __weftcutTest: { activeClipProbe(id?: string): {
          sourceKind: string; isSoftware: boolean; ringSize: number; ringFirstPtsUs: number | null; ringLastPtsUs: number | null; spriteBound: boolean
        } | null } }).__weftcutTest.activeClipProbe(id)
        if (!p || p.sourceKind !== 'sw' || p.ringSize < 1 || !p.spriteBound) return null
        if (p.ringLastPtsUs == null || p.ringLastPtsUs < target) return null
        return p
      },
      [layerId, c.seekUs] as const,
      { timeout: 90_000, polling: 200 },
    )
    const probe = (await handle.jsonValue()) as { isSoftware: boolean; ringFirstPtsUs: number | null }
    expect(probe.isSoftware).toBe(true)
    // Long-GOP proof: the ring's earliest frame covers the target — not a pre-target keyframe.
    expect(probe.ringFirstPtsUs ?? 0).toBeGreaterThanOrEqual(c.forwardDecodeFloorUs)

    // SSIM vs an ffmpeg reference of the same source frame.
    const ffmpeg = ffmpegBin()
    test.skip(ffmpeg === null, 'ffmpeg not on PATH (set FFMPEG) — SSIM step skipped')
    const b64 = (await page.evaluate(
      () => (window as { __weftcutTest: { capturePreviewFramePng(): Promise<string> } }).__weftcutTest.capturePreviewFramePng(),
    )) as string
    const rendered = path.join(OUT_DIR, `${c.label}-rendered.png`)
    writeFileSync(rendered, Buffer.from(b64, 'base64'))
    const idx = Math.round((c.seekUs * CANVAS.fpsNum) / (1_000_000 * CANVAS.fpsDen))
    const scores: Array<{ idx: number; ssim: number | null }> = []
    for (const i of [idx - 1, idx, idx + 1].filter((n) => n >= 0)) {
      const reference = path.join(OUT_DIR, `${c.label}-ref-${i}.png`)
      execFileSync(ffmpeg!, ['-y', '-i', c.fixture, '-vf', `select=eq(n\\,${i})`, '-vsync', '0', '-frames:v', '1', reference])
      const r = spawnSync(ffmpeg!, ['-i', rendered, '-i', reference, '-lavfi', '[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim', '-f', 'null', '-'], { encoding: 'utf8' })
      scores.push({ idx: i, ssim: parseSsimAll(r.stderr) })
    }
    const best = scores.reduce<{ idx: number; ssim: number }>((acc, s) => (s.ssim != null && s.ssim > acc.ssim ? { idx: s.idx, ssim: s.ssim } : acc), { idx: -1, ssim: -1 })
    // eslint-disable-next-line no-console
    console.log(`[preview-sw ${c.label}] SSIM scores: ${JSON.stringify(scores)} → best=${JSON.stringify(best)}`)
    expect(best.ssim, `SSIM below floor; scores=${JSON.stringify(scores)}`).toBeGreaterThanOrEqual(SSIM_FLOOR)
  } finally {
    if (toggledOn) {
      await invokeCmd(page, 'app_settings_set', { patch: { experimental_native_sw_decode: false } }).catch(() => {})
    }
    await app.close()
  }
}

test('preview-sw: DNxHR (intra) previews via SwSourceHandle + SSIM', async () => {
  await runFamilyConformance({
    label: 'dnxhr', fixture: path.join(BENCH_DIR, 'dnxhr-1080.mov'),
    seekUs: 500_000, forwardDecodeFloorUs: 0, // intra: any frame is a keyframe
  })
})

test('preview-sw: MPEG-2 (long-GOP) previews the covering frame via SwSourceHandle + SSIM', async () => {
  await runFamilyConformance({
    label: 'mpeg2', fixture: path.join(BENCH_DIR, 'mpeg2-1080.mpg'),
    seekUs: 800_000, forwardDecodeFloorUs: 700_000, // mid-GOP: ring must NOT hold the ~500ms keyframe
  })
})
```

- [ ] **Step 4: Run the spec to verify it fails first (RED) then passes (GREEN)**

Before the addon is rebuilt with Task 1's routing, or if run on an old addon, these fail on the `native-sw` route wait. After the rebuild (see the task note), run:

```powershell
cd apps/desktop
$env:FFMPEG = "ffmpeg"   # ensure ffmpeg resolvable for the SSIM step
npx playwright test e2e/electron/preview-sw-families.spec.ts --project=electron 2>&1 | Select-String -Pattern "passed|failed|skipped|Error"
```
Expected (GREEN): both tests pass. The MPEG-2 test proves (a) native-sw routing for a long-GOP family, (b) the decode-forward-to-target seek delivered the covering frame (`ringFirstPtsUs ≥ 700_000` + SSIM against frame 24 clears 0.98 — a keyframe delivery would tank SSIM), and (c) the frame-drop floor (sprite held on the far-seek miss). If ffmpeg isn't resolvable, the SSIM sub-step skips but the routing + forward-decode + frame-drop assertions still gate.

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop/e2e/scripts/gen-decode-bench-fixtures.mjs apps/desktop/e2e/electron/preview-sw-families.spec.ts
git commit -m @'
test(preview-sw): DNxHR + MPEG-2 conformance (SSIM, long-GOP seek, frame-drop floor)

Adds dnxhr-1080/mpeg2-1080 bench fixtures and a real-app conformance spec: both
families preview via SwSourceHandle with SSIM >= 0.98; MPEG-2 proves the covering
frame (not the keyframe) is delivered mid-GOP; a far-seek miss holds the last
frame (frame-drop floor, Compositor hold-last). ProRes spec untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 5: decode-bench measurement — threading win + seek-latency guard (informative)

**Files:**
- No production code. A documented measurement run via the existing `decodeBenchRun` hook (decode-bench is informative, not a CI gate — spec §10). Optionally record numbers in `docs/decode-bench.md`.

**Interfaces:**
- Consumes: `decodeBenchRun(args: BenchArgs)` on `window.__weftcutTest` (strategy `"sw"` = `forceStrategy: "software"`, already wired), the fixtures from Task 4, and the existing `prores-2160.mov` for the 4K threading proof.

- [ ] **Step 1: Rebuild the addon (if not already from Task 4) and launch the E2E build**

Close the app, set the ffmpeg env, rebuild with the feature union (Global Constraints), then launch the `VITE_WEFTCUT_E2E=1` build so `window.__weftcutTest.decodeBenchRun` exists.

- [ ] **Step 2: Measure the 4K threading throughput win**

In the app's devtools console (or via a throwaway Playwright `page.evaluate`), run the SW throughput bench on the 4K ProRes fixture and compare against the Phase-1 single-thread baseline (28.5 fps @4K):

```js
await window.__weftcutTest.decodeBenchRun({
  sourcePath: "<abs path>/e2e/fixtures/decode-bench/prores-2160.mov",
  durationUs: 60_000_000, scenario: "throughput", strategy: "sw", throttleMs: 0,
})
// Expect: result.kind === "throughput" with result.fps materially ABOVE 28.5
// (multithreaded decode). Record the number.
```
Expected: `fps` well above the Phase-1 28.5 (the threading win). If it is not above baseline, threading isn't taking effect — re-check the raw-context flags in Task 2.

- [ ] **Step 3: Guard seek latency (the FRAME|SLICE tradeoff check)**

Run the SW seek bench on ProRes-2160 (intra) and mpeg2-1080 (long-GOP):

```js
await window.__weftcutTest.decodeBenchRun({
  sourcePath: "<abs>/prores-2160.mov", durationUs: 60_000_000, scenario: "seek", strategy: "sw",
})
await window.__weftcutTest.decodeBenchRun({
  sourcePath: "<abs>/mpeg2-1080.mpg", durationUs: 60_000_000, scenario: "seek", strategy: "sw",
})
// Inspect result.perCategory[*].p50 / .max.
```
Expected / decision rule: intra ProRes seek `p50` should stay near the Phase-1 ~21 ms baseline (frame-threading output latency is the risk). **If intra seek p50 regresses materially past ~25 ms**, apply the design's fallback — branch the decoder's `thread_type` per family: `FF_THREAD_SLICE` only for `prores`/`dnxhd`, `FF_THREAD_FRAME | FF_THREAD_SLICE` for the long-GOP families (a small `codec_is_intra_family(codec)` check in `decoder.rs::open`, plumbed via the codec name available at open). Long-GOP seek is inherently heavier (decode-forward); record its numbers but do not gate on them.

- [ ] **Step 4: Record findings (optional) and finish**

If the numbers are noteworthy (they usually are for a 4K threading win), add a short row to `docs/decode-bench.md`'s results and commit that doc-only change:

```powershell
git add docs/decode-bench.md
git commit -m @'
docs(decode-bench): record Phase-2 SW multithreaded decode + seek numbers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
'@
```

---

## Wrap-up (after all tasks)

- [ ] **Full Rust test sweep** (from `apps/desktop/native`):
  ```powershell
  cargo test --features jobs,export,mcp,cloud,preview-sw 2>&1 | Select-String -Pattern "test result|FAILED"
  ```
  Expected: all green (routing, threading, session forward-to-target).
- [ ] **Confirm the electron-ci union is unchanged** — `preview-sw` must NOT have been added to the CI feature union (`jobs,export,mcp,cloud`), and `index.*.node`/`index.d.ts` remain gitignored. `git status` should show only the source/test/fixture files this plan touched.
- [ ] **Delete the Phase-2 kickoff handoff** once Plan B is also planned or shipped — `docs/superpowers/2026-07-05-preview-sw-phase2-kickoff.md` is a working handoff, not evergreen docs. (Leave it until Plan B is under way so the Plan B session still has it.)

## Plan B (out of scope here, for reference)

Playback-resolution throttle: swscale downscale level in `preview_sw` (decode full, scale to ½/¼), plumbed through napi + ipc; a Premiere-style Full/½/¼/Auto dropdown; the Auto frame-drop-driven algorithm. Its own brainstorm (real UX forks) → spec → plan.
