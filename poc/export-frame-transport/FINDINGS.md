# export-frame-transport spike — FINDINGS

De-risks the raw-frame transport question (design since consolidated into
`docs/export-ipc-transport.md`):
*can `main`→`renderer`(→Web-Worker) raw-frame transport sustain export-viable throughput,
or is Chromium IPC the wall?*

**Setup:** Electron 42.4.1 / Chromium 148, Windows 11, hidden `BrowserWindow`
(`backgroundThrottling:false`). Synthetic NV12 buffers, credit window = 4, 300 timed frames
after 30 warmup. Throughput metric = receive + `new VideoFrame(NV12)` + `close` (the one
unavoidable in-renderer copy); **no** `createImageBitmap` in the loop (measured separately).
Reproduce: `node_modules/electron/dist/electron.exe poc/export-frame-transport` → `results.json`.

## Results

| arm | channel | 1080p (3.1 MB) | 4K (12.4 MB) |
| --- | --- | --- | --- |
| arm0 | classic ipc (`webContents.send` → renderer → worker `postMessage` transfer) | **327 fps / 1017 MB/s** | **85.8 fps / 1067 MB/s** |
| arm1 | `MessageChannelMain` port, copy | 313 fps / 975 MB/s | 74.2 fps / 923 MB/s |
| arm2 | `MessageChannelMain` + transfer(attempt) + recycle | 241 fps / 750 MB/s | 57.8 fps / 719 MB/s |

`createImageBitmap` per-frame (construct + await + close): **1080p 3.25 ms**, **4K 11.75 ms**.

## Three hard findings

1. **`MessagePortMain` does not support `ArrayBuffer` transfer.** `port.postMessage(buf,
   [buf.buffer])` throws `"Port at index 0 is not a valid port"` — its transfer list accepts
   only `MessagePortMain` instances. So there is **no zero-copy `ArrayBuffer` path across
   `main`↔`renderer`**. (Combined with SAB being unable to span the process boundary, there
   is *no* CPU zero-copy option at all — matching §8.)
2. **Classic `ipcRenderer` is the fastest channel** (~1 GB/s), beating `MessageChannelMain`,
   and buffer **recycling is counter-productive without transfer** (arm2 adds a return trip
   for no zero-copy gain). The `MessageChannelMain` + transfer + recycle design in the spec's
   first draft was wrong on all three counts; the correct channel is the simplest one.
3. **The ceiling (~1 GB/s) is overhead-bound, not bandwidth-bound.** A 12 MB memcpy is ~1 ms,
   yet per-frame delivery is ~11.7 ms at 4K — the cost is Chromium IPC scheduling/serialization
   plus the `new VideoFrame` copy, not raw memory bandwidth. Frame **batching** (N frames per
   message) is the only untested lever that could raise it; not needed for the verdict below.

## Verdict

**Transport is viable for both preview and export — not a blocker — but 4K is a real
co-cost, with no zero-copy escape available.**

- **Preview:** cleared. 4K transport ~86 fps ≫ realtime 30 fps; pipelined with `createImageBitmap`
  still ~43–85 fps; playback-resolution throttle (→1080p ⇒ 327 fps) + the user-opt-in proxy
  backstop cover any residual.
- **Export (the head risk):** adequate, not abundant. End-to-end 4K ≈ 43–85 fps
  (transport + `createImageBitmap`, serial→pipelined). Export is not realtime and 4K encode is
  usually the real bottleneck, so transport does not block it — but there is no 2× headroom, so
  native 4K export will be somewhat slower than an in-worker WebCodecs decode would be. For the
  blind-spot formats (which have **no** in-worker option) this is a clear win regardless.

## Design updates folded back into the spec

- **Channel = classic `ipcRenderer`/`webContents.send`**, then same-process `postMessage`
  transfer renderer→worker for export. Drop `MessageChannelMain`, drop `ArrayBuffer` transfer
  (unsupported), drop buffer recycling (counter-productive).
- **SAB / zero-copy: not available, not pursued.** Confirmed empirically, not just argued.
- **Remaining lever if 4K export speed ever matters:** frame batching per message (untested).
