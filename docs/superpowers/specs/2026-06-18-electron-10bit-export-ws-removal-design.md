# 10-bit export: retire the loopback WebSocket for native IPC — design

> Production follow-up to the transport PoC (`2026-06-18-electron-10bit-export-transport-poc-design.md`),
> which proved **GO** (native Electron IPC 3.22× the loopback WebSocket, same box). Branch `wt1`
> (continues the PoC commits). This spec produces one implementation plan.

## Goal

Make native Electron IPC the **only** transport for the 10-bit export's `yuv420p10le` frame stream,
and **delete the Tauri-era loopback WebSocket** end to end — server, client, token handshake, and the
ephemeral TCP listener. After this change, a 10-bit export composites in the Worker, packs to
`yuv420p10le`, ships each frame over the existing `postChunk` channel to the main thread, which calls
the native `window.api.videoSinkWrite` IPC; the Rust sink pipes frames straight to ffmpeg's stdin with
no socket, no thread, and no accept loop.

## Background (verified during recon)

- **The renderer-side IPC plumbing already exists.** The export Worker's `postChunk` / `chunk-ack`
  loop (`exportWorker.ts`) already carries 10-bit frames in its `else { postChunk(bytes.slice()) }`
  branch; `runExport.ts`'s `worker.onmessage` routes `chunk` → a `writeChunk` callback; `App.tsx`'s
  `writeChunk` already calls an IPC write for the 10-bit path. The `chunk`/`chunk-ack` backpressure is
  identical to the 8-bit fMP4 path. **No new Worker→main transport is needed.**
- **But that existing IPC write is broken in Electron.** `ipc/index.ts`'s `exportVideoSinkWrite(bytes)`
  routes through the JSON `invoke` dispatcher (`invoke("export_video_sink_write", bytes)`), whose Rust
  arm was deleted in S3b B2. It is only avoided today because the WS branch is preferred. The PoC added
  the correct **binary** channel: preload `window.api.videoSinkWrite` → `ipcMain.handle('export:videosink_write')`
  → napi `Backend.exportVideoSinkWrite(Buffer)` → `videosink::video_sink_write` → ffmpeg stdin.
- **The Rust sink reap/teardown is currently WS-thread-driven.** `export_video_sink_finish` joins the
  `run_ws_sink` thread, which performs the `child.wait()`. Removing the WS thread means `finish`/`cancel`
  must reap the ffmpeg child directly.
- **Current 10-bit gate:** `e2e/electron/export_codecs.spec.ts`'s 10-bit HEVC test drives the real
  `App.tsx` export flow (currently `mode:"ws"`). Flipping `App.tsx` to IPC makes this gate exercise the
  production IPC path end to end — no spec change needed.

## Decision

**Approach A — full WebSocket removal** (chosen over the minimal "keep an idle WS thread" option, which
would leave dead socket infrastructure in the shipping path and defeat the goal).

## Architecture / data flow (after the change)

```
Worker (exportWorker.ts)                 Main thread (runExport.ts / App.tsx)        Main process (napi)
─────────────────────────                ────────────────────────────────────       ───────────────────
composite → PackYuv420p10                worker.onmessage 'chunk'                     Backend.exportVideoSinkWrite(Buffer)
  → postChunk(bytes) ──transfer──▶       → writeChunk(data) (10-bit)                    → videosink::video_sink_write
  (awaits 'chunk-ack')                     → window.api.videoSinkWrite(data) ──IPC──▶     → write_all to ffmpeg stdin
                                           (awaits) → post 'chunk-ack' ◀──               (spawn_blocking; bumps ipc counters)
... last frame ...
worker done                              exportVideoSinkFinish() ──IPC──▶             finish: drop stdin → child.wait() → SinkStats
```

Backpressure is the existing `chunk`/`chunk-ack` loop: the Worker awaits the ack (which the main thread
posts only after `videoSinkWrite` resolves, i.e. after the frame is written to ffmpeg stdin). No socket
buffer polling.

## Components / changes

### Renderer (TypeScript)
- **`App.tsx`** — export start: `mode:"ws"` → IPC (see "Rust" for the arg shape); stop creating and
  threading `videoSink {port,token}` into the Worker start request. `writeChunk` (10-bit) already calls
  `exportVideoSinkWrite` — no change there once that wrapper is fixed.
- **`ipc/index.ts`** — `exportVideoSinkWrite(bytes)` calls `window.api.videoSinkWrite(bytes)` (the PoC's
  binary channel) instead of the broken `invoke("export_video_sink_write", bytes)`. `exportVideoSinkStart`
  return type drops `{port,token}` (start returns nothing meaningful). `VideoSinkStartArgs` drops `mode`.
- **`exportWorker.ts`** — delete the `sinkClient` WS branch (L233–248 connect, L410–413 write, L547–548
  finish, L598 abort). The 10-bit branch always does `await postChunk(bytes.slice())`. Drop the
  `videoSink` field from the start request type and the `VideoSinkClient` import.
- **`protocol.ts`** — update the `chunk` doc-comment (it currently says 10-bit IPC is a "fallback"; it's
  now the only path). Drop the `videoSink` field from the start-request type.
- **Delete `videoSinkClient.ts`** entirely.

### Main process (Electron)
- No change. `export:videosink_write` handler + `window.api.videoSinkWrite` (from the PoC) stay.
  (The `export_video_sink_start`/`finish`/`cancel` JSON-dispatch arms remain — they no longer return a
  port/token but still start/finish/cancel the sink.)

### Rust (`src-tauri/src/export/videosink.rs`)
- **Delete the WS server:** `run_ws_sink`, `message_kind`, the `TcpListener` bind, `make_token`, the
  token handshake, `VideoSinkStartReply`, and the `tungstenite` dependency usage. Remove `tungstenite`
  from `Cargo.toml` if unused elsewhere (verify).
- **`SinkShared` slims** to: `child`, `stdin`, `ipc_bytes`, `ipc_frames`, `t0`, `stderr_tail`. Drop
  `ws_connected`, `finishing`, `last_write_ms` (all were WS-accept-loop state). `ActiveSink` drops its
  `join` handle (no WS thread); it holds `shared` (the stderr-drain thread stays — it ends when ffmpeg's
  stderr closes).
- **`export_video_sink_start`** (renamed args drop `mode`): always spawn ffmpeg (the existing encode
  command, unchanged) + take stdin + spawn the stderr-drain thread; store `ActiveSink{shared}`. Returns
  `Ok(())`. Keep `reclaim_stale_sink` (simplified: take stale, `abort_child`, drop stdin) for the
  webview-reload-mid-export orphan case.
- **`video_sink_write`** (from the PoC) — unchanged.
- **`export_video_sink_finish`** — direct reap: drop stdin (EOF), take the child, `child.wait()` (via
  `spawn_blocking`), error with the stderr tail on non-zero exit, return `SinkStats` from
  `ipc_bytes`/`ipc_frames`/`t0.elapsed()`. No thread join.
- **`export_video_sink_cancel`** — `abort_child` (kill + wait) then drop stdin. Unchanged in spirit.

## Error handling

- **ffmpeg fails mid-stream:** a `write_all` to a broken pipe returns `Err` → `video_sink_write` rejects
  → the main thread's `writeChunk` rejects → `runExport` rejects → `App.tsx` calls
  `exportVideoSinkCancel` (kills/reaps) and surfaces the error. The bounded `stderr_tail` is appended to
  the message (preserved from current behavior).
- **ffmpeg fails at EOF:** `finish`'s `child.wait()` returns non-zero → `finish` errors with the stderr
  tail; `App.tsx` shows "Finalize failed" and removes the temp files (current behavior preserved).
- **Worker crash / reload mid-export:** the renderer rejects and calls cancel; a sink still present at
  the next `start` is reclaimed by `reclaim_stale_sink`.
- **No write-in-flight at finish:** guaranteed by the `chunk`/`chunk-ack` serialization — the last
  `videoSinkWrite` has resolved before `App.tsx` calls `finish`, so dropping stdin is safe.

## Testing

- **Rust unit test:** `start` (IPC) with empty `output_path` (discard, no ffmpeg) → `video_sink_write`
  N frames → `finish` → assert `SinkStats.frames/bytes` and that `finish` returns promptly (direct reap,
  no hang). Adapt the PoC's `ipc_discard_write_counts_bytes_and_frames` to the new `start` shape
  (no `mode`).
- **End-to-end gate (existing):** `e2e/electron/export_codecs.spec.ts`'s 10-bit HEVC test now exercises
  the IPC path through `App.tsx` — must still pass (`codec_name=hevc`, `pix_fmt` ∈ {yuv420p10le, p010le},
  `profile` "Main 10", bt709 tags). This is the production-path gate.
- **Full suites must stay green:** `cargo test --lib --features jobs,export` and the Playwright Electron
  suite (`s2`/`s3a`/`s3b` + codecs/conformance/eos/overlap).

## Deletion scope (verify-before-delete)

- `apps/desktop/src/render/worker/videoSinkClient.ts` — the WS client.
- `apps/desktop/e2e/electron/transport_bench.spec.ts` and `transport_bench_smoke.spec.ts` — PoC
  scaffolding; their job (the GO decision) is done, and `transport_bench.spec.ts`'s WS-baseline test
  would break once `"ws"`/`"discard"` are gone. `export_codecs` gates the real path.
- `apps/desktop/e2e/tools/iso_transport_matrix.e2e.js` and `iso_video_sink_throughput.e2e.js` — Tauri-era
  wdio tools (`window.__TAURI__`, dead in Electron) that only ever benched the WS. **Verify** they are not
  referenced by any live config before deleting.
- The `tungstenite` dependency in `src-tauri/Cargo.toml` — remove only after confirming no other module
  uses it.

## Out of scope

- The 8-bit path (WebCodecs → mediabunny → `fs:writeFile` append) — untouched.
- The `gl.readPixels` 10-bit readback itself — inherent to the f16 composite; stays.
- Any throughput re-tuning beyond what the PoC measured. (The PoC's per-frame `bytes.to_vec()` copy in
  `video_sink_write` stays for now; eliminating it via an `&[u8]` borrow is a possible later micro-opt,
  not required — the measured 373 MB/s already includes the copy.)

## Risks

- **`finish`/`cancel` reap rewrite** is the main risk (the PoC left it untouched). Mitigated by the
  Rust discard test + the `export_codecs` 10-bit e2e gate exercising the real encode+finish.
- **Removing `tungstenite`** could break the build if another module imports it — verify with a grep
  before removing the Cargo dependency; if anything else uses it, leave the dep and only delete the
  sink's WS code.
- **`VideoSinkStartArgs` shape change** (drop `mode`/return) crosses the renderer↔Rust boundary — both
  sides land in the same change; the `export_codecs` gate catches a mismatch.
