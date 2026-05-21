# Architecture

WeftCut is a Tauri 2 desktop video editor. The Rust core owns all state
and side effects; the webview hosts a PixiJS-based compositor and a
React UI; external agents connect over MCP. The workspace folder *is*
the project — opening a folder = opening the project; auto-save means
closing the app loses nothing.

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
│  │ Webview (React + Pixi) │ ◄─IPC─► │ Rust core                   │  │
│  │ • Startup screen       │         │ ┌─────────────────────────┐ │  │
│  │ • Timeline             │         │ │ Project actor (state)   │ │  │
│  │ • Property panels      │         │ │  • Arc<Project>+history │ │  │
│  │ • PreviewSurface       │         │ │  • single-writer queue  │ │  │
│  │   - PixiJS Application │         │ └────────────┬────────────┘ │  │
│  │   - synthetic clock    │         │ ┌────────────▼────────────┐ │  │
│  │   - WebCodecs decoder  │         │ │ Subscriber tasks        │ │  │
│  │     pool               │         │ │  • Autosave (debounce)  │ │  │
│  │   - Web Audio mixer    │         │ │  • UI event bridge      │ │  │
│  │ • Export Worker        │         │ └────────────┬────────────┘ │  │
│  │   (OffscreenCanvas)    │         │ ┌────────────▼────────────┐ │  │
│  └────────────────────────┘         │ │ Background jobs         │ │  │
│                                     │ │  • proxy / thumbnails / │ │  │
│                                     │ │    waveform / import    │ │  │
│                                     │ └────────────┬────────────┘ │  │
│                                     │ ┌────────────▼────────────┐ │  │
│                                     │ │ Audio compositor        │ │  │
│                                     │ │  • lower(Project) → IR  │ │  │
│                                     │ │  • emit ffmpeg          │ │  │
│                                     │ │  • export_audio_only +  │ │  │
│                                     │ │    mux_to_file          │ │  │
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

All mutations — UI edits and MCP tool calls — funnel through one Rust
actor that holds `Arc<Project>`. Reads are lock-free `Arc` clones.
Concurrency is solved by serialization, not by locks scattered through
the code.

### 2. Preview = export pipeline

The PixiJS + WebCodecs compositor that drives the live preview is the
same module the export Worker invokes against an `OffscreenCanvas`.
Preview pixels equal export pixels by construction; there's no
"preview engine" to drift from export. See [`render.md`](render.md) for
the renderer architecture.

### 3. ffmpeg shrinks to audio + mux

The Rust side runs ffmpeg only at:

- **Import** — proxy generation (1080p H.264 1 s GOP), thumbnails,
  waveform.
- **Audio export** — the `lower → emit_ffmpeg → ffmpeg` audio pipeline
  produces `audio.m4a` for the user's project.
- **Final mux** — `ffmpeg -c copy` stitches the WebCodecs-produced
  `video.mp4` with the audio m4a into the user's output path.

No ffmpeg-driven visual compositor, no offscreen rasterizer, no
libmpv preview. The visual half of the old IR was deleted with the
PixiJS migration.

## Data flow: a single edit

1. UI command or MCP tool call sends a `Command` to the project actor.
2. Actor validates invariants. Reject on failure with a structured
   error.
3. Actor produces a new `Arc<Project>`, pushes the prior one onto
   history, broadcasts a `ChangeEvent`.
4. Subscribers react:
   - **UI event bridge** emits `project:changed` so React panels
     re-fetch `projectSummary()`. The `<PreviewSurface>` compositor
     receives the updated project and updates its sprite tree in
     place (no recompile).
   - **Autosave subscriber** debounces 500 ms, writes
     `<workspace>/project.json` (atomic `.tmp` + rename). Every 50
     commits or 5 min, copies to `Backups/<ISO>.json`.
   - **MCP change feed** pushes a compact line to subscribed agents
     over the `/events` SSE endpoint.

Round-trip from commit to preview pixels: next animation frame
(~16 ms at 60 Hz). The PixiJS compositor reads the new project state
directly; no encode-and-swap step.

## Inter-process boundaries

| From → To | Mechanism |
|---|---|
| Webview UI → Rust core | `tauri::command` (sync queries, RPC-style mutations) |
| Rust core → Webview UI | `app_handle.emit` events: `project:changed`, `import:*`, `media:job_*` |
| Webview UI → workspace files | `convertFileSrc(path)` via Tauri's `asset://` protocol (scope `**`, enabled in `tauri.conf.json`) — used by the Pixi decoder pool to fetch proxies and originals |
| External agent → Rust core | MCP over SSE on localhost (rmcp 0.1.x; bearer in `app_config_dir/mcp_auth.json`) |
| Rust core → External agent | MCP SSE change feed on a separate axum `/events` endpoint |
| Rust core → ffmpeg | `ffmpeg-sidecar` subprocess. Used by audio export, proxy / thumbnail / waveform / frame-extract jobs, audio-extract for cloud transcription, and the final stream-copy mux. |

## Repository layout

```
weftcut/
  README.md
  docs/                       ← documentation (this directory)
  apps/desktop/               ← the Tauri app
    src-tauri/                ← Rust core
      src/
        state/                ← project state types, actor, history, persistence
        ir/                   ← audio-only IR: lower → emit_ffmpeg
        export/               ← export_audio_only + mux_to_file
        ffmpeg/               ← sidecar wrapper, install bootstrap
        jobs/                 ← background derivative jobs:
                              ←   proxy, thumbnails, waveform, frame,
                              ←   import (workspace copy worker)
        cache/                ← workspace-scoped derivative cache
                              ←   (workspace/Cache/{proxies,...})
        templates/            ← built-in HTML template catalog
                              ←   (manifests + HTML + CSS, embedded)
        mcp/                  ← rmcp server, tool definitions, resources
        io/                   ← project.json save/load + autosave task +
                              ←   io/migrate.rs (schema migrations)
        recents.rs            ← startup-screen recents.json + prefs
        workspace.rs          ← WorkspaceSlot tracking current workspace
        cloud/                ← provider-agnostic cloud APIs:
                              ←   Transcriber / Synthesizer traits,
                              ←   keyring-backed key storage
        main.rs
      Cargo.toml
      tauri.conf.json
    src/                      ← React + TypeScript UI
      startup/                ← Create / Open / Recent screen
      preview/                ← <PreviewSurface> mounting the Pixi compositor
      render/                 ← PixiJS + WebCodecs renderer
        Compositor.ts         ←   PixiJS Application owner
        clock.ts              ←   synthetic clock + Web Audio drift
        PlaybackEngine.ts     ←   transport
        decoder/              ←   SourceDecoderPool, Demuxer, FrameRing, scrub
        sprite/               ←   per-layer-kind Sprite implementations
        templates/            ←   foreignObject rasterizer + cache
        subtitles/            ←   JASSUB binding
        worker/               ←   exportWorker + encoder (OffscreenCanvas)
        audio/                ←   AudioGraph (Web Audio mixer)
      timeline/
      properties/
      ipc/                    ← typed Tauri command wrappers
```

## External dependencies

- **tauri** v2 — shell, IPC, window management, `assetProtocol` for
  webview access to workspace files.
- **rmcp** v0.1.x — MCP server framework. (1.x dropped SSE transport;
  migration to streamable-HTTP is its own piece of work.)
- **ffmpeg-sidecar** — auto-downloads ffmpeg on first run.
- **imbl** — persistent immutable collections (state snapshots with
  structural sharing).
- **tokio** — async runtime, channels.
- **serde** / **serde_json** / **schemars** — serialization, JSON
  Schema generation shared between MCP and Tauri command bridges.
- **ts-rs** — emit TypeScript types from Rust state types so the UI
  doesn't drift.
- **uuid** — v7 IDs for all addressable entities.
- **blake3** — content hashing (cache keys, file dedup).
- **keyring** — OS-native credential storage for cloud-provider API
  keys.
- **reqwest** (rustls) — HTTP client for cloud-provider integrations.
- **pixi.js** v8 — webview-side renderer.
- **mp4box.js** — webview-side demuxer / muxer for the WebCodecs
  pipeline.
- **libass-wasm** (JASSUB) — ASS/SRT subtitle rendering.
- **i18next** + **react-i18next** — frontend i18n; bundled resources
  for `en-US` and `zh-CN`.

## Internationalization (UI)

The webview is bilingual: **English (US)** as the source/default,
**Simplified Chinese** (`zh-CN`) as the second supported locale.
Adding more locales is a strict addition — drop a resource file under
`apps/desktop/src/i18n/locales/`, register it in the init module.

| Layer | Strategy |
|---|---|
| UI labels (React) | `i18next` keys via `useTranslation()` / `<Trans>`. |
| Rust logs / `tracing` output | Stay English. Operator-facing. |
| Tauri command errors | Tagged structured form (`{kind, detail}`) returned to the UI; the UI maps recognized kinds to localized messages. |
| MCP tool errors | English machine-readable strings. Agents do their own translation. |
| Built-in HTML templates | Each template carries text in its props; localization is per-project content. |
| Date / time / number formatting | `Intl.DateTimeFormat` and `Intl.NumberFormat` with the active locale. |

## See also

- [Data model](data-model.md) — what the actor stores and emits.
- [Render](render.md) — PixiJS + WebCodecs renderer architecture.
- [Preview](preview.md) — interactive preview surface.
- [Rendering](rendering.md) — audio IR + export + final mux.
- [Groups](groups.md) — group model.
- [MCP](mcp.md) — agent connection protocol and tool surface.
- [Roadmap](roadmap.md) — phased delivery.
