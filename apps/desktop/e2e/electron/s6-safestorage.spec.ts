import { test, expect, _electron as electron } from '@playwright/test'
import { MAIN } from './helpers/driver'

test('startup logs a keyring warning when encryption is unavailable', async () => {
  const logs: string[] = []
  const app = await electron.launch({ args: [MAIN] })
  app.process().stdout?.on('data', (d) => logs.push(String(d)))
  app.process().stderr?.on('data', (d) => logs.push(String(d)))
  // firstWindow resolves only after main's whenReady → backend.init → the
  // safeStorage keyring check (+ warning) → createWindow. So once the window
  // exists, the warning (if any) has already been emitted into the captured logs.
  await app.firstWindow({ timeout: 60_000 })
  await new Promise((r) => setTimeout(r, 500)) // flush the streams
  const warned = logs.join('').includes('OS keyring unavailable')
  const { available } = await app.evaluate(async ({ safeStorage }) => ({ available: safeStorage.isEncryptionAvailable() }))
  expect(warned).toBe(!available)
  await app.close()
})
