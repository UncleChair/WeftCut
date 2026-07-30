# Integration Design — native-ffmpeg GPU decode as a second preview strategy

Companion to [FINDINGS.md](./FINDINGS.md). FINDINGS proves the transport is
feasible; this document records the **integration design** agreed for landing it
in the app as a user-selectable second decode strategy, alongside the existing
WebCodecs/proxy path.

## 0. The one-line goal

Let a Windows user **preview today's 8-bit hard-codec sources (8-bit HEVC / VP9 /
AV1) instantly and from the original** — without waiting for a proxy transcode — by
decoding them with native ffmpeg on the GPU and handing frames to the renderer over a
shared texture. It is **opt-in, preview-only, and additive**: nothing about the
existing path changes unless the user flips a switch. **10-bit is deferred to v2** —
the Result-7 probe (§5a) found the P010 import blocked, and deferring it keeps the
native path aligned with WeftCut's existing SDR-only / 10-bit→proxy color stance.

## 1. The re-baseline (read this first — it overrides FINDINGS §4b)

FINDINGS §4b recommended the *zero-copy* shape: share BGRA, feed the `VideoFrame`
straight into WebGPU/Pixi, hold a persistent lookahead ring. **We deliberately do
NOT build that for v1.** Zero-copy performance is not the current priority; instant,
full-fidelity first-screen preview is.

So the integration **snapshots each delivered `VideoFrame` with
`createImageBitmap` and pushes it into the existing `FrameRing`** — i.e. the native
path joins the pipeline at the *exact* point the WebCodecs path already does
(`SourceDecoderPool.ts` output callback: `createImageBitmap(frame) → ring.push`).
From that point on, everything downstream is the unchanged, proven machinery:
`FrameRing` lookahead/lookbehind, the pump, `frameAt`, the warm-up gate,
`scheduleRepaint`, `VideoClipSprite`.

Consequences of the re-baseline:

| FINDINGS §4b / earlier idea | This design |
|---|---|
| Zero-copy into WebGPU | **Deferred to v2.** One `createImageBitmap` GPU→GPU copy per frame is accepted. |
| Native NV12/P010 → BGRA convert shader (Result 6) | **Not built.** Share **raw NV12/P010**; `createImageBitmap` honors the `colorSpace` tag (Result 5 proved `drawImage`/`createImageBitmap` are color-correct for tagged NV12), so no producer-side color convert is needed. |
| 10-bit needs a P010 shader | ~~**Trivial.** `createImageBitmap` down-converts a P010 `VideoFrame`...~~ **REFUTED by the Result-7 probe (§5a): the P010 keyed-mutex texture imports as a null-format/black frame.** 10-bit needs a decision — defer, or a native P010→BGRA convert. |
| Custom lookahead `FrameStore` | **Reuse `FrameRing`** unchanged. The shared-texture ring is a *separate, tiny transport ring*, not the buffer. |

The POC becomes, in effect, **a decode module**: a different front-end that produces
`VideoFrame`s in the renderer, feeding the same back-end.

## 2. Product decisions (scope & semantics)

1. **Scope** — only sources that are **proxied today** (route `Proxied`: HEVC, VP9,
   AV1, 8- and 10-bit). Sources that already `Bypass`/`DirectExport` in WebCodecs
   (clean H.264) are untouched. AV1 is in scope but the weakest case (WebCodecs can
   soft-decode it); droppable if it complicates color.
2. **Manual opt-in** — default behavior is unchanged. The native path activates only
   when the user turns it on. `proxy_decision.rs` automatic routing is **not** modified.
3. **Single global switch, default OFF** — not per-source. One experimental toggle
   ("prefer native GPU decode for hard codecs"). Fallback, however, is **per-source**
   (see §6).
4. **Switch lives in `AppSettings`** (per-machine, `app_settings.json`) — the
   capability is machine/GPU/Windows-specific; a project setting that travels to a
   Mac would be meaningless. Add a field to `src/shared/app-settings.ts`.
5. **Preview-only; export untouched** — the `full_proxy` is **still generated** in
   the background for export, which stays 100% on the proven path. The v1 win is
   *instant + full-fidelity preview*, **not** saving the proxy transcode (that
   cost-elimination is a v2 goal, gated on trusting the native path enough to feed
   export). This mirrors the existing `DirectExport` route, where preview and export
   already use different sources.
6. **10-bit — UNDER REVISIT (Result-7 probe blocked it).** The intent was to include
   10-bit (iPhone HEVC 10-bit) shader-free via `createImageBitmap`. The probe (§5a)
   found the P010 shared-texture imports as a null/black frame, so this is not viable
   as-is. Pending decision: ship **8-bit-only v1** (10-bit stays on proxy, no
   regression) or add a **native P010→BGRA convert**. 8-bit hard codecs (8-bit HEVC,
   VP9, AV1) are unaffected and validated.
   **Consistency note (from the §3.6 audit):** WeftCut's existing color path
   (`ffprobeColorSpace.ts`) is *deliberately SDR-only* and already states 10-bit
   sources "take WeftCut's proxy path" — so deferring 10-bit in the native path
   matches the codebase's existing 10-bit stance; it is not a new gap, and the P010
   blocker simply keeps the native path aligned with that stance.

## 3. Architecture

### 3.1 Renderer seam

A new `NativeGpuSourceHandle implements DecoderHandle`
(`src/renderer/render/decoder/`), selected inside `DecoderPool.acquire()` so the
`Compositor` stays strategy-agnostic. The interface already fits:

- `ring: FrameRing` — the existing ring (not a custom `FrameStore`).
- `requestFrameAt(tUs): Promise<void>` — async IPC to the main-process producer
  (the WebCodecs handle drives an in-renderer pump synchronously; this one drives a
  cross-process producer). Signature is already `Promise<void>`, so `Compositor`'s
  `void c.source.requestFrameAt(srcTUs)` is unchanged.
- `DecodedFrame` stays `VideoFrame | ImageBitmap | TenBitFrame`; the snapshot path
  pushes `ImageBitmap`, so **no new union variant** and **no `VideoClipSprite` change**.
- `isDowngraded?()` is reused to surface "fell back to proxy" (see §6).

### 3.2 Process layout (3 pieces)

`importSharedTexture`/`sendSharedTexture` are **main-process** Electron APIs, and the
napi addon is loaded in main — so the only real IPC boundary is **main ↔ renderer**.

1. **Rust decode module** — `native/src/` new module, `#[cfg(target_os = "windows")]`
   + a cargo feature; non-Windows builds exclude it entirely. Lifts the **simple**
   proven core (Result 1b-ii + Result 3): d3d11va decode → `CopySubresourceRegion`
   into a shared **NV12/P010** texture on ffmpeg's device → keyed mutex →
   `CreateSharedHandle` → ffmpeg device-context mirroring (FINDINGS #6) → adapter pick
   (FINDINGS #8). **The Result-6 BGRA shader / SRVs / `D3DCompile` are dropped** — the
   integrated Rust is *simpler* than the POC's final state.
2. **Main-process JS glue** — `src/main/`: `importSharedTexture` /
   `sendSharedTexture` / `setSharedTextureReceiver` routing; bridges the addon's
   share handles to the renderer. New commands in `src/main/state/router.ts`.
3. **Renderer handle** — `NativeGpuSourceHandle` + the receiver callback +
   `createImageBitmap → ring.push`.

A **stateful decode-session registry** (`Map<streamId, GpuPreviewSession>`) lives in
the native Backend. This is an **OS resource handle**, like the existing job queue /
cache / log bus — **not** project state, so it does not regress the stateless-compute
model (project state stays TS-owned, no Rust read-mirror).

### 3.3 Transport — persistent import + frame-ready/consume-ack (Result 4 based)

Chosen to eliminate per-frame `sendSharedTexture` overhead at the source. **Two
rings, distinct layers:**

- **Shared-texture transport ring** — native-owned, **N≥2–3** persistent-import
  slots, overwritten in place. Each slot is `import`ed + `send`'d **exactly once** at
  setup; **never re-sent**.
- **`FrameRing`** — the existing `ImageBitmap` lookahead/lookbehind buffer.

Per-frame flow:

1. native decodes a frame → writes it into a free transport slot K (keyed mutex) →
   sends a tiny `frameReady{slot:K, pts, dur}` poke.
2. renderer: `getVideoFrame(import[K])` → `await createImageBitmap` → `ring.push` →
   sends a tiny **`consume-ack{slot:K}`** poke.
3. native does **not** overwrite K until its `consume-ack` arrives (the ack — not the
   keyed mutex across the async `createImageBitmap` boundary — is the coherence
   guarantee). With N≥2 slots, native writes the next slot while the renderer
   snapshots the previous, so the race never arises in practice.

Per-frame IPC inventory (main ↔ renderer): one `frameReady` poke + one `consume-ack`
poke (tens of bytes each) + the coalesced anchor. **No frame pixels ever cross IPC**
(they stay on the GPU; `createImageBitmap` is a renderer-local GPU→GPU copy). **No
per-frame `sendSharedTexture`.** Bandwidth is a non-issue (~tens of KB/s); the only
cost is two tiny pokes/frame.

### 3.4 Decode loop — native owns it

`requestFrameAt(T)` ships the anchor T to native; **native owns its ffmpeg decode
loop** (demux + decode + `av_seek_frame` to keyframe ≤ T + decode forward). This is
*not* a Rust port of `PacketPump` — it is a simpler, ffmpeg-idiomatic loop; the only
shared thing is the `DecoderHandle` contract, not the internal pump.

- **Anchor IPC is coalesced** (reuse the `ScrubCoalescer` pattern) so scrubbing does
  not flood IPC.
- **Seek-latency visual**: reuse `FrameRing`'s existing contract — `frameAt` misses
  return null and the painter **holds the previous frame** until native catches up
  (`CLAMP_TO_FIRST_GAP_US`).
- **Pause is natural**: clock stops → `requestFrameAt` stops advancing → native fills
  to anchor+lookahead and idles. No explicit pause command.

### 3.5 Selection gate (`acquire()`)

Mint `NativeGpuSourceHandle` iff **all**: platform = Windows; global switch ON; route
== `Proxied`; codec/pix_fmt in native-decodable set; source not in the session
fallback set. Otherwise the existing WebCodecs handle.

- The native module decodes the **original `media.path`** (not a proxy URL) — this is
  the source of the instant-preview win; it short-circuits `previewPathLive` for these
  sources, while the proxy still builds in the background for export.
- Gate on `route == Proxied` (reuse `proxy_decision.rs`'s authoritative
  classification) rather than re-deriving codec rules — avoids twin drift.
- **Switch toggled mid-session → rebuild affected clips** (reuse the Compositor's
  existing clip-rebuild) so the choice takes effect immediately.

### 3.6 Color-tag derivation (the import `colorSpace`) — align with the existing path

The import tag must be **derived from the source, not hardcoded** (the Result-7 probe
hardcoded 601/709; since `createImageBitmap` *honors* whatever tag we pass, the tag
being right is what makes the color right). Audit of the existing machinery (so the
native path reuses it rather than growing a twin):

- **`native/src/io/probe.rs` already reads all four tags** (`color_space`→matrix,
  `color_range`, `color_primaries`, `color_transfer`; `"unknown"`→None) into
  `MediaItem.metadata`. **No native change needed** to obtain colorimetry.
- **`ffprobeColorSpace.ts`** maps those ffprobe strings → WebCodecs
  `VideoColorSpaceInit`; **`colorSpaceDefault.ts`** (`withDefaultColorSpace`) applies a
  3-layer priority (container `colr` tag > ffprobe `sourceColor` > resolution default:
  HD→`bt709`, SD→`smpte170m`, limited range). Its output strings
  (`bt709`/`smpte170m`/`rgb`/`bt470bg`) are exactly Electron's
  `importSharedTexture.colorSpace` vocabulary.

**v1 derives the import tag by REUSING the source's existing computed
`VideoColorSpaceInit`** (the same value the WebCodecs path uses), adapting only
`fullRange:boolean → range:'full'|'limited'` for the Electron shape. This makes the
native path's colorimetry **identical to the WebCodecs path by construction** →
`media_conformance` parity for free, no second mapping to drift. The node-av
`AVCOL_*`↔string table (FINDINGS §7) is the **cross-validation** (its strings ⊇ the
SDR subset above) and the **v2 tool** (BGRA-convert output tagging + HDR vocabulary);
it is **not** ported to Rust for v1.

## 4. Fallback & limits (§6 robustness)

- **Triggers**: (a) setup-time — `ensureReady` reject / first-frame timeout (incl. the
  `importSharedTexture` 1000 ms timeout, adapter mismatch, codec unsupported);
  (b) mid-stream — decode error event. Both → mark source in the **session** fallback
  set → rebuild the clip as WebCodecs.
- **Fallback == "behave as if the switch were off for this source"** — route it back
  through its existing `Proxied` path (wait for / use the proxy). No new degrade path
  is invented; failure handling is only *detect* + *re-acquire*.
- **Session-scoped, not persisted** — a transient failure must not permanently
  blacklist a source.
- **Silent but observable** — no disruptive toast, but a low-key indicator
  (`isDowngraded()` + a `LogBus` / status-log entry, optional media-card badge) so the
  user can tell which strategy they are actually seeing (essential for an A/B feature).
- **Concurrent-decoder cap (capacity, not failure)** — cap simultaneous native
  decoders at **3–4** (NVDEC session limits on older GPUs); overflow sources use
  WebCodecs and are **not** marked fallback (they may go native once capacity frees).

## 5. Verification

- **Probe first, in the `poc/shared-texture/` harness, before touching
  `@weftcut/core`** ("Result 7"). It must prove **two** things (the only remaining
  unknowns):
  1. **Color** — `createImageBitmap(getVideoFrame())` is correct for raw **NV12**
     8-bit (601 & 709) **and a new P010 10-bit clip**. The `colorSpace` tag passed to
     `importSharedTexture` is derived from the decoded stream's `AVCOL_*` tags via the
     Electron-string↔enum table in FINDINGS §7 (ported from node-av); since Result 7 (§5a) showed
     `createImageBitmap` *honors* that tag, deriving it from the stream — not hardcoding 709 — is
     what makes the color correct.
  2. **Coherence** — persistent import + in-place overwrite + **async**
     `createImageBitmap` under `consume-ack` gating is tear-free (Result 4 only tested
     *synchronous* readback; the async snapshot path is the new gap). Use the Result
     3/4 monotonic-luma-ramp method, read via `createImageBitmap`.

### 5a. Result 7 — probe outcomes (RUN 2026-06-29, Electron 42.4.1 / Chromium 148, RTX 3050)

Implemented as new harness modes (`POC_COLOR` extended with a `createImageBitmap`
path; new `POC_CIB_PERSIST`). Run commands in [README](./README.md).

| Claim | Result | Evidence |
|---|---|---|
| **A — `createImageBitmap` color, NV12 8-bit** | **PASS ✅** | 601 clip: `createImageBitmap`=[20,220,41], byte-identical to the `drawImage` reference and 38 away from the broken WebGPU [58,217,38]. 709 clip (honest tag): [17,218,37]=source. Tracks `drawImage` in all 4 tag×source combos → honors the colorSpace tag. |
| **B — async-`createImageBitmap` coherence under consume-ack** | **PASS ✅** | `POC_CIB_PERSIST`, pool=1 and pool=2, 60-frame ramp: `import=send=poolSize` (one-time), 60/60 snapshots, **maxErrVsExpected=1** (every async snapshot caught the correct frame), **backwardSteps=0** (no tearing), 0 errors. Closes the Result-4 async-readback gap. |
| **A — `createImageBitmap` color, P010 10-bit** | **BLOCKED ❌** | HEVC Main10 decodes to a P010 D3D11 surface, format auto-detected (`DXGI_FORMAT(104)`) and shared as `p010le` — but `importSharedTexture({pixelFormat:'p010le'})` of our keyed-mutex P010 texture yields a **`format:null`, all-black VideoFrame** (drawImage AND createImageBitmap AND WebGPU all read [0,0,0]). The 8-bit path is unaffected (re-confirmed PASS). The import does not surface usable pixels for a hand-built keyed-mutex P010 texture on Electron 42. |

**Consequence for the 10-bit decision (§2.6): the assumption that 10-bit is a
trivial, shader-free `createImageBitmap` downconvert is REFUTED at the transport
layer.** 10-bit needs one of: (a) defer 10-bit, ship **8-bit-only** v1 (revert §2.6
to the conservative scope — 10-bit sources stay on proxy, no regression); or (b) a
**native P010→BGRA GPU convert** (Result-6-style shader, extended to 10-bit R16/R16G16
SRVs) sharing **BGRA**, which imports cleanly (Results 1, 6) — i.e. the convert shader
the re-baseline dropped is NOT optional for 10-bit. The exact root cause of the P010
import failure (keyed-mutex P010 rejection vs another import constraint) is not yet
pinned; pinning it could open a third, shader-free path but is unproven.
- **Color baseline is ffmpeg's own color-honoring decode of the original** (the
  Result 5/6 ground truth), **NOT the proxy** — the proxy is lossy, so native (decoding
  the original) is *expected* to differ from it. Conformance assertions must compare
  native ↔ ground-truth, not native ↔ proxy, or they will false-fail.
- **v1 merge gated on the local `media_conformance` harness** (Playwright `_electron`,
  `VITE_WEFTCUT_E2E=1`, local-only / skip CI): drag in HEVC + 10-bit → toggle on →
  verify instant preview, seek/scrub/pause, forced-failure fallback, and
  multi-source-over-cap overflow.

## 6. Explicitly deferred to v2

- **True zero-copy** (feed the `VideoFrame` into WebGPU/Pixi without the
  `createImageBitmap` copy) — requires the native BGRA/P010 convert shader (Result 6),
  because WebGPU ingestion mis-colors raw NV12 (Result 5).
- **Saving the proxy transcode** (export from native decode → stop generating the
  proxy) — only after the native path is trusted enough for export correctness.
- **`DirectExport` heavy-H.264 sources** going native (v1 is `Proxied`-only).

## 7. Implementation sequence

1. **Result-7 probe** in `poc/shared-texture/` (color NV12+P010 via `createImageBitmap`;
   async-snapshot coherence under consume-ack). Gate everything else on it.
2. **Rust decode module** in `native/` (lift the simple core; streaming loop with
   `av_seek_frame`; session registry; napi command surface) + Windows cfg/feature.
3. **Main-process glue** (`import/send/receiver` routing; `frameReady`/`consume-ack`
   pokes; anchor command).
4. **`NativeGpuSourceHandle`** + `acquire()` selection gate + the `AppSettings` switch
   (`shared/app-settings.ts`, settings UI) + toggle→rebuild wiring.
5. **Fallback** (triggers → session set → rebuild; `isDowngraded`/`LogBus` indicator;
   concurrent cap).
6. **`media_conformance`** scenarios + ground-truth color assertions.

## 8. Key file touch-list

- `src/shared/app-settings.ts` — the global switch field.
- `src/main/app-settings.ts`, `src/main/state/router.ts`, `src/main/` — switch
  persistence; shared-texture glue + command routing.
- `src/renderer/render/decoder/SourceDecoderPool.ts` — `acquire()` selection gate +
  `NativeGpuSourceHandle`.
- `src/renderer/render/decoder/FrameRing.ts` — reused unchanged.
- `src/renderer/render/Compositor.ts` — clip-rebuild on toggle; otherwise agnostic.
- `native/src/<new module>` — decode + D3D11 share (Windows-gated).
- `native/src/napi_backend.rs` — session registry + commands.
- `native/src/jobs/proxy_decision.rs`, `state/decode_route.rs`, `io/probe.rs` — read
  only (route classification, color tags); not modified.
- `poc/shared-texture/` — extended with the Result-7 probe; kept as an isolated
  regression bed during integration.
