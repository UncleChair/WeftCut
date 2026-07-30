import { test, expect, type ElectronApplication } from '@playwright/test'

import { launchApp, newProject, tmpDir } from './helpers/driver'

// The macOS application menu (src/main/appMenu.ts, ADR 0031). Three
// things here that no unit test can prove, because they need the real browser
// process to expand the role items and the real renderer to project into them:
//
//  1. Reload / DevTools must not reach a shipped menu. The unit test asserts
//     the TEMPLATE declares no such role; only a launch can prove what the
//     EXPANDED menu contains — swapping the hand-built View for
//     `role: 'viewMenu'` re-adds both, and Electron's default menu (the thing
//     this feature replaces) ships them in production.
//  2. The renderer → main projection actually arrives, so the menu carries this
//     app's own commands rather than an empty File and a Settings-less App menu.
//  3. A chosen item runs the SAME renderer action the in-app menu bar runs.
//
// Labels are never asserted: they come from i18next, whose first-launch locale
// follows the HOST's language. Accelerators are locale-independent, and they
// are also the thing that would silently rot if the projection ever stopped
// reading the action catalogue.
//
// NOT covered here, deliberately: that the renderer keeps ownership of the
// chords the menu also binds (Cmd+Z, Cmd+W, Cmd+C). Asserting that needs a key
// event delivered through AppKit — `webContents.sendInputEvent` injects PAST
// AppKit, so menu key equivalents never run and such a test would pass
// vacuously, proving nothing. It stays a manual check, written down under
// "Manual check" in docs/notes/electron-chromium-behavior.md.

const isDarwin = process.platform === 'darwin'

/// One live menu item, flattened out of the expanded application menu.
interface MenuSnapshotItem {
  role: string | null
  label: string
  accelerator: string | null
  type: string
  /// Label of the top-level menu this item belongs to, so a test can talk about
  /// "the File menu" without re-walking.
  menu: string
}

/// Walk `Menu.getApplicationMenu()` in the main process. Returns null when no
/// menu is installed at all — the Windows/Linux shape, and on macOS the
/// regression that would take the whole feature away.
function menuSnapshot(app: ElectronApplication): Promise<MenuSnapshotItem[] | null> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    if (!menu) return null
    const walk = (items: Electron.MenuItem[], top: string): MenuSnapshotItem[] =>
      items.flatMap((i) => [
        {
          role: i.role ?? null,
          label: i.label,
          accelerator: i.accelerator ?? null,
          type: i.type,
          menu: top,
        },
        ...(i.submenu ? walk(i.submenu.items, top) : []),
      ])
    return menu.items.flatMap((top) => walk(top.submenu ? top.submenu.items : [top], top.label))
  })
}

/// Top-level menu labels, in bar order. `[0]` is always the App menu on macOS.
function menuBar(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? [],
  )
}

test.describe('macOS application menu', () => {
  // macOS is the only platform with one: Windows/Linux run
  // `setApplicationMenu(null)` and the renderer draws the bar (ADR 0031).
  test.skip(!isDarwin, 'macOS-only application menu')

  test('a production launch exposes no reload or DevTools item', async () => {
    const { app } = await launchApp()

    const items = await menuSnapshot(app)
    // Null would mean macOS lost its menu entirely — Cmd+C/V in text inputs and
    // every platform convention with it.
    expect(items).not.toBeNull()

    // Electron lowercases `role` on the live MenuItem; the template spells it
    // camelCase (FORBIDDEN_MENU_ROLES in src/main/appMenu.ts).
    const roles = items!.map((i) => i.role?.toLowerCase()).filter(Boolean)
    expect(roles).not.toContain('reload')
    expect(roles).not.toContain('forcereload')
    expect(roles).not.toContain('toggledevtools')

    // Belt and braces: the default menu's accelerators, whatever an item might
    // call itself. Cmd+R in a shipped build discards unsaved timeline state.
    const accelerators = items!.map((i) => i.accelerator)
    expect(accelerators).not.toContain('CmdOrCtrl+R')
    expect(accelerators).not.toContain('Shift+CmdOrCtrl+R')
    expect(accelerators).not.toContain('Alt+Command+I')

    await app.close()
  })

  test('the App menu carries Settings at Cmd+, from the very first screen', async () => {
    const { app, page } = await launchApp()
    await page.waitForSelector('.startup-titlebar')

    const appMenuLabel = (await menuBar(app))[0]!

    // Settings has no slot in `role: 'appMenu'`, so its presence proves the
    // renderer's projection arrived and main rebuilt the menu around it.
    await expect
      .poll(async () => {
        const items = (await menuSnapshot(app)) ?? []
        return items.filter((i) => i.accelerator === 'CommandOrControl+,').map((i) => i.menu)
      })
      .toEqual([appMenuLabel])

    // The startup screen has no project to save or export, and an action this
    // surface cannot run is OMITTED rather than shown dead — so there is no
    // File menu at all yet: App, Edit, View, Window.
    expect(await menuBar(app)).toHaveLength(4)

    await app.close()
  })

  test('File projects the editor actions, and choosing one runs it', async () => {
    const { app, page } = await launchApp()
    await page.waitForSelector('.startup-titlebar')
    await newProject(page, {
      parentFolder: tmpDir('weftcut-menu-'),
      name: 'MenuProjection',
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    })
    await page.waitForSelector('.app-header')

    // File appears only once the editor projects it, right after the App menu:
    // App, File, Edit, View, Window.
    await expect.poll(async () => (await menuBar(app)).length).toBe(5)
    const fileLabel = (await menuBar(app))[1]!

    // Accelerators come from the action catalogue (shortcuts/defs.ts) through
    // the renderer's projection — never retyped in main — so this pins both the
    // File order and the chord → Electron accelerator conversion.
    await expect
      .poll(async () => {
        const items = (await menuSnapshot(app)) ?? []
        return items
          .filter((i) => i.menu === fileLabel && i.type !== 'separator')
          .map((i) => i.accelerator)
      })
      .toEqual([
        'CommandOrControl+I', // Import media…
        'CommandOrControl+S', // Save
        'CommandOrControl+Shift+S', // Save as…
        'CommandOrControl+W', // Save and Close — the app's action, not Close Window
        'CommandOrControl+E', // Export…
      ])

    // Choose "Save and Close" the way a mouse would. It must run the renderer's
    // closeProject — the same handler Cmd+W and the in-app File menu run —
    // which lands back on the startup screen.
    await app.evaluate(({ Menu }, label) => {
      const file = Menu.getApplicationMenu()!.items.find((i) => i.label === label)!
      file.submenu!.items.find((i) => i.accelerator === 'CommandOrControl+W')!.click()
    }, fileLabel)
    await page.waitForSelector('.startup-titlebar')

    await app.close()
  })
})
