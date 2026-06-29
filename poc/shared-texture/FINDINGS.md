# Findings — zero-copy native-GPU-texture → renderer via Electron `sharedTexture`

**Verdict: feasible and proven end-to-end on Windows, including color.** A video
frame decoded by ffmpeg on the GPU can be displayed in an Electron renderer as a
`VideoFrame` with **no CPU frame copy and no IPC frame transfer**, the path streams
continuously by recycling a pool of shared textures, and — by converting NV12→RGB on
the producer's GPU and sharing a **BGRA** texture — it is **color-correct through the
WebGPU/Pixi ingestion path** for both BT.601 and BT.709 sources (Result 6 closed the
Result-5 color gap).

- Environment: Electron **42.4.1** (Chromium 148), Windows 11, NVIDIA RTX 3050, `ffmpeg-next` 8.1 / FFmpeg 8.1.1.
- Branch: `poc/shared-texture-import`. Standalone under `poc/shared-texture/`; does **not** touch `@weftcut/core`.
- Commits: `04827a9d` (BGRA) → `a0b47d50` (NV12) → `84231a7d` (ffmpeg CPU-bounce) → `ad31685d` (ffmpeg zero-copy) → `03eac452` (streaming).

---

## 1. The question

WeftCut's preview decodes via WebCodecs in the renderer; export and proxy use
native ffmpeg. The idea: let **native ffmpeg** decode (e.g. HEVC/10-bit/VP9 that we
currently proxy) and hand frames to the renderer **without** an IPC frame copy —
sharing GPU memory instead. Electron 42 ships an experimental `sharedTexture`
module; could it carry a native-produced GPU texture *into* the renderer?

## 2. The correction (and the key learning)

Initial instinct was **wrong**: `sharedTexture` was assumed to be one-directional
(renderer→native, via offscreen `useSharedTexture`), with the reverse unimplemented
(Electron issue #46779). The user pushed back with the docs, and reading the source
confirmed them:

> `sharedTexture` imports an external shared texture **into** Electron and converts
> the platform handle to a `VideoFrame`; supports all web rendering systems; can be
> transferred between processes.

So there are **two** mechanisms, opposite directions:
- `webPreferences.offscreen.useSharedTexture` — Chromium's rendered output **out** to native (the `paint` event).
- `sharedTexture.importSharedTexture()` — an external native texture **in**, surfaced as a `VideoFrame`. ← this POC.

Lesson: verify load-bearing platform claims against source/docs, not memory.

## 3. The API (Electron 42.4.1, from `electron.d.ts`)

Direction: native handle → main-process import → send to renderer → `VideoFrame`.

| Call | Process | Purpose |
|---|---|---|
| `sharedTexture.importSharedTexture({ textureInfo, allReferencesReleased })` | main | import a handle → `SharedTextureImported` |
| `sharedTexture.sendSharedTexture({ frame: webContents.mainFrame, importedSharedTexture })` | main | transfer to a renderer (1000 ms timeout; receiver must exist first) |
| `sharedTexture.setSharedTextureReceiver(cb)` | renderer | `cb(data)` → `data.importedSharedTexture` |
| `imported.getVideoFrame()` | renderer | a `VideoFrame` for WebGPU / WebGL / 2D canvas |
| `allReferencesReleased` | main | fires when **every** ref (main + renderer) is released |

`textureInfo` (required: `codedSize`, `handle`, `pixelFormat`):
```js
{ codedSize:{width,height}, handle:{ ntHandle:<Buffer 8 LE bytes of the NT HANDLE> },
  pixelFormat:'bgra'|'rgba'|'rgbaf16'|'nv12'|'p010le', colorSpace?, visibleRect?, timestamp? }
```

## 4. Architecture (final, zero-copy + streaming)

```
            main process (Rust napi addon + Electron main)            │   renderer
                                                                       │
 ffmpeg d3d11va HW-decode ── AVFrame(D3D11): data[0]=texture array,    │
   (frame stays on GPU)              data[1]=slice index               │
        │                                                              │
        │  CopySubresourceRegion (GPU→GPU, no CPU)                     │
        ▼      into a free POOL slot, bracketed by the slot's          │
   shared NV12 texture  ◄── keyed mutex Acquire/Release(0)             │
   (NTHANDLE|KEYEDMUTEX,                                               │
    on ffmpeg's D3D11 device)                                          │
        │  CreateSharedHandle (once per pool texture)                  │
        ▼                                                              │
   importSharedTexture(handle) ── sendSharedTexture ───────────────►  setSharedTextureReceiver
        ▲                                                              │      getVideoFrame()
        │  allReferencesReleased → mark slot free (AtomicBool)         │      → WebGPU/canvas
        └──────────────────── slot recycled for a later frame ◄────── frame.close(); release()
```

Two cooperating sync layers, both necessary:
1. **Per-texture keyed mutex (key 0)** — serialises our GPU write vs Chromium's read *within* one texture's handoff.
2. **Per-slot `AtomicBool` free-flag** — serialises slot ownership across the JS boundary; the producer only writes a slot whose `allReferencesReleased` has fired.

The **pool** provides concurrency: the producer fills slot N+1 while the renderer
still holds slot N — exactly how Electron OSR recycles textures.

## 5. Milestones (all verified, byte-exact in the renderer)

| # | Commit | What | Evidence |
|---|---|---|---|
| 1 | `04827a9d` | synthetic **BGRA** checkerboard → import → display | cellA `[255,102,51]`, cellB `[34,34,34]` |
| 1a | `a0b47d50` | synthetic **NV12** (YUV) bands | top `[210,210,210]`, bottom `[60,60,60]` |
| 1b-i | `84231a7d` | real H.264 → **ffmpeg d3d11va** HW-decode → `av_hwframe_transfer_data` (GPU→CPU NV12) → upload → display | `format=NV12`, lumaTop 235, lumaBottom 16 |
| 1b-ii | `ad31685d` | **true zero-copy**: HW-decode → `CopySubresourceRegion` (GPU→GPU) into a shared NV12 texture on ffmpeg's device → display | identical to 1b-i |
| streaming | `03eac452` | pool of reusable shared NV12 textures, per-frame import/send/release | see below |

Streaming verification (60-frame 256×256 H.264, center-patch luma ramps 20→235 with
frame index; renderer keys each frame by `VideoFrame.timestamp` = frame index and
requires **strictly increasing** luma — a stale/torn/duplicated frame breaks it):

| pool | sent/recv | ordered+advancing | gaps | dups | errors | busySpins | fps |
|------|-----------|-------------------|------|------|--------|-----------|-----|
| 5 | 60/60 | yes | 0 | 0 | 0 | 0 | ~65 |
| 3 | 60/60 | yes | 0 | 0 | 0 | 2–7 | ~60–75 |
| **1** | **60/60** | **yes** | 0 | 0 | 0 | **79** | 53 |

`POC_POOL=1` is the decisive case: one texture, 59 forced reuses (producer waited on
Chromium's release 79×) — still ordered and tear-free. So **Chromium's NV12 import
re-acquires/re-releases the keyed mutex cleanly across frames**; pooled reuse works.

## 6. Key technical findings (the hard-won bits)

1. **`importSharedTexture` accepts a handle Chromium did not create** — the whole idea hinges on this; confirmed even for hand-built D3D11 textures.
2. **`pixelFormat` import supports `nv12` and `p010le`** — ffmpeg's NV12/P010 hw-decode output imports with no RGBA conversion.
3. **Raw `ID3D11Device::CreateTexture2D` requires `SHARED_NTHANDLE | SHARED_KEYEDMUTEX` together** (+ a `RENDER_TARGET` bind for BGRA). A keyed-mutex-*free* `SHARED_NTHANDLE` texture — what the docs say Chromium emits for BGRA — is **not** creatable via the public D3D11 API (Chromium uses an internal Dawn/D3D11on12/fence path). The importer reads our keyed-mutex texture fine regardless.
4. **Shared textures reject initial data** (`E_INVALIDARG`) — create empty, upload after via `UpdateSubresource`/`CopySubresourceRegion`.
5. **Decoder frames are not directly shareable** — they live in a `BIND_DECODER` texture **array** owned by ffmpeg's hw-frames pool (`data[0]`=array ptr, `data[1]`=slice index). Must `CopySubresourceRegion` into a fresh shared texture **on ffmpeg's own device** (intra-device copy).
6. **`ffmpeg-sys-next` does not bind `AVD3D11VADeviceContext`** (its wrapper omits the D3D11 hw-context header). Mirror its stable `repr(C)` layout to read `device`/`device_context`. Wrap ffmpeg's COM pointers with windows-rs `from_raw_borrowed` (**no** ownership) and `device.clone()` (AddRef) so the device outlives the decoder.
7. **windows crate 0.58 quirks**: `CreateSharedHandle` needs the `Win32_Security` feature (else the method is gated out); struct flag fields are plain `u32` while the constants are newtypes (`.0`); `GetDesc1()` returns by value.
8. **Adapter must match Chromium's** (multi-GPU laptops): pick the highest-VRAM adapter (the discrete GPU Chromium prefers); NT-handle textures share cross-device, so the copy works as long as both devices are on that adapter.
9. **Performance is IPC-round-trip bound, not GPU**: ~53–75 fps here is `import`/`sendSharedTexture` overhead (+2 ms busy-yield), not the GPU copy. A real preview would import straight to WebGPU and pace to the clock.
10. **Spec tests are macOS-arm64-only**, but the feature works on Windows (the skip is a CI-GPU limitation, not a feature gap).

## 6b. Result 4 — persistent import / zero per-frame IPC ✅ PASS (2026-06-29)

Result 3 streamed via **per-frame** import/send/release (one `importSharedTexture` +
`sendSharedTexture` round-trip per frame, paced by `allReferencesReleased`). The
open question for a real preview: **can per-frame texture IPC be driven to zero?**

Hypothesis: import + send each pool texture **exactly once**, keep the
`SharedTextureImported` alive in the renderer, then have the producer overwrite the
**same** underlying D3D11 texture (bracketed by the keyed mutex) while the renderer
calls `getVideoFrame()` repeatedly on that persistent import — and have each call
reflect the **new** content, with no further import/send.

**Verdict: PASS.** A persistent import DOES reflect the producer's later writes.

How it was tested (`POC_PERSIST=1`, new mode; existing modes untouched):
- Native: reuse `pocOpenVideoStream(path, poolSize)` for the pool, then
  `pocPersistSlotHandle(slot)` (returns the slot's cached NT handle for the
  one-time import) and `pocPersistWriteNext(slot)` — decode the next frame and
  `CopySubresourceRegion` it into the **given** slot under that slot's keyed mutex,
  **without** the free-slot / `allReferencesReleased` gating. The producer and the
  persistent import are deliberately NOT coordinated by slot ownership; the keyed
  mutex (index 0) is the only handshake.
- Main: for each slot, `importSharedTexture` **once** + `await sendSharedTexture`
  **once** (kept in a main-side array so `allReferencesReleased` never fires), then
  a producer loop overwrites the textures round-robin every ~16 ms — **no**
  re-import/re-send. `importCount` / `sendCount` are tracked and must equal
  `poolSize`.
- Renderer: store each received import in a slot map and **never release it**; on a
  self-paced `requestAnimationFrame` loop call `getVideoFrame()` on each persistent
  import, sample center-patch average luma, `frame.close()` (but keep the import),
  record `{tMs, slot, luma}`. On the done signal compute distinct-luma count,
  min/max, advance, and a per-slot monotonicity (tearing) metric.

Verification clip: the same 60-frame 256×256 H.264 luma ramp (20→235).

| pool | import/send (must == pool) | pulls | distinct luma | luma min→max | advanced | mid-run backward steps (tearing) | verdict |
|------|----------------------------|-------|---------------|--------------|----------|----------------------------------|---------|
| **1** | **1 / 1** | 132 | 60 | 20 → 235 | yes | **0** | **PASS** |
| 2 | 2 / 2 | 266 | 60 | 20 → 235 | yes | 0 | PASS |

The `POC_POOL=1` case is decisive: **one** shared texture, imported and sent **once**,
overwritten 60 times in place — and the renderer's repeated `getVideoFrame()` on that
single persistent import tracked the full ramp. Collapsing repeated reads, the
observed luma trajectory was a clean monotonic ramp:

```
49 20 23 27 30 34 38 41 45 49 52 56 60 63 67 71 74 78 85 89 92 96 100 103 107 111
114 118 122 125 129 132 136 140 143 147 151 154 158 162 165 169 173 176 180 183
187 191 194 198 202 205 209 213 216 220 224 227 231 235
```

(The leading `49` then `20` is a one-time startup re-alignment: the producer ran a
few frames during the ~200 ms setup wait before the renderer's rAF pull loop began,
so the first pulls caught the texture mid-ramp, then snapped to the true start ONCE.
After startup, **zero** backward steps per slot — no torn or reordered reads. The
pool=2 backward count is measured per-slot for the same reason: with round-robin
writes the two slots are one frame apart at any instant, which is the pool offset,
not tearing.)

Result-4 findings:
1. **`getVideoFrame()` on a persistent `SharedTextureImported` is a live view of the
   underlying texture, not a snapshot.** Each call samples the current GPU contents;
   producer writes between calls ARE observed. This is the load-bearing fact.
2. **The keyed mutex alone is sufficient to make in-place overwrites coherent.** The
   producer `AcquireSync(0)` / `CopySubresourceRegion` / `Flush` / `ReleaseSync(0)`,
   and the renderer's `getVideoFrame()` read, interleave without tearing — no
   per-frame import/send, no `allReferencesReleased` round-trip, needed for
   correctness.
3. **Per-frame texture IPC can be driven to zero.** Import + send happen exactly
   `poolSize` times for the whole stream (1 and 2 here), regardless of frame count.
   `allReferencesReleased` fired **0** times (main holds the import for the run).
4. **What still costs per frame:** the producer's GPU copy + keyed-mutex bracket
   (native, cheap, off the IPC path) and, in this probe, the renderer's 2D
   `getImageData` readback (verification only — a real preview reads the VideoFrame
   straight into WebGPU). The expensive `sendSharedTexture` IPC round-trip is gone.

Caveats / what this does NOT yet establish:
- **No frame-ready signal.** The renderer pulls on its own timer; it does not know
  *when* the producer finished a write. For a real preview you still need a cheap
  per-frame poke (a tiny `{frameIndex}` IPC message — orders of magnitude smaller
  than a texture send) or to pace both sides to the same clock, so the renderer
  reads exactly once per produced frame rather than over-/under-sampling.
- **No double-buffer guarantee against read-during-write.** Coherence here rests on
  the keyed mutex serialising the whole write against the whole read. With `pool=1`
  a read must wait for an in-flight write (and vice-versa) on the SAME texture; a
  `pool≥2` ping-pong (write slot B while renderer reads slot A) avoids that stall —
  the persistent-import model supports either, since both slots are imported once.
- Tested at 256×256 / 60 frames on one machine (Electron 42.4.1, RTX 3050); not a
  soak or a multi-resolution sweep.

**Integration implication:** the real WeftCut preview can import a small ring of
shared textures **once** at session/seek setup and thereafter feed the renderer by
overwriting them in place + a tiny frame-index poke — eliminating the per-frame
`importSharedTexture`/`sendSharedTexture` IPC that bounded Result 3's throughput
(~50–75 fps). The renderer imports each ring texture to WebGPU once and re-samples.

## 6c. Result 5 — renderer color paths ❌ WebGPU video ingestion is NOT color-correct (2026-06-29)

Results 1–4 verified pixels **only** through 2D `drawImage` + `getImageData`,
which honors `VideoFrame.colorSpace`. WeftCut's real renderer uploads to
WebGPU/Pixi, where a known WeftCut finding is that Pixi v8's
`device.queue.copyExternalImageToTexture({source: videoFrame})` **ignores**
`VideoFrame.colorSpace` and converts every frame with BT.709. So the WebGPU color
behavior for our shared NV12 textures was **unverified** — especially the spec's
`device.importExternalTexture` video path, which was the key unknown: does Electron
honor a non-709 tag there?

**Question:** for a shared NV12 `VideoFrame` from our zero-copy path, tagged
**BT.601**, which renderer ingestion paths produce correct color?

**Verdict: only the 2D `drawImage` path is color-correct. BOTH WebGPU paths —
`copyExternalImageToTexture` AND `importExternalTexture` — are WRONG, and wrong
identically.** `importExternalTexture` does **not** rescue the zero-copy path.

### Method (`POC_COLOR=1`, new mode; existing modes untouched)

1. **Known-color clip, honestly tagged BT.601.** A 256×256 H.264 solid fill of a
   *saturated* color, RGB **(20,220,40)** (saturated green — grays can't show a
   matrix error, chroma must be non-zero), encoded under the 601 matrix:
   `-vf format=yuv420p -color_primaries smpte170m -color_trc smpte170m
   -colorspace smpte170m -color_range tv`. Verified the stored bytes: center
   **Y=136 U=79 V=53** — exactly RGB(20,220,40) under 601-limited. ffprobe confirms
   `color_space=smpte170m, color_range=tv`. ffmpeg's own 601-honoring decode back to
   RGB gives **(19,218,40)** — the ground-truth "correct" readback (the ~1–2 drift is
   H.264 + 4:2:0 rounding).
2. Decode that first frame via the existing **zero-copy** path
   (`pocCreateTextureFromVideoZerocopy`) into a shared NV12 texture; import it with
   `colorSpace` **matrix `smpte170m`, range `limited`** (the honest 601 tag).
3. In the renderer, ingest the SAME `VideoFrame` **three ways**, reading back the
   center-patch average RGB of each: (1) 2D `drawImage`+`getImageData`,
   (2) WebGPU `copyExternalImageToTexture` (Pixi's path), (3) WebGPU
   `importExternalTexture` + `texture_external` + `textureSampleBaseClampToEdge`
   (spec video path). `getVideoFrame()` is a live view (Result 4), so each path gets
   a fresh frame; path 3 does import+draw+submit synchronously, then maps the
   readback buffer.
4. **Controls:** (a) re-import the SAME frame tagged **BT.709** (deliberately wrong)
   to confirm the matrix tag is what moves the numbers; (b) round-trip a **known
   sRGB color** through the exact same WebGPU copy+render+`copyTextureToBuffer`
   readback, to prove the readback path is color-clean.

### Results (deterministic across 3 runs)

Expected CORRECT (BT.601): **[20,220,40]**, tolerance ±12/channel.

| ingestion path | measured RGB (601-tagged) | err vs expected | verdict |
|---|---|---|---|
| **2D `drawImage`** (reference) | **[20,220,41]** | [0,0,1] | **CORRECT** |
| WebGPU `copyExternalImageToTexture` | [58,217,38] | [+38,−3,−2] | **WRONG** |
| WebGPU `importExternalTexture` | [58,217,38] | [+38,−3,−2] | **WRONG** |
| *control:* known sRGB through same WebGPU readback | [20,220,40] vs known [20,220,40] | [0,0,0] | readback **CLEAN** |

709-tagged control (all three paths agreed): **[5,190,36]**.

### What this proves (and what it does NOT)

1. **2D `drawImage` honors the BT.601 tag — exact.** This is the reference; it is
   the only path that recovers the source color.
2. **Both WebGPU video-ingestion paths are wrong, and *identically* wrong.** The key
   new finding: `importExternalTexture` (`texture_external` /
   `textureSampleBaseClampToEdge`) is **not** a clean BT.601 path on
   Electron 42 — it lands on the exact same [58,217,38] as
   `copyExternalImageToTexture`. The spec's "proper" video-sampling entry point does
   **not** rescue zero-copy color on this engine.
3. **The error is genuinely in YUV→RGB ingestion, not in measurement.** The control
   round-tripped a known sRGB color through the identical WebGPU readback path with
   **maxAbsErr 0** — so the readback (rgba8unorm target + `copyTextureToBuffer`) is
   color-clean.
4. **The WebGPU error is NOT the originally-hypothesised "treated as BT.709".** A
   709-on-601 mis-convert reads [5,190,36] — which is exactly what the *709-tagged*
   import produced on all three paths. The WebGPU 601 result [58,217,38] is a
   *different*, reproducible shift, dominated by the **red (V/Cr) channel** (green &
   blue land near-correct). It does not reduce to any single textbook
   matrix-swap or limited/full range-handling model tested (closest candidate still
   ≥23 off); its shape (saturated-red push with green/blue intact) is most
   consistent with a **primaries/gamut conversion from smpte170m primaries toward
   the display/sRGB gamut** that the WebGPU paths apply and the raw-`getImageData`
   read does not — but the **exact internal mechanism is not pinned here**, only that
   it is real, reproducible, and color-shifting. What IS pinned: the WebGPU paths DO
   read the colorSpace tag (the 709 tag changed their output), they just don't render
   the same colorimetry as `drawImage` for a 601 source.
5. **Caveat:** verified at 256×256, single frame, one saturated color, on one
   machine (Electron 42.4.1 / Chromium 148, Windows 11, RTX 3050). The magnitude of
   the error is color-dependent; this is a qualitative "WebGPU paths diverge from the
   reference for non-709", not a calibrated per-color error model.

### Integration implication (the decision this informs)

The clean branch hoped for — *"real integration can stay zero-copy via
`GPUExternalTexture`, no native color-convert needed"* — is **closed for non-709
sources**. `importExternalTexture` does not honor BT.601 colorimetry the way the
reference does, so feeding our shared NV12 `VideoFrame` straight into a WebGPU/Pixi
texture would mis-color any 601-tagged (SD / much legacy) content. The viable paths:

- **`createImageBitmap(videoFrame)`** in the renderer (honors the tag like
  `drawImage`) then upload — **but that is no longer zero-copy** (a CPU/GPU
  conversion + copy), partially defeating the point.
- **Native GPU NV12→RGB convert into the working color space** (a shader on
  ffmpeg's / a shared D3D11 device, output an already-sRGB/709-working-space BGRA
  shared texture, which the WebGPU control proved round-trips cleanly) — keeps the
  GPU-resident, zero-CPU-copy property and hands Chromium a texture whose colorimetry
  the WebGPU path *does* preserve. This is the recommended follow-up probe.
- For **BT.709 full-range** sources specifically, the WebGPU paths may already match
  (709-tagged agreed across all three here) — but that is the easy case, not the one
  that motivated the probe.

So: **zero-copy to the renderer is real (Results 1–4), but zero-copy *with correct
color for non-709 sources* requires a native color-convert step; the spec
`GPUExternalTexture` path does not provide it on Electron 42.** Run with
`POC_COLOR=1 POC_VIDEO=<601 clip>` (see README).

## 6d. Result 6 — native NV12→BGRA convert (color-correct zero-copy) ✅ PASS (2026-06-29)

Result 5 closed the "stay raw-NV12 zero-copy through `GPUExternalTexture`" branch:
both WebGPU video-ingestion paths mis-color a BT.601 `VideoFrame` ([58,217,38] vs
the [20,220,40] that 2D `drawImage` recovers). Result 6 tests the recommended fix:
**do the YUV→RGB in native** — on ffmpeg's own D3D11 device, where the decoded NV12
surface lives — and share an **already-BGRA** texture in the working/sRGB space, so
the WebGPU path has no YUV→RGB left to mishandle.

**Verdict: PASS, exactly. Approach (B) — a custom D3D11 pixel shader — recovers the
reference color through the very WebGPU path that mangled raw NV12, with ZERO error.**

### Method (`POC_BGRA=1`, new mode; existing modes untouched)

Two shared textures from the SAME solid clip, in the SAME run, then ingested in the
renderer and read back at the center patch:

1. **`refDraw`** — the existing zero-copy NV12 texture
   (`pocCreateTextureFromVideoZerocopy`), imported tagged BT.601 limited, read back
   via 2D `drawImage`. This is WeftCut's existing-pipeline reference (~[20,220,40]),
   the self-calibrating target.
2. **`bgraViaWebGPU`** — a new `pocCreateBgraFromVideoZerocopy(path, matrix)`:
   - decode the first frame to the NV12 D3D11 surface (reuse
     `decode_first_d3d11_frame`),
   - `CopySubresourceRegion` the decoded slice (a `BIND_DECODER` array surface,
     which can't carry SRVs) into a plain `BIND_SHADER_RESOURCE` NV12 staging
     texture on ffmpeg's device,
   - create two SRVs over that one texture — **Y as `DXGI_FORMAT_R8_UNORM`, UV as
     `DXGI_FORMAT_R8G8_UNORM`** (D3D11 binds individual NV12 planes as typed views),
   - render a full-screen triangle into a **shared BGRA** texture
     (`SHADER_RESOURCE|RENDER_TARGET|SHARED_NTHANDLE|SHARED_KEYEDMUTEX`), pixel
     shader = the **limited-range matrix the task pins** (`Yl=(Y*255-16)/219`,
     `Cb=(U*255-128)/224`, `Cr=(V*255-128)/224`, then the 601 **or** 709 matrix,
     `saturate`), bracketed by the BGRA texture's keyed mutex,
   - share that BGRA texture, tagged `{primaries:'bt709', transfer:'srgb',
     matrix:'rgb', range:'full'}`.

   In the renderer it is ingested via **`copyExternalImageToTexture`** (Pixi's path,
   the one that was wrong for NV12) — and also `drawImage` (sanity) and
   `importExternalTexture` (cross-check).

`PASS = bgraViaWebGPU matches refDraw within ±8/channel` AND is clearly NOT the
broken raw-NV12-via-WebGPU value (~[58,217,38]).

**Approach choice — went straight to (B), the shader.** The task flagged that
`VideoProcessorBlt` (approach A) likely applies a 601→display *primaries* remap and
would land near the broken [58,217,38]; the shader gives matrix-only control that
matches `drawImage`'s naive behavior. The shader passed on the first run with 0
error, so (A) was not needed. The shader compiles HLSL at runtime via `D3DCompile`
(`Win32_Graphics_Direct3D_Fxc`), with the 601/709 matrix selected by a `#define`.

### Results (deterministic across 3 runs each)

| source | path | measured RGB | err vs refDraw | verdict |
|---|---|---|---|---|
| **601 clip** (`color601.mp4`) | `refDraw` (2D drawImage of raw NV12, 601-tagged) | **[20,220,41]** | — (reference) | reference |
| | **`bgraViaWebGPU`** (copyExternalImageToTexture of native-BGRA) | **[20,220,41]** | **[0,0,0]** | **PASS** |
| | bgraDraw (2D drawImage of native-BGRA, sanity) | [20,220,41] | [0,0,0] | shader == drawImage |
| | bgra via importExternalTexture (cross-check) | [20,220,41] | [0,0,0] | also correct |
| | *(raw NV12 via copyExternalImageToTexture — the Result-5 break)* | [58,217,38] | (err vs bgra = 38) | still WRONG |
| **709 clip** (`color709.mp4`, `POC_BGRA_MATRIX=709`) | `refDraw` (drawImage, 709-tagged) | [17,218,37] | — | reference |
| | **`bgraViaWebGPU`** (709-shader BGRA) | [17,218,37] | **[0,0,0]** | **PASS** |

### What this proves

1. **Native NV12→BGRA convert closes the Result-5 color gap.** The native-converted
   BGRA texture read back through `copyExternalImageToTexture` matches WeftCut's 2D
   `drawImage` reference **to the byte** ([20,220,41] vs [20,220,41], maxAbs 0), and
   is 38 away from the broken raw-NV12-via-WebGPU value. The zero-copy-to-renderer
   property is preserved: the convert is a GPU render on ffmpeg's device, no CPU
   bounce, no IPC frame copy; only the share handle crosses to Chromium.
2. **`copyExternalImageToTexture` is color-clean for an RGB/BGRA texture.** The
   WebGPU path only mishandled YUV→RGB; given a texture already in the working space
   (`matrix:'rgb'`), it round-trips exactly. So the fix is entirely on the producer
   side — no renderer/Pixi change needed.
3. **The native shader's matrix is byte-identical to `drawImage`'s.** For both the
   601 and 709 clips, the BGRA-via-drawImage sanity read equals the raw-NV12 drawImage
   reference (maxAbs 0). The simple limited-range matrix (no primaries/gamut remap) IS
   what `drawImage` does — confirming the [58,217,38] WebGPU error was a primaries/gamut
   transform the native path correctly omits.
4. **The convert matrix MUST track the source colorimetry.** A 709 clip decoded with
   the 601 shader (and vice-versa) gives a wrong-but-self-consistent color
   (`POC_BGRA_MATRIX` default 601 on the 709 clip read [33,251,43], not the source
   [20,220,40]); with the matching 709 matrix it recovers [17,218,37] ≈ source. A
   real integration must read the matrix (and range) from the decoded stream's tags,
   not hardcode it. The POC exposes this as the `matrix` arg / `POC_BGRA_MATRIX`.

### Caveats

- Verified at 256×256, single frame, two solid saturated colors (601 + 709), on one
  machine (Electron 42.4.1 / Chromium 148, Windows 11, RTX 3050). Not a
  multi-resolution / streaming / HDR sweep.
- The shader handles **8-bit NV12 limited-range** only. 10-bit (P010) and full-range
  sources need their own scaling/matrix; the shader is structured for it (the matrix
  is a `#define`) but those variants are not exercised here.
- The convert allocates the shader/sampler/SRVs per call (fine for a probe). A
  streaming integration would create them once and reuse, and would fold the convert
  into the per-frame `CopySubresourceRegion` already in the streaming pool (Result 3),
  so each frame is decode → convert-to-BGRA → recycled shared BGRA texture.

### Integration recommendation

**Ship the native NV12→BGRA convert as the preview producer's output format.** The
zero-copy-to-renderer transport (Results 1–4) is sound; the only open risk (color,
Result 5) is closed by converting on the producer side and sharing BGRA instead of
NV12. Concretely:

- Decode (d3d11va) → on ffmpeg's device, NV12→BGRA via the matrix-only shader
  (matrix + range from the stream's color tags) → recycled shared **BGRA** texture
  (the Result-3 pool, BGRA instead of NV12) → import **once** per ring texture
  (Result 4) → renderer feeds it straight into Pixi/WebGPU via
  `copyExternalImageToTexture`/`importExternalTexture`, no per-frame conversion and
  correct color for any source colorimetry.
- This is a hair more GPU work than sharing raw NV12 (one extra full-screen pass per
  frame, size-proportional, on the decode device) but removes the renderer-side color
  ambiguity entirely and means the renderer treats the preview texture identically to
  any other RGB layer.

## 7. Conclusion

**The full path is proven end-to-end, including color.** ffmpeg-decoded frames reach
the renderer zero-copy and stream continuously (Results 1–4), and the renderer
*ingestion* color gap that Result 5 exposed for raw NV12 is **closed** by a native
GPU NV12→BGRA convert (Result 6): the native-converted BGRA texture read back through
the same WebGPU `copyExternalImageToTexture` path that mangled raw NV12 now matches
WeftCut's 2D-`drawImage` reference **to the byte** (maxAbs 0), for both BT.601 and
BT.709 sources. Integration is back to deterministic engineering: share **BGRA**
(converted on the producer's D3D11 device, matrix/range from the stream tags), not
raw NV12. Remaining work:

- Pace the pump to the playback clock / PTS instead of as-fast-as-possible; wire into the transport (`playbackStore`).
- Correct color-range tagging (libx264 is limited-range; the streaming POC tagged full, hence 235/16 instead of 255/0), HDR (P010), odd-size/alignment.
- Lifecycle: decode errors, seek, pause, pool teardown on window close.
- This currently lives outside `@weftcut/core`; integrating means weighing it against the existing WebCodecs preview path — worth a separate design pass.

## 8. Reproduce

See [README.md](./README.md) for build/run commands and the toolchain env vars
(`FFMPEG_DIR`, `LIBCLANG_PATH`; ffmpeg bin on `PATH` at runtime — see
[[reference_ffmpeg_next_windows_setup]]). Modes: synthetic (`POC_FORMAT=bgra|nv12`),
single video (`POC_VIDEO=…`, `POC_ZEROCOPY=1`), streaming (`POC_STREAM=1`,
`POC_POOL=N`), persistent import (`POC_PERSIST=1`), renderer color paths
(`POC_COLOR=1`), and native NV12→BGRA convert (`POC_BGRA=1`,
`POC_BGRA_MATRIX=601|709`).

## 9. References

- Electron offscreen rendering / shared texture: `electronjs.org/docs/latest/api/shared-texture`, `shell/common/api/shared_texture/README.md`.
- External-texture import request (predates the shipped API): electron/electron#46779.
