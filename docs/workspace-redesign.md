# Workspace Redesign

> **Status:** All four phases + dep upgrade pass + live-verification polish
> shipped 2026-05-13 / 2026-05-14. Supersedes parts of
> [`data-model.md`'s on-disk format](data-model.md) and the
> [Phase 1 libmpv embed model](roadmap.md#phase-1--editor-mvp-45-weeks).
>
> | Phase | Commits |
> |---|---|
> | A — workspace foundation (cache per-workspace, path_rel anchor, auto-save, migration) | `902ad93`, `5e10593` |
> | B — startup screen (Create / Open / Recent + recents.json + new-project form) | `c5e528b` |
> | C — import polish (background copy, missing-media badges, derivatives pill) | `6f943be` |
> | D — preview overhaul (DOM `<video>` + state-hashed MP4, delete libmpv embed) | `9e23046`, `3cb42d2` |
> | docs — mark phases shipped + tie off obsolete libmpv memories | `2982b3c` |
> | E — dep upgrade pass (tauri 2.5→2.11, libmpv2 4→6, reqwest 0.12→0.13, ts-rs 10→12) | `067c69c` |
> | live-verification polish — startup locale toggle + new-project rewrite | `22f6c6a` |
> | live-verification polish — async `state_hash` + silent `run_render` + RAF playhead | `81bc02b` |
>
> **All five residual-risk flows verified end-to-end against a real dev
> build** (startup screen, "+ New project", recents persistence, import
> + preview render, legacy `.vproj` migration — last one moot per "no
> install base"). See "Live-verification log" near the bottom of this
> doc for the fixes that came out of that pass.
>
> Cross-cutting work — affects state, IO, cache, raster, mpv, raster preview,
> jobs, MCP. Targets the 4 user-facing problems below; resolves them via 10
> design decisions and a 4-phase rollout.

## What this fixes

Four problems the current data flow papers over:

1. **No startup screen.** The app always opens into a blank `Project::new_blank("untitled")`. There's no Create / Open / Recent choice — you only ever discover that you *can* open a project once you find the menu item.
2. **Media references break easily.** Today `MediaItem.path_abs` is an absolute path to wherever the user imported from. Move the source, the project breaks. Workspaces aren't portable.
3. **No visible "loading" model.** On `Open`, the editor pops up with the project mounted, but proxies / thumbnails / waveforms appear lazily as the UI touches them — users have no signal that anything is happening, and no way to know what's missing.
4. **libmpv preview overlaps DOM.** The embed HWND sits above WebView2 in z-order. Every menu / modal has to `useHideMpvHost` or `useMpvHostClip` to be visible. The new auto-init preview UX (shipped `670eb28`) inherits the same trap: spinners, error banners, and the empty-state placeholder all render behind a black HWND.

This redesign is the structural fix. After it lands, the project is a folder you can zip, the load flow is honest about what's happening, and the preview is a DOM `<video>` element.

## Design decisions (the 10)

Each was a binary/multi-choice with rationale during the grill. Quoted here so future readers know *why* the shape is what it is.

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Workspace ownership model | **B** — workspace owns the media | Self-contained project; zip-and-ship works. |
| 2 | Import operation | **A** — always copy | Workspace truly owns its bytes. No link footguns. |
| 3 | Derivatives location | **A** — in workspace `Cache/` | Symmetric with Q2. `cache/mod.rs` header already foresaw this. |
| 4 | Folder structure | **A** — minimal flat + on-demand A/V demux | Mirrors today's cache paths; demux is cheap per-use. |
| 5 | Open-workspace flow | **B** — critical-only blocking, derivatives in background | Editor opens fast; missing media surfaces inline, not in a modal. |
| 6 | Import-during-editing UX | **B** — background job, cancellable, single-worker FIFO, probe-original-first | Editor stays live during 50GB copies. Mirrors `ExportQueue`. |
| 7 | Startup screen | **A** — minimal Create / Open / Recent | Smallest correct thing. Avoids Resolve-style overkill. |
| 8 | Save model | **C** — auto-save + periodic `Backups/` + force-flush Cmd-S | Folder is the truth; no lost-work surprises; checkpoint snapshots for "go back further than undo." |
| 9 | Migration of legacy `.vproj` | **A** — auto-migrate on open with prompt + pre-migration backup | One-time pain; reuses `import_media`. |
| 10 | Preview architecture | **A** — DOM `<video>` + `Cache/preview/` MP4 renders + per-clip proxies | Removes libmpv from the project preview entirely; eliminates z-order class. |

## On-disk layout

```
<workspace>/
├── project.json          ← live state, auto-saved (Q8)
├── schema_version
├── Media/                ← imported originals, always-copied (Q2)
│   ├── interview.mov
│   └── b-roll-001.mp4
├── Cache/                ← all derivatives (Q3), workspace-scoped
│   ├── proxies/          ← 540p H.264 proxies per source
│   ├── thumbnails/       ← per-source thumb strips
│   ├── waveforms/        ← .peaks files
│   ├── frames/           ← on-demand video frames
│   ├── raster/           ← template/text renders
│   ├── preview/          ← state-hashed preview MP4s (Q10)
│   └── voiceover/        ← TTS output
├── Backups/              ← periodic project.json snapshots (Q8)
└── Renders/              ← export outputs default here
```

`MediaItem.path_rel` becomes authoritative; `path_abs` is computed at use time as `workspace.join(path_rel)`. The OS-level app-cache `CacheLayout` (today's `cache/mod.rs`) goes away — every cache is rooted at a workspace.

## Flow specs

### Startup (Q7)

App boots into a Create / Open / Recent screen. There is **no** editor-without-workspace state. Settings toggle "Reopen last project on launch" defaults to **off**.

- **New project**: name + parent folder + canvas preset (1080p/30, 1080p/60, 4K/30, custom). Creates `parent/<name>/` and writes a blank `project.json`.
- **Open**: native folder picker → validates `project.json` exists → loads.
- **Recent**: last 10 workspaces in `app_config_dir/recents.json`. Click to open. Missing path → toast "Not found — remove from list?".

### Open flow (Q5, Q9)

1. Read `project.json` + `schema_version` (blocking, ms).
2. If schema older than current → modal: *"This project predates the workspace format. Migrate now? This will copy N media files (~X GB) into the project folder."* On accept: write `Backups/pre-migration.json`, enumerate `MediaItem`s, copy each `path_abs → workspace/Media/`, set `path_rel`, bump schema, save.
3. Validate `Media/` references: every `path_rel` exists, `file_size` matches, `file_mtime` matches. Anything off → badge that pool item; **editor opens anyway**.
4. Kick off background jobs for any missing derivative in `Cache/`.
5. Editor renders. Top-of-window unobtrusive indicator: *"Generating proxies (3 of 12)…"* drains as jobs complete.

Open-to-editor target: **<500ms** regardless of project size.

### Import flow (Q6)

Always background, single-worker FIFO, cancellable.

1. Probe + hash from the *original* path → `MediaItem` populated, pool entry appears immediately marked `importing`.
2. Background worker copies original → `workspace/Media/<filename>` via `.tmp` rename pattern.
3. On success: pool entry transitions to `ready`; `jobs/proxy.rs`, `jobs/thumbnails.rs`, `jobs/waveform.rs` fire.
4. Cancel: delete partial `.tmp`, remove the pool entry.

Layers can already reference a still-copying media: render attempts fall through `not_ready` until the copy lands, identical to today's thumbnail / waveform pattern.

### Save model (Q8)

- Every commit triggers a 500ms-debounced write to `project.json`.
- Every 50 commits *or* 5 minutes (whichever first) copies `project.json` to `Backups/<ISO-timestamp>.json`; retain last 20.
- `Cmd-S` force-flushes + snapshots (explicit user checkpoint).
- Close requires no prompt — state is always saved.
- Crash recovery: if `.writing.lock` exists on open, fall back to most recent `Backups/*.json`.

Undo/redo stays in-memory (`state/history.rs`). Backups are *outside* the undo chain — they're the recovery surface for "go back further than the in-memory history kept."

### Preview architecture (Q10)

libmpv is removed from the project-preview data path. Replaced by `<video>` element + background MP4 renders:

- On every commit, debounced 1s, render the current state to `workspace/Cache/preview/<state_hash>.mp4` using the existing ffmpeg export pipeline.
- Per-clip **540p H.264 proxies** generated on import (`jobs/proxy.rs`). The preview composition feeds proxies, not originals. Export still uses originals.
- Cache key: `blake3(canonical_lavfi_complex || proxy_path_hashes || canvas_w || canvas_h || fps_num || fps_den)`. Hit → instant `src` swap, no ffmpeg call.
- `<video>` element points at the latest preview MP4; on new render, swap `src`, restore playhead, restore paused-state.
- A/V sync, hardware decode, audio playback — native browser.
- Stale MP4 stays playable while a re-render is in flight; small "rebuilding…" indicator in the surface; new MP4 lands → swap.
- Initial granularity: whole-project render. Per-segment + MSE streaming is a later optimization when long-project pain shows.

**Deleted in Phase D:** `mpv_preview_project`, the embed HWND code (`create_host_hwnd`, `set_surface_rect`, `set_host_visible`, `set_host_clip`), `useHideMpvHost`, `useMpvHostClip`, the surface-rect sync effect in `App.tsx`. `mpv_play_media` (media-pool popup, standalone window, no z-order issue) survives for now — replaced by a `<video>` modal later.

## Phased rollout

Sequenced to minimize user-visible disruption. Each phase is independently shippable; the libmpv embed stays alive until Phase D ships so preview never breaks during the migration.

### Phase A — workspace foundation (invisible plumbing)

No UX changes. Plumbing only. Order:

1. **A.1** — Refactor `CacheLayout` to take a workspace root. Defer cache creation until a project is opened. Existing OS-app-cache wiring removed from `lib.rs` setup.
2. **A.2** — `path_rel` becomes authoritative. Add a `resolve_media_path(workspace, item) -> PathBuf` helper. Update every consumer: IR materialization (`ir/materialize.rs`), media-pool snapshot, ffmpeg input emit, raster cache lookups, thumbnail/waveform job kicks.
3. **A.3** — Auto-save subscriber: spawn a task on actor `subscribe()`, debounce 500ms, write `project.json`. Snapshot writer: every 50 commits or 5 min, copy current `project.json` → `Backups/<ISO-timestamp>.json`, GC keep-last-20.
4. **A.4** — Migration on `load_from_dir`: detect `schema_version < N`, run import-copy loop, bump version, write pre-migration backup first.
5. **A.5** — Bump `SCHEMA_VERSION` constant. Update existing io tests + add migration round-trip tests.

Exit: existing app behavior unchanged; new workspace folder structure populated correctly for any new project; legacy `.vproj` files auto-migrate on open.

### Phase B — startup screen

Pure additive: new screen, old menu Open/Save-as still works.

1. **B.1** — `apps/desktop/src/startup/StartupScreen.tsx`: Create / Open / Recent layout. Replaces `App` until a workspace is chosen.
2. **B.2** — `recents.json` reader/writer in `app_config_dir`. New project form (name + parent folder + canvas preset).
3. **B.3** — Wire startup → editor transition. Remove the `Project::new_blank("untitled")` boot path; app always begins on the startup screen.
4. **B.4** — Settings toggle: "Reopen last project on launch" (off by default).

Exit: app boots into startup screen; can create + open workspaces from it; recents work; old menu items still function as escape hatches.

### Phase C — import + open polish

Make the load and import flows match the new model.

1. **C.1** — Background-copy import worker (mirrors `ExportQueue`). Pool entry shows `importing` state with cancel button.
2. **C.2** — Missing-media badges on pool items (red dot + tooltip); right-click → "Relink…" (deferred to later phase).
3. **C.3** — Top-of-window "Generating proxies (X of Y)…" indicator subscribed to the existing `media:job_complete` event bus.
4. **C.4** — `not_ready` paths for thumbnails / waveforms / preview play attempts route through a single "media derivative pending" treatment in the UI.

Exit: open flow shows progress; import is non-blocking + cancellable; missing-media is honest about itself.

### Phase D — preview overhaul (the headline)

The libmpv-overlap problem dies here.

1. **D.1** — Preview renderer: a function that takes a `Project` snapshot, computes the state hash, and either returns the cached `Cache/preview/<hash>.mp4` or kicks an ffmpeg job to produce it. Reuses `export/preset.rs` machinery; uses proxies as inputs.
2. **D.2** — Debounced render trigger: subscribe to actor commits, 1s debounce, fire `render_preview()`. Coalesces rapid edits.
3. **D.3** — React `<video>` preview component: pointed at the latest preview MP4; swaps `src` when a new render is ready; restores playhead + paused-state across swaps; small "rebuilding…" indicator while a re-render is in flight.
4. **D.4** — Delete libmpv embed code path:
   - Rust: `mpv_preview_project`, `mpv_close_preview`, `mpv_set_surface_rect`, `mpv_set_host_visible`, `mpv_set_host_clip`, `create_host_hwnd`, `MpvSlot` host_hwnd registration, the hot-reload subscriber, the `mpv:time` poller.
   - React: `useHideMpvHost`, `useMpvHostClip`, the `videoSurfaceRef` ResizeObserver effect, `mpvPreviewProject` import + auto-init effect + state machine.
   - i18n: `preview.preparing` / `preview.init_failed` / `preview.retry` stay (they fit the new model too); `transport.preview_*` already deleted in `670eb28`.
5. **D.5** — Per-clip proxy generation: complete `jobs/proxy.rs` if any gaps; ensure preview renderer uses proxy paths.
6. **D.6** — Audit `useHideMpvHost` / `useMpvHostClip` call sites and remove (they become no-ops then can be deleted).

Exit: libmpv embed code removed from the project preview path; project preview is a DOM `<video>`; menus and modals no longer need to dance around the libmpv HWND; the auto-init UX shipped in `670eb28` is replaced by render-on-commit.

## Open / deferred decisions

- **Cross-workspace media library** (deduped shared assets across projects): deferred. Compromises Q2's self-containment promise. Can layer on as a Settings option later (`shared_media_libraries: PathBuf[]`).
- **Per-segment preview cache + MSE streaming**: deferred until long-project edit-to-preview latency becomes a real problem. Whole-project render is fine for <2min projects with proxies.
- **Cross-platform libmpv removal**: Phase D removes the project preview's dependency on libmpv on Windows. macOS/Linux project previews use the standalone window (no embed work was ever done) — those just stop opening a window once Phase D lands. The media-pool `mpv_play_media` popup survives until later cleanup.
- **Hardlinks / symlinks as an opt-in**: deferred. Q2 chose pure copy; a "link instead" toggle can come later as an advanced Settings option if disk pressure becomes a real complaint.
- **`relink` UX for missing media**: badged in Phase C, but the actual right-click → file-picker → reassign-by-content-hash flow is its own small project.

## Live-verification log (2026-05-14)

The plan was structurally complete after Phase D landed, but cargo tests
and tsc don't catch UI-level wrong-ness. A residual-risks pass walked
five flows in the running dev build:

1. **Startup screen first paint** — ✅ passed.
2. **"+ New project" flow** — surfaced two UX gaps:
   - i18n toggle button was only in the editor header → first-launch
     users on a foreign locale couldn't switch before they could read
     the buttons. Added top-right locale toggle to the startup screen
     mirroring the editor's `cycleLocale`. Commit `22f6c6a`.
   - The save-dialog flow felt like the name was buried inside folder
     creation. Rewrote `NewProjectForm` (grill-me design pass):
     two-row form with a separate **Project name** input (autofocused,
     empty, live validation against `\ / : * ? " < > |` + reserved
     names + trailing dot / whitespace) and a **Save in** parent
     picker. Pre-fills "Save in" with the parent of the last project
     created (persisted in `recents.json` as
     `last_new_project_parent`); first launch falls back to
     `documentDir()`. Path preview `→ <parent>/<name>` updates live.
     Commit `22f6c6a`.
3. **Recents persistence across restarts** — ✅ passed.
4. **First import + preview render** — surfaced three bugs:
   - `preview::state_hash` called `tauri::async_runtime::block_on(
     materialize_templates(...))` from inside the preview-loop tokio
     task — a deadlock-or-panic anti-pattern that silently killed the
     renderer task on the first commit. No `preview:render_*` events
     surfaced. Native `.await`; the loop survives. Added a
     `preview renderer subscribed; waiting for commits` log so
     "is the renderer alive" is observable. See
     [[feedback_async_block_on_in_async]]. Commit `81bc02b`.
   - `preview::render` called `export::run_render`, which emits
     `export:complete` — the React `<ExportPanel>` popped up an
     "Exported to ..." toast on every preview render and couldn't
     stay dismissed. Split: `run_render` (event-emitting, for user
     exports) wraps `run_render_inner` with an `emit_events: bool`;
     new `run_render_silent` is the no-emit wrapper for preview's
     use. Commit `81bc02b`.
   - Timeline playhead jerky during playback because the HTML5
     `timeupdate` event only fires at ~4 Hz. PreviewSurface now starts
     a `requestAnimationFrame` pump on `onPlay` (~60 Hz updates) and
     cancels on `onPause`. Final sync on pause so the playhead lands
     exactly where the video stopped. Commit `81bc02b`.
5. **Migration of legacy `.vproj`** — moot. The project has never been
   released; no install base exists. `io::migrate::tests` covers the
   v1→v2 code path; the live "open a real legacy project from disk"
   test would have been belt-and-suspenders for a population that
   doesn't exist. Migration code stays as schema-bump insurance for
   future v2→v3 work.
