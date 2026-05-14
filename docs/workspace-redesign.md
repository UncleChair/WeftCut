# Workspace Redesign — shipped log

> **Status:** Phases A–D + dep upgrade pass + live-verification polish shipped 2026-05-13 / 2026-05-14. This doc is the retrospective record. Current-state spec lives in the relevant per-topic docs:
>
> - On-disk format + `MediaItem` semantics — [`data-model.md`](data-model.md)
> - Component map + data flow + preview surface — [`architecture.md`](architecture.md)
> - Preview render path + state-hash + proxy substitution — [`rendering.md`](rendering.md)

## Commits

| Phase | Commits |
|---|---|
| A — workspace foundation (cache per-workspace, `path_rel` anchor, auto-save, migration, schema v2) | `902ad93`, `5e10593` |
| B — startup screen (Create / Open / Recent + recents.json + new-project form) | `c5e528b` |
| C — import polish (background copy, missing-media badges, derivatives pill) | `6f943be` |
| D — preview overhaul (DOM `<video>` + state-hashed MP4) + libmpv embed deletion | `9e23046`, `3cb42d2` |
| docs — mark phases shipped + tie off obsolete libmpv memories | `2982b3c` |
| E — dep upgrade pass (tauri 2.5→2.11, libmpv2 4→6, reqwest 0.12→0.13, ts-rs 10→12) | `067c69c` |
| polish — startup locale toggle + new-project rewrite (live-verification round 1) | `22f6c6a` |
| polish — async `state_hash` + silent `run_render` + RAF playhead (live-verification round 2) | `81bc02b` |

## What it fixed

Four cumulative problems forced a structural fix:

1. **No startup screen** — app opened into a blank `Project::new_blank("untitled")`. No discoverability for Create / Open / Recent.
2. **Brittle absolute-path media refs** — `MediaItem.path_abs` was authoritative; moving the source file broke the project. Workspaces weren't portable.
3. **No visible "loading" model** — derivatives appeared as the UI touched them; users had no signal that anything was happening or what was missing.
4. **libmpv HWND z-order trap** — the embed HWND sat above WebView2; every DOM overlay needed `useHideMpvHost` / `useMpvHostClip` to be visible. The full spectrum of DOM-composition tricks (rounded corners, scrollable regions, translucent panels) was unavailable.

## The ten design decisions (resolved via grill-me, 2026-05-13)

1. **Workspace owns the media** — the folder *is* the project.
2. **Always copy** on import — workspace owns its bytes (no hardlinks, no references).
3. **All derivatives in the workspace** — `<workspace>/Cache/` (not OS app-cache).
4. **Flat folder layout** — `Media/`, `Cache/`, `Backups/`, `Renders/`. A/V demux is on-demand into `Cache/`.
5. **Open is non-blocking** — editor opens fast; derivatives stream in; missing-media gets inline badges.
6. **Import is a cancellable background job** — single-worker FIFO; pool entry appears immediately with `importing` state.
7. **Startup screen is minimal Create / Open / Recent** — no Resolve-style project manager.
8. **Auto-save + periodic `Backups/`** — 500 ms debounce on commits; snapshot every 50 commits or 5 min, retain 20.
9. **Legacy `.vproj` auto-migrates on open** — pre-migration backup → copy externals into `Media/` → set `path_rel` → bump schema.
10. **Project preview switches to DOM `<video>`** — state-hashed MP4 in `Cache/preview/<hash>.mp4`; per-clip 540p proxies as render inputs. libmpv leaves the project-preview data path entirely.

## Live-verification log (2026-05-14)

After cargo tests + tsc were clean, a residual-risks pass walked each user-facing flow in the running dev build. Surfaced five bugs:

- **Startup locale toggle missing** — first-launch users on a foreign locale couldn't switch language before they could read the buttons. Added top-right toggle on the startup screen mirroring the editor header. `22f6c6a`.
- **Save-dialog UX confusion** — the "name in filename field" save-dialog flow felt like naming was buried inside folder creation. Rewrote `NewProjectForm` to a two-row layout: separate **Project name** input (autofocused, empty, live validation against `\ / : * ? " < > |` + Windows-reserved names + trailing dot / whitespace) + **Save in** parent picker (pre-fills with the parent of the last project; first-launch falls back to `documentDir()`). Live path preview `→ <parent>/<name>` under the inputs. `22f6c6a`.
- **`preview::state_hash` killed the renderer task** — was sync and called `tauri::async_runtime::block_on(materialize_templates(...))` from inside the preview-loop tokio task. That deadlock-or-panic anti-pattern silently killed the task on the first commit. Zero `preview:render_*` events ever surfaced. Native `.await` fixes it. See `feedback_async_block_on_in_async` memory. `81bc02b`.
- **Export-event leak into preview** — `preview::render` called `export::run_render`, which emits `export:complete`. The React `<ExportPanel>` popped a "Exported to ..." toast on every preview re-render and couldn't stay dismissed. Split `run_render` into a public wrapper + a public `run_render_silent` variant; preview now calls the silent one. `81bc02b`.
- **Playhead jerky during playback** — `<video>.timeupdate` fires at ~4 Hz per HTML5 spec, which reads as stuttery on the timeline. Replaced with a `requestAnimationFrame` pump while playing (~60 Hz), cancel on pause. Final sync on pause so the playhead lands exactly where the video stopped. `81bc02b`.

Risk #5 from the residual-risks list (migration of a legacy `.vproj`) was deemed **moot** — the project has never been released; no install base exists. `io::migrate::tests` covers the v1→v2 code path; live verification was unnecessary.

## Deferred / out of scope

- **Cross-workspace shared media library** — compromises Q2's self-containment promise. Layer on as a Settings option (`shared_media_libraries: PathBuf[]`) when a studio scenario actually demands it.
- **Per-segment preview cache + MSE streaming** — whole-project preview render is fine for short projects with proxies. Revisit when long-project edit-to-preview latency becomes a real complaint.
- **macOS / Linux libmpv-popup removal** — project preview already works on those platforms because it's pure DOM. The popup `mpv_play_media` survives Phase D; its removal is its own work when those platforms become the primary target.
- **Hardlinks / symlinks as an opt-in** — Q2 chose pure copy. A "link instead" toggle can land as an advanced Settings option if disk pressure becomes a real complaint.
- **Right-click "Relink…" for missing media** — Phase C badges missing items; the actual relink-by-content-hash UI is its own small project.

## Memory pointers (outside the repo)

- [[project-workspace-redesign]] — top-level project memory, commit map, the 10 decisions
- [[async-block-on-in-async]] — the `block_on`-in-async gotcha that surfaced in live verification
- [[libmpv-host-overlay]], [[libmpv-embed-hwnd]] — both **OBSOLETE** post `3cb42d2` (the code they describe is deleted); preserved as design rationale
- [[libmpv-close-path]] — scope shrunk to popup-only
- [[libmpv2-4-1-command-string-concat-bug]] — **FIXED** upstream in libmpv2 6.0 (Phase E)
- [[rmcp-migration-blocked]] — why rmcp stays at 0.1.x despite 1.x being available
