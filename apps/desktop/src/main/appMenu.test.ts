import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

import { MENU_ACTION_IDS, type MenuActionId, type MenuProjection } from '../shared/menu'
import {
  buildApplicationMenuTemplate,
  FORBIDDEN_MENU_ROLES,
  sanitizeMenuProjection,
  toElectronAccelerator,
} from './appMenu'

/// Flatten a template to every item it contains, at any depth. Role items the
/// browser process expands (editMenu / windowMenu) stay opaque here — that is
/// the point: these assertions can only speak about what THIS template
/// declares, and the e2e gate (e2e/electron/menu.spec.ts) walks the expanded,
/// live menu instead.
function flatten(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ])
}

function rolesIn(template: MenuItemConstructorOptions[]): string[] {
  return flatten(template)
    .map((i) => i.role)
    .filter((r): r is NonNullable<MenuItemConstructorOptions['role']> => !!r)
}

function submenuOf(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const found = template.find((i) => i.label === label)?.submenu
  return Array.isArray(found) ? found : []
}

/// Labels of a submenu's non-separator items, in order.
function labelsOf(submenu: MenuItemConstructorOptions[]): (string | undefined)[] {
  return submenu.filter((i) => i.type !== 'separator').map((i) => i.label)
}

const noop = () => {}

/// Choose a menu item. The real callback carries (menuItem, window, event); the
/// builder's handlers ignore all three, so the cast keeps the call readable.
function choose(item: MenuItemConstructorOptions): void {
  ;(item.click as unknown as (() => void) | undefined)?.()
}

/// A projection with every action live, as the editor surface sends it.
function fullProjection(): MenuProjection {
  return {
    actions: {
      importMedia: { label: 'Import media…', keys: ['Mod+I'] },
      save: { label: 'Save', keys: ['Mod+S'] },
      saveAs: { label: 'Save as…', keys: ['Mod+Shift+S'] },
      closeProject: { label: 'Save and Close', keys: ['Mod+W'] },
      export: { label: 'Export…', keys: ['Mod+E'] },
      openSettings: { label: 'Settings…', keys: ['Mod+Comma'] },
    },
    labels: { 'menu.file': 'File', 'menu.view': 'View' },
  }
}

describe('macOS application menu template', () => {
  it('never declares a reload or DevTools role', () => {
    for (const projection of [null, fullProjection()]) {
      const roles = rolesIn(buildApplicationMenuTemplate({ projection, dispatch: noop, appName: 'WeftCut' }))
        .map((r) => r.toLowerCase())
      for (const forbidden of FORBIDDEN_MENU_ROLES) {
        expect(roles).not.toContain(forbidden.toLowerCase())
      }
    }
  })

  it('builds View by hand rather than through role: viewMenu', () => {
    // `role: 'viewMenu'` is what re-adds Reload and DevTools — the very bug
    // this menu exists to fix. The hand-built View carries fullscreen only.
    const template = buildApplicationMenuTemplate({ projection: fullProjection(), dispatch: noop, appName: 'WeftCut' })
    expect(rolesIn(template)).not.toContain('viewMenu')
    expect(submenuOf(template, 'View').map((i) => i.role)).toEqual(['togglefullscreen'])
  })

  it('keeps the OS-supplied Edit and Window menus as verbatim roles', () => {
    // Roles, not hand-built copies, so AppKit supplies the behaviour — and so
    // the Edit menu's clipboard accelerators stay intact. Stripping one kills
    // the role outright (docs/notes/electron-chromium-behavior.md).
    const top = buildApplicationMenuTemplate({ projection: fullProjection(), dispatch: noop, appName: 'WeftCut' })
      .map((i) => i.role)
    expect(top).toContain('editMenu')
    expect(top).toContain('windowMenu')
  })

  it('orders the bar the way macOS expects', () => {
    const template = buildApplicationMenuTemplate({ projection: fullProjection(), dispatch: noop, appName: 'WeftCut' })
    expect(template.map((i) => i.role ?? i.label)).toEqual([
      'WeftCut',
      'File',
      'editMenu',
      'View',
      'windowMenu',
    ])
  })

  it('hand-builds the App menu so Settings gets its conventional slot', () => {
    // `role: 'appMenu'` has no Settings slot, so this one menu is assembled
    // from individual roles plus our item — every OTHER entry stays a role.
    const template = buildApplicationMenuTemplate({ projection: fullProjection(), dispatch: noop, appName: 'WeftCut' })
    const app = submenuOf(template, 'WeftCut')
    expect(app.map((i) => i.role).filter(Boolean)).toEqual([
      'about',
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'quit',
    ])
    const settings = app.find((i) => i.label === 'Settings…')
    expect(settings?.accelerator).toBe('CommandOrControl+,')
    // Directly under About, above Services — where macOS apps put it.
    expect(app.indexOf(settings!)).toBeGreaterThan(app.findIndex((i) => i.role === 'about'))
    expect(app.indexOf(settings!)).toBeLessThan(app.findIndex((i) => i.role === 'services'))
  })

  it('projects File in the same order as the in-app File menu', () => {
    const template = buildApplicationMenuTemplate({ projection: fullProjection(), dispatch: noop, appName: 'WeftCut' })
    expect(labelsOf(submenuOf(template, 'File'))).toEqual([
      'Import media…',
      'Save',
      'Save as…',
      'Save and Close',
      'Export…',
    ])
  })

  it('places every projectable action somewhere in the menu', () => {
    // Drift guard: an id added to MENU_ACTION_IDS but never placed would be
    // resolved by the renderer every sync and shown to nobody.
    const dispatched: MenuActionId[] = []
    const template = buildApplicationMenuTemplate({
      projection: fullProjection(),
      dispatch: (id) => dispatched.push(id),
      appName: 'WeftCut',
    })
    for (const item of flatten(template)) choose(item)
    expect([...dispatched].sort()).toEqual([...MENU_ACTION_IDS].sort())
  })

  it('runs the projected action when an item is chosen', () => {
    const dispatch = vi.fn()
    const template = buildApplicationMenuTemplate({ projection: fullProjection(), dispatch, appName: 'WeftCut' })
    const save = submenuOf(template, 'File').find((i) => i.label === 'Save')
    choose(save!)
    expect(dispatch).toHaveBeenCalledWith('save')
  })

  it('shows the effective binding, so a rebind is never stale', () => {
    const projection = fullProjection()
    projection.actions.save = { label: 'Save', keys: ['Ctrl+Alt+S'] }
    // Unbound in Settings → Keyboard: no accelerator at all beats a wrong one.
    projection.actions.export = { label: 'Export…', keys: [] }
    const file = submenuOf(
      buildApplicationMenuTemplate({ projection, dispatch: noop, appName: 'WeftCut' }),
      'File',
    )
    expect(file.find((i) => i.label === 'Save')?.accelerator).toBe('Control+Alt+S')
    expect(file.find((i) => i.label === 'Export…')?.accelerator).toBeUndefined()
  })

  it('omits what the current surface cannot run, rather than disabling it', () => {
    // The startup screen has no project to save; it projects Settings only.
    const template = buildApplicationMenuTemplate({
      projection: { actions: { openSettings: { label: '设置…', keys: ['Mod+Comma'] } }, labels: {} },
      dispatch: noop,
      appName: 'WeftCut',
    })
    // No File menu at all — no dead entries, and no live-state IPC to keep it
    // in step (ADR 0031: that sync cost is what full parity would buy).
    expect(template.map((i) => i.label)).not.toContain('File')
    expect(labelsOf(submenuOf(template, 'WeftCut'))).toContain('设置…')
  })

  it("falls back to English titles before the renderer's first sync", () => {
    // The window between app.whenReady and the first projection: roles only,
    // so the bar is complete and safe from the very first frame.
    const template = buildApplicationMenuTemplate({ projection: null, dispatch: noop, appName: 'WeftCut' })
    expect(template.map((i) => i.role ?? i.label)).toEqual([
      'WeftCut',
      'editMenu',
      'View',
      'windowMenu',
    ])
  })
})

describe('chord → Electron accelerator', () => {
  it('resolves Mod to the cross-platform token', () => {
    expect(toElectronAccelerator('Mod+S')).toBe('CommandOrControl+S')
    expect(toElectronAccelerator('Mod+Shift+S')).toBe('CommandOrControl+Shift+S')
  })

  it('spells out the named physical punctuation keys', () => {
    expect(toElectronAccelerator('Mod+Comma')).toBe('CommandOrControl+,')
    expect(toElectronAccelerator('Ctrl+Shift+Period')).toBe('Control+Shift+.')
    expect(toElectronAccelerator('Mod+Backquote')).toBe('CommandOrControl+`')
  })

  it('maps the catalogue key names Electron spells differently', () => {
    expect(toElectronAccelerator('Alt+Shift+ArrowLeft')).toBe('Alt+Shift+Left')
    expect(toElectronAccelerator('ArrowDown')).toBe('Down')
    expect(toElectronAccelerator('Escape')).toBe('Esc')
    expect(toElectronAccelerator('Space')).toBe('Space')
    expect(toElectronAccelerator('F5')).toBe('F5')
    expect(toElectronAccelerator('Mod+K')).toBe('CommandOrControl+K')
  })

  it('accepts every modifier spelling the binding parser does', () => {
    expect(toElectronAccelerator('Command+Option+Backspace')).toBe('Command+Alt+Backspace')
    expect(toElectronAccelerator('control+meta+X')).toBe('Control+Command+X')
  })

  it('returns null rather than guessing at anything unrecognised', () => {
    // A wrong accelerator is worse than none: it would claim a chord in the
    // menu bar that the renderer never dispatches.
    expect(toElectronAccelerator('')).toBeNull()
    expect(toElectronAccelerator('Mod+Frobnicate')).toBeNull()
    expect(toElectronAccelerator('Hyper+S')).toBeNull()
    expect(toElectronAccelerator('Mod+')).toBeNull()
  })
})

describe('projection sanitising', () => {
  it('keeps a well-formed projection', () => {
    expect(sanitizeMenuProjection(fullProjection())).toEqual(fullProjection())
  })

  it('drops ids, labels and keys it does not recognise', () => {
    const dirty = {
      actions: {
        save: { label: 'Save', keys: ['Mod+S', 42] },
        quitTheApp: { label: 'Quit', keys: [] },
        saveAs: { label: 7, keys: [] },
        export: { label: 'Export…', keys: 'Mod+E' },
      },
      labels: { 'menu.file': 'File', 'menu.nope': 'Nope', 'menu.view': null },
    }
    expect(sanitizeMenuProjection(dirty)).toEqual({
      actions: { save: { label: 'Save', keys: ['Mod+S'] }, export: { label: 'Export…', keys: [] } },
      labels: { 'menu.file': 'File' },
    })
  })

  it('degrades junk to an empty projection instead of throwing', () => {
    // The payload crosses an IPC boundary from the renderer; a malformed one
    // must not take out the menu (or the main process) with it.
    for (const junk of [null, undefined, 'nope', 42, [], { actions: 'no', labels: 3 }]) {
      expect(sanitizeMenuProjection(junk)).toEqual({ actions: {}, labels: {} })
    }
  })
})
