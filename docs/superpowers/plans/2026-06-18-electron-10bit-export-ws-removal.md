# 10-bit Export: Retire the Loopback WebSocket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native Electron IPC the only transport for the 10-bit export's `yuv420p10le` frame stream and delete the Tauri-era loopback WebSocket end to end (server, client, token, listener).

**Architecture:** The export Worker already posts 10-bit frames over the existing `postChunk`/`chunk-ack` channel; the main thread's `writeChunk` already calls an IPC write. This plan (1) rewrites the Rust sink to be IPC-only with direct ffmpeg reaping (no WS thread), (2) removes the now-dead `videoSink {port,token}` threading and the WS client across the renderer, rewiring the IPC write to the PoC's working binary channel, and (3) verifies the integrated path via the existing `export_codecs` 10-bit e2e gate and removes obsolete test scaffolding.

**Tech Stack:** Rust (napi-rs v3, tokio, ffmpeg-sidecar), Electron 42.4.1, TypeScript (Vite/electron-vite), Playwright-for-Electron, vitest.

## Global Constraints

- Branch / venue: `wt1` worktree (`C:/Users/jonny/Desktop/learning/videtor-wt1`), continuing the PoC commits. Paths below are relative to `apps/desktop/` unless noted, except `docs/`.
- napi build (do NOT change features): `npm run napi:build` = `napi build --platform --release --manifest-path src-tauri/Cargo.toml --output-dir src-tauri --features jobs,export,mcp,cloud,motifs`.
- Gate commands: Rust = `cd src-tauri && cargo test --lib --features jobs,export`; renderer typecheck = `npm run typecheck` (`tsc -b`); renderer unit tests = `npm test` (`vitest run`); e2e = `npx playwright test <spec> -c playwright.config.ts` (needs a `VITE_WEFTCUT_E2E=1` electron build).
- The 8-bit export path (WebCodecs → mediabunny → `fs:writeFile` append) must remain UNTOUCHED and green.
- The IPC frame channel itself (`window.api.videoSinkWrite` → `ipcMain.handle('export:videosink_write')` → `Backend.exportVideoSinkWrite`) already exists from the PoC — do not re-add it.
- Slow builds (`napi:build`, `electron:build`) may take 10+ min; run with `run_in_background` or the max Bash timeout. Node 22.20.0 is the active version.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- `src-tauri/src/export/videosink.rs` — **rewrite**: IPC-only sink. Delete the WS server (`run_ws_sink`, `TcpListener`, `make_token`, `message_kind`, token handshake, `VideoSinkStartReply`); slim `SinkShared`; `ActiveSink` loses its thread `join`; `finish`/`cancel` reap directly; `VideoSinkStartArgs` loses `mode`.
- `src-tauri/Cargo.toml` — **modify**: remove `tungstenite` (only if unused elsewhere).
- `src/ipc/index.ts` — **modify**: `VideoSinkStartArgs` loses `mode`; `exportVideoSinkStart` returns `void`; `exportVideoSinkWrite` calls `window.api.videoSinkWrite`.
- `src/electron-compat/tauri-core.ts` — **modify**: add `videoSinkWrite` to the `Window.api` type.
- `src/App.tsx` — **modify**: drop the `mode:"ws"` arg + the `videoSink` capture/threading.
- `src/render/worker/exportWorker.ts` — **modify**: delete the `VideoSinkClient` branch; 10-bit always `postChunk`.
- `src/render/worker/protocol.ts`, `src/render/worker/runExport.ts`, `src/render/PixiPreview.tsx`, `src/render/PreviewSurface.tsx`, `src/render/pixiPreviewFlag.ts` — **modify**: remove the threaded `videoSink?: {port,token}` field + spreads.
- `src/render/worker/videoSinkClient.ts` + `videoSinkClient.test.ts` — **delete**.
- `e2e/electron/transport_bench.spec.ts`, `transport_bench_smoke.spec.ts`, `e2e/tools/iso_transport_matrix.e2e.js`, `e2e/tools/iso_video_sink_throughput.e2e.js` — **delete** (T3, verify-before-delete).

---

### Task 1: Rust — IPC-only sink (delete WS server, direct-reap finish/cancel)

**Files:**
- Rewrite: `src-tauri/src/export/videosink.rs`
- Modify: `src-tauri/Cargo.toml` (remove `tungstenite` if unused)

**Interfaces:**
- Consumes: `super::hwencoder::HwEncoderCache`, `super::video_encode_args`, `super::hwencoder::tenbit_encode_args`, `super::hvc1_tag_args`, `super::hwencoder::TargetCodec` (all unchanged).
- Produces: `pub async fn export_video_sink_start(state, hw, args: VideoSinkStartArgs) -> Result<(), String>` (args has NO `mode`; returns `()` not a reply); `pub async fn video_sink_write(state, data: Vec<u8>) -> Result<(), String>`; `pub async fn export_video_sink_finish(state) -> Result<SinkStats, String>`; `pub async fn export_video_sink_cancel(state) -> Result<(), String>`. `SinkStats { bytes, frames, elapsed_ms }` unchanged.

- [ ] **Step 1: Update the existing tests to the new shapes (RED)**

Replace the entire `#[cfg(test)] mod tests { … }` block at the bottom of `videosink.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_shared() -> Arc<SinkShared> {
        Arc::new(SinkShared {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            t0: Instant::now(),
            ipc_bytes: AtomicU64::new(0),
            ipc_frames: AtomicU64::new(0),
            stderr_tail: Mutex::new(String::new()),
        })
    }

    // A leaked/orphaned sink (webview reloaded mid-export) must be reclaimed
    // by the next start instead of wedging future exports.
    #[test]
    fn reclaim_clears_orphaned_sink() {
        let shared = dummy_shared();
        let state = Mutex::new(Some(ActiveSink { shared }));
        reclaim_stale_sink(&state);
        assert!(state.lock().unwrap().is_none(), "orphaned sink must be reclaimed");
    }

    #[test]
    fn reclaim_is_a_noop_when_no_sink_is_active() {
        let state: Mutex<Option<ActiveSink>> = Mutex::new(None);
        reclaim_stale_sink(&state);
        assert!(state.lock().unwrap().is_none());
    }

    // IPC + empty output_path (no ffmpeg): push frames through video_sink_write,
    // finish, and confirm the counters AND that finish reaps promptly + clears
    // the sink (the direct-reap path with child=None).
    #[tokio::test]
    async fn ipc_write_counts_and_finish_reaps() {
        let state = VideoSinkState::default();
        let hw = super::super::hwencoder::HwEncoderCache::default();
        export_video_sink_start(
            &state,
            &hw,
            VideoSinkStartArgs {
                width: 64,
                height: 64,
                fps_num: 30,
                fps_den: 1,
                codec: "hevc".into(),
                bitrate: 0,
                cbr: false,
                gop: 30,
                software: false,
                output_path: String::new(),
            },
        )
        .await
        .expect("start");

        let frame = vec![7u8; 64 * 64 * 3];
        for _ in 0..5 {
            video_sink_write(&state, frame.clone()).await.expect("write");
        }

        let stats = export_video_sink_finish(&state).await.expect("finish");
        assert_eq!(stats.frames, 5);
        assert_eq!(stats.bytes, 5 * (64 * 64 * 3) as u64);
        assert!(state.0.lock().unwrap().is_none(), "finish clears the sink");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail (compile error)**

Run: `cd src-tauri && cargo test --lib --features jobs,export videosink 2>&1 | head -40`
Expected: FAIL to compile — `SinkShared` has fields the new `dummy_shared` omits (`ws_connected`/`finishing`/`last_write_ms` still present), `ActiveSink { shared }` is missing `join`, and `VideoSinkStartArgs` still requires `mode`. This confirms the tests target the rewrite.

- [ ] **Step 3: Rewrite `videosink.rs` (everything above the test module)**

Replace the entire file content from the top through the end of `export_video_sink_cancel` (i.e. everything before the `#[cfg(test)]` module you just wrote) with:

```rust
//! Native-IPC video sink for the 10-bit export. The webview composites in a
//! Worker, packs each frame to yuv420p10le, and posts it over the export
//! `chunk` channel; the main process forwards each frame to `video_sink_write`,
//! which pipes it into an ffmpeg encode. `finish` drops stdin (EOF) and reaps
//! ffmpeg directly. The former loopback-WebSocket transport was retired (see
//! docs/superpowers/specs/2026-06-18-electron-10bit-export-ws-removal-design.md).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

#[derive(Default)]
pub struct VideoSinkState(pub Mutex<Option<ActiveSink>>);

/// Shared between the IPC write command, finish, and cancel.
pub struct SinkShared {
    /// ffmpeg child (None when output_path is empty / after wait).
    pub child: Mutex<Option<Child>>,
    /// ffmpeg stdin. The IPC write command writes here; dropping it = EOF.
    pub stdin: Mutex<Option<ChildStdin>>,
    /// Time origin for SinkStats.
    pub t0: Instant,
    /// IPC-path counters reported as SinkStats.
    pub ipc_bytes: AtomicU64,
    pub ipc_frames: AtomicU64,
    /// Rolling tail of ffmpeg stderr (bounded to 8192 chars), appended to errors.
    pub stderr_tail: Mutex<String>,
}

pub struct ActiveSink {
    pub shared: Arc<SinkShared>,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SinkStats {
    pub bytes: u64,
    pub frames: u64,
    pub elapsed_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSinkStartArgs {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// "hevc" | "av1".
    pub codec: String,
    pub bitrate: u64,
    pub cbr: bool,
    pub gop: u64,
    pub software: bool,
    /// Empty ⇒ no ffmpeg (byte-count only; used by tests). Non-empty ⇒ encode.
    pub output_path: String,
}

/// Build the ffmpeg-stderr suffix appended to error messages (last ≤8 lines).
fn tail_suffix(shared: &SinkShared) -> String {
    let t = shared.stderr_tail.lock().unwrap();
    if t.is_empty() {
        String::new()
    } else {
        let tail: Vec<&str> = t.lines().rev().take(8).collect();
        format!(
            " ffmpeg stderr tail:\n{}",
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        )
    }
}

/// Kill and reap `shared.child`, ignoring all errors.
fn abort_child(shared: &SinkShared) {
    if let Some(mut c) = shared.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// Tear down a sink left in `state`, if any. The app runs at most one export at
/// a time, so a sink still present when a NEW export starts is always an orphan
/// (its webview-side finish/cancel never ran — typically a webview reload/crash
/// mid-export). Kill its ffmpeg and drop the handle so the next export proceeds.
fn reclaim_stale_sink(state: &Mutex<Option<ActiveSink>>) {
    let stale = state.lock().unwrap().take();
    if let Some(sink) = stale {
        warn!("video sink already active at start — reclaiming orphaned sink (prior export's teardown never ran, e.g. a webview reload mid-export)");
        abort_child(&sink.shared);
        drop(sink.shared.stdin.lock().unwrap().take());
    }
}

pub async fn export_video_sink_start(
    state: &VideoSinkState,
    hw: &super::hwencoder::HwEncoderCache,
    args: VideoSinkStartArgs,
) -> Result<(), String> {
    // An active sink here is always stale (single-export invariant); reclaim it.
    reclaim_stale_sink(&state.0);

    let mut child_opt: Option<Child> = None;
    let mut stdin_opt: Option<ChildStdin> = None;
    let mut stderr_temp: Option<std::process::ChildStderr> = None;

    if !args.output_path.is_empty() {
        let codec = super::hwencoder::TargetCodec::parse(&args.codec)
            .ok_or_else(|| format!("unknown codec {}", args.codec))?;
        if !matches!(
            codec,
            super::hwencoder::TargetCodec::Hevc | super::hwencoder::TargetCodec::Av1
        ) {
            return Err(format!("10-bit export supports hevc/av1, got {}", args.codec));
        }
        let encoder = if args.software {
            codec.software_encoder().to_string()
        } else {
            hw.encoder_for_10bit(codec).await.as_ref().clone()
        };
        let mut cmd = std::process::Command::new(ffmpeg_sidecar::paths::ffmpeg_path());
        cmd.args(["-y", "-hide_banner", "-loglevel", "error"]);
        cmd.args(["-f", "rawvideo", "-pix_fmt", "yuv420p10le"]);
        cmd.arg("-video_size").arg(format!("{}x{}", args.width, args.height));
        cmd.arg("-framerate").arg(format!("{}/{}", args.fps_num, args.fps_den));
        cmd.args(["-i", "-"]);
        // Tag the FRAMES (rawvideo carries no colour metadata) so every encoder
        // family emits the full bt709/limited 4-tuple (export_10bit gate).
        cmd.args([
            "-vf",
            "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
        ]);
        for arg in super::video_encode_args(&encoder, args.bitrate, args.cbr, args.gop) {
            cmd.arg(arg);
        }
        for arg in super::hwencoder::tenbit_encode_args(&encoder) {
            cmd.arg(arg);
        }
        cmd.args([
            "-colorspace", "bt709", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-color_range", "tv",
        ]);
        for arg in super::hvc1_tag_args(codec, std::path::Path::new(&args.output_path)) {
            cmd.arg(arg);
        }
        cmd.arg(&args.output_path);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
        stdin_opt = child.stdin.take();
        stderr_temp = child.stderr.take();
        child_opt = Some(child);
    }

    let shared = Arc::new(SinkShared {
        child: Mutex::new(child_opt),
        stdin: Mutex::new(stdin_opt),
        t0: Instant::now(),
        ipc_bytes: AtomicU64::new(0),
        ipc_frames: AtomicU64::new(0),
        stderr_tail: Mutex::new(String::new()),
    });

    if let Some(stderr) = stderr_temp {
        let shared_for_thread = shared.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut buf = shared_for_thread.stderr_tail.lock().unwrap();
                buf.push_str(&line);
                buf.push('\n');
                if buf.len() > 8192 {
                    let excess = buf.len() - 8192;
                    let drain_to = buf[..excess + 128]
                        .find('\n')
                        .map(|p| p + 1)
                        .unwrap_or(excess);
                    buf.drain(..drain_to);
                }
            }
        });
    }

    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        // Race: another concurrent start won. Tear down ours.
        drop(guard);
        abort_child(&shared);
        drop(shared.stdin.lock().unwrap().take());
        return Err("video sink already active".into());
    }
    *guard = Some(ActiveSink { shared });
    info!("video sink started (ipc, output={})", !args.output_path.is_empty());
    Ok(())
}

/// Write one raw yuv420p10le frame to the active sink's ffmpeg stdin (None =>
/// byte-count only) and bump the counters reported by finish. The blocking pipe
/// write runs on a blocking thread; awaiting it is the renderer's backpressure.
pub async fn video_sink_write(state: &VideoSinkState, data: Vec<u8>) -> Result<(), String> {
    let shared = {
        let guard = state.0.lock().unwrap();
        let sink = guard.as_ref().ok_or("no active video sink")?;
        sink.shared.clone()
    };
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        {
            let mut stdin = shared.stdin.lock().unwrap();
            if let Some(s) = stdin.as_mut() {
                s.write_all(&data)
                    .map_err(|e| format!("ffmpeg stdin: {e}{}", tail_suffix(&shared)))?;
            }
        }
        shared.ipc_bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
        shared.ipc_frames.fetch_add(1, Ordering::Relaxed);
        Ok(())
    })
    .await
    .map_err(|e| format!("write join: {e}"))?
}

/// Finalize: drop stdin (EOF → ffmpeg finalizes), reap the child directly, and
/// return the IPC counters. No WS thread to join.
pub async fn export_video_sink_finish(state: &VideoSinkState) -> Result<SinkStats, String> {
    let shared = {
        let mut guard = state.0.lock().unwrap();
        guard.take().ok_or("no active video sink")?.shared
    };
    drop(shared.stdin.lock().unwrap().take());
    let shared_for_wait = shared.clone();
    let status = tokio::task::spawn_blocking(move || -> Result<Option<std::process::ExitStatus>, String> {
        let child = shared_for_wait.child.lock().unwrap().take();
        match child {
            Some(mut c) => c.wait().map(Some).map_err(|e| format!("ffmpeg wait: {e}")),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("finish join: {e}"))??;
    if let Some(st) = status {
        if !st.success() {
            return Err(format!("ffmpeg exited {st}{}", tail_suffix(&shared)));
        }
    }
    Ok(SinkStats {
        bytes: shared.ipc_bytes.load(Ordering::Relaxed),
        frames: shared.ipc_frames.load(Ordering::Relaxed),
        elapsed_ms: shared.t0.elapsed().as_millis() as u64,
    })
}

pub async fn export_video_sink_cancel(state: &VideoSinkState) -> Result<(), String> {
    let sink = state.0.lock().unwrap().take();
    if let Some(sink) = sink {
        // Kill first (breaks the pipe so any blocked write unblocks), then drop stdin.
        abort_child(&sink.shared);
        drop(sink.shared.stdin.lock().unwrap().take());
        warn!("video sink cancelled");
    }
    Ok(())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib --features jobs,export videosink 2>&1 | tail -20`
Expected: PASS — `reclaim_clears_orphaned_sink`, `reclaim_is_a_noop_when_no_sink_is_active`, `ipc_write_counts_and_finish_reaps` (frames=5, bytes=61440, sink cleared). If the build errors on an unused import (e.g. `now_ms` was removed), delete the dead item it names.

- [ ] **Step 5: Remove the `tungstenite` dependency (verify first)**

Run: `grep -rn "tungstenite" src-tauri/src` — expected: NO matches (the only user was `run_ws_sink`, now deleted). If there ARE matches outside videosink.rs, SKIP this step and report it. If clean, remove the `tungstenite` line from `src-tauri/Cargo.toml`'s `[dependencies]`.

- [ ] **Step 6: Re-run the full Rust suite**

Run: `cd src-tauri && cargo test --lib --features jobs,export 2>&1 | tail -15`
Expected: PASS (all tests; the build confirms `tungstenite` removal didn't break anything).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/export/videosink.rs src-tauri/Cargo.toml
git commit -m "feat(export): IPC-only video sink, delete loopback WebSocket server" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Renderer — remove videoSink threading + WS client, rewire the IPC write

**Files:**
- Modify: `src/ipc/index.ts`, `src/electron-compat/tauri-core.ts`, `src/App.tsx`, `src/render/worker/exportWorker.ts`, `src/render/worker/protocol.ts`, `src/render/worker/runExport.ts`, `src/render/PixiPreview.tsx`, `src/render/PreviewSurface.tsx`, `src/render/pixiPreviewFlag.ts`
- Delete: `src/render/worker/videoSinkClient.ts`, `src/render/worker/videoSinkClient.test.ts`

**Interfaces:**
- Consumes (from Task 1, after `napi:build`): `Backend.exportVideoSinkStart` now returns `null`/void; `exportVideoSinkWrite` unchanged; args have no `mode`.
- Produces: `window.api.videoSinkWrite(bytes)` is the only 10-bit transport; no `videoSink {port,token}` is threaded anywhere.

- [ ] **Step 1: `src/electron-compat/tauri-core.ts` — add `videoSinkWrite` to the `Window.api` type**

In the `declare global { interface Window { api: { … } } }` block, add the method to the `api` shape (alongside `invoke`/`on`/`off`):

```typescript
      videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void>
```

- [ ] **Step 2: `src/ipc/index.ts` — drop `mode`, fix the return type, rewire the write**

Edit the `VideoSinkStartArgs` interface — delete the `mode` line:

```typescript
// DELETE this line from VideoSinkStartArgs:
  mode: "ws";
```

Change `exportVideoSinkStart`'s return type to `void` (body unchanged — start still dispatches; it just returns null now):

```typescript
export function exportVideoSinkStart(args: VideoSinkStartArgs): Promise<void> {
  return invoke("export_video_sink_start", { args });
}
```

Rewire `exportVideoSinkWrite` to the binary channel:

```typescript
export function exportVideoSinkWrite(bytes: Uint8Array): Promise<void> {
  return window.api.videoSinkWrite(bytes);
}
```

- [ ] **Step 3: `src/App.tsx` — drop `mode:"ws"` and the `videoSink` capture/threading**

Replace the start block (the `let videoSink … if (tenBit) { try { videoSink = await exportVideoSinkStart({ mode: "ws", … }) } … }`, ~L1282–1304) with — note `let videoSink` is gone, the result is not captured, and `mode` is dropped:

```typescript
    if (tenBit) {
      try {
        await exportVideoSinkStart({
          width: dims.width,
          height: dims.height,
          fpsNum,
          fpsDen,
          codec: settings.codec,
          bitrate: computeBitrate(settings, dims.width, dims.height, outFps),
          cbr: settings.rateMode === "cbr",
          gop: gopFrames(settings.keyframeIntervalSec, outFps),
          software: settings.hwAccel === "software",
          outputPath: tempVideoPath,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] video sink start failed:", e);
        setExportState({ kind: "error", detail: `Failed to start the 10-bit encoder: ${msg}` });
        return;
      }
    }
```

Update the comment just above it (~L1277-1280) to drop the WebSocket mention, e.g.: `// 10-bit path: start the native-encode video sink (ffmpeg HEVC Main10 / AV1 10-bit, frames streamed over IPC) before the Worker starts. On the 8-bit path the existing fMP4 streaming path is used.`

Remove the `videoSink` spread passed to the export (~L1403):

```typescript
// DELETE this line:
        ...(videoSink ? { videoSink } : {}),
```

(Leave the `exportVideoSinkWrite` call at ~L1384, the `exportVideoSinkCancel` calls at ~L1408/1413, and `exportVideoSinkFinish` at ~L1446 exactly as they are — they are the IPC lifecycle calls.)

- [ ] **Step 4: `src/render/worker/exportWorker.ts` — delete the WS client branch**

Delete the import (L47): `import { VideoSinkClient } from "./videoSinkClient";`

In the 10-bit setup block (~L233-248), delete the `sinkClient` declaration and the `if (req.videoSink) { … VideoSinkClient.connect … }` connect attempt, keeping the `compositeRT` + `pack` creation. The block becomes:

```typescript
  if (tenBit) {
    compositeRT = RenderTexture.create({
      width: req.project.width,
      height: req.project.height,
      format: "rgba16float",
    });
    pack = new PackYuv420p10(app.renderer as WebGLRenderer, outWidth, outHeight);
  }
```

In the per-frame 10-bit branch (~L399-420), replace the `if (sinkClient) { await sinkClient.write(bytes) } else { await postChunk(bytes.slice()) }` with the single IPC path:

```typescript
      if (tenBit) {
        app.renderer.render({ container: app.stage, target: compositeRT! });
        compositeMs += performance.now() - compT0;

        const capT0 = performance.now();
        const bytes = pack!.pack(compositeRT!);
        captureMs += performance.now() - capT0;

        const encT0 = performance.now();
        // 10-bit frames go to the main thread over the chunk/ack channel, which
        // forwards them to export_video_sink_write. Copy because postChunk
        // transfers the buffer and pack() reuses its output.
        await postChunk(bytes.slice());
        encodeMs += performance.now() - encT0;
      } else {
```

Replace the finalization (~L547-551) — the 10-bit branch no longer flushes a client (the main thread calls `exportVideoSinkFinish` after `done`):

```typescript
  if (!tenBit) {
    await encoder!.finalize();
  }
```

In `CleanupArgs` (~L582) delete the `sinkClient: VideoSinkClient | null;` field; in `cleanup()` (~L587-598) delete the `sinkClient,` destructure entry and the `sinkClient?.abort();` line. At each `cleanup({ … })` call site (search the file — ~L305, ~L375, ~L574), delete the `sinkClient,` argument.

- [ ] **Step 5: `src/render/worker/protocol.ts` — drop the `videoSink` start field; fix the chunk comment**

Delete the `videoSink?: { port: number; token: string };` field (~L91) and its 3-line `/// Rust sink endpoint …` comment (~L87-90) from the `start`-request type. Update the `chunk` event comment (~L123-128) to drop the "fallback" framing, e.g.: `/// One sequential slice of the output file (fMP4, append-only) in the 8-bit WebCodecs path, or one raw yuv420p10le frame in the 10-bit native-encode path. The main thread appends fMP4 slices to the temp file and forwards 10-bit frames to export_video_sink_write. Replies with chunk-ack in both cases.`

- [ ] **Step 6: `src/render/worker/runExport.ts` — drop the `videoSink` init field + spread**

Delete the `videoSink?: { port: number; token: string };` field (~L65) and its `/// Native-encode sink connection details …` comment (~L62-64) from the init interface. Delete the spread `...(init.videoSink ? { videoSink: init.videoSink } : {}),` (~L192).

- [ ] **Step 7: `PixiPreview.tsx`, `PreviewSurface.tsx`, `pixiPreviewFlag.ts` — drop the `videoSink` field + spread**

- `src/render/PixiPreview.tsx`: delete the `videoSink?: { port: number; token: string };` field + its comment (~L438-439) from the opts type, and the spread `...(opts.videoSink ? { videoSink: opts.videoSink } : {}),` (~L475).
- `src/render/PreviewSurface.tsx`: delete `videoSink?: { port: number; token: string };` (~L60).
- `src/render/pixiPreviewFlag.ts`: delete `videoSink?: { port: number; token: string };` (~L62).

- [ ] **Step 8: Delete the WS client + its test**

```bash
git rm src/render/worker/videoSinkClient.ts src/render/worker/videoSinkClient.test.ts
```

- [ ] **Step 9: Typecheck + unit tests**

Run: `npm run typecheck` — Expected: clean (no references to a removed `videoSink` field or `VideoSinkClient`). Then run: `npm test` — Expected: all vitest pass, and there is NO `videoSinkClient.test.ts` in the run (it was deleted). If typecheck flags a leftover `videoSink`/`VideoSinkClient` reference, fix that site.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(export): route 10-bit frames over IPC, delete VideoSinkClient + videoSink threading" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Integration gate + remove obsolete scaffolding

**Files:**
- Delete: `e2e/electron/transport_bench.spec.ts`, `e2e/electron/transport_bench_smoke.spec.ts`, `e2e/tools/iso_transport_matrix.e2e.js`, `e2e/tools/iso_video_sink_throughput.e2e.js`

**Interfaces:**
- Consumes: Tasks 1 + 2 complete (Rust IPC-only sink + renderer rewired).

- [ ] **Step 1: Remove the obsolete PoC bench specs (they break once `"ws"`/`"discard"` are gone)**

The PoC bench (`transport_bench.spec.ts`) starts `mode:"ws"`/`"discard"` sinks, which no longer exist; it and the smoke spec served only the GO decision. Verify they aren't referenced anywhere else, then delete:

Run: `grep -rn "transport_bench" e2e playwright.config.ts package.json` — expected: only the spec files themselves. Then:

```bash
git rm e2e/electron/transport_bench.spec.ts e2e/electron/transport_bench_smoke.spec.ts
```

- [ ] **Step 2: Remove the dead Tauri-era wdio transport tools (verify-before-delete)**

These use `window.__TAURI__` (dead under Electron) and only ever benched the WS. Confirm nothing live references them:

Run: `grep -rn "iso_transport_matrix\|iso_video_sink_throughput" e2e package.json wdio.conf.mjs 2>/dev/null` — expected: only the files themselves (no config include). If a config references them, remove that reference too. Then:

```bash
git rm e2e/tools/iso_transport_matrix.e2e.js e2e/tools/iso_video_sink_throughput.e2e.js
```

- [ ] **Step 3: Build the addon + Electron bundle (E2E build)**

Run (PowerShell, from `apps/desktop`): `$env:VITE_WEFTCUT_E2E='1'; npm run napi:build; npm run electron:build`
Expected: both exit 0. `napi:build` picks up Task 1's IPC-only Rust; `electron:build` picks up Task 2's renderer. Use `run_in_background` / max timeout (slow).

- [ ] **Step 4: Run the 10-bit export gate (now exercises the IPC path end-to-end)**

Run (from `apps/desktop`, long timeout): `npx playwright test export_codecs -c playwright.config.ts`
Expected: 3 passed, including the 10-bit HEVC test — `codec_name=hevc`, `pix_fmt` ∈ {yuv420p10le, p010le}, `profile` "Main 10", `color_space/transfer/primaries=bt709`, `color_range=tv`. This proves the production IPC path (App.tsx `mode`-less start → Worker postChunk → `window.api.videoSinkWrite` → IPC-only Rust sink → ffmpeg → finish direct-reap) works end to end.

- [ ] **Step 5: Run the broader export suite for no regressions**

Run (from `apps/desktop`, long timeout): `npx playwright test conformance export_eos_tail export_overlap_same_source s3b-fs -c playwright.config.ts`
Expected: all pass (8-bit conformance, EOS-tail, overlap, fs append — the 8-bit path is untouched).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(export): drop obsolete WS bench/diagnostic specs; 10-bit gate now covers IPC path" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Order matters:** Task 1 (Rust) must be committed before Task 3's `napi:build` (which compiles the new sink). Task 2's typecheck does not need the rebuilt addon (the changed types live in renderer TS), but Task 3's e2e needs BOTH Tasks 1 and 2 built.
- **`finish` with a real ffmpeg child** is only exercised end-to-end by Task 3's `export_codecs` 10-bit test (the Rust unit test covers the `child=None` discard path). If that e2e fails at finalize, check the `finish` reap: stdin must be dropped (EOF) before `child.wait()`.
- **Do not touch the 8-bit path.** The `else` branches (WebCodecs `EncoderSink`, `encoder.finalize()`, fMP4 `writeChunk`→`fs:writeFile`) stay exactly as-is.
- **Single-export invariant:** there is no concurrent write during `finish` — the renderer's `chunk`/`chunk-ack` loop guarantees the last `videoSinkWrite` resolved before `App.tsx` calls `exportVideoSinkFinish`, so dropping stdin in `finish` is safe.
