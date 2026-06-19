# 10-bit export transport PoC — native Electron IPC vs the loopback WebSocket — design

> A just-in-time PoC on branch `migration/electron-napi`. Predecessor: S3b (export) COMPLETE
> (`apps/desktop/electron/S3b-NOTES.md`). Implementation venue: the existing **`wt1`** worktree
> (`C:/Users/jonny/Desktop/learning/videtor-wt1`). This spec produces one implementation plan.
> The PoC is additive and branch-local — it does **not** edit the shipping WebSocket path.

## Goal

Decide one thing with evidence: **can a native Electron renderer↔main IPC transport replace the
Tauri-era loopback WebSocket** that currently carries the 10-bit export's packed `yuv420p10le`
frames from the export Worker to ffmpeg's stdin, **without regressing export throughput**?

Deliverable: a throughput comparison of three transports feeding the same ffmpeg/NVENC sink, plus a
GO/NO-GO on swapping the WebSocket out. PoC only — the production swap is a separate, gated follow-up.

## Why (motivation)

The user's pain (selected during brainstorming): the 10-bit `gl.readPixels → loopback-WebSocket →
Rust ffmpeg` transport feels fragile and Tauri-shaped, and they want it simpler or gone.

- **The WebSocket is a Tauri-era workaround.** Under Tauri/WebView2 the webview↔Rust seam had hard
  limits (custom URI ~25 ms/fetch; `asset://` ~1 MB 206-body cap), so a loopback `ws://` was a
  reasonable escape for a high-rate byte stream. **Under Electron the renderer↔main IPC is native
  and fast, so the WebSocket's reason-for-being is largely gone.**
- **It is fragile today.** The migration deleted the IPC write arm (S3b B2: "`export_video_sink_write`
  intentionally unported") and kept only the WS. The JS-side `postChunk` fallback in `exportWorker.ts`
  now routes to a Rust target that no longer exists — it is **dead code**. So a WS bind/connect
  failure means **broken 10-bit export with no graceful degradation**. The WS also carries a lot of
  moving parts: ephemeral port bind (`127.0.0.1:0`), a bearer-token text handshake, a 30 s accept
  deadline, `bufferedAmount` high-water polling, and close-code-1000-as-EOF semantics.
- **The change is determinism-neutral.** Same composite, same `PackYuv420p10` bytes, same
  ffmpeg/`hwencoder` Main10 encode — only the byte-transport differs. The migration's payoff
  (determinism, not speed) is untouched.

## Scope (decisions resolved in brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| P1 | Lever | **Native Electron IPC transport bench.** SharedTexture rejected: 8-bit-only (OSR composites BGRA8, can't carry the f16 10-bit path), adds `paint`↔frame determinism risk, and a new C++ native dep beside Rust `@weftcut/core` — high cost, doesn't even solve 10-bit. |
| P2 | Blast radius | **10-bit only.** The WS is gated behind `tenBit` in `exportWorker.ts` (`sinkClient` created only when `tenBit`). 8-bit (WebCodecs → mediabunny → `fs:writeFile` append) is untouched. |
| P3 | Transports compared | (1) `ipcRenderer.invoke` per-frame; (2) `MessageChannelMain` `MessagePort` transferred into the Worker; (3) the existing WebSocket as baseline. |
| P4 | Named pipe | **Rejected.** A sandboxed Electron renderer (and a Web Worker) can't open an OS named-pipe handle without `nodeIntegration`; and main→ffmpeg already uses stdin, so a named pipe buys nothing there. The hard leg is renderer→main, which named pipes don't help. |
| P5 | Resolution | **1080p primary; 4K conditional.** If 1080p can't separate the transports (all comfortably fast, within ~10 % of each other), rerun at 4K (~4× payload, ~25 MB/frame) to expose per-frame copy-cost differences. |
| P6 | Venue & safety | Implement in the `wt1` worktree. The PoC runs **alongside** the shipping WS code (additive Rust/IPC entry points + a standalone bench harness); **no edit to the production WS path**. |

## Current state (verified during recon)

- **`exportWorker.ts`**: `tenBit = req.bitDepth === 10` (L109). `sinkClient` is created only under
  `tenBit` (L233–243). The 10-bit branch renders to the `rgba16float` target, packs via
  `PackYuv420p10` (L406), then `await sinkClient.write(bytes)` (L413); the `else` arm
  `postChunk(bytes.slice())` (L418) is the **dead** IPC fallback. 8-bit → `EncoderSink` (WebCodecs, L447).
- **`videoSinkClient.ts`**: WebSocket to `127.0.0.1:port`, token text frame first, `bufferedAmount`
  32 MB high-water, `close(1000)` = clean EOF.
- **`src-tauri/src/export/videosink.rs`**: `export_video_sink_start` builds the ffmpeg command
  (`-f rawvideo -pix_fmt yuv420p10le … → hwencoder NVENC/QSV/AMF Main10` or software) and spawns
  the child; `run_ws_sink` (tungstenite) accepts one client (30 s deadline), verifies the token,
  pumps binary frames to ffmpeg stdin; `start`/`finish`/`cancel` lifecycle is fully ported. The
  **write arm is NOT ported** (S3b B2). `Backend` holds `video_sink: Arc<Mutex<VideoSinkState>>`
  and `hw_encoder: Arc<Mutex<HwEncoderCache>>`.
- **`src/ipc/index.ts`** still declares `exportVideoSinkWrite(bytes) → invoke("export_video_sink_write", bytes)`
  (L1413), but its napi target was deleted — vestigial.
- **Throughput history** (`e2e/tools/iso_transport_matrix.e2e.js`, measured 2026-06-13 on Tauri/
  WebView2, RTX 3050): WS shipping path `T1` 71 MB/s at dev `opt-level=0` → **~312 MB/s** at
  release/`opt-level=1`; Chromium WS send side ≥ 312 MB/s. **This benchmarks the WebSocket, not
  Electron IPC** — the Electron-IPC number is the open question this PoC answers. (~312 MB/s ≈
  50 fps @ 1080p `yuv420p10le`, the reference floor.)
- **`@weftcut/core`** loaded via `createRequire("@weftcut/core")` in `electron/main/index.ts`.
  Electron **42.4.1**.

## PoC design

A side-by-side bench harness, isolated from the shipping export, with three interchangeable transports
all terminating at the **same** ffmpeg/`hwencoder` Main10 sink.

**Rust (napi `Backend`)** — additive, does not touch the WS code path:
- Add an `export_video_sink_write(bytes: &[u8])` method that appends to the active sink's ffmpeg
  stdin. Borrow the napi buffer (`&[u8]`) for the call to avoid an extra copy; measure, don't assume.
- Extend `VideoSinkStartArgs.mode` with an `"ipc"` variant alongside `"ws"`/`"discard"`: `"ipc"`
  spawns ffmpeg and holds stdin **without** binding the WebSocket; `"ws"` is the existing path
  (baseline). Reuse `SinkShared`/`finish`/`cancel` unchanged.

**Electron main**:
- `ipcMain.handle("export:videosink_write", (_e, ab) => backend.export_video_sink_write(Buffer.from(ab)))`
  for the invoke transport.
- A `MessageChannelMain` variant: main creates the channel, sends `port2` to the renderer (which
  transfers it into the Worker), and feeds `port1.on("message", …)` bytes to `export_video_sink_write`.

**Renderer / Worker bench** (standalone, not the real timeline export — model it on
`e2e/tools/iso_video_sink_throughput.e2e.js`):
- Generate `N` synthetic `yuv420p10le` frames at W×H with a deterministic fill (so output is
  verifiable and runs need no media fixtures).
- Push the same `N` frames through each transport, timing first-send → sink-drained:
  1. **invoke**: Worker → `postMessage(ab, [ab])` (zero-copy transfer to the renderer main thread) →
     `ipcRenderer.invoke("export:videosink_write", ab)`. Awaiting the invoke is the backpressure.
  2. **MessagePort**: Worker holds a transferred `MessagePort`; `port.postMessage(ab, [ab])`; main
     feeds ffmpeg. Backpressure via bounded-outstanding (cap in-flight frames; ack via a return port
     message) since there is no built-in await.
  3. **WebSocket** (baseline): drive the existing `VideoSinkClient` against the existing tungstenite
     sink (`mode:"ws"`), unchanged.

**Validation per transport**: the produced file must be a real 10-bit HEVC (`ffprobe`: `codec_name=hevc`,
`pix_fmt=yuv420p10le`, `profile="Main 10"`), proving the IPC byte path is correct end-to-end.

## Acceptance — GO / NO-GO

- ✅ All three transports produce a valid 10-bit HEVC file (correctness of the IPC byte path proven).
- 📊 A throughput table at 1080p (MB/s + end-to-end ms per transport); 4K appended only if 1080p
  can't differentiate them.
- **GO** if a chosen IPC transport — prefer `invoke` for simplicity, fall back to `MessagePort` —
  sustains **≥ the WS baseline** on this box, or at minimum **≥ the offline-export floor** (the
  realized export fps need; WS ~312 MB/s ≈ 50 fps @ 1080p is the reference), with no correctness loss.
- **NO-GO** ⇒ keep the WebSocket; document the measured reason (which transport, what MB/s, where the
  wall was).
- The shipping WS production code is unchanged at the end of the PoC regardless of outcome.

## Out of scope

- The production swap itself (delete the WS, rewire `exportWorker.ts`/`videosink.rs`, drop the
  vestigial fallback) — a follow-up plan gated on **GO**.
- The 8-bit path (untouched), SharedTexture / GPU zero-copy, and eliminating the 10-bit
  `gl.readPixels` readback (impossible without abandoning the f16 composite — the readback stays).
- Determinism gates — transport-neutral; the bytes are identical.

## Risks / unknowns

- **Electron structured-clone copy cost** per 6 MB (1080p) / ~25 MB (4K) frame on the `invoke`
  transport — the main thing 4K is there to probe.
- **MessagePort backpressure** has no built-in await; needs a bounded-outstanding + ack scheme, which
  is the fiddly part of transport (2).
- **`wt1` base**: the worktree (`0c2703c0`) is behind the main checkout (`703c735e`) and must carry
  the S3b export code (`videosink.rs`, `exportWorker.ts`, `PackYuv420p10.ts`). **Verify/update wt1's
  base before writing PoC code.**
- **napi buffer handling**: `&[u8]` borrow-for-the-call vs `Buffer` copy — measure rather than assume
  the zero-copy borrow holds.
