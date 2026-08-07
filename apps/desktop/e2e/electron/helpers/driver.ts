import { _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/// Built Electron main entry. Helpers live at e2e/electron/helpers; the build
/// output is apps/desktop/out/main/index.js → three levels up.
export const MAIN = path.resolve(__dirname, '../../../out/main/index.js')

/// Chromium GL switches every launch needs, per platform. Spread these into
/// `args` BEFORE the app entry (see the switch-ordering note in launchApp);
/// raw `electron.launch` call sites must include them too, which is why this is
/// a shared export rather than inlined.
///
/// Linux gets `--enable-unsafe-swiftshader` because the CI runner has no GPU —
/// it is xvfb over llvmpipe, and since Chromium 121 a software WebGL fallback is
/// REFUSED unless this switch is passed explicitly. Without it every WebGL2
/// context creation fails, preview and the export worker's GL packing alike
/// (see the renderer assertion in exportWorker.ts).
///
/// Windows and macOS deliberately get NOTHING: both have a real GPU stack on
/// the runners, and forcing software GL on Windows 11 HANGS the offscreen CDP
/// capture — see the RENDERER CHOICE note in .github/workflows/electron-ci.yml.
/// WEFTCUT_E2E_GL overrides the table (space-separated switches) so a dev
/// machine can reproduce a CI leg's GL stack, e.g. ubuntu's SwiftShader:
/// WEFTCUT_E2E_GL="--use-angle=swiftshader --enable-unsafe-swiftshader"
export const GL_SWITCHES: readonly string[] = process.env.WEFTCUT_E2E_GL
  ? process.env.WEFTCUT_E2E_GL.split(/\s+/).filter(Boolean)
  : process.platform === 'linux'
    ? ['--enable-unsafe-swiftshader']
    : []

/// Temp-dir lifecycle & default userData isolation.
///
/// Bare `launchApp()` mints a fresh, empty userData dir (mkdtemp under
/// os.tmpdir()) for EVERY launch and registers the app below; the driver
/// removes the dir once the app's close() resolves, and a process-exit sweep
/// kills + cleans up whatever a spec forgot to close. Specs are therefore
/// isolated from each other and from the developer's real WeftCut profile —
/// layout mutations and autosaves can no longer leak through the OS-default
/// userData, and the suite is safe to run with parallel workers.
///
/// A spec that must relaunch over the SAME userData (app-level state such as
/// <userData>/workspaces.json surviving a restart) mints its own dir —
/// `tmpDir('weftcut-e2e-')` — and passes it as `opts.userDataDir` on both
/// launches. Caller-provided dirs are never removed by close(); tmpDir's own
/// exit sweep still reaps them.
///
/// Set WEFTCUT_E2E_KEEP_TMP=1 to skip ALL dir removal (surviving apps are
/// still killed) when debugging export outputs locally.
const keepTmp = () => process.env.WEFTCUT_E2E_KEEP_TMP === '1'

/// Live apps → the userData dir the driver minted for them (null when the
/// caller passed their own — then the driver still kills on exit but never
/// removes the dir).
const liveApps = new Map<ElectronApplication, string | null>()
/// Every dir minted by tmpDir(), swept at process exit.
const mintedTmpDirs = new Set<string>()

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best effort — a dying process may still hold a file inside.
  }
}

/// Mint a fresh temp dir under os.tmpdir() with `prefix`, registered for
/// removal at process exit. Specs use this for project-parent dirs and export
/// outputs they don't otherwise manage.
export function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  mintedTmpDirs.add(dir)
  return dir
}

/// Export-fidelity SSIM floor for the 1:1 export gates. Default 0.8; a CI leg
/// whose GL raster legitimately rounds differently (SwiftShader: pervasive
/// ±1-2 LSB, SSIM-visible but PSNR-flat) overrides it to its measured healthy
/// baseline minus margin via WEFTCUT_E2E_SSIM_FLOOR — see e2e/README.md.
export function exportSsimFloor(dflt = 0.8): number {
  const v = Number(process.env.WEFTCUT_E2E_SSIM_FLOOR)
  return Number.isFinite(v) && v > 0 ? v : dflt
}

export type DockDropPosition = 'left' | 'right' | 'top' | 'bottom' | 'center'

/**
 * A dock Panel's BODY — the `.weft-dock-panel` region that hosts its content,
 * carries `data-panel-visible`, and is the focus region (ADR 0041). Omit `kind`
 * for every open Panel.
 *
 * The `.weft-dock-panel` prefix is not optional: `data-panel-kind` is also on
 * each Panel's TAB renderer, so a bare `[data-panel-kind]` matches twice per
 * Panel. Counting is the loud failure; the quiet one is worse — the tab comes
 * FIRST in document order, so `querySelector`/`.evaluate` silently measures a
 * 28px tab strip and geometry assertions pass or fail for the wrong reason.
 */
export const dockPanel = (page: Page, kind?: string): Locator =>
  page.locator(
    kind ? `.weft-dock-panel[data-panel-kind="${kind}"]` : '.weft-dock-panel[data-panel-kind]',
  )

/**
 * A dock Panel's header TAB, as Dockview's own `.dv-tab` box.
 *
 * That wrapper — not the `.weft-dock-tab` we render inside it — is the element
 * Dockview marks `draggable` and gives `role="tab"`, and Playwright's synthetic
 * pointer sequence does not reliably promote a mousedown on a descendant into a
 * native HTML5 drag. So both drags and clicks must target this box.
 *
 * NOT `getByTitle('Move <Panel>')`: a standard tab carries no `title` at all.
 * Only the Quick Actions grip has one, and it sits on the inner div, where it
 * does NOT become the `role="tab"` wrapper's accessible name (measured: that
 * name is ""). Its string is `dock_workspace.move_panel` — today "Drag to move
 * <Panel>" — so even a substring match on the old "Move <Panel>" reaches the
 * grip and nothing else. Overflow-dropdown rows are excluded for free: they get
 * no `data-panel-kind`.
 */
export const dockTab = (page: Page, kind: string): Locator =>
  page
    .locator('.dv-tab')
    .filter({ has: page.locator(`.weft-dock-tab[data-panel-kind="${kind}"]`) })

/** Drive Dockview with a real pointer gesture. Its drop-zone overlay
 * intentionally covers the underlying target mid-drag, so locator.dragTo's
 * target-actionability retry can wait forever even though a user drop works. */
export async function dragDockTab(
  page: Page,
  source: Locator,
  target: Locator,
  position: DockDropPosition = 'center',
): Promise<void> {
  await source.waitFor({ state: 'visible' })
  await target.waitFor({ state: 'visible' })
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('dock drag endpoints have no layout box')

  const start = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  }
  const inset = 8
  const end = {
    x:
      position === 'left'
        ? targetBox.x + inset
        : position === 'right'
          ? targetBox.x + targetBox.width - inset
          : targetBox.x + targetBox.width / 2,
    y:
      position === 'top'
        ? targetBox.y + inset
        : position === 'bottom'
          ? targetBox.y + targetBox.height - inset
          : targetBox.y + targetBox.height / 2,
  }

  let pressed = false
  try {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    pressed = true
    await page.mouse.move(end.x, end.y, { steps: 24 })
    await page.mouse.up()
    pressed = false
  } finally {
    if (pressed) await page.mouse.up()
  }
}

/// Wrap an app's close(): once the original close settles, remove the
/// userData dir the driver minted for it and unregister. Idempotent — every
/// call after the first returns the same promise, so double close is safe.
function wrapClose(app: ElectronApplication): () => Promise<void> {
  const original = app.close.bind(app)
  let closing: Promise<void> | null = null
  return () => {
    closing ??= (async () => {
      try {
        await original()
      } finally {
        // finally: a rejected close means the process already died — the dir
        // is still safe (and still ours) to remove.
        const dir = liveApps.get(app) ?? null
        liveApps.delete(app)
        if (dir && !keepTmp()) removeDir(dir)
      }
    })()
    return closing
  }
}

/// Best-effort sweep when the Playwright worker exits: kill any app a spec
/// forgot to close, then remove every dir the driver minted. 'exit' handlers
/// must be synchronous, so this is kill() + rmSync, not an awaited close().
process.on('exit', () => {
  for (const [app, dir] of liveApps) {
    try {
      app.process()?.kill()
    } catch {
      // Already gone.
    }
    if (dir && !keepTmp()) removeDir(dir)
  }
  if (!keepTmp()) for (const dir of mintedTmpDirs) removeDir(dir)
})

/// Launch the built app over an isolated userData dir. With no
/// `opts.userDataDir` (the default — what almost every spec wants) the driver
/// mints a fresh empty dir for this launch and removes it on close, so bare
/// `launchApp()` boots the pristine built-in Editing baseline, never touches
/// the developer's real profile or another spec's state, and is safe under
/// parallel workers. Pass an explicit `opts.userDataDir` only for a
/// same-userData relaunch: mint the dir with `tmpDir` and hand it to both
/// launches (see the lifecycle comment above).
export async function launchApp(
  opts: { userDataDir?: string; locale?: string; env?: Record<string, string> } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const locale = opts.locale ?? 'en-US'
  const localeBase = locale.split('-')[0] ?? locale
  const processLocale = `${locale.replace('-', '_')}.UTF-8`
  // Chromium switches must precede the app entry. Otherwise Electron forwards
  // them as application arguments and userData isolation is ignored. Linux
  // Chromium derives navigator.language from the process locale despite
  // --lang, so set both inputs for deterministic accessible names.
  const args = [`--lang=${locale}`, ...GL_SWITCHES]
  let mintedUserDataDir: string | null = null
  if (opts.userDataDir) {
    args.push(`--user-data-dir=${opts.userDataDir}`)
  } else {
    mintedUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-e2e-'))
    args.push(`--user-data-dir=${mintedUserDataDir}`)
  }
  args.push(MAIN)
  const app = await electron.launch({
    args,
    // The elevated-run notice is a modal dialog; suppress it so it can't block the
    // (often elevated) e2e/CI Electron process. `env` replaces process.env, so
    // spread it to keep PATH etc. that the app needs.
    // Caller-supplied `opts.env` is spread LAST so a spec can inject extra
    // vars (e.g. WEFTCUT_FORCE_HW_LANE for the lane-parameterized preview-hw
    // conformance spec) without disturbing the locale/elevation keys above.
    env: {
      ...process.env,
      LANG: processLocale,
      LANGUAGE: `${locale.replace('-', '_')}:${localeBase}`,
      LC_ALL: processLocale,
      WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1',
      ...(opts.env ?? {}),
    } as Record<string, string>,
  })
  liveApps.set(app, mintedUserDataDir)
  app.close = wrapClose(app)
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    // Opt-in renderer console tap for wedge diagnosis (local or a CI leg).
    if (process.env.WEFTCUT_E2E_CONSOLE === '1') {
      page.on('console', (msg) => console.log(`[renderer:${msg.type()}] ${msg.text()}`))
      page.on('pageerror', (err) => console.log(`[renderer:pageerror] ${err.message}`))
    }
    await page.waitForLoadState('domcontentloaded')
    return { app, page }
  } catch (e) {
    // Boot failed before the caller got a page: close via the wrapper so the
    // half-launched process and the minted userData dir don't leak.
    await app.close().catch(() => {})
    throw e
  }
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
/// `api.backend.invoke` is the single generic command channel into the
/// main-process router (TS actor for state, Rust for compute) that the renderer
/// and every e2e spec use. Rejects (failing the test) when the command errors.
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
/// settlement. `hook` defaults to "exportClip"; pass "exportTimeline" for the
/// timeline path.
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
  let done: { ok: boolean; error?: string }
  try {
    const handle = await page.waitForFunction(() => (window as any).__e2eExportDone, undefined, {
      timeout,
      polling: 1000,
    })
    done = (await handle.jsonValue()) as { ok: boolean; error?: string }
  } catch (e) {
    // Timed out mid-export: surface WHERE it wedged, not just that it did.
    const st = await page
      .evaluate(() => {
        const s = (window as any).__weftcutExportState
        const p = (window as any).__weftcutExportPerf
        return { kind: s?.kind ?? null, detail: s?.detail ?? null, perf: p ?? null }
      })
      .catch(() => null)
    throw new Error(
      `export did not complete within ${timeout}ms; ` +
        `last state=${st?.kind}/${JSON.stringify(st?.detail)} perf=${JSON.stringify(st?.perf)}`,
      { cause: e },
    )
  }
  const st = (await page.evaluate(() => {
    const s = (window as any).__weftcutExportState
    return { kind: s?.kind ?? null, detail: s?.detail ?? null }
  })) as { kind: string | null; detail: string | null }
  // What each handle actually decoded (original vs proxy) — the readiness
  // gate's route-corrections are otherwise invisible from a green export.
  const sources = (await page.evaluate(
    () => (window as any).__weftcutExportPerf?.sources ?? null,
  )) as Array<{ mediaId: string; url: string }> | null
  if (sources) console.log(`[e2e] export sources: ${JSON.stringify(sources)}`)
  return { done, lastKind: st.kind, lastDetail: st.detail }
}
