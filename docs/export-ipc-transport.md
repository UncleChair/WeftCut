# Export frame transport (native engines)

Raw frames cross the Electron process boundary in both export directions,
over classic main↔renderer IPC. **Encode-out:** the native encode engine
composites in a Web Worker, packs each frame to the target's rawvideo format
(yuv420p, yuv422p, yuv420p10le, or yuv422p10le), and streams it to a native
`ffmpeg` encode. **Decode-in:** the native export-decode lane streams
NV12/I420P10 frames from the native component's `export_sw` session into the
Worker's export ring (see §The decode direction). The WebCodecs engine is
separate on both axes (VideoDecoder in-worker; VideoEncoder → mediabunny →
fragmented-MP4 to disk) and uses neither transport.

## How a frame reaches ffmpeg

1. The export Worker composites into a render target sized for the target
   format (`rgba16float` for the yuv420p10le lane, `rgba8unorm` otherwise); a
   GPU pack pass — `PackYuvPlanar` for yuv420p/yuv422p/yuv422p10le, or the
   parity-gated `PackYuv420p10` for yuv420p10le — writes the sink's rawvideo
   bytes.
2. The Worker posts the frame to the renderer main thread over the export `chunk`
   channel (zero-copy `postMessage` transfer). The `chunk-ack` is the backpressure,
   with exactly one frame in flight: the Worker composites and packs the next frame
   while the previous frame's ack is pending, and awaits that ack before posting —
   the transport round-trip overlaps GPU work instead of serializing after it, and
   the ack loop still bounds the pipeline at one unwritten frame.
3. The main thread forwards the bytes to the backend via `window.api.videoSinkWrite` →
   `ipcMain.handle('export:videosink_write')` → `Backend.export_video_sink_write`.
4. The backend writes the frame to `ffmpeg`'s stdin (`video_sink_write`). `ffmpeg`
   encodes to the target codec and writes the output file.
5. When the Worker finishes, the main thread calls `export_video_sink_finish`, which
   drops stdin (EOF, so `ffmpeg` finalizes) and reaps the child.

`export_video_sink_start` spawns `ffmpeg` and holds its stdin; `export_video_sink_cancel`
kills and reaps it. There is no socket, port, token, or background accept loop — a single
binary IPC channel carries the frames, and the existing `chunk`/`chunk-ack` loop provides
flow control.

## Why IPC

Native renderer→main IPC was chosen over two alternatives:

- **A loopback WebSocket** (the original transport): measured slower, and carried more
  moving parts — an ephemeral TCP listener, a bearer-token handshake, an accept-loop
  deadline, and `bufferedAmount` polling. Native IPC is faster and simpler.
- **GPU shared-texture import** (e.g. Electron offscreen rendering → FFmpeg hardware
  frames): Electron's offscreen shared texture is 8-bit BGRA, so it cannot carry the
  10-bit lane's 16-bit-float composite or the intermediate codecs' 10-bit planes. It
  would cover only part of the native engine's format range and would add a separate
  native dependency without letting this transport go away.

The same reasoning fixed the decode direction below: classic IPC measured
~1 GB/s, there is no cross-process CPU zero-copy on this platform, so the
budget is one copy per frame per hop.

## The decode direction (native export decode)

The mirror route, main → renderer → Worker, feeds natively decoded frames to
the export compositor (routing and session semantics:
[ADR 0033](adr/0033-export-decode-joins-the-engine-overlay.md);
consumption: [`render.md`](render.md) §Export decode pipelines):

1. The Worker's `NativeExportSourceHandle` sends `nd:*` commands
   (open / decodeRange / returnCredit / close) up its own `postMessage`
   channel; the renderer forwards them to the main process
   (`window.api.exportSw`), which drives the native component's `export_sw`
   session.
2. The session decodes GOP-aligned exact coverage of each requested range and
   emits **everything in-band** on its per-session callback as a tagged
   `ExportSwMsg` — `frame`, `rangeEnd`, `ended`, `error`. `rangeEnd` includes
   the exact completed `[aUs,bUs]`; after every preceding frame has arrived,
   the Worker uses it as a presentation-finality proof for pending
   `waitForPts` targets. The main process
   relays each message verbatim to the renderer over the one dedicated
   `exportSw:msg` channel, and the renderer re-posts frames into the Worker
   as transferred `ArrayBuffer`s (zero-copy at that hop).
3. Delivery order IS the contract: an `ended` or `rangeEnd` arriving before
   its tail frames would corrupt the export tail. Never split control
   signals and frames onto separate channels.
4. Backpressure is a **credit window**, not an ack loop: the Rust producer
   parks once `creditWindow` frames are in flight, and the handle returns
   exactly one credit per frame that has *left* the export ring — consumed,
   evicted, or freed — bounding main-process frame memory regardless of how
   far decode runs ahead of encode. Credit returns bypass the session's
   command channel so they land even mid-range.

## Deferred optimization: eliminate the per-frame copy

`export_video_sink_write` copies each frame out of the napi `Buffer` into an owned
`Vec<u8>` (`bytes.to_vec()`) before handing it to a blocking-thread write. The copy
exists because the write runs on `tokio::task::spawn_blocking`, whose closure must own a
`'static` buffer — it cannot borrow the JS-owned `Buffer` across the await.

This copy is **not currently a priority**. Export is offline/batch; the copy is one of
several on the path (the cross-process IPC serialization is the larger, unavoidable one);
and the realized throughput already comfortably exceeds the offline need. To make the
decision evidence-based, the sink logs per-export `copy` vs stdin-`write` timing at finish
(`video sink finished: … copy N ms, write N ms (… MB/s stdin)`) — read that line from a
real export before changing anything.

Two ways to remove the copy, *if* a profile (e.g. a 4K or long export) shows it is a real
hotspot rather than ffmpeg encode:

- **Direct async-fn write** — drop `spawn_blocking` and `write_all` the borrowed buffer in
  the async method body. Removes the copy, but the blocking pipe write then occupies a
  shared `tokio` worker thread for the duration of each (backpressured) write, which the
  backend's other async work shares.
- **Async stdin (preferred)** — spawn `ffmpeg` via `tokio::process::Command` so its stdin
  is an `AsyncWrite`; `stdin.write_all(&bytes).await` is then truly async — no copy and no
  blocked worker. This changes `start`/`finish`/`cancel` to the async-process API and is
  the cleaner end state.

The export-codec conformance e2e (`export_codecs.spec.ts`, which drives this path end to
end across 8-bit, 10-bit, and intermediate targets, with an SSIM check) is the regression
gate for any such change.
