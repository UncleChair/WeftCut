import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  WeftcutApi,
  AppNotice,
  DialogOpenOpts,
  DialogSaveOpts,
  DirEntry,
  WinCreateOpts,
  WinAction,
} from '../shared/ipc'

type Listener = (payload: unknown) => void

// The contextBridge surface — the COMPLETE set of things the (untrusted)
// renderer can ask the main process to do. Grouped, named methods rather than a
// generic `invoke(channel)` passthrough: a compromised renderer can only reach
// these specific operations, and the IPC surface is auditable at a glance
// (Electron security guidance: expose APIs, not channels). The one generic
// channel is `backend.invoke`, which fronts the napi/Rust command dispatcher —
// a single controlled capability that validates its own commands.
const api: WeftcutApi = {
  backend: {
    invoke(channel: string, args?: unknown): Promise<unknown> {
      return ipcRenderer.invoke('backend:invoke', { channel, args })
    },
  },

  fs: {
    writeFile(path: string, data: Uint8Array, append?: boolean): Promise<void> {
      return ipcRenderer.invoke('fs:writeFile', { path, data, append }) as Promise<void>
    },
    writeTextFile(path: string, data: string): Promise<void> {
      return ipcRenderer.invoke('fs:writeTextFile', { path, data }) as Promise<void>
    },
    mkdir(path: string, recursive?: boolean): Promise<void> {
      return ipcRenderer.invoke('fs:mkdir', { path, recursive }) as Promise<void>
    },
    readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
      return ipcRenderer.invoke('fs:readFile', { path }) as Promise<Uint8Array<ArrayBuffer>>
    },
    remove(path: string): Promise<void> {
      return ipcRenderer.invoke('fs:remove', { path }) as Promise<void>
    },
    exists(path: string): Promise<boolean> {
      return ipcRenderer.invoke('fs:exists', { path }) as Promise<boolean>
    },
    readDir(path: string): Promise<DirEntry[]> {
      return ipcRenderer.invoke('fs:readDir', { path }) as Promise<DirEntry[]>
    },
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize') as Promise<void>,
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggleMaximize') as Promise<void>,
    close: (): Promise<void> => ipcRenderer.invoke('window:close') as Promise<void>,
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
    setTitle: (title: string): Promise<void> => ipcRenderer.invoke('window:setTitle', title) as Promise<void>,
  },

  dialog: {
    open(opts: DialogOpenOpts): Promise<string | string[] | null> {
      return ipcRenderer.invoke('dialog:open', opts) as Promise<string | string[] | null>
    },
    save(opts: DialogSaveOpts): Promise<string | null> {
      return ipcRenderer.invoke('dialog:save', opts) as Promise<string | null>
    },
  },

  path: {
    documentDir: (): Promise<string> => ipcRenderer.invoke('path:documentDir') as Promise<string>,
    join: (parts: string[]): Promise<string> => ipcRenderer.invoke('path:join', { parts }) as Promise<string>,
    tempDir: (): Promise<string> => ipcRenderer.invoke('path:tempDir') as Promise<string>,
  },

  mcp: {
    getInfo: (): Promise<unknown> => ipcRenderer.invoke('get_mcp_info'),
    resetToken: (): Promise<unknown> => ipcRenderer.invoke('reset_mcp_token'),
  },

  win: {
    create: (label: string, options?: WinCreateOpts): Promise<void> =>
      ipcRenderer.invoke('win:create', { label, options }) as Promise<void>,
    act: (label: string, action: WinAction): Promise<void> =>
      ipcRenderer.invoke('win:act', { label, action }) as Promise<void>,
    exists: (label: string): Promise<boolean> => ipcRenderer.invoke('win:exists', { label }) as Promise<boolean>,
  },

  media: {
    dropped: (paths: string[]): Promise<void> => ipcRenderer.invoke('media:dropped', paths) as Promise<void>,
  },

  app: {
    notices: (): Promise<AppNotice[]> => ipcRenderer.invoke('app:notices') as Promise<AppNotice[]>,
  },

  // Event subscription: main relays Rust core events via webContents.send →
  // `evt:<event>` → here.
  on(event: string, cb: Listener): () => void {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(`evt:${event}`, handler)
    return () => ipcRenderer.removeListener(`evt:${event}`, handler)
  },
  off(event: string): void {
    ipcRenderer.removeAllListeners(`evt:${event}`)
  },

  // Stream one raw frame to the native video sink over IPC (the Electron-native
  // alternative to the loopback WebSocket transport).
  videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void> {
    return ipcRenderer.invoke('export:videosink_write', bytes) as Promise<void>
  },
}

contextBridge.exposeInMainWorld('api', api)

// Resolve drag-drop file paths in the preload's own drop listener.
// Background: in Electron 30+, a File passed across the contextBridge loses its
// disk-backing, so webUtils.getPathForFile() returns '' when called from the
// renderer side (electron/electron#44600). The fix is to intercept drop events
// here in the preload where the File objects are still native-backed.
function wireFileDrop(): void {
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
  })
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
    if (!(e.target instanceof Element && e.target.closest('.media-pool'))) return
    e.preventDefault()
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => {
        try {
          return webUtils.getPathForFile(f)
        } catch {
          return ''
        }
      })
      .filter((p) => p.length > 0)
    if (paths.length > 0) void ipcRenderer.invoke('media:dropped', paths)
  })
}
wireFileDrop()

// Frameless-window drag regions. The renderer marks its titlebars with the
// `data-drag-region` attribute; Electron doesn't treat it as draggable on its
// own — it uses the CSS `-webkit-app-region` property. Bridge the two by
// injecting a stylesheet
// (interactive descendants get `no-drag` so window controls / buttons stay
// clickable).
function injectDragRegionStyles(): void {
  const style = document.createElement('style')
  style.textContent = `
    [data-drag-region] { -webkit-app-region: drag; }
    [data-drag-region] :where(button, a, input, select, textarea, [role="button"], [contenteditable]) { -webkit-app-region: no-drag; }
  `
  document.head.appendChild(style)
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectDragRegionStyles)
} else {
  injectDragRegionStyles()
}
