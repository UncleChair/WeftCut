# decode-bench Stage 2 — native GPU decode path (measure-first slice) — Design

**Goal:** Light up the *native* half of the decode-bench comparison by landing the
minimum native-ffmpeg GPU/shared-texture decode path that the benchmark can drive,
so decode-bench's `strategy:'native'` cells produce real numbers across the full
matrix. Nothing about the shipping WebCodecs path changes.

This is a **scoping / decomposition** spec over an already-settled design, not a
new design. The architecture is fixed by two prior docs and **adopted as-is**:

- `poc/shared-texture/INTEGRATION-DESIGN.md` (branch `poc/shared-texture-import`) —
  the native path's full v1 design; proven feasible end-to-end (FINDINGS Results 1–7).
- `docs/superpowers/specs/2026-07-03-decode-bench-design.md` — the benchmark that
  measures it; Stage 1 (WebCodecs side) shipped (`a4a62479`).

What this spec adds: the **measure-first decomposition** (which parts of the
INTEGRATION-DESIGN are built now vs deferred, and why), and the concrete Slice A
architecture — chiefly the lift of the proven poc Rust core into the production
`apps/desktop/native/` crate.

## 1. Decomposition — Slice A (this spec) vs Slice B (deferred)

The INTEGRATION-DESIGN's own logic forces this split: decode-bench spec §5's product
decisions — native codec set (drop AV1?), concurrent-decoder cap (measured knee vs
guessed 3–4), 4K-in-v1 (`hevc-2160` ≥ 1× realtime?), zero-copy-v2 priority — are all
**"gated on Stage-2 data."** You cannot correctly finalize the fallback's concurrency
cap or the codec set *before* the benchmark has produced the numbers those decisions
depend on. So Slice A builds only what produces the data; Slice B consumes it.

**Slice A (this spec) — "measure-first":**

1. Rust GPU-decode module (Windows-gated cargo feature) — the lifted poc core.
2. Main-process shared-texture glue (import/send/receiver + `frameReady`/`consume-ack`
   pokes + coalesced anchor command).
3. `NativeGpuSourceHandle implements DecoderHandle` + the `forceStrategy` E2E gate in
   `SourceDecoderPool.acquire()`.

Deliverable: decode-bench's `strategy:'native'` runs the full matrix (throughput,
seek, cold-start, resources) on the dev machine (RTX 3050).

**Slice B (deferred — a follow-up spec, informed by Slice A data):**

- `AppSettings` switch (`shared/app-settings.ts`) + settings UI + toggle→rebuild.
- Automatic route-based selection gate (route == `Proxied` + switch ON) in `acquire()`.
- Per-source **fallback** (setup/decode-error triggers → session set → rebuild as
  WebCodecs) + `isDowngraded()`/LogBus indicator.
- **Concurrency cap** tuned to the measured knee (INTEGRATION-DESIGN §4).
- `media_conformance` scenarios + ground-truth color assertions (INTEGRATION-DESIGN §6).

The benchmark runs strategies **serially** (decode-bench spec §3), so a concurrency
cap is never exercised in Slice A — deferring it costs nothing. Fallback is likewise
undesirable in a benchmark: we *want* a native failure to surface as an `unsupported`
cell, not be masked by a silent WebCodecs re-acquire.

## 2. Rust decode module (the lift)

### 2.1 Build-system change (the notable one)

The production crate depends on **`ffmpeg-sidecar = "2"`** — it shells out to an
ffmpeg *subprocess* for proxy/conform/export. You cannot extract a d3d11va-decoded
`ID3D11Texture2D` from a subprocess; the GPU frame must be produced in-process. So
Slice A **adds new dependencies**, matching the poc's proven set:

- `ffmpeg-next = "8.1"` (library bindings; matches the machine's Gyan.FFmpeg.Shared
  8.1.1) — requires `FFMPEG_DIR` + `LIBCLANG_PATH` at build time (see
  `reference_ffmpeg_next_windows_setup`).
- `windows = "0.58"` with the D3D11/DXGI/Security feature set the poc used.

Both go behind a **new Windows-gated cargo feature** (working name `preview-gpu`):

- Gated by `#[cfg(all(windows, feature = "preview-gpu"))]`; non-Windows and
  feature-off builds exclude the module and the ffmpeg-next/windows deps entirely
  (`[target.'cfg(windows)'.dependencies]` + `optional = true` + feature activation).
- **Kept OUT of the CI feature-union** (`jobs,export,mcp,cloud`). GPU decode is
  meaningless on headless-GL CI runners (see `reference_electron_ci_gotchas`), CI does
  not set `FFMPEG_DIR`/`LIBCLANG_PATH`, and decode-bench is already local-only by
  construction. `napi:build` for the benchmark/dev turns the feature on locally; the
  3-OS CI matrix does not. This must be stated wherever the feature-union is pinned so
  a future union edit doesn't accidentally enable it on CI.

### 2.2 Module shape

New module under `apps/desktop/native/src/` (e.g. `preview_gpu/`), lifting the
**simple** proven core from `poc/shared-texture/native/src/decoder.rs` +
`lib.rs`:

- d3d11va HW-decode of the **original `media.path`** → `CopySubresourceRegion` the
  decoder's NV12 `ID3D11Texture2D` into a shared NV12 texture created on **ffmpeg's own
  D3D11 device** (GPU→GPU, no CPU bounce) → keyed mutex → `CreateSharedHandle` →
  ffmpeg device-context mirroring (FINDINGS #6) → adapter pick (FINDINGS #8).
- **`convert.rs` (the Result-6 BGRA shader / SRVs / `D3DCompile`) is dropped.** Share
  raw NV12; `createImageBitmap` honors the `colorSpace` tag (Result 5/7-A PASS), so no
  producer-side color convert is needed for 8-bit. (The shader is Slice-B/v2 territory,
  needed only for the deferred 10-bit P010 path.)
- **8-bit only.** P010 shared-texture import yields a null/black frame (Result 7);
  `hi10p` stays a WebCodecs-only reference row in the benchmark. No 10-bit native cell.
- **Session registry** — `Map<streamId, GpuPreviewSession>` on the native Backend. This
  is an OS-resource handle (like the job queue / cache / log bus), **not** project
  state — it does not regress the stateless-compute model.
- **napi command surface:** `open(streamId, path, colorTag) → textureInfo[]` (the N
  persistent slots), `requestFrameAt(streamId, tUs)`, `consumeAck(streamId, slot)`,
  `close(streamId)`. The decode loop is a simple ffmpeg-idiomatic
  `av_seek_frame`-to-keyframe-≤T + decode-forward loop owned by native — **not** a Rust
  port of `PacketPump`.

## 3. Transport + renderer handle

### 3.1 Persistent-import transport (mandatory here)

Slice A uses the **Result-4 persistent-import model**, not per-frame import/send:

- Native owns a small transport ring of **N ≥ 2** shared NV12 slots, each
  `importSharedTexture`'d + `sendSharedTexture`'d **exactly once** at `open`, then
  overwritten in place.
- Per frame: native writes a free slot K (keyed mutex) → emits `frameReady{slot:K,pts,
  dur}`. Renderer `getVideoFrame(import[K]) → await createImageBitmap → ring.push` →
  emits `consume-ack{slot:K}`. Native does not overwrite K until its ack arrives (the
  ack — not the keyed mutex across the async `createImageBitmap` — is the coherence
  guarantee; with N ≥ 2 the race never arises in practice).

**Why mandatory, not an optimization:** the only native fps on record (~53–75, Result
3) measured the per-frame-`sendSharedTexture` IPC bound that Result 4 eliminated. A
benchmark built on per-frame import/send would report that stale IPC-bound number as
"native throughput" — an unfair, misleading measurement. Result 7-B already proved the
async-`createImageBitmap`-under-`consume-ack` path is tear-free (maxErr=1,
backwardSteps=0).

### 3.2 Renderer handle

`NativeGpuSourceHandle implements DecoderHandle` in `src/renderer/render/decoder/`:

- `ring: FrameRing` — the existing ring, unchanged; join point is the exact
  `createImageBitmap → ring.push` the WebCodecs path already uses. `DecodedFrame` stays
  `VideoFrame | ImageBitmap | TenBitFrame` (snapshot pushes `ImageBitmap`) → **no union
  change, no `VideoClipSprite` change**.
- `requestFrameAt(tUs): Promise<void>` — ships a **coalesced** anchor (reuse the
  `ScrubCoalescer` pattern) over IPC to main → native. `Compositor`'s
  `void c.source.requestFrameAt(...)` is unchanged.
- Seek-latency visual + pause reuse `FrameRing`'s existing contract (miss → hold
  previous frame; clock stops → anchor stops advancing → native idles). No explicit
  pause command.

### 3.3 Selection gate

`SourceDecoderPool.acquire()` gains a `forceStrategy?: 'webcodecs' | 'native'` field on
`SourceHandleInit`, honored **only under `VITE_WEFTCUT_E2E=1`** (inert otherwise). When
`forceStrategy === 'native'`, `acquire()` mints `NativeGpuSourceHandle` (bypassing the
settings switch + route gate, which don't exist yet — Slice B). Otherwise the existing
WebCodecs `SourceHandle` path is unchanged. `decodeBench.ts` (already wired for
`strategy:'native'`, currently returning `"not integrated (Stage 2)"`) passes it.

## 4. Verification

- **Spike first, before building out scenarios:** one fixture (start with `hevc-1080`,
  the headline) → `open` → `requestFrameAt` → one `ImageBitmap` lands in the private
  pool's `FrameRing`. This de-risks the real unknown: the poc's *standalone*-harness
  main-process wiring behaving identically when the addon is loaded in the *production*
  main process. Only after the spike passes do the remaining scenarios come online.
- **Coherence check:** monotonic-luma-ramp method (Result 3/4) through the integrated
  path — no tearing / stale / gap under the async snapshot + `consume-ack`.
- **Then the decode-bench matrix runs native cells** across all four scenarios;
  `hi10p` records `unsupported` (P010 block) with reason. A native cell that cannot
  decode records `unsupported`, not a run failure — the coverage matrix is a
  deliverable (decode-bench spec §2).
- **Explicitly NOT validated in Slice A:** color *conformance* (native ↔ ground-truth
  ffmpeg decode) — that is Slice B's `media_conformance` scenario. Slice A validates
  *decode + coherence + speed*, matching the benchmark's purpose.

## 5. Key file touch-list (Slice A)

- `apps/desktop/native/Cargo.toml` — new `preview-gpu` feature; `ffmpeg-next` +
  `windows` optional deps under it (Windows target).
- `apps/desktop/native/src/preview_gpu/` (new) — the lifted decode + D3D11 share core.
- `apps/desktop/native/src/napi_backend.rs` — session registry + `open`/
  `requestFrameAt`/`consumeAck`/`close` commands (feature-gated).
- `src/main/` + `src/main/state/router.ts` — `importSharedTexture`/`sendSharedTexture`/
  `setSharedTextureReceiver` routing; `frameReady`/`consume-ack` pokes; coalesced
  anchor command.
- `src/renderer/render/decoder/SourceDecoderPool.ts` — `forceStrategy` field on
  `SourceHandleInit` + `acquire()` E2E gate + `NativeGpuSourceHandle` (new file).
- `src/renderer/render/decoder/decodeBench.ts` — drop the `"not integrated"` guard for
  `strategy:'native'`.
- `apps/desktop/native/src/{io/probe.rs, jobs/proxy_decision.rs, state/decode_route.rs}`
  — read-only (color tags / route); not modified.
- **Not touched in Slice A:** `shared/app-settings.ts`, settings UI, `Compositor.ts`
  toggle-rebuild, `media_conformance` — all Slice B.

## 6. Acceptance (Slice A)

- The spike passes: a native-decoded `ImageBitmap` reaches the private pool's ring for
  `hevc-1080`.
- decode-bench `--fixture hevc-1080 --strategy native` completes all four scenarios and
  the report renders native cells (no `"not integrated"`).
- Full matrix runs: `h264/hevc-1080/hevc-2160/vp9/av1` native cells yield data;
  `hi10p` records `unsupported` (P010) with reason.
- `preview-gpu` feature is off in the 3-OS CI union; existing suites unaffected
  (`forceStrategy` inert outside E2E; the feature excluded when off).
- No change to the shipping WebCodecs preview path.

## 7. Note on the H.264 baseline anomaly (carried, not resolved here)

Stage-1 baseline had **H.264 slower than HEVC/VP9/AV1** (decode-bench memory /
`2026-07-03-78049eeb.json`). This is a WebCodecs-side reading; it must be understood
before native comparisons are trusted (a slow-H.264 baseline would read as a false
native win). It is an *analysis* task on the data, not a Slice A build item — flagged
here so the comparison read-out accounts for it.
