# Electron + napi-rs PoC (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate, with real numbers on this machine, the two high-risk boundaries of the Tauri→Electron+napi-rs migration before committing to it: (1) the napi-rs ↔ Rust state boundary, (2) deterministic Motif capture via Electron offscreen rendering + `webContents.debugger` CDP.

**Architecture:** A throwaway, self-contained Electron app under `apps/desktop/poc/electron-napi/`. A napi-rs v3 native addon exposes a representative async state mutation + a CPU-heavy op + a ThreadsafeFunction event source. A headless Electron main process runs two measurement suites — Boundary 1 (latency / non-blocking / events) and Boundary 2 (capture determinism / speed / alpha / GPU isolation) — and writes a `results.md` with GO/NO-GO verdicts. It reuses the **real** `MOTIF_RUNTIME_SOURCE` and the **real** lower-third Motif so the determinism test is faithful.

**Tech Stack:** Electron 40+, napi-rs v3 (`napi`/`napi-derive` 3.x, `@napi-rs/cli` 3.6.x), Rust (cdylib + imbl + serde + tokio), esbuild (bundles the TS main), pngjs (pixel-diff for the jitter magnitude).

## Global Constraints

- **Throwaway / Windows-only.** This PoC lives entirely under `apps/desktop/poc/electron-napi/`; it is deleted at the S0→S1 transition. Do not wire it into the real app, the workspace, or CI.
- **Reuse real artifacts, don't fork them.** Import `MOTIF_RUNTIME_SOURCE` from `apps/desktop/src/render/motifs/runtime.ts`; serve the lower-third from `apps/desktop/src-tauri/src/motifs/catalog/lower-third/`. Do not copy/edit these.
- **napi-rs v3 API.** async fn requires the `tokio_rt` Cargo feature. ThreadsafeFunction: accept `ThreadsafeFunction<T>` as a `#[napi]` param; call `tsfn.call(Ok(value), ThreadsafeFunctionCallMode::NonBlocking)`. Imports: `use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};` and `use napi::bindgen_prelude::*;`. Reference: https://napi.rs/docs/concepts/threadsafe-function and https://napi.rs/docs/concepts/async-fn — if a generic signature differs in the installed version, follow these docs.
- **lower-third facts (from its manifest):** render size `1280×320`, `content_duration_s: 0.8`, `settle_rafs: 1`, font Inter 700. Default props: `{ title:"Jane Doe", subtitle:"Director of Photography", accent:"#ff4d4d", align:"left" }`.
- **Render entry contract:** `window.__motifRender(t, props, meta)` where `t` is seconds and `meta = { width, height, fps, settleRafs }`. Ready when `typeof window.__motifRender==='function' && document.readyState==='complete'`.
- **Node:** v22.20.0 (fnm default, active). Do not install Node any other way.

---

## File Structure

```
apps/desktop/poc/electron-napi/
  native/
    Cargo.toml            # napi addon crate
    build.rs              # napi_build::setup()
    package.json          # @napi-rs/cli build script
    src/lib.rs            # Backend state slice + apply_mutation + heavy_mutation + subscribe_and_fire
  src/
    boundary1.ts          # napi boundary measurements (latency / non-blocking / TSFN)
    boundary2.ts          # capture measurements (determinism / speed / alpha / isolation)
    capture.ts            # offscreen host + debugger CDP capture primitive
    protocol.ts           # motif: protocol handler (serves the real lower-third dir)
    pngdiff.ts            # pixel diff (max channel diff + % pixels differing) via pngjs
    main.ts               # Electron bootstrap; runs both suites; writes results.md
  package.json            # electron + esbuild + pngjs; build/run scripts
  results.md              # OUTPUT: recorded measurements + GO/NO-GO (the deliverable)
  .gitignore              # ignore build artifacts (node_modules, target, *.node, *.cjs)
```

Responsibilities: `native/` is the addon (Boundary 1 subject). `capture.ts` is the one capture primitive; `boundary2.ts` orchestrates the capture experiments. `protocol.ts`/`pngdiff.ts` are small focused helpers. `main.ts` is the only Electron-aware bootstrap and the only thing that writes `results.md`.

---

## Task 0: PoC scaffold boots Electron

**Files:**
- Create: `apps/desktop/poc/electron-napi/package.json`
- Create: `apps/desktop/poc/electron-napi/.gitignore`
- Create: `apps/desktop/poc/electron-napi/src/main.ts`

**Interfaces:**
- Produces: an Electron app that launches headless and exits cleanly; the `npm run poc` script chain (esbuild bundle → run) used by every later task.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "poc-electron-napi",
  "version": "0.0.0",
  "private": true,
  "description": "Throwaway PoC: Electron + napi-rs boundary validation",
  "devDependencies": {
    "electron": "^40.0.0",
    "esbuild": "^0.24.0",
    "pngjs": "^7.0.0"
  },
  "scripts": {
    "build:native": "cd native && npm run build",
    "build:main": "esbuild src/main.ts --bundle --platform=node --format=cjs --external:electron --external:../native --outfile=main.cjs",
    "poc": "npm run build:native && npm run build:main && electron main.cjs",
    "poc:sw": "npm run build:main && electron main.cjs --software"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
native/node_modules/
native/target/
native/*.node
native/index.js
native/index.d.ts
main.cjs
*.png
```

- [ ] **Step 3: Create a minimal `src/main.ts`**

```ts
import { app } from 'electron'

app.disableHardwareAcceleration() // overridden per-run in later tasks

app.whenReady().then(async () => {
  console.log('[poc] electron ready')
  app.quit()
})
```

- [ ] **Step 4: Install deps**

Run: `cd apps/desktop/poc/electron-napi && npm install`
Expected: electron, esbuild, pngjs installed; no errors.

- [ ] **Step 5: Bundle + run**

Run: `npm run build:main && npx electron main.cjs`
Expected: stdout prints `[poc] electron ready`, process exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/poc/electron-napi/package.json apps/desktop/poc/electron-napi/.gitignore apps/desktop/poc/electron-napi/src/main.ts
git commit -m "poc(electron-napi): scaffold boots headless electron"
```

---

## Task 1: napi-rs addon — representative state slice

**Files:**
- Create: `apps/desktop/poc/electron-napi/native/Cargo.toml`
- Create: `apps/desktop/poc/electron-napi/native/build.rs`
- Create: `apps/desktop/poc/electron-napi/native/package.json`
- Create: `apps/desktop/poc/electron-napi/native/src/lib.rs`

**Interfaces:**
- Produces (addon exports, consumed by `boundary1.ts`):
  - `applyMutation(payload: string): Promise<string>` — payload `{"layerIndex":number,"deltaUs":number}`; returns the serialized project (the "resolveView" stand-in).
  - `heavyMutation(rounds: number): Promise<number>` — CPU-bound work off the JS thread; returns a checksum.
  - `subscribeAndFire(cb: (err, msg: string) => void): void` — fires 5 `project:changed`-style events from a background thread via a ThreadsafeFunction.

- [ ] **Step 1: Create `native/Cargo.toml`**

```toml
[package]
name = "poc_native"
version = "0.0.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "3", default-features = false, features = ["napi6", "tokio_rt"] }
napi-derive = "3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
imbl = { version = "3", features = ["serde"] }
tokio = { version = "1", features = ["rt", "rt-multi-thread", "time"] }

[build-dependencies]
napi-build = "2"
```

- [ ] **Step 2: Create `native/build.rs`**

```rust
fn main() {
    napi_build::setup();
}
```

- [ ] **Step 3: Create `native/package.json`**

```json
{
  "name": "poc_native",
  "version": "0.0.0",
  "main": "index.js",
  "types": "index.d.ts",
  "napi": { "binaryName": "poc_native" },
  "devDependencies": { "@napi-rs/cli": "^3.6.2" },
  "scripts": { "build": "napi build --platform --release" }
}
```

- [ ] **Step 4: Write the failing Rust unit test (in `native/src/lib.rs`)**

Create `native/src/lib.rs` with the data model + a unit test for the pure mutation logic first:

```rust
use imbl::Vector;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Serialize, Deserialize)]
struct Layer {
    id: String,
    t_start_us: i64,
    t_end_us: i64,
    kind: String,
    opacity: f64,
    x: f64,
    y: f64,
    scale: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Project {
    layers: Vector<Layer>,
    duration_us: i64,
}

fn sample_project(n: usize) -> Project {
    let layers = (0..n)
        .map(|i| Layer {
            id: format!("layer-{i}"),
            t_start_us: (i as i64) * 1_000_000,
            t_end_us: (i as i64) * 1_000_000 + 2_000_000,
            kind: if i % 2 == 0 { "video" } else { "audio" }.to_string(),
            opacity: 1.0,
            x: 0.0,
            y: 0.0,
            scale: 1.0,
        })
        .collect();
    Project { layers, duration_us: (n as i64) * 1_000_000 }
}

#[derive(Deserialize)]
struct MoveMutation {
    #[serde(rename = "layerIndex")]
    layer_index: usize,
    #[serde(rename = "deltaUs")]
    delta_us: i64,
}

/// Pure mutation: returns a new project with one layer moved (persistent update).
fn move_layer(proj: &Project, m: &MoveMutation) -> Project {
    let mut next = proj.clone();
    if let Some(layer) = next.layers.get(m.layer_index).cloned() {
        let mut moved = layer;
        moved.t_start_us += m.delta_us;
        moved.t_end_us += m.delta_us;
        next.layers = next.layers.update(m.layer_index, moved);
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_layer_shifts_only_target() {
        let proj = sample_project(50);
        let before = proj.layers.get(3).unwrap().t_start_us;
        let next = move_layer(&proj, &MoveMutation { layer_index: 3, delta_us: 500 });
        assert_eq!(next.layers.get(3).unwrap().t_start_us, before + 500);
        assert_eq!(next.layers.get(4).unwrap().t_start_us, proj.layers.get(4).unwrap().t_start_us);
    }
}
```

- [ ] **Step 5: Run the Rust test to verify it passes**

Run: `cd apps/desktop/poc/electron-napi/native && cargo test`
Expected: `move_layer_shifts_only_target ... ok`.

- [ ] **Step 6: Add the napi exports (append to `native/src/lib.rs`)**

```rust
static STATE: OnceLock<Mutex<Project>> = OnceLock::new();
fn state() -> &'static Mutex<Project> {
    STATE.get_or_init(|| Mutex::new(sample_project(50)))
}

#[napi]
pub async fn apply_mutation(payload: String) -> Result<String> {
    let m: MoveMutation =
        serde_json::from_str(&payload).map_err(|e| Error::from_reason(format!("bad payload: {e}")))?;
    let view = {
        let mut proj = state().lock().unwrap();
        *proj = move_layer(&proj, &m);
        serde_json::to_string(&*proj).map_err(|e| Error::from_reason(format!("serialize: {e}")))?
    };
    Ok(view)
}

#[napi]
pub async fn heavy_mutation(rounds: u32) -> Result<f64> {
    let sum = tokio::task::spawn_blocking(move || {
        let mut acc = 0f64;
        for i in 0..(rounds as u64) * 1_000_000 {
            acc += (i as f64).sqrt();
        }
        acc
    })
    .await
    .map_err(|e| Error::from_reason(format!("join: {e}")))?;
    Ok(sum)
}

#[napi]
pub fn subscribe_and_fire(callback: ThreadsafeFunction<String>) -> Result<()> {
    std::thread::spawn(move || {
        for i in 0..5 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            callback.call(Ok(format!("project:changed #{i}")), ThreadsafeFunctionCallMode::NonBlocking);
        }
    });
    Ok(())
}
```

- [ ] **Step 7: Build the addon**

Run: `cd apps/desktop/poc/electron-napi/native && npm install && npm run build`
Expected: produces `poc_native.<triple>.node` plus generated `index.js` + `index.d.ts`; `index.d.ts` shows `applyMutation`, `heavyMutation`, `subscribeAndFire`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/poc/electron-napi/native/Cargo.toml apps/desktop/poc/electron-napi/native/build.rs apps/desktop/poc/electron-napi/native/package.json apps/desktop/poc/electron-napi/native/src/lib.rs
git commit -m "poc(electron-napi): napi addon with state-slice mutation, heavy op, TSFN"
```

---

## Task 2: Boundary 1 — latency

**Files:**
- Create: `apps/desktop/poc/electron-napi/src/boundary1.ts`
- Modify: `apps/desktop/poc/electron-napi/src/main.ts`

**Interfaces:**
- Consumes: addon `applyMutation` (Task 1).
- Produces: `runBoundary1(): Promise<Boundary1Result>` where `Boundary1Result = { p50Ms, p99Ms, payloadBytes, tickRatio, eventsReceived }` — fields filled across Tasks 2–3.

- [ ] **Step 1: Create `src/boundary1.ts` with the latency measurement**

```ts
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('../native') as {
  applyMutation(payload: string): Promise<string>
  heavyMutation(rounds: number): Promise<number>
  subscribeAndFire(cb: (err: unknown, msg: string) => void): void
}

export interface Boundary1Result {
  p50Ms: number
  p99Ms: number
  payloadBytes: number
  tickRatio: number
  eventsReceived: number
}

export async function runBoundary1(): Promise<Boundary1Result> {
  const N = 1000
  // warm-up
  for (let i = 0; i < 50; i++) {
    await native.applyMutation(JSON.stringify({ layerIndex: i % 50, deltaUs: 1000 }))
  }
  const samples: number[] = []
  let payloadBytes = 0
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    const view = await native.applyMutation(JSON.stringify({ layerIndex: i % 50, deltaUs: 1000 }))
    samples.push(performance.now() - t0)
    if (i === 0) payloadBytes = Buffer.byteLength(view, 'utf8')
  }
  samples.sort((a, b) => a - b)
  const p50Ms = samples[Math.floor(N * 0.5)]
  const p99Ms = samples[Math.floor(N * 0.99)]

  return { p50Ms, p99Ms, payloadBytes, tickRatio: NaN, eventsReceived: -1 }
}
```

- [ ] **Step 2: Wire it into `src/main.ts`**

Replace `src/main.ts` with:

```ts
import { app } from 'electron'
import { runBoundary1 } from './boundary1'

const useSoftware = process.argv.includes('--software')
if (useSoftware) app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const b1 = await runBoundary1()
  console.log('[boundary1]', JSON.stringify(b1, null, 2))
  app.quit()
})
```

- [ ] **Step 3: Build + run**

Run: `npm run build:native && npm run build:main && npx electron main.cjs`
Expected: prints `[boundary1] { p50Ms, p99Ms, payloadBytes, ... }`. Record the numbers.

- [ ] **Step 4: Check against GO budget**

GO for latency = **p50Ms ≤ 1.0 AND p99Ms ≤ 5.0** for the ~50-layer payload (in-process napi JSON round-trip is expected well under Tauri's over-IPC JSON; these absolute budgets stand in for "≤ Tauri baseline"). Note `payloadBytes` for context.
Expected: pass. If p99 is far above 5 ms, record it — that triggers risk R1 (selective native/Buffer upgrade or delta-push).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/poc/electron-napi/src/boundary1.ts apps/desktop/poc/electron-napi/src/main.ts
git commit -m "poc(electron-napi): boundary-1 latency measurement"
```

---

## Task 3: Boundary 1 — non-blocking + ThreadsafeFunction events

**Files:**
- Modify: `apps/desktop/poc/electron-napi/src/boundary1.ts`

**Interfaces:**
- Consumes: addon `heavyMutation`, `subscribeAndFire` (Task 1).
- Produces: fills `tickRatio` and `eventsReceived` in `Boundary1Result`.

- [ ] **Step 1: Add the non-blocking + event measurements**

In `src/boundary1.ts`, replace the `return` line of `runBoundary1` with:

```ts
  // Non-blocking: a JS-thread timer must keep ticking while a heavy native op runs.
  let ticks = 0
  const intervalMs = 10
  const timer = setInterval(() => { ticks++ }, intervalMs)
  const tStart = performance.now()
  await native.heavyMutation(300) // tune so elapsed >= ~500ms on this machine
  const elapsedMs = performance.now() - tStart
  clearInterval(timer)
  const expectedTicks = elapsedMs / intervalMs
  const tickRatio = ticks / expectedTicks // ~1.0 == event loop never blocked

  // ThreadsafeFunction: expect 5 events delivered to the JS callback.
  const events: string[] = []
  await new Promise<void>((resolve) => {
    const done = setTimeout(resolve, 3000)
    native.subscribeAndFire((_err, msg) => {
      events.push(msg)
      if (events.length >= 5) { clearTimeout(done); resolve() }
    })
  })

  return { p50Ms, p99Ms, payloadBytes, tickRatio, eventsReceived: events.length }
```

- [ ] **Step 2: Build + run**

Run: `npm run build:main && npx electron main.cjs`
Expected: `[boundary1]` now shows a `tickRatio` near 1.0 and `eventsReceived: 5`. If `heavyMutation`'s `elapsedMs` is under ~300 ms, raise the `300` argument and re-run.

- [ ] **Step 3: Check against GO criteria**

GO = **tickRatio ≥ 0.8** (event loop stayed responsive during heavy native work) AND **eventsReceived === 5** (TSFN delivery works). Record both.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/poc/electron-napi/src/boundary1.ts
git commit -m "poc(electron-napi): boundary-1 non-blocking + TSFN event checks"
```

---

## Task 4: Capture primitive — offscreen host + debugger CDP

**Files:**
- Create: `apps/desktop/poc/electron-napi/src/protocol.ts`
- Create: `apps/desktop/poc/electron-napi/src/capture.ts`
- Modify: `apps/desktop/poc/electron-napi/src/main.ts`

**Interfaces:**
- Consumes: `MOTIF_RUNTIME_SOURCE` from `apps/desktop/src/render/motifs/runtime.ts`; the lower-third dir.
- Produces:
  - `registerMotifProtocol(): void` — registers `motif:` serving the real lower-third dir.
  - `createHost(): Promise<HostHandle>` and `captureFrame(host, tSec): Promise<Buffer>` (PNG bytes), used by `boundary2.ts`.

- [ ] **Step 1: Create `src/protocol.ts`**

```ts
import { protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import * as path from 'node:path'

// The real built-in lower-third, served as motif://lower-third/<path>
const LOWER_THIRD_DIR = path.resolve(
  __dirname,
  '../../../src-tauri/src/motifs/catalog/lower-third',
)

export function registerMotifSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'motif', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

export function registerMotifProtocol(): void {
  protocol.handle('motif', (request) => {
    const url = new URL(request.url) // motif://lower-third/index.html
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const abs = path.join(LOWER_THIRD_DIR, rel || 'index.html')
    // path-safety: stay within the motif dir
    if (!abs.startsWith(LOWER_THIRD_DIR)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(abs).toString())
  })
}
```

Note: `registerMotifSchemePrivileged` must be called **before** `app.whenReady()`; `registerMotifProtocol` **after**.

- [ ] **Step 2: Create `src/capture.ts`**

```ts
import { BrowserWindow } from 'electron'
import { MOTIF_RUNTIME_SOURCE } from '../../../src/render/motifs/runtime'

const W = 1280
const H = 320
const FPS = 30
const SETTLE = 1
const PROPS = { title: 'Jane Doe', subtitle: 'Director of Photography', accent: '#ff4d4d', align: 'left' }

export interface HostHandle {
  win: BrowserWindow
  send: (method: string, params?: object) => Promise<any>
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function createHost(): Promise<HostHandle> {
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const send = (method: string, params: object = {}) => dbg.sendCommand(method, params)

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOTIF_RUNTIME_SOURCE })
  await win.loadURL('motif://lower-third/index.html')

  // ready probe (mirrors the production readiness check)
  let ready = false
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', {
      expression: `(typeof window.__motifRender==='function' && document.readyState==='complete')`,
      returnByValue: true,
    })
    if (r?.result?.value === true) { ready = true; break }
    await delay(50)
  }
  if (!ready) throw new Error('motif never became ready (window.__motifRender undefined / page not loaded)')

  // metrics + transparent backdrop (set once)
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })

  return { win, send }
}

export async function captureFrame(host: HostHandle, tSec: number): Promise<Buffer> {
  const meta = { width: W, height: H, fps: FPS, settleRafs: SETTLE }
  const expr = `window.__motifRender(${JSON.stringify(tSec)}, ${JSON.stringify(PROPS)}, ${JSON.stringify(meta)})`
  const ev = await host.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (ev?.exceptionDetails) throw new Error('render threw: ' + JSON.stringify(ev.exceptionDetails))
  const shot = await host.send('Page.captureScreenshot', { format: 'png' })
  return Buffer.from(shot.data, 'base64')
}
```

Fallback note (if `Page.captureScreenshot` returns a blank/transparent image for an offscreen window): capture via the offscreen paint path instead — `win.webContents.on('paint', (_e, _dirty, image) => image.toPNG())` after `win.webContents.setFrameRate(60)` — and record that the debugger-screenshot path needed the paint fallback.

- [ ] **Step 3: Smoke the capture in `src/main.ts`**

Replace `src/main.ts` with:

```ts
import { app } from 'electron'
import * as fs from 'node:fs'
import { runBoundary1 } from './boundary1'
import { registerMotifSchemePrivileged, registerMotifProtocol } from './protocol'
import { createHost, captureFrame } from './capture'

const useSoftware = process.argv.includes('--software')
if (useSoftware) app.disableHardwareAcceleration()
registerMotifSchemePrivileged()

app.whenReady().then(async () => {
  registerMotifProtocol()

  const b1 = await runBoundary1()
  console.log('[boundary1]', JSON.stringify(b1, null, 2))

  const host = await createHost()
  const png = await captureFrame(host, 0.35)
  fs.writeFileSync('frame-0.35.png', png)
  console.log('[capture] wrote frame-0.35.png', png.length, 'bytes')

  app.quit()
})
```

- [ ] **Step 4: Build + run + eyeball**

Run: `npm run build:native && npm run build:main && npx electron main.cjs`
Expected: writes `frame-0.35.png`. Open it: it must show the lower-third mid-animation (Inter font rendered, accent color) on a **transparent** background. If blank, apply the paint fallback from Step 2.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/poc/electron-napi/src/protocol.ts apps/desktop/poc/electron-napi/src/capture.ts apps/desktop/poc/electron-napi/src/main.ts
git commit -m "poc(electron-napi): offscreen host + debugger CDP capture of the real lower-third"
```

---

## Task 5: Boundary 2 — determinism + alpha

**Files:**
- Create: `apps/desktop/poc/electron-napi/src/pngdiff.ts`
- Create: `apps/desktop/poc/electron-napi/src/boundary2.ts`
- Modify: `apps/desktop/poc/electron-napi/src/main.ts`

**Interfaces:**
- Consumes: `createHost`, `captureFrame` (Task 4); `pngjs`.
- Produces: `pngDiff(a, b)` and `runBoundary2(): Promise<Boundary2Result>` where `Boundary2Result = { identical, maxChannelDiff, pctPixelsDiffering, hasAlpha, avgCaptureMs, gpuRenderer }` — fields filled across Tasks 5–7.

- [ ] **Step 1: Create `src/pngdiff.ts`**

```ts
import { PNG } from 'pngjs'

export interface PngDiff { maxChannelDiff: number; pctPixelsDiffering: number }

export function pngDiff(a: Buffer, b: Buffer): PngDiff {
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  const n = Math.min(pa.data.length, pb.data.length)
  let maxChannelDiff = 0
  let differingPixels = 0
  const totalPixels = Math.min(pa.width * pa.height, pb.width * pb.height)
  for (let i = 0; i < n; i += 4) {
    let pixelDiff = 0
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(pa.data[i + c] - pb.data[i + c])
      if (d > maxChannelDiff) maxChannelDiff = d
      if (d > pixelDiff) pixelDiff = d
    }
    if (pixelDiff > 8) differingPixels++
  }
  return { maxChannelDiff, pctPixelsDiffering: (differingPixels / totalPixels) * 100 }
}

export function hasAlpha(png: Buffer): boolean {
  const p = PNG.sync.read(png)
  for (let i = 3; i < p.data.length; i += 4) {
    if (p.data[i] < 255) return true
  }
  return false
}
```

- [ ] **Step 2: Create `src/boundary2.ts` with the determinism + alpha checks**

```ts
import { createHost, captureFrame, HostHandle } from './capture'
import { pngDiff, hasAlpha } from './pngdiff'

export interface Boundary2Result {
  identical: boolean
  maxChannelDiff: number
  pctPixelsDiffering: number
  hasAlpha: boolean
  avgCaptureMs: number
  gpuRenderer: string
}

export async function runBoundary2(host: HostHandle): Promise<Boundary2Result> {
  // Determinism: same frozen t captured twice, in the opacity-animation window (t=0.35 < 0.8).
  const a1 = await captureFrame(host, 0.35)
  const a2 = await captureFrame(host, 0.35)
  const identical = a1.equals(a2)
  const diff = identical ? { maxChannelDiff: 0, pctPixelsDiffering: 0 } : pngDiff(a1, a2)
  const alpha = hasAlpha(a1)

  return {
    identical,
    maxChannelDiff: diff.maxChannelDiff,
    pctPixelsDiffering: diff.pctPixelsDiffering,
    hasAlpha: alpha,
    avgCaptureMs: NaN,
    gpuRenderer: '',
  }
}
```

- [ ] **Step 3: Call it from `src/main.ts`**

In `src/main.ts`, replace the capture smoke block (the `createHost` … `frame-0.35.png` … lines) with:

```ts
  const host = await createHost()
  const { runBoundary2 } = await import('./boundary2')
  const b2 = await runBoundary2(host)
  console.log('[boundary2]', JSON.stringify(b2, null, 2))
```

- [ ] **Step 4: Run in GPU mode (default) and software mode**

Run (GPU): `npm run build:native && npm run build:main && npx electron main.cjs`
Run (software): `npx electron main.cjs --software`
Record `[boundary2]` for both. Expectation: GPU run shows `identical:false` with a small `maxChannelDiff` (~28, the reproduced AA jitter); software run shows **`identical:true`**.

- [ ] **Step 5: Check against GO criteria**

GO (determinism) = **software run `identical === true`** (or, failing exact, `maxChannelDiff` and `pctPixelsDiffering` collapse to far below the GPU run and within the perceptual gate: maxChannelDiff ≤ 48 AND pctPixelsDiffering < 0.5). GO (alpha) = **`hasAlpha === true`**. Record both runs' numbers; the GPU-vs-software contrast is itself the evidence.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/poc/electron-napi/src/pngdiff.ts apps/desktop/poc/electron-napi/src/boundary2.ts apps/desktop/poc/electron-napi/src/main.ts
git commit -m "poc(electron-napi): boundary-2 determinism + alpha (GPU vs software)"
```

---

## Task 6: Boundary 2 — capture speed

**Files:**
- Modify: `apps/desktop/poc/electron-napi/src/boundary2.ts`

**Interfaces:**
- Produces: fills `avgCaptureMs` in `Boundary2Result`.

- [ ] **Step 1: Add the speed measurement**

In `src/boundary2.ts`, add this import at the top:

```ts
import { performance } from 'node:perf_hooks'
```

Then, in `runBoundary2`, replace the `avgCaptureMs: NaN,` line by computing it before the `return` — insert this block right after the `const alpha = hasAlpha(a1)` line:

```ts
  // Speed: warm 3, then time 20 distinct frames across the content window.
  for (let i = 0; i < 3; i++) await captureFrame(host, 0.1 + i * 0.05)
  const times: number[] = []
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    await captureFrame(host, (i / 20) * 0.8)
    times.push(performance.now() - t0)
  }
  const avgCaptureMs = times.reduce((s, x) => s + x, 0) / times.length
```

And change the returned object's `avgCaptureMs: NaN,` to `avgCaptureMs,`.

- [ ] **Step 2: Build + run (both modes)**

Run: `npm run build:main && npx electron main.cjs` then `npx electron main.cjs --software`
Record `avgCaptureMs` for both. Baseline reference: WebView2 CDP ~92 ms/frame.

- [ ] **Step 3: Check against GO criterion**

GO (speed) = **`avgCaptureMs` (software mode) < 300** (usable within the L1-prewarm + L2-bake model). Record the number; if > 300, that triggers risk R2 (capture approach B / GPU + perceptual gate).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/poc/electron-napi/src/boundary2.ts
git commit -m "poc(electron-napi): boundary-2 capture speed measurement"
```

---

## Task 7: Boundary 2 — per-window GPU isolation

**Files:**
- Modify: `apps/desktop/poc/electron-napi/src/boundary2.ts`

**Interfaces:**
- Produces: fills `gpuRenderer` in `Boundary2Result` (the WebGL UNMASKED_RENDERER string of a normal, non-offscreen window in the SAME process).

- [ ] **Step 1: Add the isolation probe**

In `src/boundary2.ts`, add to the top:

```ts
import { BrowserWindow } from 'electron'
```

Then insert this block before the `return` in `runBoundary2`:

```ts
  // Isolation: in the SAME process, does a normal window stay GPU-accelerated
  // while the offscreen capture window renders? Read its WebGL renderer string.
  const probe = new BrowserWindow({ show: false, webPreferences: { offscreen: false } })
  await probe.loadURL('data:text/html,<canvas id=c></canvas>')
  const gpuRenderer = (await probe.webContents.executeJavaScript(`
    (() => {
      const gl = document.getElementById('c').getContext('webgl');
      if (!gl) return 'no-webgl';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no-debug-ext';
    })()
  `)) as string
  probe.destroy()
```

And change the returned object's `gpuRenderer: '',` to `gpuRenderer,`.

- [ ] **Step 2: Build + run (default GPU mode)**

Run: `npm run build:main && npx electron main.cjs`
Record `gpuRenderer`. A real GPU name (e.g. "ANGLE (NVIDIA ...)") = the normal window is hardware-accelerated. "Google SwiftShader" / "no-webgl" = software.

- [ ] **Step 3: Interpret (record, no hard gate)**

Determine the isolation verdict for `results.md`:
- If the **GPU-mode** Boundary-2 capture was already `identical:true` → per-window software is achieved without app-wide disable → **isolation OK** (best case).
- If determinism needed `--software` (app-wide `disableHardwareAcceleration`) AND `gpuRenderer` in default mode is real hardware → software can't be scoped per-window in-process → **isolation needs a separate capture process** (risk R4 fallback). Note this for the migration plan.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/poc/electron-napi/src/boundary2.ts
git commit -m "poc(electron-napi): boundary-2 per-window GPU isolation probe"
```

---

## Task 8: Record results + GO/NO-GO verdict

**Files:**
- Modify: `apps/desktop/poc/electron-napi/src/main.ts`
- Create: `apps/desktop/poc/electron-napi/results.md` (generated, then hand-annotated)

**Interfaces:**
- Consumes: `Boundary1Result`, `Boundary2Result`.
- Produces: `results.md` — the PoC deliverable.

- [ ] **Step 1: Make `main.ts` write `results.md`**

Replace `src/main.ts` with the final version:

```ts
import { app } from 'electron'
import * as fs from 'node:fs'
import { runBoundary1 } from './boundary1'
import { registerMotifSchemePrivileged, registerMotifProtocol } from './protocol'
import { createHost } from './capture'
import { runBoundary2 } from './boundary2'

const useSoftware = process.argv.includes('--software')
if (useSoftware) app.disableHardwareAcceleration()
registerMotifSchemePrivileged()

app.whenReady().then(async () => {
  registerMotifProtocol()
  const mode = useSoftware ? 'software' : 'gpu'

  const b1 = await runBoundary1()
  const host = await createHost()
  const b2 = await runBoundary2(host)

  const block = [
    `## Run: ${mode}`,
    '',
    '### Boundary 1 (napi-rs state)',
    `- p50: ${b1.p50Ms.toFixed(4)} ms  (GO ≤ 1.0)`,
    `- p99: ${b1.p99Ms.toFixed(4)} ms  (GO ≤ 5.0)`,
    `- payload: ${b1.payloadBytes} bytes`,
    `- tickRatio: ${b1.tickRatio.toFixed(3)}  (GO ≥ 0.8 — event loop non-blocking)`,
    `- eventsReceived: ${b1.eventsReceived}  (GO = 5 — TSFN delivery)`,
    '',
    '### Boundary 2 (capture)',
    `- identical: ${b2.identical}  (GO = true in software mode)`,
    `- maxChannelDiff: ${b2.maxChannelDiff}`,
    `- pctPixelsDiffering: ${b2.pctPixelsDiffering.toFixed(4)}%`,
    `- hasAlpha: ${b2.hasAlpha}  (GO = true)`,
    `- avgCaptureMs: ${b2.avgCaptureMs.toFixed(2)} ms  (GO < 300 in software mode)`,
    `- gpuRenderer (normal window): ${b2.gpuRenderer}`,
    '',
  ].join('\n')

  fs.appendFileSync('results.md', block + '\n')
  console.log(block)
  app.quit()
})
```

- [ ] **Step 2: Seed `results.md` header**

Create `apps/desktop/poc/electron-napi/results.md`:

```markdown
# Electron + napi-rs PoC results

Machine: <fill: CPU / GPU / RAM / OS build>
Date: 2026-06-17
Electron: <fill from `npx electron --version`>
napi: <fill from native/Cargo.lock>

<!-- runs appended below -->
```

- [ ] **Step 3: Run both modes to append results**

Run: `npm run build:native && npm run build:main && npx electron main.cjs`
Run: `npx electron main.cjs --software`
Expected: two `## Run:` blocks appended to `results.md`.

- [ ] **Step 4: Hand-annotate the verdict**

Append a `## Verdict` section to `results.md` stating, per boundary, GO / NO-GO against the criteria, and for any NO-GO the triggered risk (R1/R2/R4) and chosen fallback. Fill the `<fill: ...>` placeholders in the header from `npx electron --version`, `native/Cargo.lock`, and machine specs.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/poc/electron-napi/src/main.ts apps/desktop/poc/electron-napi/results.md
git commit -m "poc(electron-napi): results.md with GO/NO-GO verdict"
```

---

## Self-Review

**1. Spec coverage** (against the Phase 0 section of `2026-06-17-electron-napi-migration-design.md`):
- Boundary 1 — round-trip latency → Task 2; event-loop non-blocking → Task 3; TSFN event push → Task 3; serialization cost (payload bytes) → Task 2. ✓
- Boundary 2 — determinism (same frame twice) → Task 5; speed → Task 6; transparency/alpha → Task 5; per-window GPU isolation → Task 7. ✓
- Reuse real runtime + real lower-third → Task 4 (imports `MOTIF_RUNTIME_SOURCE`, serves the catalog dir). ✓
- Throwaway/Windows-only, GO/NO-GO recorded → Global Constraints + Task 8. ✓
- NO-GO fallbacks mapped to risks R1/R2/R4 → Tasks 2/6/7 + Task 8 verdict. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". The only `<fill: ...>` tokens are in `results.md`, which is *output* an operator fills with machine-specific measurements — by design, not plan placeholders. ✓

**3. Type consistency:** `applyMutation`/`heavyMutation`/`subscribeAndFire` names match between `native/src/lib.rs` (snake_case `apply_mutation` → napi auto-camelCases to `applyMutation`) and `boundary1.ts`'s `native` typing. `HostHandle`, `createHost`, `captureFrame` consistent across `capture.ts`/`boundary2.ts`. `Boundary1Result`/`Boundary2Result` field names consistent across producing tasks and `main.ts`'s `results.md` writer. `pngDiff` returns `{maxChannelDiff, pctPixelsDiffering}` consumed verbatim in `boundary2.ts`. ✓

Note for the implementer: napi-rs maps Rust `snake_case` exports to JS `camelCase` by default, so `apply_mutation` is called as `applyMutation`. If the installed napi version does not, check `native/index.d.ts` for the actual exported names and adjust the `native` require typing in `boundary1.ts`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-17-electron-napi-poc.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
