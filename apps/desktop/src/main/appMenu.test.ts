import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

import { buildApplicationMenuTemplate, FORBIDDEN_MENU_ROLES } from './appMenu'

/// Flatten a template to every item it contains, at any depth. Roles the
/// browser process expands (appMenu / editMenu / windowMenu) stay opaque here —
/// that is the point: the assertions below can only speak about what THIS
/// template declares, and the e2e gate (e2e/electron/menu.spec.ts) walks the
/// expanded, live menu.
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

describe('macOS application menu template', () => {
  it('never declares a reload or DevTools role', () => {
    const roles = rolesIn(buildApplicationMenuTemplate()).map((r) => r.toLowerCase())
    for (const forbidden of FORBIDDEN_MENU_ROLES) {
      expect(roles).not.toContain(forbidden.toLowerCase())
    }
  })

  it('builds View by hand rather than through role: viewMenu', () => {
    // `role: 'viewMenu'` is what re-adds Reload and DevTools — the very bug
    // this menu exists to fix. The hand-built View carries fullscreen only.
    expect(rolesIn(buildApplicationMenuTemplate())).not.toContain('viewMenu')

    const view = buildApplicationMenuTemplate().find(
      (item) => Array.isArray(item.submenu) && item.submenu.some((i) => i.role === 'togglefullscreen'),
    )
    expect(view?.submenu).toHaveLength(1)
  })

  it('keeps the OS-supplied App, Edit and Window menus as verbatim roles', () => {
    // Roles, not hand-built copies, so AppKit supplies the behaviour and the
    // localisation — and so the Edit menu's clipboard accelerators stay intact
    // (stripping one kills the role, see docs/notes/electron-chromium-behavior.md).
    const top = buildApplicationMenuTemplate().map((i) => i.role)
    expect(top).toContain('appMenu')
    expect(top).toContain('editMenu')
    expect(top).toContain('windowMenu')
  })

  it('orders the bar the way macOS expects', () => {
    const top = buildApplicationMenuTemplate().map((i) => i.role ?? i.label)
    expect(top).toEqual(['appMenu', 'editMenu', 'View', 'windowMenu'])
  })
})
