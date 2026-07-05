# preview-sw Phase 2 — kickoff handoff (for a fresh session)

**Read first:** the design spec `docs/superpowers/specs/2026-07-05-ffmpeg-sw-decode-blindspot-design.md`
(the multi-phase design of record; Phase 2 = §11.2 + the degrade stack §4) and `docs/adr/0029-native-sw-decode-ships-bytes-not-shared-texture.md`.
This note is a working handoff, not evergreen docs — delete it once Phase 2 ships.

## Where Phase 1 left off (SHIPPED, on local `main`, not pushed)
Native software-decode **ProRes** preview works end-to-end behind the off-by-default `experimental_native_sw_decode`
toggle. Verified: TS 1802 tests + Rust 346 tests; decode-bench sw = 1080p 101.8 fps / 4K 28.5 fps / seek 21.2 ms
(pure software); E2E conformance spec green (Compositor uses `SwSourceHandle` at runtime; SSIM 0.995 vs ffmpeg;
4K memory within ratchet). The full path: `PreviewSource::NativeFfmpeg` → `preview_sw` (ffmpeg-next SW decode →
NV12) → napi ThreadsafeFunction → ipc → `SwSourceHandle` → FrameRing → Compositor (never auto-swaps to proxy).

## Phase 2 scope (spec §11.2 + §4)
1. **Four more WebCodecs-blind families:** DNxHD/DNxHR, MPEG-2, VC-1/WMV (ProRes already done).
2. **Degrade stack (§4) — the part that lifts 4K toward realtime:**
   - (a) always-on `thread_count` = cores + frame/slice threading in the SW decoder;
   - (b) playback-resolution throttle (swscale to ½/¼ during playback, full on pause/scrub) + an `Auto` mode driven
     by observed frame-drop rate + a Premiere-style Full/½/¼ UI dropdown;
   - (c) frame-drop floor, audio-clock-locked (skip a late frame, never stall A/V).

## Concrete code seams to extend (from Phase-1 knowledge)
- **Routing** `apps/desktop/native/src/jobs/proxy_decision.rs`: `codec_is_prores` → widen to a `codec_is_blindspot`
  family check (`prores`, `dnxhd`, `mpeg2video`, `vc1`, `wmv3`); `decide` branches on it (same NativeFfmpeg route).
  Existing tests + the `native-sw` DecodeRoute machinery (Rust twin + golden fixture + media.ts/summary/persistence
  arms) already generalize — a new family just flows through as `native-sw`.
- **Decoder** `apps/desktop/native/src/preview_sw/decoder.rs`: the open path is ALREADY codec-agnostic
  (`streams().best(Video)` → `from_parameters` → `.decoder().video()`), so DNxHD/MPEG-2/VC-1 decode with no new
  per-codec code. NEW work: set `thread_count`/`thread_type` (parallel decode — biggest 4K win); and a **long-GOP
  seek** variant for MPEG-2/VC-1 (the current `seek` is intra-frame-optimized = single decode after seek; long-GOP
  needs seek-to-keyframe + decode-forward-to-target — mirror the WebCodecs `PacketPump`/`preview_gpu` long-GOP logic).
- **Throttle** (new): swscale downscale in `preview_sw` (decode full, scale to ½/¼) driven by a per-session
  resolution level; plumb the level through napi + ipc; renderer `SwSourceHandle` already reconstructs whatever size
  arrives. Full res on pause/scrub.
- **Frame-drop**: confirm the Compositor playback loop tolerates a `frameAt` miss gracefully (spec §4.3) — may already.
- **UI**: a playback-resolution dropdown (Full/½/¼/Auto) — new AppSettings or per-project pref + a control near the preview.
- **Validation**: extend the decode-bench matrix + `preview-sw-conformance.spec.ts` for each new family; per-family SSIM.

## Recommended first step in the new session
Start with **superpowers:brainstorming** (the degrade-stack UX — playback-resolution control, Auto behavior — is a
real design fork worth grilling), then **superpowers:writing-plans** for a Phase-2 plan, then
subagent-driven-development (as Phase 1). The spec §4/§11.2 is the design input.

## Phase-1 gotchas to carry forward (bit us or nearly did)
- `jobs` is an effective baseline cargo feature — Rust tests need `--features jobs,export,mcp,cloud,preview-sw`.
- napi:build via `npx napi build ... --features jobs,export,mcp,cloud,preview-sw` (ONE union flag, not double); close the app first (.node lock). `.node` + `index.d.ts` are gitignored; preview-sw stays OUT of the CI union.
- Single color model: derive `VideoColorSpace` from the MAPPED `sourceColor` (`ffprobeColorToWebCodecs`), NEVER cast
  raw ffmpeg `.name()` tag strings (they aren't valid WebCodecs enums for wide-gamut/HDR → `new VideoFrame` throws).
- Compositor must NEVER auto-swap a software clip to a proxy (`ActiveClip.isSoftware` guard) — feedback_native_nle_conventions.
- Build env inline: `$env:FFMPEG_DIR="...Gyan.FFmpeg.Shared...ffmpeg-8.1.1-full_build-shared"; $env:LIBCLANG_PATH="C:\Program Files\LLVM\bin"; $env:PATH="$env:FFMPEG_DIR\bin;$env:PATH"`.

## Also-open (not Phase 2, but track)
- Native EXPORT for blind-spot formats = Phase 3 (spike already cleared the main→worker transport; export currently proxies).
- Proxy = pure user toggle / delete blind-spot auto-proxy scheduling = Phase 4 cleanup.
- The 4K memory-ratchet headroom is variable (10–20 vs 30 MB) — bump the ceiling if the conformance spec flakes.
