import { test, expect, _electron as electron, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// Phase 3c-ii-d — THE FLIP. With WEFTCUT_TS_ACTOR=1 the TS state actor in main
// is authoritative: the renderer's category-A commands (add_color_layer,
// undo/redo, project_new_workspace/save/open, project_summary) are served by the
// TS actor + TS persistence orchestrator, NOT the Rust actor. This drives that
// path end-to-end through the production bridge (window.api.backend.invoke) and
// asserts an edit → summary → undo/redo → save → reopen round-trip.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')

interface Summary {
  tracks: Array<{ id: string; layers: Array<{ id: string; params: { kind: string } }> }>
}
const invoke = <T = unknown>(page: Page, cmd: string, args: Record<string, unknown> = {}) =>
  page.evaluate(([c, a]) => (window as any).api.backend.invoke(c, a), [cmd, args] as const) as Promise<T>
const layerCount = (s: Summary) => s.tracks.reduce((n, t) => n + t.layers.length, 0)

test('WEFTCUT_TS_ACTOR flip: edit → summary → undo/redo → save → reopen round-trip', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-flip-'))
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, WEFTCUT_TS_ACTOR: '1', WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
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

    // Diverge in-memory (2 layers), then reopen from disk — must revert to the
    // saved 1-layer state, proving open loads through the TS orchestrator.
    await invoke(page, 'add_color_layer', { tStartUs: 6_000_000 })
    expect(layerCount(await invoke<Summary>(page, 'project_summary'))).toBe(2)
    await invoke(page, 'project_open', { path: projectDir })
    expect(layerCount(await invoke<Summary>(page, 'project_summary'))).toBe(1)
  } finally {
    await app.close()
    fs.rmSync(ws, { recursive: true, force: true })
  }
})
