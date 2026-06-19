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
    // No direct maximize/unmaximize handlers in S2 main; safe no-ops.
    maximize: () => Promise.resolve(),
    unmaximize: () => Promise.resolve(),
    close: ctl('close'),
    // show() is called in main.tsx's requestAnimationFrame on boot.
    // The Electron main already shows the window via ready-to-show; this
    // no-ops so the renderer's call is harmless.
    show: () => Promise.resolve(),
    // WindowControls.tsx calls isMaximized() on mount to sync the glyph.
    // Real call to the main window:isMaximized handler.
    isMaximized: () => window.api.invoke('window:isMaximized') as Promise<boolean>,
    // WindowControls.tsx calls onResized(cb) to keep the glyph in sync.
    // No backend subscription in S2; returns a no-op unlisten.
    onResized: (_cb: () => void) => Promise.resolve(() => undefined),
    // App.tsx calls setTitle(string).
    setTitle: (title: string) => window.api.invoke('window:setTitle', title) as Promise<void>,
    // App.tsx checks isFocused() in a drag-drop handler.
    // No backend handler in S2; always returns true (safe default).
    isFocused: () => Promise.resolve(true),
    // App.tsx calls destroy() on emergency close confirmation.
    // No backend handler in S2; no-op.
    destroy: () => Promise.resolve(),
    // PerfHUD.tsx calls onCloseRequested.
    // No backend subscription in S2; returns a no-op unlisten.
    onCloseRequested: (_cb: (event: { preventDefault: () => void }) => void | Promise<void>) =>
      Promise.resolve(() => undefined),
    // App.tsx calls setProgressBar({ status, progress }).
    // No backend handler in S2; no-op.
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
