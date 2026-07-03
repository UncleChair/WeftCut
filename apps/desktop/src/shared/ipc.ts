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

// `decorations` is the Tauri-era name kept at the IPC boundary: true (the
// default in createSecondary) gives the window a native OS frame with a title
// bar (move/close). Secondary windows draw no custom titlebar, so omit it (or
// pass true) for everything except a window that paints its own caption.
export type WinCreateOpts = {
  url?: string
  width?: number
  height?: number
  title?: string
  decorations?: boolean
  resizable?: boolean
  minWidth?: number
  minHeight?: number
}

export type WinAction = 'show' | 'hide' | 'close' | 'center' | 'focus'

export type NotificationOpts = { title?: string; body?: string }

/// Process-tree resource snapshot derived from Electron's app.getAppMetrics().
/// Covers the whole app process tree (main + renderers + GPU + utility), not
/// the host machine. See src/main/metrics.ts for the CPU-normalization landmine.
export type SystemStats = {
  /// Summed CPU across the process tree, as a % of the whole machine (0–100).
  cpu_percent: number
  /// Summed resident memory (working set) of the process tree, in bytes.
  rss_bytes: number
  /// Number of processes in the Electron tree.
  process_count: number
  /// Logical core count — context for cpu_percent.
  logical_cores: number
}

/// An app-level notice surfaced to the user (non-modal corner panel). `code`
/// keys the i18n strings + the dismissable UI; main collects these at startup
/// (e.g. keyring-unavailable → plaintext cloud keys) and the renderer PULLS them
/// on mount via `app.notices()` — a pull model so a notice can't be lost to the
/// fire-once-before-subscribe race a pushed event had.
export type AppNotice = { level: 'info' | 'warn' | 'error'; code: string }

/// Color-space tag for a native GPU-preview shared-texture import. Mirrors
/// Electron's `ColorSpace` structure (main passes it straight to
/// `importSharedTexture`); typed structurally here so this DOM/electron-free
/// contract file stays free of the Electron types. Task 7 supplies the enum
/// values (e.g. bt709/limited) from the source's color metadata.
export type PreviewGpuColorSpace = {
  primaries: string
  transfer: string
  matrix: string
  range: 'limited' | 'full' | 'derived' | 'invalid'
}

/// Reply of `previewGpu.open`: decoded stream dimensions + the realized pool
/// size (native may hand back fewer slots than requested).
export type PreviewGpuOpenReply = { width: number; height: number; poolSize: number }

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
  /// Open a path or URL in the OS default handler (file manager / browser).
  shell: { open(target: string): Promise<void> }
  /// Post a desktop notification (best-effort; no-op where unsupported).
  notification: { send(opts: NotificationOpts): Promise<void> }
  /// Process-tree resource snapshot (app.getAppMetrics(), main-side).
  metrics: { get(): Promise<SystemStats> }
  /// Best-effort OS font-file lookup by family name (main-side scan); null when
  /// not found, so the renderer falls back to the bundled font chain.
  font: { resolve(family: string): Promise<Uint8Array | null> }
  /// Native GPU-decode preview (Windows). Session commands only — per-frame
  /// `ImageBitmap`s do NOT travel over this bridge (a MessagePort/frame can't
  /// cross contextBridge). Instead `requestPort()` hands a MessagePort to the
  /// main world via `window.postMessage`, over which the preload posts each
  /// decoded frame; the renderer (Task 7) listens for the one-time port message
  /// then reads frames off `port.onmessage`. consumeAck is preload-internal
  /// (fired after createImageBitmap), so it is deliberately NOT exposed here.
  previewGpu: {
    open(args: {
      streamId: string
      path: string
      poolSize: number
      colorSpace: PreviewGpuColorSpace
    }): Promise<PreviewGpuOpenReply>
    requestFrameAt(args: { streamId: string; targetUs: number }): Promise<void>
    close(args: { streamId: string }): Promise<void>
    requestPort(): void
  }
  on(event: string, cb: (payload: unknown) => void): () => void
  off(event: string): void
  /// Broadcast an event to every app window (delivered to `on()` subscribers as
  /// `evt:<event>`). Backs the renderer's cross-window `emit()` (bridge/events.ts).
  emit(event: string, payload?: unknown): Promise<void>
  videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void>
}
