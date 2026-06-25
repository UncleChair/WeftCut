import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Notification, protocol, shell } from 'electron'
import { loadAllKeys, setKey, clearKey } from './keys.js'
import { MOTIF_SCHEME_ENTRY, registerMotifProtocol } from './motif/protocol.js'
import { setRuntimeSource, captureMotifFrameB64 } from './motif/capture.js'
import { createSecondary, actOnSecondary, secondaryExists, hardenWindow } from './windows.js'
import type { SecondaryWinOpts } from './windowConfig.js'
import { broadcastEvent } from './broadcast.js'
import { resolveSystemFont } from './fonts/resolveSystemFont.js'
import { collectMetrics } from './metrics.js'
import { isAllowed } from './fsGuard.js'
import { tsActorHandles } from './state/shadow.js'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'weftcut-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  MOTIF_SCHEME_ENTRY,
])

const require_ = createRequire(import.meta.url)
const { Backend } = require_('@weftcut/core') as typeof import('@weftcut/core')

let backend: import('@weftcut/core').Backend | null = null
let mainWindow: BrowserWindow | null = null
// The MCP host is started after `backend.init()`, but the `onEvent` closure
// (which taps `mcp:change`) is constructed in the `new Backend(...)` call
// BEFORE the host exists. Hold it module-scoped and set it right after
// `startMcpHost` resolves.
let mcpHostRef: import('./mcp/index.js').McpHost | null = null
let tsHost: import('./state/ts-actor-host.js').TsActorHost | null = null

const isDev = !!process.env['ELECTRON_RENDERER_URL']

// App-level startup notices the renderer PULLS on mount via the `app:notices`
// IPC (see AppNotice in src/shared/ipc.ts). Collected here at startup, fetched
// when the renderer is ready — a pull model so a notice can't be lost to the
// fire-once-before-subscribe race the old `evt:app:notice` send had.
const startupNotices: { level: string; code: string }[] = []

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // Show immediately. A frameless (`frame:false`) window combined with
    // `show:false` + a deferred `ready-to-show` show does NOT reliably surface
    // on Windows (ready-to-show may not fire) — the window stays hidden. With a
    // set backgroundColor there's no white flash, so show on create.
    show: true,
    // Frameless window — the renderer draws its
    // own titlebar (app-header / startup-titlebar / agent-titlebar) with custom
    // window controls. (macOS traffic-light styling is a future cross-platform
    // refinement.)
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow = win
  hardenWindow(win)

  // The renderer draws its own caption buttons (frameless window); their
  // maximize/restore glyph cares only about maximize-STATE transitions, not
  // every resize tick. Emit on maximize/unmaximize only — the external paths
  // (drag-region double-click, Win+arrow, drag-to-top) all funnel through these
  // — and carry the state so the renderer needn't round-trip back to read it.
  const sendMaximizeState = () =>
    win.webContents.send('evt:window:maximize-changed', { isMaximized: win.isMaximized() })
  win.on('maximize', sendMaximizeState)
  win.on('unmaximize', sendMaximizeState)

  // Capture renderer console messages to stdout for diagnostics
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const lvl = ['verbose', 'info', 'warning', 'error'][level] ?? 'log'
    console.log(`[renderer:${lvl}] ${message} (${sourceId}:${line})`)
  })

  if (isDev) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  void warnIfElevatedWindows(win)

  return win
}

/// Whether THIS process runs at Windows High integrity (i.e. "Run as
/// administrator"). The High Mandatory Level integrity SID (S-1-16-12288) appears
/// in the token's group list only when elevated, and the SID — unlike the group's
/// display name — is locale-independent. Uses `whoami` (always on PATH) rather
/// than a native Win32 dependency.
function isElevatedWindows(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('whoami', ['/groups'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.includes('S-1-16-12288'))
    })
  })
}

/// One-shot startup notice: when WeftCut runs elevated on Windows, Windows UIPI
/// blocks file drag-drop from the (Medium-integrity) Explorer into this
/// (High-integrity) process — the drag never reaches the renderer, so drop-import
/// silently dies. Surface it instead of leaving a confusing no-op. The dialog is
/// suppressed under e2e/CI (which often run elevated) so it can't block automation.
async function warnIfElevatedWindows(win: BrowserWindow): Promise<void> {
  if (process.platform !== 'win32') return
  if (process.env['WEFTCUT_SUPPRESS_ELEVATION_NOTICE']) return
  if (!(await isElevatedWindows())) return
  if (win.isDestroyed()) return
  const zh = app.getLocale().toLowerCase().startsWith('zh')
  await dialog.showMessageBox(win, {
    type: 'info',
    noLink: true,
    buttons: ['OK'],
    title: zh ? '正在以管理员身份运行' : 'Running as administrator',
    message: zh ? '拖放导入已被禁用' : 'Drag-and-drop import is disabled',
    detail: zh
      ? 'Windows 会阻止把文件从资源管理器拖放到以管理员身份运行的应用。要启用拖放,请以普通方式(不要"以管理员身份运行")重新启动 WeftCut。你仍可使用"导入媒体…"按钮导入。'
      : 'Windows blocks dragging files from File Explorer into an app that runs as administrator. To enable drag-and-drop, relaunch WeftCut normally (not "Run as administrator"). You can still import with the "Import media…" button.',
  })
}

app.whenReady().then(async () => {
  // Bundled ffmpeg: ffmpeg-sidecar resolves "ffmpeg" via PATH when no binary sits
  // adjacent to the exe (ffmpeg_sidecar::paths::ffmpeg_path). Prepend the packaged dir so the
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

  // Construct + init the Backend before creating the window
  backend = new Backend(
    app.getPath('userData'),
    path.join(app.getPath('userData'), 'Cache'),
    (_err: Error | null, msg: string) => {
      if (!msg) return
      const { event, payload } = JSON.parse(msg)
      // `mcp:change` is consumed by the MCP host (relayed as an in-protocol
      // streamable-HTTP notification to connected agents), NOT forwarded to the renderer.
      if (event === 'mcp:change') {
        mcpHostRef?.notifyChange(payload)
        return
      }
      // `media:derivatives` write-back: when the TS actor is authoritative, apply
      // the derivative patch to the TS actor instead of forwarding to the renderer.
      // tsHost is module-scoped (set later); the closure captures it by reference.
      if (event === 'media:derivatives') {
        if (tsHost) { void import('./state/jobs-writeback.js').then(({ applyDerivativesEvent }) => applyDerivativesEvent(tsHost!.actor, payload as never)); return }
        // flag-off: Rust is authoritative and never emits this event — fall through is defensive
      }
      mainWindow?.webContents.send('evt:' + event, payload)
    },
  )
  await backend.init()
  console.log('[main] backend init OK')

  const { encryptionAvailable } = await import('./keys.js')
  if (!encryptionAvailable()) {
    console.warn('[main] OS keyring unavailable — cloud API keys persist in PLAINTEXT (cloud_keys.json). Secure your userData dir or install a keyring (libsecret/kwallet).')
    // Surfaced to the user by the renderer's <AppNotices> (pulled via app:notices).
    startupNotices.push({ level: 'warn', code: 'keyring_unavailable' })
  }

  // Push any safeStorage-persisted cloud API keys into the backend cache so
  // reqwest providers + settings_test_provider see them without a renderer round-trip.
  for (const [provider, key] of Object.entries(loadAllKeys())) {
    backend.setCloudKey(provider, key)
  }

  // Start the MCP host (streamable HTTP + bearer) and expose its info IPC.
  const { startMcpHost } = await import('./mcp/index.js')
  const mcpHost = await startMcpHost(backend, () => tsHost)
  mcpHostRef = mcpHost

  // TS-actor host: construct after mcpHostRef is set (emitChange relays via mcpNotify).
  // DORMANT unless WEFTCUT_TS_ACTOR=1 — flag-off leaves existing behavior 100% unchanged.
  const tsActorOn = process.env['WEFTCUT_TS_ACTOR'] === '1'
  if (tsActorOn) {
    const { createTsActorHost } = await import('./state/ts-actor-host.js')

    // The TS actor snaps frame edges via the wasm eval leaf (snap.ts → renderer/eval).
    // Main MUST initialize it once at boot before the actor handles any command
    // (snap.ts contract) — the Rust actor used the native leaf, so this is flip-only.
    const { initEval } = await import('./state/snap.js')
    await initEval()

    // Node fs adapter — satisfies both OrchestratorFs and AutosaveFs.
    const nodeFs = {
      exists: (p: string) => fs.existsSync(p),
      readFile: (p: string) => fs.readFileSync(p, 'utf8'),
      writeFile: (p: string, t: string) => fs.writeFileSync(p, t, 'utf8'),
      mkdirp: (d: string) => { fs.mkdirSync(d, { recursive: true }) },
      copyFile: (s: string, d: string) => fs.copyFileSync(s, d),
      readdir: (d: string) => fs.readdirSync(d) as string[],
      rm: (p: string) => { fs.rmSync(p, { force: true }) },
    }

    // Napi facade for workspace bookkeeping — delegates to the Backend instance.
    const napiFacade = {
      commitWorkspace: (p: string) => backend!.commitWorkspace(p),
      pushRecent: (p: string, n: string) => backend!.pushRecent(p, n),
      setLastNewProjectParent: (p: string) => backend!.setLastNewProjectParent(p),
      enqueueJobsForMedia: (j: string) => backend!.enqueueJobsForMedia(j),
      setProjectMirror: (pj: string, hv: string) => backend!.setProjectMirror(pj, hv),
    }

    // Workspace dir cache — seeded once at boot; refreshed after each persistence call
    // (the orchestrator calls commitWorkspace itself before replaceState, so by the time
    // open/saveAs/newWorkspace resolves wsCache must reflect the NEW workspace so that
    // buildProjectSummary's fileExists + autosave see the right dir).
    let wsCache: string | null = null
    try {
      wsCache = JSON.parse(await backend!.invoke('workspace_dir', '{}')) as string | null
    } catch { /* no workspace at cold boot */ }

    // Wrap napiFacade.commitWorkspace to also refresh wsCache as a side effect —
    // the orchestrator calls it before replaceState, so by the time any post-open
    // handler runs, wsCache already holds the new path.
    const napiFacadeWithCache = {
      ...napiFacade,
      commitWorkspace: async (p: string) => {
        await napiFacade.commitWorkspace(p)
        wsCache = p
      },
    }

    tsHost = createTsActorHost({
      send: (event, payload) => mainWindow?.webContents.send('evt:' + event, payload),
      mcpNotify: (payload) => mcpHostRef?.notifyChange(payload),
      fileExists: (p) => fs.existsSync(p),
      fs: nodeFs,
      join: path.join,
      napi: napiFacadeWithCache,
      workspaceDir: () => wsCache,
      setProjectMirror: (pj, hv) => backend!.setProjectMirror(pj, hv),
    })
    tsHost.start()
    // Tell the jobs subsystem the TS actor is now authoritative for derivative write-back.
    backend!.setTsDerivativeAuthority(true)
    console.log('[main] WEFTCUT_TS_ACTOR on — TS state actor authoritative')
  }

  ipcMain.handle('get_mcp_info', () => mcpHost.getInfo())
  ipcMain.handle('reset_mcp_token', () => mcpHost.resetToken())
  ipcMain.handle('app:notices', () => startupNotices)

  ipcMain.handle('backend:invoke', async (_e, { channel, args }) => {
    // Motif runtime registration: renderer sends its clock-takeover source once
    // at boot; main injects it into the offscreen capture host via CDP.
    if (channel === 'motif_register_runtime') {
      setRuntimeSource((args as { source: string }).source)
      return null
    }
    // Motif frame capture: offscreen CDP path — never falls through to Rust.
    if (channel === 'motif_capture_frame') {
      const a = args as {
        motifId: string; tSec: number; propsJson: string
        width: number; height: number; settleRafs: number | null; contentHash: string
      }
      return await captureMotifFrameB64(backend!, a)
    }
    // API-key writes need safeStorage (main-only) + a push into the backend
    // cache. Intercept here; status/test fall through to the Rust dispatcher.
    if (channel === 'settings_set_api_key') {
      const { provider, key } = (args ?? {}) as { provider: string; key: string }
      setKey(provider, key)
      backend!.setCloudKey(provider, (key ?? '').trim())
      return null
    }
    if (channel === 'settings_clear_api_key') {
      const { provider } = (args ?? {}) as { provider: string }
      clearKey(provider)
      backend!.clearCloudKey(provider)
      return null
    }
    // TS-actor splitter: when the flag is on, route non-Rust channels into the TS
    // host. Consulted AFTER main-only intercepts above, BEFORE the Rust fallthrough.
    // Flag-off: tsHost is null, block is skipped, behavior unchanged.
    if (tsHost) {
      const route = (await import('./state/router.js')).routeChannel(channel)
      if (route.kind !== 'rust') return await tsHost.handleInvoke(channel, (args ?? {}) as Record<string, unknown>)
    }
    // Dev-only shadow: log when the Phase-1 TS actor vocabulary covers this command.
    // Rust stays authoritative; this flag is OFF by default.
    // Full live divergence check is deferred to a future phase — the Task-12
    // differential harness (replay_driver) is the Phase-1 correctness gate.
    if (process.env['WEFTCUT_TS_ACTOR_SHADOW'] === '1') {
      try {
        if (tsActorHandles(channel)) {
          console.log(`[ts-actor-shadow] shadow enabled — ${channel} is in Phase-1 vocabulary`)
        } else {
          console.log(`[ts-actor-shadow] shadow enabled — ${channel} is out-of-vocabulary (skipped)`)
        }
      } catch (e) {
        console.warn('[ts-actor-shadow] shadow hook threw', e)
      }
    }
    const json = await backend!.invoke(channel, JSON.stringify(args ?? {}))
    return JSON.parse(json)
  })

  // Secondary windows (PerfHUD popup etc.) via win:* IPC.
  ipcMain.handle('win:create', (_e, { label, options }: { label: string; options?: SecondaryWinOpts }) => createSecondary(label, options))
  ipcMain.handle('win:act', (_e, { label, action }: { label: string; action: 'show' | 'hide' | 'close' | 'center' | 'focus' }) => actOnSecondary(label, action))
  ipcMain.handle('win:exists', (_e, { label }: { label: string }) => secondaryExists(label))

  // Drag-drop import: the renderer resolves real paths via webUtils and posts
  // them here; we re-emit the SAME `media:external-drop` event the renderer's
  // existing listener already handles.
  ipcMain.handle('media:dropped', (_e, paths: string[]) => {
    if (Array.isArray(paths) && paths.length > 0) {
      mainWindow?.webContents.send('evt:media:external-drop', paths)
    }
  })

  // Caption-button controls act on the SENDER's window, not always mainWindow:
  // secondary windows (the PerfHUD popup) render the same <WindowControls/>, so
  // their close/min/max must target themselves — otherwise the popup's close
  // button would close the main editor. fromWebContents resolves the window that
  // invoked the IPC; mainWindow is the fallback if it can't (shouldn't happen).
  const ctlWin = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender) ?? mainWindow
  ipcMain.handle('window:minimize', (e) => ctlWin(e)?.minimize())
  ipcMain.handle('window:toggleMaximize', (e) => {
    const w = ctlWin(e)
    if (w?.isMaximized()) w.unmaximize()
    else w?.maximize()
  })
  ipcMain.handle('window:close', (e) => ctlWin(e)?.close())
  ipcMain.handle('window:isMaximized', (e) => !!ctlWin(e)?.isMaximized())
  ipcMain.handle('window:setTitle', (e, title: string) => ctlWin(e)?.setTitle(title))
  ipcMain.handle('path:documentDir', () => app.getPath('documents'))
  ipcMain.handle('path:join', (_e, payload: { parts?: string[]; paths?: string[] }) => path.join(...(payload.parts ?? payload.paths ?? [])))
  ipcMain.handle('path:tempDir', () => app.getPath('temp'))

  // Open a path or URL in the OS default handler. Files/folders → the file
  // manager; http(s) → the default browser (openExternal refuses non-web
  // schemes, so a compromised renderer can't launch arbitrary protocols).
  ipcMain.handle('shell:open', async (_e, { target }: { target: string }) => {
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target)
    } else {
      const err = await shell.openPath(target)
      if (err) throw new Error(err)
    }
  })

  // Best-effort desktop notification. Silently no-op where the OS reports no
  // notification support (matches the renderer's fire-and-forget contract).
  ipcMain.handle('notification:send', (_e, opts: { title?: string; body?: string }) => {
    if (!Notification.isSupported()) return
    new Notification({ title: opts?.title ?? '', body: opts?.body ?? '' }).show()
  })

  // Cross-window event broadcast: re-send to EVERY window (incl. the sender) as
  // `evt:<event>`. Backs the renderer's `emit()` → `listen()` path (e.g. the
  // main window streaming PerfHUD snapshots to the popped-out HUD window).
  ipcMain.handle('app:emit', (_e, { event, payload }: { event: string; payload?: unknown }) => {
    broadcastEvent(BrowserWindow.getAllWindows(), event, payload)
  })

  // Process-tree resource snapshot for the PerfHUD. Electron tracks the whole
  // app tree (Browser + renderers + GPU + utility) itself — no Rust round-trip,
  // no system-info crate. Works in dev AND release (unlike the dropped Rust
  // `get_system_stats`, which only ever errored).
  ipcMain.handle('app:metrics', () => collectMetrics(app.getAppMetrics(), os.cpus().length))

  const { dialog } = require('electron') as typeof import('electron')
  ipcMain.handle('dialog:open', async (_e, opts) => {
    const o = (opts ?? {}) as {
      title?: string
      multiple?: boolean
      directory?: boolean
      filters?: { name: string; extensions: string[] }[]
      defaultPath?: string
    }
    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = o.directory
      ? ['openDirectory']
      : ['openFile']
    if (o.multiple) properties.push('multiSelections')
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: o.title,
      defaultPath: o.defaultPath,
      // Filters are meaningless for a directory picker.
      filters: o.directory ? undefined : o.filters,
      properties,
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return o.multiple ? res.filePaths : res.filePaths[0]
  })
  ipcMain.handle('dialog:save', async (_e, opts) => {
    const o = (opts ?? {}) as {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: o.title,
      defaultPath: o.defaultPath,
      filters: o.filters,
    })
    return res.canceled || !res.filePath ? null : res.filePath
  })

  // fs:* — direct main-process filesystem access for the renderer (write/append/
  // read/remove/readDir). Confined to APP-MANAGED roots: the OS temp dir (export
  // scratch), userData (incl. the backend Cache), and the active workspace. The
  // renderer is first-party (contextIsolation+sandbox, no remote content / no
  // <webview>) and the final export files + project saves go through Rust (not
  // this surface), so the whitelist breaks nothing — it just caps the blast
  // radius of an XSS/CSP breach: a compromised renderer can no longer read,
  // overwrite, or recursively delete arbitrary paths on disk. The workspace
  // path is fetched from the BACKEND (the authority), so a compromised renderer
  // can't widen its own scope by lying about which folder is "the workspace".
  //
  // NOTE: arbitrary user-imported MEDIA is served read-only by the separate
  // weftcut-media:// protocol below (those paths come from the import dialog and
  // can live anywhere), which is deliberately NOT confined here.
  let cachedWorkspace: string | null = null
  const refreshWorkspace = async (): Promise<void> => {
    try {
      cachedWorkspace = JSON.parse(await backend!.invoke('workspace_dir', '{}')) as string | null
    } catch {
      /* keep the last-known value on a query error */
    }
  }
  const fsRoots = (): string[] => {
    const roots = [app.getPath('temp'), app.getPath('userData')]
    if (cachedWorkspace) roots.push(cachedWorkspace)
    return roots
  }
  // Resolve `p` and assert it sits under an allowed root, else throw. Static
  // roots (temp/userData) are checked first with no backend round-trip; only a
  // miss re-queries the workspace (it may have just opened) and retries — so the
  // hot path (export temp appends) never touches the backend.
  const guardFsPath = async (p: string): Promise<string> => {
    const abs = path.resolve(p)
    if (isAllowed(abs, fsRoots())) return abs
    await refreshWorkspace()
    if (isAllowed(abs, fsRoots())) return abs
    throw new Error(`fs access denied: ${abs} is outside the allowed roots (temp, userData, workspace)`)
  }

  ipcMain.handle(
    'fs:writeFile',
    async (_e, { path: p, data, append }: { path: string; data: Uint8Array; append?: boolean }) => {
      const abs = await guardFsPath(p)
      const buf = Buffer.from(data)
      if (append) fs.appendFileSync(abs, buf)
      else fs.writeFileSync(abs, buf)
    },
  )
  ipcMain.handle('fs:writeTextFile', async (_e, { path: p, data }: { path: string; data: string }) => {
    fs.writeFileSync(await guardFsPath(p), data, 'utf8')
  })
  ipcMain.handle('fs:mkdir', async (_e, { path: p, recursive }: { path: string; recursive?: boolean }) => {
    fs.mkdirSync(await guardFsPath(p), { recursive: recursive ?? false })
  })
  ipcMain.handle('fs:readFile', async (_e, { path: p }: { path: string }) => fs.readFileSync(await guardFsPath(p)))
  ipcMain.handle('font:resolve', async (_e, { family }: { family: string }) => {
    return resolveSystemFont(family)
  })

  // PoC: native IPC video-sink write. Binary frame in (ArrayBuffer/typed array),
  // forwarded straight to the napi backend's ffmpeg stdin. No JSON.
  ipcMain.handle('export:videosink_write', async (_e, ab: ArrayBuffer | Uint8Array) => {
    const buf = Buffer.isBuffer(ab) ? ab : Buffer.from(ab as ArrayBuffer)
    await backend!.exportVideoSinkWrite(buf)
  })
  ipcMain.handle('fs:remove', async (_e, { path: p }: { path: string }) => {
    fs.rmSync(await guardFsPath(p), { force: true, recursive: true })
  })
  ipcMain.handle('fs:exists', async (_e, { path: p }: { path: string }) => fs.existsSync(await guardFsPath(p)))
  ipcMain.handle('fs:readDir', async (_e, { path: p }: { path: string }) =>
    fs.readdirSync(await guardFsPath(p), { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
      isSymlink: d.isSymbolicLink(),
    })),
  )

  registerMotifProtocol(backend!)

  protocol.handle('weftcut-media', async (request) => {
    // URL form: weftcut-media://localhost/<encodeURIComponent(absPath)>
    const u = new URL(request.url)
    const abs = decodeURIComponent(u.pathname.replace(/^\//, ''))
    if (!path.isAbsolute(abs)) {
      return new Response('bad path', { status: 403 })
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('not a file', { status: 404 })

    const total = stat.size
    const range = request.headers.get('Range')
    const headersBase: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
    }

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (!m) return new Response('bad range', { status: 416 })
      let start = m[1] === '' ? 0 : parseInt(m[1], 10)
      let end = m[2] === '' ? total - 1 : parseInt(m[2], 10)
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        })
      }
      if (end >= total) end = total - 1
      const stream = fs.createReadStream(abs, { start, end })
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...headersBase,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(end - start + 1),
        },
      })
    }

    const stream = fs.createReadStream(abs)
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: { ...headersBase, 'Content-Length': String(total) },
    })
  })

  const win = await createWindow()

  win.once('ready-to-show', () => win.show())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().then((w) => w.once('ready-to-show', () => w.show()))
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
