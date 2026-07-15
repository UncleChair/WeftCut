// Window controls + secondary-window handle, backed by the Electron main
// process over window.api (window:* / win:* IPC). getCurrentWindow() mirrors
// the small surface the renderer uses (titlebar controls, taskbar progress);
// SecondaryWindow is the secondary-window handle (PerfHUD / Render&Play).

export function getCurrentWindow() {
  return {
    minimize: () => window.api.window.minimize(),
    toggleMaximize: () => window.api.window.toggleMaximize(),
    // No direct maximize/unmaximize handlers in main; safe no-ops.
    maximize: () => Promise.resolve(),
    unmaximize: () => Promise.resolve(),
    close: () => window.api.window.close(),
    // The Electron main already shows the window via ready-to-show; this
    // no-ops so the renderer's boot-time show() call is harmless.
    show: () => Promise.resolve(),
    // WindowControls.tsx calls isMaximized() once on mount for the initial glyph.
    isMaximized: () => window.api.window.isMaximized(),
    // Live maximize-state sync: main emits `evt:window:maximize-changed` carrying
    // { isMaximized } on maximize/unmaximize (src/main/index.ts) — the external
    // paths (drag-region double-click, Win+arrow, drag-to-top). Forward the flag
    // so the caller updates the glyph straight from the payload, with no extra
    // isMaximized() round-trip. Returns the subscription's unlisten.
    onMaximizeChange: (cb: (isMaximized: boolean) => void) =>
      Promise.resolve(
        window.api.on('window:maximize-changed', (p) =>
          cb(!!(p as { isMaximized?: boolean } | undefined)?.isMaximized),
        ),
      ),
    // macOS native fullscreen (green button) enter/leave, emitted by main
    // (src/main/index.ts). Used to drop the traffic-light inset while the
    // buttons are hidden in fullscreen. Returns the subscription's unlisten.
    onFullscreenChange: (cb: (isFullscreen: boolean) => void) =>
      Promise.resolve(
        window.api.on('window:fullscreen-changed', (p) =>
          cb(!!(p as { isFullscreen?: boolean } | undefined)?.isFullscreen),
        ),
      ),
    setTitle: (title: string) => window.api.window.setTitle(title),
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

export class SecondaryWindow {
  public readonly label: string

  constructor(label: string, options?: Record<string, unknown>) {
    this.label = label
    if (!_suppressCreate) {
      void window.api.win.create(label, options as Parameters<typeof window.api.win.create>[1])
    }
  }

  async show(): Promise<void> { await window.api.win.act(this.label, 'show') }
  async hide(): Promise<void> { await window.api.win.act(this.label, 'hide') }
  async close(): Promise<void> { await window.api.win.act(this.label, 'close') }
  async center(): Promise<void> { await window.api.win.act(this.label, 'center') }
  async setFocus(): Promise<void> { await window.api.win.act(this.label, 'focus') }

  // Returns a handle if the labelled window exists, else null. Mirrors the
  // shape PerfHUD consumes (it calls .then() on the result).
  static async getByLabel(label: string): Promise<SecondaryWindow | null> {
    const exists = await window.api.win.exists(label)
    if (!exists) return null
    // Construct a handle without firing win:create (window already exists).
    _suppressCreate = true
    try {
      return new SecondaryWindow(label)
    } finally {
      _suppressCreate = false
    }
  }
}
