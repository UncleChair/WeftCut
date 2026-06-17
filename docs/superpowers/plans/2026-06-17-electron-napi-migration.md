# Tauri → Electron + napi-rs migration — master plan (S1–S6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the desktop shell from Tauri (system WebView2) to Electron (bundled Chromium) while keeping the Rust domain core in-process via napi-rs, so preview/export/capture run on one engine cross-platform.

**Architecture:** Electron `main` + `preload` + the existing React/Vite/PixiJS `renderer` (unchanged behind compat shims). The Rust `state/audio/jobs/io/export/...` modules move near-verbatim into a napi-rs `cdylib` (`Backend` class), called from `main`. Motif capture uses an Electron offscreen `BrowserWindow` + `webContents.debugger` CDP (validated in Phase 0).

**Tech Stack:** Electron 40+, napi-rs v3 (`napi`/`napi-derive` 3.x, `@napi-rs/cli` 3.6.x, `tokio_rt`), electron-vite (dev/build), electron-builder (packaging), existing Vite 8 / React 19 / Tailwind v4 / PixiJS 8 renderer.

**Phase 0 (PoC) is COMPLETE — both boundaries GO.** See `2026-06-17-electron-napi-migration-design.md` ("Phase 0 outcome") and `apps/desktop/poc/electron-napi/results.md`. Findings folded in below.

## Global Constraints

- **Branch:** `migration/electron-napi`. Never commit migration work to `main`. Stage by explicit path (parallel sessions edit this checkout).
- **Renderer business logic is OUT of scope.** No edits to `apps/desktop/src/**` app code. The only renderer change is redirecting `@tauri-apps/*` imports via **Vite `resolve.alias`** to compat shims under `src/electron-compat/` — the source files keep importing `@tauri-apps/api/core` etc. verbatim.
- **Rust domain logic moves near-verbatim.** Only the Tauri shell (`lib.rs`/`main.rs`/`commands.rs` + `tauri-plugin-*`) is replaced by napi bindings + the Electron main.
- **napi-rs v3 API:** async fn needs the `tokio_rt` feature; expose commands as `Backend` `#[napi] async fn` returning `napi::Result<T>`; events via `ThreadsafeFunction` (`tsfn.call(Ok(v), ThreadsafeFunctionCallMode::NonBlocking)`); Rust `snake_case` → JS `camelCase`. Depend on the addon by package name (not relative path).
- **Serialization:** JSON-string by default (matches current Tauri behavior; ts-rs already describes the shapes); bytes via `Buffer`/`Uint8Array`; selectively upgrade hot/large paths only if measured.
- **Electron security posture:** main window `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, `webSecurity:true`; backend reaches renderer ONLY via a typed `contextBridge` `window.api`; assets/media via `protocol.handle` (streaming + Range).
- **Capture (from PoC):** offscreen `BrowserWindow` + `webContents.debugger` CDP is byte-deterministic in GPU mode — **no software rendering, no separate capture process**. Init order gotcha: load `about:blank` first → attach debugger → `Page.enable`/`Runtime.enable` → `Page.addScriptToEvaluateOnNewDocument` → navigate to `motif:` URL.
- **Node:** v22.20.0 (fnm default, active). Do NOT install Node any other way.
- **Verify versions at scaffold time** (electron, electron-vite, electron-builder, napi) and pin exact; do not use stale majors.
- **Parity oracle:** existing Rust unit tests + ported e2e suite + media-conformance output compare (perceptual gates) + state-replay. Tauri-vs-Electron Motif parity is PERCEPTUAL (different engines), not byte-identical.

---

## S1–S6 Roadmap

Each stage is an independently runnable/testable increment on the migration branch; Tauri is abandoned on the branch from S1. **S1 is detailed below (execution-ready).** S2–S6 are roadmap-level here and each gets its own full bite-sized plan authored just-in-time when it starts — later-stage detail genuinely depends on earlier-stage discoveries (the same PoC→plan→execute→next-plan rhythm already used).

| Stage | Goal | Key dependencies | Exit criteria |
|---|---|---|---|
| **S1** | Electron shell renders the existing React UI on a stub backend | none | App launches via electron-vite; React UI + PixiJS WebGPU canvas render (no white screen); backend calls fail gracefully through the shim |
| **S2** | napi-rs hosts the real Rust state core; load/mutate/query + event bridge | S1 | Real project loads; mutations (move/trim/split/add, undo/redo) work and the UI updates via the `project:changed` TSFN bridge; existing Rust state unit tests pass on the addon build; parity spot-check vs Tauri |
| **S3** | Media + jobs (ffmpeg, import/proxy/conform/thumbnails/waveform, export) | S2 | Import (two-phase proxy), thumbnails/waveform, scrub preview (WebCodecs + `protocol.handle`-served media), end-to-end export (H.264+AV1); media-conformance e2e passes on the Electron build |
| **S4** | Node-side rewrites: MCP→TS SDK, keyring→`safeStorage` | S2 | MCP server starts and an external client calls a tool; cloud transcription works with a `safeStorage`-stored key |
| **S5** | Motif capture (offscreen + debugger CDP) productionized | S2, S3 | Place/preview a Motif (deterministic), export-with-Motifs ("preparing" bake); motif capture e2e passes |
| **S6** | Packaging + cross-platform | S1–S5 | Signed installers for Win/mac/Linux; **cross-platform capture-consistency e2e passes (the original goal proven)**; app runs on all three |

**Cross-cutting (starts at S2): test-driver migration.** Port the e2e harness from tauri-driver + WebdriverIO + msedgedriver to **Playwright-for-Electron or the WebdriverIO Electron service**. The media-conformance / motif / export gates are the parity oracle, so this is a first-class workstream, not an afterthought.

**Cut-over:** at S1–S6 parity, delete the `src-tauri` shell + Tauri deps (domain modules already moved to `native/`), and delete the throwaway `apps/desktop/poc/electron-napi/`.

---

## S1 — Electron shell on a stub backend (DETAILED)

S1 proves the existing renderer runs under Electron with the security posture and the compat-shim strategy, with NO real backend. All work is additive (new `electron/` + `src/electron-compat/` + config + scripts); no `src/**` app code is edited.

### S1 File Structure

```
apps/desktop/
  electron/
    main/index.ts            # app lifecycle, BrowserWindow (security), load renderer
    preload/index.ts         # contextBridge: window.api (invoke/on/off) — stubbed in S1
  src/electron-compat/
    tauri-core.ts            # invoke()  -> window.api.invoke   (aliased from @tauri-apps/api/core)
    tauri-event.ts           # listen()/emit() -> window.api.on (aliased from @tauri-apps/api/event)
    tauri-path.ts            # documentDir() etc. via window.api (stub in S1)
    tauri-window.ts          # getCurrentWindow().minimize()/... via window.api (stub in S1)
    plugin-dialog.ts         # open()/save() (stub in S1)
    plugin-fs.ts             # readFile/writeFile (stub in S1)
    plugin-notification.ts   # (stub in S1)
    plugin-shell.ts          # open() (stub in S1)
  electron.vite.config.ts    # main + preload + renderer (reuses react/tailwind/@ alias) + the @tauri-apps/* aliases
  package.json               # + electron, electron-vite, electron-builder; electron:dev / electron:build scripts
```

The aliasing is the linchpin: the renderer keeps importing `@tauri-apps/api/core` etc., and electron-vite's renderer `resolve.alias` maps each `@tauri-apps/*` specifier to the matching `src/electron-compat/*` shim. **Zero `src/**` app-code edits.**

### Task S1.1: electron-vite config + deps + a window that loads the renderer

**Files:**
- Modify: `apps/desktop/package.json` (add deps + scripts)
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/electron/main/index.ts`

**Interfaces:**
- Produces: `npm run electron:dev` (electron-vite dev) and `npm run electron:build`; a `main` that creates the secured `BrowserWindow` and loads the renderer (dev server in dev, built files in prod).

- [ ] **Step 1: Add deps + scripts to `package.json`**

Add to `devDependencies` (pin the latest stable resolved at install time): `"electron": "^40.0.0"`, `"electron-vite": "^4.0.0"`, `"electron-builder": "^26.0.0"`. Add to `scripts`:
```json
"electron:dev": "electron-vite dev",
"electron:build": "electron-vite build",
"electron:preview": "electron-vite preview"
```
Add a top-level `"main": "out/main/index.js"` field (electron entry).

- [ ] **Step 2: Run install**

Run: `cd apps/desktop && npm install`
Expected: electron, electron-vite, electron-builder resolve; no peer-dep errors that block.

- [ ] **Step 3: Create `electron.vite.config.ts`**

```ts
import path from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const HERE = __dirname
const compat = (m: string) => path.resolve(HERE, 'src/electron-compat', m)

export default defineConfig({
  main: {
    build: { outDir: 'out/main', lib: { entry: 'electron/main/index.ts' } },
  },
  preload: {
    build: { outDir: 'out/preload', lib: { entry: 'electron/preload/index.ts' } },
  },
  renderer: {
    root: HERE,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(HERE, 'src'),
        // Redirect every @tauri-apps/* surface to a compat shim — no src/** edits.
        '@tauri-apps/api/core': compat('tauri-core.ts'),
        '@tauri-apps/api/event': compat('tauri-event.ts'),
        '@tauri-apps/api/path': compat('tauri-path.ts'),
        '@tauri-apps/api/window': compat('tauri-window.ts'),
        '@tauri-apps/plugin-dialog': compat('plugin-dialog.ts'),
        '@tauri-apps/plugin-fs': compat('plugin-fs.ts'),
        '@tauri-apps/plugin-notification': compat('plugin-notification.ts'),
        '@tauri-apps/plugin-shell': compat('plugin-shell.ts'),
      },
    },
    build: {
      target: 'chrome120',
      outDir: 'out/renderer',
      rollupOptions: { input: path.resolve(HERE, 'index.html') },
    },
    server: { port: 1420, strictPort: true },
  },
})
```
(If the installed electron-vite version's config keys differ, align with its docs — the three sections main/preload/renderer and the renderer alias map are the load-bearing parts.)

- [ ] **Step 4: Create `electron/main/index.ts`**

```ts
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

const isDev = !!process.env['ELECTRON_RENDERER_URL']

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  if (isDev) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/package.json apps/desktop/electron.vite.config.ts apps/desktop/electron/main/index.ts
git commit -m "migrate(s1): electron-vite config + secured main window"
```

### Task S1.2: preload contextBridge `window.api` (stub backend)

**Files:**
- Create: `apps/desktop/electron/preload/index.ts`

**Interfaces:**
- Produces: `window.api = { invoke(channel, args?), on(event, cb) => unsubscribe, off(...) }`. In S1, `invoke` rejects with a clear "not implemented" so the UI's catch-paths run instead of white-screening; `on` registers but never fires.

- [ ] **Step 1: Create `electron/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'

type Listener = (payload: unknown) => void

const api = {
  // S1 stub: no backend yet. Reject so callers hit their error/empty paths.
  invoke(channel: string, _args?: unknown): Promise<never> {
    return Promise.reject(new Error(`[stub] backend not wired in S1: ${channel}`))
  },
  // Event subscription: real wiring lands in S2 (TSFN -> main -> webContents.send).
  on(event: string, cb: Listener): () => void {
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(`evt:${event}`, handler)
    return () => ipcRenderer.removeListener(`evt:${event}`, handler)
  },
  off(event: string): void {
    ipcRenderer.removeAllListeners(`evt:${event}`)
  },
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/electron/preload/index.ts
git commit -m "migrate(s1): preload contextBridge window.api (stubbed)"
```

### Task S1.3: compat shims (`@tauri-apps/*` → `window.api`)

**Files:**
- Create: `apps/desktop/src/electron-compat/tauri-core.ts`
- Create: `apps/desktop/src/electron-compat/tauri-event.ts`
- Create: the remaining stubs (`tauri-path.ts`, `tauri-window.ts`, `plugin-dialog.ts`, `plugin-fs.ts`, `plugin-notification.ts`, `plugin-shell.ts`)

**Interfaces:**
- Consumes: `window.api` (Task S1.2).
- Produces: drop-in replacements matching the Tauri APIs the renderer imports — `invoke`, `listen`, `documentDir`, `getCurrentWindow`, dialog `open`/`save`, fs `readFile`/`writeFile`/`writeTextFile`, `isPermissionGranted`/`requestPermission`/`sendNotification`, shell `open`.

- [ ] **Step 1: `tauri-core.ts` — the invoke shim (the one that matters)**

```ts
// Replaces @tauri-apps/api/core for the renderer. The ~70 callers in
// src/ipc/index.ts import { invoke } from here unchanged (via Vite alias).
declare global {
  interface Window {
    api: {
      invoke(channel: string, args?: unknown): Promise<unknown>
      on(event: string, cb: (payload: unknown) => void): () => void
      off(event: string): void
    }
  }
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.api.invoke(cmd, args) as Promise<T>
}
```

- [ ] **Step 2: `tauri-event.ts` — listen/emit shim**

```ts
// Replaces @tauri-apps/api/event. Mirrors the Tauri signature: listen returns
// a Promise<UnlistenFn>. In S1 events never fire (stub on()); S2 wires them.
export interface Event<T> { event: string; id: number; payload: T }
export type UnlistenFn = () => void

export async function listen<T>(
  event: string,
  handler: (e: Event<T>) => void,
): Promise<UnlistenFn> {
  let id = 0
  const unsub = window.api.on(event, (payload) =>
    handler({ event, id: id++, payload: payload as T }),
  )
  return unsub
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  await window.api.invoke(`emit:${event}`, payload as Record<string, unknown>)
}
```

- [ ] **Step 3: Remaining stubs (don't crash on import; real impls land in later stages)**

`tauri-path.ts`:
```ts
export async function documentDir(): Promise<string> {
  return (await window.api.invoke('path:documentDir')) as string
}
```
`tauri-window.ts`:
```ts
function ctl(action: string) {
  return () => window.api.invoke(`window:${action}`)
}
export function getCurrentWindow() {
  return { minimize: ctl('minimize'), toggleMaximize: ctl('toggleMaximize'), close: ctl('close') }
}
```
`plugin-dialog.ts`:
```ts
export async function open(opts?: unknown): Promise<string | string[] | null> {
  return (await window.api.invoke('dialog:open', opts as Record<string, unknown>)) as string | string[] | null
}
export async function save(opts?: unknown): Promise<string | null> {
  return (await window.api.invoke('dialog:save', opts as Record<string, unknown>)) as string | null
}
```
`plugin-fs.ts`:
```ts
export async function readFile(path: string): Promise<Uint8Array> {
  return (await window.api.invoke('fs:readFile', { path })) as Uint8Array
}
export async function writeFile(path: string, data: Uint8Array): Promise<void> {
  await window.api.invoke('fs:writeFile', { path, data })
}
export async function writeTextFile(path: string, data: string): Promise<void> {
  await window.api.invoke('fs:writeTextFile', { path, data })
}
```
`plugin-notification.ts`:
```ts
export async function isPermissionGranted(): Promise<boolean> { return true }
export async function requestPermission(): Promise<'granted'> { return 'granted' }
export function sendNotification(opts: unknown): void {
  void window.api.invoke('notification:send', opts as Record<string, unknown>)
}
```
`plugin-shell.ts`:
```ts
export async function open(target: string): Promise<void> {
  await window.api.invoke('shell:open', { target })
}
```

> If the renderer imports a named export not covered above, add it as a thin `window.api.invoke('<surface>:<name>', ...)` shim in the same file. Confirm the import surface with: `rg "from \"@tauri-apps" apps/desktop/src` and reconcile every named import against these shims.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/electron-compat
git commit -m "migrate(s1): @tauri-apps/* compat shims over window.api"
```

### Task S1.4: boot acceptance

**Files:**
- (No new files; this task is the S1 exit gate.)

**Interfaces:**
- Consumes: everything from S1.1–S1.3.

- [ ] **Step 1: Reconcile the import surface**

Run: `rg "from \"@tauri-apps" apps/desktop/src -o | sort -u`
Expected: every distinct specifier is covered by an alias in `electron.vite.config.ts`. Add any missing alias + a matching shim before proceeding.

- [ ] **Step 2: Launch the Electron dev shell**

Run: `cd apps/desktop && npm run electron:dev`
Expected: Electron launches; the renderer dev server is loaded.

- [ ] **Step 3: Verify the boot acceptance**

In the launched window: the React UI renders (startup screen / timeline / panels) with **no white screen**; the PixiJS WebGPU canvas initializes (no fatal renderer error in the console). Backend-dependent panels may show empty/error states (expected — stub rejects `invoke`); they must not crash the app. Confirm in DevTools console that errors are the stub "backend not wired in S1" rejections, not module-resolution or render crashes.

- [ ] **Step 4: Record the result + commit any alias additions**

If Step 1 required new aliases/shims, commit them:
```bash
git add apps/desktop/electron.vite.config.ts apps/desktop/src/electron-compat
git commit -m "migrate(s1): cover remaining @tauri-apps import surface"
```
Append the boot result (screenshot or console summary) to a short `apps/desktop/electron/S1-NOTES.md`, then:
```bash
git add apps/desktop/electron/S1-NOTES.md
git commit -m "migrate(s1): record boot acceptance"
```

### S1 self-review

- **Coverage:** electron-vite config (S1.1) · secured main window (S1.1) · preload `window.api` (S1.2) · `@tauri-apps/*` → shim aliasing with the invoke/listen shims that the ~70-command `src/ipc/index.ts` and event constants rely on (S1.3) · boot gate with import-surface reconciliation (S1.4). ✓
- **Scope:** no `src/**` app code edited — only additive `electron/`, `src/electron-compat/`, config, scripts. ✓
- **No placeholders:** every shim has a concrete body; the only deferred behavior (events never firing, invoke rejecting) is the explicit S1 stub contract, wired for real in S2. ✓

---

## S2–S6 (roadmap; full plans authored just-in-time)

### S2 — napi-rs state core + event bridge
- Convert the Rust lib to a napi `cdylib`; build the `Backend` class holding the actor handle + managed-state Arcs; expose the `src/ipc/index.ts` command set as `#[napi] async fn` (JSON-string serialization).
- Wire the `project:changed` (+ `app_settings:changed`, `agent_session:changed`, log/import/media-job events) bridge: Rust event sources → `ThreadsafeFunction` → main → `webContents.send('evt:<name>')` → the preload `on()` (replace the S1 stub).
- Replace the preload `invoke` stub with a real `ipcRenderer.invoke('cmd', {channel, args})` → main → `Backend` method dispatch.
- ts-rs ↔ napi `.d.ts` alignment.
- **Exit:** real project load + mutations + undo/redo with live UI updates; existing Rust state unit tests pass on the addon; parity spot-check vs Tauri.

### S3 — media + jobs
- jobs (import/proxy/conform/thumbnails/waveform) stay Rust (ffmpeg-sidecar; ship the ffmpeg binary via electron-builder `extraResources`); job/export progress via TSFN.
- Media served over `protocol.handle` with Range (lifts the `asset://` ceiling); decide the export `videosink` transport (keep WS vs IPC/Buffer).
- **Exit:** import → thumbnails/waveform → scrub preview (WebCodecs) → end-to-end export (H.264+AV1); media-conformance e2e on Electron.

### S4 — Node-side rewrites
- MCP → `@modelcontextprotocol/sdk` (TS), re-exposing the tool surface against `Backend`; verify external client compat (resolves the rmcp 0.1.x pin).
- API-key storage → Electron `safeStorage`; cloud HTTP stays Rust (reqwest).
- **Exit:** MCP server up + an external client calls a tool; cloud transcription with a `safeStorage` key.

### S5 — Motif capture
- Productionize the PoC capture host: offscreen `BrowserWindow` + `webContents.debugger` CDP (about:blank-first init), `protocol.handle('motif')` path-safe serving, repoint the JS fill loops; Rust Motif brain (catalog/store/keys/staleness/watcher) via napi.
- **Exit:** place/preview a Motif (deterministic), export-with-Motifs; motif capture e2e passes.

### S6 — packaging + cross-platform
- electron-builder (Win NSIS → mac dmg/notarization → Linux AppImage/deb); napi-rs cross-platform prebuilds (CI matrix); per-platform ffmpeg; signing + auto-update.
- Add the determinism **negative control** (a known-jittery on-screen config) to prove the test's sensitivity, then the cross-platform capture-consistency e2e.
- **Exit:** signed installers for 3 OSes; cross-platform capture consistency proven; app runs everywhere.

---

## Execution note

S1 is execution-ready. S2–S6 each get a full bite-sized plan (like this S1 section) authored when they start, informed by the prior stage's results. Use subagent-driven-development per stage, with the test-driver migration running alongside from S2.
