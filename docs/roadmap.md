# Roadmap

The foundation is in place: the project state actor + history (TypeScript,
Electron main), the workspace on-disk format, media import with proxy / thumbnail / waveform jobs,
audio IR + ffmpeg export + final mux, PixiJS + WebCodecs renderer
(preview and export share one compositor), the Motif catalog
(built-in + user-authored, with an agent authoring loop over MCP),
cloud transcription + TTS
behind a provider-agnostic trait surface, the MCP server (streamable-HTTP,
hosted in the Electron main) with its edit / workflow / cloud tools and
its in-protocol change feed, the status-bar `LogBus` console, the i18n
stack (en-US + zh-CN).

This doc tracks what's left between here and v1. Detail per area
lives in the topical doc — this is the index.

## Open work

### Keyframes — authoring, sub-lanes, and MCP tools shipped; multi-select + extras remain

`Animated<T>` is live end-to-end. `AnimTrack<T>` flows through the
`LayerSummary` views and resolves per frame in the shared Compositor
(preview == export, golden-vector-locked engines), and **authoring
shipped**: a per-property stopwatch + auto-key in the inspector,
collapsed-mode diamonds on the clip (click-seek / drag-retime / delete /
interpolation menu), and the `update_layer_param_track(s)` actor surface
(normalized, recorded, undoable). **Expanded-mode per-property sub-lanes
shipped** too (`KeyframeLane`): twirl a track open on the header to
AE-style per-property rows (union of the keyframed properties across the
track's layers), each diamond click-seek / drag-retime / delete /
interpolation-menu, with out-of-range keys dimmed. Trim and split keep
keyframes content-anchored — non-destructive, out-of-range keys retained
(so the layer validator permits keyframe times outside `[0, duration]`).
Verified by an export-sampling e2e. The same authoring is exposed over
MCP — `get_param_track`, `set_keyframe`, `remove_keyframe`,
`retime_keyframe`, `set_keyframe_easing`, `smooth_keyframes`,
`clear_keyframes`, and a low-level `set_param_track` — over the
`update_layer_param_track` write path (timeline-absolute times), with a
shared Rust↔TS golden fixture locking the transform math (see
[`mcp.md`](mcp.md)).

What remains:

- **Multi-select keyframe editing in the sub-lanes** (timeline-redesign spec
  §5). Sub-lane selection and drag are single-keyframe today; the batch
  `update_layer_param_tracks` actor command exists but no UI rides it yet.
  Add marquee box-select and cross-property/cross-layer multi-drag (one undo
  via that batch surface).
- **A color stopwatch + MCP color keyframing.** `Animated<Rgba>` now
  interpolates end-to-end — OkLab + premultiplied alpha in the shared
  `weftcut-eval` engine (a native `value_at` twin plus a wasm packed-i32 preview
  shim, locked by a Chromium `color-mix(in oklab)` golden), wired through
  `resolveView` so keyframed text and color-fill color render in preview and
  export. What remains is the authoring surface: a color stopwatch in the
  inspector and the MCP color-keyframe tools.

See [`data-model.md`](data-model.md).

### Effect subsystem — beyond v1

The per-layer effects subsystem ships v1: per-sprite Pixi filter chains
driven by a `layer.effects` field — the Blur and Chroma Key filters, scalar
(`Animated<f64>`) params, the `add_effect`/`update_effect`/`move_effect`/
`remove_effect` actor + MCP surface, keyframe support via the param key
`effects[<id>].params[<key>]`, a `preview_effects_enabled` LOD toggle, and an
inspector effect editor (chain list / filter picker / per-param keyframable
rows on every visual kind). See
[ADR 0027](adr/0027-per-layer-effects-pixi-filter-chains.md) and
[`render.md`](render.md). Remaining:

- **Grow the filter catalog** beyond Blur and Chroma Key (brightness /
  contrast / saturation, then the wider pixi-filters set). Each filter is one
  `effectRegistry.ts` entry, classified `f16-verified` or
  `precision-reduced` by the GL-parity gate.
- **Non-scalar params** — a `ParamValue` sum type (color / bool / enum);
  v1 is scalar-only. Animated color params can now reuse the `Animated<Rgba>`
  interpolation engine (OkLab, shared `weftcut-eval`); what's missing is the
  `ParamValue` lowering through the effect-param surface.
- **Preview-effects LOD toggle UI** — the inspector effect editor (chain
  list / filter picker / per-param keyframable rows) ships; what remains is a
  UI control for the `preview_effects_enabled` toggle (still AppSetting /
  MCP-only).
- **End-to-end filtered-10-bit-export gate** — the parity gate proves the
  f16 filter-pool technique (ADR 0022), not a full filtered 10-bit export.
- **`Speed`** is time remapping, not a filter — it stays out of
  `layer.effects` and needs its own design.

### Caption sidecar / soft-subtitle export

Caption cues imported from SRT/VTT/ASS become `Text` layers on a
caption-role track and burn into the video through the normal
`TextSprite` compositor path — no separate ffmpeg stage required.
What remains as a deferred follow-up: soft-subtitle tracks
(stream-muxed SRT/ASS into MKV or MP4) and sidecar file export for
containers that carry a subtitle stream. The data is already in `Text` layers;
the work is an ffmpeg subtitle-mux stage on top of the existing
export pipeline.

### Export decode redundancy — resolved, nothing actionable left

Export decode dispatch sits ON the inherent floor across the timeline
shapes that used to thrash (single clip, sequential source re-use,
different-phase overlap, mid-GOP range entry) — measured via the
worker's `__weftcutExportPerf` counters during development. The
phase-keyed pipeline
grouping in [`render.md`](render.md) collected the old "up to ~4.35×"
lever; what remains is inherent cost, not waste: a different-phase
overlap decodes one pass per phase (sharing would need a ring deeper
than the WebCodecs buffer pool), and a mid-GOP entry decodes from the
GOP key (long-GOP sources, unavoidable without re-keyframing).
Revisit only if Speed / reverse playback lands — a backward-marching
source mapping is the one shape the forward-only pipelines don't
cover. Preview keeps its own sibling item (warm-decoder handoff
across sequential cuts, designed in [`render.md`](render.md)).

### Decode engine — export-side decode, session split

Preview decode collapsed to two engines (Standard/`ffmpeg`, Lite/`webcodecs`)
with hardware-vs-software private to the Standard engine's `FfmpegSource` (see
[`preview.md`](preview.md#decode-engine) and
[ADR 0030](adr/0030-decode-engine-overlay-and-native-component.md)). Proxy
source activation — the per-clip override, the project-wide Prefer Proxies
toggle, and the on-demand generate-proxy command that back the `source:
original | proxy` axis — is built; see [`preview.md`](preview.md) §Proxies
for how the resolver picks proxy vs. original today. Three pieces of the
wider architecture remain deliberately deferred:

- **Export-side decode consumes the overlay.** `ExportDecoderPool` still
  decodes WebCodecs-on-proxy. The plan is to route export decode through the
  same engine overlay so blind-spot and forced-Standard sources export from
  originals instead of the lossy full-proxy. It needs the
  main→renderer→worker raw-frame transport — design of record in
  [`export-ipc-transport.md`](export-ipc-transport.md) (the 10-bit raw-frame
  transport this generalizes) and `poc/export-frame-transport` (~1 GB/s
  classic-IPC ceiling, spike-cleared; no cross-process CPU zero-copy).
- **Preview/export session-interface split — done.** The shared interface was
  split into a minimal `DecodeSession` core plus named `PreviewDecodeSession`
  and `ExportDecodeSession` roles, extracted to `decoder/session.ts`. Preview and
  export no longer share one bloated contract; `ExportDecodeSession` gives the
  export Worker a compiler-checked driving surface.
- **Unified `DecodedFrame` metadata/ownership.** The frame union already
  exists across the decode paths; standardizing its metadata and ownership is
  a safe later cleanup, not a blocker.

The native-decode component ships on **Windows only** in v1; the macOS/Linux
LGPL-ffmpeg DLL supply chain is unsettled, so on those platforms the Standard
engine is simply unavailable (`auto` resolves to Lite) rather than broken.

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
2. **`importExternalTexture` as last resort.** A standalone POC (run
   during development via a since-retired diagnostic) confirmed
   Chromium/Electron HONORS the matrix through `importExternalTexture` +
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

The PixiJS + WebCodecs path runs in Electron's bundled Chromium, the same
engine on every OS, so browser behavior no longer diverges per platform.
The 3-OS CI matrix (`electron-ci.yml`) covers the structural cross-platform
work: it builds the napi addon + renderer + main bundles, packages an
unsigned installer, launches the app headlessly, fetches the platform's
static ffmpeg, and gates cross-OS *motif-render* determinism (byte-identical
captures, SSIM) on Windows + Linux + macOS.

What CI's headless, fixture-free runners do not exercise — and what remains
to verify on real macOS + Linux hardware:

- **Cross-platform video decode + export conformance.** The conformance and
  export e2e specs self-skip in CI: no fixture media is generated there and the
  export-disabling hook is set, so WebCodecs / mediabunny decode of real proxies
  and the ffmpeg encode + mux exit have only been gated on Windows. Run the
  conformance + export suite (`npm run fixtures`, then the e2e) on macOS and
  Linux to confirm frame-identical decode and conformant output.
- **Hardware decode / encode + real-display color.** CI runners are headless
  (xvfb on Linux) and lack a representative GPU, so they exercise the software
  codec paths only. A human smoke pass on real hardware covers the hardware
  WebCodecs paths and the display color the runners can't.
- **Runtime `ffmpeg-sidecar` auto-download.** CI fetches ffmpeg through its own
  build script; confirm the app's first-launch auto-download (and the proxy
  SOCKS fallback in [`setup.md`](setup.md)) works on a clean machine.

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
- Media-pool thumbnail strip (backend data already cached; React + canvas
  work). The timeline waveform strip ships already; the filmstrip's
  tile-engine rebuild is planned in
  `docs/superpowers/plans/2026-07-02-timeline-display-upgrades.md` (Plan B).

### MCP tool gating

The `tool_table!` macro registers tools at compile time, and the
catalog has no per-session filter. Unconfigured cloud tools are listed
and return `MissingKey` errors instead of being hidden. The refinement
is to omit unsupported cloud tools from the advertised catalog
entirely, keyed on which providers are configured.

### Frame analysis for agents (`analyze_clip` / `compare_frames`) — unscheduled

**Designed, not scheduled.** The MCP surface lets an agent *see* a frame
(`media://{id}/frame/{t_us}`) but not reason about how a clip's picture
changes over time. The planned addition is two "Analysis tools" beside
`detect_silences`: `analyze_clip` (a structured shot list — scene
boundaries, a representative keyframe timestamp per shot, per-shot
brightness/motion, and black/freeze/fade events) and `compare_frames`
(pairwise perceptual-hash similarity). A heuristic Rust pass —
histogram-difference scene scoring (the PySceneDetect approach), driven by
the same ffmpeg CLI child + `ffmpeg_sem` as the other derivative jobs,
lazy on the 720p proxy, content-addressed cache — behind a `SceneDetector`
trait so a learned model (TransNetV2 via ONNX) can slot in later for
gradual-transition accuracy. Deliberately *not* the renderer/GPU path (keeps
analysis off the compositor the user is driving) and *not* a vision model
(semantic "what's in the frame" stays the multimodal agent's job).

### Transitions

**Backend skeleton only — not wired to rendering, UI, or the agent
surface.** The data model (`Transition` with the single
`TransitionKind::Crossfade`), the `add_transition` / `remove_transition`
actor mutations (which auto-extend the outgoing layer to open the
overlap window and pull source handles), and the overlap-authorizing
validator exist and are unit-tested. Nothing else is connected:
`transitions` is not surfaced to the renderer or the export IR, no napi
command or MCP tool reaches the mutations (only Rust tests call them),
and there is no timeline UI. So no transition is reachable or visible
today, and an authorized overlap currently renders as a hard cut rather
than a blend.

Completing crossfade is small because the substrate already exists: the
compositor draws every layer whose window contains the current time —
overlapping same-track layers included — and applies each layer's own
`opacity`, which is already keyframeable. The remaining work is to
surface `transitions` to the per-frame eval and export paths, ramp the
incoming layer's effective `opacity` 0 → 1 across the authorized overlap
window, expose the mutations via a napi command + MCP tool, and add a
create-at-cut authoring affordance.

Other kinds (wipe, slide, push) are a separate, larger effort: they are
two-input operations — each output pixel is a function of *both* clips at
once — so they cannot ride the per-layer `opacity` path and need a
dedicated two-input transition compositor node (both textures + a
progress uniform + a shader per kind). Crossfade falls out of that node
as the degenerate `mix()` case if it is ever built.

## v1 ship checklist

- [ ] All open-work sections above resolved or deliberately deferred.
- [ ] Linux: feature-complete or documented degraded mode.
- [ ] CI green: build + lint + unit + integration on all platforms.
- [ ] Code signing on Windows + macOS.
- [ ] Auto-update wired (`electron-updater`).
- [ ] Docs site live with Getting Started + agent connection guides.
- [ ] At least one third-party MCP client tested (Cursor or Cline
      alongside Claude Desktop).

## Post-v1 (not committed)

- Tree-of-edits history (branch, merge).
- WebGPU compositor backend tuned for real-time effects.
- Marketplace / remote sharing for user Motifs (the current feature is
  deliberately local-only — no registry).
- Multi-window timelines.
- Mobile companion (React Native or similar).
- Remote-server MCP variant (Tailscale-friendly) with proper auth.
- Plugin system for third-party effects via WebAssembly.
- Collaboration (CRDT-based shared editing).
- **HDR preview sink and wider-gamut working space.**
  The native encode exit exists: the 10-bit pipeline's Rust video sink
  (`export/videosink.rs`, native IPC → ffmpeg rawvideo → Main10
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
  v1 10-bit export ships **experimental** (UI-labeled, with an export-time
  confirmation gate). The headline gap is preview fidelity: there is no
  HDR/wide-gamut preview on the web platform, so the 8-bit/SDR preview is
  not guaranteed to match the 10-bit file — compounded by sub-realtime
  speed (4K especially) and the pending HEVC-source conform below.
  Follow-ups in the 10-bit bucket (all post-v1; see ADR 0022): **HEVC
  Main10 source conform** — HW-opaque HEVC frames cannot `copyTo` (P1 probe
  finding), so 10-bit HEVC originals currently proxy to a SW-decodable form;
  `importExternalTexture` or a format-conversion approach is the open P6
  investigation.
  Distinct from the "WebGPU compositor backend" item above (that's real-time
  effects; this is the output pipeline and preview sink).
  (Resolved from this bucket: AV1 10-bit sources are admitted —
  `tenBitExportCapable` covers h264 + av1; dav1d under prefer-software yields
  copyTo-able I420P10 while the hardware path emits opaque frames. The ring
  cap derives from resolution — a per-ring byte target clamped to entry
  floor/ceiling bounds 4K at ~500 MB; a cross-ring global budget remains a
  known limitation if it ever matters.)
