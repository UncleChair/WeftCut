import { test, expect, _electron as electron, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Bring-up smoke: the TS state actor + production bridge are up immediately after
// boot, so an early renderer `project_summary` (served by the TS actor) reflects
// the project. This boots the DEFAULT path and confirms the actor is ready before
// the renderer asks for state.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')

interface Summary {
  tracks: Array<{ id: string; layers: Array<{ id: string; params: { kind: string } }> }>
}
const invoke = <T = unknown>(page: Page, cmd: string, args: Record<string, unknown> = {}) =>
  page.evaluate(([c, a]) => (window as any).api.backend.invoke(c, a), [cmd, args] as const) as Promise<T>

test('bring-up: project summary is available immediately after boot (no flag)', async () => {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    // The production bridge is available on the startup screen.
    await page.waitForFunction(() => !!(window as any).api?.backend?.invoke, undefined, { timeout: 30_000 })

    // The renderer summary is served by the TS actor; a blank project still has
    // the two reserved tracks. If the actor were not ready at boot, this summary
    // pull would fail.
    const summary = await invoke<Summary>(page, 'project_summary')
    expect(summary.tracks.length).toBeGreaterThanOrEqual(2)
  } finally {
    await app.close()
  }
}, 120_000)
