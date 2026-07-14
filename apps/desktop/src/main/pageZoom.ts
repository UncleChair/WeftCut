// Chromium supplies page-zoom accelerators even though WeftCut has no UI-scale
// commands. Keep this predicate Electron-free so the shortcut policy is easy to
// verify without launching a BrowserWindow.
export interface PageZoomInput {
  type: string
  key: string
  code: string
  control: boolean
  meta: boolean
  alt: boolean
}

const PAGE_ZOOM_CODES = new Set([
  'Minus',
  'Equal',
  'Digit0',
  'NumpadSubtract',
  'NumpadAdd',
  'Numpad0',
])

export function isPageZoomShortcut(input: PageZoomInput): boolean {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return false

  // `code` is layout-independent. The key fallback covers synthetic events and
  // platforms which report an empty/unknown physical code for keypad input.
  return PAGE_ZOOM_CODES.has(input.code) || ['-', '+', '=', '0'].includes(input.key)
}
