# Findings — zero-copy native-GPU-texture → renderer via Electron `sharedTexture`

**Verdict: feasible and proven end-to-end on Windows.** A video frame decoded by
ffmpeg on the GPU can be displayed in an Electron renderer as a `VideoFrame` with
**no CPU frame copy and no IPC frame transfer**, and the path streams continuously
by recycling a pool of shared textures.

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

## 7. Conclusion

The entire original idea is proven: ffmpeg-decoded frames reach the renderer
zero-copy and stream continuously. Remaining work to integrate into a real WeftCut
preview (all deterministic engineering, no open technical risk):

- Renderer: import to WebGPU via `device.importExternalTexture({ source: videoFrame })` and feed Pixi (POC draws to a 2D canvas for verification only).
- Pace the pump to the playback clock / PTS instead of as-fast-as-possible; wire into the transport (`playbackStore`).
- Correct color-range tagging (libx264 is limited-range; the POC tags full, hence 235/16 instead of 255/0), HDR (P010), odd-size/alignment.
- Lifecycle: decode errors, seek, pause, pool teardown on window close.
- This currently lives outside `@weftcut/core`; integrating means weighing it against the existing WebCodecs preview path — worth a separate design pass.

## 8. Reproduce

See [README.md](./README.md) for build/run commands and the toolchain env vars
(`FFMPEG_DIR`, `LIBCLANG_PATH`; ffmpeg bin on `PATH` at runtime — see
[[reference_ffmpeg_next_windows_setup]]). Modes: synthetic (`POC_FORMAT=bgra|nv12`),
single video (`POC_VIDEO=…`, `POC_ZEROCOPY=1`), streaming (`POC_STREAM=1`,
`POC_POOL=N`).

## 9. References

- Electron offscreen rendering / shared texture: `electronjs.org/docs/latest/api/shared-texture`, `shell/common/api/shared_texture/README.md`.
- External-texture import request (predates the shipped API): electron/electron#46779.
