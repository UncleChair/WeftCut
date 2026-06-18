import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/// Built Electron main entry. Helpers live at e2e/electron/helpers; the build
/// output is apps/desktop/out/main/index.js → three levels up.
export const MAIN = path.resolve(__dirname, '../../../out/main/index.js')

export async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [MAIN] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/// Wait until window.__weftcutTest[name] is a function (the hook surface mounts
/// async after the editor loads). Requires a VITE_WEFTCUT_E2E=1 build.
export async function waitForHook(page: Page, name: string, timeout = 30000): Promise<void> {
  await page.waitForFunction(
    (n) => typeof (window as unknown as { __weftcutTest?: Record<string, unknown> }).__weftcutTest?.[n] === 'function',
    name,
    { timeout },
  )
}

/// Create a workspace + enter the editor via the bootstrap hook.
export async function newProject(
  page: Page,
  opts: {
    parentFolder: string
    name: string
    canvas: { width: number; height: number; fpsNum: number; fpsDen: number }
  },
): Promise<void> {
  await waitForHook(page, 'newProjectAndEnter')
  const r = (await page.evaluate(
    (o) =>
      (window as any).__weftcutTest
        .newProjectAndEnter({ parentFolder: o.parentFolder, name: o.name, canvas: o.canvas })
        .then(() => ({ ok: true }))
        .catch((e: unknown) => ({ ok: false, error: String(e) })),
    opts,
  )) as { ok: boolean; error?: string }
  if (!r.ok) throw new Error('newProjectAndEnter failed: ' + r.error)
}

export interface DriveResult {
  done: { ok: boolean; error?: string }
  lastKind: string | null
  lastDetail: string | null
}

/// Fire-and-forget an export hook, then poll window.__e2eExportDone to
/// settlement. Mirrors e2e/helpers/export.mjs::driveExport for Playwright.
/// `hook` defaults to "exportClip"; pass "exportTimeline" for the timeline path.
export async function driveExport(
  page: Page,
  args: Record<string, unknown>,
  opts: { hook?: string; timeout?: number } = {},
): Promise<DriveResult> {
  const hook = opts.hook ?? 'exportClip'
  const timeout = opts.timeout ?? 170000
  await waitForHook(page, hook)
  await page.evaluate(
    ({ h, a }) => {
      ;(window as any).__e2eExportDone = null
      ;(window as any).__weftcutTest[h](a)
        .then(() => {
          ;(window as any).__e2eExportDone = { ok: true }
        })
        .catch((e: unknown) => {
          ;(window as any).__e2eExportDone = { ok: false, error: String(e) }
        })
    },
    { h: hook, a: args },
  )
  const handle = await page.waitForFunction(() => (window as any).__e2eExportDone, undefined, {
    timeout,
    polling: 1000,
  })
  const done = (await handle.jsonValue()) as { ok: boolean; error?: string }
  const st = (await page.evaluate(() => {
    const s = (window as any).__weftcutExportState
    return { kind: s?.kind ?? null, detail: s?.detail ?? null }
  })) as { kind: string | null; detail: string | null }
  return { done, lastKind: st.kind, lastDetail: st.detail }
}
