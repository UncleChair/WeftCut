import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp, newProject, invokeCmd, waitForHook } from './helpers/driver'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

test('palette jumps the playhead to a caption found by content', async () => {
  const { app, page } = await launchApp()
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-palette-'))
    await newProject(page, { parentFolder: parent, name: 'palette', canvas: CANVAS })
    await invokeCmd(page, 'add_text_layer', {
      tStartUs: 2_000_000,
      durationUs: 1_000_000,
      content: 'FindMe subtitle line',
    })

    await page.keyboard.press(`${MOD}+K`)
    const input = page.locator('.search-palette-input input')
    await expect(input).toBeVisible()
    await input.fill('FindMe')
    // Index rebuild is debounced ~300 ms after the mutation; the row
    // appearing IS the rebuild signal.
    await expect(
      page.locator('.search-row', { hasText: 'FindMe subtitle line' }),
    ).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Enter')

    await waitForHook(page, 'getPlayheadUs')
    await expect
      .poll(() => page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs()))
      .toBe(2_000_000)
    await expect(page.locator('.search-palette')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('palette executes a command (toggle media pool drawer)', async () => {
  const { app, page } = await launchApp()
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-palette-'))
    await newProject(page, { parentFolder: parent, name: 'palette-cmd', canvas: CANVAS })

    const drawerOpen = () =>
      page.evaluate(() => document.querySelector('.app-main')!.classList.contains('drawer-open'))

    await page.keyboard.press(`${MOD}+K`)
    await page.locator('.search-palette-input input').fill('media pool')
    await expect(page.locator('.search-row.is-active')).toBeVisible()
    // Read the pre-toggle state only now, not right after newProject: this
    // is a GLOBAL app-level setting (app_settings.json, not per-project —
    // see appSettingsStore.ts), and its initial IPC hydrate is async. Reading
    // it immediately after newProject races that fetch and can observe the
    // in-memory FALLBACK default instead of the real persisted value,
    // flipping the polarity of the post-toggle assertion below. By the time
    // the palette is open and the active row is visible, the hydrate has
    // long since landed.
    const before = await drawerOpen()
    await page.keyboard.press('Enter')

    await expect.poll(drawerOpen).toBe(!before)
  } finally {
    await app.close()
  }
})
