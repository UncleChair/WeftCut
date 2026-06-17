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
