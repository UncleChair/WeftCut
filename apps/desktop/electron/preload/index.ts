import { contextBridge, ipcRenderer } from 'electron'

type Listener = (payload: unknown) => void

const api = {
  invoke(channel: string, args?: unknown): Promise<unknown> {
    // window:* and path:* are served by direct ipcMain handlers in the main
    // process, not the napi backend dispatcher. Route them straight through.
    if (
      channel.startsWith('window:') ||
      channel.startsWith('path:') ||
      channel.startsWith('dialog:') ||
      channel.startsWith('fs:') ||
      channel === 'get_mcp_info' ||
      channel === 'reset_mcp_token'
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
}

contextBridge.exposeInMainWorld('api', api)

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
