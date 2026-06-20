// Single source of truth for the preload IPC contract — the shape of
// `window.api`. Shared between the two DOM-context sides that must agree on it:
//   - src/preload/index.ts   implements it: `const api: WeftcutApi = {…}`
//                            (so the implementation is compile-checked here)
//   - src/renderer/bridge/   consumes it: augments `Window` + wraps each method
// Because both type-check against THIS definition, the two sides cannot drift.
// The main process does not consume this contract, so it does not reference
// this project.
//
// Types only — no runtime. `File` etc. resolve from DOM (both consumers are DOM
// contexts); this file is never imported by the non-DOM main process.

export type DialogOpenOpts = {
  title?: string
  multiple?: boolean
  directory?: boolean
  filters?: { name: string; extensions: string[] }[]
  defaultPath?: string
}

export type DialogSaveOpts = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export type DirEntry = { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }

export type WinCreateOpts = { url?: string; width?: number; height?: number; title?: string }

export type WinAction = 'show' | 'hide' | 'close' | 'center' | 'focus'

/// An app-level notice surfaced to the user (non-modal corner panel). `code`
/// keys the i18n strings + the dismissable UI; main collects these at startup
/// (e.g. keyring-unavailable → plaintext cloud keys) and the renderer PULLS them
/// on mount via `app.notices()` — a pull model so a notice can't be lost to the
/// fire-once-before-subscribe race a pushed event had.
export type AppNotice = { level: 'info' | 'warn' | 'error'; code: string }

export interface WeftcutApi {
  /** The napi/Rust command dispatcher — one controlled channel for the whole
   *  Rust command catalog. */
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
  /// Startup notices the renderer pulls on mount (see AppNotice).
  app: { notices(): Promise<AppNotice[]> }
  on(event: string, cb: (payload: unknown) => void): () => void
  off(event: string): void
  videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void>
}
