<p align="center">
  <img src="apps/desktop/src/renderer/public/icons/icon.svg" alt="WeftCut" width="128" height="128" />
</p>

<h1 align="center">WeftCut</h1>

WeftCut is a cross-platform, web-based desktop video editor where **external AI agents are first-class citizens**. Connect Claude Desktop, Cursor, or any MCP-capable client to a localhost MCP server and let an agent edit your timeline through a structured tool surface — while you watch the changes land in the UI in real time and collaborate on editing.

## Why this is different

Most editors bolt AI on as features. WeftCut exposes the editor *as* a tool surface. The intelligence lives in whoever connects; the app stays small, fast, bring-your-own-API-key, and free of bundled models.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Electron (Rust core via a napi addon, Chromium UI) |
| UI | React 19 + `@pixi/react` in the renderer |
| Renderer | PixiJS v8 + WebCodecs (preview on `<canvas>`, export in a Worker on `OffscreenCanvas`) |
| Audio export + final mux | ffmpeg via `ffmpeg-sidecar` |
| Container demux/mux | `mediabunny` (WebCodecs pipeline; MP4/MOV + Matroska/WebM) |
| Subtitles | `jassub` (libass-wasm) |
| Agent protocol | MCP over streamable-HTTP (`@modelcontextprotocol/sdk`, hosted in the Electron main) |
| UI i18n | `i18next` + `react-i18next` (en-US, zh-CN) |
| Optional cloud | OpenAI (Whisper transcription, tts-1 TTS) — user-supplied key |

No local AI models. No bundled Chromium. No server backend.

## Documentation

- **[Architecture](docs/architecture.md)** — system overview, components, data flow, repo layout.
- **[Data model](docs/data-model.md)** — project state schema, history, persistence, validation.
- **[Render](docs/render.md)** — PixiJS + WebCodecs renderer architecture.
- **[Motifs](docs/motifs.md)** — parameterized web overlays (CDP capture, raster cache, user-authored catalog).
- **[Preview](docs/preview.md)** — interactive preview surface and transport.
- **[Rendering](docs/rendering.md)** — audio IR, audio export, final mux.
- **[Conformance](docs/conformance.md)** — media fixtures and E2E gates for frame alignment, audio sync, and color.
- **[MCP server & agent UX](docs/mcp.md)** — protocol, tool surface, resources, multi-agent.
- **[Groups](docs/groups.md)** — flat group model that bundles layers across tracks.
- **[Status / Log system](docs/status-log.md)** — bottom-of-editor log bus.
- **[Undo-stack scope](docs/undo-stack-scope.md)** — what records into history and what doesn't.
- **[Setup](docs/setup.md)** — per-OS toolchain prerequisites and first-run flow.
- **[Roadmap](docs/roadmap.md)** — phased delivery journal.
- **ADRs** — [`docs/adr/`](docs/adr/) (0001–0017): architecture decisions with a `status` frontmatter field (`accepted`, `proposed`, or `superseded`). Prefer [`docs/rendering.md`](docs/rendering.md) and other top-level docs for current export/audio behavior; older ADRs may be historical.

## Getting started

Prerequisites — see [docs/setup.md](docs/setup.md) for per-OS install commands:

- **Rust** (stable, via `rustup`; this repo declares its wasm target in `rust-toolchain.toml`)
- **MSVC Build Tools** (Windows) / **Xcode CLT** (macOS) / build tools (Linux)
- **Node 20+**

Electron bundles its own Chromium, so there is no per-OS webview runtime to install.

After installing prerequisites, from the repo root:

```sh
npm install
npm run dev
```

`npm run dev` builds the Rust core, starts Vite, and opens the Electron window.
ffmpeg is auto-downloaded on first run via `ffmpeg-sidecar`; if that fails
behind a SOCKS proxy, see the ffmpeg section in [setup.md](docs/setup.md).

Other root scripts: `npm run typecheck` (TypeScript project references),
`npm run build` (release bundle — icon set and packaging notes in
[setup.md](docs/setup.md)).

Project layout follows the [architecture doc](docs/architecture.md):

```
apps/desktop/        Electron app
  native/            Rust core (state actor, ir, export, ffmpeg, jobs, cache,
                     mcp, cloud, io, logs, motifs, …)
  src/               React UI + PixiJS/WebCodecs renderer (+ export Worker)
docs/                design + architecture
```
