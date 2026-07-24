# Roadmap

The foundation is in place: the project state actor + history (TypeScript,
Electron main), the workspace on-disk format, media import with proxy / thumbnail / waveform jobs,
audio IR + ffmpeg export + final mux, PixiJS + WebCodecs renderer
(preview and export share one compositor), the Motif catalog
(built-in + user-authored, with an agent authoring loop over MCP),
speech-to-text over pluggable backends (OpenAI cloud + local whisper.cpp / FunASR sidecars) + cloud TTS
behind a provider-agnostic trait surface, the MCP server (streamable-HTTP,
hosted in the Electron main) with its edit / workflow / speech tools and
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
  via that batch surface), then the rest of the desktop-grade batch set on
  the same selection model: time-scale a selection about an anchor
  (stretch/squash a group of keys), copy/paste keyframes (serialize the
  selected keys, layer-local times rebased on paste at the playhead), and
  per-frame nudge.
- **A color stopwatch + MCP color keyframing.** `Animated<Rgba>` now
  interpolates end-to-end — OkLab + premultiplied alpha in the shared
  `weftcut-eval` engine (a native `value_at` twin plus a wasm packed-i32 preview
  shim, locked by a Chromium `color-mix(in oklab)` golden), wired through
  `resolveView` so keyframed text and color-fill color render in preview and
  export. What remains is the authoring surface: a color stopwatch in the
  inspector and the MCP color-keyframe tools.
- **Extrapolation modes.** Outside the first/last keyframe the value clamps
  to the endpoint (`native/eval/src/lib.rs`); there is no
  loop / ping-pong / continue — the first thing a user reaches for on looping
  overlays, Motifs, and text FX. Shape: an `extrapolate: { before, after }`
  enum on the keyframed track, honored in `eval` before the segment lookup;
  extend the golden fixture. Low effort; a schema addition (ship it with its
  `.vproj` migration — see the migration note below).
- **Per-keyframe tangent model — auto-bezier that stays smooth.** `interp` is
  owned by the *segment* (stored on the left keyframe), so a key's velocity
  is split across two records and `smooth_keyframes` is a one-shot bake:
  editing a neighbor's value or time does not re-smooth, so smoothed motion
  silently goes stale (unlike AE's auto-bezier, which re-solves
  continuously), and the model has no home for the per-key interpolation
  type (auto / continuous / bezier / linear / hold) every pro UI presents.
  Cheap option: keep the segment model and re-run `smooth_one` on affected
  keys behind a per-key "auto" flag. Proper option: promote `interp` to a
  per-keyframe `{ in, out, mode }` tangent record and derive segment beziers
  at eval time (schema + engine + UI + golden).
- **Spatial motion paths.** Position is two independent scalar tracks
  (`Transform.x` / `Transform.y`), which cannot represent a curved spatial
  path — arcs, roving keyframes, and orient-along-path are impossible;
  per-axis time-remaps only produce axis-aligned eased moves. Worth building
  only if WeftCut targets motion graphics (the Motif / text-FX direction
  suggests it eventually will): model position as a single `Animated<Vec2>`
  carrying per-key *spatial* tangents separate from the *temporal* curve,
  plus a viewport path editor. Structural — and the longer it waits, the
  more keyframe data has to migrate, so flag the decision early even if the
  build stays deferred.
- **Keyframe minor / cleanup.** Animatable anchor (`Transform.anchor` is a
  static pair, so the pivot can't be keyframed — fold into the vector type
  when convenient); the `"ease"` preset loses its named identity on reload
  (stored as a raw `Bezier{p1,p2}` while EaseIn/EaseOut are named variants);
  the curve-graph UI still hand-mirrors the Rust bezier solver in one JS
  `unitBezier` (`src/renderer/render/animated.ts`) — have it call the wasm
  `unit_bezier` instead (kills the last non-audio twin); and **schema
  migration**: pre-release currently hard-rejects old `.vproj`, and the
  extrapolation / tangent / motion-path items above all touch the keyframe
  schema — once the format ships, each needs a migration planned with the
  feature, not after.

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
- **Chroma Key v2 — keyer quality**, in priority order: despill bias color
  (preserve skin tones under heavy spill; 3 scalars), clip rollback (recover
  edge detail lost to levels clipping), despot + large-radius softness
  (needs a matte-texture multi-pass — shared infrastructure with IBK),
  IBK-style clean-plate mode (per-pixel local screen color for unevenly lit
  screens), and linear-light keying (rides colorspace bracketing). Out of
  scope for the keyer: ML background removal is a separate feature — and a
  licensing landmine: RVM is GPL-3.0 and @imgly/background-removal is
  AGPL/commercial, both incompatible with the open-source licensing plan, so
  it needs a license-clean model plus an offline-analysis + cached-alpha
  architecture; garbage/holdout masks belong to a general masking feature;
  and no shader code may be ported from OBS/Natron (GPL) — algorithm math
  from public literature only.
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
for how the resolver picks proxy vs. original today. Export-side decode and
the preview/export session-interface split have shipped; one piece remains
deliberately deferred:

- **Export-side decode consumes the overlay — done.** Export decode routes
  through the same engine overlay: `resolveExportDecodeRouting` freezes a
  per-media routing table at export start from the per-project `decodeEngine`
  intent (an `ffmpeg` pin degrades to `auto` when the component is absent), so
  blind-spot and pinned-Standard sources export from their originals over a
  credit-windowed native session instead of the lossy full-proxy, and skip the
  pre-export proxy wait. See [`render.md`](render.md) §Export source
  resolution, [`export-ipc-transport.md`](export-ipc-transport.md) (both
  directions of the raw-frame transport), and
  [ADR 0033](adr/0033-export-decode-joins-the-engine-overlay.md).
- **Preview/export session-interface split — done.** The shared interface was
  split into a minimal `DecodeSession` core plus named `PreviewDecodeSession`
  and `ExportDecodeSession` roles, extracted to `decoder/session.ts`. Preview and
  export no longer share one bloated contract; `ExportDecodeSession` names the
  export Worker's driving surface (`decodeRange`/`evictBefore`) as an explicit
  contract.
- **Unified `DecodedFrame` metadata/ownership — resolved as a type-honesty
  pass.** The union, its guards, and the dims helper live together in
  `decoder/decodedFrame.ts`, and `VideoClipSprite.updateFrame` accepts only
  the `BrowserConvertibleFrame` subset (compile-time exclusion of the
  CPU-plane kinds). The remaining per-kind differences are deliberate design,
  not debt: `close()` is uniform across all four kinds, the stores own
  `ptsUs`/`durationUs` in their entries (an `ImageBitmap` cannot carry PTS),
  and each kind's color fields follow its conversion path (ADR 0032). A
  metadata-envelope wrapper and an NV12/I420P10 type merge were evaluated and
  rejected — per-frame allocation on the preview hot path, and the two
  CPU-plane types' parallelism is honest (different layouts, shaders, and
  target texture formats).

The export-decode lane's deliberate scope cuts, in rough leverage order — the
v2 debt list:

- **4:2:2 chroma transport + compositing.** v1 swscales ProRes 422 to
  I420P10, halving vertical chroma before RGB conversion (the same cost
  preview eats); the faithful 422 ceiling needs a 4:2:2 transport format plus
  composite-chokepoint support.
- **Native session rebuild-once + abort UX.** The design admits exactly one
  same-engine session rebuild before an export aborts, with the failing source
  named and a Lite re-run suggested; today the native lane fails loud on the
  first surfaced session error with the generic export-failure message.
  Cross-engine/cross-source mid-export fallback stays forbidden either way
  (ADR 0033).
- **Hardware-lane readback** for export decode — not designed;
  profiling-gated.
- **Concurrent native-session caps** and any decode memory budget beyond the
  per-session credit window.
- **Per-clip decode-engine overrides** in the export dialog — the routing
  table's per-media shape leaves room for them.
- **Cross-machine bit-reproducibility gate** (the `ffmpeg` pin + software
  encode promise) — needs two-machine baseline management; build it as a
  permanent harness once the path has settled.
- **Routing decodable sources through native for performance** (the re-seek
  redundancy motive) — `auto` deliberately keeps them in-worker; revisit with
  profiling.

The native-decode component ships on **Windows, Linux, and macOS**; each
platform stages its own LGPL-shared ffmpeg runtime (macOS builds ffmpeg 8.1
from the pinned source tarball — see `fetch-ffmpeg-lgpl.mjs`). Where the
runtime is absent, the Standard engine is simply unavailable (`auto` resolves
to Lite) rather than broken.

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
  work). The timeline waveform and filmstrip strips ship already (see
  [`timeline-content-preview.md`](timeline-content-preview.md)); this is the
  media-pool panel counterpart.
- Drive the menus from the command registry
  (`renderer/commands/registry.ts`, see
  [features.md §Global search palette](features.md#global-search-palette)) so
  `ACTION_DEFS` and the menu markup stop being parallel books; while there,
  render platform-pretty shortcut hints (`⌘K` / `Ctrl+K`) in the palette and
  menus instead of the raw chord string.
- Status-log deferrals ([status-log.md](status-log.md)): a "Generating
  derivatives (N)" aggregate row in the status bar, which then replaces the
  project-bar derivatives pill (removing the pill first would lose the
  specific signal); tool-level Started/Ok log wraps for the remaining
  long-running MCP tools (`synthesize_speech`, `detect_silences`);
  derivative-job log producers (proxy / thumbnails / waveform); console list
  virtualization (`react-window`) only if profiling shows real cost; a
  drag-to-resize handle for the console (height is fixed at 40vh; the CSS
  cursor is set but no pointer-drag handler is wired).

### MCP tool gating

The `tool_table!` macro registers tools at compile time, and the
catalog has no per-session filter. Unconfigured speech tools are listed
and return actionable "not configured" errors instead of being hidden. The refinement
is to omit unsupported speech tools from the advertised catalog
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

### Transitions — v1 shipped; named deferrals remain

Transitions ship end-to-end for visual layers: **Crossfade**, **Wipe**, and
**Slide** (direction = motion direction — see the
[CONTEXT.md glossary](../CONTEXT.md#transitions)) between any mix of visual
layer kinds. Every kind renders through one two-input compositor node — both
participants bake, with their own transform / opacity / effects applied, into
pooled composition-sized render textures, and a full-frame quad composites
them with a per-kind shader at the track's z-slot; preview and export share
the path, gated by the transitions-WYSIWYG e2e. Authoring: right-click at a
cut on the timeline, a chip straddling the join (Delete key removes), an
inspector kind / direction / duration editor, and the
`add_transition` / `update_transition` / `remove_transition` MCP tools;
default duration is 1 s snapped to whole composition frames. Edits that break
a transition's overlap drop it via reconcile-on-commit — visibly logged, one
undo restores edit + transition, no shrink-back — while a split inside a
transition is blocked atomically; insufficient tail handle is a named
pre-check error carrying the available microseconds. See
[ADR 0035](adr/0035-transitions-two-input-node-reconcile-on-commit.md).

The named deferrals:

- **Push** kind (an enum variant + shader on the existing node: slide's
  boundary plus outgoing translation).
- **Wipe edge softness** (additive uniform + slider).
- **Easing / keyframeable progress** — progress is fixed linear; easing is an
  additive parameter reusing the keyframe bézier infrastructure.
- **Center-at-cut / end-at-cut alignment** — alignment is start-at-cut only;
  the variants are additive parameters.
- **Freeze-frame handle padding** (Premiere's repeat-last-frame when the
  outgoing clip lacks tail media; needs decode-session past-tail clamping).
- **Audio equal-power crossfade** — Crossfade kind only, on the
  WebAudio-preview + Rust-mixer twin seam (a second and third evaluation
  surface on the golden-guarded audio twins).
- **Policy C — the transition rides the trim**: individual mutations become
  transition-aware, reconcile degrades to a backstop (upgrade path recorded
  in ADR 0035).
- **Chip edge drag-resize** on the timeline (duration edits go through the
  inspector or MCP).
- **Transition-specific error for blocked in-transition splits** — the
  atomic rejection surfaces as the generic `LayerOverlap` error.

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
- **FFmpeg encoder registry / capability resolver — runtime resolver shipped;
  distribution gate remains.** `export/encoder_registry.rs` now accepts
  library-agnostic intent (`codec`, bit depth, acceleration, rate control,
  speed), owns the known adapters, real one-frame probes, per-encoder argument
  mapping, and process-lifetime selection cache, and returns a complete
  `EncoderPlan` or structured `EncodeUnavailable` attempts. `videosink.rs`
  consumes the plan without naming or remapping an encoder; removal of a
  library skips that adapter and never falls back to an assumed name. What
  remains is the supply-chain half: pin/hash each bundled ffmpeg build and
  check a required encode-capability matrix during packaging.
