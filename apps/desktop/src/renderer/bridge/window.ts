// Window controls + secondary-window handle, backed by the Electron main
// process over window.api (window:* / win:* IPC). getCurrentWindow() mirrors
// the small surface the renderer uses (titlebar controls, taskbar progress);
// WebviewWindow is the secondary-window handle (PerfHUD / Render&Play).

function ctl(action: string) {
  return () => window.api.invoke(`window:${action}`)
}

export function getCurrentWindow() {
  return {
    minimize: ctl('minimize'),
    toggleMaximize: ctl('toggleMaximize'),
    // No direct maximize/unmaximize handlers in main; safe no-ops.
    maximize: () => Promise.resolve(),
    unmaximize: () => Promise.resolve(),
    close: ctl('close'),
    // The Electron main already shows the window via ready-to-show; this
    // no-ops so the renderer's boot-time show() call is harmless.
    show: () => Promise.resolve(),
    // WindowControls.tsx calls isMaximized() on mount to sync the glyph.
    isMaximized: () => window.api.invoke('window:isMaximized') as Promise<boolean>,
    // No live resize subscription in main; returns a no-op unlisten.
    onResized: (_cb: () => void) => Promise.resolve(() => undefined),
    setTitle: (title: string) => window.api.invoke('window:setTitle', title) as Promise<void>,
    // No backend handler; safe default (used in a drag-drop guard).
    isFocused: () => Promise.resolve(true),
    // No backend handler; no-op (emergency close confirmation).
    destroy: () => Promise.resolve(),
    // No backend subscription; returns a no-op unlisten.
    onCloseRequested: (_cb: (event: { preventDefault: () => void }) => void | Promise<void>) =>
      Promise.resolve(() => undefined),
    // No backend handler; no-op.
    setProgressBar: (_opts: unknown) => Promise.resolve(),
  }
}

// Taskbar progress states used by App.tsx.
export const ProgressBarStatus = {
  None: 'none',
  Normal: 'normal',
  Indeterminate: 'indeterminate',
  Paused: 'paused',
  Error: 'error',
} as const
export type ProgressBarStatus = (typeof ProgressBarStatus)[keyof typeof ProgressBarStatus]

// Secondary-window handle, backed by a real Electron BrowserWindow via win:*
// IPC (src/main/windows.ts). window.api is declared in ./ipc.
let _suppressCreate = false

export class WebviewWindow {
  public readonly label: string

  constructor(label: string, options?: Record<string, unknown>) {
    this.label = label
    if (!_suppressCreate) {
      void window.api.invoke('win:create', { label, options })
    }
  }

  async show(): Promise<void> { await window.api.invoke('win:act', { label: this.label, action: 'show' }) }
  async hide(): Promise<void> { await window.api.invoke('win:act', { label: this.label, action: 'hide' }) }
  async close(): Promise<void> { await window.api.invoke('win:act', { label: this.label, action: 'close' }) }
  async center(): Promise<void> { await window.api.invoke('win:act', { label: this.label, action: 'center' }) }
  async setFocus(): Promise<void> { await window.api.invoke('win:act', { label: this.label, action: 'focus' }) }

  // Callers pass a lifecycle event name to be notified of create/failure. The
  // Electron secondary-window lifecycle isn't bridged here, so this is a no-op
  // that keeps the signature (load failures log in main).
  once(_event: string, _cb: (...a: unknown[]) => void): void { /* no-op */ }

  // Returns a handle if the labelled window exists, else null. Mirrors the
  // shape PerfHUD consumes (it calls .then() on the result).
  static async getByLabel(label: string): Promise<WebviewWindow | null> {
    const exists = await window.api.invoke('win:exists', { label })
    if (!exists) return null
    // Construct a handle without firing win:create (window already exists).
    _suppressCreate = true
    try {
      return new WebviewWindow(label)
    } finally {
      _suppressCreate = false
    }
  }
}
