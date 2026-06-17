// Replaces @tauri-apps/api/webviewWindow.
// Imports seen in src/: WebviewWindow
// Used in App.tsx and PerfHUD.tsx for creating secondary windows (PerfHUD popup).
// In S1 this is a stub class that no-ops; the PerfHUD feature degrades gracefully.

export class WebviewWindow {
  constructor(
    public readonly label: string,
    _options?: Record<string, unknown>,
  ) {}

  async show(): Promise<void> {
    // stub
  }

  async hide(): Promise<void> {
    // stub
  }

  async close(): Promise<void> {
    // stub
  }

  async center(): Promise<void> {
    // stub
  }

  // Static helper used in some Tauri patterns
  static getByLabel(_label: string): WebviewWindow | null {
    return null
  }
}
