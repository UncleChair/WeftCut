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

### Export decode redundancy — resolved, nothing actionable left

Export decode dispatch sits ON the inherent floor across the timeline
shapes that used to thrash (single clip, sequential source re-use,
different-phase overlap, mid-GOP range entry) — measured via the
`__weftcutExportPerf` counters with
`e2e/tools/perf_export_redundancy.e2e.js`. The phase-keyed pipeline
grouping in [`render.md`](render.md) collected the old "up to ~4.35×"
lever; what remains is inherent cost, not waste: a different-phase
overlap decodes one pass per phase (sharing would need a ring deeper
than the WebCodecs buffer pool), and a mid-GOP entry decodes from the
GOP key (long-GOP sources, unavoidable without re-keyframing).
Revisit only if Speed / reverse playback lands — a backward-marching
source mapping is the one shape the forward-only pipelines don't
cover. Preview keeps its own sibling item (warm-decoder handoff
across sequential cuts, designed in [`render.md`](render.md)).

### Zero-copy GPU frame upload — deprioritized, measure first

Export composites a decoded `VideoFrame` by snapshotting it into a 2D
`OffscreenCanvas` (`VideoClipSprite`) before Pixi uploads the canvas.
The snapshot exists because Pixi's raw-`VideoFrame` upload
(`copyExternalImageToTexture`) ignores the frame's `colorSpace` and
converts every frame as BT.709/limited — a destructive pixel
mis-convert for 601 / full-range sources (screen recordings, phone
footage), not a repairable tag error. The prohibition and both
surfaces' conforming paths are documented in [`render.md`](render.md)
("the snapshot rule") and ADR 0014.

**Deliberately parked at lowest priority.** Color correctness is fully
handled today at zero marginal cost — the snapshot *is* the honoring
conversion. What zero-copy would buy is removing one per-frame blit in
offline export, a cost that is bounded, unmeasured, and instrumented
(`__weftcutExportPerf` `compositeMs`); the full replacement is heavy
(bespoke Pixi pass, a permanent WebGL dual-path, external-texture
sampling limits, a fresh conformance pass). Do not start without
profiling showing the blit matters (4K export is where it would).

If profiling ever justifies it, the staged plan:

1. **colorSpace-routed hybrid first.** The raw upload's fixed-function
   conversion is *correct* for bt709/limited frames — the dominant
   content class. Route in `VideoClipSprite`: raw-bind frames whose
   `colorSpace` is bt709/limited, keep the snapshot for everything
   else. One branch plus one analyzer run; no custom shaders, the
   conformance gate stays untouched.
2. **`importExternalTexture` as last resort.** A standalone POC
   (`apps/desktop/e2e/tools/iso_importexternaltexture.e2e.js`) confirms
   WebView2 HONORS the matrix through `importExternalTexture` +
   `textureSampleBaseClampToEdge` (601 and 709 sample to distinct RGB),
   so full zero-copy is *possible* without losing color correctness.
   The design work it defers:
   - **Custom Pixi pass.** Pixi's `TextureSource` model only does
     `copyExternalImageToTexture`; it never imports an external
     texture. Needs a bespoke `GpuProgram` + bind group re-importing
     the per-frame `GPUExternalTexture` (it expires each frame).
   - **WebGL fallback.** `importExternalTexture` is WebGPU-only. The
     export's WebGL path (no `navigator.gpu`) keeps the snapshot, so
     both paths coexist permanently.
   - **Sampling limits.** External textures sample only via
     `textureSampleBaseClampToEdge` — no mips, bilinear only — so
     heavily downscaled clips lose filtering quality vs a canvas
     texture; large-downscale sprites may need the snapshot anyway.
   - **Color-management exactness.** `importExternalTexture` does a
     full matrix + primaries/transfer → sRGB conversion whose exact
     output differs from `drawImage` on chromatic values; the external
     texture's `GPUExternalTextureDescriptor.colorSpace` is the lever.
     Whichever path ships must re-pass the color-conformance gate (the
     analyzer is the arbiter), watching the non-primary patches where
     any primaries residual surfaces.

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
- **HDR preview sink and wider-gamut working space.**
  The native encode exit exists: the 10-bit pipeline's Rust video sink
  (`export/videosink.rs`, loopback WebSocket → ffmpeg rawvideo → Main10
  encoder) ships the ffmpeg encoder surface that was the main prize of the
  old "native Rust export backend" item. What remains gated on the HDR-
  deliverable trigger is: (a) the **HDR preview sink** — `rgba16float`
  WebGPU canvas with `toneMapping:{mode:'extended'}` in Pixi; this requires
  the Pixi WebGPU pipeline-cache patch (tracked upstream as PR #12020 /
  issue #12019) or the verified runtime override, plus real HDR-glass
  verification on Windows; (b) the **wider-gamut working space** — evolving
  ADR 0021's ingest chokepoint from display-referred BT.709 to a scene-light
  or wide-color-gamut space, which changes blending semantics and needs a
  full conformance re-pass. Both remain post-v1 and both gate on HDR output
  becoming a real deliverable requirement.
  Follow-up in the 10-bit bucket: **HEVC Main10 source conform** — HW-opaque
  HEVC frames cannot `copyTo` (P1 probe finding), so 10-bit HEVC originals
  currently proxy to a SW-decodable form; `importExternalTexture` or a
  format-conversion approach is the open P6 investigation.
  Distinct from the "WebGPU compositor backend" item above (that's real-time
  effects; this is the output pipeline and preview sink).
