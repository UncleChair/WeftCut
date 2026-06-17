// Replaces @tauri-apps/api/window.
// Imports seen in src/: getCurrentWindow, ProgressBarStatus
// getCurrentWindow().show() is called in main.tsx on boot — we return a
// no-op stub so the boot doesn't throw (the Electron main already handles
// show via ready-to-show).
// ProgressBarStatus is an enum used in App.tsx; exported as a const enum mimic.

function ctl(action: string) {
  return () => window.api.invoke(`window:${action}`)
}

export function getCurrentWindow() {
  return {
    minimize: ctl('minimize'),
    toggleMaximize: ctl('toggleMaximize'),
    maximize: ctl('maximize'),
    unmaximize: ctl('unmaximize'),
    close: ctl('close'),
    // show() is called in main.tsx's requestAnimationFrame on boot.
    // The Electron main already shows the window via ready-to-show; this
    // no-ops so the renderer's call is harmless.
    show: () => Promise.resolve(),
    setProgressBar: (_progress: number, _opts?: unknown) =>
      window.api.invoke('window:setProgressBar', { _progress, _opts }),
    // WindowControls.tsx calls isMaximized() on mount to sync the glyph.
    // S1 stub: always returns false (not maximized).
    isMaximized: () => Promise.resolve(false),
    // WindowControls.tsx calls onResized(cb) to keep the glyph in sync.
    // S1 stub: registers nothing, returns a no-op unlisten.
    onResized: (_cb: () => void) => Promise.resolve(() => undefined),
    // App.tsx calls setProgressBar via Tauri's ProgressBarStatus API.
    // S1 stub: no-op.
    setTitle: (_title: string) => Promise.resolve(),
    // App.tsx checks isFocused() in a drag-drop handler.
    isFocused: () => Promise.resolve(true),
    // App.tsx calls destroy() on emergency close confirmation.
    destroy: () => window.api.invoke('window:destroy'),
    // PerfHUD.tsx calls onCloseRequested.
    onCloseRequested: (_cb: (event: { preventDefault: () => void }) => void | Promise<void>) =>
      Promise.resolve(() => undefined),
    // App.tsx calls setProgressBar({ status, progress }).
    setProgressBar: (_opts: unknown) => Promise.resolve(),
  }
}

// Mirror of Tauri's ProgressBarStatus enum. Values used in App.tsx.
export const ProgressBarStatus = {
  None: 'none',
  Normal: 'normal',
  Indeterminate: 'indeterminate',
  Paused: 'paused',
  Error: 'error',
} as const
export type ProgressBarStatus = (typeof ProgressBarStatus)[keyof typeof ProgressBarStatus]
