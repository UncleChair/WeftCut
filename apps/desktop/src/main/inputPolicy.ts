// Electron-free keyboard/menu policy, kept pure so the rules are verifiable
// without launching a BrowserWindow. Owns the `before-input-event` predicates
// (which keys are Chromium page-zoom accelerators, which developer affordance a
// key maps to) and the platform decision for clearing the native application
// menu. See ADR 0031.
export interface KeyInput {
  type: string
  key: string
  code: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

const PAGE_ZOOM_CODES = new Set([
  'Minus',
  'Equal',
  'Digit0',
  'NumpadSubtract',
  'NumpadAdd',
  'Numpad0',
])

export function isPageZoomShortcut(input: KeyInput): boolean {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return false

  // `code` is layout-independent. The key fallback covers synthetic events and
  // platforms which report an empty/unknown physical code for keypad input.
  return PAGE_ZOOM_CODES.has(input.code) || ['-', '+', '=', '0'].includes(input.key)
}

export type DevKeyAction = 'reload' | 'forceReload' | 'toggleDevTools' | 'toggleFullscreen'

// `code` is layout- and modifier-independent (macOS reports `KeyI` for Option+I
// even though it prints a dead key), so prefer it; `key` is a fallback for
// synthetic events that carry an empty `code`.
function isKey(input: KeyInput, code: string, keys: readonly string[]): boolean {
  return input.code === code || keys.includes(input.key)
}

// Maps a key to the developer affordance it triggers, or null for none. Gated on
// `isDev` so a production build leaves every key inert here (Chromium keeps its
// own behavior). Page-zoom chords always return null — isPageZoomShortcut owns
// them on this same seam. Fullscreen is F11 (the Windows/Linux convention).
export function matchDevKeyAction(input: KeyInput, isDev: boolean): DevKeyAction | null {
  if (!isDev || input.type !== 'keyDown') return null

  if (isKey(input, 'F12', ['F12'])) return 'toggleDevTools'
  if (isKey(input, 'F11', ['F11'])) return 'toggleFullscreen'

  // DevTools: Ctrl+Shift+I on Windows/Linux, Cmd+Alt+I on macOS.
  if (isKey(input, 'KeyI', ['i', 'I'])) {
    const winLinux = input.control && input.shift && !input.alt && !input.meta
    const mac = input.meta && input.alt && !input.control && !input.shift
    return winLinux || mac ? 'toggleDevTools' : null
  }

  if (isKey(input, 'KeyR', ['r', 'R']) && (input.control || input.meta) && !input.alt) {
    return input.shift ? 'forceReload' : 'reload'
  }

  return null
}

// Whether to remove Electron's default application menu at startup, per platform.
// win32/linux: true — the window is frameless (the renderer draws its own menu
// bar), so a native menu never renders yet its accelerators still preempt the
// renderer's useShortcuts for chords like Mod+W / Mod+C / Mod+Z. Clearing it makes
// the renderer the single, uncontested owner of every shortcut.
// Everything else (incl. macOS): false. macOS installs an EXPLICIT menu instead
// of clearing (src/main/appMenu.ts, ADR 0031 Stage 2 revised): it wants the
// App/Edit/Window roles for platform conventions, and Electron's default menu
// ships Reload + DevTools to end users. Returning false here is therefore only
// half the macOS answer — the caller must install that menu, or the default one
// stays live. The reason this comment used to give — "clearing the menu breaks
// Cmd+C/V in text inputs" — was measured FALSE on Electron 42; the renderer is
// upstream of the menu and a preventDefault() beats a role. See
// docs/notes/electron-chromium-behavior.md.
export function shouldClearApplicationMenu(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'linux'
}
