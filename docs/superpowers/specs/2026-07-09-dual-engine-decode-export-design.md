# Dual-Engine Decode & Export — Design

2026-07-09 · approved design, pre-implementation. One architecture, two
implementation phases: **Phase E (export engine) first, Phase D (decode
engine) second.** When implemented, the durable content consolidates into
`docs/render.md` / `docs/preview.md` / `docs/decode-bench.md` plus a new ADR
(engine-as-overlay + conditional native-decode component), and this spec is
deleted per the evergreen-docs discipline.

## Problem

Decode and encode paths are chosen today by hardcoded format presets spread
across several layers, and the strongest measured paths are side-paths rather
than defaults:

- **Decode** is WebCodecs-and-proxy-centric: only "friendly" H.264 previews
  the original; HEVC/VP9/AV1/10-bit default to a 720p short-GOP quick proxy;
  WebCodecs-blind codecs (ProRes/DNxHD/DNxHR/MPEG-2/VC-1/WMV3) route to a
  native software decoder that is gated behind an experimental toggle **and
  compiled out of the standard build** (`preview-sw` is not in the
  `napi:build`/CI feature set). The far stronger native **hardware** path
  (`preview-gpu`: d3d11va → sharedTexture zero-copy) exists end-to-end but is
  E2E-gated and unshipped, despite decode-bench showing it beats WebCodecs on
  throughput at 1080p and 4K and decisively on seek latency.
- **Export** has three encode paths decided inline in `App.tsx`: WebCodecs
  direct (8-bit, probe-passing), a **WebCodecs H.264 mezzanine + ffmpeg
  transcode** for 8-bit targets WebCodecs can't encode (a hidden
  two-generation quality loss), and a native ffmpeg raw-frame sink for 10-bit
  HEVC/AV1 (`videosink.rs`, the strongest and most controllable path — but
  reachable only via bit depth).
- Blind-spot codecs **export** from the lossy H.264 full proxy (4:2:2/10-bit
  masters degrade to 8-bit 4:2:0 before encoding).

Format lists decide behavior; probes exist but only patch edges. New or odd
formats fail by falling through list gaps rather than by failing a probe.

## Goals

- Two complete, parallel engines on each side — **Native (FFmpeg)** and
  **WebCodecs** — with Native preferred where it is available and measured
  stronger, WebCodecs as the compatibility floor, and the choice exposed to
  the user.
- Replace format-list routing with **capability probing** so unknown formats
  degrade gracefully instead of falling through lists.
- Kill the two hidden quality losses: the export mezzanine path and (in
  Phase D, for export decode) the blind-spot full-proxy indirection.
- Preview matches mainstream-NLE norms: decode the original by default;
  proxies are a user opt-in convenience, never an automatic swap.

## Non-goals (this design)

- macOS VideoToolbox / Linux VAAPI hardware decode lanes (future, separate
  design; the engine model leaves room for them as additional Native lanes).
- Per-source engine override UI (v1.5; v1 is the global setting + LogBus
  visibility).
- MCP exposure of engine/export settings (`docs/mcp.md` deliberately excludes
  export control; unchanged).
- ProRes 4444 / DNxHR 444 / alpha export; 10-bit H.264 (Hi10P) delivery;
  2-pass, GOP structure, B-frame, tune encoder knobs; MKV container.
- HDR preview and wide-gamut working space (unchanged post-v1 roadmap items).
- Runtime auto-download of the native-decode component (sidecar-style fetch
  infrastructure exists and can be reused later; v1 bundles on Windows only).

## Principles

- **P1 — Probes over lists.** Capability is decided by real probes (decode
  probe / encode smoke-encode), cached per machine. Format lists may seed or
  short-circuit probes, never overrule them. Unknown formats fail a probe and
  fall to the next tier instead of taking a wrong path.
- **P2 — Engine is a session overlay.** Three layers of truth: **on-disk**
  (`DecodeRoute`: which derivatives exist — `decide()` and the folded enum are
  untouched), **machine** (capability cache), **session** (the overlay that
  picks a path at acquire/export time). Engine preference lives in settings
  only — app-level for decode, the project's export settings for the encoder
  (delivery intent) — and no engine state is ever written into media items or
  `DecodeRoute`. Capability is a machine property, not a project property.
- **P3 — Tiered fallback, fully visible.** Every downgrade is per-source
  sticky (no oscillation), logged to LogBus with a reason, and inspectable in
  the UI. No silent path changes.
- **P4 — NLE conventions.** Originals are the default preview source. Proxy
  is user opt-in. Preview never auto-swaps sources mid-session.
- **P5 — The color chokepoint does not move.** Every decode lane ships
  YUV + `colorSpace` into the same `FrameRing`; conversion happens once, at
  `VideoClipSprite.drawImage` (ADR 0021). On the encode side, the native exit
  writes color tags explicitly (primaries/trc/matrix/range) instead of relying
  on encoder defaults.

## User surface

| Setting | Store | Values | Notes |
|---|---|---|---|
| Decode engine | App-level `AppSettings.decode_engine` | `auto` \| `native` \| `webcodecs` | Default `auto`. Replaces and deletes `experimental_native_sw_decode` (its semantics are absorbed by `auto`). Grayed out with a reason when the native-decode component is absent. |
| Encoder engine | Per-project `export.json` `encoderEngine` | `auto` \| `native` \| `webcodecs` | Default `auto`. Export settings are already persisted per project; `auto` re-resolves on the current machine, so cross-machine opens cannot go stale. |

The two `auto`s deliberately differ: **decode auto picks the fastest available
path** (preview is latency/throughput-bound); **encoder auto prefers Native**
(export is control/quality-bound; WebCodecs encodes only when the sidecar is
missing or the native probe fails). Engine-internal lane choice (HW vs SW) is
an implementation concern surfaced through LogBus, not a user decision.

## Conditional first-class: the native-decode component

The Native decode engine is **conditionally first-class**: a first-class,
user-selectable engine *when its runtime is present*, and cleanly absent
otherwise. This converts the ffmpeg-DLL supply chain from a build/release
blocker into a per-platform packaging decision.

- **Split addon.** A new `@weftcut/native-decode` napi addon carries
  `preview_sw` + `preview_gpu` and the `ffmpeg-next` linkage. The existing
  `@weftcut/core` addon drops those modules and never links `ffmpeg-next`, so
  the standard build needs no `FFMPEG_DIR`/libclang. Rationale: a missing DLL
  in a single addon's import table fails the entire `require('@weftcut/core')`
  — jobs/export/MCP would die with it. Isolation is structural, not optional.
- **Lazy load + level-0 gate.** Main tries `require('@weftcut/native-decode')`
  in a try/catch at startup. Failure ⇒ the Native decode engine is
  unavailable: the setting is grayed out with the reason, `auto` resolves
  without Native tiers, LogBus records it once. The app is fully functional
  without the component.
- **Distribution (v1).** The official **Windows** installer bundles the
  component (second `.node` + LGPL ffmpeg shared DLLs as extraResources,
  ~60–90 MB). macOS/Linux packages ship without it until their DLL supply
  chain is settled — on those platforms the engine is simply unavailable, not
  broken. Sidecar-style auto-download is a later enhancement.
- **Licensing line (fixed constraint).** **In-process = LGPL, sidecar = GPL.**
  The in-process DLLs are an LGPL ffmpeg build (decode needs no x264/x265;
  LGPL builds carry all required decoders — ProRes, DNxHD/HR, MPEG-2, VC-1,
  dav1d). All *encoding* stays in the GPL `ffmpeg` CLI sidecar, isolated
  behind a pipe. The app's own licensing posture is unchanged; the GPLv3
  source-offer obligation remains scoped to the sidecar.

**Why the sidecar CLI cannot be the preview decode backend** (recorded so the
question stays answered): the CLI has no session control — a running ffmpeg
process cannot be seeked. Interactive scrubbing would mean kill+respawn per
seek (~100–300 ms: process creation + init + probe + open + seek) versus
~5–20 ms for in-process `av_seek_frame`, inverting the measured 8–16× seek
advantage that motivates the Native engine. The HW lane is also structurally
in-process: D3D11 shared-texture handles must be produced by code that owns
the device. The sidecar remains the encode exit and the batch-job tool, and
is a candidate for **linear** export-side decode later (offline,
forward-only, no seeks — where a rawvideo pipe is fully adequate).

---

## Export engine (Phase E)

Today's three inline branches collapse into one resolution seam and two sinks:

```
ExportSettings (incl. encoderEngine) ──► EncodeTarget resolution ──┬─► NativeSink     (videosink.rs generalized)
                        × capability probes (smoke-encode, sidecar) └─► WebCodecsSink  (today's path A, wrapped)
                                              mezzanine path (B) is deleted
```

### EncodeTarget resolution

A single module (renderer) that turns `ExportSettings` + probe results into
`{ engine, sinkConfig }`. `encoderEngine: "auto"` prefers Native whenever the
sidecar is present and the encoder probe passes; `"webcodecs"` validates
against a real smoke-encode (`exportCodecProbe` stays); combinations an engine
cannot do (10-bit, ProRes/DNxHR, CRF mode on WebCodecs) are disabled live in
the dialog rather than failing at export time. If NativeSink is selected but
becomes unavailable at export start, the user gets an explicit dialog offering
the fallback — export is a delivery action; the encoder never changes
silently (P3, strengthened for export).

### NativeSink — generalize the 10-bit exit to a full exit

- **Compositing is unchanged** (8-bit RGBA8, 10-bit f16/WebGL2). When
  NativeSink is selected, the worker composites on **WebGL2 for all bit
  depths** so there is a single pack-pass implementation (the WebGPU 8-bit
  composite remains the WebCodecsSink path); revisit only if profiling shows a
  real WebGPU composite advantage.
- **GPU pack-pass family** completes the pix_fmt matrix next to the existing
  `PackYuv420p10`: `PackYuv420p8` (→ `yuv420p`, H.264/HEVC/AV1 8-bit),
  `PackYuv422p8` (→ `yuv422p`, DNxHR LB/SQ/HQ), `PackYuv422p10`
  (→ `yuv422p10le`, ProRes Proxy/LT/422/HQ). BT.709 limited matrix +
  quantization per pass. Bandwidth check: 4K60 `yuv420p` ≈ 746 MB/s, inside
  the measured ~1 GB/s IPC ceiling, and export is encode-bound anyway.
- **Transport is reused as-is**: worker `postMessage` (transfer) →
  `chunk`/`chunk-ack` backpressure → `videoSinkWrite` IPC → sidecar stdin.
  The documented async-stdin optimization stays optional, not blocking.
- **`videosink.rs` + `hwencoder.rs` generalize** from 10-bit-only to the full
  matrix: encoder selection keeps the probe order (NVENC > QSV > AMF /
  VideoToolbox / VAAPI, software fallback) and extends to `libx264`,
  `libx265`, `libsvtav1`, hardware 8-bit variants, `prores_ks`
  (Proxy/LT/422/HQ profiles), `dnxhd` (`dnxhr_lb/sq/hq` profiles). A Rust-side
  `encode_spec` maps the TS settings to args: CRF quality mode (`-crf` /
  `-cq` / `-global_quality` per encoder), ABR (`-b:v`), `-preset`, existing
  `keyframeIntervalSec` → `-g`, and **explicit color tags**
  (`-color_primaries/-color_trc/-colorspace/-color_range`, BT.709/limited —
  the working space per ADR 0021 — turning "defaults happen to be right" into
  a declared, assertable property).
- **Container coupling**: ProRes/DNxHR force MOV (dialog-linked). MP4/MOV
  faststart behavior preserved.
- **Progress/EOS**: reuse the `-progress` event parsing (exists in
  `transcode_and_mux`) and the drop-stdin EOS + orphan-reclaim semantics
  already in `videosink.rs`. New spawns keep `NoConsoleWindow`.
- **Audio and final mux unchanged**: Rust mix → ffmpeg AAC/Opus temp track →
  `mux_export` joins video+audio. Already fully native.

### WebCodecsSink — the floor, wrapped

Today's path A (`EncoderSink` + mediabunny fragmented MP4 streamed to disk)
unchanged behind the seam. Its honest capability boundary: 8-bit only; H.264
always; AV1/HEVC per smoke-encode; bitrate modes only (no CRF); no color-tag
control. `mux_to_file` (`-c copy`) stays as its mux tail.

### Deleted: mezzanine path (B)

Its only scenario — 8-bit targets WebCodecs can't encode — is covered by
NativeSink direct encode, removing the two-generation loss.
`transcode_and_mux` retires with it.

### Boundaries

- **Export-side *decode* is untouched in Phase E** (worker WebCodecs +
  existing full-proxy routing). When Phase D lands (stage D5),
  `ExportDecoderPool` consumes the same decode-engine overlay, upgrading
  blind-spot exports from lossy full-proxy to direct original decode.
  Cross-phase dependency, recorded here.
- **Render & Play** is a WYSIWYG preview affordance, pinned to the fast
  WebCodecs H.264 path; it does not follow `encoderEngine`.

### ExportSettings schema (additive, backward-compatible)

`encoderEngine`, `rateMode: "quality"` (CRF) + `crf`, `preset`,
`codec: "prores" | "dnxhr"` + `proresProfile` / `dnxhrProfile`,
`container: "mov"`. All optional with defaults; existing `export.json` files
load unchanged.

---

## Decode engine (Phase D)

### Resolution flow (the overlay, concretely)

```
AppSettings.decode_engine ─┐
capability cache (machine) ┼─► per-source engine resolution ─► SourceDecoderPool.acquire(forceStrategy, sourcePath)
DecodeRoute (disk, read-only)┘        (decodeEngine.ts)           ├─ SourceHandle          ← WebCodecs engine
                                                                  ├─ NativeGpuSourceHandle ← Native · HW lane
                                                                  └─ SwSourceHandle        ← Native · SW lane
```

The resolution module replaces the `nativeSwSourceFor` special case in
`Compositor`/`PixiPreview`. The three `DecoderHandle` implementations, the
`FrameRing`, and everything downstream are untouched.

### Native engine = two lanes behind one facade

- **HW lane** (Windows; `preview_gpu` productized): d3d11va → GPU→GPU copy
  into a pooled set of shared NV12 textures → Electron `sharedTexture` →
  preload isolated world builds the `ImageBitmap` → MessagePort to main world
  → `FrameRing`. Per frame only a poke/ack crosses IPC — zero pixel bytes.
  Productization: remove the `VITE_WEFTCUT_E2E` gate, multi-source session cap
  under a VRAM pool budget, failure downgrade, ship in the component build.
  Scope is probe-decided (measured today: 8-bit H.264/HEVC/VP9 work; AV1
  yields no decodable surface; P010 is transport-blocked — those probes fail
  and resolution falls through, no list needed).
- **SW lane** (all platforms; `preview_sw` widened): acceptance goes from the
  blind-spot list to **"anything ffmpeg decodes"**, probe-verified. Phase-2
  assets carry over: per-family threading (intra = SLICE, long-GOP =
  FRAME|SLICE), the long-GOP backward-seek margin fix, ring-eviction fix.
  10-bit/HDR sources are swscaled to 8-bit NV12 — the preview surface is
  8-bit/SDR, so this is an explicit decision, not a defect.

### `auto` decision table (per source; every step logged)

0. Native-decode component loadable? (else skip Native tiers)
1. Native·HW probe passes (platform + codec + depth) → **Native·HW**
2. WebCodecs probe passes (`probeSourceDecodable`, generalized to a routing
   input) → **WebCodecs, decoding the original**
3. Native·SW (ffmpeg can decode) → **Native·SW**
4. Nothing passes → **proxy path** (the WebCodecs engine's fallback machinery)

Tier 2 matters independently of Native: the "720p proxy by default" era ends
for anything WebCodecs can actually decode. Forcing `native` skips tier 2
(HW → SW → only then WebCodecs); forcing `webcodecs` skips tiers 1 and 3
(today's full machinery, proxies included).

### Capability probe cache

App-level cache file (machine truth): key = (lane, codec, profile, pix_fmt,
resolution class), value = result + timestamp; invalidated on GPU/driver
change. Same idea as the export smoke-encode probe, applied to decode.

### Proxy policy flip (P4 realized)

- `decide()` still runs and `DecodeRoute` is still persisted (disk truth
  unchanged), but **proxy jobs stop auto-enqueuing** when engine resolution
  shows the source will decode originals on any engine. Proxies build only on
  explicit user opt-in ("generate proxy" in the media panel) or when
  resolution lands on tier 4. The two proxy axes flip independently: the
  quick (preview) proxy stops when *preview* resolves to originals; the full
  proxy (the export master, ADR 0011) stops only once the *export* path
  decodes originals too (stage D5) — stopping it earlier would strand
  blind-spot exports.
- **The session bridge (original→proxy auto-swap) retires.** "Original is the
  default" removes its reason to exist — and with it the `previewPathLive`
  auto-swap behavior. The no-flash swap mechanism itself stays, now serving
  explicit engine switches and mid-session downgrades.
- **Scrub tradeoff, recorded honestly:** long-GOP originals scrub by
  seek-to-key + decode-forward, without the short-GOP proxy's frame-accuracy
  bound. Mitigations: Native seek is measured 8–16× faster, ring lookbehind,
  and the playback-resolution throttle (Plan B) lands right after Phase D.
  If a source still scrubs poorly, proxy is one click away — which is exactly
  the mainstream-NLE shape.
- Derivative jobs (filmstrip/waveform/thumbnails) that read the quick proxy
  switch to reading originals via the sidecar CLI (which already decodes
  anything) — verify each input during planning.

### Failure & fallback semantics (both sides)

- **Resolution-time failure** (probe fails): silently resolve to the next
  tier; LogBus info.
- **Runtime failure** (decode error, device loss, session crash): per-source
  **sticky downgrade** (no re-promotion within the session), LogBus warning,
  no-flash handle rebuild. Re-resolved on next project open.
- **Export exception**: NativeSink unavailability surfaces a dialog with the
  fallback choice — never a silent encoder change.

### Resource discipline

Touching the playback loop ⇒ the memory ratchet gate runs
(`e2e/scripts/memory-ratchet.mjs`, <30 MB/90 s). `FrameRing`/`setAnchor`
eviction semantics unchanged. HW sessions bounded by the VRAM pool budget, SW
by the thread budget (per-family policy exists); over-budget sources resolve
to the next tier.

---

## Build, packaging, CI

- `@weftcut/core` keeps features `jobs,export,mcp,cloud` — unchanged, no
  `ffmpeg-next`. The **component** addon builds with `preview-sw` (+
  `preview-gpu` on Windows). The Rust-tests/`napi:build` feature-union
  consistency rule now applies per addon (the union drift already burned CI
  once; keep them matched).
- CI is headless: the GPU lane can never be exercised in CI (known, accepted); the
  SW lane's unit + e2e coverage runs in CI on the component build. The
  hardware smoke pass stays a local checklist item (roadmap already has the
  slot).
- Second build product = second `.node` — the "running app locks the .node"
  gotcha now applies to both.

## Testing & gates

| Gate | Coverage |
|---|---|
| decode-bench | The engine regression bed it was built to be; SW strategy widens with the lane (add mpeg2/vc1 fixture rows); `--strategy webcodecs\|native\|sw` already models the lanes |
| Conformance SSIM | Export matrix over both engines: native 8-bit H.264/HEVC/AV1 + ProRes/DNxHR rows; SW-lane per-family baselines exist from Phase 2 |
| Color-tag assertions | New: ffprobe checks primaries/trc/matrix/range on native outputs (only the native exit makes this assertable) |
| Memory ratchet | Runs whenever Phase D touches the playback loop |
| Export e2e | Both engines drive full exports; EOS/cancel/progress parity |
| Manual hardware smoke | HW lane + hardware encoders (CI-blind), local checklist |

## Phasing

- **Phase E (export, first)**
  - E1: `EncodeTarget` resolution seam + WebCodecsSink wrap (pure refactor,
    behavior-preserving).
  - E2: `videosink.rs`/`hwencoder.rs` generalization + `PackYuv420p8` —
    native direct encode for 8-bit H.264/HEVC/AV1.
  - E3: ProRes/DNxHR + 422 pack passes + CRF/preset + color tags + dialog UI
    (engine selector, live capability gating, MOV coupling).
  - E4: delete mezzanine path + conformance/e2e matrix completion.
- **Phase D (decode, second)**
  - D1: split `@weftcut/native-decode` component + level-0 availability gate +
    Windows installer bundling (LGPL DLLs).
  - D2: engine resolution module + `decode_engine` setting + `auto`
    (absorbs and deletes `experimental_native_sw_decode`).
  - D3: SW lane widened to probe-accepted formats + capability cache.
  - D4: HW lane productization (gate removal, VRAM budget, downgrade path).
  - D5: export-side decode consumes the overlay — the main→renderer→worker
    raw-frame transport (design of record: the blind-spot spec §6,
    spike-cleared in `poc/export-frame-transport`) — so blind-spot and
    forced-native sources export from originals.
  - D6: proxy policy flip + session-bridge retirement + derivative-job input
    verification. Depends on D5: a source's full-proxy (export-master)
    auto-build stops only once its export path decodes originals.
- **Follow-on**: Plan B (playback resolution throttle + Full/½/¼/Auto UI;
  kickoff doc remains valid) — it relieves both SW-lane 4K CPU cost and IPC
  bandwidth.

Each stage is independently shippable and revertible; the overlay design means
no stage migrates persisted data.

## Risks

1. **LGPL DLL supply chain** (3 platforms) — de-risked from release blocker to
   per-platform component availability; D1 resolves Windows first (Gyan ships
   no LGPL shared build → build our own or source elsewhere; decide in D1).
2. **Long-GOP original scrub feel** — the one user-perceivable behavior change
   that can read as regression; mitigations above, release notes state it
   plainly, opt-in proxy is one click.
3. **HW lane multi-source VRAM budget** — bench data is single-source; D4
   starts with a conservative session cap and widens on measurement.
4. **Engine-resolution complexity creep** — the overlay must stay a pure
   function of (settings × capability cache × read-only route); any hidden
   state re-grows the preset maze this design exists to kill. Guard in review.

## References

- ADR 0021 (color converges at ingest), ADR 0022 (10-bit export + native
  encode exit), ADR 0028 (DecodeRoute folded enum), ADR 0029 (native SW decode
  ships bytes; classic-IPC transport data).
- `docs/decode-bench.md` (native-vs-WebCodecs character + harness contract),
  `docs/preview.md` (proxy routing today), `docs/export-ipc-transport.md`
  (the 10-bit raw-frame transport this design generalizes).
- `poc/export-frame-transport/FINDINGS.md` (~1 GB/s classic-IPC ceiling; no
  cross-process CPU zero-copy; `createImageBitmap` costs).
- `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts`
  (`DecoderHandle` seam + `forceStrategy`), `apps/desktop/native/src/export/`
  (`videosink.rs`, `hwencoder.rs`), `apps/desktop/native/src/jobs/proxy_decision.rs`
  (`decide()` — unchanged by this design).
- `docs/superpowers/2026-07-05-preview-sw-phase2-kickoff.md` (Plan B, the
  follow-on).
- `docs/superpowers/specs/2026-07-05-ffmpeg-sw-decode-blindspot-design.md` —
  its §6/§7 remain the design of record for stage D5's export frame
  transport; its Phase 3/4 phasing, blind-spot-only scoping, and list-based
  routing are superseded by this spec (see the banner there).
