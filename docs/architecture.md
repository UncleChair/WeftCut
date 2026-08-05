# Architecture

WeftCut is an Electron desktop video editor (Electron + napi-rs). The
Electron **main** process (TypeScript) owns project state, persistence, and
the agent/MCP surface. The Rust core (an in-process napi addon) owns
native runtime services — media jobs, cache/workspace slots, import queue,
logs, cloud-provider calls, the audio mixer, export video sink, and ffmpeg —
but it does **not** own the authoritative `Project`. Project-shaped Rust
code is a serde/compute model: each compute call receives the exact
`Project`/`MediaItem` slice it needs as an argument. The renderer hosts a
PixiJS-based compositor and a React UI; external agents connect over MCP.
The workspace folder *is* the project — opening a folder = opening the
project; auto-save means closing the app loses nothing.

Runtime choice and rationale: see [ADR 0024](adr/0024-desktop-runtime-electron-napi.md).

## Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│                          External agents                             │
│        (Claude Desktop, Cursor, Cline, custom Python clients)        │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ MCP / streamable-HTTP / localhost / token
┌────────────────────────▼─────────────────────────────────────────────┐
│                          Electron app                                │
│                                                                      │
│  ┌────────────────────────┐         ┌─────────────────────────────┐  │
│  │ Renderer (React + Pixi)│ ◄─IPC─► │ Main + Rust core (napi)     │  │
│  │  via preload bridge    │         │                             │  │
│  │ • Startup screen       │         │ ┌─────────────────────────┐ │  │
│  │ • Timeline             │         │ │ Project actor (state)   │ │  │
│  │ • Property panels      │         │ │  • snapshots + history  │ │  │
│  │ • PreviewSurface       │         │ │  • serialized dispatch  │ │  │
│  │   - PixiJS Application │         │ │                         │ │  │
│  │   - audio-master clock │         │ └────────────┬────────────┘ │  │
│  │   - WebCodecs decoder  │         │ ┌────────────▼────────────┐ │  │
│  │     pool               │         │ │ Subscriber tasks        │ │  │
│  │   - Web Audio mixer    │         │ │  • Autosave (debounce)  │ │  │
│  │ • Export Worker        │         │ │  • UI event bridge      │ │  │
│  │   (OffscreenCanvas)    │         │ └────────────┬────────────┘ │  │
│  └────────────────────────┘         │ ┌────────────▼────────────┐ │  │
│                                     │ │ Background jobs         │ │  │
│                                     │ │  • proxy / thumbnails / │ │  │
│                                     │ │    waveform / conform / │ │  │
│                                     │ │    import               │ │  │
│                                     │ └────────────┬────────────┘ │  │
│                                     │ ┌────────────▼────────────┐ │  │
│                                     │ │ Audio mixer (export)    │ │  │
│                                     │ │  • MixPlan → block sum  │ │  │
│                                     │ │    over conform PCM     │ │  │
│                                     │ │  • ffmpeg encode tail + │ │  │
│                                     │ │    mux_to_file          │ │  │
│                                     │ └─────────────────────────┘ │  │
│                                     │ ┌─────────────────────────┐ │  │
│                                     │ │ MCP host (main, TS)     │ │  │
│                                     │ │  • streamable-HTTP +    │ │  │
│                                     │ │    bearer; merged TS+   │ │  │
│                                     │ │    Rust tool catalog    │ │  │
│                                     │ └─────────────────────────┘ │  │
│                                     └─────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

Within the single app process, the project **actor, history, autosave, the
UI/MCP event bridges, the config stores, and the MCP host are TypeScript**
(Electron main); the **background jobs, audio mixer, ffmpeg, and export are
the Rust napi core**. Rust is project-state stateless: it keeps runtime slots
for cache/workspace/jobs/logs/session, but every project compute/export path
takes its state slice as a call argument. The boundary between the two is the
napi `Backend.invoke` dispatch.

## Three load-bearing principles

### 1. Single-writer state

All mutations — UI edits and MCP tool calls — funnel through one
TypeScript actor in the Electron main process (`src/main/state/`) that
holds the authoritative project snapshot + history. Reads are cheap
immutable-snapshot clones. Concurrency is solved by serialization, not by
locks scattered through the code. The Rust core never mutates the
authoritative project directly: each compute call receives the exact state
slice it needs as an argument, and derivative jobs emit write-back events
that the TS actor folds into state.

### 2. Preview = export pipeline

The PixiJS + WebCodecs compositor that drives the live preview is the
same module the export Worker invokes against an `OffscreenCanvas`.
Preview pixels equal export pixels by construction; there's no
"preview engine" to drift from export. See [`render.md`](render.md) for
the renderer architecture.

The deterministic "what-you-see/hear" MATH both the renderer and Rust's
compute/export paths need — frame snap, keyframe interpolation, the audio
envelope curve, the role mute/solo gate — lives once in the `weftcut-eval`
leaf crate, compiled natively for the Rust compute + export paths and to
wasm for the renderer and the TS main-process actor where main-process state
logic needs it (notably frame snapping). One source of truth instead of
hand-mirrored Rust + TS copies that could drift.
See [ADR 0025](adr/0025-shared-eval-wasm-leaf-crate.md).

### 3. ffmpeg never composites

The Rust side runs ffmpeg at:

- **Import** — proxy generation (a 720p short-GOP scrub proxy for
  preview, plus a source-resolution H.264 export master for sources
  WebCodecs can't decode directly), thumbnails, waveform, and the audio
  conform (canonical 48 kHz f32 PCM both audio paths read;
  [`audio.md`](audio.md)).
- **Audio export** — the encode tail only: the mix itself happens in
  Rust (`audio::mix`, sample-accurate over conform PCM); ffmpeg applies
  the limiter ceiling and encodes AAC/Opus into a temporary audio file.
- **Video export** — the native encode engine (the default) streams
  GPU-packed rawvideo frames over IPC into an ffmpeg sink that owns the
  video encode itself (bitrate/CRF, presets, GOP, explicit color tags;
  see [`render.md`](render.md)'s "Encode exits"). The WebCodecs engine
  (an explicit user pin) encodes video in the renderer instead and never
  reaches ffmpeg for it.
- **Final mux** — ffmpeg stream-copies the already-encoded video, from
  whichever engine produced it, with the optional audio track into the
  user-chosen container; this step never re-encodes.

No ffmpeg-driven visual compositor, no offscreen rasterizer, no
libmpv preview. The visual half of the old IR was deleted with the
PixiJS migration; ffmpeg's remaining jobs are encode and mux, never pixels.

## Data flow: a single edit

1. UI command or MCP tool call sends a `Command` to the project actor.
2. Actor validates invariants. Reject on failure with a structured
   error.
3. Actor produces a new frozen `Project` snapshot, records it in history,
   and broadcasts a `ChangeEvent`.
4. Subscribers react:
   - **UI event bridge** emits `project:changed` (the TS host sends it from
     the main process to the renderer as `evt:project:changed`) so React
     panels re-fetch `projectSummary()`. The `<PreviewSurface>` compositor
     receives the updated project and updates its sprite tree in
     place (no recompile). The re-fetch is **ordering-guarded**:
     `project_summary` responses can resolve out of order over async IPC,
     so a response older than the newest already applied is dropped —
     last-write-wins by dispatch order, preventing a slow stale summary
     from clobbering fresher state (e.g. resetting a just-decided export
     route).
   - **Autosave subscriber** debounces 500 ms, writes
     `<workspace>/project.json`. Every 50 flushed autosaves or 5 min,
     copies the current project file to `Backups/<ISO>.json`.
   - **MCP change feed** — the TS host notifies the in-process MCP host,
     which relays to subscribed agents as a streamable-HTTP notification
     (it never reaches the renderer).

Round-trip from commit to preview pixels: next animation frame
(~16 ms at 60 Hz). The PixiJS compositor reads the new project state
directly; no encode-and-swap step.

## Inter-process boundaries

| From → To | Mechanism |
|---|---|
| Renderer → main (→ Rust core) | The contextBridge preload exposes named capabilities (not raw channels); the generic `api.backend.invoke(channel, args)` rides an `ipcRenderer.invoke('backend:invoke', …)` into the main process, where the TS host's `routeChannel` dispatches it — state / config / MCP channels are served in TS; compute channels forward to the napi addon's `Backend.invoke(cmd, argsJson)` dispatcher. |
| Main → Renderer | The main process forwards events as `webContents.send('evt:<event>', payload)` — `project:changed` from the TS actor/host; `import:*`, `media:job_*` from the Rust core via its thread-safe-function callback — surfaced to the renderer via `api.on(event, …)`. |
| Renderer → workspace files | The `weftcut-media://localhost/<encoded-abs-path>` custom protocol (registered privileged + `supportFetchAPI`/`stream`; HTTP `Range`, served from main) — used by the Pixi decoder pool to fetch proxies and originals. The `fs:*` IPC surface (confined to temp / userData / active-workspace roots) handles export-scratch writes and reads. |
| External agent → main (MCP host) | MCP over streamable-HTTP on localhost (`@modelcontextprotocol/sdk` host in the main process; bearer enforced by main, token in `app_config_dir/mcp_auth.json`). The tool catalog + resources are merged in TS — the TS-routed tool defs plus the Rust compute/hybrid tools. |
| Main → External agent | The TS host's change notification, relayed by the in-process MCP host as a streamable-HTTP notification. |
| Rust core → ffmpeg | `ffmpeg-sidecar` subprocess. Used by the audio encode tail (limiter + AAC/Opus), the native video encode sink (the default export engine's ffmpeg-backed encoder), proxy / thumbnail / waveform / conform / frame-extract jobs, audio-extract for transcription, and final mux (stream-copy only). |

## Repository layout

```
weftcut/
  README.md
  docs/                       ← documentation (this directory)
  apps/desktop/               ← the Electron app
    native/                   ← Rust core, built as a napi-rs addon (@weftcut/core)
      eval/                   ← weftcut-eval leaf crate: the pure WYSIWYG math
                              ←   (snap, keyframe eval, envelope, role gate),
                              ←   linked natively here + compiled to wasm for
                              ←   the renderer (ADR 0025)
      src/
        state/                ← project state data types — the model Rust
                              ←   compute deserializes from the slice it is
                              ←   handed (actor/history/validation/autosave in TS)
        audio/                ← envelope contract + export block mixer
                              ←   (conform_reader, mix; docs/audio.md)
        export/               ← export_audio_only (mix + encode tail) +
                              ←   mux_to_file + native video sink
        ffmpeg/               ← sidecar wrapper, install bootstrap
        jobs/                 ← background derivative jobs:
                              ←   proxy, thumbnails, waveform, conform,
                              ←   frame, import (workspace copy worker)
        cache/                ← workspace-scoped derivative cache
                              ←   (workspace/Cache/{proxies, thumbnails,
                              ←    waveforms, audio, frames, transcribe-audio,
                              ←    voiceover, …})
        mcp/                  ← compute/hybrid tool defs + wire + resources
                              ←   (TS owns the merged catalog; HTTP host in
                              ←   src/main/mcp)
        speech/               ← provider-agnostic speech backends:
                              ←   Transcriber / Synthesizer + resolver
                              ←   (user preference then availability);
                              ←   cloud (OpenAI key via safeStorage) +
                              ←   local one-shot CLI sidecars (whisper.cpp,
                              ←   FunASR); parse/ normalizes each raw style
                              ←   → one word-timed Transcript
        io/                   ← media probe helpers; project.json load/save
                              ←   and schema-version gate live in TS
                              ←   state/persistence.ts
        logs/                 ← LogBus actor, JSONL writer, tracing bridge
        commands/             ← the command surface dispatched by Backend.invoke
                              ←   (native compute/read handlers; TS owns
                              ←   mutation/history/query/persistence)
        events.rs             ← EventSink + thread-safe-function bridge to main
        subtitles/            ← caption/subtitle parse + compute (docs/captions.md)
        agent_session.rs      ← agent-mode session lifecycle
        workspace.rs          ← WorkspaceSlot tracking current workspace
        bin/                  ← media_conformance analyzer binary
        napi_backend.rs       ← the Backend napi type (invoke + init)
        lib.rs
      Cargo.toml
      package.json            ← napi packaging (@weftcut/core, *.node)
    src/
      main/                   ← Electron main process (TypeScript)
        index.ts             ←   app bootstrap: loads @weftcut/core, wires the
                             ←   backend:invoke / fs:* / window:* / dialog:* IPC,
                             ←   registers the weftcut-media:// protocol
        state/               ←   project actor + history + validation + autosave
                             ←   + workspace orchestrator + MCP commands
                             ←   (THE sole state writer; ts-actor-host + router)
        mcp/                 ←   streamable-HTTP MCP host (SDK + bearer)
        motif/               ←   offscreen-CDP capture host + motif: protocol
        keys.ts              ←   safeStorage cloud-key persistence
        app-settings.ts view-state.ts export-settings.ts keybindings.ts
        recents.ts           ←   config/preference stores (TS-owned; persist the
                             ←   same JSON files the Rust stores used to)
        windows.ts fsGuard.ts
      preload/                ← contextBridge surface (api.backend / fs / window / …)
        index.ts
      shared/                 ← IPC types shared between main + renderer
        ipc.ts
        app-settings.ts view-state.ts keybindings.ts recents.ts
                              ←   config-store types (main owns persistence)
        motifs/               ← motif types shared main↔renderer
      renderer/               ← React + TypeScript UI (PixiJS + WebCodecs)
        startup/              ← Create / Open / Recent screen
        preview/              ← <PreviewSurface> mounting the Pixi compositor
        render/               ← PixiJS + WebCodecs renderer
          Compositor.ts       ←   scene graph + per-frame compositor
                              ←   (the host owns the PixiJS Application)
          clock.ts            ←   audio-master clock (anchor-derived;
                              ←   wall fallback while suspended)
          PlaybackEngine.ts   ←   transport
          decoder/            ←   SourceDecoderPool, PacketPump, mediaInput,
                              ←   FrameRing, ExportDecoderPool,
                              ←   probeSourceDecodable, scrub
          sprite/             ←   per-layer-kind Sprite implementations
          motifs/             ←   motif raster cache + frame descriptor helpers
          worker/             ←   exportWorker + encoder (OffscreenCanvas)
          audio/              ←   buffer-scheduled preview mixer:
                              ←   AudioGraph (master bus), AudioMixer,
                              ←   conformSource, chunkSchedule, envelope
                              ←   (sampler grid/fades in TS; dB + keyframe +
                              ←   role-gate math via the eval wasm leaf;
                              ←   docs/audio.md)
          fixtures/           ←   runFixture + browser-test fixtures
        bridge/               ← renderer-side IPC client over window.api
        timeline/
        properties/
        panels/               ← side / floating panels
        connect/              ← Connect-agent panel
        settings/             ← Settings panel (Transcription / Speech,
                              ←   API keys, data location, …)
        logs/                 ← status bar + log console
        keyframe/             ← keyframe authoring + curve editing
        menu/ shortcuts/ agent/ hooks/ ipc/ i18n/ state/
    electron.vite.config.ts   ← main / preload / renderer build config
    electron-builder.yml      ← packaging + per-OS installers
```

## External dependencies

- **electron** — desktop shell: main/renderer processes, IPC, window
  management, and the privileged `weftcut-media://` custom protocol for
  renderer access to workspace files.
- **@napi-rs/cli** + **napi** / **napi-derive** — build the Rust core as
  an in-process Node addon (`@weftcut/core`) that the main process loads.
- **electron-vite** — bundles main / preload / renderer; **electron-builder**
  produces the per-OS installers.
- **@modelcontextprotocol/sdk** + **express** — the streamable-HTTP MCP
  host that runs in the main process and fronts the merged tool catalog
  (TS-routed tool defs + the Rust compute/hybrid tools).
- **ffmpeg-sidecar** — auto-downloads ffmpeg on first run.
- **immer** — TS actor drafts and frozen immutable project snapshots.
- **imbl** — Rust project model collections used when deserializing
  per-call project slices for native compute/export paths.
- **tokio** — async runtime, channels.
- **serde** / **serde_json** / **schemars** — serialization, JSON
  Schema generation shared between the MCP tool catalog and the
  `Backend.invoke` command bridge.
- **uuid** — v7 IDs for all addressable entities.
- **blake3** — content hashing (cache keys, file dedup).
- **reqwest** (rustls) — HTTP client for cloud-provider integrations.
- **pixi.js** v8 — renderer-side compositor.
- **mediabunny** — renderer-side demuxer / muxer for the WebCodecs
  pipeline (MP4/MOV + Matroska/WebM), reading through a
  `weftcut-media://` Range `CustomSource`.
- **i18next** + **react-i18next** — frontend i18n; bundled resources
  for `en-US` and `zh-CN`.
- **tailwindcss** v4 (`@tailwindcss/vite`) — design-token carrier +
  utility layer; entry at `src/renderer/app.css`.
- **@base-ui/react** — headless widget primitives (dialog, menu/menubar,
  select, slider, tooltip) behind the app wrapper components.

## UI widget & styling layer

The widget layer rides [Base UI](https://base-ui.com) primitives behind
app-level wrappers; Tailwind v4 carries the design tokens; the legacy
stylesheet keeps the visual identity. Decision + the full cascade
contract: [ADR 0018](adr/0018-ui-widgets-on-base-ui-with-tailwind-tokens.md).
The rules a day-to-day change must respect:

| Rule | Why |
|---|---|
| New modals go through `components/AppDialog` (omit `onClose` for an undismissable working-state). | One dismissal/focus/aria behavior app-wide. |
| Form dropdowns/sliders use `components/AppSelect` / `AppSlider` — never native `<select>` / `<input type="range">`. | App-styled popups, shared keyboard behavior. |
| A component that consumes Escape inside a dialog must `stopPropagation()`. | Base UI closes the dialog on Escape otherwise. |
| `styles.css` is unlayered and beats Tailwind's layered output; don't stack utilities onto elements legacy rules target — remove the legacy rule instead. | Layered-vs-unlayered cascade ordering. |
| If a layout relied on a UA default that preflight resets, pin the value explicitly in `styles.css` (`line-height` is the canonical case). | Preflight only leaks through UA-default reliance. |
| Tokens live in `src/renderer/app.css` (`.dark` block, shadcn naming + a dark-NLE semantic role layer on top — full reference: [ui-tokens.md](ui-tokens.md)); the app is dark-only via the hardwired `html.dark`. | Single palette source; the `var(--*)` sweep is done, with semantic roles layered above. |
| Icons come from [lucide](https://lucide.dev/icons) via `lucide-react` named imports (`size` explicit, `aria-hidden`, color via `currentColor`) — no inline `<svg>`, no Unicode glyphs. [ADR 0020](adr/0020-ui-icons-from-lucide-react.md); `WindowControls` and CSS cursors are the documented exceptions. | One drawing style; glyph rendering no longer font-dependent. |

## Internationalization (UI)

The renderer is bilingual: **English (US)** as the source/default,
**Simplified Chinese** (`zh-CN`) as the second supported locale.
Adding more locales is a strict addition — drop a resource file under
`apps/desktop/src/renderer/i18n/locales/`, register it in the init module.

| Layer | Strategy |
|---|---|
| UI labels (React) | `i18next` keys via `useTranslation()` / `<Trans>`. |
| Rust logs / `tracing` output | Stay English. Operator-facing. |
| Backend command errors | Tagged structured form (`{kind, detail}`) returned from `Backend.invoke` to the UI; the UI maps recognized kinds to localized messages. |
| MCP tool errors | English machine-readable strings. Agents do their own translation. |
| Built-in motifs | Each motif carries text in its props; localization is per-project content. |
| Date / time / number formatting | `Intl.DateTimeFormat` and `Intl.NumberFormat` with the active locale. |

## See also

- [Data model](data-model.md) — what the actor stores and emits.
- [Render](render.md) — PixiJS + WebCodecs renderer architecture.
- [Motifs](motifs.md) — parameterized web overlays captured via the DevTools Protocol: authoring contract, capture harness, raster cache.
- [Preview](preview.md) — interactive preview surface.
- [Export](export.md) — export orchestration + final mux.
- [Audio](audio.md) — conform cache, envelope contract, preview + export mixers.
- [Conformance](conformance.md) — media fixtures and E2E gates.
- [Features](features.md) — small-feature contracts (undo scope, groups, search palette, color picker).
- [MCP](mcp.md) — agent connection protocol and tool surface.
- [v1 target](https://github.com/UncleChair/WeftCut/issues/11) — release scope
  and open work. This lives in the issue tracker, not in `docs/`: everything
  here describes what exists today.
