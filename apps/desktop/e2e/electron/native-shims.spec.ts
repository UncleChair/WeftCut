import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')

// The shell / notification / cross-window-emit capabilities are handled natively
// in the Electron main process (no Rust round-trip). Before this they detoured
// through `backend.invoke`, which has no such command → every call errored and
// the features (open-log-folder, export notifications, PerfHUD cross-window
// snapshots) silently did nothing.

test('emit() broadcasts an event across windows to a listen() subscriber', async () => {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')

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

test('shell:open and notification:send are wired (no missing-handler error)', async () => {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

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
