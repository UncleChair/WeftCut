import { contextBridge, ipcRenderer } from 'electron'

type Listener = (payload: unknown) => void

// S1 stub: invoke rejects with a clear message so callers hit their
// error/empty paths instead of white-screening.
// S2 will replace this with real ipcRenderer.invoke -> main -> Backend dispatch.
const api = {
  invoke(channel: string, _args?: unknown): Promise<never> {
    return Promise.reject(new Error(`[stub] backend not wired in S1: ${channel}`))
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
