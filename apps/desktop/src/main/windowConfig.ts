// Pure config for secondary BrowserWindows (Performance Monitor, Render & Play).
// Kept electron-free (operates on plain options, returns a plain object) so it's
// unit-testable without launching a BrowserWindow — same rule as metrics.ts.
//
// LANDMINE: a secondary window with NO frame and NO custom titlebar has no bar —
// un-movable and un-closable. So the default here is DECORATED (native OS frame).
// A window may pass `decorations: false` ONLY if its renderer draws its own
// titlebar + <WindowControls/> (the Performance Monitor does, matching the MAIN
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
  // macOS only: when a frameless popup keeps the native traffic lights (so it
  // stays closable/movable while the renderer suppresses its own caption
  // buttons — see WindowControls). Undefined on Win/Linux (truly frameless).
  titleBarStyle?: 'hidden'
  trafficLightPosition?: { x: number; y: number }
  // Publishes the traffic-light geometry to CSS as env(titlebar-area-*) so the
  // popup's own titlebar insets itself from the real buttons instead of a
  // hardcoded width (perf.css). macOS only — on Windows this flag would have the
  // OS paint native caption buttons over the renderer's own.
  titleBarOverlay?: true
  backgroundColor: string
}

export function secondaryWindowConfig(
  opts?: SecondaryWinOpts,
  platform: NodeJS.Platform = process.platform,
): SecondaryWindowConfig {
  const frameless = opts?.decorations === false
  const isMac = platform === 'darwin'
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
    // A popup that draws its own caption (decorations:false) is frameless on
    // Win/Linux. On macOS we instead keep the frame + hide only the titlebar so
    // the NATIVE traffic lights remain — otherwise, with the renderer's own
    // caption buttons suppressed on macOS, the popup would be un-closable.
    frame: frameless && !isMac ? false : true,
    ...(frameless && isMac
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 10, y: 10 },
          titleBarOverlay: true as const,
        }
      : {}),
    backgroundColor: '#0a0a0a',
  }
}
