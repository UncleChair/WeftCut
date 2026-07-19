import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

test('path:join and path:tempDir round-trip through the bridge', async () => {
  const { app, page } = await launchApp()

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
