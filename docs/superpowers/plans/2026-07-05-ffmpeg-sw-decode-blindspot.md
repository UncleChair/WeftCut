# ffmpeg SW-decode blind-spot — Phase 1 (ProRes preview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a ProRes file preview directly via native libavcodec **software** decode of the original (no proxy), behind an off-by-default AppSettings toggle — proving the ship-bytes → `VideoFrame` → `FrameRing` path end-to-end for one blind-spot format.

**Architecture:** A new cross-platform Rust `preview_sw` module (mirrors `preview_gpu`'s session-thread/pump/registry, minus all D3D11) decodes the original to CPU frames and `swscale`s them to 8-bit NV12; the session thread delivers each frame `(header + NV12 Buffer)` to the Electron main process via a napi `ThreadsafeFunction`; main relays it to the renderer with `webContents.send` (the fastest channel, per the spike); a new renderer `SwSourceHandle` (implements `DecoderHandle`) does `new VideoFrame(nv12, {format:'NV12', colorSpace})` → `createImageBitmap` → `ring.push`, reusing the entire Compositor/sprite/color-convergence path unchanged. Routing: a new `PreviewSource::NativeFfmpeg` (Rust) + a `native-sw` `DecodeRoute` (TS twin) makes `acquire` pick the software handle when the setting is on.

**Tech Stack:** Rust (napi-rs addon, `ffmpeg-next` 8.1 for in-process decode+swscale, behind a new `preview-sw` cargo feature), TypeScript (Electron main/preload/renderer, Zustand settings), Vitest (renderer unit tests), Node ESM + Playwright `_electron` (decode-bench + media-conformance).

## Global Constraints

- Node **22.20.0** (fnm default); do **not** switch to 24 (breaks Electron packaging).
- New Rust code lives behind a **new cargo feature `preview-sw`** (cross-platform — no `windows` cfg gate, unlike `preview-gpu`). Like `preview-gpu` it stays **OUT** of the CI Rust feature union (`jobs,export,mcp,cloud`) for Phase 1; it is enabled locally and in the `VITE_WEFTCUT_E2E=1` media-conformance build. Every Rust change compiles both with `--features preview-sw` (real impl) and without it (fallback arm returning `Err`).
- Local `preview-sw` build env (same as `preview-gpu`): `FFMPEG_DIR` = the `Gyan.FFmpeg.Shared` `ffmpeg-8.1.1-full_build-shared` dir; `LIBCLANG_PATH` = `C:\Program Files\LLVM\bin`.
- Frame transport is **classic ipc** (`webContents.send`), NOT `MessageChannelMain` — `MessagePortMain` cannot transfer `ArrayBuffer`s and there is no CPU zero-copy across `main`↔`renderer` (measured: `poc/export-frame-transport/FINDINGS.md`). Budget one copy/frame, ~1 GB/s.
- Color = **single model**: ship **YUV (NV12) + a `colorSpace` tag**; never do YUV→RGB on the Rust side. Convergence stays in the existing `VideoClipSprite.drawImage` chokepoint (ADR 0021).
- **Do not** touch the WebCodecs `SourceHandle` decode path, the export worker, or `preview-gpu`.
- napi-rs renames struct fields to camelCase across the boundary: Rust `pts_us` → JS `ptsUs`, `color_matrix` → `colorMatrix`, etc.
- `isIdle(nowMs)` is NOT part of `DecoderHandle` but IS called by the pool sweeper (`SourceDecoderPool.ts:791`) on the handle union — the software handle MUST implement it.
- Spec: `docs/superpowers/specs/2026-07-05-ffmpeg-sw-decode-blindspot-design.md`. Mirror source for Rust decode/session: `apps/desktop/native/src/preview_gpu/decoder.rs` + `session.rs`. Mirror source for the renderer handle: `apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.ts`.

---

### Task 1: Rust `PreviewSource::NativeFfmpeg` route (pure, unit-tested)

**Files:**
- Modify: `apps/desktop/native/src/jobs/proxy_decision.rs` (enum + `decide` + `job_for` + tests)

**Interfaces:**
- Produces: `PreviewSource::NativeFfmpeg` variant; `decide(media, source_gop_secs) -> ProxyRoute` now returns `preview: NativeFfmpeg` for ProRes originals; new helper `codec_is_prores(codec: &str) -> bool`.
- Consumes: `MediaItem.metadata.video: Option<VideoStreamMeta>` with `.codec: String`, `.pix_fmt: String`, `.width/.height: u32` (test builder shape at proxy_decision.rs:224-240); existing helpers `codec_is_h264` (186), `pix_fmt_is_browser_friendly` (199), `source_is_safe_to_bypass` (152).

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)]` module in `proxy_decision.rs` (reuse the existing `video_meta(...)` builder around line 224):

```rust
#[test]
fn prores_original_routes_preview_to_native_ffmpeg() {
    let mut m = media_with_video(video_meta_codec("prores", "yuv422p10le", 3840, 2160));
    let r = decide(&m, Some(0.0)); // intra-frame => gop 0
    assert_eq!(r.preview, PreviewSource::NativeFfmpeg);
    // export cannot use WebCodecs either => must proxy for now (Phase 3 makes it native)
    assert_eq!(r.export, ExportSource::FullProxy);
}

#[test]
fn h264_friendly_still_bypasses_not_native() {
    let m = media_with_video(video_meta_codec("h264", "yuv420p", 1920, 1080));
    let r = decide(&m, Some(0.2));
    assert_eq!(r.preview, PreviewSource::Original);
}
```

If a `video_meta_codec(codec, pix_fmt, w, h)` helper does not already exist, add a thin wrapper over the existing builder that sets those four fields and leaves the rest at the test defaults.

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd apps/desktop/native && cargo test --features preview-sw proxy_decision`
Expected: FAIL — `NativeFfmpeg` variant does not exist / `decide` returns `Original` or `Proxy`.

- [ ] **Step 3: Extend the enum + `decide` + exhaustive matches**

In `proxy_decision.rs`:
- Add the variant (enum at lines 28-35): `pub enum PreviewSource { Original, NativeFfmpeg, Proxy }`.
- Add helper near line 186: `fn codec_is_prores(codec: &str) -> bool { codec.eq_ignore_ascii_case("prores") }`
- In `decide` (63-81), after the `source_is_safe_to_bypass` → `Original` decision and before the `Proxy` fallback, insert: if `media.metadata.video.as_ref().map(|v| codec_is_prores(&v.codec)).unwrap_or(false)` then set `preview = PreviewSource::NativeFfmpeg` and `export = ExportSource::FullProxy` (Phase 1 keeps export on proxy; Phase 3 flips it).
- Update `job_for` (119-128): the `NativeFfmpeg` preview arm still needs a proxy job for export → return the same `ProxyJob` as the `(FullProxy, Proxy)` case; remove/redirect the `unreachable!` so the new `(FullProxy, NativeFfmpeg)` pair is handled.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd apps/desktop/native && cargo test --features preview-sw proxy_decision`
Expected: PASS. Also run without the feature to confirm the pure decision compiles feature-independently: `cargo test proxy_decision`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/jobs/proxy_decision.rs
git commit -m "feat(decode): PreviewSource::NativeFfmpeg route for ProRes originals"
```

---

### Task 2: Rust `preview_sw` cargo feature + module skeleton + software decoder

**Files:**
- Modify: `apps/desktop/native/Cargo.toml` (add `preview-sw` feature)
- Create: `apps/desktop/native/src/preview_sw/mod.rs`
- Create: `apps/desktop/native/src/preview_sw/decoder.rs`
- Modify: `apps/desktop/native/src/lib.rs` (register `#[cfg(feature = "preview-sw")] mod preview_sw;`)

**Interfaces:**
- Produces: `SwVideoStream::open(path: &str) -> Result<SwVideoStream, String>`; `SwVideoStream::next_frame(&mut self) -> Result<Option<SwFrame>, String>`; `SwVideoStream::seek(&mut self, target_us: i64) -> Result<(), String>`; `struct SwFrame { pub nv12: Vec<u8>, pub width: u32, pub height: u32, pub pts_us: i64, pub dur_us: i64, pub color: SwColorTags }`; `struct SwColorTags { pub matrix: Option<String>, pub range: Option<String>, pub primaries: Option<String>, pub transfer: Option<String> }`.
- Consumes: `ffmpeg-next` (already a dep — see `preview_gpu/decoder.rs` imports at lines 7-11).

- [ ] **Step 1: Add the cargo feature**

In `apps/desktop/native/Cargo.toml` `[features]`, add: `preview-sw = []` (ffmpeg-next is already a base dependency; the feature only gates the module).

- [ ] **Step 2: Write the failing decoder test**

Create `apps/desktop/native/src/preview_sw/decoder.rs` with a test at the bottom that decodes the first frame of a committed tiny ProRes fixture (add `apps/desktop/native/tests/fixtures/tiny_prores.mov` — a ~8-frame 320x240 ProRes 422 clip; generate once with `ffmpeg -f lavfi -i testsrc=size=320x240:rate=8:d=1 -c:v prores_ks -profile:v 2 -pix_fmt yuv422p10le tiny_prores.mov`):

```rust
#[cfg(test)]
mod tests {
    use super::SwVideoStream;
    #[test]
    fn decodes_first_prores_frame_to_nv12() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_prores.mov");
        let mut s = SwVideoStream::open(p).expect("open");
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
        // NV12: Y (w*h) + interleaved UV (w*h/2)
        assert_eq!(f.nv12.len(), (320 * 240) + (320 * 240 / 2));
    }
}
```

- [ ] **Step 3: Run it, verify it fails**

Run: `cd apps/desktop/native && cargo test --features preview-sw preview_sw::decoder`
Expected: FAIL — `SwVideoStream` undefined.

- [ ] **Step 4: Implement `SwVideoStream` by mirroring `preview_gpu/decoder.rs`**

Copy the structure of `preview_gpu/decoder.rs`, making these deletions/changes (it is a strict simplification — no new ffmpeg patterns):
- Keep the imports block (decoder.rs:7-11) and `ffmpeg_next::init().ok()`.
- Keep open-input: `let mut ictx = input(&path)?;` → `streams().best(Type::Video)` → `codec::context::Context::from_parameters(stream.parameters())?` → `codec_ctx.decoder().video()?`. **OMIT** the `av_hwdevice_ctx_create(...D3D11VA...)` block (decoder.rs:61-78 / 216-231) and the `get_format_d3d11` callback — a plain software decoder decodes to CPU frames.
- Decode loop: mirror `next_frame` (decoder.rs:455-512) — `decoder.receive_frame`/`send_packet`/`send_eof`; read `pts`, `best_effort_timestamp`, `duration`; normalize with the `pts_to_source_us` helper (decoder.rs:364-368).
- swscale to NV12: mirror `frame_to_nv12` (decoder.rs:119-156): `SwsContext::get(sw.format(), w, h, Pixel::NV12, w, h, Flags::BILINEAR)?; sws.run(sw, &mut nv)?;`.
- Extract planes into a contiguous `Vec<u8>` by mirroring `extract_nv12_planes` (decoder.rs:537-557): copy `nv.data(0)`/`stride(0)` row-by-row into the Y region, `nv.data(1)`/`stride(1)` into the UV region (handle stride != width).
- Color tags: read from the decoder — `decoder.color_space()`, `decoder.color_range()`, `decoder.color_primaries()`, `decoder.color_transfer_characteristic()` — and map each to the FFmpeg string name (`bt709`, `bt470bg`, `smpte170m`, `tv`/`pc`, …) into `SwColorTags`. If unknown, leave `None`.
- `seek(target_us)`: mirror `preview_gpu/decoder.rs` `seek` (516) — `av_seek_frame` + `avcodec_flush_buffers`. ProRes is intra-frame so a single decode after seek yields the target.

Create `preview_sw/mod.rs`: `pub mod decoder; mod session; pub use session::{PreviewSwRegistry, PreviewSwOpenInfo};` (session added in Task 3).

- [ ] **Step 5: Run the test, verify pass**

Run: `cd apps/desktop/native && cargo test --features preview-sw preview_sw::decoder`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/native/Cargo.toml apps/desktop/native/src/preview_sw/ apps/desktop/native/src/lib.rs apps/desktop/native/tests/fixtures/tiny_prores.mov
git commit -m "feat(preview-sw): software ProRes decoder -> NV12 (ffmpeg-next, mirrors preview_gpu/decoder)"
```

---

### Task 3: Rust `preview_sw` session thread + registry

**Files:**
- Create: `apps/desktop/native/src/preview_sw/session.rs`

**Interfaces:**
- Produces: `PreviewSwRegistry { new(), set_frame_sink(Box<dyn Fn(SwFramePoke) + Send>), open(stream_id, path) -> Result<PreviewSwOpenInfo, String>, request_frame_at(stream_id, target_us: i64), close(stream_id) }`; `struct PreviewSwOpenInfo { width: u32, height: u32 }`; `enum SwFramePoke { Frame { stream_id: String, frame: SwFrame }, Eof { stream_id: String }, Error { stream_id: String, message: String } }`.
- Consumes: `super::decoder::{SwVideoStream, SwFrame}` (Task 2).

- [ ] **Step 1: Write a failing integration test (registry decodes + pokes a frame)**

At the bottom of `session.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    #[test]
    fn open_then_request_delivers_a_frame() {
        let got: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke { g2.lock().unwrap().push(frame.width); }
        }));
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_prores.mov");
        let info = reg.open("s1".into(), p.into()).expect("open");
        assert_eq!(info.width, 320);
        reg.request_frame_at("s1".into(), 0);
        std::thread::sleep(std::time::Duration::from_millis(300));
        reg.close("s1".into());
        assert!(!got.lock().unwrap().is_empty(), "expected at least one frame poke");
    }
}
```

- [ ] **Step 2: Run it, verify it fails** — `cargo test --features preview-sw preview_sw::session` → FAIL (undefined).

- [ ] **Step 3: Implement the session by mirroring `preview_gpu/session.rs`**

Mirror the session-thread/registry shape (session.rs:867-980, 934-1056), with these simplifications:
- `PreviewSwRegistry { sessions: Mutex<HashMap<String, Session>>, sink: Arc<Mutex<Option<Box<dyn Fn(SwFramePoke)+Send>>>> }`.
- `open` spawns `thread::Builder::new().name("preview-sw").spawn(move || session_thread(...))`, blocks on an `init_rx.recv()` for `PreviewSwOpenInfo` (mirrors 962-1013).
- `enum SwSessionMsg { RequestFrameAt(i64), Close }` (drop `ConsumeAck` — no slot pool).
- `session_thread`: `SwVideoStream::open(path)` → send `PreviewSwOpenInfo` back; loop `rx.recv_timeout(...)`; on `RequestFrameAt(us)` call `stream.seek(us)` then decode-forward and, for each decoded `SwFrame` up to a small lookahead, call the sink with `SwFramePoke::Frame`. **No D3D11, no slot pool, no keyed mutex, no ack** — the frame bytes ARE the payload.
- `set_frame_sink` stores the boxed closure under the mutex.

- [ ] **Step 4: Run the test, verify pass** — `cargo test --features preview-sw preview_sw::session` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/preview_sw/session.rs apps/desktop/native/src/preview_sw/mod.rs
git commit -m "feat(preview-sw): session thread + registry delivering NV12 frame pokes"
```

---

### Task 4: napi surface `preview_sw_*` + Buffer frame delivery (+ fallback arm)

**Files:**
- Modify: `apps/desktop/native/src/napi_backend.rs` (feature-gated impl block + fallback block + wire the frame sink)

**Interfaces:**
- Produces (napi): `preview_sw_open(&self, stream_id: String, path: String, on_frame: ThreadsafeFunction<PreviewSwFrame>) -> napi::Result<PreviewSwOpenInfoJs>`, `preview_sw_request_frame_at(&self, stream_id: String, target_us: f64)`, `preview_sw_close(&self, stream_id: String)`. Wire structs: `#[napi(object)] struct PreviewSwFrame { stream_id, pts_us, dur_us, width, height, format: String, color_matrix, color_range, color_primaries, color_transfer, data: Buffer }`; `#[napi(object)] struct PreviewSwOpenInfoJs { width: u32, height: u32 }`.
- Consumes: `PreviewSwRegistry` (Task 3). Frame delivery uses a per-stream `ThreadsafeFunction`, NOT the generic `EventSink.emit(name, json)` (json can't carry pixel bytes without base64).

- [ ] **Step 1: Add the `preview_sw` field on `Backend`**

Mirror the `preview_gpu` field (napi_backend.rs:43-44) but cross-platform:
```rust
#[cfg(feature = "preview-sw")]
pub(crate) preview_sw: crate::preview_sw::PreviewSwRegistry,
```
Initialize it in `build_backend` (mirror 83-113): `let preview_sw = crate::preview_sw::PreviewSwRegistry::new();` (no poke→EventSink bridge here — the sink is per-open, wired in `preview_sw_open`).

- [ ] **Step 2: Implement the feature-gated `#[napi] impl Backend` block**

Mirror the `preview_gpu_*` block (napi_backend.rs:476-554). In `preview_sw_open`, install the frame sink so each `SwFramePoke::Frame` calls the `ThreadsafeFunction` with a `PreviewSwFrame` (copy `frame.nv12` into a `Buffer`, `format:"NV12"`, color tags mapped to strings). `preview_sw_request_frame_at` casts `target_us` `f64→i64` and calls the registry; `preview_sw_close` calls the registry. Convert `PreviewSwOpenInfo → PreviewSwOpenInfoJs`.

- [ ] **Step 3: Implement the fallback block (feature off)**

Mirror the fallback (napi_backend.rs:571-603): identical method signatures returning `Err(napi::Error::from_reason("preview-sw not built"))`. (No `windows` cfg — software decode is cross-platform; the only gate is `feature = "preview-sw"`.)

- [ ] **Step 4: Build the addon, verify both configs compile**

Run: `cd apps/desktop && npm run napi:build -- --features preview-sw` (close the running app first — the `.node` is locked; see project note). Then confirm the default build still compiles: `cd native && cargo check` (fallback arm).
Expected: both succeed; `index.d.ts` gains `previewSwOpen`/`previewSwRequestFrameAt`/`previewSwClose` (camelCase).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/napi_backend.rs apps/desktop/index.d.ts
git commit -m "feat(preview-sw): napi surface + ThreadsafeFunction NV12 frame delivery"
```

---

### Task 5: Electron main relay + preload bridge + ipc

**Files:**
- Create: `apps/desktop/src/main/previewSw.ts` (open/request/close manager + frame relay)
- Modify: `apps/desktop/src/main/index.ts` (register ipc handlers — mirror the previewGpu registration)
- Modify: `apps/desktop/src/preload/index.ts` (expose `window.api.previewSw`)
- Modify: `apps/desktop/src/shared/ipc.ts` (types)

**Interfaces:**
- Produces (renderer-visible): `window.api.previewSw.open(args: { streamId: string; path: string }): Promise<{ width: number; height: number }>`, `.requestFrameAt(args: { streamId: string; targetUs: number }): void`, `.close(args: { streamId: string }): void`, `.onFrame(cb: (f: PreviewSwFrameMsg) => void): () => void`. `PreviewSwFrameMsg = { streamId: string; ptsUs: number; durUs: number; width: number; height: number; format: 'NV12'; colorMatrix?: string; colorRange?: string; colorPrimaries?: string; colorTransfer?: string; data: Uint8Array }`.
- Consumes: napi `backend.previewSwOpen(streamId, path, onFrameTsfn)` etc. (Task 4).

- [ ] **Step 1: Implement `main/previewSw.ts`**

`preview_sw_open` takes a `ThreadsafeFunction`; in main, pass a JS callback that does `win.webContents.send('previewSw:frame', frame)` (frame carries the `Buffer` → arrives as `Uint8Array` in the renderer). Keep a `Map<streamId, webContents>` for routing. `requestFrameAt`/`close` are thin passthroughs to the napi methods. Mirror `main/previewGpu.ts` structure.

- [ ] **Step 2: Register ipc handlers + preload bridge**

In `main/index.ts` register `ipcMain.handle('previewSw:open', ...)`, `ipcMain.on('previewSw:requestFrameAt', ...)`, `ipcMain.on('previewSw:close', ...)` (mirror the previewGpu registration site, `main/index.ts:23,444`). In `preload/index.ts` (mirror the `previewGpu` bridge at :177-284) expose `window.api.previewSw` with `open`/`requestFrameAt`/`close` and an `onFrame(cb)` that subscribes to `ipcRenderer.on('previewSw:frame', (_e, f) => cb(f))` and returns an unsubscribe.

- [ ] **Step 3: Type-check**

Run: `cd apps/desktop && npm run typecheck`
Expected: PASS (no test yet — this is plumbing exercised end-to-end in Task 9).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/previewSw.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/shared/ipc.ts
git commit -m "feat(preview-sw): main relay + preload bridge + ipc for NV12 frames"
```

---

### Task 6: TS decode-route `native-sw` variant + resolver threading

**Files:**
- Modify: `apps/desktop/src/shared/decode-route.ts` (variant)
- Modify: `apps/desktop/src/renderer/render/decodeRoute.ts` (resolver + test)
- Modify: `apps/desktop/native/src/state/decode_route.rs` (Rust twin serialization)
- Test: `apps/desktop/src/renderer/render/decodeRoute.test.ts`

**Interfaces:**
- Produces: `DecodeRoute` gains `| { route: "native-sw" }`; `resolveDecode` returns `{ route: "native-sw", previewPath: media.path, exportPath: <full_proxy or null> }` for that variant.
- Consumes: `PreviewSource::NativeFfmpeg` (Task 1) serializes to `{ route: "native-sw" }` via the Rust twin.

- [ ] **Step 1: Write the failing resolver test**

In `decodeRoute.test.ts`:
```ts
it("native-sw previews the original path", () => {
  const r = resolveDecode({ kind: "video", path: "C:/clip.mov", decode_route: { route: "native-sw" } });
  expect(r.previewPath).toBe("C:/clip.mov");
});
```

- [ ] **Step 2: Run it, verify it fails** — `cd apps/desktop && npx vitest run src/renderer/render/decodeRoute.test.ts` → FAIL (type/behavior).

- [ ] **Step 3: Add the variant + resolver arm + Rust twin**

- `decode-route.ts`: add `| { route: "native-sw" }` to the `DecodeRoute` union.
- `decodeRoute.ts` `resolveDecode` (21-39): add an arm returning `{ route: "native-sw", previewPath: media.path, exportPath: null }` (Phase 1: export still proxies — `exportPath` resolved by the existing proxy machinery, not here).
- `native/src/state/decode_route.rs`: add the `NativeFfmpeg → { route: "native-sw" }` (de)serialization so the persisted `PreviewSource::NativeFfmpeg` round-trips to the TS shape.

- [ ] **Step 4: Run the test, verify pass** — `npx vitest run src/renderer/render/decodeRoute.test.ts` → PASS. Also `cargo test --features preview-sw decode_route`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/decode-route.ts apps/desktop/src/renderer/render/decodeRoute.ts apps/desktop/src/renderer/render/decodeRoute.test.ts apps/desktop/native/src/state/decode_route.rs
git commit -m "feat(decode): native-sw DecodeRoute variant + resolver (TS+Rust twin)"
```

---

### Task 7: Renderer `SwSourceHandle` (implements `DecoderHandle`)

**Files:**
- Create: `apps/desktop/src/renderer/render/decoder/SwSourceHandle.ts`
- Test: `apps/desktop/src/renderer/render/decoder/SwSourceHandle.test.ts`

**Interfaces:**
- Produces: `class SwSourceHandle implements DecoderHandle` with `constructor(layerId: string, mediaId: string, sourcePath: string, sourceColor?: VideoColorSpaceInit)`, all `DecoderHandle` members (`mediaId`, `ring: FrameRing`, `disposed`, `ensureReady`, `requestFrameAt`, `onFirstFrame`, `dispose`) plus `isIdle(nowMs: number): boolean`.
- Consumes: `window.api.previewSw.*` (Task 5); `FrameRing.push(bitmap, ptsUs, durationUs)` (FrameRing.ts:94); `frameToSourceUs` helper used by `SourceHandle`.

- [ ] **Step 1: Write the failing test (frame message → ring.push)**

Mirror `NativeGpuSourceHandle.test.ts`. Stub `window.api.previewSw` with an `onFrame` you can trigger manually; assert that feeding a `PreviewSwFrameMsg` results in a `ring.push` with the right `ptsUs`, after a `createImageBitmap` (stub `globalThis.createImageBitmap` and `VideoFrame` to return a sentinel bitmap):

```ts
it("converts an NV12 frame message to a ring bitmap", async () => {
  const h = new SwSourceHandle("L1", "M1", "C:/clip.mov", undefined);
  await h.ensureReady();
  emitFrame({ streamId: h.streamId, ptsUs: 33367, durUs: 33367, width: 4, height: 4, format: "NV12",
              data: new Uint8Array(4 * 4 + 4 * 4 / 2) });
  await flushMicrotasks();
  expect(h.ring.size()).toBe(1);
  expect(h.ring.lastPtsUs()).toBe(33367);
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run src/renderer/render/decoder/SwSourceHandle.test.ts` → FAIL (undefined).

- [ ] **Step 3: Implement by mirroring `NativeGpuSourceHandle.ts`**

Same shape as `NativeGpuSourceHandle` (constructor 132-146, `_doEnsureReady` 174-203, `handlePortMessage` 228-257, `requestFrameAt` 264-271, `dispose` 314-328), except the frame source is the ipc event, not a `MessagePort`:
- `ensureReady`: `const unsub = window.api.previewSw.onFrame((f) => this.handleFrame(f))` (store `unsub`), then `const info = await window.api.previewSw.open({ streamId: this.streamId, path: this.sourcePath })`.
- `handleFrame(f)`: ignore if `f.streamId !== this.streamId`; build the color space from `f.color*` tags via a `deriveColorSpace` helper (mirror NativeGpuSourceHandle.ts:70-77, default BT.709/limited); `const vf = new VideoFrame(f.data, { format: "NV12", codedWidth: f.width, codedHeight: f.height, timestamp: f.ptsUs, colorSpace })`; `const bmp = await createImageBitmap(vf); vf.close();` then `this.ring.push(bmp, f.ptsUs, f.durUs)`; fire the first-frame cb once.
- `requestFrameAt(tUs)`: coalesce (mirror 264-271) → `window.api.previewSw.requestFrameAt({ streamId, targetUs: tUs })`; set `this.lastUseMs = performance.now()`.
- `isIdle(nowMs)`: `return nowMs - this.lastUseMs > IDLE_DISPOSE_MS` (reuse the same constant the pool uses).
- `dispose()`: `this.unsub?.(); window.api.previewSw.close({ streamId }); this.ring.dispose(); this._disposed = true`.

- [ ] **Step 4: Run the test, verify pass** — `npx vitest run src/renderer/render/decoder/SwSourceHandle.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/SwSourceHandle.ts apps/desktop/src/renderer/render/decoder/SwSourceHandle.test.ts
git commit -m "feat(preview-sw): SwSourceHandle — ipc NV12 -> VideoFrame -> ring"
```

---

### Task 8: AppSettings toggle + `acquire` software branch

**Files:**
- Modify: `apps/desktop/src/shared/app-settings.ts` (setting + patch + default)
- Modify: `apps/desktop/src/main/app-settings.ts` (persistence defaulting)
- Modify: `apps/desktop/src/renderer/settings/appSettingsStore.ts` (fallback + selector)
- Modify: `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts` (union widen + branch)
- Test: extend `SourceDecoderPool` tests

**Interfaces:**
- Produces: `AppSettings.experimental_native_sw_decode: boolean` (default `false`); `useNativeSwDecodeEnabled()` selector; `acquire` returns a `SwSourceHandle` when `forceStrategy === "software"`.
- Consumes: `SwSourceHandle` (Task 7); `SourceHandleInit` (SourceDecoderPool.ts:28-82).

- [ ] **Step 1: Write the failing acquire test**

```ts
it("acquire returns a software handle when forceStrategy=software", () => {
  const pool = new SourceDecoderPool(/* deps */);
  const h = pool.acquire({ layerId: "L1", mediaId: "M1", proxyAssetUrl: "x", forceStrategy: "software", sourcePath: "C:/clip.mov" });
  expect(h).toBeInstanceOf(SwSourceHandle);
});
```

- [ ] **Step 2: Run it, verify it fails** — vitest → FAIL (`"software"` not in `forceStrategy` union / no branch).

- [ ] **Step 3: Implement**

- `app-settings.ts`: add `experimental_native_sw_decode: boolean` to `AppSettings` (9-26), `AppSettingsPatch` (32-40), and `APP_SETTINGS_DEFAULTS` (`false`, 42-50).
- `main/app-settings.ts` `read()` (49-57): add `typeof parsed.experimental_native_sw_decode === "boolean" ? parsed.experimental_native_sw_decode : d.experimental_native_sw_decode`.
- `appSettingsStore.ts`: add the `FALLBACK` field (39-47) and `export const useNativeSwDecodeEnabled = () => useAppSettingsStore((s) => s.experimental_native_sw_decode)` (mirror `usePrebakeMotifsEnabled`).
- `SourceDecoderPool.ts`: widen `forceStrategy` (line 72) to `"webcodecs" | "native" | "software"`; widen `handles` map (677) and `acquire` return (693) to include `SwSourceHandle`; add the branch mirroring the native one (694-707): `if (init.forceStrategy === "software") { ... new SwSourceHandle(init.layerId, init.mediaId, init.sourcePath ?? "", init.sourceColor); ... }` (no `VITE_WEFTCUT_E2E` gate — this ships behind the AppSettings toggle instead).

- [ ] **Step 4: Wire the caller to set `forceStrategy: "software"`**

Where `SourceHandleInit` is built for the compositor (the `proxyAssetUrl`/`previewPathLive` call site — `PixiPreview.tsx:124-133` region): when `media.decode_route.route === "native-sw"` AND `useNativeSwDecodeEnabled()` is true, set `forceStrategy: "software"` and `sourcePath: media.path`. (When the setting is off, fall through to the existing behavior — the media will still have a proxy job, so preview falls back to proxy/original as today.)

- [ ] **Step 5: Run tests + typecheck, verify pass** — `npx vitest run src/renderer/render/decoder` and `npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/app-settings.ts apps/desktop/src/main/app-settings.ts apps/desktop/src/renderer/settings/appSettingsStore.ts apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts apps/desktop/src/renderer/preview/PixiPreview.tsx
git commit -m "feat(preview-sw): AppSettings toggle + acquire software branch"
```

---

### Task 9: End-to-end verification — real ProRes preview + SSIM + memory

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/decodeBench.ts` (`strategy:'sw'` arm)
- Modify: `e2e/` media-conformance test (SSIM sw-preview vs ffmpeg reference)
- Create: a ProRes conformance fixture reference

**Interfaces:**
- Consumes: everything above; the `VITE_WEFTCUT_E2E=1` build with `--features preview-sw`.

- [ ] **Step 1: Manual smoke (the real proof)**

Build the addon with the feature (`npm run napi:build -- --features preview-sw`), start the app with the setting on (or toggle it in Settings), import a real ProRes clip, scrub + play in the timeline. Expected: frames render, color looks correct (matches a VLC/ffplay reference), no proxy is generated for that clip. Capture via the CDP recipe (`REMOTE_DEBUGGING_PORT=9222 npm run dev`) if driving headlessly.

- [ ] **Step 2: decode-bench `sw` arm**

Add a `strategy: 'sw'` branch to `decodeBench.ts` (mirror the `'native'` branch that sets `forceStrategy`) so the bench can drive `SwSourceHandle` on a ProRes fixture at the `DecoderHandle` seam. Run `e2e/scripts/decode-bench.mjs --strategy sw` and record fps/×realtime for 1080p + 4K ProRes.

- [ ] **Step 3: media-conformance SSIM gate**

Add a conformance case: decode-and-render one ProRes frame via `SwSourceHandle`, compare SSIM against an ffmpeg-produced reference PNG of the same frame (`lib/analyze.mjs` + Playwright `_electron`). Expected SSIM ≥ 0.98 (8-bit downconvert of a 10-bit source is expected, so not 1.0). Keep it gated the same way as existing conformance (feature-union note: add `preview-sw` to the E2E build's features).

- [ ] **Step 4: memory-ratchet at 4K**

Run `e2e/scripts/memory-ratchet.mjs` with a 4K ProRes clip previewing via SW. Expected: within the existing <30MB/90s ratchet — the `FrameRing` holds `ImageBitmap`s exactly like the WebCodecs path, but 4K bitmaps are large, so confirm the 1s lookahead does not blow the budget.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/decodeBench.ts e2e/
git commit -m "test(preview-sw): decode-bench sw arm + ProRes SSIM conformance + 4K memory ratchet"
```

---

## Self-Review

**Spec coverage (§ by §):** §2 preview data path → Tasks 2-8. §3 three-valued route → Tasks 1, 6. §4 degrade stack → **deferred to Phase 2** (Phase 1 is correctness-first, single clip; frame-drop/throttle not needed to prove the path). §5 proxy semantics (user opt-in) → the AppSettings toggle (Task 8) is the Phase-1 slice of it; full "delete auto-proxy scheduling" is the Phase-4 cleanup. §6 export → **Phase 3** (Task 1 keeps export on proxy for now). §7 transport → classic ipc (Tasks 4-5), matches the spike verdict. §8 channel → classic ipc, no SAB (Global Constraints + Tasks 4-5). §10 validation → Task 9.

**Placeholder scan:** Rust decode/session tasks reference exact mirror lines in `preview_gpu/decoder.rs`/`session.rs` rather than inventing 300 lines — this is "copy the existing pattern with these deletions", which is executable, not a placeholder. All TS/route/settings tasks carry complete code or exact signatures + line anchors.

**Type consistency:** `PreviewSource::NativeFfmpeg` (Rust) ↔ `{ route: "native-sw" }` (TS) ↔ `forceStrategy: "software"` (pool) — three names for three layers, mapped explicitly in Tasks 1/6/8. `SwFrame` (Rust) → `PreviewSwFrame` napi (Buffer) → `PreviewSwFrameMsg` (renderer, `Uint8Array`) — the field set (`ptsUs/durUs/width/height/format/color*`) is identical across Tasks 2/4/5/7. `SwSourceHandle` implements `DecoderHandle` + `isIdle` (Tasks 7/8) per the Global Constraint.

**Deferred by design (not gaps):** degrade stack, native export, playback-resolution UI, deleting auto-proxy scheduling — all belong to Phases 2-4 and are called out in the spec's §11.
