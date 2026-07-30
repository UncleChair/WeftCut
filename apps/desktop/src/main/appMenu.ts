// The macOS application menu — WeftCut's OS-integration surface.
//
// Windows/Linux run with NO application menu at all (`setApplicationMenu(null)`,
// see inputPolicy.ts): the window is frameless there and the renderer draws its
// own bar. macOS cannot do that — the menu bar belongs to the system — so this
// module builds an EXPLICIT one, and Electron's default menu never goes live.
//
// Why explicit rather than default (ADR 0031, Stage 2):
//   • the default menu binds Cmd+R / Shift+Cmd+R (reload) and Alt+Cmd+I
//     (DevTools) in PRODUCTION, and a renderer reload discards unsaved
//     in-memory timeline state;
//   • its Cmd+W closes the window and its Cmd+Z runs `webContents.undo()`
//     (DOM text undo, never project history) — both the wrong handler for this
//     app's own actions.
//
// The renderer stays the owner of every app shortcut. It is UPSTREAM of the
// menu on macOS: `useShortcuts` sees every chord first and its
// `preventDefault()` suppresses the matching menu item — measured, not assumed
// (docs/notes/electron-chromium-behavior.md). So this menu is additive, not a
// competing dispatcher, and no item here needs to be display-only.
//
// Two rules the same notes file makes non-negotiable:
//   1. Never strip an accelerator off a ROLE item. `accelerator: ''` silently
//      kills the role's native behaviour and `registerAccelerator: false` is
//      ignored on macOS. Include a role whole, or omit it.
//   2. Build View by hand. `role: 'viewMenu'` re-adds Reload and DevTools.
//
// The template is a pure function so the shape is unit-testable without
// launching a BrowserWindow; only `electron` TYPES are imported here (erased at
// runtime). Installation lives in src/main/index.ts.
import type { MenuItemConstructorOptions } from 'electron'

/// Roles that must never appear in a shipped menu. Developer affordances live
/// in `hardenWindow`'s `before-input-event` seam instead, gated on `isDev`, so
/// dev and prod share one code path on every platform (ADR 0031 Stage 1).
/// Compared case-insensitively: Electron lowercases `role` on the live
/// MenuItem, while a template spells it camelCase.
export const FORBIDDEN_MENU_ROLES = ['reload', 'forceReload', 'toggleDevTools'] as const

/// The macOS menu bar. App / Edit / Window come from roles so AppKit supplies
/// their behaviour, ordering, and localisation; View is hand-built and holds
/// nothing but fullscreen.
export function buildApplicationMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    // Hand-built, per rule 2 above. `togglefullscreen` is the one View item Mac
    // convention expects; the in-app View menu (workspace profiles) stays
    // renderer-only and stays primary — `.app-header` is visible in fullscreen,
    // where the system hides this bar behind a hover reveal.
    { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]
}
