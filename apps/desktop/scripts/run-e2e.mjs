import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url))) // apps/desktop

/** Local-only measurement gates that run AFTER the Playwright projects, each
 * behind its own flag. They drive the built app and measure, so they stay
 * opt-in: CI's per-PR matrix must not pay for them (the playback memory ratchet
 * is opt-in for the same reason, and additionally needs a dev server, so it has
 * no flag here). */
const EXTRA_GATES = {
  '--ruler-gate': {
    script: 'e2e/scripts/ruler-node-count.mjs',
    why: 'ruler tick/DOM count stays bounded by the viewport',
  },
  '--playback-perf': {
    script: 'e2e/scripts/playback-perf.mjs',
    why: 'per-stage preview playback cost and the max smooth track count',
  },
}

/** Split the extra-gate flags out of the Playwright argv — Playwright rejects
 * unknown flags, so they must never reach it. */
export function splitGateFlags(args) {
  const requested = args.filter((arg) => arg in EXTRA_GATES)
  return { gates: requested, args: args.filter((arg) => !(arg in EXTRA_GATES)) }
}

/** `--full` restores the `@matrix` cells that playwright.config.ts excludes by
 * default (the combinatorial audio sweeps and the specialty codec targets — the
 * expensive part of the suite, since each one drives a real encode). It selects
 * a tier rather than naming a Playwright option, so like the gate flags it has
 * to leave the argv before Playwright sees it. */
export function splitFullFlag(args) {
  return { full: args.includes('--full'), args: args.filter((arg) => arg !== '--full') }
}

/** Fold the planned runs' exit statuses into one process status: 0 only when
 * every run passed, otherwise the EARLIEST non-zero — the first project to fail
 * is the most diagnostic, and a later project's red is often downstream of it.
 *
 * This exists because every planned project must run even after one of them
 * fails (see the loop in runE2E), so there is no longer a single status to
 * return. */
export function foldRunStatuses(statuses) {
  return statuses.find((status) => status !== 0) ?? 0
}

/** Full runs execute the machine-exclusive project first, then the parallel
 * project. An explicitly selected project remains a single targeted run. */
export function planE2ERuns(args) {
  const hasExplicitProject = args.some(
    (arg) => arg === '--project' || arg.startsWith('--project='),
  )
  if (hasExplicitProject) return [args]

  return [
    ['--project=serial', '--pass-with-no-tests', ...args],
    ['--project=parallel', '--pass-with-no-tests', ...args],
  ]
}

// Same per-OS tables the fetch script (resources/ffmpeg/<os>/) and the specs'
// component probe (export-native-wedges.spec.ts ADDON_FILE) use.
const FFMPEG_OS_DIR = { win32: 'win', linux: 'linux', darwin: 'mac' }
const DECODE_ADDON_FILE = {
  win32: 'index.win32-x64-msvc.node',
  linux: 'index.linux-x64-gnu.node',
  darwin: 'index.darwin-arm64.node',
}

const defaultHasPathFfmpeg = () =>
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0

/** Point FFMPEG/FFPROBE at the fetched resources/ffmpeg/<os> binaries and put
 * their dir on PATH (the fixture generator and the app itself spawn a bare
 * `ffmpeg`). Precedence mirrors napi-build-decode.mjs: an explicit FFMPEG env
 * wins and leaves PATH untouched. */
function wireFfmpeg(env, { platform, root, hasPathFfmpeg }, notes) {
  if (env.FFMPEG) return
  const osDir = FFMPEG_OS_DIR[platform]
  const exe = platform === 'win32' ? '.exe' : ''
  const dir = osDir ? path.join(root, 'resources', 'ffmpeg', osDir) : null
  const ffmpeg = dir ? path.join(dir, `ffmpeg${exe}`) : null
  if (!ffmpeg || !existsSync(ffmpeg)) {
    if (!hasPathFfmpeg())
      notes.push(
        'no ffmpeg found (PATH or resources/ffmpeg) — run `npm run ffmpeg:fetch`; fixture generation fails if media is missing, SSIM comparisons degrade to warnings, encoder-dependent specs skip',
      )
    return
  }
  env.FFMPEG = ffmpeg
  const ffprobe = path.join(dir, `ffprobe${exe}`)
  if (!env.FFPROBE && existsSync(ffprobe)) env.FFPROBE = ffprobe
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  if (!(env[pathKey] ?? '').split(path.delimiter).includes(dir))
    env[pathKey] = env[pathKey] ? `${dir}${path.delimiter}${env[pathKey]}` : dir
  notes.push(`FFMPEG → ${path.relative(root, ffmpeg)} (bundled; dir prepended to PATH)`)
}

/** The local-only decode gates (decode-engine, export-native-wedges,
 * export-prores-fidelity, preview-gpu-order) skip unless WEFTCUT_DECODE_E2E=1.
 * On a dev machine with the native-decode component built that opt-in is the
 * real per-platform config, so default it on. Any explicit value (including
 * "0") and CI are left alone — CI builds the addon too but must keep these
 * gates off. */
function wireDecodeGates(env, { platform, root }, notes) {
  if ('WEFTCUT_DECODE_E2E' in env || env.CI) return
  const addonFile = DECODE_ADDON_FILE[platform]
  if (!addonFile || !existsSync(path.join(root, 'native', 'decode', addonFile))) return
  env.WEFTCUT_DECODE_E2E = '1'
  notes.push(
    'WEFTCUT_DECODE_E2E=1 (native-decode component present — set WEFTCUT_DECODE_E2E=0 to skip the local-only decode gates)',
  )
}

/** True when a built renderer chunk contains the `__weftcutTest` hook surface.
 * The marker is absent from a production build — every reference sits behind a
 * static VITE_WEFTCUT_E2E check and is tree-shaken (verified by grepping a
 * flag-less build), so its presence ⇔ an e2e-capable build. */
function rendererHasE2EHook(rendererDir) {
  const stack = [rendererDir]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(p)
      else if (entry.name.endsWith('.js') && readFileSync(p, 'utf8').includes('__weftcutTest'))
        return true
    }
  }
  return false
}

/** Fail fast on a missing/flag-less build instead of the alternative symptom:
 * every export spec timing out in waitForHook (30 s) with no other clue. */
function checkE2EBuild({ root }, errors) {
  const rendererDir = path.join(root, 'out', 'renderer')
  if (!existsSync(rendererDir)) {
    errors.push('no built app at out/ — run `npm run build:e2e` first')
    return
  }
  if (!rendererHasE2EHook(rendererDir))
    errors.push(
      'out/ was built without VITE_WEFTCUT_E2E=1 — window.__weftcutTest is tree-shaken out and every export spec times out in waitForHook; rebuild with `npm run build:e2e`',
    )
}

/** Name the tier that is about to run. Without this the test count moves for no
 * visible reason and a shrunken run reads as tests having gone missing. */
function noteMatrixTier(env, notes) {
  notes.push(
    env.WEFTCUT_E2E_FULL
      ? 'WEFTCUT_E2E_FULL=1 — @matrix cells included (full combinatorial sweep)'
      : '@matrix cells excluded (combinatorial + specialty-codec sweep) — pass --full to run them',
  )
}

/** Wire the per-platform real-run config into a copy of the environment and
 * collect fatal preflight errors. Pure apart from fs reads — exported for the
 * node:test suite, which points `root` at a fixture tree. */
export function prepareE2EEnv(
  env,
  { platform = process.platform, root = ROOT, hasPathFfmpeg = defaultHasPathFfmpeg } = {},
) {
  const errors = []
  const notes = []
  wireFfmpeg(env, { platform, root, hasPathFfmpeg }, notes)
  wireDecodeGates(env, { platform, root }, notes)
  noteMatrixTier(env, notes)
  checkE2EBuild({ root }, errors)
  // CI wraps the run in xvfb-run (which sets DISPLAY for the child); locally a
  // missing DISPLAY only surfaces as Electron launch failures deep in a spec.
  if (platform === 'linux' && !env.CI && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    errors.push(
      'no DISPLAY on Linux — Electron cannot start; run with DISPLAY=:0 (local desktop) or under `xvfb-run -a`',
    )
  return { env, errors, notes }
}

export function runE2E(argv = process.argv.slice(2)) {
  const { gates, args: afterGates } = splitGateFlags(argv)
  const { full, args } = splitFullFlag(afterGates)
  const { env, errors, notes } = prepareE2EEnv({
    ...process.env,
    ...(full ? { WEFTCUT_E2E_FULL: '1' } : {}),
  })
  for (const note of notes) console.log(`[e2e preflight] ${note}`)
  for (const [flag, gate] of Object.entries(EXTRA_GATES))
    if (!gates.includes(flag))
      console.log(`[e2e preflight] ${flag} not requested — skipping the local gate for ${gate.why}`)
  if (errors.length) {
    for (const error of errors) console.error(`[e2e preflight] ${error}`)
    return 1
  }
  const cli = require.resolve('@playwright/test/cli')
  // Run EVERY planned project, even after one of them fails. Returning on the
  // first non-zero status meant a red `serial` project SILENTLY SKIPPED the
  // `parallel` project — on CI's macOS leg that left the 143-test parallel run
  // unmeasured on every failing push, so one known-red serial spec hid an
  // unknown number of real failures behind it. A project that fails now costs
  // the rest of the suite's time; being able to see the rest is the point.
  const statuses = []
  for (const runArgs of planE2ERuns(args)) {
    const result = spawnSync(
      process.execPath,
      [cli, 'test', '-c', 'playwright.config.ts', ...runArgs],
      { cwd: ROOT, env, stdio: 'inherit' },
    )
    // A spawn error (no binary, EAGAIN) is not a test result — fail loudly
    // rather than folding it into a status the caller reads as "tests ran".
    if (result.error) throw result.error
    statuses.push(result.status ?? 1)
  }
  // The extra gates measure a working app, so a red suite still short-circuits
  // them — only the projects above are run-to-completion.
  const suiteStatus = foldRunStatuses(statuses)
  if (suiteStatus !== 0) return suiteStatus
  for (const flag of gates) {
    const gate = EXTRA_GATES[flag]
    const result = spawnSync(process.execPath, [path.join(ROOT, gate.script)], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runE2E()
}
