import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp, newProject, driveExport, waitForHook, tmpDir } from './helpers/driver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, '../fixtures/media')

// REGRESSION GATE for the export-Worker dropped-ready wedge (runExport.ts
// `workerReady` latch). Two back-to-back clip exports in ONE app session, a
// fresh project each: the first export cold-compiles the Worker bundle, the
// second runs it from a WARM code cache, so the Worker posts {type:"ready"}
// while the export harness is still awaiting its bundled-font fetches. Before
// the latch fix, a ready dispatched while no message listener was attached was
// silently dropped: `start` never went out and the export hung at "starting"
// until driveExport's timeout.
//
// The drop is a race: it only fires when the font fetches resolve SLOWER than
// the warm Worker's startup — true under a cold HTTP cache or full-suite load
// (where the bug originally surfaced), but not on a warmed-up dev box, where
// the cached fetches win and the bug hides. The fetch shim below deterministically
// recreates the trigger: it delays font-URL fetches by 500ms (≫ warm Worker
// startup), exactly like a cold cache. A latched build shrugs this off (ready
// is caught whenever it lands — and with loadBundledFontBytes memoized, the
// second export doesn't refetch at all); a pre-latch build wedges reliably.
//
// Reuses the generated color fixtures (`npm run fixtures`); skips where absent
// (CI), same status as color-conformance.spec.ts.
const CLIPS = ['test_1080p_color_709ltd.mp4', 'test_1080p_color_601ltd.mp4']
const sourceFor = (name: string) => path.resolve(MEDIA_DIR, name)

/// Delay font fetches (.ttf/.woff/.woff2) by `delayMs`, delegating everything
/// else untouched. Models a cold font cache so the ready-vs-fonts race always
/// takes the branch the wedge lived on.
async function installSlowFontFetch(page: Page, delayMs: number): Promise<void> {
  await page.evaluate((ms) => {
    const orig = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (/\.(ttf|otf|woff2?)([?#]|$)/i.test(url)) {
        await new Promise((r) => setTimeout(r, ms))
      }
      return orig(input, init)
    }
  }, delayMs)
}

test.describe('repeat export in one session (Electron)', () => {
  let app: ElectronApplication | undefined
  let page: Page

  test.beforeAll(async () => {
    test.skip(
      !CLIPS.every((c) => existsSync(sourceFor(c))),
      'media fixtures not present (run `npm run fixtures`)',
    )
    ;({ app, page } = await launchApp())
    await waitForHook(page, 'newProjectAndEnter')
    await installSlowFontFetch(page, 500)
  })
  test.afterAll(async () => {
    await app?.close()
  })

  test('two back-to-back clip exports both complete', async () => {
    test.setTimeout(240000)
    const PROJECT_PARENT = tmpDir('weftcut-e2e-export-repeat-proj-')
    for (const [i, clip] of CLIPS.entries()) {
      const n = i + 1
      const out = path.join(tmpDir('weftcut-e2e-export-repeat-out-'), `export-repeat-${n}.mp4`)
      await newProject(page, {
        parentFolder: PROJECT_PARENT,
        name: `e2e-export-repeat-${n}-` + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      const r = await driveExport(page, { mediaAbsPath: sourceFor(clip), outputAbsPath: out })
      if (!r.done.ok) {
        throw new Error(
          `export #${n} failed: ${r.done.error} (lastState=${r.lastKind}/${r.lastDetail})`,
        )
      }
      expect(existsSync(out), `export #${n} produced no output at ${out}`).toBe(true)
      expect(statSync(out).size, `export #${n} output is empty`).toBeGreaterThan(0)
    }
  })
})
