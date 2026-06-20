import { test, expect, _electron as electron } from '@playwright/test'
import { MAIN } from './helpers/driver'

// When the OS keyring is unavailable (headless Linux CI,
// minimal containers), safeStorage falls back to plaintext and main emits a
// console.warn diagnostic — but it must DEGRADE, never hard-fail the boot.
// We assert the robust, meaningful behavior: the app reaches a window regardless
// of keyring availability, AND the plaintext-keys warning reaches the UI via a
// pulled app notice (api.app.notices).
test('app boots + degrades gracefully regardless of safeStorage keyring availability', async () => {
  const app = await electron.launch({
    args: [MAIN],
    // Suppress the elevated-run modal so it can't interfere when this (often
    // elevated) test drives the renderer below.
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  // firstWindow resolves only after main's whenReady → backend.init → the
  // safeStorage keyring check → createWindow. So a resolved window proves the
  // no-keyring path did NOT hard-fail boot.
  const page = await app.firstWindow({ timeout: 60_000 })
  expect(page).toBeTruthy()

  const available = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())
  // On headless Linux CI `available` is false and the app still booted (degrade);
  // on Windows/macOS it's true. Either way the app must reach a window.
  expect(typeof available).toBe('boolean')

  // The keyring-unavailable warning is surfaced through the pulled-notice channel.
  // The notice must be present exactly when the keyring is NOT available.
  await page.waitForFunction(() => typeof (window as any).api?.app?.notices === 'function')
  const notices = (await page.evaluate(() => (window as any).api.app.notices())) as Array<{ code: string }>
  expect(Array.isArray(notices)).toBe(true)
  expect(notices.some((n) => n.code === 'keyring_unavailable')).toBe(!available)

  await app.close()
})
