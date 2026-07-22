import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { launchApp, tmpDir } from './helpers/driver'

// The TS state actor in main is authoritative: the renderer's category-A
// commands (add_color_layer, undo/redo, project_new_workspace/save/open,
// project_summary) are served by the TS actor + TS persistence orchestrator.
// This drives that path end-to-end through the production bridge
// (window.api.backend.invoke) and asserts an edit → summary → undo/redo →
// save → cross-workspace persistence round-trip.

interface Summary {
  tracks: Array<{ id: string; layers: Array<{ id: string; params: { kind: string } }> }>
}
const invoke = <T = unknown>(page: Page, cmd: string, args: Record<string, unknown> = {}) =>
  page.evaluate(([c, a]) => (window as any).api.backend.invoke(c, a), [cmd, args] as const) as Promise<T>
const layerCount = (s: Summary) => s.tracks.reduce((n, t) => n + t.layers.length, 0)

test('TS actor: edit → summary → undo/redo → save → workspace-switch round-trip', async () => {
  const ws = tmpDir('wc-flip-')
  const { app, page } = await launchApp()
  try {
    // The production bridge is available on the startup screen — no editor/test hooks needed.
    await page.waitForFunction(() => !!(window as any).api?.backend?.invoke, undefined, { timeout: 30_000 })

    // New workspace — served by the TS persistence orchestrator under the flag.
    const projectDir = await invoke<string>(page, 'project_new_workspace', {
      parentFolder: ws, name: 'flip', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1,
    })
    expect(typeof projectDir).toBe('string')
    expect(layerCount(await invoke<Summary>(page, 'project_summary'))).toBe(0)

    // Add a color layer (no trackId → TS adapter resolves/creates an Overlay track).
    await invoke(page, 'add_color_layer', { tStartUs: 0 })
    const afterAdd = await invoke<Summary>(page, 'project_summary')
    expect(layerCount(afterAdd)).toBe(1)
    expect(afterAdd.tracks.some((t) => t.layers.some((l) => l.params.kind === 'Color'))).toBe(true)

    // Undo / redo through the TS actor's history.
    await invoke(page, 'project_undo')
    expect(layerCount(await invoke<Summary>(page, 'project_summary'))).toBe(0)
    await invoke(page, 'project_redo')
    expect(layerCount(await invoke<Summary>(page, 'project_summary'))).toBe(1)

    // Save — TS autosave forceFlush writes project.json + a Backups snapshot.
    await invoke(page, 'project_save')
    expect(fs.existsSync(path.join(projectDir, 'project.json'))).toBe(true)
    const backups = path.join(projectDir, 'Backups')
    expect(fs.existsSync(backups) && fs.readdirSync(backups).some((f) => f.endsWith('.json'))).toBe(true)

    // Create and edit a second project without an explicit save. Opening the
    // first project must flush B before replacing actor state, then load A.
    const secondProjectDir = await invoke<string>(page, 'project_new_workspace', {
      parentFolder: ws, name: 'second', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1,
    })
    await invoke(page, 'add_color_layer', { tStartUs: 0 })
    await invoke(page, 'add_color_layer', { tStartUs: 6_000_000 })
    expect(layerCount(await invoke<Summary>(page, 'project_summary'))).toBe(2)

    await invoke(page, 'project_open', { path: projectDir })
    expect(layerCount(await invoke<Summary>(page, 'project_summary'))).toBe(1)

    // Reopening B proves the pending edits were written to B rather than being
    // lost (or accidentally written to A) during the workspace transition.
    await invoke(page, 'project_open', { path: secondProjectDir })
    expect(layerCount(await invoke<Summary>(page, 'project_summary'))).toBe(2)
  } finally {
    await app.close()
  }
})
