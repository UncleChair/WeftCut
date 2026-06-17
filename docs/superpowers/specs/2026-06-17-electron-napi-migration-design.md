# Tauri → Electron + napi-rs migration (design)

Date: 2026-06-17

## Context

WeftCut today is a Tauri 2 desktop app: the React/Vite/Tailwind/PixiJS renderer
runs in the **system webview** (WebView2 on Windows), and a Rust backend
(`apps/desktop/src-tauri`) owns the state actor, media jobs (ffmpeg via
`ffmpeg-sidecar`), audio mixing, the MCP server, and the Windows-only Motif
capture path (WebView2 CDP over `webview2-com`).

We need **cross-platform** (Windows + macOS + Linux). Two structural problems
make the system-webview model a poor base for that:

1. **Motif capture is Chromium/CDP-specific.** The capture primitive drives
   WebView2's DevTools Protocol via `CallDevToolsProtocolMethod`. WKWebView and
   WebKitGTK have no CDP, so the path cannot be ported as-is.
2. **The capture has an AA-jitter determinism gap** rooted in the **live GPU
   compositor** (opacity-animated compositor layers jitter ~28/255 alpha between
   two captures of the same frozen frame). This is shared by *all* system
   webviews (WebView2/WKWebView/WebKitGTK), so per-platform native snapshot APIs
   would not fix it — only **software compositing** makes the raster
   deterministic.

A large fraction of the project's accumulated pain is also WebView2-specific
(foreignObject taint, no Pointer Lock, encoder colorSpace ignored, the
`asset://` ~25 ms/1 MB streaming ceiling, Hi10P probe flush bugs).

### Decisions already taken (inputs to this design)

- **Runtime:** migrate to **Electron** (bundled Chromium for the UI + render),
  so preview/export/capture run on one engine across platforms and the WebView2
  quirk surface goes away. Bundle size is explicitly **not** a concern.
- **Keep the Rust.** The Rust domain core is the crown jewel; it is **not**
  rewritten in Node. It is hosted **in-process** via **napi-rs** (Node-API
  native addon). Only the Tauri shell/glue is replaced.
- **Capture via Electron's own runtime** (no separate bundled Chromium): a
  hidden **offscreen BrowserWindow** driven over CDP through
  `webContents.debugger`. The Phase 0 PoC found offscreen capture is **already
  byte-deterministic in GPU mode** (the WebView2 AA jitter did not reproduce —
  offscreen surface compositing ≠ the live on-screen GPU compositor), so the
  software output device is **not** required for within-machine determinism;
  the main UI keeps hardware acceleration with no per-window isolation needed.
  (Software rendering remains the cross-machine-byte-identity lever if S6 ever
  needs it; `app.disableHardwareAcceleration()` is process-wide, so it would be
  a separate capture process, not in-process.)

### Scope

**In scope (shell swap + migration-adjacent cheap debt):**
- Shell: Tauri → Electron (main + preload + renderer).
- Backend binding: Tauri commands/events → Electron IPC + napi-rs.
- Platform-forced rewrites: Motif capture (CDP via `webContents.debugger`),
  cloud key storage (keyring → Electron `safeStorage`), MCP transport.
- Adjacent cheap wins: replace the `asset://` ~25 ms/1 MB ceiling with
  streaming `protocol.handle`; delete dev-only WebView2-specific tools
  (`tauri-plugin-mcp-bridge`, `sysmon`).

**Out of scope:** the renderer business logic (React/Vite/Tailwind/PixiJS stays
unchanged behind a compatibility shim) and the Rust domain logic
(`state/audio/jobs/io/export/...` move near-verbatim).

### Verified current stack (2026-06; pin exact versions at scaffold time)

- **Electron 40+** stable (8-week major cadence; latest 3 majors supported).
- **napi-rs v3** (`napi` 3.8.x / `@napi-rs/cli` 3.6.x) with `tokio_rt`,
  `AsyncTask`, and `ThreadsafeFunction` (incl. `call_async_catch`).
- **electron-vite** for dev/build (correct main/preload/renderer split, Vite
  HMR); **electron-builder** for packaging. (Electron Forge's Vite support is
  still experimental.)
- Electron **offscreen rendering** supports a **software output device** (no GPU
  copy) and per-`BrowserWindow` config; `webContents.debugger` exposes CDP.

Sources consulted: endoflife.date/electron, electronjs.org release timelines &
offscreen-rendering docs, napi.rs changelog, electron-vite.org.

## Phase 0 — PoC (throwaway, Windows-only)

A throwaway PoC on a scratch branch. No UI, no glue migration, no MCP/cloud, no
packaging. It pins **independent GO/NO-GO numbers for the two high-risk
boundaries**. Either NO-GO reshapes its sub-approach; it does not by itself kill
the migration.

### Boundary 1 — napi-rs ↔ Rust state core (in-process, non-blocking)

**Build:** wrap a representative slice of the real Rust state actor via napi-rs
(`tokio_rt`) — load a small project, apply one mutation (move/trim a layer),
query `resolveView`; push `project:changed` via `ThreadsafeFunction`. Call it
from a minimal Electron main.

**Measure / criteria:**
1. **Round-trip latency** of one mutation (JS → Rust async fn → return),
   baselined against the current Tauri command for the same op. Target:
   **≤ Tauri baseline** (in-process napi call overhead is expected to be µs-scale).
2. **Event loop non-blocking:** a concurrent JS timer/rAF keeps ticking during a
   heavy mutation (validates `AsyncTask`/Rust-thread offloading).
3. **Event push:** `ThreadsafeFunction` delivers `project:changed` to JS,
   non-blocking.
4. **Serialization cost:** measured cost of passing a realistically-sized
   `resolveView` snapshot; decide JSON-string vs napi-native here.

**GO** = round-trip ≤ Tauri baseline + event loop responsive + TSFN events work.

### Boundary 2 — Motif capture via Electron offscreen-software + debugger CDP

**Build:** a hidden offscreen BrowserWindow (`offscreen: true` + software
output), load the **lower-third** Motif (opacity animation + bundled font — the
one that exhibits the AA jitter), inject the clock-takeover runtime, drive
`__motifRender(t)` via debugger `Runtime.evaluate`, capture via
`Page.captureScreenshot`.

**Measure / criteria:**
1. **Determinism (core):** capture the same frozen frame twice, compare PNGs.
   Target: **byte-identical** (or at minimum AA jitter collapsing from ~28/255 to
   within a far tighter bound than the current perceptual gate). Software
   rendering should make it byte-identical — this validates the whole thesis.
2. **Speed:** real per-frame time
   (`setDeviceMetricsOverride + Runtime.evaluate + captureScreenshot`).
   Baseline: WebView2 CDP ~92 ms/frame; software is expected slower. Acceptable
   if it fits the L1-prewarm + L2-bake export model (< ~300 ms/frame still
   usable; capture a real number).
3. **Transparency:** captured PNG preserves real alpha (transparent background).
4. **Per-window GPU isolation:** the offscreen-software window does **not** force
   the main UI window into software rendering.

**GO** = byte-identical (or dramatically tighter) + usable per-frame speed +
alpha preserved + main UI unaffected. **NO-GO fallback** = capture approach B
(separate Chromium driven by puppeteer-core), or keep GPU offscreen + the
perceptual gate (loses byte-identity but still unifies the engine cross-platform).

### Phase 0 outcome (2026-06-17) — both boundaries GO

Executed on Windows (Electron 40.10.4, napi 3.9.2, i5-13400 / RTX 3050).
Full data: `apps/desktop/poc/electron-napi/results.md`.

- **Boundary 1: GO.** napi round-trip p50 0.05 ms / p99 ≤ 0.34 ms (budget ≤1/≤5);
  TSFN events delivered 5/5; non-blocking confirmed (71 timer ticks spread
  evenly across the full 1112 ms heavy op — the raw `tickRatio 0.63` is Windows'
  ~15.6 ms `setInterval` floor, a harness-formula artifact, not blocking).
- **Boundary 2: GO.** Capture of the real lower-third is **byte-identical
  (maxChannelDiff = 0) in BOTH GPU and software modes**, alpha preserved,
  ~67–71 ms/frame (beats WebView2's ~92 ms, far under the 300 ms gate).
  Isolation OK — GPU-mode capture is already deterministic while a normal window
  keeps real hardware, so **no software rendering and no separate capture
  process are needed** (R4 not triggered).
- **Design impact:** the software-render-for-determinism premise is relaxed
  (offscreen GPU is already deterministic within a machine).
- **Migration gotcha banked:** offscreen `webContents.debugger` `Page.enable`/
  `Runtime.enable` **hang until a renderer context exists** → load `about:blank`
  first, then attach + enable + `addScriptToEvaluateOnNewDocument`, then navigate
  to the `motif:` URL.
- **Caveats carried to S6:** no negative control (the jitter never reproduced, so
  the test's sensitivity to jitter is unproven) and no cross-platform /
  cross-machine identity test yet (Windows-only, one GPU). Within-machine
  run-to-run determinism is what is proven — that is what removes the re-bake /
  preview-vs-export concern. Cross-OS byte-identity is the S6 gate.

## Target architecture

### Project structure (`apps/desktop`, post-migration)

```
apps/desktop/
  src/                       # renderer — React/Vite/Tailwind/PixiJS (UNCHANGED)
  electron/
    main/                    # Electron main (TS): lifecycle, windows, IPC router, protocol.handle
    preload/                 # contextBridge typed API surface
  native/                    # napi-rs crate (was src-tauri/src domain modules)
    src/
      lib.rs                 # #[napi] binding layer (replaces Tauri lib.rs shell + commands.rs)
      state/ audio/ jobs/ …   # domain logic moved near-verbatim
  electron.vite.config.ts
  electron-builder.yml
```

- `crate-type`: `["staticlib","cdylib","rlib"]` → napi `cdylib`. Domain modules
  (`state/audio/jobs/io/export/...`) stay; only the Tauri shell
  (`lib.rs`/`main.rs`/`commands.rs` + `tauri-plugin-*`) is replaced.
- **Keep `ts-rs`** (independent of Tauri) for domain types feeding
  renderer/preload; compose with napi-rs's generated addon `.d.ts` (napi
  signatures take/return ts-rs-described domain types).

### Security posture (Electron best practices)

- Main window: `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`,
  `webSecurity:true`. Backend reaches the renderer **only** through a minimal,
  typed `contextBridge` API (replacing `@tauri-apps/api` invoke).
- Assets/media via modern **`protocol.handle`** (returns a web `Response`,
  native streaming + Range) — also lifts the `asset://` ceiling (scope-adjacent
  win). A localhost server is only a fallback.
- Motif capture window (untrusted-content trust boundary): dedicated hidden
  window, `sandbox:true`, preload exposes nothing, strict CSP
  (`default-src 'none'`), offline, `motif:` custom protocol with path-safe asset
  serving — a 1:1 map of the current capability-denial / window-as-isolation
  model.

### Tauri-plugin → native mapping

dialog/fs/shell → Electron `dialog`/`net`/`shell`; single-instance →
`app.requestSingleInstanceLock()`; window-state → `electron-window-state` or
self-stored; notification → Electron `Notification`;
`tauri-plugin-mcp-bridge` + `sysmon` (dev-only, WebView2-specific) → **deleted**.

## napi-rs boundary design

1. **Backend singleton.** A single `#[napi]` `Backend` class, instantiated once
   in the Electron main, holds the same `Arc` graph Tauri puts in managed state
   (actor handle, capture state, log bus, job manager). Commands are methods;
   `State<T>` injection → `self` field access.

2. **Commands:** each `#[tauri::command]` → a `Backend` `#[napi] async fn`
   returning `napi::Result<T>`. **Serialization:**
   - Default **JSON string** (Rust `serde_json::to_string` / JS `JSON.parse`):
     lowest porting risk, matches current Tauri behavior, ts-rs already describes
     the JSON shape. Use it for the bulk.
   - **Bytes via `Buffer`/`Uint8Array`** (thumbnails, peaks, frame bitmaps) —
     never base64/JSON.
   - **Selective upgrade** of hot/large paths (esp. per-frame `resolveView`) to
     `#[napi(object)]` native mapping only if the PoC shows JSON cost matters.

3. **Async & threading (non-blocking).** `#[napi] async fn` futures run on
   napi-rs's `tokio_rt` runtime off the Node main thread (JS gets a Promise); the
   existing tokio actor + jobs run on that same runtime. CPU-heavy sync work
   (audio mixing, blake3) → `spawn_blocking`/`AsyncTask`.

4. **Events:** Tauri `emit` → `ThreadsafeFunction`. `Backend.subscribe(cb)`
   wraps the JS callback in a TSFN; Rust event sources (actor, log bus,
   job/export progress, `motifs:changed`) push through it (`call_async_catch`),
   non-blocking. Chain: Rust event → TSFN → Electron main → IPC
   (`webContents.send`) → renderer. **Load-bearing:** every mutation source
   (napi commands, MCP, jobs) must go through the `project:changed` bridge or the
   UI silently freezes.

5. **Renderer call surface (compatibility shim).** Preload exposes
   `window.api.invoke(channel,args)` (→ `ipcRenderer.invoke` → main → Backend
   method → Promise) and `window.api.on(event,cb)`. A `src/lib/ipc.ts` shim
   re-exports Tauri-signature `invoke`/`listen` backed by `window.api`; the
   renderer only repoints its `@tauri-apps/api` import — business code unchanged.

## Capture subsystem

The capture **primitive** (`motif_capture_frame`) is already called *from* JS
fill loops; L0/L1/L2 fill loops are already JS-side. So migration swaps the
primitive (Rust-drives-WebView2-CDP → Electron-main-drives-offscreen-debugger-CDP),
not the direction.

**Moves to Node / Electron main (replaces `cdp.rs` + `host.rs`):**
- Hidden offscreen BrowserWindow lifecycle: lazy create, reuse, `navigate`
  between motif ids.
- Offscreen **software output** (determinism) + per-window GPU isolation.
- `webContents.debugger` CDP: `setDeviceMetricsOverride` +
  `setDefaultBackgroundColorOverride{a:0}` (alpha) + `Runtime.evaluate`
  (`__motifRender`) + `Page.captureScreenshot` (lossless PNG).
- Runtime injection: wry `initialization_script` → CDP
  `Page.addScriptToEvaluateOnNewDocument` (document-start, before `motif.define`).
- Per-frame serialization lock, readiness probe,
  `should_probe`/`should_set_metrics` dedup — small + unit-tested; ported to TS
  alongside the primitive.
- `protocol.handle('motif', …)` for path-safe asset serving (replaces the
  `builtin.rs` scheme resolver).

**Stays in Rust (napi, near-verbatim — the Motif "brain"):** catalog / store /
authoring / built-in Motif bytes (`include_bytes!`); props validate +
canonicalize; **cache-key derivation** (L2 PNG key); staleness; watcher
(`notify`); `MotifRuntime` source registration. Exposed as napi functions; the
Node protocol handler fetches built-in assets via a Rust `get_motif_asset(id,
path) -> Buffer` accessor (single source of truth; reconcile the dual-manifest
gotcha during migration).

**Fill loops (L0/L1/L2):** unchanged location (JS-side); repoint
`invoke('motif_capture_frame')` → `window.api.captureMotifFrame(...)`.

**Reuse of `cdp.rs`:** the `!Send` / UI-thread / oneshot COM dance is **deleted**
(Electron debugger is plain async JS); CDP method names + params JSON are
identical; `parse_screenshot_data`/`parse_eval_result` are trivial in JS.

**Determinism:** offscreen software output → deterministic raster; the font
force-load and re-seekable-runtime gotchas live in the runtime (JS,
platform-independent) and carry over unchanged; the perceptual gate may be
tightenable to exact-match under software rendering (PoC Boundary 2 confirms).

## Migration staging (S1–S6)

New branch; Tauri abandoned on it from S1; each stage independently
runnable/testable; branch stays green. **S0 = the Phase 0 PoC** (precedes S1;
GO gates entry).

- **S1 — shell up.** electron-vite scaffold (main/preload/renderer → existing
  `src`); contextBridge `window.api` + `ipc.ts` shim; **stub** backend (invoke
  returns empty); security posture + `protocol.handle` for renderer assets.
  *Accept:* app launches, React UI renders (no white screen), PixiJS WebGPU
  canvas initializes. Boot smoke.
- **S2 — state core.** Rust lib → napi addon (`Backend`/`tokio_rt`); state
  commands (load/mutation/resolveView/undo-redo) + `project:changed` TSFN bridge;
  ts-rs alignment. *Accept:* load a real project, mutate (move/trim/split/add,
  undo/redo), UI updates via the bridge; existing Rust state unit tests pass on
  the addon; parity spot-check vs Tauri.
- **S3 — media + jobs.** jobs (import/proxy/conform/thumbnails/waveform) stay
  Rust (ffmpeg-sidecar; ffmpeg binary via electron-builder extraResources);
  job/export progress TSFN; media via `protocol.handle` + Range (lifts asset://
  ceiling); export pipeline (worker in renderer; videosink WS transport retained
  for now, revisit). *Accept:* import (two-phase proxy), thumbnails/waveform,
  scrub preview (WebCodecs decode + protocol-served frames), end-to-end export
  (H.264+AV1); media-conformance e2e on the Electron build.
- **S4 — Node-side rewrites.** **MCP → TS SDK** (`@modelcontextprotocol/sdk`,
  replaces rmcp, resolves the 0.1.x pin; re-expose the tool surface calling
  `Backend`; verify external client compat); keyring → Electron `safeStorage`;
  cloud HTTP stays Rust (reqwest). *Accept:* MCP server starts, an external
  client connects + calls a tool; cloud transcription works with a safeStorage
  key.
- **S5 — Motif capture.** Land the capture subsystem (above). *Accept:* place a
  Motif, preview renders correctly + deterministically, export-with-Motifs
  ("preparing" bake), motif capture e2e passes; determinism gate tightened per
  PoC.
- **S6 — packaging + cross-platform.** electron-builder (Win NSIS → mac
  dmg/notarization → Linux AppImage/deb); napi-rs cross-platform prebuilds (CI
  for win/mac/linux); per-platform ffmpeg; signing + auto-update (the open
  Phase 7 items). *Accept:* signed installers for 3 platforms; **cross-platform
  capture-consistency e2e passes (same Motif → perceptually-equal/identical
  frames across OS) — the original goal proven here**; app runs on all three.

**Cut-over:** at S1–S6 parity, delete the `src-tauri` shell + Tauri deps (domain
modules already in `native/`).

**Cross-cutting — test-driver migration (load-bearing).** The current e2e
(tauri-driver + WebdriverIO + msedgedriver) is Tauri/WebView2-specific. Port to
**Playwright-for-Electron or the WebdriverIO Electron service**. The
media-conformance / motif / export gates are the parity oracle, so this starts
with S2/S3, not as an afterthought.

## Parity validation strategy

Four layers proving Electron ≡ Tauri:

1. **Rust unit tests pass verbatim** on the napi build (domain code unchanged):
   `state/actor/tests.rs`, conformance, keyframe golden vectors,
   engine-source/snap-math twins. Strongest "brain intact" evidence.
2. **Behavioral parity = ported e2e suite passes** (export EOS-tail, overlap
   same-source, two-role audio, motif capture, keyframe golden). The e2e suite
   is the behavioral oracle.
3. **Output parity (the product):** same project + `WEFTCUT_TEST_MEDIA`
   fixtures, export on both builds, compare with the media-conformance analyzer
   (frame-align SSIM + audio Goertzel) within existing perceptual gates (SSIM
   0.80 / color / audio).
4. **State parity:** load N real projects on both builds, replay a mutation
   sequence, compare serialized resolved state — identical (same Rust).

**Honest caveat:** Motif-frame parity *between the two builds* is **perceptual,
not byte-identical** (Tauri = WebView2 GPU compositing; Electron = software).
Byte-identity is a new *within-Electron* property (same frame captured twice),
not a cross-build one. Do not gate Tauri-vs-Electron on byte-identity.

## Risk register

| # | Risk | Mitigation / fallback |
|---|---|---|
| R1 | napi serialization cost on hot paths (per-frame resolveView) | PoC Boundary 1 measures; JSON-first + selective native/Buffer upgrade; fallback: keep per-frame resolve in Rust, push deltas |
| R2 | Offscreen rendering too slow for bake/export | **Retired (PoC):** ~70 ms/frame, beats WebView2 ~92 ms, far under 300 ms. L1 prewarm + L2 persist remain. |
| R3 | GPU compositor AA jitter breaks determinism | **Retired within-machine (PoC):** offscreen GPU capture is byte-identical (maxChannelDiff 0); jitter did not reproduce. Cross-machine/OS identity still open → S6 gate (+ add a negative control there). |
| R4 | Per-window GPU isolation fails (software tanks main-UI PixiJS) | **Moot (PoC):** software rendering not needed; GPU-mode capture is deterministic while the main UI keeps hardware. In-process coexistence works. |
| R5 | Test-driver migration drag (the whole oracle depends on it) | First-class cross-cutting workstream, starts at S2 |
| R6 | Rust `!Send` / tokio runtime coexistence with napi | napi `tokio_rt` owns one runtime; we use ffmpeg-sidecar (subprocess) not ffmpeg-next, so the `!Send` risk is largely moot |
| R7 | MCP external-client compat after rmcp → TS SDK (transport change) | S4 verifies each connecting client; TS SDK supports SSE + streamable-HTTP (a superset) |
| R8 | Electron security posture breaks a renderer assumption (direct Tauri global) | shim + S1 audit of renderer's direct Tauri-global usage |
| R9 | Parallel sessions editing the same checkout | long-lived migration branch; stage by explicit path; ask on overlaps |

Bundle/runtime footprint is explicitly de-prioritized by the user.

## Open questions deferred to the implementation plan

- Serialization: confirm JSON-string vs napi-native split from PoC numbers;
  exact `resolveView` representation.
- Export `videosink` WS transport (tungstenite): keep WS, or switch to
  IPC/Buffer under Electron? (Decide in S3.)
- Built-in Motif assets: keep embedded in the addon (`include_bytes!` +
  `get_motif_asset`) vs ship as electron-builder resources; reconcile the
  dual-manifest (TS + Rust) gotcha.
- ts-rs ↔ napi-rs `.d.ts` alignment mechanics (avoid type drift).
- e2e driver choice: Playwright-for-Electron vs WebdriverIO Electron service.
- napi-rs prebuild/CI matrix shape for the three platforms.
