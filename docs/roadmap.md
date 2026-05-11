# Roadmap

Phased delivery to v1. Single-developer estimates; double for first time touching Tauri/Rust/ffmpeg.

## Phase 0 — Spike (1 week)

**Goal: kill the project here if a fundamental assumption is wrong.**

- Tauri 2 shell builds and runs on Win + macOS + Linux.
- libmpv embeds and plays one MP4 inside the Tauri window. Surface positioning syncs with a webview placeholder div on resize.
- Hidden `wry` webview captures one PNG via the platform's snapshot API. **Test on every target OS.**
- `rmcp` server boots, Claude Desktop connects, `ping` tool returns.

**Risks validated here:**
- libmpv ↔ webview window layering on each OS.
- Webview snapshot capture (especially WebKitGTK on Linux).
- ffmpeg sidecar download/exec on each OS.

**Exit criteria:** all four work end-to-end, or a documented decision to swap a piece (e.g., Electron, headless Chromium fallback for Linux).

### Phase 0 status (2026-05-07, Windows 11)

| Spike | Result |
|---|---|
| Tauri 2 shell | ✅ builds + dev-launches; React UI + Rust IPC (`core: ok` ping) confirmed end-to-end. |
| ffmpeg sidecar | ✅ wired with graceful fallback. Auto-download fails behind a SOCKS proxy (`ureq` lacks the `socks-proxy` feature in `ffmpeg-sidecar`'s build); bootstrap downgrades to `WARN` and the app keeps running. Manual install via `winget install -e --id Gyan.FFmpeg` flips it to the "already installed" path. |
| `rmcp` server | ✅ live. SSE on auto-port + bearer token logged at startup. `event: endpoint` handshake validated with curl. **Deviation:** transport is SSE rather than Streamable HTTP, because `rmcp` 0.1.x hasn't shipped `transport-streamable-http-server` yet — Claude Desktop accepts both. |
| Hidden `wry` webview | ⚠ partial. Offscreen webview spawn confirmed (`raster spike: hidden webview spawned`). PNG capture via `CapturePreview` / `WKWebView.takeSnapshot` / `webkit_web_view_get_snapshot` is deferred to Phase 5 — the architecture is decided, the integration work belongs there. |
| libmpv embed | ⏸ deferred behind tooling. `libmpv2` removed from `Cargo.toml` because `libmpv2-sys`'s build script unconditionally emits `cargo:rustc-link-lib=mpv`; without `mpv.lib` on the linker path the build fails LNK1181 even when no code references libmpv2. The mpv module has a no-op `spike()` with the enabling block commented; `docs/setup.md` walks through the install + flip-back. |

**Exit decision:** project not killed. Two pieces deferred under documented preconditions, both safe to advance past:
- libmpv: validates locally as soon as the user installs the dll/lib; the surface-mount work is its own Phase 1+ task regardless.
- raster PNG capture: an isolated Phase 5 deliverable; design doesn't change.

Forward to Phase 1.

## Phase 1 — Editor MVP (4–5 weeks)

**Goal: a usable editor for the simplest case.**

- Project state: types, actor, validation, undo/redo (linear), checkpoints.
- Save/load `.vproj` folder, `schema_version: 1`.
- Media import: probe metadata, generate proxy + thumbnails + waveform asynchronously.
- IR compiler MVP: `VideoClip`, `Color` base, `Overlay` chain, `Amix`. ffmpeg + libmpv emitters.
- Timeline UI: tracks, drag/drop import, trim/split/move, scrubbing.
- libmpv preview connected to live filter graph.
- **i18n scaffold** — `i18next` set up with `en-US` (source) and `zh-CN` resources; every new UI string lands behind a key from day one so we don't have to retrofit later. See [architecture.md](architecture.md) "Internationalization".

**Exit criteria:** import three clips, arrange on a timeline, trim, scrub the result smoothly. UI fully translatable.

### Phase 1 status (2026-05-07, Windows 11)

Tracking the data-model.md "Implementation footprint" build order:

| Step | Status | Notes |
|---|---|---|
| 1. Type definitions + JSON round-trip | ✅ | 12 modules under `src/state/`. 2 round-trip tests. |
| 2. Single-writer actor (`add_layer`/`delete_layer`) | ✅ | mpsc inbox, broadcast events. |
| 3. History (snapshots + checkpoints) | ✅ | Undo/redo + named checkpoints. `recursion_limit = "512"` on `lib.rs` so the actor's future can prove `Send`/`Sync` through nested `imbl` types. |
| 4. Validation invariants | ✅ | 11 invariants in `state/validate.rs`; runs on every commit. 12 tests. |
| 5. Full mutation surface | ⚙️ partial | Done: `add_track`, `delete_track` (with `force`), `add_layer`, `delete_layer`, `split_layer` (adjusts VideoClip/Audio src offsets at speed=1), `replace_state`, `add_media_item`, `update_layer` (envelope patch), `move_layer` (across tracks), `duplicate_layer`, `set_composition` (envelope patch), `add_marker`. Pending: `update_marker`/`remove_marker`, `update_effect`/`add_effect`/`move_effect`/`remove_effect`, keyframe commands, `move_track`, `remove_media`. |
| 6. Save/load `.vproj` | ✅ | `io/mod.rs` writes `project.json` + `schema_version`. Schema-version gate on load. UI buttons via `tauri-plugin-dialog`. |
| 7. MCP resource serialization (read-only) | ✅ | `project://current` returns the snapshot as `application/json`. `tools` + `resources` capabilities advertised. |
| 8. UI bridge | ⚙️ partial | React app shows project meta + history + action bar. **i18n scaffolded** with en-US + zh-CN, header toggle. Subscription-based auto-refresh and richer panels are Phase 1.x polish. |

Roadmap-level deliverables still outstanding inside Phase 1:

| Deliverable | Why deferred / next step |
|---|---|
| **Media import** | ✅ done in `src/io/probe.rs` + actor `add_media_item` + Tauri `import_media`. Hashes via blake3, probes metadata via `ffprobe` when installed, falls back to extension-based `MediaKind` + empty metadata when not. UI: **Import media…** button + a media-pool list showing kind/label/duration/dimensions/size with i18n. Proxy / thumbnails / waveform stay deferred — separate background-job phase. |
| **IR compiler MVP** | ✅ done in `src/ir/`. `Color`, `VideoClip`, `Audio` lower; `Overlay` chain + `Amix`; ffmpeg `lavfi` emitter; round-trip + worked-example tests. UI exposes a `Compile` button that pops the emitted graph in a panel. libmpv emitter is a thin wrapper deferred until libmpv install. |
| **Timeline UI** | ✅ MVP done (`apps/desktop/src/timeline/Timeline.tsx`). Time ruler with second tick marks, one row per track, layer blocks with stable per-layer color, click-to-select with white outline, drag layer body to move (calls `move_layer`), drag left/right edges to trim (calls `update_layer`), Delete key removes selected layer. Fixed zoom at 80 px/s. Track lanes coloured by kind. **Drag from media pool**: media-pool items are HTML5 draggable (`application/x-videtor-media` payload), tracks accept the matching kinds (video tracks accept Video + Image, audio tracks accept Audio), drop spawns a layer at the cursor's `t_start_us` via the new `add_media_layer` Tauri command. **Pending**: scrub indicator + click-to-seek, zoom control, multi-select, cross-track drag of existing layers. |
| **libmpv preview connected to live filter graph** | ⚙️ partial. Install path automated: `apps/desktop/src-tauri/vendor/libmpv/` is populated by the script that downloads Shinchiro's libmpv-dev archive, generates `mpv.lib` from `libmpv-2.dll` exports via `dumpbin` + `lib.exe`, and drops the headers in place. `build.rs` extends `rustc-link-search` and stages `libmpv-2.dll` into `target/<profile>/`. `libmpv2 = { optional = true }` behind the `mpv` Cargo feature; `npm run dev`'s default already passes `--features mpv`. **Working today**: `Import media…` → ▶ Preview opens libmpv's own top-level window playing the file. Timeline has a playhead, ruler-click seeks, and the Play/Pause button toggles the libmpv `pause` property. Cross-track timeline drag works for layers of the same track kind. **Pending**: child-HWND-inside-WebView2 mount synced to `<div id="video-surface">`, hot-reload of `lavfi-complex` on every project commit, libmpv → UI playhead-position feedback so the ruler tracks playback in real time. |
| **Export pipeline** (originally Phase 3) | ✅ MVP done in `src/export/`. Drives ffmpeg via `tokio::process::Command`, writes the IR's filter graph to `%TEMP%/videtor-export-<id>.txt`, parses `-progress pipe:1` for per-block updates, and re-emits them as Tauri events (`export:progress` / `export:complete` / `export:error`). UI: **Export…** action button + a bottom-left progress panel with percent/frame/fps/speed, full i18n. Preset is hard-wired to `libx264 -preset medium -crf 20` + AAC 192k MP4. Hardware-encoder probing, render queue, ProRes/GIF presets remain Phase 3. **Needs ffmpeg installed.** |

Tests at end of session: **44 passing** (18 actor + 5 history + 12 validate + 2 io + 3 probe + 4 ir).

### Live-preview slice (2026-05-07, same day as closeout audit)

Closes gaps #2 and #3 from the closeout below.

- `src/ir/emit_mpv.rs` — libmpv `lavfi-complex` emitter. Translates `[N:v]/[N:a]` → `[vid(N+1)]/[aid(N+1)]`, terminates in mpv's magic `[vo]/[ao]` labels, returns `MpvPlan { primary, external_files, lavfi_complex, has_video, has_audio }`. Two unit tests (one-clip + empty-project).
- `mpv::play_graph(slot, plan)` — sets `external-files` (Windows `;` separator), clears + sets `lavfi-complex`, `loadfile`s primary. Skips on pure-Color projects (no decoded inputs). Dedups by `(primary, external_files, lavfi_complex)` so file-swap-at-same-slot still reloads.
- `mpv_preview_project` Tauri command + `🎬 Preview project` UI button (en-US + zh-CN). Returns an `MpvPreviewStatus` shape so the UI can confirm what loaded.
- Hot-reload subscriber in `lib.rs` setup (cfg `mpv` only). Subscribes to `ProjectHandle::subscribe()`, recompiles + re-applies on every ChangeEvent when `is_active(slot)`. Handles `RecvError::Lagged` by refreshing from current snapshot. `is_active` flips true on first `play_graph` / `play_file`.
- `MpvSlot` rewired to `Arc<Mutex<MpvState { mpv, active, last_key }>>` to hold the dedup key + active flag.

Verification owed: dev machine has no mpv CLI; label syntax, path-list separator, and live-update semantics are documented behavior, not measured. First time at the app, confirm libmpv shows the *trimmed* project output (not the raw clip). If it doesn't, labels are the first suspect.

Budget calibration: the doc/audit framed this as a "~30 LoC thin wrapper" — actual was ~280 LoC for emitter + tests, ~60 for `play_graph`, ~50 for the subscriber. The translation is structural (input/output label conventions + loading model), not a wrapper.

### Post-slice UX polish (2026-05-07)

Three follow-ups landed the same day, all bug-driven:

- **Tauri `dragDropEnabled: false`** on the main window. Default-true was making the OS drag-drop handler intercept events before the webview saw them, so media-pool → timeline drag silently no-op'd. Disabling it lets HTML5 drag-drop work normally; we don't use the OS file-drop hook anyway (imports go through the file picker).
- **libmpv preview close path.** With `force-window=yes` (required for libmpv to spawn its own top-level window when no host `wid` is supplied), the OS close button binds to `quit` and emits `MPV_EVENT_SHUTDOWN`, but the OS window resource isn't released until `mpv_terminate_destroy` runs — i.e. until our `Option<Mpv>` is dropped. Fix: a 200ms-tick background poller (`mpv::drain_events_and_close_if_shutdown`) drains the event queue and drops the handle when Shutdown arrives. Plus an explicit ✕ Close preview button + `mpv_close_preview` Tauri command for instant close. Plus a zombie-handle probe in `ensure_init` (read `mpv-version`; if it errors, drop and re-init) so reopening preview after the user closed via OS X works fresh. Also, `play_file` now clears stale `lavfi-complex`/`external-files` so raw-clip ▶ works cleanly even mid-session.
- **Default A-roll / B-roll tracks + `removable: bool`**. Fresh `Project::new_blank` ships two non-removable video tracks labelled "A roll" / "B roll". Gives the timeline UI a guaranteed drop target and gives MCP agents a stable answer for "where do I put this clip?". `delete_track` returns `TrackNotRemovable` for these.
- **Media import sits outside the undo stack.** `add_media_item` writes the updated pool into every snapshot in `History` + every checkpoint, then broadcasts a non-recorded `ChangeEvent`. The history cursor doesn't move and no entry is recorded. Imported clips stay in the bin even when the user undoes their way past the import — Premiere/DaVinci semantics.

Tests: 46 → 50, +4 covering the new contracts (`blank_project_ships_with_a_b_roll`, `cannot_delete_non_removable_track`, `import_media_does_not_grow_history`, `imported_media_persists_across_undo`).

### Phase 1 closeout audit (2026-05-07)

Honest accounting against the bullet list at the top of this section:

| Roadmap deliverable | Status | Detail |
|---|---|---|
| Project state: types, actor, validation, undo/redo, checkpoints | ✅ done | Steps 1–4 of the build order land cleanly. Mutation surface step 5 has the envelope ops the UI needs; effect/keyframe/marker-edit families remain. |
| Save/load `.vproj`, `schema_version: 1` | ✅ done | `io::save_to_dir` / `load_from_dir`, `replace_state` actor command, file-picker UI. |
| Media import: probe metadata, generate **proxy + thumbnails + waveform** | ⚠️ partial | Probe + hash + import is done. **Proxy / thumbnails / waveform are NOT generated** — the media-pool list shows ffprobe-derived metadata only. These were always going to be a background-job phase; not yet started. |
| IR compiler MVP: `VideoClip`, `Color`, `Overlay`, `Amix`. **ffmpeg + libmpv emitters** | ⚠️ partial | ffmpeg `lavfi` emitter ✅. **libmpv emitter NOT written** — same syntax via `--lavfi-complex`, but the wrapper that pipes our `FfmpegPlan` into `libmpv2`'s `set_option` is still the open piece. |
| Timeline UI: tracks, drag/drop import, trim/split/move, scrubbing | ✅ done | Render + select + body-drag to move + edge-drag to trim + Delete key + drop from media pool + cross-track drag + ruler click-to-seek + playhead + Play/Pause. |
| **libmpv preview connected to live filter graph** | ⚠️ partial | libmpv plays **raw imported clips** in its own top-level window today. The "connected to live filter graph" piece — IR `lavfi-complex` fed to libmpv with hot-reload on every commit — is **NOT done**. |
| i18n scaffold (en-US + zh-CN) | ✅ done | `i18next` + `react-i18next`, `Resources` type enforces shape parity, header toggle, `localStorage` persistence. |

**Strict exit-criteria check** — "import three clips, arrange on a timeline, trim, scrub the result smoothly. UI fully translatable":

- import three clips ✅
- arrange on a timeline ✅
- trim ✅
- scrub **the result** ⚠️ — the timeline ruler scrubs and the playhead jumps; the libmpv `seek` command fires; but what libmpv shows is the **raw imported clip**, not the project's composited output. Strictly, "the result" isn't being scrubbed.
- UI fully translatable ✅

**Closeout decision: Phase 1 SUBSTANTIALLY complete, with three named gaps**

| Gap | Where it belongs |
|---|---|
| Proxy / thumbnails / waveform generation for imported media | A background-job phase (1.x polish or Phase 2 prerequisite). Needs a worker pool driving ffmpeg sidecars; not foundational. |
| libmpv emitter | One small Rust wrapper around the existing `FfmpegPlan` + `libmpv2`'s option API. ~30 LoC. |
| Live preview = compiled IR graph | The actual Phase 1 keystone we didn't close. Needs the libmpv emitter (above) plus a "recompile on every commit, hot-reload `lavfi-complex`" loop. ~150 LoC plus the tricky question of where libmpv renders (its own window today; ideally child-HWND inside the Tauri window). |

Out-of-scope-but-delivered work that paid for the gaps in calendar terms:
- Export pipeline (originally Phase 3) ✅ MVP
- MCP read-only resource + tool (originally Phase 4) ✅
- libmpv install automation (vendored DLL, generated `mpv.lib`, build.rs staging) ✅
- Cross-track timeline drag, transport controls, scrub UI ✅

Forward motion: **Phase 1 closed for milestone purposes, with the three gaps tracked as named follow-ups**. The next time we're in front of the project, the natural Phase 1 cleanup is the live-preview-of-compiled-graph slice — it's the deliverable the spec actually wanted from "scrub the result smoothly", and it unblocks meaningful Phase 2 work.

### Phase 1.x leftover (proxy / thumbnails / waveform) closeout (2026-05-08)

The "background-job phase" gap from the Phase 1 audit. **COMPLETE** in seven staged commits (`a028572` → `0e3ce48`). The Phase 4 closeout deferred `media://*` MCP resources to "the proxy/thumbnails/waveform background-job phase" — that's this phase, and they ship together.

| Stage | Result |
|---|---|
| 1 — Cache + actor surface | ✅ `cache::CacheLayout` (content-addressable layout in OS app-cache dir, deviates from data-model.md per-`.vproj` spec deliberately — same hash hits across projects). `MediaDerivativesPatch` + `Command::SetMediaDerivatives` + `ProjectHandle::set_media_derivatives`, mirrors `add_media_item` semantics (outside the editing undo stack). Atomicity helpers `temp_path` / `promote_temp` / `discard_temp` + `cached_ok` predicate. |
| 2+3 — Orchestration + thumbnails | ✅ `jobs/mod.rs` with `OnceLock<Semaphore>` (capacity 2) gating concurrent ffmpeg invocations. `enqueue_for_media` fans jobs out per kind. `jobs/thumbnails.rs` extracts 10 evenly-spaced 320px JPGs via `-vf fps=N/D,scale=...,-frames:v N`. Atomic at directory level — write into `<dest>.tmp/`, verify N non-empty files, rename. |
| 4 — Proxy | ✅ 540p H.264 fast-preset MP4 software encode (HW probe stays for user exports). Smoke test caught a real bug — ffmpeg can't infer mp4 from `<dest>.mp4.tmp` so the muxer needs explicit `-f mp4`. |
| 5 — Waveform | ✅ Mono f32 PCM at 22050 Hz piped to stdout, max-abs per ~10ms window written to a compact binary peaks file (`VPEAKS\0\0` magic + header + f32 array). 1 hour of audio ≈ 1.4 MB; mmap-friendly. |
| 6 — `media://*` MCP resources | ✅ `media://{id}/thumbnail` returns the middle thumbnail, `media://{id}/frame/{t_us}` does on-demand extraction with disk cache, `media://{id}/waveform` returns the peaks file. All via `BlobResourceContents.blob` (base64). 404 with hint text pointing at `media:job_complete` when derivatives haven't been generated yet — agents know to wait + retry rather than giving up. |
| 7 — Import-time fan-out | ✅ Both `commands::import_media` and `VidetorServer::import_media` call `jobs::enqueue_for_media` after `add_media_item` succeeds. Identical event streams from either source. |

Tests: 70 → 88. **+11 jobs tests** running real ffmpeg against tiny `lavfi`-generated fixtures (skipped when ffmpeg absent — the smoke-test pattern from `feedback_emit_smoke_tests.md`). The `.mp4.tmp` and waveform-amplitude bugs that actually surfaced both came from these tests, vindicating the discipline.

Tauri events the UI can listen for (not yet wired into a media-pool progress strip — polish phase): `media:job_started`, `media:job_complete`, `media:job_error` with `{ media_id, kind: "thumbnails" | "proxy" | "waveform", path? | error? }` payloads.

### Deliberately deferred from Phase 1.x

| Deferral | Where it belongs |
|---|---|
| Frontend display of thumbnails / waveforms (media pool thumbnail strip; timeline waveform peaks under audio layers) | Phase 7 polish or whenever the editing UX feels held back. Backend already has the data; rendering is a React + canvas job. |
| Per-vproj cache mirroring (data-model.md "On-disk format" originally spec'd `cache/` inside `.vproj`) | Lands when "consolidate to project folder" is a feature. Until then the app-cache deviation makes more sense (cross-project hits). |
| Proxy auto-selection (libmpv plays the proxy when original is too heavy) | Needs a heuristic ("source is 4K + proxy exists → use proxy"). Not yet wired into `mpv::play_*`. |
| ffmpeg behind SOCKS proxy auto-download | Pre-existing Phase 0 issue; manual `winget install Gyan.FFmpeg` is the documented workaround. |

Forward motion: Phase 1.x closed. **Phase 6 closed 2026-05-11** — Stages 1–8 complete (keyring + Settings UI, inline-subtitle materialization, `apply_subtitles` tool, cloud client foundation, Whisper + `transcribe_clip`, tts-1 + `synthesize_speech`, `/auto-caption` + `/voiceover` prompts, hardening: retries + Test connection). One scope gap deliberately deferred: omitting unconfigured cloud tools from `list_tools` (rmcp 0.1.x `tool_box` macro limitation — current `MissingKey` structured error is the recovery path; see `cloud/mod.rs` doc comment near `pick_transcriber`). Other open slices: Phase 5 (rasterized templates), or pick at remaining Phase 2 deferrals (mpv drawtext live preview, crossfade, layer composition order).

## Phase 2 — Native overlays (2 weeks)

- `ImageOverlay` layer (ffmpeg `overlay`).
- `Text` layer with `DrawText` backend (font, color, outline, shadow).
- `Subtitles` layer (ASS/SRT via ffmpeg `subtitles`/`ass`).
- Built-in transitions via `xfade` (crossfade, dissolve, fade-to-black).
- Property panel UI for each layer type.

**Exit criteria:** add a title, a logo, captions, and a fade transition.

### Phase 2 status (2026-05-08, Windows 11)

**SUBSTANTIALLY COMPLETE** — all five slices land, with two named caveats:

| Slice | Status |
|---|---|
| ImageOverlay layer | ✅ IR + ffmpeg/mpv emitters + UI wiring + property-panel transform/opacity/fade controls. Export path verified at the parser level; mpv still-image preview unmeasured (caveat documented). |
| Text / DrawText | ✅ IR + emitters + property-panel content/font/size/color/x-y/opacity controls. Export path now works end-to-end after the `;`-separator fix (see "emit_ffmpeg fix" below). Live preview through mpv's bundled libavfilter still fails with `Raw(-13)` — separate from the export-side bug, deferred again. |
| Subtitles | ✅ IR `Subtitles` node + lower for `SubtitlesParams` (Media-backed, inline ASS/SRT not yet wired). Burns onto current_v via ffmpeg's `subtitles` filter. Auto-creates a Subtitle track when the user drops a `.srt`/`.ass` from the media pool. ffmpeg + mpv emitters share the same path-escape rule (`\:` for drive letters, `'\''` for embedded quotes). |
| xfade transitions | ✅ shipped as **per-clip fade-in / fade-out** via the simpler `fade` filter (single-input). New `IRNode::Fade` + `FadeKind`. Property panel exposes `fade_in_us` / `fade_out_us` on `VideoClip` and `ImageOverlay`. Crossfade-between-adjacent-clips deferred — needs an overlap-exempt `Transition` concept (see "deliberately deferred" below). |
| Property panel UI | ✅ Right-side sidebar. Edits envelope (label, t_start_us, t_end_us, enabled) and kind-specific scalars (Text: content/font/size/color/x/y/opacity; VideoClip: opacity/scale/x/y/speed/fade/flip; ImageOverlay: opacity/x/y/fade; Color: color/dims; Audio: gain/pan/mute; Subtitles: read-only source view). Range/color inputs debounced; text/number inputs commit on blur. New `LayerParamsPatch` actor command + Tauri command flow. |

### emit_ffmpeg fix (2026-05-08) — silent export-pipeline bug

While diagnosing the deferred Text-preview failure, the export-side bisection (run the emitted graph through `ffmpeg -filter_complex_script` headless) revealed that **the export pipeline had been broken end-to-end since Phase 1.12**: `emit_ffmpeg` separated filter clauses with `\n` only, but lavfi requires `;` between filterchains. ffmpeg's parser rejected every multi-clause graph with "Trailing garbage after a filter". Existing unit tests only checked string contents and never invoked ffmpeg, so the regression slipped through.

Fix: `emit_ffmpeg` now uses the same `write_clause` helper as `emit_mpv`, which inserts `;\n` between clauses. New regression guard `empty_project_graph_parses_through_ffmpeg` in `ir/mod.rs` runs `ffmpeg -filter_complex_script` against the emitter output (skipped when ffmpeg is absent). Test count: 53 → 54.

### Deliberately deferred (still open)

- **Crossfade / dissolve between two clips.** Per-clip fade-in/fade-out covers "fade-to-black" from the roadmap, but real crossfades need temporal overlap between layers — which violates the `LayerInvariants::no_overlap` rule. Design path: `LayerParams::Transition` variant exempted from overlap, lowering walks the bracketing layers and emits `xfade`. ~150 LoC, judgment call to ship later.
- **mpv drawtext + image-overlay live preview.** Export now works for projects with these layer kinds; live preview through libmpv's bundled libavfilter still fails with `Raw(-13)` for drawtext (unmeasured for image overlays — likely related). Failing graphs + reproduction notes still in `project_text_preview_deferred.md`. Likely a libmpv-specific `--lavfi-complex` quirk on color sources; suspects to try next: drawtext directly on `[vid1]` instead of color base, `--lavfi=` startup option, mpv 0.42 to see if libavfilter version helps.
- **Layer composition order.** Lowering walks layers in track-iteration order, so layers on earlier-iterating tracks become the base. With the default A roll / B roll, text on A roll renders correctly behind video on B roll *only if you put text on B roll*. Either document the convention firmly in the UI or change lowering to top-down composition.

## Phase 3 — Export pipeline (1–2 weeks)

- ffmpeg subprocess driver with progress reporting.
- Export presets: H.264/AAC MP4 1080p, 4K, ProRes MOV, GIF.
- Hardware encoder detection (NVENC, VideoToolbox, QSV, AMF) + automatic selection with software fallback.
- Render queue (multiple exports in series).
- Export progress events to UI.

**Exit criteria:** export a complete project to MP4 with hardware acceleration on the host platform; output plays correctly in VLC and a browser.

### Phase 3 status (2026-05-08)

**COMPLETE** for the listed deliverables. Verification of "plays correctly in VLC and a browser" needs a follow-up sanity export; the export pipeline now actually emits valid lavfi (see emit_ffmpeg fix above) so this is the first time end-to-end MP4 generation has been operational.

| Slice | Status |
|---|---|
| ffmpeg subprocess driver + progress | ✅ from Phase 1.12. Now driving the new preset/HW path. |
| Export presets | ✅ `ExportPreset` enum: `H264Mp4_1080p`, `H264Mp4_4K`, `ProResMov`, `Gif`. ProRes uses `prores_ks -profile:v 3` with PCM s16le; GIF uses two-pass `palettegen` / `paletteuse` via filter-graph suffix appended to the IR's lavfi script. UI dropdown next to Export button picks the preset; default-extension flips automatically. |
| HW encoder detection | ✅ Runtime probe via tiny synthetic encode (`color=...:d=0.1` → encoder → `null`) per candidate, time-boxed to 4s per encoder. Per-platform candidate list: Win=[NVENC, QSV, AMF], macOS=[VideoToolbox], Linux=[NVENC, VAAPI]. Result cached in memory; queue panel shows the recommended encoder. Each H.264 preset call site swaps `libx264` → `h264_<recommended>`. |
| Render queue | ✅ `ExportQueue` actor. In-memory FIFO, single tokio worker. `enqueue / list / remove / clear_finished` Tauri commands; `export:queue` events broadcast on every state change. UI: floating queue panel (top-right) showing per-job status + remove button. Removing a Running job sends a kill signal → `kill_on_drop` terminates ffmpeg. |
| Export progress events | ✅ `export:progress` / `export:complete` / `export:error` from Phase 1.12; new `export:queue` for queue state. |

## Phase 4 — MCP server (2 weeks)

- `rmcp` server, Streamable HTTP, token auth.
- Connect-agent panel UI with snippet generators.
- Read tools + resources: `project://current`, `media://...`, `templates://list`.
- Edit tools (full mutation surface from data-model.md).
- Workflow tools (`checkpoint`, `undo`, `dry_run`).
- SSE change feed.
- MCP activity panel in UI.

**Exit criteria:** Claude Desktop connected, "make a 30-second highlight from this clip" successfully edits the open project.

### Phase 4 status (2026-05-08)

**SUBSTANTIALLY COMPLETE** in six staged commits (`bbd2414` → `4a8fbcb`). The MVP edit surface is live; deliberately-deferred pieces are the ones that hit IR-lowering gaps or rmcp 0.1.x limits.

| Stage | Result |
|---|---|
| 1 — Actor backfill | ✅ `update_marker`, `remove_marker`, `move_track`, `remove_media(force)` with `MediaInUse { referenced_by }` error. 12 new tests. |
| 2 — Read resources | ✅ `project://current/composition/media/tracks/markers/history/compiled` + dynamic `project://layers/{id}` and `project://layers/{id}/effects` (returns `[]` per scope cut). `media://*` and `templates://*` deferred. New `HistoryView`/`HistoryEntrySummary`/`NamedCheckpointSummary` snapshot-free types. |
| 3 — Edit tools | ✅ 17 schemars-derived tools mapping 1:1 to actor commands. Structured `LayerOverlap` and `MediaInUse` errors carry `options[]` per `docs/mcp.md` "Error model" so agents can pick a recovery rather than brick-wall. `JsonSchema` derive cascade onto `Rgba`, `ColorSpace`, `Rational`, all `*Patch` types. |
| 4 — Workflow tools | ✅ `undo`, `redo`, `checkpoint(label)`, `list_checkpoints`, `restore_checkpoint`. |
| 5 — SSE change feed | ✅ Separate axum-backed `/events` endpoint on its own port — sidesteps rmcp 0.1.x's missing per-session notification surface. Pushes `ChangeEventSummary` (no snapshot) per `docs/mcp.md`'s "events are a notification, not a sync protocol". 15s keep-alive + lagged-event hint when the broadcast channel falls behind. |
| 6 — Connect-agent panel UI | ✅ Modal panel showing SSE / events URLs + bearer token (revealable) + copy-ready snippets for Claude Desktop / Cursor / curl. Polls `get_mcp_info` until the server binds. en-US + zh-CN strings. |

Tool count today: **23** (`ping` + 17 edit + 5 workflow). Spec target was ~25; the remainder is the Phase 4.x deferred set.

### Deliberately deferred from Phase 4 (Phase 4.x or beyond)

| Deferral | Where it belongs |
|---|---|
| **Effect / keyframe MCP edit tools** (`add_effect`, `add_keyframe`, etc.) | Phase 4.x. `state/effect.rs` is "Phase 2 scaffolding — types declared, lowering wired later". `ir/lower.rs` evaluates `Animated<T>` static-or-first-keyframe only. Exposing the actor-level surface today would succeed but produce zero visual change — strictly worse than absence. Re-open when the per-frame `Animated<T>` IR pass lands; effect lowering becomes feasible at the same time. See `project_phase4_scope.md`. |
| **`dry_run(operations[])` workflow tool** | Phase 4.x. Needs a `Project::try_apply` pure path or `Command::DryRun` actor variant — not a thin wrapper. Cheaper than it sounds with `imbl` structural sharing, but it's a new architectural piece. Until it lands, agents fall back to "execute one op at a time, course-correct on the structured `LayerOverlap` / `MediaInUse` errors". |
| **Token enforcement on inbound MCP requests** | Phase 4.x or whenever rmcp ships middleware. rmcp 0.1.5's `SseServer` doesn't expose request middleware; localhost-only binding is the actual isolation today. Token is generated and surfaced in the connect panel so the user can paste it into Claude Desktop config (validating the auth flow end-to-end), and we keep it ready for the day enforcement clicks on. Real auth lights up automatically when middleware lands or when the user wants to flip the bind to `0.0.0.0` (which we'd gate behind a confirmation dialog regardless). |
| **`media://{id}/thumbnail` / `media://{id}/frame/{time}` / `media://{id}/waveform`** | Needs Phase 1's deferred proxy/thumbnails/waveform background-job phase. Multimodal agents lose the "see the video" affordance until then; they can still reason structurally via `project://current` + `project://compiled`. |
| **`templates://*` resources, `add_template` tool** | Phase 5 — depends on the rasterized-template runtime. |
| **MCP activity panel in UI** | Quality-of-life polish. No spec dependency on it; Phase 4.x. |
| **MCP prompts** (`/cut-silences`, `/auto-caption`, `/voiceover`, `/highlight-reel`, `/jump-cut`, `/translate-subtitles`) | Phase 4.x for `/cut-silences` and `/highlight-reel` (analysis tools first). `/auto-caption`, `/voiceover`, and `/translate-subtitles` are Phase 6 (cloud transcription + TTS). |

**Strict exit-criteria check** — "Claude Desktop connected, 'make a 30-second highlight from this clip' successfully edits the open project":
- Claude Desktop can connect ✅ — connect-agent panel emits the exact `claude_desktop_config.json` snippet.
- Agent can make a 30s highlight ✅ — `import_media` → `add_video_layer` (multiple slices) → `split_layer` / `delete_layer` for refinement → user clicks **Export…** in the UI (export tools intentionally remain UI-driven; render queue is Tauri-event-driven). Validation rejects map to structured `LayerOverlap` options the agent can resolve.

### Verification owed

- Real Claude Desktop end-to-end smoke: connect using the panel snippet and run a tool round-trip. Local-LAN testing only — production-grade is post-token-enforcement.

## Phase 5 — Rasterized templates (2–3 weeks)

- Offscreen `wry` worker, time-mock JS shim, platform capture APIs (Win + macOS first; Linux fallback decision).
- Job queue + worker pool.
- PNG-sequence cache (sled + filesystem, LRU eviction).
- Template loader + manifest validator (`schemars` against `props_schema`).
- 8 built-in templates (lower thirds, title cards, captions, callouts, progress bar, countdown, logo bug, slate).
- IR `PngSeq` node + lowering for `Template` layers.
- MCP `add_template` tool + `templates://` resources.

**Exit criteria:** agent picks a template, fills props, sees it appear on the timeline within seconds; preview matches export pixel-for-pixel.

## Phase 6 — Cloud transcription + TTS + auto-caption / voiceover (1–1.5 weeks)

Cloud-side AI lives behind a provider-agnostic trait surface so the agent
sees capabilities ("transcribe this clip", "synthesize this line") rather
than vendor names. v1 ships one transcription provider and one TTS
provider; the abstraction is what makes adding a second of either trivial
later.

Surfaces:
- **Transcription** (`Transcriber` trait): audio → SRT with timestamps.
  v1 provider: OpenAI Whisper. Provider slot already wired (Stage 1).
  Future: Deepgram, AssemblyAI — drop-in once trait is settled.
- **Text-to-speech** (`Synthesizer` trait): text + voice → audio file.
  v1 provider: OpenAI tts-1 (same key reuses the OpenAI keyring slot).
  Future: ElevenLabs, Deepgram Aura.

Stages (advisor-blessed sequence; numbers are cumulative):
1. ✅ **Keyring + Settings UI** (commit `9b84059`). `cloud/keys.rs` with
   `Provider::OpenAi` enum, 3 Tauri commands
   (`settings_set/clear/get_api_key_status` — never returns key material
   on read), `SettingsPanel.tsx` modal with reveal-free password entry,
   configured/not-configured badge, EN + zh-CN strings. Keyring service
   `"videtor"`, username = lowercase provider tag. Panel iterates
   `Provider::all()` so it scales to N variants automatically.
2. ✅ **Inline-subtitle materialization pass** (commit `8cf55f6`).
   `ir/materialize.rs` walks every Subtitles layer with an inline body,
   blake3-hashes, writes atomically (`temp_path → write → promote_temp`)
   to `<cache>/inline-subs/<hash>.<srt|ass>`. Output is
   `imbl::HashMap<LayerId, PathBuf>` threaded into `lower()` as a third
   arg; the lower step stays pure. Five call sites updated
   (`compile_project`, `mpv_preview_project`, `project://compiled`, mpv
   hot-reload, export `run_render`). Persistence unchanged — `.vproj`
   keeps `InlineSrt(String)`. End-to-end smoke test invokes real ffmpeg
   through materialize → lower → emit_ffmpeg.
3. ✅ **`apply_subtitles` MCP tool** (commit `05fa8df`). Body-based
   contract — agent passes the SRT/ASS document inline, not a path, so
   `transcribe_clip` returns the body and the agent can inspect/edit
   before applying. Format auto-sniffed (`[Script Info]` → ASS, else
   SRT, BOM-tolerant) when omitted. Auto-finds or creates a Subtitle
   track via new `VidetorServer::ensure_subtitle_track` (mirrors the
   Tauri-command behavior so both surfaces target the same track).
   Stage 3 is a thin wrapper — heavy lifting lives in Stage 2.
4. ✅ **Cloud client foundation**. `cloud/{transcriber, synthesizer,
   errors, http, audio_extract}.rs` ship: `Transcriber` and `Synthesizer`
   async-trait surfaces with owned-data request/response structs (no
   borrowed lifetimes — keeps `Box<dyn Transcriber>` clean), shared
   `reqwest::Client` singleton with a 180s default timeout and pinned
   User-Agent, `CloudError` enum covering MissingKey / InvalidKey /
   RateLimited / PayloadTooLarge / Provider / Network / Io / AudioExtract.
   `audio_extract::extract_audio_window(cache, source, source_hash, in_us,
   out_us)` slices through ffmpeg to mono 16 kHz 16-bit PCM WAV, content-
   addressed to `<cache>/transcribe-audio/<hash>.wav` where `hash =
   blake3([source_hash.bytes, in_us.le, out_us.le].concat())`. Shares
   `jobs::ffmpeg_sem()` (now `pub(crate)`) with background derivative jobs.
   Per-provider `Capabilities { transcription, tts }` lives on `Provider`
   in `keys.rs`. End-to-end smoke `audio_extract_window_roundtrip_against_
   real_ffmpeg` cracks the WAV header to verify mono / 16 kHz / 16-bit.
   No provider impls and no `pick_*` picker in this stage — both land in
   Stage 5. 100 → 109 lib tests. New dep: `async-trait` (required for
   dyn-compatible async methods on stable).
5. ✅ **OpenAI Whisper transcription** + `transcribe_clip` MCP tool.
   `cloud/providers/openai.rs` ships `OpenAiWhisper` (multipart POST to
   `/v1/audio/transcriptions`, `response_format=srt`, optional `language`
   forwarded as ISO-639-1). HTTP status mapping: 401 → `InvalidKey`,
   413 → `PayloadTooLarge { cap: 25 MB }` (also pre-checked client-side
   so the agent gets the error before the upload starts), 429 →
   `RateLimited { retry_after_s: <header> }`, 5xx + others →
   `Provider { message: "<status> <reason>: <body[..400]>…" }`.
   `cloud::pick_transcriber()` walks `Provider::all() → capabilities →
   has_key → first match`; returns `None` when nothing's configured so
   the tool errors with a "configure Settings → API keys" hint.
   `cloud/srt.rs` shifts SRT cue timestamps forward by the timeline-
   absolute slice start (line-tolerant, CRLF-preserving, accepts `,`
   or `.` as the decimal separator on parse, emits canonical `,`).
   `transcribe_clip { layer_id, t_start_us?, t_end_us?, language? }`
   resolves a VideoClip or Audio layer, validates the window is inside
   the layer, maps timeline offset → source coords via `src_in_us +
   (t - layer.t_start_us)`, calls `audio_extract::extract_audio_window`
   to materialize the mono 16 kHz WAV, hands to the picked transcriber,
   shifts cues, returns the body inline. VideoClip layers with
   `speed != 1.0` are rejected with `split off a speed-1 segment first`
   (the source-coord math is only correct at speed=1; mirrors the
   `split_layer` precedent). 109 → 133 lib tests (+11 SRT shift,
   +5 provider HTTP-error mapping, +8 MCP resolve_clip_audio_source).
6. ✅ **OpenAI TTS** + `synthesize_speech` MCP tool. `OpenAiTts` lives
   alongside `OpenAiWhisper` in `cloud/providers/openai.rs`; same key,
   same HTTP-status mapping. JSON POST to `/v1/audio/speech` with
   `model=tts-1, response_format=mp3, input, voice, speed?`. Pre-flight
   checks reject empty text, text past 4096 chars, unknown voice, and
   speed outside `[0.25, 4.0]` BEFORE the API call. `cloud::pick_synthesizer()`
   mirrors `pick_transcriber`. Cache layout adds `<cache>/voiceover/<hash>.mp3`;
   hash composition is `blake3(model || '\0' || lowercase(voice) || '\0'
   || speed-or-"default" || '\0' || text)` so repeat synthesize calls
   skip the API entirely. `synthesize_speech { text, voice, speed?,
   target_track_id?, t_start_us? }`: checks cache → calls synthesizer on
   miss → atomic write to `<cache>/voiceover/...` → ffprobe for duration
   → constructs MediaItem with `file_hash_blake3` = cache key → adds to
   media pool → ensures/uses Audio track → adds Audio layer at
   `t_start_us` (default = `composition.duration_us`, so voiceover
   appends at end) with `t_end_us = t_start + duration`. Returns
   `{ layer_id, media_id, t_start_us, t_end_us, cached }`. Cache hits
   skip the API and the `cached: true` flag tells agents the result
   came from cache (no billing). 133 → 138 lib tests (+5 TTS pre-flight
   + cache-key determinism).
7. ✅ **MCP prompts**: `/auto-caption` (transcribe → apply_subtitles) and
   `/voiceover` (synthesize_speech for a script with a single voice).
   `mcp/prompts.rs` ships the catalog + per-call expansion. `auto-caption`
   takes `layer_id` (required) and optional `language`; the expanded
   user-role message walks the agent through `transcribe_clip` →
   inspect → `apply_subtitles` (with the explicit "omit `t_start_us` so
   cues self-position" reminder). `voiceover` takes `script` + `voice`
   (required), optional `speed` and `target_track_id`; expansion
   embeds the script verbatim and tells the agent to split at paragraph
   boundaries if it exceeds tts-1's 4096-char cap. Both prompts close
   with the missing-key recovery hint ("configure Settings → API
   keys"). `ServerCapabilities::builder().enable_prompts()`, plus
   `ServerHandler::list_prompts` (returns the catalog) and `get_prompt`
   (delegates to `prompts::expand`). 138 → 146 lib tests (+8 covering
   catalog shape, unknown-prompt rejection, required-arg enforcement,
   and arg interpolation for both prompts).
8. ✅ **Hardening**.
   - **Retries**: `cloud::http::retry_delay_for_status` returns `Some(delay)`
     for 408 / 429 / 5xx. 429 prefers the `Retry-After` header capped at
     10s; 408 / 5xx use exponential backoff (500ms → 1s → 2s → 4s → 8s,
     saturating at attempt 4). `MAX_RETRY_ATTEMPTS = 3` (1 initial + 2
     retries). `RETRY_TOTAL_BUDGET = 45s` bounds *between-retry* sleeps,
     not a wedged single attempt (that's the `shared_client` 180s per-
     request timeout). Loop lives in each provider's `transcribe` /
     `synthesize` method so the body can be rebuilt per attempt (multipart
     `Form` isn't cheaply cloneable).
   - **Test connection**: `cloud::test_connection(provider)` does a cheap
     GET to OpenAI's `/v1/models`, returns a `ConnectionTestInfo` with a
     one-line summary ("N models available"). New Tauri command
     `settings_test_provider` and a "Test" button in `SettingsPanel.tsx`
     surface this inline (green ✓ summary, red ✗ message). Catches
     invalid keys + rate-limit / network issues BEFORE the first agent
     call.
   - **Missing-key tool gating** *deferred* (scope gap, see `cloud/mod.rs`
     doc comment near `pick_transcriber`): rmcp 0.1.x's `tool_box` macro
     generates `list_tools` from compile-time registration with no per-
     session filtering hook. Tools currently return structured `MissingKey`
     errors when called without a configured provider; the prompts and
     tool descriptions reference Settings. Revisit when rmcp gains
     per-session tool filtering.
   - 146 → 151 lib tests (+5 retry-decision: permanent 4xx, Retry-After
     honored + capped at 10s, exponential fallback when no header, 5xx
     uses exponential, exponent saturates at attempt 4).

Provider model: keyring slot is keyed by **API provider** (`OpenAi`,
`Deepgram`, `ElevenLabs`, ...), not by feature surface. A single OpenAI
key covers both Whisper and tts-1. Each provider declares which surfaces
it supports (`Capabilities { transcription: bool, tts: bool }`); the
default-provider picker for each tool falls back to the first configured
provider that can serve the surface.

**Exit criteria:**
- `/auto-caption` adds correctly-timed subtitles to a 5-minute clip.
- `/voiceover` produces an audio layer from an agent-supplied script,
  played back in preview at the right place on the timeline.
- Adding a second transcription provider (Deepgram) is a single-file
  change against `cloud::Transcriber` — proven by spiking it in a
  branch (don't ship in v1).

## Phase 7 — Polish (2 weeks)

- Undo/redo UI (history panel showing per-actor edits).
- Checkpoints UI (named save points, agent rollback affordance).
- Error toasts with structured-error options ("Create new track" / "Trim existing").
- Onboarding tour.
- App icon, splash, About dialog.
- Crash reporter (opt-in, Sentry or local).

**Exit criteria:** dogfood for one week without major friction.

## v1 ship checklist

- [ ] Phases 0–7 complete on Win + macOS.
- [ ] Linux: feature-complete OR documented degraded mode (e.g., headless-Chromium rasterizer).
- [ ] CI green: build + lint + unit + integration on all platforms.
- [ ] Code signing on Win + macOS.
- [ ] Auto-update wired (`tauri-plugin-updater`).
- [ ] Docs site live with Getting Started + agent connection guides.
- [ ] At least one third-party MCP client tested (Cursor or Cline alongside Claude Desktop).

## Total v1 estimate

**~4 months** for one focused developer who's comfortable with both Rust and the audio/video domain. **6+ months** if either is new. Phases 0–3 are the load-bearing foundation; everything else is incremental given those are solid.

## Post-v1 (not committed)

- Tree-of-edits history (branch, merge).
- WebGPU compositor backend (alternative to ffmpeg for real-time effects).
- Marketplace / sharing for HTML overlay templates.
- Multi-window timelines.
- Mobile companion (Tauri mobile or React Native).
- Remote-server MCP variant (Tailscale-friendly) with proper auth.
- Plugin system for third-party effects via WebAssembly.
- Collaboration (CRDT-based shared editing).
