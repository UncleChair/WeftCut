// Replaces @tauri-apps/api/webviewWindow. Backed by a real Electron secondary
// BrowserWindow via win:* IPC (electron/main/windows.ts).
// Window.api is declared with the full shape in tauri-core.ts; no re-declaration here.

// Flag used to suppress win:create from the internal no-op constructor path.
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

  // The renderer calls win.once('tauri://created', cb) and win.once('tauri://error', cb)
  // to surface create/failure events. Electron secondary-window lifecycle isn't
  // bridged here, so both are no-ops (load failures log in main). Keep the
  // signature so callers don't throw.
  once(_event: string, _cb: (...a: unknown[]) => void): void { /* no-op */ }

  // getByLabel mirrors the Tauri API which returns a Promise<WebviewWindow | null>.
  // PerfHUD calls .then() on the result. We check win:exists on main and return
  // a handle instance (truthy) if found, or null if not.
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
