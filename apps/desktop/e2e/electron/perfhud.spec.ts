import { test, expect } from '@playwright/test'

import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'

interface PerfTelemetryProbe {
  active: boolean
  rafActive: boolean
  compositorPollActive: boolean
  systemPollActive: boolean
  resetListenerActive: boolean
  compositorPolls: number
  systemPolls: number
  broadcasts: number
}

// WindowControls renders null on macOS, where the native traffic lights own
// the window chrome; close the HUD through the window bridge there instead.
const isDarwin = process.platform === 'darwin'

test('the on-demand Dev Performance Monitor is singleton and sleeps on close @serial', async () => {
  const projectParent = tmpDir('weftcut-perf-monitor-')
  const { app, page: main } = await launchApp()
  try {
    await newProject(main, {
      parentFolder: projectParent,
      name: 'PerfMonitor',
      canvas: { width: 320, height: 180, fpsNum: 30, fpsDen: 1 },
    })
    await invokeCmd(main, 'add_color_layer', {
      tStartUs: 0,
      durationUs: 1_000_000,
    })
    await main.waitForFunction(() => !!(window as any).__weftcutPerfTelemetry)

    // Release/E2E builds are not development builds: no diagnostic dropdown or
    // Preview overlay may leak into normal application chrome.
    await expect(main.getByRole('button', { name: /Dev/ })).toHaveCount(0)
    await expect(main.locator('[data-testid="perf-hud"]')).toHaveCount(0)
    expect(await main.evaluate(() => (window as any).__weftcutPerfTelemetry)).toMatchObject({
      active: false,
      rafActive: false,
      compositorPollActive: false,
      systemPollActive: false,
      resetListenerActive: false,
      compositorPolls: 0,
      systemPolls: 0,
      broadcasts: 0,
    })

    // decorations:false mirrors the Dev menu action: frameless, with a
    // renderer-owned titlebar. A second create request must reuse the label.
    await main.evaluate(() =>
      (window as any).api.win.create('perf-hud', { url: '/?perfHud=1', decorations: false }),
    )
    await main.evaluate(() =>
      (window as any).api.win.create('perf-hud', { url: '/?perfHud=1', decorations: false }),
    )
    await main.evaluate(() => (window as any).api.win.act('perf-hud', 'focus'))
    await expect.poll(() => app.windows().length).toBe(2)
    const exists = await main.evaluate(() => (window as any).api.win.exists('perf-hud'))
    expect(exists).toBe(true)
    const hudWin = app.windows().find((win) => win.url().includes('perfHud=1'))!
    expect(hudWin).toBeTruthy()

    const frame = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('perfHud=1'),
      )
      if (!w) return null
      const outer = w.getBounds()
      const content = w.getContentBounds()
      return { dh: outer.height - content.height }
    })
    expect(frame).not.toBeNull()
    expect(frame!.dh).toBeLessThan(8)

    await expect(hudWin.locator('[data-testid="perf-hud-titlebar"]')).toBeVisible()
    if (!isDarwin) {
      await expect(hudWin.locator('.window-control-close')).toBeVisible()
    }
    await expect(hudWin.locator('[data-testid="perf-hud-window"]')).toBeVisible()
    await expect.poll(
      () => main.evaluate(() => (window as any).__weftcutPerfTelemetry as PerfTelemetryProbe),
    ).toMatchObject({
      active: true,
      rafActive: true,
      compositorPollActive: true,
      systemPollActive: true,
      resetListenerActive: true,
    })
    await expect.poll(
      () => main.evaluate(() => (window as any).__weftcutPerfTelemetry.compositorPolls),
    ).toBeGreaterThan(0)
    await expect.poll(
      () => main.evaluate(() => (window as any).__weftcutPerfTelemetry.systemPolls),
    ).toBeGreaterThan(0)

    // The monitor's own close button closes only that window. The main bridge
    // must synchronously leave the active state and every counter must remain
    // still after more than both polling cadences.
    if (isDarwin) {
      await main.evaluate(() => (window as any).api.win.act('perf-hud', 'close'))
    } else {
      await hudWin.locator('.window-control-close').click()
    }
    await expect.poll(() => app.windows().length).toBe(1)
    await expect.poll(
      () => main.evaluate(() => (window as any).__weftcutPerfTelemetry as PerfTelemetryProbe),
    ).toMatchObject({
      active: false,
      rafActive: false,
      compositorPollActive: false,
      systemPollActive: false,
      resetListenerActive: false,
    })
    const stopped = await main.evaluate(
      () => (window as any).__weftcutPerfTelemetry as PerfTelemetryProbe,
    )
    await main.waitForTimeout(1_250)
    const idle = await main.evaluate(
      () => (window as any).__weftcutPerfTelemetry as PerfTelemetryProbe,
    )
    expect(idle.compositorPolls).toBe(stopped.compositorPolls)
    expect(idle.systemPolls).toBe(stopped.systemPolls)
    expect(idle.broadcasts).toBe(stopped.broadcasts)
    expect(app.windows()[0]!.url()).not.toContain('perfHud=1')
  } finally {
    await app.close()
  }
})
