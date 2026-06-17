import { contextBridge, ipcRenderer } from 'electron'

type Listener = (payload: unknown) => void

const api = {
  invoke(channel: string, args?: unknown): Promise<unknown> {
    // window:* and path:* are served by direct ipcMain handlers in the main
    // process, not the napi backend dispatcher. Route them straight through.
    if (channel.startsWith('window:') || channel.startsWith('path:')) {
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
export type Api = typeof api
