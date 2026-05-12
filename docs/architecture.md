# Architecture

> **Implementation status:** This is the design spec. Phase-by-phase implementation status lives in [`roadmap.md`](roadmap.md). At time of writing the MCP transport is SSE rather than Streamable HTTP (rmcp 0.1.x hasn't shipped streamable-http yet) and the change-feed lives on a separate axum-backed `/events` endpoint rather than riding the MCP transport — both pragmatic deltas, see `roadmap.md`'s Phase 4 closeout.

Videtor is a Tauri 2 desktop app. The Rust core owns all state and side effects; the webview is a thin UI; external agents connect over MCP.

## Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│                          External agents                             │
│        (Claude Desktop, Cursor, Cline, custom Python clients)        │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ MCP / Streamable HTTP / localhost / token
┌────────────────────────▼─────────────────────────────────────────────┐
│                          Tauri app                                   │
│                                                                      │
│  ┌────────────────────────┐         ┌─────────────────────────────┐  │
│  │ Webview (React)        │ ◄─IPC─► │ Rust core                   │  │
│  │ • Timeline             │         │ ┌─────────────────────────┐ │  │
│  │ • Property panels      │         │ │ Project actor (state)   │ │  │
│  │ • mpv surface mount    │         │ │  • Arc<Project>+history │ │  │
│  │ • Offscreen rasterizer │         │ │  • single-writer queue  │ │  │
│  │   (hidden webviews)    │         │ └────────────┬────────────┘ │  │
│  └────────────────────────┘         │ ┌────────────▼────────────┐ │  │
│                                     │ │ IR compiler             │ │  │
│                                     │ │  lower → optimize →     │ │  │
│                                     │ │  emit ffmpeg/lavfi      │ │  │
│                                     │ └────────────┬────────────┘ │  │
│                                     │ ┌────────────▼────────────┐ │  │
│                                     │ │ Render orchestrator     │ │  │
│                                     │ │  • libmpv (preview)     │ │  │
│                                     │ │  • ffmpeg (export)      │ │  │
│                                     │ │  • rasterizer driver    │ │  │
│                                     │ └─────────────────────────┘ │  │
│                                     │ ┌─────────────────────────┐ │  │
│                                     │ │ MCP server (rmcp)       │ │  │
│                                     │ │  • tools / resources    │ │  │
│                                     │ │  • SSE change feed      │ │  │
│                                     │ └─────────────────────────┘ │  │
│                                     └─────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## Three load-bearing principles

### 1. Single-writer state
All mutations — UI edits and MCP tool calls — funnel through one Rust actor that holds `Arc<Project>`. Reads are lock-free `Arc` clones. Concurrency is solved by serialization, not by locks scattered through the code.

### 2. Preview = export pipeline at lower resolution
The IR compiler emits one filter graph. libmpv plays it at proxy resolution for live preview; ffmpeg encodes it at full resolution for export. Same pixels, different scales. No alternate code paths to drift.

### 3. Hybrid rendering for HTML overlays
ffmpeg-native layers (clips, images, drawtext, subtitles, shapes, transitions) flow through the filter graph directly. Rich graphic overlays (animated titles, lower thirds, custom motion graphics) are rasterized in an offscreen webview to a PNG sequence, then composited as just another overlay layer. Authoring flexibility of HTML/CSS, parity guarantee of a unified pipeline.

## Data flow: a single edit

1. UI command or MCP tool call sends a `Command` to the project actor.
2. Actor validates invariants. Reject on failure with a structured error.
3. Actor produces a new `Arc<Project>`, pushes the prior one onto history.
4. Change event is broadcast:
   - **UI** re-renders affected components.
   - **IR compiler** recompiles the affected subgraph.
   - **MCP change feed** pushes a compact line to subscribed agents.
5. New filter graph is hot-reloaded into libmpv via `lavfi-complex` (full reload only when topology changes; parameter-only changes use mpv's filter-update path).
6. Preview reflects the change within ~100 ms.

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
| Rust core → Webview UI | `app_handle.emit` events: `project:change`, `compile:done`, `raster:progress`, `export:progress` |
| External agent → Rust core | MCP over Streamable HTTP on localhost (tools + resources) |
| Rust core → External agent | MCP SSE change feed |
| Rust core → libmpv | `libmpv2` crate, `lavfi-complex` option, command queue |
| Rust core → ffmpeg | `ffmpeg-sidecar` subprocess, `-filter_complex_script` (file-backed graphs to avoid argv length limits) |
| Rust core → Offscreen rasterizer | Spawned `wry` webviews, JS `eval` for `__seek`, native snapshot APIs for capture |

## libmpv surface integration

Embedding a native video pane inside a webview UI is the platform-specific bit:

| OS | Approach |
|---|---|
| Windows | Child HWND of the Tauri WebView2 host; layered with the webview by Z-order. |
| macOS | NSView added as a sibling of WKWebView in the Tauri NSWindow; constrained by Auto Layout to the webview's "video" placeholder div, position synced via JS measuring DOM rect. |
| Linux | GtkBox placement inside Tauri's GtkApplicationWindow; same DOM-rect-syncing pattern. |

The webview reserves a placeholder `<div id="video-surface">` whose position/size it streams to Rust on resize/scroll; Rust positions the libmpv surface to match. This is fiddly and is the most likely Phase 0 spike to fail — validate it early.

**Two libmpv slots, by design.** Tauri state holds `MpvSlot` (project preview) AND `MpvPopupSlot(MpvSlot)` (media-pool / raw-file preview). They use separate libmpv handles because `wid` is init-only — a single handle can't toggle between embedded and standalone modes without dropping + recreating on every transition. The slot a Tauri command takes determines its surface: `mpv_preview_project` + transport commands use the embed slot; `mpv_play_file` / `mpv_play_media` use the popup slot.

**Windows (current):** the embed is wired for the project preview. At Tauri setup we register a `WS_CHILD` window class and create a host HWND as a sibling of WebView2 (parented to the outer Tauri HWND). The host's HWND value is stored on the **embed `MpvSlot`** only; `ensure_init` sets libmpv's `wid` property *before* the first `loadfile` so the VO embeds into it. JS measures `#video-surface` via `getBoundingClientRect()`, multiplies by `devicePixelRatio`, and calls `mpv_set_surface_rect` → `SetWindowPos(HWND_TOP, …)`. ResizeObserver + a `window.resize` listener keep the surface tracking layout. `osc`, `input-default-bindings`, and `input-vo-keyboard` are off in embed mode — the React UI owns transport (⏮ / ⏯·⏸ / ⏭ row beneath the preview pane). The **popup `MpvPopupSlot`** has no host HWND registered, so `ensure_init` falls into the `force-window=yes` branch and the media-pool preview continues to spawn a separate top-level window.

**macOS / Linux (deferred):** both slots run libmpv in standalone top-level windows via `force-window=yes` (required when no host `wid` is supplied — without it `loadfile` succeeds silently with no display surface). The NSView / GtkBox embed paths haven't been wired yet; the `host_hwnd: None` branch in `ensure_init` keeps them on the standalone-window fallback.

**Closing the embedded window cleanly is non-obvious.** mpv's default `CLOSE_WIN → quit` binding fires when the user clicks the OS close button; this puts the mpv core in a shutdown state and emits `MPV_EVENT_SHUTDOWN`, but the OS window resource isn't released until `mpv_terminate_destroy` runs — i.e. until the `Mpv` handle is `Drop`-ed. A 200ms-tick poller drains the event queue and drops the handle on `Shutdown`. There's also an explicit `mpv_close_preview` Tauri command for instant close from the UI, and `ensure_init` probes the existing handle via `mpv-version` and re-creates fresh if it's been externally quit.

## Repository layout

```
videtor/
  README.md
  docs/                       ← documentation (this directory)
  apps/desktop/               ← the Tauri app
    src-tauri/                ← Rust core
      src/
        state/                ← project state types, actor, history, persistence
        ir/                   ← render graph IR, lowering, optimization, emitter
        ffmpeg/               ← sidecar wrapper, export pipeline
        mpv/                  ← libmpv integration, surface management
        raster/               ← offscreen rasterizer, JS shim, cache
        mcp/                  ← rmcp server, tool definitions, resources
        io/                   ← project save/load, schema migrations
        cloud/                ← provider-agnostic cloud APIs:
                              ←   Transcriber / Synthesizer traits,
                              ←   keyring-backed key storage,
                              ←   one module per concrete provider
        main.rs
      Cargo.toml
      tauri.conf.json
    src/                      ← React UI
      timeline/
      panels/
      hooks/
      ipc/                    ← typed Tauri command wrappers
  packages/templates/         ← built-in HTML overlay templates
    lower-third-glow/
    title-card/
    ...
  scripts/                    ← dev/build helpers (PowerShell + bash)
  .github/workflows/          ← CI (build, test, lint)
```

## External dependencies (decided)

- `tauri` v2 — shell, IPC, window management.
- `wry` — webview backend; used directly for offscreen rasterizer workers.
- `rmcp` — MCP server framework.
- `ffmpeg-sidecar` — auto-downloads ffmpeg on first run; sidesteps licensing/distribution.
- `libmpv2` — embedded preview player.
- `imbl` — persistent immutable collections (state snapshots with structural sharing).
- `tokio` — async runtime, channels.
- `serde` / `serde_json` / `schemars` — serialization, JSON Schema generation shared between MCP and Tauri command bridges.
- `ts-rs` — emit TypeScript types from Rust state types so the UI doesn't drift.
- `uuid` — v7 IDs for all addressable entities.
- `blake3` — content hashing (cache keys, file dedup, raster cache).
- `insta` — snapshot testing for IR lowering.
- `i18next` + `react-i18next` + `i18next-browser-languagedetector` — frontend i18n; bundled resources for `en-US` and `zh-CN`, localStorage-persisted user choice.

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
