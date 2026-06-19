import { contextBridge, ipcRenderer, webUtils } from 'electron'

type Listener = (payload: unknown) => void

const api = {
  invoke(channel: string, args?: unknown): Promise<unknown> {
    // window:*, win:*, path:* etc. are served by direct ipcMain handlers in the
    // main process, not the napi backend dispatcher. Route them straight through.
    if (
      channel.startsWith('window:') ||
      channel.startsWith('win:') ||
      channel.startsWith('path:') ||
      channel.startsWith('dialog:') ||
      channel.startsWith('fs:') ||
      channel === 'get_mcp_info' ||
      channel === 'reset_mcp_token' ||
      channel === 'media:dropped'
    ) {
      return ipcRenderer.invoke(channel, args)
    }
    return ipcRenderer.invoke('backend:invoke', { channel, args })
  },
  // Event subscription: real wiring lands in S2 (TSFN -> main -> webContents.send).
  on(event: string, cb: Listener): () => void {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(`evt:${event}`, handler)
    return () => ipcRenderer.removeListener(`evt:${event}`, handler)
  },
  off(event: string): void {
    ipcRenderer.removeAllListeners(`evt:${event}`)
  },
  // Electron drops give File objects, not paths. webUtils.getPathForFile is the
  // sanctioned API (File.path was removed). Per-File (not FileList) is reliable
  // across the contextBridge boundary.
  getPathForFile(file: File): string {
    try { return webUtils.getPathForFile(file) } catch { return '' }
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
    const onPool = e.target instanceof Element && !!e.target.closest('.media-pool')
    if (!onPool) return
    e.preventDefault()
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => { try { return webUtils.getPathForFile(f) } catch { return '' } })
      .filter((p) => p.length > 0)
    console.log('[drop] media-pool drop', { fileCount: e.dataTransfer.files.length, paths })
    if (paths.length > 0) void ipcRenderer.invoke('media:dropped', paths)
  })
}
wireFileDrop()

// Frameless-window drag regions. The renderer marks its titlebars with Tauri's
// `data-tauri-drag-region` attribute; Electron doesn't honor that — it uses the
// CSS `-webkit-app-region` property. Bridge the two by injecting a stylesheet
// (interactive descendants get `no-drag` so window controls / buttons stay
// clickable). Injected from preload to respect the no-`src/**`-edit fence.
function injectDragRegionStyles(): void {
  const style = document.createElement('style')
  style.textContent = `
    [data-tauri-drag-region] { -webkit-app-region: drag; }
    [data-tauri-drag-region] :where(button, a, input, select, textarea, [role="button"], [contenteditable]) { -webkit-app-region: no-drag; }
  `
  document.head.appendChild(style)
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectDragRegionStyles)
} else {
  injectDragRegionStyles()
}

export type Api = typeof api
