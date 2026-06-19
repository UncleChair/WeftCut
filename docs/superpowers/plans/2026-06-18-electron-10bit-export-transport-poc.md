# 10-bit Export Transport PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether a native Electron renderer→main IPC transport can carry the 10-bit export's `yuv420p10le` frame stream to ffmpeg as fast as the existing loopback WebSocket, so the Tauri-era WebSocket can be retired.

**Architecture:** Re-add the deleted `export_video_sink_write` napi entry point and an `"ipc"` start mode (the `SinkShared` state + `run_ws_sink` reap branches for the IPC path already exist — only the entry point was removed). Add one Electron IPC channel (`export:videosink_write`). Then a standalone Playwright-for-Electron bench drives the same ffmpeg/NVENC sink through each transport (invoke, WebSocket baseline, optionally MessagePort) and prints a throughput table. The shipping WebSocket production path is never edited.

**Tech Stack:** Rust (napi-rs v3, tokio), Electron 42.4.1 (`ipcMain`/`contextBridge`/`ipcRenderer`), Playwright-for-Electron, ffmpeg (sidecar) + ffprobe on PATH.

## Global Constraints

- Branch / venue: implement in the **`wt1`** worktree (`C:/Users/iClass/Desktop/learning/videtor-wt1`), already fast-forwarded to the migration branch. All paths below are relative to `apps/desktop/` inside that worktree unless noted.
- napi build command (do NOT change features): `napi build --platform --release --manifest-path src-tauri/Cargo.toml --output-dir src-tauri --features jobs,export,mcp,cloud,motifs` (exposed as `npm run napi:build`).
- E2E build requires `VITE_WEFTCUT_E2E=1` set for `npm run electron:build` (inlines the `window.__weftcutTest` hook surface). Full sequence (PowerShell): `cd apps/desktop; $env:VITE_WEFTCUT_E2E='1'; npm run napi:build; npm run electron:build`.
- **Do NOT edit the shipping WebSocket path** (`videoSinkClient.ts`, `exportWorker.ts`, the `"ws"`/`"discard"` branches). The PoC is additive: new `"ipc"` mode + new write entry point + new bench spec only.
- Frame size convention (matches `e2e/tools/iso_transport_matrix.e2e.js`): `yuv420p10le` bytes = `width * height * 3` (2 bytes/sample, 4:2:0). 1080p = `1920*1080*3` = 6,220,800; 4K = `3840*2160*3` = 24,883,200.
- ffprobe must be on PATH (the bench's correctness check shells out to it, same as `export_codecs.spec.ts`).
- Commit message style: conventional commits; end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- `src-tauri/src/export/videosink.rs` — **modify**. Add `"ipc"` to the mode whitelist; gate ffmpeg spawn on `ws || (ipc && output_path != "")`; add `pub async fn video_sink_write(state, data)` (writes to `shared.stdin`, bumps `ipc_*` counters). `finish`/`cancel`/`run_ws_sink` unchanged. Add a `#[tokio::test]`.
- `src-tauri/src/napi_backend.rs` — **modify**. Add `#[napi] pub async fn export_video_sink_write(&self, bytes: Buffer)` (feature-gated) delegating to `videosink::video_sink_write`.
- `electron/main/index.ts` — **modify**. Add `ipcMain.handle('export:videosink_write', …)` → `backend.exportVideoSinkWrite(Buffer.from(ab))`.
- `electron/preload/index.ts` — **modify**. Add `videoSinkWrite(bytes)` to the exposed `api`.
- `e2e/electron/transport_bench.spec.ts` — **create**. Diagnostic bench: drives each transport through the sink, prints the comparison table, ffprobes the encode output. Run manually, not a CI gate.

Each task ends with an independently testable deliverable. Tasks 1–4 answer the core GO/NO-GO (invoke vs WS). Task 5 (MessagePort) is **conditional** on Task 4's result.

---

### Task 1: Rust — re-add the IPC video-sink write path + `"ipc"` start mode

**Files:**
- Modify: `src-tauri/src/export/videosink.rs` (mode whitelist ~L339; ffmpeg-spawn gate ~L353; new `video_sink_write` fn; new test in the existing `#[cfg(test)] mod tests`)
- Modify: `src-tauri/src/napi_backend.rs` (new `#[napi]` method in the `#[napi] impl Backend` block ~L234)

**Interfaces:**
- Produces: `pub async fn video_sink_write(state: &VideoSinkState, data: Vec<u8>) -> Result<(), String>` in `videosink.rs`; `#[napi] pub async fn export_video_sink_write(&self, bytes: napi::bindgen_prelude::Buffer) -> napi::Result<()>` on `Backend` (JS name `exportVideoSinkWrite`).
- Consumes: existing `VideoSinkState` (`pub Mutex<Option<ActiveSink>>`), `ActiveSink.shared: Arc<SinkShared>`, `SinkShared.{stdin, ipc_bytes, ipc_frames, last_write_ms, t0}`.

- [ ] **Step 1: Write the failing Rust test**

Add to the existing `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/export/videosink.rs`:

```rust
    // The "ipc" + empty-output (discard) path: start a sink with no ffmpeg,
    // push frames through the re-added write command, finish, and confirm the
    // SinkStats counters reflect exactly what was written. Exercises the same
    // accept-loop reap branch (I1) the production IPC fallback relied on.
    #[tokio::test]
    async fn ipc_discard_write_counts_bytes_and_frames() {
        let state = VideoSinkState::default();
        let hw = super::super::hwencoder::HwEncoderCache::default();
        let reply = export_video_sink_start(
            &state,
            &hw,
            VideoSinkStartArgs {
                mode: "ipc".into(),
                width: 64,
                height: 64,
                fps_num: 30,
                fps_den: 1,
                codec: "hevc".into(),
                bitrate: 0,
                cbr: false,
                gop: 30,
                software: false,
                output_path: String::new(), // empty => no ffmpeg (discard)
            },
        )
        .await
        .expect("ipc start");
        assert!(reply.port > 0, "sink still binds an (idle) listener in the PoC");

        let frame = vec![7u8; 64 * 64 * 3];
        for _ in 0..5 {
            video_sink_write(&state, frame.clone()).await.expect("write");
        }

        let stats = export_video_sink_finish(&state).await.expect("finish");
        assert_eq!(stats.frames, 5, "five IPC writes => five frames");
        assert_eq!(stats.bytes, 5 * (64 * 64 * 3) as u64, "byte count matches");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/desktop/src-tauri`): `cargo test --lib --features jobs,export ipc_discard_write_counts -- --nocapture`
Expected: FAIL to **compile** — `cannot find function video_sink_write` and the `"ipc"` mode would be rejected by `export_video_sink_start` (unknown sink mode). This confirms the test targets the missing pieces.

- [ ] **Step 3: Accept the `"ipc"` mode and gate the ffmpeg spawn**

In `export_video_sink_start`, replace the mode whitelist (currently L339–341):

```rust
    if args.mode != "discard" && args.mode != "ws" {
        return Err(format!("unknown sink mode {}", args.mode));
    }
```

with:

```rust
    if args.mode != "discard" && args.mode != "ws" && args.mode != "ipc" {
        return Err(format!("unknown sink mode {}", args.mode));
    }
```

Then change the ffmpeg-spawn condition. Currently L353 reads `if args.mode != "discard" {`. Replace that single line with:

```rust
    // Spawn ffmpeg for: "ws" (always), and "ipc" with a real output path.
    // "discard" and "ipc"+empty-path skip ffmpeg (pure transport / byte-count).
    let spawn_ffmpeg = args.mode == "ws" || (args.mode == "ipc" && !args.output_path.is_empty());
    if spawn_ffmpeg {
```

(The `info!` line L450 `mode={}` already logs the mode — leave it.)

- [ ] **Step 4: Add the `video_sink_write` function**

Insert after `export_video_sink_cancel` (after L521), before the `#[cfg(test)]` module:

```rust
/// IPC write path (re-added for the Electron-native transport PoC). Writes one
/// raw `yuv420p10le` frame to the active sink's ffmpeg stdin (None => discard,
/// byte-count only) and bumps the `ipc_*` counters that `run_ws_sink`'s reap
/// branch reports as `SinkStats`. Runs the blocking pipe write on a blocking
/// thread so it never stalls the addon's async executor; awaiting it is the
/// renderer's backpressure.
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
                s.write_all(&data).map_err(|e| format!("ffmpeg stdin: {e}"))?;
            }
        }
        let n = data.len() as u64;
        shared.ipc_bytes.fetch_add(n, Ordering::Relaxed);
        shared.ipc_frames.fetch_add(1, Ordering::Relaxed);
        shared
            .last_write_ms
            .store(shared.t0.elapsed().as_millis() as u64, Ordering::Relaxed);
        Ok(())
    })
    .await
    .map_err(|e| format!("write join: {e}"))?
}
```

- [ ] **Step 5: Add the napi method**

In `src-tauri/src/napi_backend.rs`, inside the `#[napi] impl Backend { … }` block (the same block that holds `invoke` at ~L234), add:

```rust
    /// Stream one raw encoded frame to the active 10-bit video sink over native
    /// IPC (PoC: the Electron-native alternative to the loopback WebSocket).
    /// Binary in, no JSON — bypasses the `invoke` dispatcher.
    #[cfg(feature = "export")]
    #[napi]
    pub async fn export_video_sink_write(
        &self,
        bytes: napi::bindgen_prelude::Buffer,
    ) -> napi::Result<()> {
        crate::export::videosink::video_sink_write(&self.video_sink, bytes.to_vec())
            .await
            .map_err(napi::Error::from_reason)
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run (from `apps/desktop/src-tauri`): `cargo test --lib --features jobs,export ipc_discard_write_counts -- --nocapture`
Expected: PASS (`stats.frames == 5`, `stats.bytes == 60_000`). Also run the existing sink tests to confirm no regression: `cargo test --lib --features jobs,export videosink`
Expected: the two existing `reclaim_*` tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/export/videosink.rs src-tauri/src/napi_backend.rs
git commit -m "feat(export): re-add IPC video-sink write path + ipc start mode (PoC)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Electron — wire the `export:videosink_write` IPC channel

**Files:**
- Modify: `electron/preload/index.ts` (add `videoSinkWrite` to the exposed `api` object, ~L5–40)
- Modify: `electron/main/index.ts` (add an `ipcMain.handle` near the other handlers, e.g. after the `fs:readFile` handler ~L240)

**Interfaces:**
- Consumes: `Backend.exportVideoSinkWrite(bytes)` from Task 1 (regenerated into `@weftcut/core`'s `.d.ts` by `napi:build`).
- Produces: renderer-visible `window.api.videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void>`.

- [ ] **Step 1: Add the preload method**

In `electron/preload/index.ts`, inside the `const api = { … }` object (alongside `invoke`/`on`/`off`/`getPathForFile`), add:

```typescript
  // PoC: stream one raw frame to the native video sink over IPC (the
  // Electron-native alternative to the loopback WebSocket transport).
  videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void> {
    return ipcRenderer.invoke('export:videosink_write', bytes) as Promise<void>
  },
```

- [ ] **Step 2: Add the main-process handler**

In `electron/main/index.ts`, add near the other `ipcMain.handle` calls (after the `fs:readFile` handler at ~L240):

```typescript
  // PoC: native IPC video-sink write. Binary frame in (ArrayBuffer/typed array),
  // forwarded straight to the napi backend's ffmpeg stdin. No JSON.
  ipcMain.handle('export:videosink_write', async (_e, ab: ArrayBuffer | Uint8Array) => {
    const buf = Buffer.isBuffer(ab) ? ab : Buffer.from(ab as ArrayBuffer)
    await backend!.exportVideoSinkWrite(buf)
  })
```

- [ ] **Step 3: Build the addon and the Electron bundle**

Run (PowerShell, from `apps/desktop`): `$env:VITE_WEFTCUT_E2E='1'; npm run napi:build; npm run electron:build`
Expected: both build steps exit 0. `napi:build` regenerates `@weftcut/core` with `exportVideoSinkWrite`; `electron:build` compiles the new main/preload code into `out/`.

- [ ] **Step 4: Smoke-test the channel is reachable**

Create `e2e/electron/transport_bench_smoke.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

test('export:videosink_write channel is exposed and write-without-sink rejects cleanly', async () => {
  const { app, page } = await launchApp()
  try {
    const hasFn = await page.evaluate(
      () => typeof (window as any).api?.videoSinkWrite === 'function',
    )
    expect(hasFn).toBe(true)

    // No active sink => the napi method's "no active video sink" error must
    // surface as a rejected promise, not a crash.
    const rejected = await page.evaluate(async () => {
      try {
        await (window as any).api.videoSinkWrite(new Uint8Array(16))
        return 'resolved'
      } catch (e) {
        return String(e)
      }
    })
    expect(rejected).toContain('no active video sink')
  } finally {
    await app.close()
  }
})
```

- [ ] **Step 5: Run the smoke test**

Run (from `apps/desktop`): `npx playwright test transport_bench_smoke -c playwright.config.ts`
Expected: 1 passed — the method exists and writing with no active sink rejects with `"no active video sink"`.

- [ ] **Step 6: Commit**

```bash
git add electron/preload/index.ts electron/main/index.ts e2e/electron/transport_bench_smoke.spec.ts
git commit -m "feat(export): add export:videosink_write Electron IPC channel (PoC)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Bench harness — invoke transport (discard throughput + encode correctness)

**Files:**
- Create: `e2e/electron/transport_bench.spec.ts`

**Interfaces:**
- Consumes: `launchApp` (`e2e/electron/helpers/driver.ts`); `window.api.invoke('export_video_sink_start'|'export_video_sink_finish', …)`; `window.api.videoSinkWrite(ab)` (Task 2).
- Produces: a `pushInvoke(page, cfg)` measurement returning `{ mbps, ms, stats }`; an ffprobe-validated 10-bit HEVC file for the encode config.

- [ ] **Step 1: Write the bench spec with the invoke transport + correctness assertion**

Create `e2e/electron/transport_bench.spec.ts`:

```typescript
// DIAGNOSTIC bench (not a CI gate): compares 10-bit export frame-transport
// throughput across native Electron IPC vs the loopback WebSocket. Run manually:
//   npx playwright test transport_bench -c playwright.config.ts
// Flip RES to '4k' to stress per-frame copy cost when 1080p can't separate them.
import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { launchApp } from './helpers/driver'

const RES: '1080p' | '4k' = '1080p'
const DIMS = RES === '4k' ? { w: 3840, h: 2160 } : { w: 1920, h: 1080 }
const FRAME_BYTES = DIMS.w * DIMS.h * 3 // yuv420p10le @ 4:2:0
const N_THROUGHPUT = 90 // frames for the discard (transport-only) runs
const N_ENCODE = 30 // frames for the software-encode correctness run

function mbps(bytes: number, ms: number): number {
  return Math.round(bytes / 1048576 / (ms / 1000))
}

function probe(file: string, entries: string): Record<string, string> {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', `stream=${entries}`,
     '-of', 'default=nw=1', file],
    { encoding: 'utf8' },
  )
  if (r.error) throw new Error('ffprobe not on PATH: ' + r.error.message)
  if (r.status !== 0) throw new Error('ffprobe failed: ' + r.stderr)
  const out: Record<string, string> = {}
  for (const line of r.stdout.trim().split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

// Push N synthetic frames through the invoke transport against an already-started
// sink, timed first-send -> all-acked. Runs entirely in the renderer.
async function pushInvoke(page: import('@playwright/test').Page, frameBytes: number, n: number) {
  return page.evaluate(
    async ({ frameBytes, n }) => {
      const api = (window as any).api
      const payload = new Uint8Array(frameBytes)
      for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff
      const t0 = performance.now()
      for (let i = 0; i < n; i++) {
        // Copy per send so the transferred/cloned buffer is independent.
        await api.videoSinkWrite(payload.slice().buffer)
      }
      return { ms: Math.round(performance.now() - t0) }
    },
    { frameBytes, n },
  )
}

const startArgs = (mode: string, outputPath: string, software: boolean) => ({
  mode, width: DIMS.w, height: DIMS.h, fpsNum: 30, fpsDen: 1,
  codec: 'hevc', bitrate: 0, cbr: false, gop: 30, software, outputPath,
})

test.describe('10-bit export transport bench (diagnostic)', () => {
  test.setTimeout(600_000)

  test('invoke transport: discard throughput + software-encode correctness', async () => {
    const { app, page } = await launchApp()
    try {
      // --- A) discard: pure transport throughput (no ffmpeg) ---
      const startA = await page.evaluate(
        (args) => (window as any).api.invoke('export_video_sink_start', { args }),
        startArgs('ipc', '', false),
      )
      expect(startA).toBeTruthy()
      const pa = await pushInvoke(page, FRAME_BYTES, N_THROUGHPUT)
      const finA = await page.evaluate(() =>
        (window as any).api.invoke('export_video_sink_finish'),
      ) as { bytes: number; frames: number; elapsedMs: number }
      expect(finA.frames).toBe(N_THROUGHPUT)
      expect(finA.bytes).toBe(FRAME_BYTES * N_THROUGHPUT)
      const invokeDiscardMbps = mbps(FRAME_BYTES * N_THROUGHPUT, pa.ms)
      console.log(`[bench] invoke/discard ${RES}: ${invokeDiscardMbps} MB/s (send ${pa.ms}ms, ${finA.frames} frames)`)

      // --- B) encode: real software (libx265 Main10) 10-bit file for correctness ---
      const out = path.join(os.tmpdir(), `wc_bench_invoke_${Date.now()}.mp4`)
      const startB = await page.evaluate(
        (args) => (window as any).api.invoke('export_video_sink_start', { args }),
        startArgs('ipc', out, true),
      )
      expect(startB).toBeTruthy()
      const pb = await pushInvoke(page, FRAME_BYTES, N_ENCODE)
      const finB = await page.evaluate(() =>
        (window as any).api.invoke('export_video_sink_finish'),
      ) as { bytes: number; frames: number; elapsedMs: number }
      expect(finB.frames).toBe(N_ENCODE)
      console.log(`[bench] invoke/encode ${RES}: send ${pb.ms}ms, sink ${finB.elapsedMs}ms`)

      // Correctness: the IPC byte path produced a valid 10-bit HEVC file.
      const st = probe(out, 'codec_name,pix_fmt,profile')
      console.log('[bench] invoke/encode output stream:', JSON.stringify(st))
      expect(st.codec_name).toBe('hevc')
      expect(['yuv420p10le', 'p010le']).toContain(st.pix_fmt)
      expect(st.profile).toContain('Main 10')
      fs.rmSync(out, { force: true })
    } finally {
      await app.close()
    }
  })
})
```

- [ ] **Step 2: Run the bench (build first if Task 2's build is stale)**

Run (from `apps/desktop`): `npx playwright test transport_bench -c playwright.config.ts`
Expected: 1 passed. Console shows `[bench] invoke/discard 1080p: <N> MB/s …` and the encode output stream with `codec_name=hevc`, `pix_fmt=yuv420p10le` (or `p010le`), `profile … Main 10`.

- [ ] **Step 3: Record the invoke/discard number**

Note the printed `invoke/discard` MB/s — this is the IPC transport's raw throughput, the figure Task 4 compares against the WebSocket baseline.

- [ ] **Step 4: Commit**

```bash
git add e2e/electron/transport_bench.spec.ts
git commit -m "test(export): transport bench — invoke transport + 10-bit correctness (PoC)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: WebSocket baseline + comparison table + GO/NO-GO

**Files:**
- Modify: `e2e/electron/transport_bench.spec.ts` (add a WS-baseline push + a second test that prints the comparison)

**Interfaces:**
- Consumes: `export_video_sink_start` with `mode:"discard"` (returns `{ port, token }`); a renderer-side `WebSocket`.
- Produces: a `pushWs(page, port, token, frameBytes, n)` measurement; a printed `invoke vs WS` table and a GO/NO-GO line.

- [ ] **Step 1: Add the WebSocket push helper**

Add to `e2e/electron/transport_bench.spec.ts` (after `pushInvoke`):

```typescript
// Push N frames over a loopback WebSocket against a discard-mode sink, timed
// first-send -> bufferedAmount==0. Mirrors the shipping VideoSinkClient protocol
// (token text frame first, then binary frames, close 1000).
async function pushWs(
  page: import('@playwright/test').Page,
  port: number, token: string, frameBytes: number, n: number,
) {
  return page.evaluate(
    async ({ port, token, frameBytes, n }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.binaryType = 'arraybuffer'
      await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws connect')) })
      ws.send(token)
      const payload = new Uint8Array(frameBytes)
      for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff
      const HIGH_WATER = 32 * 1024 * 1024
      const t0 = performance.now()
      for (let i = 0; i < n; i++) {
        while (ws.bufferedAmount > HIGH_WATER) await new Promise((r) => setTimeout(r, 2))
        ws.send(payload)
      }
      while (ws.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 2))
      const ms = Math.round(performance.now() - t0)
      ws.close(1000)
      return { ms }
    },
    { port, token, frameBytes, n },
  )
}
```

- [ ] **Step 2: Add the comparison test**

Add this test inside the `describe` block in `e2e/electron/transport_bench.spec.ts`:

```typescript
  test('compare: invoke vs WebSocket (discard throughput)', async () => {
    const { app, page } = await launchApp()
    try {
      // invoke/discard
      await page.evaluate((args) => (window as any).api.invoke('export_video_sink_start', { args }), startArgs('ipc', '', false))
      const invoke = await pushInvoke(page, FRAME_BYTES, N_THROUGHPUT)
      const invokeFin = await page.evaluate(() => (window as any).api.invoke('export_video_sink_finish')) as { frames: number }
      expect(invokeFin.frames).toBe(N_THROUGHPUT)
      const invokeMbps = mbps(FRAME_BYTES * N_THROUGHPUT, invoke.ms)

      // WS/discard (existing "discard" mode = WS transport, no ffmpeg)
      const wsStart = await page.evaluate((args) => (window as any).api.invoke('export_video_sink_start', { args }), startArgs('discard', '', false)) as { port: number; token: string }
      const ws = await pushWs(page, wsStart.port, wsStart.token, FRAME_BYTES, N_THROUGHPUT)
      const wsFin = await page.evaluate(() => (window as any).api.invoke('export_video_sink_finish')) as { frames: number }
      expect(wsFin.frames).toBe(N_THROUGHPUT)
      const wsMbps = mbps(FRAME_BYTES * N_THROUGHPUT, ws.ms)

      const ratio = (invokeMbps / wsMbps).toFixed(2)
      console.log('\n===== 10-bit transport bench (' + RES + ', ' + N_THROUGHPUT + ' frames, ' + (FRAME_BYTES / 1048576).toFixed(1) + ' MB/frame) =====')
      console.log('  invoke (ipc) : ' + invokeMbps + ' MB/s  (' + invoke.ms + ' ms)')
      console.log('  websocket    : ' + wsMbps + ' MB/s  (' + ws.ms + ' ms)')
      console.log('  invoke/WS    : ' + ratio + '×')
      const floorFps = invokeMbps / (FRAME_BYTES / 1048576)
      console.log('  invoke supports ~' + Math.round(floorFps) + ' fps @ ' + RES)
      console.log('  GO if invoke >= WS or invoke >= offline need (~' + Math.round(wsMbps / (FRAME_BYTES / 1048576)) + ' fps reference)')
      console.log('================================================================\n')
      // Diagnostic only: never fail on the comparison itself.
      expect(invokeMbps).toBeGreaterThan(0)
      expect(wsMbps).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })
```

- [ ] **Step 3: Run the comparison**

Run (from `apps/desktop`): `npx playwright test transport_bench -c playwright.config.ts`
Expected: 2 passed; the console prints the comparison block with invoke MB/s, WS MB/s, the ratio, and the GO/NO-GO reference line.

- [ ] **Step 4: Decide 4K and record the verdict**

If `invoke/WS` ≥ ~1.0 at 1080p → **GO**: invoke is the recommended transport; Task 5 is not needed. If the two are within ~10% (can't separate them) OR invoke < WS, flip `const RES` to `'4k'`, rerun Step 3, and record both rows. Write the verdict (numbers + GO/NO-GO + chosen transport) into `apps/desktop/electron/S3b-NOTES.md` under a new `## PoC: native IPC transport (2026-06-18)` heading.

- [ ] **Step 5: Commit**

```bash
git add e2e/electron/transport_bench.spec.ts apps/desktop/electron/S3b-NOTES.md
git commit -m "test(export): WS-baseline comparison + verdict for transport bench (PoC)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5 (CONDITIONAL): MessagePort transport

**Run this task ONLY if Task 4 showed `invoke` below the WebSocket baseline (or below the offline-export need) at both 1080p and 4K.** If invoke met the bar, the PoC is GO on invoke and MessagePort is unnecessary (YAGNI) — skip to Execution Handoff.

**Files:**
- Modify: `electron/main/index.ts` (create a `MessageChannelMain`, hand `port2` to the renderer on demand, drain `port1` to `backend.exportVideoSinkWrite`)
- Modify: `electron/preload/index.ts` (expose `onVideoSinkPort(cb)` to receive the transferred port)
- Modify: `e2e/electron/transport_bench.spec.ts` (add a `pushPort` measurement + a third row)

**Interfaces:**
- Consumes: `Backend.exportVideoSinkWrite` (Task 1); Electron `MessageChannelMain`/`MessagePortMain`.
- Produces: renderer `window.api.requestVideoSinkPort(): Promise<MessagePort>`; a `pushPort(page, …)` measurement.

- [ ] **Step 1: Main — create the channel and drain it to the backend**

In `electron/main/index.ts`, add (near the other handlers; requires `import { MessageChannelMain } from 'electron'` at the top):

```typescript
  // PoC transport (3): a dedicated MessagePort the renderer transfers frames
  // over, drained here to the napi backend. Bounded by an ack per frame so the
  // renderer can apply backpressure without per-frame ipcRenderer.invoke.
  ipcMain.on('export:request_videosink_port', (e) => {
    const { port1, port2 } = new MessageChannelMain()
    port1.on('message', async (ev) => {
      const ab = ev.data as ArrayBuffer
      try {
        await backend!.exportVideoSinkWrite(Buffer.from(ab))
        port1.postMessage({ ok: true })
      } catch (err) {
        port1.postMessage({ ok: false, error: String(err) })
      }
    })
    port1.start()
    e.sender.postMessage('export:videosink_port', null, [port2])
  })
```

- [ ] **Step 2: Preload — expose port retrieval**

In `electron/preload/index.ts`, add to the `api` object:

```typescript
  // PoC transport (3): request a MessagePort wired to the backend video sink.
  requestVideoSinkPort(): Promise<MessagePort> {
    return new Promise((resolve) => {
      ipcRenderer.once('export:videosink_port', (e) => resolve(e.ports[0]))
      ipcRenderer.send('export:request_videosink_port')
    })
  },
```

- [ ] **Step 3: Bench — add the MessagePort push + run**

Add to `e2e/electron/transport_bench.spec.ts`:

```typescript
async function pushPort(page: import('@playwright/test').Page, frameBytes: number, n: number) {
  return page.evaluate(
    async ({ frameBytes, n }) => {
      const port: MessagePort = await (window as any).api.requestVideoSinkPort()
      port.start()
      const payload = new Uint8Array(frameBytes)
      for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff
      const t0 = performance.now()
      for (let i = 0; i < n; i++) {
        const ab = payload.slice().buffer
        await new Promise<void>((res, rej) => {
          port.onmessage = (ev) => (ev.data?.ok ? res() : rej(new Error(ev.data?.error || 'port write')))
          port.postMessage(ab, [ab])
        })
      }
      return { ms: Math.round(performance.now() - t0) }
    },
    { frameBytes, n },
  )
}
```

Add a row to the comparison test (after the WS row), reusing the discard sink:

```typescript
      await page.evaluate((args) => (window as any).api.invoke('export_video_sink_start', { args }), startArgs('ipc', '', false))
      const portRun = await pushPort(page, FRAME_BYTES, N_THROUGHPUT)
      const portFin = await page.evaluate(() => (window as any).api.invoke('export_video_sink_finish')) as { frames: number }
      expect(portFin.frames).toBe(N_THROUGHPUT)
      const portMbps = mbps(FRAME_BYTES * N_THROUGHPUT, portRun.ms)
      console.log('  messageport  : ' + portMbps + ' MB/s  (' + portRun.ms + ' ms)')
```

- [ ] **Step 4: Build, run, record**

Run (PowerShell, from `apps/desktop`): `$env:VITE_WEFTCUT_E2E='1'; npm run electron:build; npx playwright test transport_bench -c playwright.config.ts`
Expected: the comparison block now includes a `messageport` row. Append the MessagePort number to the S3b-NOTES verdict and finalize the GO/NO-GO (chosen transport = whichever ≥ WS with the least machinery).

- [ ] **Step 5: Commit**

```bash
git add electron/main/index.ts electron/preload/index.ts e2e/electron/transport_bench.spec.ts apps/desktop/electron/S3b-NOTES.md
git commit -m "test(export): MessagePort transport row for transport bench (PoC)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **PoC shortcut (intentional):** the `"ipc"` mode still binds an idle `127.0.0.1:0` listener and spawns `run_ws_sink`, which sits in its accept-loop until `finish()` signals `finishing` (its I1 branch then reaps using the `ipc_*` counters). This reuses the existing reap/teardown logic unchanged. Removing the WS thread entirely belongs to the production swap (out of scope for the PoC).
- **Backpressure semantics differ by transport:** `invoke` and the MessagePort+ack scheme both await each frame (true backpressure); the WS baseline uses `bufferedAmount` high-water (matches the shipping `VideoSinkClient`). The comparison is fair for the discard runs (all bounded, no ffmpeg).
- **If `cargo test` can't construct `HwEncoderCache::default()`** (no `Default`), the `"ipc"`+empty-path test never reaches encoder selection, so pass any cheap constructor the type offers; the discard path skips `hw` entirely.
- **Do not promote the bench into the CI gate set.** It's diagnostic and HW/throughput-dependent. The smoke spec from Task 2 is safe to keep as a gate (it only checks the channel exists + rejects cleanly).
