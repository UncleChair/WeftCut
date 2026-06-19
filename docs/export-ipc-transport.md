# 10-bit export frame transport

The 10-bit export path (HEVC Main10 / AV1 10-bit) composites in a Web Worker, packs
each frame to `yuv420p10le`, and streams it to a native `ffmpeg` encode over Electron
main↔renderer IPC. The 8-bit path is separate (WebCodecs → mediabunny → fragmented-MP4 to disk) and
does not use this transport.

## How a frame reaches ffmpeg

1. The export Worker composites into an `rgba16float` target and `PackYuv420p10` packs
   it to `yuv420p10le` bytes.
2. The Worker posts the frame to the renderer main thread over the export `chunk`
   channel (zero-copy `postMessage` transfer) and awaits a `chunk-ack`. That ack is the
   backpressure: the next frame is not produced until the previous one has been written.
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
  16-bit-float 10-bit composite. It would serve only the 8-bit path and would add a
  separate native dependency.

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

The 10-bit HEVC export-codec conformance e2e (which drives this path end to end, with an
SSIM check) is the regression gate for any such change.
