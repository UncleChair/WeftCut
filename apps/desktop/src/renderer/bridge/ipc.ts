// Core IPC bridge to the Electron main process (window.api). The renderer's
// backend calls in src/renderer/ipc/index.ts import { invoke } from here, which
// fronts the napi/Rust command dispatcher via `window.api.backend.invoke`.
// Specific main-process operations (fs/window/dialog/path/mcp/win/media) are
// named methods on window.api (see src/preload/index.ts) and have their own
// bridge wrappers (bridge/fs.ts, bridge/window.ts, …).
//
// convertFileSrc maps a filesystem path to a URL the renderer can load (the
// weftcut-media:// protocol served by main).

import type { WeftcutApi } from '../../shared/ipc'

declare global {
  interface Window {
    api: WeftcutApi
  }
}

/** Send a command to the napi/Rust backend dispatcher. */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.api.backend.invoke(cmd, args) as Promise<T>
}

export function convertFileSrc(filePath: string, _protocol?: string): string {
  // Electron custom protocol served by protocol.handle('weftcut-media') in main,
  // with HTTP Range support (lifts the WebView2 asset:// ~1 MB ceiling).
  return `weftcut-media://localhost/${encodeURIComponent(filePath)}`
}
