# S6 — Migration completion (cross-platform + cut-over) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Electron + napi-rs build runs and captures deterministically on Windows, Linux, and macOS; close the remaining Electron-vs-Tauri functional gaps; and delete the Tauri shell.

**Architecture:** A GitHub Actions matrix builds the napi addon + bundles ffmpeg + builds the Electron app + runs the test suites and a new cross-platform determinism gate on all three OSes. Local code tasks (drag-drop, PerfHUD, safeStorage, MCP panel) close parity gaps. The Tauri shell is removed last, after everything is green.

**Tech Stack:** Electron 42, electron-vite 6, electron-builder 26, napi-rs v3, ffmpeg-sidecar 2.5, GitHub Actions, Playwright-for-Electron, `pngjs` (new devDep for image SSIM).

## Global Constraints

- **Branch:** `migration/electron-napi`. Never commit to `main`. Stage by explicit path (parallel sessions edit this checkout) — re-check `git status` before each commit.
- **Spec:** `docs/superpowers/specs/2026-06-18-electron-napi-s6-migration-completion-design.md`.
- **No release machinery.** Unsigned installers only. No signing, notarization, auto-update, branding, or store work in S6.
- **No new product features.** S6 ships exactly today's functionality.
- **Build features:** the napi addon always builds with `--features jobs,export,mcp,cloud,motifs`.
- **E2E builds require `VITE_WEFTCUT_E2E=1`** at `electron:build` time, or the `__weftcutTest` hooks are stripped and hook-driven specs time out.
- **Node:** v22.20.0 (fnm default). Do not install Node any other way.
- **Determinism gate:** force software rendering on every OS (`--disable-gpu --use-gl=swiftshader`); perceptual SSIM, seed threshold **0.98**, tune from the first CI run; a negative control must fall below threshold.
- **Cut-over is the LAST task**, gated on all prior tasks green.
- **`src/**` edits are forbidden except where a task explicitly sanctions one** (Task 4 drag-drop branch; Task 6 ConnectAgentPanel + ipc type + locales). `electron-compat/` shim code is migration code, not `src/**` app code, and is always in scope.

---

## Task 1: electron-builder config + unsigned packaging

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/package.json` (add `electron-builder` devDep + `package` script)
- Test: manual — produce + launch an installer on the current OS (Windows).

**Interfaces:**
- Consumes: the `out/{main,preload,renderer}` bundle from `electron:build`; the napi `.node` resolved from `@weftcut/core` (`file:src-tauri`).
- Produces: `release/` unsigned installers; an `npm run package` script.

- [ ] **Step 1: Add the devDep + script**

In `apps/desktop/package.json`, add to `devDependencies`: `"electron-builder": "^26.0.0"` (pin the exact latest at install). Add to `scripts`:
```json
"package": "npm run napi:build && npm run electron:build && electron-builder --publish never"
```

- [ ] **Step 2: Install**

Run: `cd apps/desktop && npm install`
Expected: electron-builder resolves; no blocking peer-dep errors.

- [ ] **Step 3: Create `apps/desktop/electron-builder.yml`**

```yaml
appId: dev.weftcut.desktop
productName: WeftCut
directories:
  output: release
  buildResources: build
files:
  - out/**
  - package.json
  - "!**/*.map"
asarUnpack:
  - "**/*.node"
extraResources:
  - from: resources/ffmpeg/${os}
    to: ffmpeg
    filter: ["**/*"]
win:
  target: [nsis]
  artifactName: ${productName}-${version}-${arch}.${ext}
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
linux:
  target: [AppImage, deb]
  category: AudioVideo
  artifactName: ${productName}-${version}-${arch}.${ext}
mac:
  target: [dmg]
  category: public.app-category.video
  identity: null   # unsigned in S6; ad-hoc
```
Note: `${os}` in `extraResources.from` resolves to `win`/`linux`/`mac` at build time, matching the per-OS folders Task 2 populates. The `@weftcut/core` addon ships because it is a production dependency reached from `out/main`; `asarUnpack: **/*.node` keeps the native binary executable.

- [ ] **Step 4: Create a placeholder ffmpeg resource dir so packaging doesn't fail pre-Task-2**

Run: `mkdir -p apps/desktop/resources/ffmpeg/win apps/desktop/resources/ffmpeg/linux apps/desktop/resources/ffmpeg/mac`
Add `apps/desktop/resources/ffmpeg/.gitkeep` (commit the empty dirs; the binaries themselves are fetched in CI / Task 2, not committed). Add `apps/desktop/resources/ffmpeg/*/ffmpeg*` to `apps/desktop/.gitignore`.

- [ ] **Step 5: Build the installer locally (Windows)**

Run: `cd apps/desktop && npm run package`
Expected: `release/WeftCut-0.0.0-x64.exe` (NSIS) is produced. Install it; the app launches and the startup screen renders. (ffmpeg-dependent features won't work until Task 2; that's expected here.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron-builder.yml apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/.gitignore apps/desktop/resources/ffmpeg/.gitkeep
git commit -m "migrate(s6): electron-builder config + unsigned packaging script"
```

---

## Task 2: ffmpeg bundling + runtime PATH injection

**Files:**
- Modify: `apps/desktop/electron/main/index.ts` (prepend bundled ffmpeg dir to PATH before `new Backend`)
- Create: `apps/desktop/scripts/fetch-ffmpeg.mjs` (downloads a static ffmpeg for one OS)
- Modify: `apps/desktop/package.json` (a `fetch-ffmpeg` script)
- Test: manual — run an export from a packaged build and confirm it uses the bundled binary.

**Interfaces:**
- Consumes: `process.resourcesPath` (packaged) / `resources/ffmpeg/<os>` (dev).
- Produces: ffmpeg on `process.env.PATH` for the in-process addon; ffmpeg-sidecar's PATH fallback (`ffmpeg_path()` → `"ffmpeg"`) then resolves it. **No Rust change.**

- [ ] **Step 1: Add the PATH-prepend in `main`, before `new Backend(...)`**

In `apps/desktop/electron/main/index.ts`, inside `app.whenReady().then(async () => {` and BEFORE `backend = new Backend(...)`:
```ts
// Bundled ffmpeg: ffmpeg-sidecar resolves "ffmpeg" via PATH when no binary sits
// adjacent to the exe (paths.rs::ffmpeg_path). Prepend the packaged dir so the
// in-process addon spawns OUR static build, not a system one. Dev (unpackaged)
// has no bundled dir → falls back to system/auto-download as before.
const ffmpegDir = app.isPackaged
  ? path.join(process.resourcesPath, 'ffmpeg')
  : path.join(__dirname, '../../resources/ffmpeg', process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux')
const ffmpegBin = path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
if (fs.existsSync(ffmpegBin)) {
  process.env.PATH = ffmpegDir + path.delimiter + (process.env.PATH ?? '')
  console.log(`[main] bundled ffmpeg on PATH: ${ffmpegBin}`)
}
```

- [ ] **Step 2: Create `apps/desktop/scripts/fetch-ffmpeg.mjs`**

```js
// Downloads a static ffmpeg for the host OS into resources/ffmpeg/<os>/.
// Sources: Windows = gyan.dev; Linux = johnvansickle; macOS = evermeet.
// Used by CI (and locally) to populate extraResources before packaging.
import { existsSync, mkdirSync, createWriteStream, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const plat = process.platform
const osDir = plat === 'win32' ? 'win' : plat === 'darwin' ? 'mac' : 'linux'
const dest = join(HERE, '..', 'resources', 'ffmpeg', osDir)
const bin = join(dest, plat === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
mkdirSync(dest, { recursive: true })
if (existsSync(bin)) { console.log(`ffmpeg already present: ${bin}`); process.exit(0) }

// Use ffmpeg-sidecar's own downloader via npx? No — fetch a known static build.
// Implementer: pick the current stable static URLs; extract the single `ffmpeg`
// (and on win, `ffmpeg.exe`) binary into `dest`. Example (Linux):
//   curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar xJ
//   then copy the extracted ffmpeg to `bin`.
// (Concrete per-OS commands live in the CI workflow, Task 8, which is the
//  authoritative fetch path; this script mirrors them for local packaging.)
console.error('fetch-ffmpeg: implement per-OS download (see Task 8 CI for the exact URLs)')
process.exit(1)
```
Add to `package.json` scripts: `"fetch-ffmpeg": "node scripts/fetch-ffmpeg.mjs"`.

> Rationale for the split: the **authoritative** ffmpeg fetch is the CI workflow (Task 8 Step 3), which pins exact per-OS URLs and runs on every build. This local script is a convenience mirror; keeping the exact URLs in one place (CI) avoids drift. CI does not call this script — it fetches inline.

- [ ] **Step 3: Verify locally on Windows**

Fetch a Windows static ffmpeg manually into `apps/desktop/resources/ffmpeg/win/ffmpeg.exe` (gyan.dev full build), then:
Run: `cd apps/desktop && npm run package` → install → import a video → export.
Expected: export succeeds; `[main] bundled ffmpeg on PATH:` appears in the app log; no auto-download attempt.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/main/index.ts apps/desktop/scripts/fetch-ffmpeg.mjs apps/desktop/package.json
git commit -m "migrate(s6): bundle ffmpeg via PATH-prepend (no Rust change)"
```

---

## Task 3: Linux safeStorage plaintext-fallback handling

**Files:**
- Modify: `apps/desktop/electron/main/keys.ts` (warn when encryption unavailable)
- Modify: `apps/desktop/electron/main/index.ts` (surface a one-time notice)
- Test: `apps/desktop/e2e/electron/s6-safestorage.spec.ts` (assert the warning path is reachable; full Linux behavior verified in CI).

**Interfaces:**
- Consumes: Electron `safeStorage.isEncryptionAvailable()`.
- Produces: a startup log warning + a `evt:app:notice` event when encryption is unavailable. `keys.ts` already gates writes on safeStorage; this adds the visibility.

- [ ] **Step 1: Read the current keys.ts encryption check**

Run: `rg "isEncryptionAvailable|safeStorage" apps/desktop/electron/main/keys.ts`
Expected: confirm where keys are read/written and whether `isEncryptionAvailable()` is already consulted. (Implementer reconciles the exact insertion point from this output.)

- [ ] **Step 2: Add the warning in `keys.ts`**

Export a helper used by main:
```ts
import { safeStorage } from 'electron'

/// True when the OS keyring backs safeStorage. False on Linux without a
/// keyring (headless CI, minimal containers) → key material persists in
/// plaintext. Callers should warn + degrade, never hard-fail.
export function encryptionAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}
```

- [ ] **Step 3: Surface it once at startup in `index.ts`**

After `await backend.init()` in `app.whenReady`:
```ts
const { encryptionAvailable } = await import('./keys.js')
if (!encryptionAvailable()) {
  console.warn('[main] OS keyring unavailable — cloud API keys persist in PLAINTEXT (cloud_keys.json). Secure your userData dir or install a keyring (libsecret/kwallet).')
  // One-time UI notice (renderer shows it via the existing notice path).
  mainWindow?.webContents.send('evt:app:notice', {
    level: 'warn',
    code: 'keyring_unavailable',
  })
}
```
(The `evt:app:notice` payload is consumed by the renderer's existing notice handling; if no handler exists for this code, the log line is the floor and the event is a no-op — acceptable, do not add a `src/**` handler in S6.)

- [ ] **Step 4: Write the spec**

`apps/desktop/e2e/electron/s6-safestorage.spec.ts`:
```ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'

test('startup logs a keyring warning when encryption is unavailable', async () => {
  const logs: string[] = []
  const app = await electron.launch({ args: [path.join(__dirname, '../../out/main/index.js')] })
  app.process().stdout?.on('data', (d) => logs.push(String(d)))
  await app.firstWindow()
  // On Windows/macOS dev runners encryption IS available → no warning (pass).
  // On Linux CI without a keyring → warning present. Assert the code path is
  // wired: either available (no warn) or unavailable (warn present).
  await new Promise((r) => setTimeout(r, 1500))
  const warned = logs.join('').includes('OS keyring unavailable')
  const { available } = await app.evaluate(async ({ safeStorage }) => ({
    available: safeStorage.isEncryptionAvailable(),
  }))
  expect(warned).toBe(!available)
  await app.close()
})
```

- [ ] **Step 5: Build + run the spec**

Run: `cd apps/desktop && VITE_WEFTCUT_E2E=1 npm run electron:build && npm run e2e:electron -- --grep safestorage`
Expected: PASS on Windows (encryption available → no warning, assertion `warned === false`).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/keys.ts apps/desktop/electron/main/index.ts apps/desktop/e2e/electron/s6-safestorage.spec.ts
git commit -m "migrate(s6): warn + degrade on Linux safeStorage plaintext fallback"
```

---

## Task 4: Drag-drop import on Electron (the cut-over blocker)

**Files:**
- Modify: `apps/desktop/electron/preload/index.ts` (expose `getPathForFile`)
- Modify: `apps/desktop/electron/main/index.ts` (add `media:dropped` handler)
- Modify: `apps/desktop/src/App.tsx` (`MediaDropZone.onDrop` Electron branch — **the one sanctioned `src/**` edit**)
- Test: `apps/desktop/e2e/electron/s6-dragdrop.spec.ts`

**Interfaces:**
- Consumes: Electron `webUtils.getPathForFile(file)`; the existing `media:external-drop` renderer listener (`App.tsx:944`) → `importPaths` → `importMedia`.
- Produces: `window.api.getPathForFile(file): string`; a `media:dropped` IPC channel; an Electron path in `onDrop` that feeds `media:external-drop`.

- [ ] **Step 1: Expose `getPathForFile` in preload**

In `apps/desktop/electron/preload/index.ts`, add `import { contextBridge, ipcRenderer, webUtils } from 'electron'` and add to the `api` object:
```ts
  // Electron drops give File objects, not paths. webUtils.getPathForFile is the
  // sanctioned API (File.path was removed). Per-File (not FileList) is reliable
  // across the contextBridge boundary.
  getPathForFile(file: File): string {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },
```

- [ ] **Step 2: Add the `media:dropped` handler in main**

In `apps/desktop/electron/main/index.ts`, alongside the other `ipcMain.handle` calls:
```ts
// Drag-drop import: the renderer resolves real paths via webUtils and posts
// them here; we re-emit the SAME event the Tauri media_drop.rs path emitted,
// so the renderer's existing media:external-drop listener handles them.
ipcMain.handle('media:dropped', (_e, paths: string[]) => {
  if (Array.isArray(paths) && paths.length > 0) {
    mainWindow?.webContents.send('evt:media:external-drop', paths)
  }
})
```

- [ ] **Step 3: Write the failing e2e test**

`apps/desktop/e2e/electron/s6-dragdrop.spec.ts`:
```ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'

test('a media file dropped on the pool imports via media:external-drop', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '../../out/main/index.js')] })
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof (window as any).api?.getPathForFile === 'function')
  const media = process.env.WEFTCUT_TEST_MEDIA
  expect(media, 'set WEFTCUT_TEST_MEDIA to a sample video').toBeTruthy()
  // Simulate the resolved-path path of the Electron drop branch directly:
  // the renderer's listener should import when media:external-drop fires.
  const before = await page.evaluate(() => (window as any).api.invoke('project_summary', {}))
  await page.evaluate((p) => (window as any).api.invoke('media:dropped', [p]), media)
  await page.waitForTimeout(2000)
  const after = await page.evaluate(() => (window as any).api.invoke('project_summary', {}))
  expect((after as any).media_count ?? 0).toBeGreaterThan((before as any).media_count ?? 0)
  await app.close()
})
```
(This exercises the main→renderer→import chain end-to-end. The DOM-level drop is verified manually in Step 7 since Playwright can't synthesize an OS file-drop with backing paths.)

- [ ] **Step 4: Build + run — verify it FAILS first**

Run: `cd apps/desktop && VITE_WEFTCUT_E2E=1 npm run electron:build && WEFTCUT_TEST_MEDIA=<abs path> npm run e2e:electron -- --grep dragdrop`
Expected: FAIL (no `media:dropped` handler yet → no import). If you ran Step 2 already, instead confirm it PASSES and treat Step 2 as the implementation.

- [ ] **Step 5: Add the Electron branch in `MediaDropZone.onDrop` (App.tsx)**

In `apps/desktop/src/App.tsx`, in `MediaDropZone`'s `onDrop`, BEFORE the existing `window.chrome.webview` block:
```ts
        // Electron: no WebView2 postMessage bridge. Resolve real paths via the
        // preload webUtils shim and feed the same media:external-drop pipeline.
        const eapi = (window as unknown as { api?: { getPathForFile?: (f: File) => string; invoke: (c: string, a?: unknown) => Promise<unknown> } }).api
        if (eapi?.getPathForFile && e.dataTransfer.files.length > 0) {
          const paths = Array.from(e.dataTransfer.files)
            .map((f) => eapi.getPathForFile!(f))
            .filter((p) => p.length > 0)
          if (paths.length > 0) void eapi.invoke('media:dropped', paths)
          return
        }
```
(The existing `window.chrome.webview` block remains as the Tauri fallback until cut-over removes it.)

- [ ] **Step 6: Run the e2e — verify it PASSES**

Run: `WEFTCUT_TEST_MEDIA=<abs path> npm run e2e:electron -- --grep dragdrop`
Expected: PASS (media_count grows).

- [ ] **Step 7: Manual DOM drop verification**

Run the built app; drag a video file from the OS file manager onto the media pool. Expected: it imports (the drop highlight shows, the item appears). This confirms the full `onDrop` → `getPathForFile` → `media:dropped` → `media:external-drop` chain with a real OS drop.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/electron/preload/index.ts apps/desktop/electron/main/index.ts apps/desktop/src/App.tsx apps/desktop/e2e/electron/s6-dragdrop.spec.ts
git commit -m "migrate(s6): Electron drag-drop import via webUtils.getPathForFile"
```

---

## Task 5: PerfHUD secondary window (real BrowserWindow)

**Files:**
- Create: `apps/desktop/electron/main/windows.ts` (secondary-window manager)
- Modify: `apps/desktop/electron/main/index.ts` (register `win:*` IPC handlers)
- Modify: `apps/desktop/electron/preload/index.ts` (no change if `invoke` covers `win:*`) — verify routing
- Modify: `apps/desktop/src/electron-compat/tauri-webview-window.ts` (wire the stub to IPC)
- Test: `apps/desktop/e2e/electron/s6-perfhud.spec.ts`

**Interfaces:**
- Consumes: the renderer's `WebviewWindow` class usage (`new WebviewWindow(label, options)` + `show/hide/close/center`, `WebviewWindow.getByLabel`).
- Produces: `win:create/win:act/win:exists` IPC channels backed by a real `BrowserWindow` keyed by label; loads the renderer at the **caller-provided `url`** (PerfHUD passes `url:'/?perfHud=1'`, which `main.tsx` detects to render `<PerfHUDWindow/>`).

- [ ] **Step 1: The renderer's window discrimination (verified 2026-06-18)**

`main.tsx:21` renders the HUD when the URL query has `perfHud=1`: `new URLSearchParams(window.location.search).get('perfHud') === '1'` → `{isPerfHudWindow ? <PerfHUDWindow/> : <Root/>}`. The PerfHUD is opened by `src/render/PerfHUD.tsx:885 openPerfHudWindow` → `new WebviewWindow(PERF_HUD_WINDOW_LABEL, { url: '/?perfHud=1', width, height, ... })`. So the shim must **pass the caller's `url` through** to the secondary window — do NOT invent a `?window=<label>` discriminator. (A second consumer, `App.tsx:1552 openRenderPlayPopup`, passes `url:'/render-play.html#...'`; `render-play.html` is NOT a built vite entry, so render-play is a separate pre-existing gap — OUT of this task's scope; the generic url pass-through is correct for it too if/when that entry is added.) Confirm `PERF_HUD_WINDOW_LABEL`'s value and the `WebviewWindow` instance methods the renderer calls (`new`, `.once('tauri://error', cb)`, `getByLabel`) so the shim covers them.

- [ ] **Step 2: Create the window manager `apps/desktop/electron/main/windows.ts`**

```ts
import path from 'node:path'
import { BrowserWindow } from 'electron'

const wins = new Map<string, BrowserWindow>()
const isDev = !!process.env['ELECTRON_RENDERER_URL']

type SecondaryOpts = { url?: string; width?: number; height?: number; title?: string }
export function createSecondary(label: string, opts?: SecondaryOpts): void {
  let win = wins.get(label)
  if (win && !win.isDestroyed()) { win.show(); return }
  win = new BrowserWindow({
    width: opts?.width ?? 480,
    height: opts?.height ?? 320,
    title: opts?.title,
    show: false,
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  })
  wins.set(label, win)
  win.on('closed', () => wins.delete(label))
  // Pass the caller's renderer-relative url straight through (e.g. '/?perfHud=1').
  const rel = opts?.url ?? '/'
  if (isDev) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']! + rel)
  } else {
    const u = new URL(rel, 'http://x') // parse path/search/hash of the relative url
    const file = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, '')
    // Reconcile loadFile's option semantics against the installed Electron 42:
    // `search` is the query string (sans leading '?'), `hash` the fragment (sans '#').
    void win.loadFile(path.join(__dirname, '../renderer', file), {
      search: u.search ? u.search.slice(1) : undefined,
      hash: u.hash ? u.hash.slice(1) : undefined,
    })
  }
  win.once('ready-to-show', () => win!.show())
}
export function actOnSecondary(label: string, action: 'show' | 'hide' | 'close' | 'center'): void {
  const win = wins.get(label)
  if (!win || win.isDestroyed()) return
  if (action === 'show') win.show()
  else if (action === 'hide') win.hide()
  else if (action === 'close') win.close()
  else if (action === 'center') win.center()
}
export function secondaryExists(label: string): boolean {
  const win = wins.get(label)
  return !!win && !win.isDestroyed()
}
```

- [ ] **Step 3: Register `win:*` handlers in `index.ts`**

```ts
const { createSecondary, actOnSecondary, secondaryExists } = await import('./windows.js')
ipcMain.handle('win:create', (_e, { label, options }: { label: string; options?: { url?: string; width?: number; height?: number; title?: string } }) => createSecondary(label, options))
ipcMain.handle('win:act', (_e, { label, action }: { label: string; action: 'show' | 'hide' | 'close' | 'center' }) => actOnSecondary(label, action))
ipcMain.handle('win:exists', (_e, { label }: { label: string }) => secondaryExists(label))
```

- [ ] **Step 4: Route `win:*` in preload**

In `apps/desktop/electron/preload/index.ts`, add `channel.startsWith('win:')` to the direct-route condition in `invoke` (so `win:*` go straight to `ipcMain`, like `window:*`):
```ts
    if (
      channel.startsWith('window:') ||
      channel.startsWith('win:') ||
      channel.startsWith('path:') ||
      // ...existing...
```

- [ ] **Step 5: Wire the compat shim to IPC**

Replace the no-op body of `apps/desktop/src/electron-compat/tauri-webview-window.ts`:
```ts
// Replaces @tauri-apps/api/webviewWindow. Backed by a real Electron secondary
// BrowserWindow via win:* IPC (electron/main/windows.ts).
declare global {
  interface Window { api: { invoke(c: string, a?: unknown): Promise<unknown> } }
}
export class WebviewWindow {
  constructor(public readonly label: string, options?: Record<string, unknown>) {
    void window.api.invoke('win:create', { label, options })
  }
  async show(): Promise<void> { await window.api.invoke('win:act', { label: this.label, action: 'show' }) }
  async hide(): Promise<void> { await window.api.invoke('win:act', { label: this.label, action: 'hide' }) }
  async close(): Promise<void> { await window.api.invoke('win:act', { label: this.label, action: 'close' }) }
  async center(): Promise<void> { await window.api.invoke('win:act', { label: this.label, action: 'center' }) }
  // The renderer calls win.once('tauri://error', cb) to surface create failures;
  // Electron secondary-window errors aren't bridged here, so this is a no-op
  // (any load failure logs in main). Keep the signature so callers don't throw.
  once(_event: string, _cb: (...a: unknown[]) => void): void { /* no-op */ }
  static getByLabel(_label: string): WebviewWindow | null { return null }
}
```
Note: `electron-compat/` is NOT `src/**` app code — it is migration shim code and is in scope.

- [ ] **Step 6: Write the e2e test**

`apps/desktop/e2e/electron/s6-perfhud.spec.ts`:
```ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'

test('a secondary window opens and closes via win:* IPC', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '../../out/main/index.js')] })
  const main = await app.firstWindow()
  await main.evaluate(() => (window as any).api.invoke('win:create', { label: 'perf-hud', options: { url: '/?perfHud=1' } }))
  await main.evaluate(() => (window as any).api.invoke('win:act', { label: 'perf-hud', action: 'show' }))
  await expect.poll(() => app.windows().length).toBe(2)
  const exists = await main.evaluate(() => (window as any).api.invoke('win:exists', { label: 'perf-hud' }))
  expect(exists).toBe(true)
  await main.evaluate(() => (window as any).api.invoke('win:act', { label: 'perf-hud', action: 'close' }))
  await expect.poll(() => app.windows().length).toBe(1)
  await app.close()
})
```

- [ ] **Step 7: Build + run**

Run: `cd apps/desktop && VITE_WEFTCUT_E2E=1 npm run electron:build && npm run e2e:electron -- --grep perfhud`
Expected: PASS (window count goes 1→2→1).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/electron/main/windows.ts apps/desktop/electron/main/index.ts apps/desktop/electron/preload/index.ts apps/desktop/src/electron-compat/tauri-webview-window.ts apps/desktop/e2e/electron/s6-perfhud.spec.ts
git commit -m "migrate(s6): real PerfHUD secondary window via win:* IPC"
```

---

## Task 6: ConnectAgentPanel SSE → streamable-HTTP

**Files:**
- Modify: `apps/desktop/electron/main/mcp/index.ts` (`McpInfoView` + `getInfo`)
- Modify: `apps/desktop/src/ipc/index.ts:1039-1041` (the `McpInfoView` type)
- Modify: `apps/desktop/src/connect/ConnectAgentPanel.tsx`
- Modify: `apps/desktop/src/i18n/locales/en-US.ts` + `zh-CN.ts` (`connect.*`)
- Test: `apps/desktop/e2e/electron/s4a-mcp.spec.ts` already asserts connect-with-token; add a field-shape assertion.

**Interfaces:**
- Consumes: the single streamable-HTTP `url` (`http://127.0.0.1:<port>/mcp`).
- Produces: `McpInfoView { bind, url, bearer_token }` (drops `sse_url`/`message_url`/`events_url`).

> This edits `src/**` (ConnectAgentPanel + ipc type + locales). It is a genuine UI correctness fix, not a migration shim — but the renderer's MCP info shape is wrong on Electron (still SSE). Treat as in-scope correctness; it is NOT new functionality. If you prefer strict no-`src/**`, this task may be deferred to a follow-up — but the spec includes it.

- [ ] **Step 1: Reshape `McpInfoView` + `getInfo` in `electron/main/mcp/index.ts`**

```ts
export interface McpInfoView {
  bind: string
  url: string
  bearer_token: string
}
// ...in getInfo():
    getInfo(): McpInfoView {
      return { bind: `127.0.0.1:${port}`, url, bearer_token: auth.token }
    },
```

- [ ] **Step 2: Update the renderer type `src/ipc/index.ts:1039`**

Replace the three URL fields with `url: string`:
```ts
  bind: string;
  url: string;
  bearer_token: string;
```

- [ ] **Step 3: Update `ConnectAgentPanel.tsx`**

Replace `info.sse_url` / `info.events_url` usages with `info.url`; replace the SSE `curl -N ...` snippet with the streamable-HTTP config block (mirror the `[mcp] connect:` log):
```tsx
const snippet = JSON.stringify(
  { mcpServers: { weftcut: { url: info.url, headers: { Authorization: `Bearer ${info.bearer_token}` } } } },
  null, 2,
)
```
Remove the `connect.field.sse_url` / `connect.field.events_url` rows; keep a single URL field labeled `connect.field.url`.

- [ ] **Step 4: Update locales**

In `en-US.ts` and `zh-CN.ts`, under `connect.field`, replace `sse_url`/`events_url` with `url`:
- en: `url: "Server URL"`
- zh: `url: "服务器地址"`
(Reconcile any other `connect.*` strings that reference SSE.)

- [ ] **Step 5: Add a field-shape assertion to `s4a-mcp.spec.ts`**

After the existing connect block:
```ts
const info = await page.evaluate(() => (window as any).api.invoke('get_mcp_info', {}))
expect(info).toHaveProperty('url')
expect(info).not.toHaveProperty('sse_url')
expect((info as any).url).toMatch(/\/mcp$/)
```

- [ ] **Step 6: Build + run**

Run: `cd apps/desktop && VITE_WEFTCUT_E2E=1 npm run electron:build && npm run e2e:electron -- --grep "MCP client"`
Expected: PASS (connect + new field shape).

- [ ] **Step 7: Typecheck the renderer**

Run: `cd apps/desktop && npm run typecheck`
Expected: no errors (the `McpInfoView` field rename is consistent across `ipc/index.ts` + `ConnectAgentPanel.tsx`).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/electron/main/mcp/index.ts apps/desktop/src/ipc/index.ts apps/desktop/src/connect/ConnectAgentPanel.tsx apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts apps/desktop/e2e/electron/s4a-mcp.spec.ts
git commit -m "migrate(s6): ConnectAgentPanel + McpInfoView to streamable-HTTP url"
```

---

## Task 7: Determinism harness (capture spec + negative control + compare tool)

**Files:**
- Create: `apps/desktop/e2e/electron/s6-determinism.spec.ts` (per-OS capture → PNGs)
- Create: `apps/desktop/e2e/lib/image-ssim.mjs` (grayscale SSIM over two PNGs)
- Create: `apps/desktop/e2e/lib/compare-determinism.mjs` (cross-OS comparison CLI)
- Modify: `apps/desktop/package.json` (add `pngjs` devDep)
- Test: the spec runs locally (captures the host OS); the cross-OS compare runs in CI (Task 8).

**Interfaces:**
- Consumes: `window.api.invoke('motif_capture_frame', { motifId, tSec, propsJson, width, height, settleRafs, contentHash })` → base64 PNG (no `data:` prefix); the motif authoring commands (`write_motif_draft`/`install_motif`) used by `s5-motif-lifecycle.spec.ts` for the jitter motif.
- Produces: `determinism-artifacts/<platform>/<case>.png`; `compare-determinism.mjs` exits non-zero if any positive pair < threshold or the negative control ≥ threshold.

- [ ] **Step 1: Add `pngjs`**

Run: `cd apps/desktop && npm install -D pngjs`

- [ ] **Step 2: Create `e2e/lib/image-ssim.mjs`**

```js
import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'

function gray(png) {
  const { width, height, data } = png
  const out = new Float64Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
    out[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }
  return { g: out, width, height }
}

// Global SSIM (single window over the whole image). Sufficient for a
// same-engine software-render comparison; returns 1.0 for identical inputs.
export function ssimOfPngFiles(pathA, pathB) {
  const a = gray(PNG.sync.read(readFileSync(pathA)))
  const b = gray(PNG.sync.read(readFileSync(pathB)))
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const n = a.g.length
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) { ma += a.g[i]; mb += b.g[i] }
  ma /= n; mb /= n
  let va = 0, vb = 0, cov = 0
  for (let i = 0; i < n; i++) {
    const da = a.g[i] - ma, db = b.g[i] - mb
    va += da * da; vb += db * db; cov += da * db
  }
  va /= n - 1; vb /= n - 1; cov /= n - 1
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2
  return ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
}
```

- [ ] **Step 3: Create the capture spec `e2e/electron/s6-determinism.spec.ts`**

```ts
import { test, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'

// Fixed positive cases (built-in motifs) + one negative-control jitter motif.
const POSITIVE = [
  { id: 'countdown', t: 2.0 },
  { id: 'lower-third-simple', t: 1.0 },
  { id: 'title-card', t: 1.5 },
]
const W = 480, H = 480

test('capture fixed motif frames for cross-OS comparison', async () => {
  const outDir = path.join(__dirname, '../../determinism-artifacts', process.platform)
  fs.mkdirSync(outDir, { recursive: true })
  const app = await electron.launch({
    args: [
      path.join(__dirname, '../../out/main/index.js'),
      '--disable-gpu', '--use-gl=swiftshader', '--in-process-gpu',
    ],
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof (window as any).api?.invoke === 'function')

  const cap = async (motifId: string, tSec: number, propsJson = '{}') =>
    (await page.evaluate(
      ([id, t, props, w, h]) =>
        (window as any).api.invoke('motif_capture_frame', {
          motifId: id, tSec: t, propsJson: props, width: w, height: h,
          settleRafs: 3, contentHash: 'det',
        }),
      [motifId, tSec, propsJson, W, H] as const,
    )) as string

  for (const c of POSITIVE) {
    const b64 = await cap(c.id, c.t)
    fs.writeFileSync(path.join(outDir, `${c.id}.png`), Buffer.from(b64, 'base64'))
  }

  // Negative control: install a jitter motif that reads Math.random per frame,
  // so two renders (and thus two OSes) diverge. Reuse the authoring commands.
  const jitterHtml = `<!doctype html><div id=x style="position:absolute"></div><script>
    window.__motifRender=function(t){var n=Math.floor(Math.random()*400);
    document.getElementById('x').style.transform='translate('+n+'px,'+n+'px)';
    document.getElementById('x').textContent='█'.repeat(40);return true;}<\/script>`
  await page.evaluate((html) => (window as any).api.invoke('write_motif_draft', {
    id: 'det-jitter', name: 'Jitter', html, propsSchema: '{}',
  }), jitterHtml)
  await page.evaluate(() => (window as any).api.invoke('install_motif', { id: 'det-jitter' }))
  const jb64 = await cap('det-jitter', 0.5)
  fs.writeFileSync(path.join(outDir, `NEG-det-jitter.png`), Buffer.from(jb64, 'base64'))

  await app.close()
})
```
(Reconcile the exact `write_motif_draft`/`install_motif` arg shape against `s5-motif-lifecycle.spec.ts` before running — Step 5 fixes any mismatch.)

- [ ] **Step 4: Create the compare CLI `e2e/lib/compare-determinism.mjs`**

```js
// Usage: node compare-determinism.mjs <dirA> <dirB> [<dirC>] --threshold 0.98
// Compares same-named PNGs across OS dirs. Positives (no NEG- prefix) must be
// >= threshold across ALL pairs; the NEG- control must be < threshold on >=1 pair.
import { readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { ssimOfPngFiles } from './image-ssim.mjs'

const args = process.argv.slice(2)
const ti = args.indexOf('--threshold')
const threshold = ti >= 0 ? parseFloat(args[ti + 1]) : 0.98
const dirs = args.filter((a, i) => !a.startsWith('--') && i !== ti + 1)
if (dirs.length < 2) { console.error('need >=2 OS dirs'); process.exit(2) }

const names = readdirSync(dirs[0]).filter((f) => f.endsWith('.png'))
let failed = false, negBelow = false
for (const name of names) {
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
    const s = ssimOfPngFiles(join(dirs[i], name), join(dirs[j], name))
    const isNeg = basename(name).startsWith('NEG-')
    const tag = isNeg ? 'NEG' : 'POS'
    console.log(`${tag} ${name} ${basename(dirs[i])}/${basename(dirs[j])} ssim=${s.toFixed(4)}`)
    if (isNeg) { if (s < threshold) negBelow = true }
    else if (s < threshold) { failed = true; console.error(`  FAIL: ${name} < ${threshold}`) }
  }
}
if (!negBelow) { console.error('FAIL: negative control never fell below threshold — gate has no teeth'); failed = true }
process.exit(failed ? 1 : 0)
```

- [ ] **Step 5: Run the capture spec locally (Windows) — confirm it produces PNGs**

Run: `cd apps/desktop && VITE_WEFTCUT_E2E=1 npm run electron:build && npm run e2e:electron -- --grep determinism`
Expected: `determinism-artifacts/win32/{countdown,lower-third-simple,title-card,NEG-det-jitter}.png` exist. Fix any motif-id / authoring-arg mismatch surfaced here.

- [ ] **Step 6: Self-compare sanity check (same-OS repeat)**

Capture twice on Windows into two dirs and compare:
```bash
# (rename determinism-artifacts/win32 → /a, re-run, rename → /b)
node e2e/lib/compare-determinism.mjs determinism-artifacts/a determinism-artifacts/b --threshold 0.98
```
Expected: POSITIVE pairs ssim ≈ 1.0 (≥ 0.98); the NEG pair < 0.98; exit 0 (negative control fell below → has teeth). This validates the harness logic before CI runs it cross-OS.

- [ ] **Step 7: Add `.gitignore` for artifacts**

Add `apps/desktop/determinism-artifacts/` to `apps/desktop/.gitignore`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/e2e/electron/s6-determinism.spec.ts apps/desktop/e2e/lib/image-ssim.mjs apps/desktop/e2e/lib/compare-determinism.mjs apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/.gitignore
git commit -m "migrate(s6): determinism capture spec + image SSIM + cross-OS compare"
```

---

## Task 8: GitHub Actions CI matrix

**Files:**
- Create: `.github/workflows/electron-ci.yml`
- Test: push the branch; observe the Actions run (the only way to verify mac/Linux).

**Interfaces:**
- Consumes: `napi:build`, `electron:build`, `e2e:electron`, the determinism spec, `compare-determinism.mjs`.
- Produces: per-OS build artifacts (installers + determinism PNGs); a `compare` job verdict.

- [ ] **Step 1: Write `.github/workflows/electron-ci.yml`**

```yaml
name: electron-ci
on:
  push: { branches: [migration/electron-napi] }
  pull_request: { branches: [migration/electron-napi] }
  workflow_dispatch:
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    defaults: { run: { working-directory: apps/desktop } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.20.0' }
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: apps/desktop/src-tauri }
      - name: Linux deps (xvfb + keyring-less)
        if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y xvfb
      - run: npm ci
      - name: Build napi addon
        run: npm run napi:build
      - name: Fetch ffmpeg (Windows)
        if: runner.os == 'Windows'
        shell: bash
        run: |
          curl -L -o ff.zip https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
          7z x ff.zip -off && mkdir -p resources/ffmpeg/win
          cp "$(find ff -name ffmpeg.exe | head -1)" resources/ffmpeg/win/ffmpeg.exe
      - name: Fetch ffmpeg (Linux)
        if: runner.os == 'Linux'
        run: |
          curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar xJ
          mkdir -p resources/ffmpeg/linux
          cp "$(find . -maxdepth 2 -name ffmpeg -type f | head -1)" resources/ffmpeg/linux/ffmpeg
          chmod +x resources/ffmpeg/linux/ffmpeg
      - name: Fetch ffmpeg (macOS)
        if: runner.os == 'macOS'
        run: |
          curl -L -o ff.zip https://evermeet.cx/ffmpeg/getrelease/zip
          unzip -o ff.zip -d ff && mkdir -p resources/ffmpeg/mac
          cp ff/ffmpeg resources/ffmpeg/mac/ffmpeg && chmod +x resources/ffmpeg/mac/ffmpeg
      - name: Rust tests
        run: cargo test --manifest-path src-tauri/Cargo.toml --lib --features jobs,export,mcp,cloud,motifs
      - name: Build app (E2E hooks)
        run: VITE_WEFTCUT_E2E=1 npm run electron:build
        shell: bash
      - name: E2E (Linux uses xvfb)
        shell: bash
        run: ${{ runner.os == 'Linux' && 'xvfb-run -a' || '' }} npm run e2e:electron
      - name: Determinism capture
        shell: bash
        run: ${{ runner.os == 'Linux' && 'xvfb-run -a' || '' }} npm run e2e:electron -- --grep determinism
      - name: Package (unsigned)
        run: npm run package
      - uses: actions/upload-artifact@v4
        with:
          name: determinism-${{ matrix.os }}
          path: apps/desktop/determinism-artifacts/**
      - uses: actions/upload-artifact@v4
        with:
          name: installer-${{ matrix.os }}
          path: apps/desktop/release/*.*
  compare:
    needs: build
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: apps/desktop } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.20.0' }
      - run: npm ci
      - uses: actions/download-artifact@v4
        with: { pattern: determinism-*, path: apps/desktop/dl }
      - name: Cross-OS SSIM compare
        run: |
          node e2e/lib/compare-determinism.mjs \
            dl/determinism-windows-latest/win32 \
            dl/determinism-ubuntu-latest/linux \
            dl/determinism-macos-latest/darwin \
            --threshold 0.98
```
(Artifact subpaths: each build job uploads `determinism-artifacts/<platform>/`; `<platform>` is `win32`/`linux`/`darwin` from `process.platform`. Reconcile the download paths after the first run if the artifact nesting differs.)

- [ ] **Step 2: Push and observe**

```bash
git add .github/workflows/electron-ci.yml
git commit -m "migrate(s6): GitHub Actions 3-OS build + determinism gate"
git push origin migration/electron-napi
```
Expected: the `build` matrix runs on all three OSes; `compare` runs last.

- [ ] **Step 3: Triage the first run (expected iteration)**

The first run almost certainly needs fixes: ffmpeg URL drift, mac offscreen-CDP flakiness, the SSIM threshold (tune from the printed `POS`/`NEG` values — raise toward the lowest passing positive while staying above the negative). Iterate on the workflow + threshold until: all three OSes build, all suites pass, positives ≥ threshold, negative < threshold. Record the tuned threshold in the spec.

- [ ] **Step 4: Commit the tuned workflow**

```bash
git add .github/workflows/electron-ci.yml docs/superpowers/specs/2026-06-18-electron-napi-s6-migration-completion-design.md
git commit -m "migrate(s6): tune determinism threshold + CI fixes from first run"
```

---

## Task 9: Manual export verification (acceptance)

**Files:** none (acceptance evidence).

- [ ] **Step 1: Full export walkthrough on the packaged Windows build**

Install the Task-1 NSIS build (with Task-2 ffmpeg). Import a video, place clips, open Export Settings, run an H.264 export to disk, play back the output. Expected: progress UI advances, the file writes, playback is correct.

- [ ] **Step 2: Record the result**

Append a short "S6 manual export: PASS (codec/res/duration, output plays)" note to `apps/desktop/electron/S6-NOTES.md` (create it). Commit:
```bash
git add apps/desktop/electron/S6-NOTES.md
git commit -m "migrate(s6): record manual export acceptance"
```

---

## Task 10: Tauri cut-over (LAST — gated on Tasks 1–9 green)

**Files:**
- Delete: `apps/desktop/src-tauri/tauri.conf.json`, the Tauri entry points + `media_drop.rs`, the Tauri `Cargo.toml` deps, `apps/desktop/poc/electron-napi/`
- Modify: `apps/desktop/package.json` (drop `@tauri-apps/*` deps + `tauri*` scripts), `apps/desktop/src-tauri/Cargo.toml`, `electron.vite.config.ts` (the `@tauri-apps/*` aliases become dead — keep the alias→shim map since the renderer still imports `@tauri-apps/*` specifiers; do NOT delete the compat shims).

**Interfaces:**
- Consumes: a fully green S6 (all prior tasks). 
- Produces: a branch that builds + runs purely on Electron with no Tauri deps.

- [ ] **Step 1: Inventory the Tauri-only surface**

Run: `rg -l "tauri::|#\[tauri|tauri_build|tauri-plugin|use tauri" apps/desktop/src-tauri/src` and `rg "@tauri-apps|\"tauri\"" apps/desktop/package.json`
Expected: the exact list of Tauri-coupled Rust files + the package.json tauri deps/scripts. Reconcile against the deletions below. (`media_drop.rs` is Windows+Tauri-only and already unused by the napi build — confirm via `rg "mod media_drop"`.)

- [ ] **Step 2: Remove the Rust Tauri shell**

Delete `tauri.conf.json`, the Tauri-specific entry arms in `lib.rs`/`main.rs` (the `#[tauri::command]` registration, `tauri::Builder`, `tauri-plugin-*` wiring) and `media_drop.rs` + its `mod media_drop;` line. Keep the napi `cdylib` `[lib]` + all domain modules. In `Cargo.toml`, remove `tauri`, `tauri-build`, `tauri-plugin-*` deps and the `[build-dependencies] tauri-build`; drop `media_drop` from `[features]`.

- [ ] **Step 3: Rebuild + Rust tests**

Run: `cd apps/desktop && npm run napi:build && cargo test --manifest-path src-tauri/Cargo.toml --lib --features jobs,export,mcp,cloud,motifs`
Expected: addon builds without Tauri; **587 tests pass** (the removed code was shell-only).

- [ ] **Step 4: Remove the JS Tauri deps + the PoC**

In `apps/desktop/package.json`, remove the `@tauri-apps/api`, `@tauri-apps/plugin-*` dependencies, the `@tauri-apps/cli` devDep, and the `tauri`/`tauri:dev`/`tauri:build` scripts. Keep the `electron-compat/` shims and the `electron.vite.config.ts` `@tauri-apps/*` aliases (the renderer still imports those specifiers — the aliases redirect them to the shims). Delete the PoC dir:
```bash
git rm -r apps/desktop/poc/electron-napi
rm -rf apps/desktop/node_modules && npm install
```

- [ ] **Step 5: Full green gate**

Run: `cd apps/desktop && VITE_WEFTCUT_E2E=1 npm run electron:build && npm run e2e:electron`
Expected: app builds + launches with no Tauri deps; **all Playwright specs pass** (existing 24 + S6 additions). Smoke the drag-drop branch (the `window.chrome.webview` fallback is now dead but harmless — optionally remove it from `App.tsx:onDrop` in this step as a final tidy).

- [ ] **Step 6: Commit**

```bash
git add -A apps/desktop/src-tauri apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "migrate(s6): cut over — remove Tauri shell, deps, and PoC"
```

- [ ] **Step 7: Record completion in S6-NOTES**

Append the final S6 acceptance (CI green on 3 OSes, determinism gate + negative control, cut-over done) to `apps/desktop/electron/S6-NOTES.md`. Commit.

---

## Self-Review

**Spec coverage:**
- §5.1 CI matrix → Task 8. §5.2 packaging → Task 1. §5.3 ffmpeg → Task 2. §5.4 Linux safeStorage → Task 3. §5.5 determinism harness → Task 7 (+ Task 8 compare job). §5.6 cut-over → Task 10. §7 parity: drag-drop → Task 4, PerfHUD → Task 5, ConnectAgentPanel → Task 6, manual export → Task 9, onResized → already closed (noted). §9 exit criteria → Tasks 8 (CI green + gate) + 10 (cut-over). ✓ All spec sections map to a task.
- Decisions (§4): force-software-render → Task 7 Step 3 launch args + Task 8. SSIM 0.98 seed + tune → Task 7/8. Unsigned → Task 1 (`identity: null`, `--publish never`). All-3-OS → Task 8 matrix. ✓

**Placeholder scan:** The only deferred specifics are intentional reconcile-from-output steps (Task 5 Step 1 PerfHUD label, Task 7 authoring-arg shape, Task 8 artifact paths/threshold tuning) — each has a concrete command to obtain the value and a concrete fix step, not an open "TBD". `fetch-ffmpeg.mjs` deliberately delegates exact URLs to the CI workflow (Task 8) which has them inline; flagged explicitly. No silent placeholders.

**Type consistency:** `McpInfoView { bind, url, bearer_token }` is used identically in Task 6 Steps 1–2. `getPathForFile(file): string`, `media:dropped`, `media:external-drop` consistent across Task 4. `win:create/win:act/win:exists` consistent across Task 5 Steps 2–5. `ssimOfPngFiles(a, b)` defined in Task 7 Step 2, consumed in Step 4. ✓
