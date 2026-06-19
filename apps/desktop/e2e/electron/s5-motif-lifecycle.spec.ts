// S5 e2e gate: motif authoring lifecycle + staleness + file-watch hot-reload.
//
// Mirrors `e2e/specs/motif/state.e2e.js` Describe 1 (staleness notice) and
// Describe 3 (file watch hot-reload), adapted for the Playwright/Electron
// driver.
//
// Three sections:
//   A. Authoring: write_motif_draft → install_motif → list_motifs shows it
//      installed → delete_motif removes it.
//
//   B. Staleness: place a v1 layer → write v2 directly to disk → reopen the
//      project → motif_staleness_report returns the row →
//      acknowledge_motif_staleness returns count > 0.
//
//   C. File watch: write a user Motif directly on disk (no app command) →
//      add a layer → confirm red accent pixels on the live compositor →
//      overwrite with green on disk → compositor turns green with no UI action.
//
// userData path: obtained from the running app via `app.evaluate()` — the
// dev build uses `%APPDATA%\Electron`, NOT `%APPDATA%\@weftcut\desktop`.

import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, waitForHook, MAIN } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/// Playwright's electronApp.close() can hang on macOS (darwin window-all-closed
/// doesn't quit the app + lingering handles). Race it with a timeout, then
/// force-kill the process so teardown is bounded.
async function closeAppRobustly(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  try {
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))])
  } catch { /* close may reject if the process is already gone */ }
  try { if (proc && proc.pid && proc.exitCode === null) proc.kill('SIGKILL') } catch { /* already dead */ }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function motifHtml(opts: { id: string; version: number; color: string; name?: string }): string {
  const manifest = {
    id: opts.id,
    name: opts.name ?? 'E2E User Motif',
    version: opts.version,
    size: [320, 320],
    default_duration_s: 4,
    props_schema: {},
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<script type="application/json" id="motif-manifest">${JSON.stringify(manifest)}</script>` +
    `<style>html,body{margin:0;background:transparent}#box{width:320px;height:320px;background:${opts.color}}</style>` +
    `</head><body><div id="box"></div>` +
    `<script>motif.define({ setup() {} });</script>` +
    `</body></html>`
  )
}

function writeUserMotifAt(
  motifsRoot: string,
  opts: { id: string; version: number; color: string },
): void {
  const dir = path.join(motifsRoot, opts.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'index.html'), motifHtml(opts))
}

function removeUserMotifAt(motifsRoot: string, id: string): void {
  rmSync(path.join(motifsRoot, id), { recursive: true, force: true })
}

function invoke(page: import('@playwright/test').Page, channel: string, args: unknown) {
  return page.evaluate(
    ([c, a]) => (window as any).api.backend.invoke(c, a),
    [channel, args] as const,
  )
}

// Poll the catalog (via IPC) until a motif with `motifId` appears (or deadline).
// Needed after disk writes: the Rust store reads from disk on each call so no
// watcher event is required; just retry until the write is visible.
async function waitForMotifInCatalog(
  page: import('@playwright/test').Page,
  motifId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const catalog = (await invoke(page, 'list_motifs', {})) as Array<{ id: string }>
    if (catalog.find((m) => m.id === motifId)) return
    await page.waitForTimeout(500)
  }
  throw new Error(`motif '${motifId}' never appeared in list_motifs within ${timeoutMs}ms`)
}

// ── Section A: authoring lifecycle ─────────────────────────────────────────────

test('S5 motif authoring: write_motif_draft → install → list → delete', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  try {
    // write_motif_draft — napi expects { args: { manifest, html } }
    const manifest = {
      id: 'e2e-lifecycle-draft', // overwritten by app; just needs a name field
      name: 'E2E Lifecycle Draft',
      version: 1,
      size: [320, 320],
      default_duration_s: 2,
      props_schema: {},
    }
    const html =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<script type="application/json" id="motif-manifest">${JSON.stringify(manifest)}</script>` +
      `<style>html,body{margin:0;background:transparent}#box{width:320px;height:320px;background:#aabbcc}</style>` +
      `</head><body><div id="box"></div>` +
      `<script>motif.define({ setup() {} });</script></body></html>`

    const draftId = await invoke(page, 'write_motif_draft', { args: { manifest, html } })
    expect(typeof draftId).toBe('string')
    expect((draftId as string).length).toBeGreaterThan(0)
    console.log('[s5-lifecycle] draft id:', draftId)

    // install_motif (New mode) — napi expects { args: { draft_id, mode: { kind: "new" } } }
    const publishedId = await invoke(page, 'install_motif', {
      args: { draft_id: draftId, mode: { kind: 'new' } },
    })
    expect(typeof publishedId).toBe('string')
    expect((publishedId as string).length).toBeGreaterThan(0)
    console.log('[s5-lifecycle] published id:', publishedId)

    // list_motifs — published Motif must appear with status "installed" (not "builtin")
    const catalog = (await invoke(page, 'list_motifs', {})) as Array<{
      id: string
      status: string
    }>
    expect(Array.isArray(catalog)).toBe(true)
    const found = catalog.find((m) => m.id === publishedId)
    expect(found).toBeDefined()
    expect(found!.status).toBe('installed')
    console.log('[s5-lifecycle] list_motifs found installed motif:', found!.id)

    // delete_motif — napi expects { id }
    await invoke(page, 'delete_motif', { id: publishedId })

    // Confirm gone from catalog.
    const catalogAfter = (await invoke(page, 'list_motifs', {})) as Array<{ id: string }>
    expect(catalogAfter.find((m) => m.id === publishedId)).toBeUndefined()
    console.log('[s5-lifecycle] deleted; catalog size:', catalogAfter.length)
  } finally {
    await closeAppRobustly(app)
  }
})

// ── Section B: staleness notice ─────────────────────────────────────────────────

test('S5 motif staleness: v1→v2 reopen surfaces a row; acknowledge clears it', async () => {
  test.setTimeout(120_000)
  const STALE_ID = 'e2e-s5-stale-' + Date.now()
  const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-s5-stale-proj')
  mkdirSync(PROJECT_PARENT, { recursive: true })

  const appHandle = await electron.launch({ args: [MAIN] })
  const page = await appHandle.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Get the actual userData path from the running app.
  const userData = await appHandle.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const motifsRoot = path.join(userData, 'motifs')
  console.log('[s5-stale] motifsRoot:', motifsRoot)

  try {
    // Write v1 of the user Motif directly to disk.
    writeUserMotifAt(motifsRoot, { id: STALE_ID, version: 1, color: '#e02424' })

    // Create a project + enter the editor.
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-s5-stale-' + Date.now(),
      canvas: { width: 320, height: 320, fpsNum: 30, fpsDen: 1 },
    })
    await waitForHook(page, 'addMotifLayer')
    await waitForHook(page, 'motifReopenProject')

    // Retrieve the actual workspace path that the hook created.
    const projectPath = await invoke(page, 'workspace_dir', {})
    console.log('[s5-stale] workspace dir:', projectPath)
    expect(typeof projectPath).toBe('string')

    // Wait for the motif to appear in the catalog (Rust reads from disk directly).
    await waitForMotifInCatalog(page, STALE_ID)

    // Place two layers at v1.
    for (let i = 0; i < 2; i++) {
      const r = await page.evaluate(
        (id) =>
          (window as any).__weftcutTest
            .addMotifLayer({ motifId: id, durationUs: 2_000_000 })
            .then((layerId: string) => ({ ok: true, layerId }))
            .catch((e: unknown) => ({ ok: false, error: String(e) })),
        STALE_ID,
      )
      if (!r.ok) throw new Error('addMotifLayer failed: ' + r.error)
    }

    // Freshly placed = no stale entry now (placed version matches current).
    const reportBefore = (await invoke(page, 'motif_staleness_report', {})) as Array<{
      motif_id: string
    }>
    expect(reportBefore.find((e) => e.motif_id === STALE_ID)).toBeUndefined()

    // "Another project updated it": bump v2 on disk.
    writeUserMotifAt(motifsRoot, { id: STALE_ID, version: 2, color: '#1ea64a' })

    // Reopen the project — the on-mount staleness check fires.
    const rr = await page.evaluate(
      (p) =>
        (window as any).__weftcutTest
          .motifReopenProject({ path: p })
          .then(() => ({ ok: true }))
          .catch((e: unknown) => ({ ok: false, error: String(e) })),
      projectPath as string,
    )
    if (!rr.ok) throw new Error('motifReopenProject failed: ' + rr.error)
    await waitForHook(page, 'addMotifLayer')
    // Poll motif_staleness_report until it returns a non-empty array (or ~10s deadline).
    // The report is pull-based (computes from current snapshot + disk catalog on each call),
    // so polling is safe and idempotent — no race condition from a fixed wall-clock wait.
    let reportAfter: Array<{
      motif_id: string
      placed_version: number
      current_version: number
      layer_count: number
    }> = []
    {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        reportAfter = (await invoke(page, 'motif_staleness_report', {})) as typeof reportAfter
        if (reportAfter.length > 0) break
        await page.waitForTimeout(300)
      }
      // If still empty after deadline, fall through so the existing assertion fails with context.
    }

    // motif_staleness_report must now show the stale row.
    console.log('[s5-stale] report after reopen:', JSON.stringify(reportAfter))
    const row = reportAfter.find((e) => e.motif_id === STALE_ID)
    expect(row).toBeDefined()
    expect(row!.placed_version).toBe(1)
    expect(row!.current_version).toBe(2)
    expect(row!.layer_count).toBe(2)

    // acknowledge_motif_staleness returns the count of markers bumped (≥ 1).
    const ackCount = (await invoke(page, 'acknowledge_motif_staleness', {})) as number
    console.log('[s5-stale] ack count:', ackCount)
    expect(ackCount).toBeGreaterThanOrEqual(1)
  } finally {
    await closeAppRobustly(appHandle)
    removeUserMotifAt(motifsRoot, STALE_ID)
  }
})

// ── Section C: file-watch hot-reload ───────────────────────────────────────────

test('S5 motif file-watch: disk-placed Motif renders; external rewrite hot-reloads', async () => {
  test.setTimeout(180_000)
  const WATCH_ID = 'e2e-s5-watch-' + Date.now()
  const PROJECT_PARENT = path.resolve(os.tmpdir(), 'weftcut-e2e-s5-watch-proj')
  const RED = '#e02424'
  const GREEN = '#1ea64a'
  mkdirSync(PROJECT_PARENT, { recursive: true })

  const appHandle = await electron.launch({ args: [MAIN] })
  const page = await appHandle.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Get the actual userData path from the running app.
  const userData = await appHandle.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const motifsRoot = path.join(userData, 'motifs')
  console.log('[s5-watch] motifsRoot:', motifsRoot)

  try {
    // 1. Write the Motif directly to disk WHILE the app is running.
    writeUserMotifAt(motifsRoot, { id: WATCH_ID, version: 1, color: RED })

    // 2. Create a 320×320 project so the Motif fills the frame.
    await newProject(page, {
      parentFolder: PROJECT_PARENT,
      name: 'e2e-s5-watch-' + Date.now(),
      canvas: { width: 320, height: 320, fpsNum: 30, fpsDen: 1 },
    })
    await waitForHook(page, 'addMotifLayer')
    await waitForHook(page, 'weftcutSampleComposite')

    // 3. Wait for the motif to appear in the Rust catalog (reads from disk directly).
    await waitForMotifInCatalog(page, WATCH_ID)

    // 4. Place the user Motif.
    const added = await page.evaluate(
      (id) =>
        (window as any).__weftcutTest
          .addMotifLayer({ motifId: id, durationUs: 2_000_000 })
          .then((layerId: string) => ({ ok: true, layerId }))
          .catch((e: unknown) => ({ ok: false, error: String(e) })),
      WATCH_ID,
    )
    if (!added.ok) throw new Error('addMotifLayer failed: ' + added.error)

    // Helper: poll the composite until `predicate(px)` holds. Re-seek each round;
    // weftcutSeekUs throws until the PixiPreview bridge registers (swallow it).
    async function waitForCenter(
      predicate: (px: { r: number; g: number; b: number; a: number }) => boolean,
      label: string,
    ) {
      const deadline = Date.now() + 60_000
      let last: { r: number; g: number; b: number; a: number } | null = null
      while (Date.now() < deadline) {
        await page.evaluate(() => {
          try {
            ;(window as any).__weftcutTest.weftcutSeekUs(500_000)
          } catch {
            // bridge not ready yet
          }
        })
        await page.waitForTimeout(800)
        const snap = await page.evaluate(() =>
          (window as any).__weftcutTest
            .weftcutSampleComposite(160, 160)
            .then((p: { r: number; g: number; b: number; a: number }) => ({ ok: true, p }))
            .catch((e: unknown) => ({ ok: false, error: String(e) })),
        )
        if (!snap.ok) continue
        last = snap.p as typeof last
        if (predicate(last!)) return last!
      }
      throw new Error(`${label}: composite never matched; last=${JSON.stringify(last)}`)
    }

    // 5. The placed layer renders the RED box.
    const red = await waitForCenter(
      (p) => p.a > 200 && p.r > 150 && p.g < 100,
      'initial red render',
    )
    console.log('[s5-watch] initial red pixel:', JSON.stringify(red))
    expect(red.r).toBeGreaterThan(150)
    expect(red.g).toBeLessThan(100)

    // 6. External edit: same id, same version, new color.
    writeUserMotifAt(motifsRoot, { id: WATCH_ID, version: 1, color: GREEN })

    // 7. Hot reload: compositor turns green with NO UI action (watcher fires
    //    motifs:changed → content_hash bust → CDP recapture).
    const green = await waitForCenter(
      (p) => p.a > 200 && p.g > 120 && p.r < 100,
      'hot-reloaded green render',
    )
    console.log('[s5-watch] hot-reload green pixel:', JSON.stringify(green))
    expect(green.g).toBeGreaterThan(120)
    expect(green.r).toBeLessThan(100)
  } finally {
    await closeAppRobustly(appHandle)
    removeUserMotifAt(motifsRoot, WATCH_ID)
  }
})
