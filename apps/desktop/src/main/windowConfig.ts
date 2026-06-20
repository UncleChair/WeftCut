// Pure config for secondary BrowserWindows (PerfHUD popup, Render & Play).
// Kept electron-free (operates on plain options, returns a plain object) so it's
// unit-testable without launching a BrowserWindow — same rule as metrics.ts.
//
// LANDMINE: a secondary window with NO frame and NO custom titlebar has no bar —
// un-movable and un-closable. So the default here is DECORATED (native OS frame).
// A window may pass `decorations: false` ONLY if its renderer draws its own
// titlebar + <WindowControls/> (the PerfHUD popup does, matching the MAIN
// window's frameless self-drawn caption — see index.ts / WindowControls.tsx).

// Twin of the secondary-window fields of `WinCreateOpts` in src/shared/ipc.ts.
// Defined locally because main deliberately does NOT import the DOM-side preload
// contract (that file references `File` etc. and isn't compiled under main's
// lib) — same rule as metrics.ts's local SystemStats. Keep the shapes in sync.
export interface SecondaryWinOpts {
  url?: string
  width?: number
  height?: number
  title?: string
  decorations?: boolean
  resizable?: boolean
  minWidth?: number
  minHeight?: number
}

export interface SecondaryWindowConfig {
  width: number
  height: number
  minWidth: number | undefined
  minHeight: number | undefined
  title: string | undefined
  resizable: boolean
  show: boolean
  frame: boolean
  backgroundColor: string
}

export function secondaryWindowConfig(opts?: SecondaryWinOpts): SecondaryWindowConfig {
  return {
    width: opts?.width ?? 480,
    height: opts?.height ?? 320,
    minWidth: opts?.minWidth,
    minHeight: opts?.minHeight,
    title: opts?.title,
    resizable: opts?.resizable ?? true,
    // Show on create: a framed window surfaces reliably, and backgroundColor
    // avoids a white flash.
    show: true,
    frame: opts?.decorations !== false,
    backgroundColor: '#0a0a0a',
  }
}
