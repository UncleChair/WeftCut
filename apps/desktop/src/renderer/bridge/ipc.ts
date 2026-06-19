// Core IPC bridge to the Electron main process (window.api). The renderer's
// backend calls in src/renderer/ipc/index.ts import { invoke } from here, which
// fronts the napi/Rust command dispatcher via `window.api.backend.invoke`.
// Specific main-process operations (fs/window/dialog/path/mcp/win/media) are
// named methods on window.api (see src/preload/index.ts) and have their own
// bridge wrappers (bridge/fs.ts, bridge/window.ts, …).
//
// convertFileSrc maps a filesystem path to a URL the renderer can load (the
// weftcut-media:// protocol served by main).

type DialogOpenOpts = {
  title?: string
  multiple?: boolean
  directory?: boolean
  filters?: { name: string; extensions: string[] }[]
  defaultPath?: string
}
type DialogSaveOpts = { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }
type DirEntry = { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }
type WinCreateOpts = { url?: string; width?: number; height?: number; title?: string }
type WinAction = 'show' | 'hide' | 'close' | 'center' | 'focus'

/** The contextBridge surface exposed by the preload. Hand-mirrored from
 *  src/preload/index.ts's `api` (the two are not import-linked across the
 *  main/renderer tsconfig boundary). */
export interface WeftcutApi {
  backend: { invoke(channel: string, args?: unknown): Promise<unknown> }
  fs: {
    writeFile(path: string, data: Uint8Array, append?: boolean): Promise<void>
    writeTextFile(path: string, data: string): Promise<void>
    mkdir(path: string, recursive?: boolean): Promise<void>
    readFile(path: string): Promise<Uint8Array<ArrayBuffer>>
    remove(path: string): Promise<void>
    exists(path: string): Promise<boolean>
    readDir(path: string): Promise<DirEntry[]>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    setTitle(title: string): Promise<void>
  }
  dialog: {
    open(opts: DialogOpenOpts): Promise<string | string[] | null>
    save(opts: DialogSaveOpts): Promise<string | null>
  }
  path: {
    documentDir(): Promise<string>
    join(parts: string[]): Promise<string>
    tempDir(): Promise<string>
  }
  mcp: { getInfo(): Promise<unknown>; resetToken(): Promise<unknown> }
  win: {
    create(label: string, options?: WinCreateOpts): Promise<void>
    act(label: string, action: WinAction): Promise<void>
    exists(label: string): Promise<boolean>
  }
  media: { dropped(paths: string[]): Promise<void> }
  on(event: string, cb: (payload: unknown) => void): () => void
  off(event: string): void
  getPathForFile(file: File): string
  videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void>
}

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
