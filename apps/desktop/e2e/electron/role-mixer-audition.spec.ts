import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { invokeCmd, launchApp, launchFreshApp, newProject, waitForHook } from './helpers/driver'

// Role Gain audition — renders the REAL preview Role-gain fold
// (`auditionedRoleGainLinear` → GainNode) in an OfflineAudioContext and checks
// that a renderer-local audition override folds in place of the committed Role
// gain (audible immediately), then that clearing it returns the committed gain.
// A constant-1.0 source makes the output RMS equal the folded linear gain, so
// each case is analytic. Covers the audition WIRING that the headless override
// and fold goldens cannot reach — the real Web Audio path preview playback runs.
// Role Mixer behavior and gain semantics are documented in docs/audio.md.
test.describe('Role Gain audition (Electron preview audio)', () => {
  let app: ElectronApplication | undefined
  let page: Page
  test.beforeAll(async () => {
    ;({ app, page } = await launchApp())
    // The hook surface mounts async (main.tsx dynamic-imports e2eHook after
    // React mounts); evaluating before it lands races → undefined __weftcutTest.
    await waitForHook(page, 'roleGainAuditionProbe')
  })
  test.afterAll(async () => { await app?.close() })

  const dbToLinear = (db: number): number => 10 ** (db / 20)
  const FRAMES = 48_000
  const COMMITTED_DB = 6.0206 // ≈ 2.0×
  const OVERRIDE_DB = -6.0206 // ≈ 0.5×

  const probe = (overrideDb: number | null) =>
    page.evaluate(
      (a) => (window as any).__weftcutTest.roleGainAuditionProbe(a),
      { role: 'dialogue', committedDb: COMMITTED_DB, overrideDb, frames: FRAMES },
    ) as Promise<{ rms: number; folded: number }>

  test('an active override folds its gain in place of the committed Role gain', async () => {
    const audition = await probe(OVERRIDE_DB)
    console.log('[e2e] role audition override', JSON.stringify(audition))
    expect(audition.folded).toBeCloseTo(dbToLinear(OVERRIDE_DB), 2)
    expect(audition.rms).toBeCloseTo(dbToLinear(OVERRIDE_DB), 2)
  })

  test('clearing the override returns the committed Role gain', async () => {
    const committed = await probe(null)
    console.log('[e2e] role audition committed', JSON.stringify(committed))
    expect(committed.folded).toBeCloseTo(dbToLinear(COMMITTED_DB), 2)
    expect(committed.rms).toBeCloseTo(dbToLinear(COMMITTED_DB), 2)
  })

  test('audition changes the audible level relative to the committed gain', async () => {
    const audition = await probe(OVERRIDE_DB)
    const committed = await probe(null)
    // The override (−6 dB) must be audibly quieter than the committed +6 dB.
    expect(audition.rms).toBeLessThan(committed.rms)
    expect(committed.rms / audition.rms).toBeCloseTo(dbToLinear(COMMITTED_DB - OVERRIDE_DB), 1)
  })
})

// Drive the REAL Role Mixer Panel in the editor: open it from the View menu,
// confirm the master meter renders, then drag the Dialogue fader and prove the
// gesture records exactly one recorded Role gain (a single undo reverts it),
// while Escape mid-gesture records nothing — the one-commit + cancellation flow
// through the real actor.
test.describe('Role Mixer panel flow (Electron UI)', () => {
  let app: ElectronApplication | undefined
  let page: Page
  let workspace: string

  test.beforeAll(async () => {
    // Fresh userData: this block reopens the normally-closed Role Mixer Panel,
    // which the app autosaves — a shared userData would leak it into the
    // dock-workspace baseline specs that assert the default six-Panel set.
    ;({ app, page } = await launchFreshApp('weftcut-mixer-data-'))
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-mixer-'))
    await newProject(page, {
      parentFolder: workspace,
      name: 'role-mixer',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
    })
    // Role Mixer is closed in the built-in Editing workspace — reopen it from
    // the View menu (index 2, matching dock-workspace.spec.ts).
    await page.locator('.menu-trigger').nth(2).click()
    await page.locator('.menu-item').filter({ hasText: /^Role Mixer$/ }).click()
    await expect(page.locator('[data-panel-kind="role-mixer"]')).toHaveCount(1)
  })
  test.afterAll(async () => {
    await app?.close()
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  const panel = () => page.locator('[data-panel-kind="role-mixer"]')
  const dialogueGain = async (): Promise<number> => {
    const s = await invokeCmd<{ audio_roles?: Array<{ role: string; gain_db: number }> }>(
      page,
      'project_summary',
    )
    return s.audio_roles?.find((r) => r.role === 'dialogue')?.gain_db ?? 0
  }
  // Pointer-drag the Dialogue fader thumb by `dx` px and release.
  const dragDialogueFader = async (dx: number): Promise<void> => {
    const thumb = panel().getByLabel('Dialogue gain fader')
    const box = await thumb.boundingBox()
    if (!box) throw new Error('Dialogue fader has no bounding box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + dx, cy, { steps: 8 })
    await page.mouse.up()
  }

  test('shows the real master meter, not a per-Role meter', async () => {
    await expect(panel().getByRole('group', { name: 'Master output meter' })).toHaveCount(1)
  })

  test('a fader drag records exactly one Role gain command (one undo reverts it)', async () => {
    const before = await dialogueGain()
    await dragDialogueFader(48)
    const after = await dialogueGain()
    expect(after).not.toBe(before)

    // Exactly one recorded command ⇒ a single undo lands back on the original.
    await invokeCmd(page, 'project_undo')
    expect(await dialogueGain()).toBe(before)
  })

  test('Escape mid-drag restores the value and records nothing', async () => {
    const before = await dialogueGain()
    const thumb = panel().getByLabel('Dialogue gain fader')
    const box = await thumb.boundingBox()
    if (!box) throw new Error('Dialogue fader has no bounding box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 48, cy, { steps: 8 })
    await page.keyboard.press('Escape')
    await page.mouse.up()

    // No recorded command: the committed gain is unchanged by the cancelled
    // gesture (the audition override reverted the sound too).
    expect(await dialogueGain()).toBe(before)
  })
})
