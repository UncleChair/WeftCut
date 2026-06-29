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
  texture across frames.

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
