import { test, expect, _electron as electron } from '@playwright/test'
import { MAIN } from './helpers/driver'

test('startup logs a keyring warning when encryption is unavailable', async () => {
  const logs: string[] = []
  const app = await electron.launch({ args: [MAIN] })
  app.process().stdout?.on('data', (d) => logs.push(String(d)))
  app.process().stderr?.on('data', (d) => logs.push(String(d)))
  await app.firstWindow()
  // On Windows/macOS dev runners encryption IS available → no warning (pass).
  // On Linux CI without a keyring → warning present. Assert the code path is
  // wired: either available (no warn) or unavailable (warn present).
  await new Promise((r) => setTimeout(r, 1500))
  const warned = logs.join('').includes('OS keyring unavailable')
  const { available } = await app.evaluate(async ({ safeStorage }) => ({
    available: safeStorage.isEncryptionAvailable(),
  }))
  expect(warned).toBe(!available)
  await app.close()
})
