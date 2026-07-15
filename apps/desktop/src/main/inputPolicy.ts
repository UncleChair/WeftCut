// Keyboard policy for the `before-input-event` seam, kept Electron-free so the
// rules are verifiable without launching a BrowserWindow. Owns two predicates:
// which keys are Chromium page-zoom accelerators, and which developer affordance
// a key maps to. See ADR 0031.
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
