// Replaces @tauri-apps/api/core for the renderer.
// The ~70 callers in src/ipc/index.ts import { invoke } from here unchanged
// (via Vite alias in electron.vite.config.ts).
// convertFileSrc: in Tauri this rewrites a fs path to an asset:// URL.
// In S1 we return the path as-is; S3 will replace with a protocol.handle URL.
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
