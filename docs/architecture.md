# Architecture

> **Implementation status:** This is the design spec. Phase-by-phase implementation status lives in [`roadmap.md`](roadmap.md); workspace-folder data flow + DOM `<video>` preview shipped 2026-05-13/14 — see [`workspace-redesign.md`](workspace-redesign.md). At time of writing the MCP transport is SSE (rmcp 0.1.x; 1.x dropped SSE and the migration to streamable-HTTP is its own piece of work — see `feedback_rmcp_migration_blocked` memory) and the change-feed lives on a separate axum-backed `/events` endpoint rather than riding the MCP transport.

Videtor is a Tauri 2 desktop app. The Rust core owns all state and side effects; the webview is a thin UI; external agents connect over MCP. **The workspace folder *is* the project** — opening a folder = opening the project; auto-save means closing the app loses nothing.

## Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│                          External agents                             │
│        (Claude Desktop, Cursor, Cline, custom Python clients)        │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ MCP / SSE / localhost / token
┌────────────────────────▼─────────────────────────────────────────────┐
│                          Tauri app                                   │
│                                                                      │
│  ┌────────────────────────┐         ┌─────────────────────────────┐  │
│  │ Webview (React)        │ ◄─IPC─► │ Rust core                   │  │
│  │ • Startup screen       │         │ ┌─────────────────────────┐ │  │
│  │ • Timeline             │         │ │ Project actor (state)   │ │  │
│  │ • Property panels      │         │ │  • Arc<Project>+history │ │  │
│  │ • <video> preview      │         │ │  • single-writer queue  │ │  │
│  │   (DOM-native; reads   │         │ └────────────┬────────────┘ │  │
│  │    Cache/preview/      │         │ ┌────────────▼────────────┐ │  │
│  │    via asset://)       │         │ │ Subscriber tasks        │ │  │
│  │ • Offscreen rasterizer │         │ │  • Autosave (debounce)  │ │  │
│  │   (hidden webviews)    │         │ │  • Preview renderer     │ │  │
│  └────────────────────────┘         │ │  • UI event bridge      │ │  │
│                                     │ └────────────┬────────────┘ │  │
│                                     │ ┌────────────▼────────────┐ │  │
│                                     │ │ IR compiler             │ │  │
│                                     │ │  lower → emit ffmpeg    │ │  │
│                                     │ └────────────┬────────────┘ │  │
│                                     │ ┌────────────▼────────────┐ │  │
│                                     │ │ Render orchestrator     │ │  │
│                                     │ │  • ffmpeg (preview MP4  │ │  │
│                                     │ │    + final export)      │ │  │
│                                     │ │  • rasterizer driver    │ │  │
│                                     │ │  • import-copy queue    │ │  │
│                                     │ └─────────────────────────┘ │  │
│                                     │ ┌─────────────────────────┐ │  │
│                                     │ │ MCP server (rmcp)       │ │  │
│                                     │ │  • tools / resources    │ │  │
│                                     │ │  • SSE change feed      │ │  │
│                                     │ └─────────────────────────┘ │  │
│                                     └─────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

libmpv survives only for the media-pool play-on-click popup (`mpv_play_media` — a standalone OS window, no z-order conflict with the DOM). The **project preview is a DOM `<video>` element** backed by state-hashed MP4 renders under `<workspace>/Cache/preview/<hash>.mp4`. See [`rendering.md`](rendering.md) for the preview-render details and [`workspace-redesign.md`](workspace-redesign.md) for the design rationale.

## Three load-bearing principles

### 1. Single-writer state
All mutations — UI edits and MCP tool calls — funnel through one Rust actor that holds `Arc<Project>`. Reads are lock-free `Arc` clones. Concurrency is solved by serialization, not by locks scattered through the code.

### 2. Preview = export pipeline at low resolution
The IR compiler emits one ffmpeg lavfi-complex filter graph. The **preview renderer** debounces actor commits 1 s, then runs that graph through ffmpeg into `<workspace>/Cache/preview/<state_hash>.mp4` — substituting each clip's 540p H.264 proxy (`MediaItem.proxy_path`) for the original so the encode is cheap. The React `<PreviewSurface>` listens for `preview:render_complete` and swaps its `<video src>`. Export uses the same graph at full resolution against originals. **Same code path, two resolutions**, no alternate "preview engine" to drift from export.

### 3. Hybrid rendering for HTML overlays
ffmpeg-native layers (clips, images, drawtext, subtitles, shapes, transitions) flow through the filter graph directly. Rich graphic overlays (animated titles, lower thirds, custom motion graphics) are rasterized in an offscreen webview to a PNG sequence, then composited as just another overlay layer. Authoring flexibility of HTML/CSS, parity guarantee of a unified pipeline.

## Data flow: a single edit

1. UI command or MCP tool call sends a `Command` to the project actor.
2. Actor validates invariants. Reject on failure with a structured error.
3. Actor produces a new `Arc<Project>`, pushes the prior one onto history, broadcasts a `ChangeEvent`.
4. Subscribers react:
   - **UI event bridge** emits `project:changed` so React panels re-fetch `projectSummary()`.
   - **Autosave subscriber** debounces 500 ms, writes `<workspace>/project.json` (atomic `.tmp` + rename). Every 50 commits or 5 min, copies to `Backups/<ISO>.json`.
   - **Preview renderer** debounces 1 s, computes the state hash, kicks ffmpeg if the resulting `Cache/preview/<hash>.mp4` doesn't already exist, emits `preview:render_complete` with the path.
   - **MCP change feed** pushes a compact line to subscribed agents over the `/events` SSE endpoint.
5. `<PreviewSurface>` receives `preview:render_complete`, swaps `<video src>` via `convertFileSrc(...)`, restores playhead + paused state across the swap so the user keeps their place.

Round-trip from commit to preview pixels: ~1 s debounce + ffmpeg encode time on proxies (typically 200 ms – 2 s for short projects).

## IR ↔ state contract

The compiler is a pure function: `Project → IRGraph`.

| Trigger | Action |
|---|---|
| `change_event.diff_hint = Coarse` | Full recompile (cheap, ms range). |
| `change_event.diff_hint = Layer(id)` | Recompile that layer's lowering only; splice into prior IR. |
| `change_event.diff_hint = Composition` | Full recompile (resolution/fps changed). |
| Project state version unchanged | Skip — reuse cached IR. |

For MVP, do full recompile on every commit — measure before optimizing. Compiler output is cached by `Arc<Project>` pointer identity (since structural sharing makes it cheap).

## Inter-process boundaries

| From → To | Mechanism |
|---|---|
| Webview UI → Rust core | `tauri::command` (sync queries, RPC-style mutations) |
| Rust core → Webview UI | `app_handle.emit` events: `project:changed`, `preview:render_*`, `import:*`, `media:job_*`, `export:*` |
| Webview UI → preview MP4 | `<video src={convertFileSrc(path)}>` via Tauri's `asset://` protocol (scope `**`, enabled in `tauri.conf.json`) |
| External agent → Rust core | MCP over SSE on localhost (rmcp 0.1.x; bearer in `app_config_dir/mcp_auth.json`) |
| Rust core → External agent | MCP SSE change feed on a separate axum `/events` endpoint |
| Rust core → ffmpeg | `ffmpeg-sidecar` subprocess, `-filter_complex_script` (file-backed graphs to avoid argv length limits). Used by export, preview render, proxy/thumbnail/waveform jobs, audio-extract for cloud transcription. |
| Rust core → libmpv | Popup window only (`mpv_play_media` for media-pool play-on-click). Standalone OS window; no z-order conflict with the DOM. |
| Rust core → Offscreen rasterizer | Spawned `wry` webviews, JS `eval` for `__seek`, native snapshot APIs (WebView2 `CapturePreview` on Windows) |

## Project preview surface

The project preview is a DOM `<video>` element inside `<PreviewSurface>`. Its `src` points at the current `<workspace>/Cache/preview/<state_hash>.mp4` produced by the preview-renderer task; Tauri's `convertFileSrc(path)` turns the absolute path into an `asset://...` URL the WebView2 page can fetch. Cross-platform by construction: the same DOM element works on Windows / macOS / Linux without any native-surface fiddling.

Across `src` swaps (which happen every time a re-render lands), the component preserves `currentTime` and `paused` state — set on the `loadedmetadata` event after a fresh `src` so the user doesn't lose their place. The timeline playhead is driven by a `requestAnimationFrame` pump that reads `video.currentTime` at the display refresh rate (~60 Hz) while playing, not the HTML5 `timeupdate` event (capped at ~4 Hz, jerky).

The transport buttons (⏮ / ⏯·⏸ / ⏭) drive the `<video>` element via an imperative ref: `play()`, `pause()`, `seekTo(tUs)`. The parent owns `currentTimeUs` state; it pushes to the video on user seek and reads back during RAF pumps.

## libmpv: media-pool popup only

After the workspace redesign, libmpv survives only for `mpv_play_media` — the media-pool "play this clip" button. The popup opens a standalone top-level OS window (no host HWND, no WebView2 sibling), so there's no z-order conflict with the editor's DOM overlays. The Rust surface (`mpv/mod.rs`) is `MpvSlot` (the libmpv handle) + `MpvPopupSlot(MpvSlot)` (Tauri-managed wrapper) + `ensure_init` (standalone-window branch only, sets `force-window=yes` + suppresses OSC/keyboard bindings) + `play_file` + `drain_events_and_close_if_shutdown` (~33 ms tick so the OS close button releases the window).

The pre-redesign WS_CHILD HWND embed, `set_host_hwnd` / `set_surface_rect` / `set_host_visible` / `set_host_clip` machinery, the `useHideMpvHost` / `useMpvHostClip` React hooks, and the project-graph `play_graph` / `mpv:time` poller are all deleted. See [`workspace-redesign.md`](workspace-redesign.md) for the rationale (HWND z-order trap → DOM-native composition).

libmpv2 6.0 (the current version) uses the array-form `mpv_command` natively, so the per-arg quoting workaround that 4.x needed is also gone. The zombie-handle probe in `ensure_init` (re-init on first failing `get_property("mpv-version")`) and the drain-events poller are the only non-obvious wirings that remain — both load-bearing for clean window close behavior.

## Repository layout

```
videtor/
  README.md
  docs/                       ← documentation (this directory)
  apps/desktop/               ← the Tauri app
    src-tauri/                ← Rust core
      src/
        state/                ← project state types, actor, history, persistence
        ir/                   ← render graph IR, lowering, emitter
        export/               ← ffmpeg pipeline: run_render (events) +
                              ←   run_render_silent (preview path)
        ffmpeg/               ← sidecar wrapper, install bootstrap
        preview/              ← state-hashed preview renderer task +
                              ←   PreviewRenderer subscriber (Phase D)
        jobs/                 ← background derivative jobs:
                              ←   proxy, thumbnails, waveform, frame,
                              ←   import (workspace copy worker)
        cache/                ← workspace-scoped derivative cache
                              ←   (workspace/Cache/{proxies,preview,...})
        mpv/                  ← libmpv popup window for mpv_play_media
                              ←   (project preview is DOM <video>)
        raster/               ← offscreen rasterizer for HTML templates
        mcp/                  ← rmcp server, tool definitions, resources
        io/                   ← project.json save/load + autosave task +
                              ←   io/migrate.rs (v1→v2 workspace migration)
        recents.rs            ← startup-screen recents.json + prefs
        workspace.rs          ← WorkspaceSlot tracking current workspace
        cloud/                ← provider-agnostic cloud APIs:
                              ←   Transcriber / Synthesizer traits,
                              ←   keyring-backed key storage,
                              ←   one module per concrete provider
        main.rs
      Cargo.toml
      tauri.conf.json
    src/                      ← React UI
      startup/                ← Create / Open / Recent screen
      preview/                ← <PreviewSurface> wrapping <video>
      timeline/
      properties/
      activity/, connect/, settings/, templates/, menu/, panels/
      ipc/                    ← typed Tauri command wrappers
  packages/templates/         ← built-in HTML overlay templates
    lower-third-glow/
    title-card/
    ...
  scripts/                    ← dev/build helpers (PowerShell + bash)
  .github/workflows/          ← CI (build, test, lint)
```

## External dependencies (decided)

- `tauri` v2.11 — shell, IPC, window management, `assetProtocol` for `<video>` access to workspace files.
- `rmcp` v0.1.x — MCP server framework. Pinned: 1.x dropped the SSE transport, migration is its own work (see `feedback_rmcp_migration_blocked`).
- `ffmpeg-sidecar` — auto-downloads ffmpeg on first run; sidesteps licensing/distribution.
- `libmpv2` v6 — media-pool popup player. Project preview no longer uses it.
- `imbl` — persistent immutable collections (state snapshots with structural sharing).
- `tokio` — async runtime, channels.
- `serde` / `serde_json` / `schemars` — serialization, JSON Schema generation shared between MCP and Tauri command bridges.
- `ts-rs` v12 — emit TypeScript types from Rust state types so the UI doesn't drift.
- `uuid` — v7 IDs for all addressable entities.
- `blake3` — content hashing (cache keys, file dedup, raster cache, preview state-hash).
- `keyring` v3 — OS-native credential storage for cloud-provider API keys.
- `reqwest` v0.13 (rustls) — HTTP client for cloud-provider integrations.
- `insta` — snapshot testing for IR lowering.
- `i18next` + `react-i18next` + `i18next-browser-languagedetector` — frontend i18n; bundled resources for `en-US` and `zh-CN`, localStorage-persisted user choice.

Direct `wry` dep was dropped in Phase E — the raster module spawns its offscreen webview via Tauri's `WebviewWindowBuilder` (which re-exports wry transitively).

## Internationalization (UI)

The webview is bilingual: **English (US)** as the source/default, **Simplified Chinese** (`zh-CN`) as the second supported locale. Adding more locales is a strict addition — drop a resource file under `apps/desktop/src/i18n/locales/`, register it in the init module.

| Layer | Strategy |
|---|---|
| UI labels (React) | `i18next` keys, looked up via `useTranslation()` / `<Trans>`. Pluralization handled by i18next's built-in rules (`*_one` / `*_other`); `zh-CN` collapses to a single form. |
| Rust logs / `tracing` output | Stay English. Operator-facing, not user-facing. |
| Tauri command errors (e.g. `CommandError`) | Tagged structured form (`{kind, detail}`) returned to the UI; the UI maps recognized kinds to localized messages, falling back to the raw English `Display` string for unknown variants. |
| MCP tool errors | English machine-readable strings. Agents do their own translation if they want. |
| Built-in HTML overlay templates | Each template carries text in its props; localization is per-project content, not framework-level (a German project ships German lower-thirds). |
| Date / time / number formatting | `Intl.DateTimeFormat` and `Intl.NumberFormat` with the active locale. Avoid hand-rolled `${value}s` strings. |

`i18next-browser-languagedetector` reads `localStorage.i18nextLng` first, then `navigator.language`, then falls back to `en-US`. The header surfaces a one-click toggle so testers don't have to dig into devtools.

For the design conversation that's now baked in: don't translate Rust-side strings. Operator logs need to stay greppable; the UI is the only place locale matters.

## See also

- [Data model](data-model.md) — what the actor stores and emits.
- [Rendering](rendering.md) — IR compiler and offscreen rasterizer.
- [MCP](mcp.md) — agent connection protocol and tool surface.
- [Roadmap](roadmap.md) — phased delivery.
