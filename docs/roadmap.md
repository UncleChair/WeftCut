# Roadmap

The foundation is in place: project state actor + history, workspace
on-disk format, media import with proxy / thumbnail / waveform jobs,
audio IR + ffmpeg export + final mux, PixiJS + WebCodecs renderer
(preview and export share one compositor), built-in HTML template
catalog with foreignObject rasterizer, cloud transcription + TTS
behind a provider-agnostic trait surface, the MCP server with its
edit / workflow / cloud tools and the `/events` change feed, the
status-bar `LogBus` console, the i18n stack (en-US + zh-CN).

This doc tracks what's left between here and v1. Detail per area
lives in the topical doc — this is the index.

## Open work

### Effect subsystem on the PixiJS path

The IR-driven per-layer effects subsystem was deleted with the PixiJS
migration. A redesign lives in `apps/desktop/src/render/sprite/` as
additional per-sprite effect chains, plus an actor surface
(`add_effect`, `update_effect`, `move_effect`, `remove_effect`) and
the corresponding MCP tools. Same redesign unblocks per-frame
`Animated<T>` sampling, which is what gates the `add_keyframe` /
`update_keyframe` / `remove_keyframe` MCP tools — see
[`data-model.md`](data-model.md).

### macOS and Linux verification

The PixiJS + WebCodecs path runs in WebView2 today; WKWebView and
WebKitGTK both ship WebCodecs but neither has been exercised against
the live app. The platform-specific work is:

- Build + run the dev shell on each OS.
- Confirm the WebCodecs / PixiJS / mediabunny / JASSUB stack decodes
  the proxy and produces frame-identical output across platforms.
- Confirm `ffmpeg-sidecar`'s auto-download works on each platform
  (and that the proxy SOCKS fallback in [`setup.md`](setup.md) is the
  only required workaround).

### MCP token enforcement

The bearer token is generated and surfaced today but not enforced —
rmcp 0.1.x's `SseServer` exposes no middleware hook. The realistic
paths are:

- **axum reverse-proxy** in front of rmcp's SSE server (~100-200 LoC,
  must own the `/sse` stream + `/message` POST forwarding). Lands
  today; defers until threat model justifies it.
- **rmcp 1.x** with `tower::Layer`. Blocked on Claude Desktop adopting
  streamable-HTTP for local servers.

Flipping the bind from `127.0.0.1` to `0.0.0.0` needs enforcement
first.

### Polish

- Undo / redo UI: history panel showing per-actor edits.
- Checkpoints UI: named save points, agent-rollback affordance.
- Error toasts with structured-error options ("Create new track" /
  "Trim existing") instead of raw text.
- Onboarding tour on first workspace open.
- App icon, splash, About dialog.
- Crash reporter (opt-in).
- Template-picker thumbnails for the remaining starter templates
  (currently rendered lazily; verify each template renders end-to-end
  through the picker → export path).
- Media-pool thumbnail strip and timeline waveform strip on audio
  layers (backend data already cached; both are React + canvas work).

### Cache layout consolidation

The derivative cache currently lives at the OS app-cache root
(`<app-cache>/proxies|thumbnails|waveforms|frames|raster|voiceover`)
rather than under each workspace's `Cache/` subdirectory as
[`data-model.md`](data-model.md) describes. Cross-project hits keep
the deviation cheap, but consolidating to per-workspace `Cache/`
is the right shape when "everything for this project lives in the
folder" becomes a feature.

### MCP tool gating

rmcp 0.1.x's `tool_box` macro registers tools at compile time with no
per-session filter hook. Unconfigured cloud tools are listed and
return `MissingKey` errors instead of being hidden. Revisit when rmcp
gains per-session filtering — the alternative is omitting
unsupported cloud tools from `list_tools` entirely.

### Transitions beyond crossfade

`Transition` ships with crossfade / dissolve via ffmpeg's
single-input `fade` filter and a transition-aware `LayerOverlap`
validator. Additional types (wipe, slide, push) land as new
`TransitionKind` variants + lowering arms + property-panel UI.

## v1 ship checklist

- [ ] All open-work sections above resolved or deliberately deferred.
- [ ] Linux: feature-complete or documented degraded mode.
- [ ] CI green: build + lint + unit + integration on all platforms.
- [ ] Code signing on Windows + macOS.
- [ ] Auto-update wired (`tauri-plugin-updater`).
- [ ] Docs site live with Getting Started + agent connection guides.
- [ ] At least one third-party MCP client tested (Cursor or Cline
      alongside Claude Desktop).

## Post-v1 (not committed)

- Tree-of-edits history (branch, merge).
- WebGPU compositor backend tuned for real-time effects.
- Marketplace / sharing for HTML overlay templates.
- Multi-window timelines.
- Mobile companion (Tauri mobile or React Native).
- Remote-server MCP variant (Tailscale-friendly) with proper auth.
- Plugin system for third-party effects via WebAssembly.
- Collaboration (CRDT-based shared editing).
