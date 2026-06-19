// Core IPC bridge to the Electron main process (window.api). The renderer's
// backend calls in src/renderer/ipc/index.ts import { invoke } from here.
// convertFileSrc maps a filesystem path to a URL the renderer can load
// (the weftcut-media:// protocol served by main).
declare global {
  interface Window {
    api: {
      invoke(channel: string, args?: unknown): Promise<unknown>
      on(event: string, cb: (payload: unknown) => void): () => void
      off(event: string): void
      videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void>
    }
  }
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.api.invoke(cmd, args) as Promise<T>
}

export function convertFileSrc(filePath: string, _protocol?: string): string {
  // Electron custom protocol served by protocol.handle('weftcut-media') in main,
  // with HTTP Range support (lifts the WebView2 asset:// ~1 MB ceiling).
  return `weftcut-media://localhost/${encodeURIComponent(filePath)}`
}
