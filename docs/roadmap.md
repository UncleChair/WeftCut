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

## Phase 2 — Native overlays (2 weeks)

- `ImageOverlay` layer (ffmpeg `overlay`).
- `Text` layer with `DrawText` backend (font, color, outline, shadow).
- `Subtitles` layer (ASS/SRT via ffmpeg `subtitles`/`ass`).
- Built-in transitions via `xfade` (crossfade, dissolve, fade-to-black).
- Property panel UI for each layer type.

**Exit criteria:** add a title, a logo, captions, and a fade transition.

## Phase 3 — Export pipeline (1–2 weeks)

- ffmpeg subprocess driver with progress reporting.
- Export presets: H.264/AAC MP4 1080p, 4K, ProRes MOV, GIF.
- Hardware encoder detection (NVENC, VideoToolbox, QSV, AMF) + automatic selection with software fallback.
- Render queue (multiple exports in series).
- Export progress events to UI.

**Exit criteria:** export a complete project to MP4 with hardware acceleration on the host platform; output plays correctly in VLC and a browser.

## Phase 4 — MCP server (2 weeks)

- `rmcp` server, Streamable HTTP, token auth.
- Connect-agent panel UI with snippet generators.
- Read tools + resources: `project://current`, `media://...`, `templates://list`.
- Edit tools (full mutation surface from data-model.md).
- Workflow tools (`checkpoint`, `undo`, `dry_run`).
- SSE change feed.
- MCP activity panel in UI.

**Exit criteria:** Claude Desktop connected, "make a 30-second highlight from this clip" successfully edits the open project.

## Phase 5 — Rasterized templates (2–3 weeks)

- Offscreen `wry` worker, time-mock JS shim, platform capture APIs (Win + macOS first; Linux fallback decision).
- Job queue + worker pool.
- PNG-sequence cache (sled + filesystem, LRU eviction).
- Template loader + manifest validator (`schemars` against `props_schema`).
- 8 built-in templates (lower thirds, title cards, captions, callouts, progress bar, countdown, logo bug, slate).
- IR `PngSeq` node + lowering for `Template` layers.
- MCP `add_template` tool + `templates://` resources.

**Exit criteria:** agent picks a template, fills props, sees it appear on the timeline within seconds; preview matches export pixel-for-pixel.

## Phase 6 — Cloud transcription + auto-caption (1 week)

- Whisper API client (OpenAI + optional Deepgram).
- API key storage in OS keyring.
- `transcribe_clip` MCP tool returning ASS.
- `/auto-caption` MCP prompt: chains transcribe → `apply_subtitles`.
- Settings UI for keys.

**Exit criteria:** "/auto-caption" in Claude Desktop adds correctly-timed subtitles to a 5-minute clip.

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
