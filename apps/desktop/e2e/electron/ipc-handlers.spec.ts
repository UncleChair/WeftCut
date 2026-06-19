import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('path:join and path:tempDir round-trip through the bridge', async () => {
  const app = await electron.launch({ args: [path.resolve(__dirname, '../../out/main/index.js')] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const joined = await page.evaluate(() =>
    (window as any).api.path.join(['a', 'b', 'c.txt']),
  )
  expect(typeof joined).toBe('string')
  expect(joined.replace(/\\/g, '/')).toBe('a/b/c.txt')

  const tmp = await page.evaluate(() => (window as any).api.path.tempDir())
  expect(typeof tmp).toBe('string')
  expect(tmp.length).toBeGreaterThan(0)

  await app.close()
})
