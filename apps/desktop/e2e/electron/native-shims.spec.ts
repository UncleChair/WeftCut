import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'

// The shell / notification / cross-window-emit capabilities are handled natively
// in the Electron main process (no Rust round-trip).

test('emit() broadcasts an event across windows to a listen() subscriber', async () => {
  const { app, page: main } = await launchApp()

  // Open a real second window and arm a subscriber there.
  await main.evaluate(() => (window as any).api.win.create('emit-probe', { url: '/?perfHud=1' }))
  await expect.poll(() => app.windows().length).toBe(2)
  const second = app.windows()[1]
  await second.waitForLoadState('domcontentloaded')
  await second.evaluate(() => {
    ;(window as any).__got = null
    ;(window as any).api.on('test:cross-window', (p: unknown) => {
      ;(window as any).__got = p
    })
  })

  // Emit from the MAIN window; main must fan it out to the second window too.
  await main.evaluate(() => (window as any).api.emit('test:cross-window', { n: 42 }))

  const got = await second.waitForFunction(() => (window as any).__got)
  expect(await got.jsonValue()).toEqual({ n: 42 })

  await app.close()
})

test('shell:open is wired (no missing-handler error)', async () => {
  // Headless Linux runners wedge on the xdg-open side effect: the invoke
  // resolves (wiring proven — CI run 31194886282), but the spawned opener
  // blocks on the session bus and app.close() then hangs the same way.
  test.skip(process.platform === 'linux' && !!process.env.CI, 'xdg-open wedges app quit on headless Linux runners')
  const { app, page } = await launchApp()

  // shell:open of a non-existent path is handled (openPath returns an error
  // string → handler rejects). The rejection must NOT be the missing-handler
  // error — that's what proves it's wired natively rather than detouring to Rust.
  const shellErr = await page.evaluate(async () => {
    try {
      await (window as any).api.shell.open('Z:/weftcut/definitely/not/real')
      return 'resolved'
    } catch (e) {
      return String(e)
    }
  })
  expect(shellErr).not.toContain('No handler registered')

  await app.close()
})

test('notification:send is wired (no missing-handler error)', async () => {
  // Notification.show() is a main-thread libnotify/DBus call; a headless
  // runner has no notification service and the call wedges the main process.
  test.skip(process.platform === 'linux' && !!process.env.CI, 'no notification service on headless Linux runners')
  const { app, page } = await launchApp()

  // notification:send always resolves (no-ops where unsupported) — proves the
  // channel exists. An unregistered channel would reject "No handler registered".
  const notifyResult = await page.evaluate(async () => {
    try {
      await (window as any).api.notification.send({ title: 'WeftCut', body: 'hi' })
      return 'ok'
    } catch (e) {
      return String(e)
    }
  })
  expect(notifyResult).toBe('ok')

  await app.close()
})

test('metrics.get() returns a live process-tree snapshot from app.getAppMetrics()', async () => {
  const { app, page } = await launchApp()

  const stats = (await page.evaluate(() => (window as any).api.metrics.get())) as {
    cpu_percent: number; rss_bytes: number; process_count: number; logical_cores: number
  }
  // A running Electron app always has >=1 process and a real RSS — no 1s warmup,
  // no null. cpu_percent is whole-machine %.
  expect(stats.process_count).toBeGreaterThanOrEqual(1)
  expect(stats.rss_bytes).toBeGreaterThan(0)
  expect(stats.logical_cores).toBeGreaterThan(0)
  expect(stats.cpu_percent).toBeGreaterThanOrEqual(0)
  expect(stats.cpu_percent).toBeLessThanOrEqual(100 * stats.logical_cores)

  await app.close()
})
