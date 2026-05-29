# WeftCut

WeftCut is a cross-platform desktop video editor where **external AI agents are first-class collaborators**. Connect Claude Desktop, Cursor, or any MCP-capable client to a localhost MCP server and let an agent edit your timeline through a structured tool surface — while you watch the changes land in the UI in real time.

## Why this is different

Most editors bolt AI on as features. WeftCut exposes the editor *as* a tool surface. The intelligence lives in whoever connects; the app stays small, fast, bring-your-own-API-key, and free of bundled models.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (Rust core, system webview UI) |
| UI | React in the webview |
| Renderer | PixiJS v8 + WebCodecs (preview on `<canvas>`, export on `OffscreenCanvas`) |
| Audio export + final mux | ffmpeg via `ffmpeg-sidecar` |
| Container demux/mux | `mp4box.js` |
| Subtitles | JASSUB (libass-wasm) |
| Agent protocol | MCP over SSE (`rmcp` 0.1.x) |
| UI i18n | `i18next` + `react-i18next` (en-US, zh-CN) |
| Optional cloud | OpenAI (Whisper transcription, tts-1 TTS) — user-supplied key |

No local AI models. No bundled Chromium. No server backend.

## Documentation

- **[Architecture](docs/architecture.md)** — system overview, components, data flow, repo layout.
- **[Data model](docs/data-model.md)** — project state schema, history, persistence, validation.
- **[Render](docs/render.md)** — PixiJS + WebCodecs renderer architecture.
- **[Preview](docs/preview.md)** — interactive preview surface and transport.
- **[Rendering](docs/rendering.md)** — audio IR, audio export, final mux.
- **[MCP server & agent UX](docs/mcp.md)** — protocol, tool surface, resources, multi-agent.
- **[Groups](docs/groups.md)** — flat group model that bundles layers across tracks.
- **[Status / Log system](docs/status-log.md)** — bottom-of-editor log bus.
- **[Undo-stack scope](docs/undo-stack-scope.md)** — what records into history and what doesn't.
- **[Setup](docs/setup.md)** — per-OS toolchain prerequisites and first-run flow.
- **[Roadmap](docs/roadmap.md)** — phased delivery journal.
- **ADRs** — [0001 audio compositing in TS](docs/adr/0001-audio-compositing-in-ts.md), [0002 mediabunny demux/mux](docs/adr/0002-mediabunny-demux-mux.md), [0003 forward GOP crossing](docs/adr/0003-forward-gop-crossing-no-decoder-reset.md), [0004 ImageBitmap snapshot](docs/adr/0004-imagebitmap-snapshot-frame-ring.md).

## Getting started

Prerequisites — see [docs/setup.md](docs/setup.md) for install commands:

- **Rust** (stable, via `rustup`)
- **MSVC Build Tools** (Windows) / **Xcode CLT** (macOS) / **gcc + webkit2gtk-4.1** (Linux)
- **Node 20+**
- **WebView2** runtime (preinstalled on Windows 11)

Once prerequisites are installed:

```sh
npm install
npm run dev     # launches Tauri dev shell
```

Project layout follows the [architecture doc](docs/architecture.md):

```
apps/desktop/        Tauri 2 app
  src-tauri/         Rust core (state, ir, ffmpeg, jobs, mcp, io, cloud, templates)
  src/               React UI + PixiJS/WebCodecs renderer
docs/                design + architecture
```
