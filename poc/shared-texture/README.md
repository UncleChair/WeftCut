# POC: import a native (ffmpeg-style) GPU texture into the renderer via Electron `sharedTexture`

## The question

Can `sharedTexture.importSharedTexture()` accept an NT handle for a D3D11 texture
that **native code created** (not Chromium's offscreen `paint` event), and display
it in the renderer as a `VideoFrame`?

If **yes**, the path is open for: native ffmpeg hardware-decode → D3D11 texture →
`importSharedTexture` → preview, with no IPC frame copy. If **no**, the whole
"ffmpeg → renderer, zero-copy" idea is dead and we learned it cheaply.

This probe uses a **synthetic checkerboard** texture, not ffmpeg, on purpose — the
handle-acceptance question is orthogonal to decoding. The texture is written once
and never mutated, so no producer/consumer synchronization is needed (and BGRA
handles carry no keyed mutex, per Electron's `SharedTextureHandle` docs).

## Result — VERIFIED ✅ (2026-06-29, Electron 42.4.1, Windows 11, RTX 3050)

**Yes.** A D3D11 texture created entirely by our own napi addon was imported by
`sharedTexture.importSharedTexture()` and displayed in the renderer as a
`VideoFrame`, with byte-exact pixels:

```
[poc-native] CreateTexture2D FAIL [SHADER_RESOURCE | NTHANDLE]: 0x80070057
[poc-native] CreateTexture2D FAIL [SHADER_RESOURCE|RENDER_TARGET | NTHANDLE]: 0x80070057
[poc-native] CreateTexture2D OK:   SHADER_RESOURCE|RENDER_TARGET | NTHANDLE|KEYEDMUTEX
[poc] importSharedTexture OK, textureId=…
[poc] sendSharedTexture resolved
RENDERER RESULT: { ok:true, frame:{format:"BGRA",256x256},
                   sample:{ cellA:[255,102,51], cellB:[34,34,34],
                            checkerboardLooksRight: true } }
```

So the native→renderer, zero-IPC-copy path is real on Windows. Two findings that
shape the ffmpeg follow-up:

1. **Raw `ID3D11Device::CreateTexture2D` requires `SHARED_NTHANDLE | SHARED_KEYEDMUTEX`
   together** (plus a `RENDER_TARGET` bind). A keyed-mutex-*free* `SHARED_NTHANDLE`
   BGRA texture — what Electron's `SharedTextureHandle` docs say Chromium emits — is
   **not** creatable through the public D3D11 API; Chromium makes those via an
   internal (Dawn/D3D11on12/fence) path. We bracket the upload in
   `AcquireSync(0)` / `ReleaseSync(0)`.
2. **The importer tolerated our keyed-mutex BGRA texture anyway** — it read the
   pixels correctly even though the docs imply BGRA handles have no keyed mutex. So
   the keyed mutex is not a blocker for the import side.

## Result 2 — real ffmpeg video, including TRUE zero-copy ✅ (2026-06-29)

Extended from synthetic textures to actual ffmpeg decode (`ffmpeg-next` 8.1,
`d3d11va` hardware decode), verified on a white-over-black H.264 clip — both paths
displayed `format=NV12, lumaTop=235, lumaBottom=16, looksRight=true`:

- **1a — synthetic NV12**: NV12 (YUV) shared texture round-trips byte-exact, proving
  the importer handles NV12 + the keyed-mutex + YUV→RGB path (not just BGRA).
- **1b-i — ffmpeg, CPU bounce**: HW-decode → `av_hwframe_transfer_data` (GPU→CPU
  NV12) → `UpdateSubresource` into a shared NV12 texture → import → display.
- **1b-ii — ffmpeg, TRUE zero-copy**: HW-decode → the decoded frame's
  `ID3D11Texture2D` is `CopySubresourceRegion`'d (GPU→GPU, no CPU bounce) into a
  shared NV12 texture **created on ffmpeg's own D3D11 device**, then shared. No CPU
  frame copy, no IPC frame transfer.

ffmpeg-path findings:
- `ffmpeg-sys-next` does **not** bind `AVD3D11VADeviceContext`; its stable public
  ABI is mirrored as a `repr(C)` struct to read ffmpeg's `ID3D11Device` /
  `ID3D11DeviceContext`. ffmpeg's COM objects are wrapped with `from_raw_borrowed`
  (no ownership) and the device is `clone()`d (AddRef) to outlive the decoder.
- The decoder's NV12 frames are a `BIND_DECODER` texture **array** (`data[0]` =
  array, `data[1]` = slice index) — not directly shareable, hence the intra-device
  copy into a fresh `SHARED_NTHANDLE|KEYEDMUTEX` texture.
- Still single-frame/static. A streaming preview must solve per-frame
  producer/consumer sync (keyed mutex or a shared fence) and reuse one shared
  texture across frames — that is Result 3.

## Result 3 — streaming sync, pooled texture REUSE ✅ (2026-06-29)

The question Results 1–2 left open: **does the keyed-mutex handshake with Chromium
let us REUSE a shared texture across many frames** (the thing a real preview needs),
without deadlock, tearing, stale frames, or drops?

**Yes — confirmed, including down to a single recycled texture.** A 60-frame
256×256 H.264 clip whose luma ramps monotonically (20→235, ~3.6/frame) was decoded
continuously and streamed to the renderer through a POOL of reusable shared NV12
textures, one frame at a time. Every run PASSED all criteria:

| pool | frames sent/recv | ordered+advancing | gaps | dups | errors | busySpins | producer fps |
|------|------------------|-------------------|------|------|--------|-----------|--------------|
| 5    | 60 / 60          | yes               | 0    | 0    | 0      | 0         | ~65          |
| 3    | 60 / 60          | yes               | 0    | 0    | 0      | 2–7       | ~60–75       |
| 1    | 60 / 60          | yes               | 0    | 0    | 0      | **79**    | ~53          |

The renderer sampled each frame's center-patch average luma and matched it against
the frame index: luma rose strictly 20→235 in lockstep with indices 0→59, with **no
non-advancing or backward sample** — which is the machine-checkable proof of *no
stale-frame reuse and no tearing* (a torn or stale frame would break monotonicity).

**`busySpins` is the load-bearing number.** It counts how often the producer found
every pool slot still held by the renderer and had to wait for Electron's
`allReferencesReleased` to free one, *then reused that freed slot for a later frame*.
With `POC_POOL=1` there is exactly ONE shared texture, so all 59 frames after the
first are forced reuses of the same texture (busySpins=79) — and it still passed,
byte-coherent and in order. **Keyed-mutex texture reuse with Chromium is real**, no
fallback to fresh-per-frame textures was needed.

How it works (architecture mirrors Electron OSR streaming):

- Native (`poc_open_video_stream`) opens the d3d11va decoder ONCE
  (`decoder::VideoStream`, which keeps `ictx`/decoder/hw-device alive and pulls the
  next GPU frame per call — `PacketIter` holds no cursor, the read position lives in
  the `AVFormatContext`, so a fresh iterator each call resumes correctly) and creates
  `poolSize` reusable `SHARED_NTHANDLE|KEYEDMUTEX` NV12 textures on ffmpeg's device,
  caching one NT handle per slot.
- `poc_stream_next_frame` finds a FREE slot (its `allReferencesReleased` fired, or it
  was never sent), `AcquireSync(0)` → `CopySubresourceRegion` (GPU→GPU) the decoded
  surface into it → `ReleaseSync(0)`, marks it busy, returns `{slot, handle, frameIndex}`.
  If no slot is free it returns `status:"busy"` so the JS pump yields and retries
  (back-pressure) instead of consuming a frame.
- Main's pump loop: per frame, `importSharedTexture({textureInfo, allReferencesReleased: () => pocFreeSlot(slot)})`,
  `await sendSharedTexture(...)`, then `imported.release()` (drop main's ref; the
  renderer holds one until it draws). `timestamp` is set to the frame index so it
  travels with the frame.

Two sync layers cooperate, and both were necessary:
1. **Keyed mutex (index 0)** on each pool texture serialises OUR GPU write
   (`CopySubresourceRegion`) against Chromium's GPU read of the same texture.
2. **A per-slot `AtomicBool` free-flag** serialises slot *ownership* across the JS
   boundary: the producer only writes a slot whose `allReferencesReleased` has fired.

Streaming-path findings:
- The producer fps (~50–75) is bounded by the per-frame `importSharedTexture` /
  `sendSharedTexture` IPC round-trip and the 2 ms busy-yield, **not** the GPU copy.
  A real preview that imports straight to a WebGPU `importExternalTexture` and paces
  to the composition clock would not pay the 2D-readback verification cost.
- More pool slots straightforwardly reduce back-pressure (busySpins 79→7→0 as
  pool 1→3→5); 3 is a comfortable default, fully decoupling producer and consumer.
- The decode never fell back to software (`next_frame` errors on any non-`D3D11`
  frame; all 60 stayed `AV_PIX_FMT_D3D11`), so the whole pipeline is true zero-copy
  GPU→GPU per frame — decode → keyed-mutex copy into a recycled shared texture →
  Chromium VideoFrame.

## Run (Windows only)

From the repo root (where `node_modules` is hoisted).

**Synthetic texture** (no ffmpeg toolchain needed for the build):

```sh
node_modules/.bin/napi build --platform \
  --manifest-path poc/shared-texture/native/Cargo.toml --output-dir poc/shared-texture/native
node_modules/.bin/electron poc/shared-texture                 # NV12 by default
POC_FORMAT=bgra node_modules/.bin/electron poc/shared-texture # BGRA checkerboard
```

**ffmpeg video paths** — build needs `FFMPEG_DIR` + `LIBCLANG_PATH`; run needs
`$FFMPEG_DIR/bin` on `PATH` (see [[reference_ffmpeg_next_windows_setup]]):

```sh
export FFMPEG_DIR="…/Gyan.FFmpeg.Shared_…/ffmpeg-8.1.1-full_build-shared"
export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
export PATH="$FFMPEG_DIR/bin:$PATH"
node_modules/.bin/napi build --platform \
  --manifest-path poc/shared-texture/native/Cargo.toml --output-dir poc/shared-texture/native

POC_VIDEO=/path/to/clip.mp4 node_modules/.bin/electron poc/shared-texture                  # 1b-i (CPU bounce)
POC_VIDEO=/path/to/clip.mp4 POC_ZEROCOPY=1 node_modules/.bin/electron poc/shared-texture    # 1b-ii (zero-copy)
```

**Streaming sync (Result 3)** — pooled reusable shared textures, multi-frame:

```sh
# Make a luma-ramp verification clip (overall brightness rises with frame index,
# so the renderer can machine-verify ordering + advance):
ffmpeg -y -f lavfi -i "color=c=black:s=256x256:r=30:d=2" \
  -vf "geq=lum='20+215*N/59':cb=128:cr=128,format=yuv420p" \
  -frames:v 60 -c:v libx264 -preset ultrafast -g 30 -bf 0 -pix_fmt yuv420p stream_test.mp4

POC_STREAM=1 POC_VIDEO=stream_test.mp4              node_modules/.bin/electron poc/shared-texture  # pool=3 (default)
POC_STREAM=1 POC_VIDEO=stream_test.mp4 POC_POOL=1   node_modules/.bin/electron poc/shared-texture  # forces reuse of ONE texture
POC_STREAM=1 POC_VIDEO=stream_test.mp4 POC_POOL=5   node_modules/.bin/electron poc/shared-texture  # no back-pressure
```

The run self-terminates and prints `STREAM SUMMARY` + `STREAM VERDICT: PASS/FAIL`.
PASS requires: received == sent, indices in order, luma strictly advancing, zero
gaps/duplicates/errors, ≥60 frames.

## Success criteria

- The window shows a 256×256 orange/dark **checkerboard**.
- Console prints `RENDERER RESULT` with `sample.checkerboardLooksRight: true`.

## If it fails — what each failure means

| Symptom | Likely cause | Next step |
|---|---|---|
| `importSharedTexture` throws | importer rejects non-Chromium handles, OR handle byte-encoding wrong | try a different `ntHandle` encoding; this may be the dead-end answer |
| black / garbage frame | **adapter mismatch (R2)** — native device ≠ Chromium's GPU | force the discrete adapter; compare logged adapter name |
| `sendSharedTexture` times out (1000ms) | receiver not registered first | ensure preload runs before `renderer-ready` |
| frame shows but `getImageData` throws | canvas tainted | use WebGPU `importExternalTexture` path instead of 2D readback |

## Notes / next steps

- `importSharedTexture` also accepts `pixelFormat: 'nv12' | 'p010le'` — so the real
  ffmpeg path could import hardware-decoded NV12/P010 textures **without** an
  RGBA conversion pass (NV12 handles do need a keyed mutex).
- The faithful zero-copy display path is WebGPU `device.importExternalTexture({ source: frame })`
  (what Pixi would use); this POC draws via 2D canvas first because it is the
  fewest lines that prove the VideoFrame is real.
- Direction reminder: `useSharedTexture` (offscreen `paint`) flows renderer→native;
  this POC uses the **reverse**, native→renderer, via `importSharedTexture` +
  `sendSharedTexture` + `setSharedTextureReceiver`.
