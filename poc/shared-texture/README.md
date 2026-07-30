# POC: import a native (ffmpeg-style) GPU texture into the renderer via Electron `sharedTexture`

> Full investigation writeup — motivation, architecture, every finding, and the
> verdict — is in **[FINDINGS.md](./FINDINGS.md)**. This README is the build/run guide.

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

## Result 4 — persistent import / zero per-frame IPC ✅ PASS (2026-06-29)

Result 3 paid one `importSharedTexture` + `sendSharedTexture` IPC round-trip **per
frame**. Result 4 asks whether that can go to zero: import + send each pool texture
**once**, then overwrite the SAME texture in place while the renderer keeps the same
`SharedTextureImported` and calls `getVideoFrame()` repeatedly.

**Yes.** With `POC_POOL=1` (one shared texture, imported and sent exactly once,
overwritten 60×), the renderer's repeated `getVideoFrame()` tracked the full luma
ramp 20→235 (60 distinct values, zero per-slot mid-run backward steps = no tearing),
with `importCount=sendCount=1` and `allReferencesReleased` firing 0 times. So
`getVideoFrame()` on a persistent import is a **live view** of the texture, not a
snapshot, and the keyed mutex alone keeps in-place overwrites coherent — **per-frame
texture IPC is unnecessary**. Full writeup + table in [FINDINGS.md](./FINDINGS.md) §6b.

## Result 5 — renderer color paths ❌ WebGPU video ingestion is NOT color-correct (2026-06-29)

Results 1–4 verified pixels **only** via 2D `drawImage` (which honors
`VideoFrame.colorSpace`). The real renderer uploads to WebGPU/Pixi. Result 5 asks:
for a shared NV12 `VideoFrame` tagged **BT.601**, which ingestion paths give correct
color — and specifically, does the spec's `device.importExternalTexture` video path
honor the non-709 tag?

**Verdict: only 2D `drawImage` is correct. BOTH WebGPU paths —
`copyExternalImageToTexture` AND `importExternalTexture` — are wrong, identically.**
A solid clip of saturated RGB **(20,220,40)**, honestly tagged BT.601, read back at
its center (expected ~[20,220,40]):

| path | measured | verdict |
|---|---|---|
| 2D `drawImage` (reference) | [20,220,41] | **CORRECT** |
| WebGPU `copyExternalImageToTexture` (Pixi's path) | [58,217,38] | **WRONG** |
| WebGPU `importExternalTexture` (spec video path) | [58,217,38] | **WRONG** |
| *control:* known sRGB through the same WebGPU readback | [20,220,40] | readback **CLEAN** |

`importExternalTexture` does **not** rescue zero-copy color on Electron 42 — it lands
on the exact same wrong value. A known-sRGB control round-tripped through the
identical readback path with **0** error, proving the error is in YUV→RGB ingestion,
not measurement. (The WebGPU error is also *not* the textbook "treated as 709"
mis-convert — that reads [5,190,36], what the 709-tagged import produced; the 601
WebGPU error is a distinct, red-channel-dominant shift.) **Integration consequence:**
a zero-copy `GPUExternalTexture` preview mis-colors non-709 sources; correct color
needs a native GPU NV12→working-space-RGB convert (or non-zero-copy
`createImageBitmap`). Full writeup + numbers in [FINDINGS.md](./FINDINGS.md) §6c.

## Result 6 — native NV12→BGRA convert (color-correct zero-copy) ✅ PASS (2026-06-29)

Result 5's recommended fix, verified: do the YUV→RGB in NATIVE (a D3D11 pixel shader
on ffmpeg's device, the BT.601/709 limited-range matrix, no primaries remap) and
share an already-**BGRA** texture (`matrix:'rgb'`). Then the WebGPU path has no
YUV→RGB to mishandle.

Measured on the same `color601.mp4` (source RGB (20,220,40)), in one run:

| path | measured | result |
|---|---|---|
| `refDraw` — 2D drawImage of raw NV12, 601-tagged (the reference) | [20,220,41] | — |
| **`bgraViaWebGPU`** — `copyExternalImageToTexture` of the native-converted BGRA | **[20,220,41]** | **err vs refDraw = 0** |
| *(raw NV12 via `copyExternalImageToTexture` — the Result-5 break)* | [58,217,38] | 38 away |

So the native-converted BGRA reads back through the very WebGPU path that mangled raw
NV12, matching the reference **to the byte**. A 709 clip (`POC_BGRA_MATRIX=709`) also
PASSes ([17,218,37] ≈ source). The matrix MUST match the source's color tag — applying
the wrong one yields a wrong-but-self-consistent color. **Recommendation: the preview
producer shares BGRA (converted on its D3D11 device), not raw NV12.** Full writeup +
the integration plan in [FINDINGS.md](./FINDINGS.md) §6d.

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

**Persistent import (Result 4)** — one-time import/send, in-place overwrite, no
per-frame texture IPC:

```sh
POC_PERSIST=1 POC_VIDEO=stream_test.mp4 POC_POOL=1 node_modules/.bin/electron poc/shared-texture  # single texture (decisive)
POC_PERSIST=1 POC_VIDEO=stream_test.mp4 POC_POOL=2 node_modules/.bin/electron poc/shared-texture  # ping-pong ring
```

Env knobs: `POC_FRAMES` (producer frame cap, default 60), `POC_WRITE_MS` (producer
write cadence ms, default 16), `POC_PERSIST_DUMP=1` (include the full per-pull luma
series in the summary). Prints `PERSIST SUMMARY` + `PERSIST VERDICT: PASS/FAIL`.
PASS requires: `importCount == sendCount == poolSize` (one-time), luma advanced
(≥3 distinct, max−min ≥ 40), and zero pull errors.

**Renderer color paths (Result 5)** — ingest one BT.601-tagged frame three ways
(2D drawImage, WebGPU copyExternalImageToTexture, WebGPU importExternalTexture) and
read back the center RGB. Needs a *saturated*, 601-tagged clip:

```sh
# Solid saturated green RGB(20,220,40), tagged BT.601 limited-range. Grays won't
# show a matrix error — chroma must be non-zero.
ffmpeg -y -f lavfi -i "color=c=0x14DC28:s=256x256:r=30:d=0.3" \
  -vf "format=yuv420p" \
  -color_primaries smpte170m -color_trc smpte170m -colorspace smpte170m -color_range tv \
  -c:v libx264 -preset ultrafast -g 8 -bf 0 -pix_fmt yuv420p -frames:v 8 color601.mp4

POC_COLOR=1 POC_VIDEO=color601.mp4 node_modules/.bin/electron poc/shared-texture
```

It self-terminates and prints `RESULT 5 — RENDERER COLOR PATHS: VERDICT` with each
path's measured RGB, error vs the expected [20,220,40], and CORRECT/WRONG, plus a
BT.709-tagged control and a known-sRGB readback control.

**Native NV12→BGRA convert (Result 6)** — decode + convert NV12→BGRA on ffmpeg's
D3D11 device (matrix-only shader, no primaries remap), share the BGRA, and read back
the center RGB via the WebGPU `copyExternalImageToTexture` path (the one that mangled
raw NV12) alongside the raw-NV12 2D-drawImage reference, in the SAME run:

```sh
# 601 clip (the motivating case — same color601.mp4 the color probe uses):
POC_BGRA=1 POC_VIDEO=color601.mp4 node_modules/.bin/electron poc/shared-texture

# 709 clip — the shader matrix MUST match the source; pass POC_BGRA_MATRIX=709 so
# both the reference NV12 tag and the convert shader honor 709:
ffmpeg -y -f lavfi -i "color=c=0x14DC28:s=256x256:r=30:d=0.3" -vf "format=yuv420p" \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
  -c:v libx264 -preset ultrafast -g 8 -bf 0 -pix_fmt yuv420p -frames:v 8 color709.mp4
POC_BGRA=1 POC_BGRA_MATRIX=709 POC_VIDEO=color709.mp4 node_modules/.bin/electron poc/shared-texture
```

It self-terminates and prints `RESULT 6 — NATIVE NV12→BGRA CONVERT: VERDICT` with
`refDraw` vs `bgraViaWebGPU`, the error vs the reference, and PASS/FAIL (PASS =
bgraViaWebGPU matches refDraw within ±8/channel AND is clearly not the broken
~[58,217,38]).

**Result 7 — integration re-baseline probe** (createImageBitmap path). Validates the
two unknowns the [INTEGRATION-DESIGN.md](./INTEGRATION-DESIGN.md) re-baseline rests on.

```sh
# Claim A — createImageBitmap is color-correct (extends POC_COLOR with a 4th path).
# Look at the `createImageBitmap:` line + `RESULT 7 (Claim A ...)` verdict.
POC_COLOR=1 POC_VIDEO=color601.mp4 node_modules/.bin/electron poc/shared-texture
POC_COLOR=1 POC_VIDEO=color709.mp4 node_modules/.bin/electron poc/shared-texture  # 709: read the bt709 row

# Claim B — persistent import + in-place overwrite + ASYNC createImageBitmap is
# coherent under consume-ack (no stale/torn reads). Uses the ramp clip.
POC_CIB_PERSIST=1 POC_POOL=2 POC_VIDEO=stream_test.mp4 node_modules/.bin/electron poc/shared-texture
POC_CIB_PERSIST=1 POC_POOL=1 POC_VIDEO=stream_test.mp4 node_modules/.bin/electron poc/shared-texture  # single-texture, decisive

# Claim A on P010 10-bit — make a Main10 clip; the zero-copy path auto-detects the
# P010 surface and shares 'p010le'. (Result: import yields a null/black frame on
# Electron 42 — see INTEGRATION-DESIGN.md §5a.)
ffmpeg -y -f lavfi -i "color=c=0x14DC28:s=256x256:r=30:d=0.3" -vf "format=yuv420p10le" \
  -color_primaries smpte170m -color_trc smpte170m -colorspace smpte170m -color_range tv \
  -c:v libx265 -preset ultrafast -x265-params "keyint=8:bframes=0" -pix_fmt yuv420p10le \
  -frames:v 8 color601_10bit.mp4
POC_COLOR=1 POC_VIDEO=color601_10bit.mp4 node_modules/.bin/electron poc/shared-texture
```

Outcomes (2026-06-29): Claim A NV12 **PASS**, Claim B **PASS** (pool 1 & 2), Claim A
P010 **BLOCKED** (null/black import). Details + the 10-bit decision in
[INTEGRATION-DESIGN.md](./INTEGRATION-DESIGN.md) §5a.

**A′ ticket 01 — rgba end-to-end byte-exactness probe** (`POC_RGBA_PROBE=1`).
Shares a native R8G8B8A8 texture carrying a deterministic pattern (16px corner
markers + (x,y) gradient, twin generators in Rust and preload) and asserts
BYTE-EXACT readback at two stages: `VideoFrame.copyTo` (rawest import view) and
the production `createImageBitmap(vf)` → 2D readback. Two geometries (256×256
and odd 253×119, tight 1012-byte stride). Also probes the `rgb10a2` pixelFormat
string at runtime (expected: rejected — no 10-bit RGB integer format exists on
Electron 42). No video/ffmpeg needed at runtime:

```sh
POC_RGBA_PROBE=1 node_modules/.bin/electron poc/shared-texture
```

Outcome (2026-07-30, Electron 42.4.1, RTX 3050): **PASS** — both stages, both
geometries, 0 mismatched bytes; colorSpace tag echoed intact
(`transfer:'iec61966-2-1'`, `matrix:'rgb'`, fullRange); `rgb10a2` rejected
(`Invalid shared texture info object`). The A′ premise — an sRGB-passthrough
RGBA share turns the browser into a pure byte mover — holds. Details in
`.scratch/hw-lane-color-sovereign/issues/01-…md` `## Answer`.

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
