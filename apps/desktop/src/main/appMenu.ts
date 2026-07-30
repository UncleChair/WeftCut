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
//     app's own actions;
//   • `role: 'appMenu'` has no Settings slot, and File is empty, so the two
//     places a Mac user looks first hold nothing.
//
// The renderer stays the owner of every app shortcut. It is UPSTREAM of the
// menu on macOS: `useShortcuts` sees every chord first and its
// `preventDefault()` suppresses the matching menu item — measured, not assumed
// (docs/notes/electron-chromium-behavior.md). So the accelerators below are a
// display of what the renderer already owns, and the `click` path only runs
// when the renderer did NOT consume the chord (or the user reached for the
// mouse). Either way one dispatch, never two.
//
// Two rules the same notes file makes non-negotiable:
//   1. Never strip an accelerator off a ROLE item. `accelerator: ''` silently
//      kills the role's native behaviour and `registerAccelerator: false` is
//      ignored on macOS. Include a role whole, or omit it.
//   2. Build View by hand. `role: 'viewMenu'` re-adds Reload and DevTools.
//
// Labels and accelerators are never written here — they arrive as a
// `MenuProjection` generated from the renderer's action catalogue and effective
// keybindings (src/shared/menu.ts explains the direction of that handoff). This
// module owns only the STRUCTURE: which ids appear, in what order, in which
// submenu, plus every role item.
//
// The template is a pure function so the shape is unit-testable without
// launching a BrowserWindow; only `electron` TYPES are imported here (erased at
// runtime). Installation lives in src/main/index.ts.
import type { MenuItemConstructorOptions } from 'electron'

import {
  DEFAULT_MENU_LABELS,
  MENU_ACTION_IDS,
  MENU_LABEL_KEYS,
  type MenuActionId,
  type MenuActionProjection,
  type MenuLabelKey,
  type MenuProjection,
} from '../shared/menu.js'

/// Roles that must never appear in a shipped menu. Developer affordances live
/// in `hardenWindow`'s `before-input-event` seam instead, gated on `isDev`, so
/// dev and prod share one code path on every platform (ADR 0031 Stage 1).
/// Compared case-insensitively: Electron lowercases `role` on the live
/// MenuItem, while a template spells it camelCase.
export const FORBIDDEN_MENU_ROLES = ['reload', 'forceReload', 'toggleDevTools'] as const

export interface AppMenuDeps {
  /// The renderer's latest projection, or null before its first sync — the
  /// menu installed at `app.whenReady`, when no window has painted yet.
  projection: MenuProjection | null
  /// Run an action id in the renderer. Same actions the in-app menu bar and
  /// `useShortcuts` run: one handler map, three call sites.
  dispatch: (actionId: MenuActionId) => void
  /// macOS shows the app's own name as the first menu's title whatever we pass;
  /// supplied so the template says what will actually appear.
  appName: string
}

/// The macOS menu bar.
export function buildApplicationMenuTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  const label = (key: MenuLabelKey): string =>
    deps.projection?.labels[key] ?? DEFAULT_MENU_LABELS[key]

  const file = fileSubmenu(deps)

  return [
    // Hand-built for one reason: `role: 'appMenu'` has no Settings slot, and
    // Cmd+, is where every Mac user reaches for preferences. Everything else in
    // it stays a role, so About/Services/Hide/Quit keep their native behaviour.
    {
      label: deps.appName,
      submenu: sections([
        [{ role: 'about' }],
        item(deps, 'openSettings'),
        [{ role: 'services' }],
        [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }],
        [{ role: 'quit' }],
      ]),
    },
    // Absent until the renderer reports a surface that can run these — see
    // `fileSubmenu`. No Close Window item: Cmd+W belongs to `closeProject`
    // ("Save and Close"), the app's own action on every platform.
    ...(file.length > 0 ? [{ label: label('menu.file'), submenu: file }] : []),
    { role: 'editMenu' },
    // Hand-built, per rule 2 above. `togglefullscreen` is the one View item Mac
    // convention expects; the in-app View menu (workspace profiles) stays
    // renderer-only and stays primary — `.app-header` is visible in fullscreen,
    // where the system hides this bar behind a hover reveal.
    { label: label('menu.view'), submenu: [{ role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]
}

/// File, mirroring the in-app File menu's order and grouping. Settings is the
/// deliberate exception — it moves to the App menu on macOS.
function fileSubmenu(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  return sections([
    item(deps, 'importMedia'),
    [...item(deps, 'save'), ...item(deps, 'saveAs'), ...item(deps, 'closeProject')],
    item(deps, 'export'),
  ])
}

/// One projected action, or nothing when the current renderer surface cannot
/// run it. Returned as a list so callers can splice it into a section without
/// a null check — and so an absent action collapses its separator too.
function item(deps: AppMenuDeps, actionId: MenuActionId): MenuItemConstructorOptions[] {
  const projected: MenuActionProjection | undefined = deps.projection?.actions[actionId]
  if (!projected) return []
  const accelerator = toElectronAccelerator(projected.keys[0] ?? '')
  return [
    {
      label: projected.label,
      // Omitted, never empty: an empty accelerator is what kills a role's
      // native behaviour, so the codebase never spells one that way.
      ...(accelerator ? { accelerator } : {}),
      click: () => deps.dispatch(actionId),
    },
  ]
}

/// Join non-empty groups with separators. Groups exist so an omitted action
/// cannot leave a doubled or leading separator behind.
function sections(groups: MenuItemConstructorOptions[][]): MenuItemConstructorOptions[] {
  const present = groups.filter((g) => g.length > 0)
  return present.flatMap((group, i) =>
    i === 0 ? group : [{ type: 'separator' as const }, ...group],
  )
}

/// Modifier tokens as the binding parser spells them (`shortcuts/match.ts`) →
/// Electron's. `Mod` is the parser's "Cmd on macOS, Ctrl elsewhere" token and
/// maps to Electron's equivalent rather than being resolved here.
const MODIFIERS: Record<string, string> = {
  mod: 'CommandOrControl',
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Command',
  meta: 'Command',
  command: 'Command',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
}

/// Key names the two notations spell differently. Anything not here is either a
/// single character (passed through, upper-cased) or a function key.
const KEYS: Record<string, string> = {
  Space: 'Space',
  Comma: ',',
  Period: '.',
  Backquote: '`',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc',
  Enter: 'Return',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Plus: 'Plus',
  '+': 'Plus',
}

/// Convert one catalogue chord ("Mod+Shift+S") to an Electron accelerator, or
/// null when it cannot be expressed. The two notations are close enough to look
/// interchangeable and are not — hence one converter with tests, rather than
/// string building at each call site.
///
/// Null, never a guess: an accelerator is a CLAIM on a chord in the menu bar,
/// and a wrong one would show the user a shortcut nothing dispatches.
export function toElectronAccelerator(chord: string): string | null {
  const parts = chord.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const key = parts[parts.length - 1]!
  const out: string[] = []
  for (const raw of parts.slice(0, -1)) {
    const modifier = MODIFIERS[raw.toLowerCase()]
    if (!modifier) return null
    out.push(modifier)
  }
  const resolved = KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : functionKey(key))
  if (!resolved) return null
  out.push(resolved)
  return out.join('+')
}

/// F1–F24, the one open-ended key family Electron accepts verbatim.
function functionKey(key: string): string | null {
  return /^F([1-9]|1\d|2[0-4])$/.test(key) ? key : null
}

/// Validate a projection arriving over IPC. The payload is renderer-authored,
/// so main treats it as untrusted input: unknown action ids, non-string labels
/// and malformed key lists are dropped, and anything structurally wrong
/// degrades to an empty projection (a bare role menu) rather than throwing
/// inside `Menu.buildFromTemplate`.
export function sanitizeMenuProjection(raw: unknown): MenuProjection {
  const out: MenuProjection = { actions: {}, labels: {} }
  if (typeof raw !== 'object' || raw === null) return out
  const { actions, labels } = raw as { actions?: unknown; labels?: unknown }

  if (typeof actions === 'object' && actions !== null) {
    for (const id of MENU_ACTION_IDS) {
      const entry = (actions as Record<string, unknown>)[id]
      if (typeof entry !== 'object' || entry === null) continue
      const { label, keys } = entry as { label?: unknown; keys?: unknown }
      if (typeof label !== 'string' || label === '') continue
      out.actions[id] = {
        label,
        keys: Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [],
      }
    }
  }

  if (typeof labels === 'object' && labels !== null) {
    for (const key of MENU_LABEL_KEYS) {
      const value = (labels as Record<string, unknown>)[key]
      if (typeof value === 'string' && value !== '') out.labels[key] = value
    }
  }

  return out
}
