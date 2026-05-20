# PixiJS renderer — implementation plan

> Working plan for the renderer rewrite. Replaces the abandoned `composition-render.md` direction. At P13 this file is deleted; the evergreen spec lives in `docs/render.md` and a slimmed `docs/rendering.md`.

Preview and export share one PixiJS v8 + WebCodecs renderer. The preview shell mounts it against a `<canvas>` on the main thread. The export shell runs the same renderer module in an `OffscreenCanvas` Worker, encoding via `VideoEncoder` and muxing via mp4box.js. ffmpeg shrinks to three roles: import-time proxy generation, the existing audio compositor, and a final `ffmpeg -c copy` mux of `video.mp4 + audio.m4a → out.mp4`. The visual half of the Rust IR, the html-cap path, headless Chrome, the entire effects system, libmpv, and chromiumoxide all delete.

## Locked decisions

| | |
|---|---|
| Renderer | PixiJS v8 |
| Decode / encode | WebCodecs `VideoDecoder` / `VideoEncoder` + mp4box.js demux/mux |
| Scope | Visual pipeline only; audio path + final mux stay on ffmpeg |
| Worker model | Preview on main thread; export in `OffscreenCanvas` Worker |
| Proxy | Single 1080p H.264 1 s-GOP master proxy (replaces today's 540p) |
| VideoClip | WebCodecs `VideoFrame` → `Texture` → `Sprite` |
| ImageOverlay | `createImageBitmap` → `Texture` → `Sprite` |
| Text | PixiJS `Text` (native canvas) |
| Template | `foreignObject` SVG → `ImageBitmap` → texture, cached on content hash |
| Subtitles | JASSUB offscreen canvas → texture, resampled per frame |
| Color | PixiJS `Graphics` rect |
| Effects | All deleted in v1. Effects redesigned in a follow-up. |
| Groups | Render-flat in v1 (pure UX abstraction). FBO composition islands come back with the effect redesign. |
| Clock | Synthetic + Web Audio drift correction |
| Decoder lifecycle | One per source media; idle-dispose 5 s after last use |
| Prefetch | 1 s lookahead / 0.5 s lookbehind |
| Scrub | Debounce + `decoder.flush()` + seek-to-IDR + decode-forward |
| Verification | Fresh DSSIM fixture suite; PixiJS path is its own ground truth |
| MCP keyframe tools | Deferred to a follow-up |
| Render & Play | Kept; backed by new export Worker; popup is a Tauri webview with `<video>` |
| libmpv | Killed entirely |
| Schema | v5 → v6 migration strips `layer.effects` and `group.effects` |
| Branch strategy | Long-running `feat/pixi-renderer`, internal phases, fast-forward merge |

## New code layout

```
apps/desktop/src/render/
  Compositor.ts              — PixiJS Application owner; per-frame composite
  clock.ts                   — synthetic clock + Web Audio drift correction
  PlaybackEngine.ts          — transport (play/pause/seek/scrub); wires clock + Compositor + AudioGraph
  decoder/
    SourceDecoderPool.ts     — one VideoDecoder per source media; idle-dispose
    Demuxer.ts               — mp4box.js wrapper; produces EncodedVideoChunks
    FrameRing.ts             — 1 s lookahead / 0.5 s lookbehind ring per source
    scrub.ts                 — debounced flush + seek-to-IDR + decode-forward
  sprite/
    VideoClipSprite.ts
    ImageOverlaySprite.ts
    TextSprite.ts
    TemplateSprite.ts        — owns the foreignObject raster cache for its template
    SubtitlesSprite.ts       — owns JASSUB binding
    ColorSprite.ts
  templates/
    Rasterizer.ts            — foreignObject SVG → ImageBitmap; embeds @font-face base64
    Cache.ts                 — content-hash keyed
  subtitles/
    Jassub.ts                — libass-wasm canvas-mode binding
  worker/
    exportWorker.ts          — Worker entry; imports Compositor against OffscreenCanvas
    encoder.ts               — VideoEncoder config + mp4box.js mux into video.mp4
    protocol.ts              — postMessage protocol (start/cancel/progress/done)
  audio/
    AudioGraph.ts            — Web Audio mixer (port from existing PlaybackEngine)
  fixtures/
    runFixture.ts            — reusable fixture runner (used by tests + Tauri command)

apps/desktop/src/preview/
  PreviewSurface.tsx         — React mount + canvas host (only file that survives here)
```

Everything else under `apps/desktop/src/preview/dom/` is deleted.

## Rust survives / dies map

**Survives:**

- All of `state/*` except: `effect.rs` deleted; `layer.effects` and `group.effects` fields removed.
- All of `mcp/*`.
- All of `io/*` (`autosave.rs`, `migrate.rs`, `probe.rs`). `migrate.rs` gains a v5 → v6 stripper.
- `workspace.rs`, `logs/*`, `cloud/*`, `cache/*`, `recents.rs`, `keybindings.rs`, `app_settings.rs`, `view_state.rs`, `agent_session.rs`, `commands.rs`, `main.rs`, `lib.rs`.
- `jobs/*` (`import.rs`, `thumbnails.rs`, `waveform.rs`, `frame.rs`, `proxy.rs`). `proxy.rs` updated to emit 1080p H.264 1 s-GOP instead of 540p.
- `ffmpeg/mod.rs` — slimmed to audio + proxy helpers.
- `export/*` — slimmed to audio compositor + final-mux + preset/queue/hwencoder for audio side.

**Dies:**

- `state/effect.rs` — entire file.
- `state/validate.rs` — `GroupHtmlModeRequiresCssEffects` and all effect-routing validators.
- `state/layer.rs` — `Layer::requires_html()`, `Layer::effects` field.
- `state/group.rs` — `Group::requires_html()`, `Group::effects` field.
- `ir/lower.rs` — visual half (audio half stays in a slimmer module or merges into `export/`).
- `ir/materialize.rs` — entire file.
- `ir/emit_ffmpeg.rs`, `ir/graph.rs`, `ir/node.rs`, `ir/target.rs` — visual half / entire files.
- `raster/*` — entire module (`chrome.rs`, `composition.rs`, `html_group.rs`, `source_frames.rs`, `template.rs`, `engine_bundle.rs`).
- `mpv/mod.rs` — entire file.
- `preview/mod.rs` — `state_hash` bridge re-pointed at the new renderer's change events; file may shrink to a stub or merge into `commands.rs`.
- `bin/verify_render_parity.rs` — replaced by new fixture runner.
- Cargo deps: `libmpv2`, `chromiumoxide`.
- Installer: chrome-headless-shell bundling steps.

## Docs cleanup

- Delete: `docs/effects-routing.md`, `docs/html-render-groups.md`, `docs/composition-render.md`.
- Rewrite: `docs/preview.md` (new renderer architecture), `docs/rendering.md` (audio IR + WebCodecs export + final mux).
- Update: `docs/architecture.md`, `docs/data-model.md` (schema v6), `docs/setup.md` (PixiJS / mp4box / JASSUB deps; remove chrome-headless-shell + libmpv), `docs/groups.md` ("no rendering significance in v1" stance).
- New: `docs/render.md` — consolidated PixiJS renderer spec (authored at P13).

## Phases

| # | Phase | Scope | Acceptance |
|---|---|---|---|
| P0 | **Spike** | Branch `feat/pixi-renderer`. Add PixiJS / mp4box.js / JASSUB deps. Scaffold `render/` directory. One hardcoded VideoClip renders through PixiJS + WebCodecs against a fixed-timestamp test. Delete `composition-render.md`; one-line note in `architecture.md` pointing at this plan. | Fixture 001 plays in a dev panel |
| P1 | **Decode + clock + scrub** | `SourceDecoderPool`, `Demuxer`, `FrameRing`, `scrub.ts`, synthetic clock. Update Rust `proxy.rs` to 1080p H.264 1 s-GOP. Invalidate existing 540p proxies on next open via the existing `MediaDerivativesPatch.proxy_path = Some(None)` shape. | Fixture 001 with play / pause / seek / scrub through the whole timeline; no scrub freezes |
| P2 | **Multi-clip composite + keyframed transforms** | `VideoClipSprite`. Per-frame transform / opacity sampling via `Animated<T>::sample(t)`. Track z-ordering. Blend modes. | Fixtures 002 (two clips crossfade), 008 (multi-track stacking), 009 (keyframed transform) |
| P3 | **ImageOverlay + Color** | `ImageOverlaySprite` (`createImageBitmap` → `Texture`). `ColorSprite` (`Graphics` rect). Animated opacity / color. | Fixtures 006 (image overlay with blend), 007 (color fill) |
| P4 | **Text** | `TextSprite` (PixiJS `Text`). Shadow via drop-shadow filter. Outline via stroke option. Intro / outro presets (FadeIn / SlideUp / Typewriter) as sprite-side animation. | Fixture 003 (text with shadow) |
| P5 | **Templates** | `TemplateSprite`, `Rasterizer`, `Cache`. `foreignObject` SVG raster with embedded `@font-face` base64 and pre-fetched image data URLs. | Fixture 004 (template with fonts) |
| P6 | **Subtitles** | `SubtitlesSprite`, JASSUB canvas binding. | Fixture 005 (subtitles ASS karaoke) |
| P7 | **Audio integration** | Port Web Audio mixer from current PlaybackEngine. Wire `audioCtx.currentTime` into clock drift correction. Audio compositor (Rust ffmpeg) untouched. | All fixtures with audio play in sync |
| P8 | **Export Worker** | `exportWorker.ts` + `encoder.ts`. Sequential decode → composite → encode → mp4box mux into temp `video.mp4`. Progress / cancel protocol. | Any fixture exports to a playable MP4 (video-only at this point) |
| P9 | **Final mux + ExportPanel + Render & Play** | New Tauri command: `mux_export(video_mp4, audio_m4a, out_path)` runs `ffmpeg -c copy`. ExportPanel wired to Worker progress. Render & Play opens a Tauri webview popup with `<video>` against the temp MP4. | Any fixture exports to a final MP4 with audio; Render & Play popup plays it |
| P9.5 | **Decoder robustness** | Shared `configureWithFallback` helper in `SourceDecoderPool.ts`, consumed by both pools. On first-frame decode error (handle has emitted zero frames), reset + reconfigure with `hardwareAcceleration: 'prefer-software'` and mark the handle as downgraded. On `error.message.includes('Codec reclaimed due to inactivity')`, close + null the decoder, emit a LogBus warning, and lazy-rebuild on next `requestFrameAt`. Per-handle state; resets with idle-dispose. Lifts the patterns from OpenVideo's `VideoFrameFinder` (`video-clip.ts:1206`, `:1263`). | Force-fail HW decode in DevTools → preview and export recover via SW with one log line. Background the window long enough for codec reclaim → preview recovers on focus with one LogBus warning. |
| P10 | **Fixture suite + DSSIM gate** | `bin/render_fixture.rs` runs a fixture through the export Worker via a headless Tauri command and computes DSSIM vs `expected/`. CI job runs it on every PR touching `render/`. | 10–20 fixtures green in CI |
| P11 | **Schema migration v5 → v6** | `io/migrate.rs` strips `layer.effects` + `group.effects` on load with a loud per-effect log. Bump `Project::schema_version`. Update test fixtures to v6. | Existing v5 project opens, effects stripped, renders correctly through new path |
| P12 | **Cleanup** | Delete every file in the "dies" list. Remove Cargo deps `libmpv2` and `chromiumoxide`. Remove chrome-headless-shell from installer. Tighten `Cargo.toml` and `package.json`. | `cargo check` clean; `cargo test` green; binary size drops ~150 MB |
| P13 | **Docs** | Delete `effects-routing.md`, `html-render-groups.md`, `composition-render.md`. Rewrite `preview.md`, `rendering.md`. Update `architecture.md`, `data-model.md`, `setup.md`, `groups.md`. Author `docs/render.md` consolidating the PixiJS renderer spec. Delete this plan file. | Docs build cleanly, evergreen (no phase numbers, dates, commit hashes) |
| P14 | **Cutover** | Final rebase against `main`. Fast-forward merge. | `main` ships the new pipeline |

P3 / P4 / P5 / P6 can be parallelized — they're per-layer-kind work with no cross-dependencies after P2 lands.

## Per-phase notes worth pinning

- **P1 proxy invalidation.** When the Rust proxy spec changes 540p → 1080p, every existing project's cached proxies become stale. `MediaDerivativesPatch.proxy_path = Some(None)` invalidation cascades through the existing patch shape (`Option<Option<PathBuf>>`) → re-proxy on next open. No new infrastructure needed.
- **P2 transform sampling shape.** `Animated<T>::sample(t)` already returns `T` at any timestamp via the existing interpolation engine; the renderer just calls it once per channel per frame. The TS-side mirror already exists in `engine.ts` as `resolveAnimated(track, t)` — the new sprite code calls into it directly.
- **P5 font handling.** Pre-flight every template's font set at composition load: read `FontSpec`, fetch the woff2 from the workspace `Cache/fonts/` (or system), base64-encode, embed as `@font-face` in the SVG. Same font set is needed at preview-rasterize time and export-rasterize time — load once into a `FontCache`, reuse for both.
- **P8 backpressure.** `encoder.encodeQueueSize > 8` → await one tick. Prevents memory blow-up if the encoder lags decode. On a 5-min 1080p30 export (~9000 frames) peak Worker heap should stay <500 MB.
- **P9 audio file output.** The existing audio compositor already produces a temp `.m4a` (or wav, depending on `audioOnly` path). Hook into that — `ffmpeg -i video.mp4 -i audio.m4a -c copy out.mp4` is one process, ~100 ms.
- **P9.5 helper as seed for `DecoderCore`.** The `configureWithFallback` free function is the seed of a future `DecoderCore` class. Writing it as a function now and promoting to a class later avoids premature abstraction while still consolidating the duplication between the two pools.
- **P9.5 LogBus message format.** One warning per inactivity recovery event: `"video decoder recovered from inactivity (source {mediaId})"`. Repeated reclaims = repeated warnings; dedup is a future concern.
- **P11 migration logging.** Each stripped effect produces a `LogBus` warning: `"v5→v6 migration: stripped Blur effect from layer 'main-clip' (group 'A-roll')"`. Project re-saves as v6 on next autosave tick.

## Risks

- **WebCodecs hardware availability.** WebView2 on most Windows machines exposes hardware H.264 encode via Media Foundation. If a user's machine doesn't (rare), `prefer-hardware` falls back to software encode. Detect at startup and surface to settings.
- **`foreignObject` font reliability.** External fonts inside SVG `foreignObject` require base64 `@font-face` embedding to render in `createImageBitmap`. If the woff2 is missing or fetch fails, the template texture renders with system fallback. Mitigation: pre-flight load check at composition mount; surface failures to the status log.
- **JASSUB integration overhead.** libass-wasm has its own renderer canvas that we sample as a texture every frame. At 1080p, copying a 1920×1080 canvas → GPU texture is ~3 ms per frame on hardware. Acceptable.
- **Fixture coverage gaps.** A 10–20 fixture suite can't cover every keyframe shape, every blend-mode interaction, every text-rendering edge case. Plan to extend the suite as real bugs surface.
- **Reader confusion mid-refactor.** `composition-render.md` (the abandoned plan) gets deleted in P0 alongside an `architecture.md` pointer to this file — so the repo never carries two contradictory plans at once.

## Open questions to confirm during implementation

1. **PixiJS version pin.** v8.x has been stable; pin a specific minor like `^8.6` to avoid passive upgrades during the refactor.
2. **mp4box.js types.** Their TypeScript types are partial; we may need a thin `.d.ts` for the bits we use. Confirm in P0.
3. **`OffscreenCanvas` + PixiJS Worker support.** PixiJS v8 explicitly supports `OffscreenCanvas`; smoke-test in P0 before committing the export Worker design.
4. **Export preset → `VideoEncoder` config mapping.** Today's `ExportPreset` carries CRF / preset / GOP — these map to `VideoEncoder` `bitrate` / `latencyMode` / `gop` differently. Build a translation layer in P9; consider whether all current presets remain meaningful in the new encoder world.
5. **State sync to export Worker.** Cleanest is `structuredClone(project)` + post once at export start. If project size grows large, revisit using shared snapshots. Confirm in P8.
6. **Worker-scope inactivity message.** Confirm during P9.5 implementation that `error.message.includes('Codec reclaimed due to inactivity')` fires inside an `OffscreenCanvas` Worker, not just main-thread `VideoDecoder`. If the Worker-side message differs, broaden the match.
7. **Software-fallback heuristic on long runs.** First-frame heuristic (downgrade only when `outputFrameCount === 0`) is correct for short-lived export handles. For long-lived preview handles, a mid-stream HW glitch leaves us with a dead decoder until the next reset. Watch P9.5 fixture telemetry; if mid-stream HW errors are real, generalize the heuristic.

## See also

- `docs/architecture.md` — overall app shape (updated at P13).
- `docs/data-model.md` — project schema (v6 after P11).
- `docs/preview.md` — interactive surface details (rewritten at P13).
- `docs/rendering.md` — audio IR + WebCodecs export + final mux (rewritten at P13).
- `docs/groups.md` — group model (updated at P13 to reflect render-flat v1).
