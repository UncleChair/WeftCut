# decode-bench Stage 2 — Native GPU Decode Path (measure-first slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the minimum native-ffmpeg D3D11 GPU-decode + shared-texture preview path so decode-bench's `strategy:'native'` cells produce real numbers across the full matrix, without changing the shipping WebCodecs path.

**Architecture:** A new Windows-gated Rust module (`apps/desktop/native/src/preview_gpu/`) lifts the proven poc core (`poc/shared-texture-import` branch) — d3d11va decode → GPU→GPU `CopySubresourceRegion` into a pool of shared NV12 textures — and adds seek + PTS + a per-session decode thread. The addon (already loaded in the **main** process) exposes `preview_gpu_*` napi commands and emits `frameReady` pokes through its existing event channel. Main-process glue does the Electron `sharedTexture` import/send (once per pool slot, persistent) and relays pokes. A renderer `NativeGpuSourceHandle implements DecoderHandle` receives frames, snapshots each to an `ImageBitmap`, and pushes into the **existing `FrameRing`** — joining the pipeline at the exact point the WebCodecs path does. `SourceDecoderPool.acquire()` gains a `forceStrategy` E2E gate that mints it; `decodeBench.ts` drives it.

**Tech Stack:** Rust (ffmpeg-next 8.1 library bindings, windows-rs 0.58 D3D11/DXGI, napi-rs 3), Electron `sharedTexture` module (main + renderer), TypeScript (renderer decoder pool, main IPC glue, preload bridge), Playwright `_electron` (decode-bench orchestrator, local-only).

## Global Constraints

- **Platform: Windows-only.** All native GPU-decode code is `#[cfg(all(windows, feature = "preview-gpu"))]`; non-Windows / feature-off builds exclude the module and its deps entirely.
- **New cargo feature `preview-gpu`** gates the `ffmpeg-next` + `windows` deps. It is **NOT** in the CI feature-union (`jobs,export,mcp,cloud`) — GPU decode is meaningless on headless CI and CI has no `FFMPEG_DIR`/`LIBCLANG_PATH`. Local `napi:build` for the bench turns it on additively.
- **Build env (local, this machine has them):** `FFMPEG_DIR` + `LIBCLANG_PATH` must be set for the `preview-gpu` build (see `reference_ffmpeg_next_windows_setup`). ffmpeg-next `8.1` matches the machine's Gyan.FFmpeg.Shared 8.1.1.
- **8-bit only.** P010 (10-bit) shared-texture import yields a null/black frame (Result 7); no 10-bit native cell. `hi10p` stays a WebCodecs-only reference row.
- **Renderer is sandboxed** (`contextIsolation:true, nodeIntegration:false, sandbox:true`). Every renderer↔main call crosses the preload `contextBridge` (`window.api.*`); the renderer cannot `require('electron')`.
- **Preview-only; export untouched.** The native path decodes the **original** `media.path`; the proxy still builds in the background for export.
- **E2E-gated.** `forceStrategy` and the bench driver are inert unless `import.meta.env.VITE_WEFTCUT_E2E === "1"`.
- **Persistent-import transport is mandatory** (Result 4): import + send each pool slot exactly once; per-frame IPC is only `frameReady` + `consume-ack` pokes. A per-frame `sendSharedTexture` model would measure the stale ~53–75 fps IPC bound Result 4 eliminated.
- **Reference docs (read before coding):** `poc/shared-texture/INTEGRATION-DESIGN.md` and `FINDINGS.md` (on branch `poc/shared-texture-import`); `docs/superpowers/specs/2026-07-03-decode-bench-stage2-native-path-design.md`; `docs/superpowers/specs/2026-07-03-decode-bench-design.md`; `docs/decode-bench.md`.
- **Commit discipline:** frequent commits, one per task. Do not push (user's local-merge pattern). Stage by explicit path (`git add -- <path>`), never `git add -A`.

---

## Phase 0 — De-risk (gates everything)

### Task 1: Sandbox shared-texture transport spike

**Purpose:** Resolve — before building anything on top of it — exactly how a native shared-texture frame reaches the **sandboxed** renderer's main world, and whether a usable `VideoFrame`/`ImageBitmap` results. This is the #1 integration risk. The payload is the poc's *synthetic* NV12 texture (no decode), so this isolates the Electron transport from ffmpeg.

**This is a spike, not production code.** Its deliverable is (a) a working end-to-end synthetic-texture display in the real sandboxed app, and (b) a short written record of the resolved receiver mechanism that Phase 3 consumes. If the sandboxed renderer cannot receive the frame at all, **STOP and escalate** — the renderer-side design (and possibly a dedicated non-sandboxed preview surface) must be reconsidered before proceeding.

**Files:**
- Create (temporary, spike-only): `apps/desktop/native/src/preview_gpu/spike.rs` (or reuse poc `poc_create_synthetic_texture` lifted behind the feature).
- Modify (temporary): `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, a temporary renderer entry under `window.__weftcutTest`.
- Reference: `git show poc/shared-texture-import:poc/shared-texture/native/src/lib.rs` (`poc_create_synthetic_texture`, `make_shared_texture`, `pick_adapter`), and the poc's main/renderer harness for the exact `importSharedTexture`/`sendSharedTexture`/`setSharedTextureReceiver` call shapes (`git log poc/shared-texture-import -- poc/shared-texture` for the harness commits).

**Interfaces:**
- Produces (the spike's written output, recorded in the task's commit message and in a scratch note): the resolved answer to each of:
  1. Where is `setSharedTextureReceiver` callable under sandbox — preload isolated world, or main world? What import/global exposes it?
  2. What does the receiver deliver, and how does a `VideoFrame` (from `importedSharedTexture.getVideoFrame()`) get from that context into the renderer main world where `createImageBitmap` + `FrameRing` live? (Candidate answers to test, in order of preference: receiver runs in preload → `createImageBitmap` in preload → transfer the `ImageBitmap` to the main world via a `MessageChannel`/`postMessage` with transfer list, since `contextBridge` cannot clone it; OR the receiver is available directly in the main world.)
  3. Does the `webContents.mainFrame` target deliver to the top frame the renderer runs in?

- [ ] **Step 1: Lift the synthetic-texture producer behind the feature**

Add the `preview-gpu` feature + Windows deps to `apps/desktop/native/Cargo.toml` (full manifest edit is Task 2; for the spike, add just enough to compile). Copy `poc_create_synthetic_texture` + `make_shared_texture` + `pick_adapter` + the `Holder`/`REGISTRY` release path into `native/src/preview_gpu/spike.rs`, gate the module with `#[cfg(all(windows, feature = "preview-gpu"))]`, and expose one `#[napi]` method on `Backend`: `preview_gpu_spike_synthetic(&self, format: String) -> napi::Result<PreviewGpuSlot>` returning `{ handle: Buffer, width: u32, height: u32, pixel_format: String }`.

- [ ] **Step 2: Build with the feature on**

Run: `cd apps/desktop && FFMPEG_DIR="$FFMPEG_DIR" LIBCLANG_PATH="$LIBCLANG_PATH" npx napi build --platform --release --manifest-path native/Cargo.toml --output-dir native --features jobs,export,mcp,cloud,preview-gpu`
Expected: builds; `weftcut.*.node` produced. (Close the running app first — it locks the `.node`; see `reference_napi_build_lock_and_skew`.)

- [ ] **Step 3: Wire main → import + send**

In `src/main/index.ts`, add a temporary `ipcMain.handle('previewGpu:spike', ...)` that calls `backend.preview_gpu_spike_synthetic('nv12')`, then `sharedTexture.importSharedTexture({ textureInfo: { codedSize: { width, height }, handle: { ntHandle: Buffer.from(slot.handle) }, pixelFormat: 'nv12', colorSpace: 'bt709' } })` and `sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture })`. Import the `sharedTexture` module the way the poc harness did (record the exact import path).

- [ ] **Step 4: Wire the receiver per the candidate mechanisms**

Implement the highest-preference candidate from the Interfaces block (preload receiver → `createImageBitmap` → `MessageChannel` transfer to main world). Expose via preload `window.api.previewGpuSpike = { start(): Promise<void>, onBitmap(cb) }` (or whatever the resolved mechanism requires). In a temporary `window.__weftcutTest.previewGpuSpike()` (renderer, behind `VITE_WEFTCUT_E2E`), draw the received `ImageBitmap` to a `<canvas>` and read back the center pixel.

- [ ] **Step 5: Run the real app and verify the synthetic frame arrives**

Run the E2E build and drive the spike hook (see `reference_dev_app_cdp_driving` / the decode-bench orchestrator's launch for the pattern):
`cd apps/desktop && VITE_WEFTCUT_E2E=1 npm run build && <launch _electron> → window.__weftcutTest.previewGpuSpike()`
Expected: the NV12 pattern's two gray bands are visible / the center-pixel readback is the expected luma (≈210 top band). PASS = a shared-texture frame produced in native reached the sandboxed renderer's main world as a usable `ImageBitmap`.

- [ ] **Step 6: Record the mechanism, revert the spike scaffolding, commit the record**

Write the resolved mechanism (answers to the three Interfaces questions) into the task commit message and a scratch note `apps/desktop/e2e/bench-results/.gitkeep`-adjacent doc is NOT appropriate — instead append a short "Sandbox receiver mechanism (Stage 2 spike)" section to `docs/decode-bench.md` under a "Native path internals" heading. Revert the temporary main/preload/renderer scaffolding (keep `preview_gpu/spike.rs` only if Task 2 will reuse `make_shared_texture`; otherwise delete). Keep the Cargo.toml feature addition (Task 2 needs it).

```bash
git add -- apps/desktop/native/Cargo.toml docs/decode-bench.md
git commit -m "docs(decode-bench): record Stage-2 sandbox shared-texture receiver mechanism (spike)"
```

**Checkpoint:** Do not start Phase 1 until the spike PASSES and the receiver mechanism is recorded. The rest of the plan assumes a frame can reach the renderer; if it can't, this plan needs revision.

---

## Phase 1 — Rust GPU-decode module

### Task 2: Feature-gated module scaffold + lifted decode core

**Files:**
- Modify: `apps/desktop/native/Cargo.toml` (deps + feature; started in Task 1)
- Create: `apps/desktop/native/src/preview_gpu/mod.rs`
- Create: `apps/desktop/native/src/preview_gpu/decoder.rs` (lifted from poc)
- Modify: `apps/desktop/native/src/lib.rs` (or wherever modules are declared) — `#[cfg(...)] mod preview_gpu;`

**Interfaces:**
- Produces (for Task 3 & 4): `preview_gpu::decoder::VideoStream` with `open(path: &str) -> Result<VideoStream, String>`, `next_frame(&mut self) -> Result<Option<StreamFrame>, String>`, public fields `width`, `height`, `device`, `device_context`, `lock`, `unlock`, `lock_ctx`; `StreamFrame { src_texture: *mut c_void, src_index: u32 }`. (Verbatim from poc; seek + pts added in Task 3.)

- [ ] **Step 1: Edit `Cargo.toml` — feature + Windows-gated optional deps**

```toml
[features]
default = []
jobs = []
export = ["jobs"]
cloud = ["jobs"]
mcp = []
preview-gpu = ["dep:ffmpeg-next"]   # Windows-only GPU preview decode (decode-bench Stage 2)

[dependencies]
# ...existing...
ffmpeg-next = { version = "8.1", optional = true }   # library bindings; needs FFMPEG_DIR + LIBCLANG_PATH

[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", optional = true, features = [
  "Win32_Foundation", "Win32_Security", "Win32_Graphics_Direct3D",
  "Win32_Graphics_Direct3D11", "Win32_Graphics_Dxgi", "Win32_Graphics_Dxgi_Common",
] }
```
Add `windows` to the `preview-gpu` feature's dep list too: `preview-gpu = ["dep:ffmpeg-next", "dep:windows"]`. (Note: `Direct3D_Fxc` — the shader compiler — is intentionally omitted; `convert.rs` is not lifted.)

- [ ] **Step 2: Copy the poc decode core verbatim**

Run:
```bash
git show poc/shared-texture-import:poc/shared-texture/native/src/decoder.rs > apps/desktop/native/src/preview_gpu/decoder.rs
```
Add `#![cfg(all(windows, feature = "preview-gpu"))]` handling by declaring the module gated in Step 4 (the file itself needs no per-item cfg once the `mod` is gated). Keep `VideoStream`, `StreamFrame`, `D3d11Frame`, `AVD3D11VADeviceContextLayout`, `get_format_d3d11`, `extract_nv12_planes`. Delete the one-shot `decode_first_frame_nv12` / `decode_first_d3d11_frame` if unused by later tasks (Task 3 keeps only `VideoStream`).

- [ ] **Step 3: Create `preview_gpu/mod.rs` with the module doc + re-exports**

```rust
//! Windows-only native GPU decode preview path (decode-bench Stage 2).
//! d3d11va decode -> GPU->GPU copy into a pool of shared NV12 textures ->
//! Electron sharedTexture -> renderer FrameRing. 8-bit only (Result-7 P010 block).
//! Lifted from poc/shared-texture (branch poc/shared-texture-import); see
//! poc/shared-texture/INTEGRATION-DESIGN.md.
pub mod decoder;
mod session;   // Task 4
pub use session::PreviewGpuRegistry;  // Task 4
```
(Comment out `mod session;` / the re-export until Task 4 creates it, so this task compiles.)

- [ ] **Step 4: Gate the module in the crate root**

In `apps/desktop/native/src/lib.rs` (next to the other `mod` declarations):
```rust
#[cfg(all(windows, feature = "preview-gpu"))]
mod preview_gpu;
```

- [ ] **Step 5: Build with the feature to verify the lift compiles**

Run: `cd apps/desktop && FFMPEG_DIR="$FFMPEG_DIR" LIBCLANG_PATH="$LIBCLANG_PATH" cargo build --manifest-path native/Cargo.toml --features preview-gpu`
Expected: compiles (warnings for unused `D3d11Frame` OK). Also run `cargo build --manifest-path native/Cargo.toml` (feature off) — expected: compiles, `preview_gpu` excluded.

- [ ] **Step 6: Commit**

```bash
git add -- apps/desktop/native/Cargo.toml apps/desktop/native/src/preview_gpu/ apps/desktop/native/src/lib.rs
git commit -m "feat(preview-gpu): scaffold Windows-gated module + lift poc d3d11va decode core"
```

---

### Task 3: Add seek + PTS/duration to `VideoStream`

**Why:** The poc decodes sequentially only. `requestFrameAt(tUs)` needs `av_seek_frame` to the keyframe ≤ T then decode-forward, and each delivered frame must carry its PTS (normalized to source-time microseconds, matching the WebCodecs path's `frameToSourceUs`) + duration for `frameReady`/`FrameRing`.

**Files:**
- Modify: `apps/desktop/native/src/preview_gpu/decoder.rs`
- Test: `apps/desktop/native/src/preview_gpu/decoder.rs` (`#[cfg(test)]` module) — a headless unit test of the PTS-normalization math (no GPU); the GPU decode path is exercised by the Task 8 integration test.

**Interfaces:**
- Produces (for Task 4): on `VideoStream` — `seek(&mut self, target_us: i64) -> Result<(), String>`; `StreamFrame` gains `pts_us: i64` (source-normalized) and `dur_us: i64`; `VideoStream` gains `start_pts_us: i64` (container start PTS, read at `open`) and a `time_base` for the video stream. New free fn `pts_to_source_us(pts: i64, time_base: (i32,i32), start_pts_us: i64) -> i64`.

- [ ] **Step 1: Write the failing test for PTS normalization**

```rust
#[cfg(test)]
mod tests {
    use super::pts_to_source_us;
    #[test]
    fn normalizes_pts_by_timebase_and_start() {
        // time_base 1/15360 (common for 30fps mp4), start PTS at frame with pts=1024.
        // pts=1024 -> 1024/15360 s = 66_666us; minus start (66_666) -> 0 (source t=0).
        assert_eq!(pts_to_source_us(1024, (1, 15360), 66_666), 0);
        // next frame pts=1536 -> 100_000us -> minus start -> 33_333us (~1 frame @30fps)
        assert_eq!(pts_to_source_us(1536, (1, 15360), 66_666), 33_333);
    }
}
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && cargo test --manifest-path native/Cargo.toml --features preview-gpu pts_to_source_us`
Expected: FAIL — `pts_to_source_us` not found.

- [ ] **Step 3: Implement `pts_to_source_us` + capture time_base/start_pts at open**

```rust
/// PTS (in stream time_base units) -> source-normalized microseconds.
/// Mirrors the renderer's frameToSourceUs: convert to us via time_base, then
/// subtract the container's first-packet PTS so source t=0 is the visible start.
pub fn pts_to_source_us(pts: i64, time_base: (i32, i32), start_pts_us: i64) -> i64 {
    let (num, den) = (time_base.0 as i128, time_base.1 as i128);
    let us = (pts as i128 * num * 1_000_000 / den) as i64;
    us - start_pts_us
}
```
In `VideoStream::open`, after resolving the stream: read `time_base = (stream.time_base().numerator(), stream.time_base().denominator())`; store it. Read the first packet's PTS for the video stream to compute `start_pts_us` (or `stream.start_time()` × time_base if present; fall back to 0). Store `start_pts_us` + `time_base` as public fields.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/desktop && cargo test --manifest-path native/Cargo.toml --features preview-gpu pts_to_source_us`
Expected: PASS.

- [ ] **Step 5: Add `seek()` + populate `StreamFrame.pts_us/dur_us`**

```rust
impl VideoStream {
    /// Seek to the keyframe at or before target_us, flush the decoder, and
    /// arm forward decode. AVSEEK_FLAG_BACKWARD lands on a key packet <= target.
    pub fn seek(&mut self, target_us: i64) -> Result<(), String> {
        let (num, den) = (self.time_base.0 as i128, self.time_base.1 as i128);
        let ts = ((target_us as i128 + self.start_pts_us as i128) * den
            / (num * 1_000_000)) as i64;
        unsafe {
            let ret = ffs::av_seek_frame(
                self.ictx.as_mut_ptr(), self.stream_index as i32, ts,
                ffs::AVSEEK_FLAG_BACKWARD,
            );
            if ret < 0 { return Err(format!("av_seek_frame failed (ret={ret})")); }
            // Flush decoder buffers so post-seek receive_frame doesn't return
            // pre-seek frames (avcodec_flush_buffers on the raw context).
            ffs::avcodec_flush_buffers(self.decoder.as_mut_ptr());
        }
        self.eof_sent = false;
        Ok(())
    }
}
```
In `next_frame`, after a successful `receive_frame`, read `let pts = (*p).pts` (fallback `(*p).best_effort_timestamp`) and `let dur = (*p).duration`; compute `pts_us = pts_to_source_us(pts, self.time_base, self.start_pts_us)` and `dur_us = pts_to_source_us(dur + start, ...)` — for duration use `dur * num * 1e6 / den` directly (no start subtraction). Add both to `StreamFrame`.

- [ ] **Step 6: Verify compiles + commit**

Run: `cd apps/desktop && cargo build --manifest-path native/Cargo.toml --features preview-gpu`
Expected: compiles.
```bash
git add -- apps/desktop/native/src/preview_gpu/decoder.rs
git commit -m "feat(preview-gpu): add seek + PTS/duration to VideoStream decode loop"
```

---

### Task 4: Per-session decode thread + shared-texture pool + registry

**Why:** Decode must not block the Node main thread (main-process CPU is a benchmark metric, and blocking stalls IPC). Each session owns a dedicated OS thread pinned to its `!Send` D3D11/ffmpeg objects; napi commands post to it; frames emit via a poke. The pool of shared NV12 textures is created on ffmpeg's device (lifted from poc `poc_open_video_stream`).

**Files:**
- Create: `apps/desktop/native/src/preview_gpu/session.rs`
- Modify: `apps/desktop/native/src/preview_gpu/mod.rs` (enable `mod session;`)
- Reference (lift the pool + copy loop): `git show poc/shared-texture-import:poc/shared-texture/native/src/lib.rs` — `poc_open_video_stream` (pool creation), `poc_persist_write_next` (in-place slot overwrite bracketed by keyed mutex + ffmpeg lock), `poc_close_video_stream`, `PoolSlot`, `StreamState`, `pick_adapter`, `DXGI_SHARED_RESOURCE_RW`, `INFINITE`.

**Interfaces:**
- Produces (for Task 5): `PreviewGpuRegistry` with:
  - `open(stream_id, path, pool_size) -> Result<OpenInfo, String>` where `OpenInfo { width: u32, height: u32, slot_handles: Vec<i64> }` (each i64 is the NT handle value; main wraps to Buffer).
  - `request_frame_at(stream_id, target_us: i64)` — sets the session's anchor; the decode thread pumps lookahead, decoding into free slots and emitting `Frameready { slot, pts_us, dur_us }` pokes via the poke sink.
  - `consume_ack(stream_id, slot)` — marks the slot free.
  - `close(stream_id)`.
  - A poke sink: `set_poke_sink(Box<dyn Fn(PreviewGpuPoke) + Send>)` where `PreviewGpuPoke` is an enum `{ FrameReady{stream_id,slot,pts_us,dur_us}, Eof{stream_id}, Error{stream_id,message} }`. (Task 5 wires this to the addon's `on_event` tsfn.)

- [ ] **Step 1: Define the session-thread message protocol + registry skeleton (compiles, no GPU yet)**

```rust
use std::collections::HashMap;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::thread::JoinHandle;

pub enum PreviewGpuPoke {
    FrameReady { stream_id: String, slot: u32, pts_us: i64, dur_us: i64 },
    Eof { stream_id: String },
    Error { stream_id: String, message: String },
}

enum SessionMsg { RequestFrameAt(i64), ConsumeAck(u32), Close }

struct Session { tx: Sender<SessionMsg>, join: Option<JoinHandle<()>>, width: u32, height: u32 }

pub struct PreviewGpuRegistry {
    sessions: Mutex<HashMap<String, Session>>,
    poke: Mutex<Option<Box<dyn Fn(PreviewGpuPoke) + Send>>>,
}
```
Add `new()`, `set_poke_sink`, and stub `open/request_frame_at/consume_ack/close` returning `Err("unimplemented")` where needed so the crate compiles.

- [ ] **Step 2: Implement `open` — spawn the session thread, create the pool, hand back slot handles**

The thread owns `VideoStream::open(path)` + the shared NV12 texture pool (lift the pool-creation block from `poc_open_video_stream`: `pick_adapter` is NOT used — the pool textures are created on **ffmpeg's** device via `ID3D11Device::from_raw_borrowed(&stream.device).clone()`, matching the poc). The thread creates `pool_size` slots, caches their NT handle values, and sends them back to `open()` via a one-shot channel before entering its run loop. Store `Session { tx, join, width, height }`.

Key lifted block (copy from poc `poc_open_video_stream`, adapting names): device/context borrow+clone, `D3D11_TEXTURE2D_DESC` with `DXGI_FORMAT_NV12` + `SHARED_NTHANDLE|SHARED_KEYEDMUTEX`, per-slot `CreateTexture2D` + `CreateSharedHandle`, `PoolSlot { texture, keyed_mutex, handle, free: AtomicBool::new(true) }`.

- [ ] **Step 3: Implement the thread run loop — anchor-driven decode into free slots + pokes**

```
loop {
  match rx.recv():
    RequestFrameAt(t): set anchor = t; if seeking needed (t outside current forward window) -> stream.seek(t)
    ConsumeAck(slot): pool[slot].free = true
    Close: break
  // After handling a message (and opportunistically), pump lookahead:
  while a slot is free AND decoded frontier < anchor + LOOKAHEAD_US AND !eof:
     decoded = stream.next_frame()?  // (skip frames with pts_us < anchor right after a seek)
     copy decoded GPU surface into free slot (keyed-mutex + ffmpeg lock bracket; lift from poc_persist_write_next)
     pool[slot].free = false
     poke(FrameReady { stream_id, slot, pts_us, dur_us })
}
```
Use a `recv_timeout` (e.g. 4 ms) so the pump makes progress between messages without busy-spinning. Emit `Eof`/`Error` pokes as appropriate. **Do not overwrite a slot until its `consume_ack` set `free=true`** — that ack (not the keyed mutex across the async `createImageBitmap` boundary) is the coherence guarantee. Post-seek: decode-and-discard frames whose `pts_us < anchor` until the first `>= anchor`, then deliver.

- [ ] **Step 4: Implement `close` — signal the thread, join, close handles**

`close` sends `SessionMsg::Close`, joins the thread; the thread's teardown closes each slot's NT handle (`CloseHandle`) and drops the `VideoStream` (which unrefs the hw context). Remove the session from the map.

- [ ] **Step 5: Build with feature; commit**

Run: `cd apps/desktop && FFMPEG_DIR="$FFMPEG_DIR" LIBCLANG_PATH="$LIBCLANG_PATH" cargo build --manifest-path native/Cargo.toml --features preview-gpu`
Expected: compiles.
```bash
git add -- apps/desktop/native/src/preview_gpu/
git commit -m "feat(preview-gpu): per-session decode thread + shared NV12 pool + registry"
```

---

### Task 5: napi command surface on `Backend`

**Files:**
- Modify: `apps/desktop/native/src/napi_backend.rs`
- Reference: existing `#[napi]` methods on `Backend` (napi_backend.rs:103–290) for the method style; the `on_event: ThreadsafeFunction<String>` field (line 96) for the poke channel.

**Interfaces:**
- Produces (for Task 6, main-process JS): `#[napi]` methods on `Backend`:
  - `preview_gpu_open(&self, stream_id: String, path: String, pool_size: u32) -> napi::Result<PreviewGpuOpenInfo>` where `#[napi(object)] PreviewGpuOpenInfo { width: u32, height: u32, slots: Vec<PreviewGpuSlot> }`, `#[napi(object)] PreviewGpuSlot { handle: Buffer }` (LE bytes of the NT handle).
  - `preview_gpu_request_frame_at(&self, stream_id: String, target_us: f64) -> napi::Result<()>`
  - `preview_gpu_consume_ack(&self, stream_id: String, slot: u32) -> napi::Result<()>`
  - `preview_gpu_close(&self, stream_id: String) -> napi::Result<()>`
  - Pokes surface via the existing `on_event` tsfn as tagged JSON: `{"kind":"previewGpu:frameReady","streamId":..,"slot":..,"ptsUs":..,"durUs":..}` (+ `previewGpu:eof`, `previewGpu:error`).

- [ ] **Step 1: Hold a `PreviewGpuRegistry` on the Backend + wire its poke sink to `on_event`**

Add a `#[cfg(all(windows, feature = "preview-gpu"))]` field `preview_gpu: preview_gpu::PreviewGpuRegistry` to `Backend`, constructed in `Backend::new`. Set its poke sink to a closure that serializes each `PreviewGpuPoke` to the tagged JSON above and calls the same `on_event` tsfn the Backend already uses (clone the tsfn into the closure). Confirm how `on_event` is invoked elsewhere in the file and match it.

- [ ] **Step 2: Add the four `#[napi]` methods (feature+cfg gated)**

```rust
#[cfg(all(windows, feature = "preview-gpu"))]
#[napi]
pub fn preview_gpu_open(&self, stream_id: String, path: String, pool_size: u32)
    -> napi::Result<PreviewGpuOpenInfo> {
    let info = self.preview_gpu.open(&stream_id, &path, pool_size)
        .map_err(napi::Error::from_reason)?;
    Ok(PreviewGpuOpenInfo {
        width: info.width, height: info.height,
        slots: info.slot_handles.into_iter()
            .map(|h| PreviewGpuSlot { handle: Buffer::from(h.to_le_bytes().to_vec()) })
            .collect(),
    })
}
// request_frame_at / consume_ack / close analogously (delegate to self.preview_gpu.*).
```
Provide a non-Windows / feature-off fallback so JS callers get a clear error rather than a missing method: a `#[cfg(not(all(windows, feature = "preview-gpu")))]` variant of each that returns `Err(napi::Error::from_reason("preview-gpu not built"))`.

- [ ] **Step 3: Build with feature ON and OFF**

Run (on): `cd apps/desktop && FFMPEG_DIR=... LIBCLANG_PATH=... npx napi build --platform --release --manifest-path native/Cargo.toml --output-dir native --features jobs,export,mcp,cloud,preview-gpu`
Run (off): `cd apps/desktop && npx napi build --platform --release --manifest-path native/Cargo.toml --output-dir native --features jobs,export,mcp,cloud`
Expected: both build; the generated `native/index.d.ts` shows `previewGpuOpen` etc. only in the on-build (or as always-present with the fallback). Note which — Task 6's TS types depend on it.

- [ ] **Step 4: Commit**

```bash
git add -- apps/desktop/native/src/napi_backend.rs apps/desktop/native/index.d.ts apps/desktop/native/index.js
git commit -m "feat(preview-gpu): napi command surface (open/requestFrameAt/consumeAck/close) + poke events"
```

---

## Phase 2 — Main-process transport glue

### Task 6: Main-process shared-texture session manager

**Files:**
- Create: `apps/desktop/src/main/previewGpu.ts`
- Modify: `apps/desktop/src/main/index.ts` (register ipcMain handlers + route `previewGpu:*` pokes to the renderer)
- Reference: `src/main/index.ts:158` (`new Backend`), `:370` (`backend:invoke` handler), the `on_event` callback wiring (where the Backend's events are forwarded to the renderer), and the poc harness main code for `importSharedTexture`/`sendSharedTexture` shapes.

**Interfaces:**
- Consumes: `backend.previewGpuOpen/RequestFrameAt/ConsumeAck/Close` (Task 5); the Electron `sharedTexture` module (main); the resolved receiver mechanism (Task 1).
- Produces (for Task 7, via preload in Task 6b): renderer-facing IPC channels — `previewGpu:open` `({streamId, path, poolSize, colorSpace}) -> {width,height,poolSize}`, `previewGpu:requestFrameAt` `({streamId, targetUs})`, `previewGpu:consumeAck` `({streamId, slot})`, `previewGpu:close` `({streamId})`; and a main→renderer push `previewGpu:event` carrying the poke JSON.

- [ ] **Step 1: `previewGpu.ts` — session table + open (import+send each slot once)**

```ts
// Main-process manager for native GPU-decode preview sessions. Owns the
// persistent shared-texture imports (one import+send per pool slot); per-frame
// traffic is only frameReady/consumeAck pokes. Windows-only; the addon methods
// throw "preview-gpu not built" elsewhere.
import { sharedTexture } from "electron"; // exact import path per Task 1 spike
type Imported = /* SharedTextureImported */ unknown;
interface GpuSession { imported: Imported[]; width: number; height: number; }
const sessions = new Map<string, GpuSession>();

export async function openPreviewGpu(
  backend: Backend, frame: WebFrameMain,
  streamId: string, path: string, poolSize: number, colorSpace: string,
): Promise<{ width: number; height: number; poolSize: number }> {
  const info = backend.previewGpuOpen(streamId, path, poolSize);
  const imported = info.slots.map((s) =>
    sharedTexture.importSharedTexture({
      textureInfo: {
        codedSize: { width: info.width, height: info.height },
        handle: { ntHandle: s.handle },
        pixelFormat: "nv12",
        colorSpace, // 'bt709' | 'smpte170m' | ... from the renderer (Task 7 §color)
      },
    }));
  imported.forEach((it) => sharedTexture.sendSharedTexture({ frame, importedSharedTexture: it }));
  sessions.set(streamId, { imported, width: info.width, height: info.height });
  return { width: info.width, height: info.height, poolSize: info.slots.length };
}
```
Add `requestFrameAtPreviewGpu`, `consumeAckPreviewGpu`, `closePreviewGpu` that delegate to the addon; `close` also releases the imports + deletes the session entry.

- [ ] **Step 2: Register ipcMain handlers in `index.ts`**

```ts
ipcMain.handle('previewGpu:open', (e, a) =>
  openPreviewGpu(backend, e.senderFrame, a.streamId, a.path, a.poolSize, a.colorSpace));
ipcMain.handle('previewGpu:requestFrameAt', (_e, a) => requestFrameAtPreviewGpu(backend, a.streamId, a.targetUs));
ipcMain.handle('previewGpu:consumeAck', (_e, a) => consumeAckPreviewGpu(backend, a.streamId, a.slot));
ipcMain.handle('previewGpu:close', (_e, a) => closePreviewGpu(backend, a.streamId));
```

- [ ] **Step 3: Route `previewGpu:*` pokes to the renderer**

In the Backend `on_event` handler (where events are already parsed/forwarded), detect `kind` starting with `previewGpu:` and forward to the focused/main window: `win.webContents.send('previewGpu:event', payload)`. (Match the existing event-forwarding style in `index.ts`.)

- [ ] **Step 4: Typecheck + commit**

Run: `cd apps/desktop && npx tsc -b` (or the project's typecheck script)
Expected: passes (may need a minimal `sharedTexture` type shim if `@types/electron` lacks it — add under `src/main/` as a `.d.ts`).
```bash
git add -- apps/desktop/src/main/previewGpu.ts apps/desktop/src/main/index.ts
git commit -m "feat(preview-gpu): main-process shared-texture session manager + IPC handlers"
```

### Task 6b: Preload bridge + renderer receiver

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Reference: existing `window.api.*` exposures + `window.api.on` (events); the resolved receiver mechanism from Task 1.

**Interfaces:**
- Produces (for Task 7): `window.api.previewGpu = { open(args), requestFrameAt(args), consumeAck(args), close(args) }`; the shared-texture **receiver** exposed per the Task-1 mechanism as `window.api.previewGpu.onFrame(cb: (slot, bitmap) => void)` (or the resolved equivalent that lands an `ImageBitmap` in the renderer main world); and `window.api.on('previewGpu:event', cb)` for pokes.

- [ ] **Step 1: Expose the four command methods over `contextBridge`**

Add to the `window.api` object the four `ipcRenderer.invoke('previewGpu:*', args)` wrappers, following the existing `backend`/`fs`/`window` patterns in the preload.

- [ ] **Step 2: Implement the receiver per Task 1**

Implement whatever Task 1 proved works under sandbox — e.g. register `setSharedTextureReceiver` in preload, `createImageBitmap` the frame in preload, and deliver the `ImageBitmap` (with `slot`) to the renderer main world via the transfer mechanism Task 1 validated. Expose the delivery as `window.api.previewGpu.onFrame`.

- [ ] **Step 3: Typecheck + commit**

Run: `cd apps/desktop && npx tsc -b`
```bash
git add -- apps/desktop/src/preload/index.ts
git commit -m "feat(preview-gpu): preload bridge (commands + sandboxed frame receiver)"
```

---

## Phase 3 — Renderer handle + selection gate + bench wiring

### Task 7: `NativeGpuSourceHandle implements DecoderHandle`

**Files:**
- Create: `apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.ts`
- Reference: `SourceDecoderPool.ts` (`DecoderHandle` interface :98, `SourceHandle.output` snapshot path :363–431, `frameToSourceUs`); `FrameRing.ts` (`push`, `pushCount`, `containsPts`); `scrub.ts` (coalescing pattern).

**Interfaces:**
- Consumes: `window.api.previewGpu` (Task 6b); `FrameRing`; `frameToSourceUs` / `ptsOffset`.
- Produces (for Task 8): `class NativeGpuSourceHandle` with `readonly ring: FrameRing`, `readonly mediaId: string`, `readonly disposed: boolean`, `ensureReady(): Promise<void>`, `requestFrameAt(tUs: number): Promise<void>`, `onFirstFrame(cb)`, `isDowngraded?()`, `dispose()`. Constructor `(layerId, mediaId, sourcePath)`.

- [ ] **Step 1: Write a failing unit test (coalescing + ack round-trip with a mocked bridge)**

```ts
// NativeGpuSourceHandle.test.ts — mock window.api.previewGpu; assert:
// (1) ensureReady() calls previewGpu.open once with poolSize>=2;
// (2) a simulated onFrame(slot,bitmap) pushes to ring with the poke's ptsUs and
//     calls previewGpu.consumeAck(slot);
// (3) requestFrameAt coalesces: 5 rapid calls -> at most 1 in-flight IPC per frame tick.
```
Provide the concrete mock + assertions (mirror `FrameRing.test.ts` / `decodeBench.test.ts` style).

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/NativeGpuSourceHandle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handle**

- `ensureReady`: `await window.api.previewGpu.open({streamId, path, poolSize: 3, colorSpace})`; store `{width,height}`; register `window.api.previewGpu.onFrame((slot, bitmap) => this.onFrame(slot, bitmap))` and `window.api.on('previewGpu:event', ...)` for the poke metadata (map slot→pts). **Color:** derive `colorSpace` from the source's `VideoColorSpaceInit` (same value the WebCodecs path computes via `withDefaultColorSpace`), adapting `fullRange:boolean → 'full'|'limited'` and matrix→Electron string (`bt709`/`smpte170m`/...). For the bench, the fixtures are HD → `bt709` is the correct default; still derive it rather than hardcode.
- `onFrame(slot, bitmap)`: look up the pts/dur for that slot from the last `frameReady` poke; `this.ring.push(bitmap, ptsUs, durUs)`; fire `onFirstFrame` once; `window.api.previewGpu.consumeAck({streamId, slot})`.
- `requestFrameAt(tUs)`: coalesce (trailing, one in-flight) then `window.api.previewGpu.requestFrameAt({streamId, targetUs: tUs})`.
- `dispose`: `window.api.previewGpu.close({streamId})`; `ring.dispose()`; unsubscribe.

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/NativeGpuSourceHandle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.ts apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.test.ts
git commit -m "feat(preview-gpu): NativeGpuSourceHandle (shared-texture -> FrameRing)"
```

### Task 8: `forceStrategy` gate in `acquire()` + bench wiring

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts` (`SourceHandleInit` + `acquire`)
- Modify: `apps/desktop/src/renderer/render/decoder/decodeBench.ts` (drop the guard; pass `forceStrategy`; retype runners)
- Test: `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.test.ts` (new or existing) — gate returns the right handle type.

**Interfaces:**
- Consumes: `NativeGpuSourceHandle` (Task 7).
- Produces: `SourceHandleInit.forceStrategy?: 'webcodecs' | 'native'`; `acquire()` returns `SourceHandle | NativeGpuSourceHandle`; a `sourcePath?: string` on `SourceHandleInit` (native decodes the original path, not the proxy URL).

- [ ] **Step 1: Failing test — native gate**

```ts
// Under a stubbed VITE_WEFTCUT_E2E, acquire({...,forceStrategy:'native',sourcePath})
// returns a NativeGpuSourceHandle; without forceStrategy returns a SourceHandle.
```

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/SourceDecoderPool.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the field + gate**

In `SourceHandleInit` add `forceStrategy?: 'webcodecs' | 'native'` and `sourcePath?: string` (both documented E2E-only). In `acquire`, at the top:
```ts
if (import.meta.env.VITE_WEFTCUT_E2E === "1" && init.forceStrategy === "native") {
  const existing = this.handles.get(init.layerId);
  if (existing) return existing;   // (native handles tracked in the same map; widen the map value type)
  const h = new NativeGpuSourceHandle(init.layerId, init.mediaId, init.sourcePath ?? "");
  // store + return (mirror the SourceHandle bookkeeping; native has no shared SourceMedia)
  return h;
}
```
Widen `acquire`'s return type to `SourceHandle | NativeGpuSourceHandle` and the `handles` map value type accordingly. (The Compositor consumes the result as `DecoderHandle` — Compositor.ts:169 — so widening is safe; verify `tsc -b` stays green.)

- [ ] **Step 4: Run, verify pass; typecheck the Compositor still builds**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/SourceDecoderPool.test.ts && npx tsc -b`
Expected: PASS + typecheck green.

- [ ] **Step 5: Wire `decodeBench.ts`**

- Remove the `if (args.strategy !== "webcodecs")` guard (:203).
- In `mkInit`, when `args.strategy === "native"`, add `forceStrategy: "native"` and `sourcePath: args.sourcePath` (native decodes the original path directly; `proxyAssetUrl` is still passed but unused by the native handle).
- Retype the runner signatures (`runThroughput`/`runSeek`/`waitContains`/`runColdstart`) from `SourceHandle` to `SourceHandle | NativeGpuSourceHandle` (or a local `type BenchHandle = SourceHandle | NativeGpuSourceHandle`). Both expose `ring: FrameRing` (so `ring.pushCount` still resolves), `ensureReady`, `requestFrameAt`.

- [ ] **Step 6: Unit tests + commit**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/` && `npx tsc -b`
Expected: all pass.
```bash
git add -- apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts apps/desktop/src/renderer/render/decoder/SourceDecoderPool.test.ts apps/desktop/src/renderer/render/decoder/decodeBench.ts
git commit -m "feat(decode-bench): forceStrategy native gate in acquire() + bench driver wiring"
```

---

## Phase 4 — Integration verification

### Task 9: Single-fixture native bench (integration smoke)

**Files:**
- No product code (integration exercise). May add a `--fixture hevc-1080 --strategy native` smoke assertion to `apps/desktop/e2e/scripts/decode-bench.mjs` if a hard gate is wanted (optional).

- [ ] **Step 1: Build the E2E app with the feature**

Run:
```bash
cd apps/desktop && \
FFMPEG_DIR=... LIBCLANG_PATH=... npx napi build --platform --release --manifest-path native/Cargo.toml --output-dir native --features jobs,export,mcp,cloud,preview-gpu && \
VITE_WEFTCUT_E2E=1 npm run build
```
Expected: both succeed (close the app first for the `.node` lock).

- [ ] **Step 2: Ensure fixtures exist**

Run: `cd apps/desktop && node e2e/scripts/gen-decode-bench-fixtures.mjs`
Expected: `e2e/fixtures/decode-bench/*.{mp4,webm}` present (idempotent).

- [ ] **Step 3: Run the headline native cell, all scenarios**

Run: `cd apps/desktop && node e2e/scripts/decode-bench.mjs --fixture hevc-1080 --strategy native`
Expected: throughput/seek/coldstart cells produce numbers (no `"not integrated"`); a `frameReady`→`consumeAck` loop sustains; no tearing (frontier PTS strictly advances in throughput).

- [ ] **Step 4: Compare against the WebCodecs cell as a sanity gate**

Run: `cd apps/desktop && node e2e/scripts/decode-bench.mjs --fixture hevc-1080 --strategy webcodecs` and eyeball both reports in `e2e/bench-results/`.
Expected: native produces a plausible fps/×realtime (a real number, not 0 or a hang). This is the acceptance signal for Slice A's core.

- [ ] **Step 5: Commit any harness tweak**

```bash
git add -- apps/desktop/e2e/scripts/decode-bench.mjs
git commit -m "test(decode-bench): native single-fixture integration smoke"
```

### Task 10: Full matrix + `hi10p` unsupported + doc update

**Files:**
- Modify: `apps/desktop/docs/decode-bench.md` (or `docs/decode-bench.md`) — native path "how to run with `--features ...,preview-gpu`", the sandbox receiver note (from Task 1), and the 8-bit-only / `hi10p` unsupported caveat.

- [ ] **Step 1: Run the full matrix, native strategy**

Run: `cd apps/desktop && node e2e/scripts/decode-bench.mjs --strategy native` (all fixtures)
Expected: `h264/hevc-1080/hevc-2160/vp9/av1` native cells yield data; `hi10p` records `unsupported` with the P010 reason (native handle should fail fast on the 10-bit source — verify it records `unsupported`, not a hang; if it hangs, add an explicit 10-bit reject in `NativeGpuSourceHandle.ensureReady` or the Rust `open`).

- [ ] **Step 2: Capture the report + note the H.264 anomaly context**

Confirm the report renders the native column. Cross-check the H.264 baseline anomaly (spec §7): if native H.264 also looks off relative to HEVC/VP9/AV1, note it in the report read-out (do not "fix" the WebCodecs baseline here — that's a separate analysis task).

- [ ] **Step 3: Update `docs/decode-bench.md` (evergreen style — no dates/hashes)**

Add: how to build/run the native strategy (`preview-gpu` feature, `FFMPEG_DIR`/`LIBCLANG_PATH`), the sandbox receiver mechanism (from Task 1), the 8-bit-only scope + `hi10p` unsupported reference row, and that `preview-gpu` is deliberately out of the CI feature-union.

- [ ] **Step 4: Commit**

```bash
git add -- docs/decode-bench.md
git commit -m "docs(decode-bench): native strategy build/run + 8-bit-only scope + sandbox receiver note"
```

---

## Self-Review

**Spec coverage** (`2026-07-03-decode-bench-stage2-native-path-design.md`):
- §1 Slice A items 1–3 → Task 2–5 (Rust), Task 6/6b (main glue), Task 7/8 (renderer + gate). ✓ Deferred set (switch UI, fallback, cap, conformance) → not in any task, matching the spec. ✓
- §2.1 build-system (ffmpeg-next + windows behind `preview-gpu`, out of CI union) → Task 2 Step 1 + Global Constraints. ✓
- §2.2 module shape (lift, drop `convert.rs`, 8-bit only, session registry, napi surface) → Tasks 2,4,5. ✓
- §3.1 persistent-import transport → Task 4 (pool, in-place overwrite, ack gating) + Task 6 (import/send once). ✓
- §3.2 renderer handle (FrameRing join, no union change) → Task 7. ✓
- §3.3 forceStrategy gate → Task 8. ✓
- §4 verification (spike-first, then matrix, hi10p unsupported, color deferred) → Task 1 (spike), Task 9/10. ✓
- §7 H.264 anomaly carried → Task 10 Step 2. ✓

**Placeholder scan:** The Rust D3D11 blocks say "lift from poc `<fn>`" with exact `git show` paths rather than transcribing 900 proven lines — this is deliberate (copy proven code, don't retype), not a placeholder; each such step names the exact source symbols. Task 1's downstream-dependency on the resolved receiver mechanism is a real spike output, not a TODO. No "TBD"/"add error handling"/"similar to Task N" left.

**Type consistency:** `PreviewGpuOpenInfo`/`PreviewGpuSlot` (Task 5) match `OpenInfo`/`slot_handles` (Task 4) via the mapping in Task 5 Step 2. `PreviewGpuPoke` enum (Task 4) ↔ tagged JSON (Task 5) ↔ `previewGpu:event` (Task 6) ↔ `window.api.on` consumer (Task 7). `window.api.previewGpu.{open,requestFrameAt,consumeAck,close,onFrame}` consistent across Tasks 6b/7. `acquire(): SourceHandle | NativeGpuSourceHandle` (Task 8) ↔ `NativeGpuSourceHandle` surface (Task 7) ↔ bench runner retype (Task 8 Step 5). ✓

## Risks & checkpoints

- **Task 1 is a go/no-go gate.** If the sandboxed renderer cannot receive a shared-texture frame into its main world, stop and revisit the renderer design (possibly a dedicated preview surface with different `webPreferences`).
- **`.node` lock:** close the running app before every `napi build` (`reference_napi_build_lock_and_skew`).
- **Feature-union drift:** `preview-gpu` must never enter the 3-OS CI union; only local/bench builds add it.
- **`!Send` D3D11 objects:** all GPU/ffmpeg ops for a session stay on that session's dedicated thread (Task 4); never marshal COM pointers across threads.
