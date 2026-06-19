import path from 'node:path'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { app, BrowserWindow, ipcMain, protocol } from 'electron'
import { loadAllKeys, setKey, clearKey } from './keys.js'
import { MOTIF_SCHEME_ENTRY, registerMotifProtocol } from './motif/protocol.js'
import { setRuntimeSource, captureMotifFrameB64 } from './motif/capture.js'

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

const isDev = !!process.env['ELECTRON_RENDERER_URL']

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // Show immediately. A frameless (`frame:false`) window combined with
    // `show:false` + a deferred `ready-to-show` show does NOT reliably surface
    // on Windows (ready-to-show may not fire) — the window stays hidden. With a
    // set backgroundColor there's no white flash, so show on create.
    show: true,
    // Frameless to match Tauri's `decorations: false` — the renderer draws its
    // own titlebar (app-header / startup-titlebar / agent-titlebar) with custom
    // window controls. (macOS traffic-light styling is an S6 cross-platform
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

  const sendResized = () =>
    win.webContents.send('evt:window:resized', { isMaximized: win.isMaximized() })
  win.on('resize', sendResized)
  win.on('maximize', sendResized)
  win.on('unmaximize', sendResized)

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

  return win
}

app.whenReady().then(async () => {
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

  // Construct + init the Backend before creating the window
  backend = new Backend(
    app.getPath('userData'),
    path.join(app.getPath('userData'), 'Cache'),
    (_err: Error | null, msg: string) => {
      if (!msg) return
      const { event, payload } = JSON.parse(msg)
      // `mcp:change` is consumed by the MCP host (relayed as an SSE notification
      // to connected agents), NOT forwarded to the renderer.
      if (event === 'mcp:change') {
        mcpHostRef?.notifyChange(payload)
        return
      }
      mainWindow?.webContents.send('evt:' + event, payload)
    },
  )
  await backend.init()
  console.log('[main] backend init OK')

  const { encryptionAvailable } = await import('./keys.js')
  if (!encryptionAvailable()) {
    console.warn('[main] OS keyring unavailable — cloud API keys persist in PLAINTEXT (cloud_keys.json). Secure your userData dir or install a keyring (libsecret/kwallet).')
    // One-time UI notice (renderer shows it via the existing notice path).
    mainWindow?.webContents.send('evt:app:notice', {
      level: 'warn',
      code: 'keyring_unavailable',
    })
  }

  // Push any safeStorage-persisted cloud API keys into the backend cache so
  // reqwest providers + settings_test_provider see them without a renderer round-trip.
  for (const [provider, key] of Object.entries(loadAllKeys())) {
    backend.setCloudKey(provider, key)
  }

  // Start the MCP host (streamable HTTP + bearer) and expose its info IPC.
  const { startMcpHost } = await import('./mcp/index.js')
  const mcpHost = await startMcpHost(backend)
  mcpHostRef = mcpHost
  ipcMain.handle('get_mcp_info', () => mcpHost.getInfo())
  ipcMain.handle('reset_mcp_token', () => mcpHost.resetToken())

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
    const json = await backend!.invoke(channel, JSON.stringify(args ?? {}))
    return JSON.parse(json)
  })

  // Secondary windows (PerfHUD popup etc.) via win:* IPC.
  const { createSecondary, actOnSecondary, secondaryExists } = await import('./windows.js')
  ipcMain.handle('win:create', (_e, { label, options }: { label: string; options?: { url?: string; width?: number; height?: number; title?: string } }) => createSecondary(label, options))
  ipcMain.handle('win:act', (_e, { label, action }: { label: string; action: 'show' | 'hide' | 'close' | 'center' | 'focus' }) => actOnSecondary(label, action))
  ipcMain.handle('win:exists', (_e, { label }: { label: string }) => secondaryExists(label))

  // Drag-drop import: the renderer resolves real paths via webUtils and posts
  // them here; we re-emit the SAME event the Tauri media_drop.rs path emitted,
  // so the renderer's existing media:external-drop listener handles them.
  ipcMain.handle('media:dropped', (_e, paths: string[]) => {
    if (Array.isArray(paths) && paths.length > 0) {
      mainWindow?.webContents.send('evt:media:external-drop', paths)
    }
  })

  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggleMaximize', () =>
    mainWindow?.isMaximized() ? mainWindow?.unmaximize() : mainWindow?.maximize(),
  )
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => !!mainWindow?.isMaximized())
  ipcMain.handle('window:setTitle', (_e, title: string) => mainWindow?.setTitle(title))
  ipcMain.handle('path:documentDir', () => app.getPath('documents'))
  ipcMain.handle('path:join', (_e, payload: { parts?: string[]; paths?: string[] }) => path.join(...(payload.parts ?? payload.paths ?? [])))
  ipcMain.handle('path:tempDir', () => app.getPath('temp'))

  const { dialog } = require('electron') as typeof import('electron')
  ipcMain.handle('dialog:open', async (_e, opts) => {
    const o = (opts ?? {}) as {
      title?: string
      multiple?: boolean
      filters?: { name: string; extensions: string[] }[]
      defaultPath?: string
    }
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: o.title,
      defaultPath: o.defaultPath,
      filters: o.filters,
      properties: o.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
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
  // read/remove/readDir). No path validation by design: the renderer is
  // first-party (contextIsolation+sandbox, no remote content / no <webview>), so
  // this matches the trust level of the Tauri fs capabilities it replaces. If a
  // future stage loads remote content or plugins, this surface MUST be re-scoped.
  ipcMain.handle(
    'fs:writeFile',
    (_e, { path: p, data, append }: { path: string; data: Uint8Array; append?: boolean }) => {
      const buf = Buffer.from(data)
      if (append) fs.appendFileSync(p, buf)
      else fs.writeFileSync(p, buf)
    },
  )
  ipcMain.handle('fs:writeTextFile', (_e, { path: p, data }: { path: string; data: string }) => {
    fs.writeFileSync(p, data, 'utf8')
  })
  ipcMain.handle('fs:readFile', (_e, { path: p }: { path: string }) => fs.readFileSync(p))

  // PoC: native IPC video-sink write. Binary frame in (ArrayBuffer/typed array),
  // forwarded straight to the napi backend's ffmpeg stdin. No JSON.
  ipcMain.handle('export:videosink_write', async (_e, ab: ArrayBuffer | Uint8Array) => {
    const buf = Buffer.isBuffer(ab) ? ab : Buffer.from(ab as ArrayBuffer)
    await backend!.exportVideoSinkWrite(buf)
  })
  ipcMain.handle('fs:remove', (_e, { path: p }: { path: string }) => {
    fs.rmSync(p, { force: true, recursive: true })
  })
  ipcMain.handle('fs:exists', (_e, { path: p }: { path: string }) => fs.existsSync(p))
  ipcMain.handle('fs:readDir', (_e, { path: p }: { path: string }) =>
    fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
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

  // S1 boot screenshot: when S1_SHOT env is set, capture the window after
  // React+Pixi have had time to paint, write boot.png, then quit.
  if (process.env['S1_SHOT']) {
    const delay = parseInt(process.env['S1_SHOT_DELAY'] ?? '2500', 10)
    win.once('ready-to-show', () => {
      win.show()
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage()
          const pngPath = path.join(__dirname, '../../electron/boot.png')
          fs.mkdirSync(path.dirname(pngPath), { recursive: true })
          fs.writeFileSync(pngPath, image.toPNG())
          console.log(`[S1] boot.png written to ${pngPath} (${image.getSize().width}x${image.getSize().height})`)
        } catch (err) {
          console.error('[S1] capturePage failed:', err)
        } finally {
          app.quit()
        }
      }, delay)
    })
  } else {
    win.once('ready-to-show', () => win.show())
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().then((w) => w.once('ready-to-show', () => w.show()))
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
