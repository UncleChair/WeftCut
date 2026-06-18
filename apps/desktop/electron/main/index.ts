import path from 'node:path'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { app, BrowserWindow, ipcMain, protocol } from 'electron'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'weftcut-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
])

const require_ = createRequire(import.meta.url)
const { Backend } = require_('@weftcut/core') as typeof import('@weftcut/core')

let backend: import('@weftcut/core').Backend | null = null
let mainWindow: BrowserWindow | null = null

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
  // Construct + init the Backend before creating the window
  backend = new Backend(
    app.getPath('userData'),
    path.join(app.getPath('userData'), 'Cache'),
    (_err: Error | null, msg: string) => {
      if (!msg) return
      const { event, payload } = JSON.parse(msg)
      mainWindow?.webContents.send('evt:' + event, payload)
    },
  )
  await backend.init()
  console.log('[main] backend init OK')

  ipcMain.handle('backend:invoke', async (_e, { channel, args }) => {
    const json = await backend!.invoke(channel, JSON.stringify(args ?? {}))
    return JSON.parse(json)
  })

  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggleMaximize', () =>
    mainWindow?.isMaximized() ? mainWindow?.unmaximize() : mainWindow?.maximize(),
  )
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => !!mainWindow?.isMaximized())
  ipcMain.handle('window:setTitle', (_e, title: string) => mainWindow?.setTitle(title))
  ipcMain.handle('path:documentDir', () => app.getPath('documents'))
  ipcMain.handle('path:join', (_e, { parts }: { parts: string[] }) => path.join(...parts))
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
