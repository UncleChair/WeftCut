# Roadmap

The foundation is in place: project state actor + history, workspace
on-disk format, media import with proxy / thumbnail / waveform jobs,
audio IR + ffmpeg export + final mux, PixiJS + WebCodecs renderer
(preview and export share one compositor), the Motif catalog
(built-in + user-authored, with an agent authoring loop over MCP),
cloud transcription + TTS
behind a provider-agnostic trait surface, the MCP server with its
edit / workflow / cloud tools and the `/events` change feed, the
status-bar `LogBus` console, the i18n stack (en-US + zh-CN).

This doc tracks what's left between here and v1. Detail per area
lives in the topical doc — this is the index.

## Open work

### Keyframes (`Animated<T>` goes live)

The schema and both interpolation engines already exist (Rust
`state/animated.rs::value_at`, TS `render/animated.ts::resolveAnimated`,
byte-identical); what's missing is transport and evaluation:
`projectSummary` flattens every `Animated<T>` to a static scalar, so
the renderer never sees keyframes. The work: ship `AnimTrack<T>`
through the `LayerSummary` views, pre-resolve per frame in the
Compositor (sprites stay schema-agnostic), exempt animated properties
from sprite signature caches (text color via tint, not re-raster),
add a cross-language golden-vector test over the engine copies before
enabling, then the `add_keyframe` / `update_keyframe` /
`remove_keyframe` actor surface + MCP tools. Export needs no extra
work — the Worker clones the same summary and runs the same
Compositor. Trim-vs-keyframe validation rules need defining. See
[`data-model.md`](data-model.md).

### Effect subsystem on the PixiJS path

The IR-driven per-layer effects subsystem was deleted with the PixiJS
migration. The redesign is per-sprite Pixi filter chains driven by
`layer.effects` — the field already ships over IPC; the Compositor
just never reads it. Animated effect parameters ride the keyframe
work above (keyframes first, then effects). Schema cleanup on the way
in: cull the HTML-era `HtmlTransform` variant; `Speed` is time
remapping, not a filter, and needs its own design. Actor surface
(`add_effect`, `update_effect`, `move_effect`, `remove_effect`) and
the corresponding MCP tools follow. Filters break batching (one
render-target switch per filtered sprite) — plan a preview-LOD flag
from day one.

### Subtitle import + export

Subtitles render in preview (JASSUB) but are omitted from export —
the Worker has no DOM host and there is no burn-in path
(`Compositor.ensureSubtitles`). Phased work, not a defect: the
planned feature adds subtitle import plus an export surface in the
export settings — burn-in via ffmpeg's `subtitles` filter at the
transcode/mux stage, and/or a sidecar subtitle track for containers
that carry one (mkv).

### Export decode redundancy

Same-phase clips of one source (stacked copies, trims of one pass) now
share a merged-range decode pipeline (`exportHandleKey` grouping, see
[`render.md`](render.md)), so identical ranges are decoded once. What
remains is the cross-chunk re-seek redundancy: a backward clip-reuse
jump re-decodes from the GOP key, and different-phase overlaps each
pay their own full decode — measured up to ~4.35× dispatched packets
via the committed `__weftcutExportPerf` counters on adversarial
timelines, roughly a 30–45% export-time lever. The fix shape is
continuous-forward decode (serve a backward-jumping clip from a
second forward pass instead of re-seeking). Preview has the sibling
optimization already designed in [`render.md`](render.md): sharing a
warm decoder across sequential cuts of one source.

### Zero-copy color-correct GPU frame upload

Export composites a decoded `VideoFrame` by snapshotting it into a 2D
`OffscreenCanvas` (`VideoClipSprite`) before Pixi uploads the canvas.
The snapshot exists because Pixi's WebGPU upload of a raw `VideoFrame`
(`copyExternalImageToTexture`) ignores the frame's `colorSpace` and
converts every frame as BT.709, so non-709 sources mis-convert; a 2D
`drawImage` performs the YUV→RGB conversion honoring the frame's
matrix/range. Correct, but it costs a per-frame GPU blit that scales
with resolution.

The zero-copy alternative is WebGPU `importExternalTexture` sampled via
`textureSampleBaseClampToEdge` in a custom shader. A standalone POC
(`apps/desktop/e2e/tools/iso_importexternaltexture.e2e.js`) confirms
WebView2 HONORS the matrix through this path (601 and 709 sample to
distinct RGB), so it can replace the snapshot without losing color
correctness. The design work this defers:

- **Custom Pixi pass.** Pixi's `TextureSource` model only does
  `copyExternalImageToTexture`; it never imports an external texture.
  The export composite needs a bespoke `GpuProgram` + bind group that
  re-imports the per-frame `GPUExternalTexture` (it expires each frame)
  and samples it.
- **WebGL fallback.** `importExternalTexture` is WebGPU-only. The
  export's WebGL path (no `navigator.gpu`) still needs the 2D-canvas
  snapshot, so both coexist.
- **Color-management exactness.** `importExternalTexture` does a full
  matrix + primaries/transfer → sRGB conversion whose exact output
  differs from `drawImage` on chromatic values; the snapshot path's
  `drawImage` has no `colorSpaceConversion` knob, whereas the external
  texture's `GPUExternalTextureDescriptor.colorSpace` is the lever.
  Whichever path ships must be validated against the color-conformance
  gate (the analyzer is the arbiter), watching the non-primary patches
  where any primaries residual surfaces.

### Full-range source color fidelity through the proxy

Full-range (`pc`) sources lose their range on export: the output is
limited-range (`tv`) while the source is full-range, a real `pc`→`tv` squash
(confirmed by ffprobe). The suspected cause is the proxy re-encode dropping full
range — full-range sources are expected to route through a proxy — though that
routing hasn't been directly confirmed. The color-conformance gate keeps these
encodings (`709full`, `601full`) marked known-bad against a perceptual metric
(see ADR 0014). First step is to confirm the path (DirectExport vs proxy for a
full-range source); the fix is then either preserving the source range through
the proxy re-encode, or routing full-range sources through DirectExport so they
decode from the original like the limited-range cases already do.

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
- Motif-picker thumbnails for the remaining starter Motifs
  (rendered lazily via a CDP still; verify each Motif renders end-to-end
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
- Marketplace / remote sharing for user Motifs (the current feature is
  deliberately local-only — no registry).
- Multi-window timelines.
- Mobile companion (Tauri mobile or React Native).
- Remote-server MCP variant (Tailscale-friendly) with proper auth.
- Plugin system for third-party effects via WebAssembly.
- Collaboration (CRDT-based shared editing).
- **Native Rust export backend (wgpu compositing + ffmpeg 10-bit encode).**
  The escape hatch from the WebCodecs *output* ceiling: WebView2's encoder
  emits 8-bit only and ignores the input `colorSpace` (resolution-default
  BT.709 tagging — see ADR 0014 / [`render.md`](render.md)), so true 10-bit /
  HDR output and exact color-tag control are unreachable in-webview. A native
  render/export path — decode → wgpu composite → ffmpeg encode (x265 Main10 /
  libaom 10-bit) with no webview round-trip — lifts both ceilings and drops the
  asset-scheme per-frame transfer cost. Scope it to the *export* path only; the
  React/Pixi editor stays for editing (no native-GUI / gpui rewrite — gpui has
  no custom-GPU-render hook today anyway). Revisit only if 10-bit/HDR output
  becomes a real deliverable requirement; today the practical loss is a single
  transcode generation, since output is 8-bit either way. Distinct from the
  "WebGPU compositor backend" item above (that's in-webview real-time effects;
  this is the native output pipeline).
