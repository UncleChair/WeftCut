import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/// Built Electron main entry. Helpers live at e2e/electron/helpers; the build
/// output is apps/desktop/out/main/index.js → three levels up.
export const MAIN = path.resolve(__dirname, '../../../out/main/index.js')

export async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN],
    // The elevated-run notice is a modal dialog; suppress it so it can't block the
    // (often elevated) e2e/CI Electron process. `env` replaces process.env, so
    // spread it to keep PATH etc. that the app needs.
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  const page = await app.firstWindow({ timeout: 60_000 })
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

/// Invoke a backend command through the renderer bridge and return its result.
/// The Electron equivalent of the retired wdio helper's `window.__TAURI__.core
/// .invoke` — `api.backend.invoke` is the one generic command channel the
/// renderer + every ported spec already use. Rejects (failing the test) when
/// the backend command errors.
export async function invokeCmd<T = unknown>(
  page: Page,
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await page.evaluate(
    ([c, a]) => (window as any).api.backend.invoke(c, a),
    [cmd, args] as const,
  )) as T
}

/// The current project summary (tracks → layers + composition). Loosely typed;
/// callers narrow the fields they read.
export interface ProjectSummary {
  composition: { fps_num: number; fps_den: number }
  tracks: Array<{ id: string; layers: Array<{ id: string; params: { kind: string } }> }>
}
export const summary = (page: Page) => invokeCmd<ProjectSummary>(page, 'project_summary', {})

/// Import `mediaAbsPath` and place it 1:1 at `tStartUs` (default 0) on a fresh
/// track — the `importAndPlaceMedia` hook (same IPC chain the UI uses), without
/// exporting. Returns the new ids + the media's classified kind.
export async function importAndPlaceMedia(
  page: Page,
  args: { mediaAbsPath: string; tStartUs?: number },
): Promise<{ mediaId: string; layerId: string; kind: string }> {
  await waitForHook(page, 'importAndPlaceMedia')
  const r = (await page.evaluate(
    (a) =>
      (window as any).__weftcutTest
        .importAndPlaceMedia(a)
        .then((x: unknown) => ({ ok: true, ...(x as object) }))
        .catch((e: unknown) => ({ ok: false, error: String(e) })),
    args,
  )) as { ok: boolean; error?: string; mediaId: string; layerId: string; kind: string }
  if (!r.ok) throw new Error('importAndPlaceMedia failed: ' + r.error)
  return r
}

/// Place an ALREADY-imported media 1:1 at `tStartUs` (default 0) on a fresh
/// track — the placement half of `importAndPlaceMedia`. Lets a spec put N
/// copies of ONE mediaId on the timeline (shared-source scenarios).
export async function placeMediaLayer(
  page: Page,
  args: { mediaId: string; tStartUs?: number },
): Promise<{ layerId: string }> {
  await waitForHook(page, 'placeMediaLayer')
  const r = (await page.evaluate(
    (a) =>
      (window as any).__weftcutTest
        .placeMediaLayer(a)
        .then((x: unknown) => ({ ok: true, ...(x as object) }))
        .catch((e: unknown) => ({ ok: false, error: String(e) })),
    args,
  )) as { ok: boolean; error?: string; layerId: string }
  if (!r.ok) throw new Error('placeMediaLayer failed: ' + r.error)
  return r
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
