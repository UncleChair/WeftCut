import path from 'node:path'
import fs from 'node:fs'
import { app, BrowserWindow } from 'electron'

const isDev = !!process.env['ELECTRON_RENDERER_URL']

async function createWindow(): Promise<BrowserWindow> {
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

  if (isDev) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
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
