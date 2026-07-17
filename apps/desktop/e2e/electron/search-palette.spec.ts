import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, invokeCmd, waitForHook } from './helpers/driver'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_PATH = path.resolve(__dirname, '../../fixtures/media/tiny.mp4')

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

test('media search reopens and reveals the singleton Media Pool Panel', async () => {
  test.skip(!fs.existsSync(MEDIA_PATH), `media fixture missing: ${MEDIA_PATH}`)
  test.setTimeout(60_000)

  const { app, page } = await launchApp()
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-palette-'))
    await newProject(page, { parentFolder: parent, name: 'palette-media', canvas: CANVAS })

    const mediaId = await invokeCmd<string>(page, 'import_media', { path: MEDIA_PATH })
    const mediaItem = page.locator(`[data-media-id="${mediaId}"]`)
    await expect(mediaItem).toBeVisible({ timeout: 20_000 })

    // View > Media Pool focuses the existing singleton. Closing the active
    // Panel destroys that surface, and the retired M binding must not reopen it.
    const viewMenu = page.locator('.menu-trigger').nth(2)
    await viewMenu.click()
    await page.locator('.menu-item').filter({ hasText: 'Media Pool' }).click()
    await viewMenu.click()
    await page
      .locator('.menu-item')
      .filter({ hasText: /Close Active Panel|关闭活动面板/ })
      .click()
    await expect(page.locator('[data-panel-kind="media"]')).toHaveCount(0)
    await page.keyboard.press('M')
    await expect(page.locator('[data-panel-kind="media"]')).toHaveCount(0)

    // The unused media result reveals directly (no usage sub-list). Navigation
    // reopens/focuses the dock Panel before delivering the deferred flash.
    await page.keyboard.press(`${MOD}+K`)
    await page.locator('.search-palette-input input').fill(path.basename(MEDIA_PATH))
    await expect(page.locator('.search-row.is-active')).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Enter')

    await expect(page.locator('[data-panel-kind="media"]')).toHaveCount(1)
    await expect(page.locator(`[data-media-id="${mediaId}"].is-search-flash`)).toBeVisible()
  } finally {
    await app.close()
  }
})
