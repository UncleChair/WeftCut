# WeftCut

A cross-platform desktop video editor where **external AI agents are first-class collaborators**. Connect Claude Desktop, Cursor, or any MCP-capable client to a localhost MCP server and let an agent edit your timeline through a structured tool surface — while you watch the changes land in the UI in real time.

## Why this is different

Most editors bolt AI on as features. WeftCut exposes the editor *as* a tool surface. The intelligence lives in whoever connects; the app stays small, fast, bring-your-own-API-key, and free of bundled models.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (Rust core, system webview UI) |
| Video engine | ffmpeg via `ffmpeg-sidecar` |
| Preview player | libmpv as embedded native widget |
| UI | React in the webview |
| Agent protocol | MCP over Streamable HTTP (`rmcp` crate) |
| Templated overlays | Offscreen webview rasterizer (built on `wry`) |
| UI i18n | `i18next` + `react-i18next` (en-US, zh-CN) |
| Optional cloud | Whisper API / Deepgram (user-supplied keys) |

No local AI models. No bundled Chromium. No server backend.

## Documentation

- **[Architecture](docs/architecture.md)** — system overview, components, data flow, repo layout.
- **[Data model](docs/data-model.md)** — project state schema, history, persistence, validation.
- **[Rendering](docs/rendering.md)** — IR compiler, render graph, offscreen rasterizer.
- **[MCP server & agent UX](docs/mcp.md)** — protocol, tool surface, resources, multi-agent.
- **[Roadmap](docs/roadmap.md)** — phased delivery plan and scope per phase.

## Status

Pre-alpha. Architecture defined. Implementation begins at Phase 0 (spike) — see [roadmap](docs/roadmap.md).

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
  src-tauri/         Rust core (state, ir, ffmpeg, mpv, raster, mcp, io, cloud)
  src/               React UI
packages/templates/  built-in HTML overlay templates
docs/                design + architecture
```
