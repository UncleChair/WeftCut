import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { SLICES, sliceEnv } from '../e2e/slices.mjs'
import {
  foldRunStatuses,
  planE2ERuns,
  planSlicedRuns,
  prepareE2EEnv,
  reportFileForRun,
  splitFullFlag,
  splitGateFlags,
  splitSliceFlag,
} from './run-e2e.mjs'

test('--full is consumed as a tier selector and never reaches Playwright', () => {
  const { full, args } = splitFullFlag(['--full', '--project=parallel', 'audio.spec.ts'])
  assert.equal(full, true)
  assert.deepEqual(args, ['--project=parallel', 'audio.spec.ts'])
  const without = splitFullFlag(['--project=parallel'])
  assert.equal(without.full, false)
  assert.deepEqual(without.args, ['--project=parallel'])
})

test('unscoped E2E runs machine-exclusive tests before the parallel project', () => {
  assert.deepEqual(planE2ERuns(['dock-workspace.spec.ts']), [
    ['--project=serial', '--pass-with-no-tests', 'dock-workspace.spec.ts'],
    ['--project=parallel', '--pass-with-no-tests', 'dock-workspace.spec.ts'],
  ])
})

test('an explicit E2E project remains one targeted run', () => {
  assert.deepEqual(
    planE2ERuns(['preview-sw-conformance.spec.ts', '--project=serial', '--workers=1']),
    [['preview-sw-conformance.spec.ts', '--project=serial', '--workers=1']],
  )
  assert.deepEqual(
    planE2ERuns(['--project', 'parallel', '-g', 'edge drop']),
    [['--project', 'parallel', '-g', 'edge drop']],
  )
})

// ── reportFileForRun ───────────────────────────────────────────────────────
// The load-bearing property is that the planned runs get DISTINCT files. They
// share one config, so a collision silently costs the serial project's timings
// — the report still exists and still parses, just describing the wrong half.

test('each planned run writes its own timing report', () => {
  const files = planE2ERuns(['audio.spec.ts']).map((run) => reportFileForRun(run, '/root'))
  assert.deepEqual(files, [
    path.join('/root', 'e2e-report', 'serial.json'),
    path.join('/root', 'e2e-report', 'parallel.json'),
  ])
})

test('a report is named for the project, in either --project spelling', () => {
  assert.equal(
    reportFileForRun(['--project=serial', '-g', 'ruler'], '/root'),
    path.join('/root', 'e2e-report', 'serial.json'),
  )
  assert.equal(
    reportFileForRun(['--project', 'parallel', '-g', 'edge drop'], '/root'),
    path.join('/root', 'e2e-report', 'parallel.json'),
  )
})

test('a project-less run still names a file rather than an undefined path', () => {
  // Reachable through a bare `npx playwright test`-shaped argv; a literal
  // "undefined.json" would be a working report under a name nobody searches.
  assert.equal(
    reportFileForRun(['smoke.spec.ts'], '/root'),
    path.join('/root', 'e2e-report', 'e2e.json'),
  )
  assert.equal(reportFileForRun(['--project'], '/root'), path.join('/root', 'e2e-report', 'e2e.json'))
})

// ── foldRunStatuses ────────────────────────────────────────────────────────
// The load-bearing property is that EVERY planned project runs: the fold is
// what lets the loop keep going past a failure instead of returning inside it.
// A regression here reads as "the second project's tests disappeared".

test('every planned project contributes a status, and any red loses', () => {
  assert.equal(foldRunStatuses([0, 0]), 0)
  // The earliest failure wins — a serial-project red is more diagnostic than
  // the parallel-project reds that usually follow from it.
  assert.equal(foldRunStatuses([1, 2]), 1)
  // A red FIRST project must not mask a green second one into an overall pass,
  // nor a green first project mask a red second one.
  assert.equal(foldRunStatuses([1, 0]), 1)
  assert.equal(foldRunStatuses([0, 1]), 1)
})

test('no runs at all is a pass, not a spurious failure', () => {
  // Defensive: planE2ERuns never returns empty today, but folding [] to 0
  // keeps a future single-project plan from inventing an exit code.
  assert.equal(foldRunStatuses([]), 0)
})

// ── splitGateFlags ─────────────────────────────────────────────────────────
// The load-bearing property is negative: Playwright rejects unknown flags, so a
// local gate flag that survives the split does not run an extra gate — it fails
// the whole E2E run before a single spec executes.

test('a gate flag is extracted and never reaches the Playwright argv', () => {
  assert.deepEqual(
    splitGateFlags(['--ruler-gate', 'dock-workspace.spec.ts']),
    { gates: ['--ruler-gate'], args: ['dock-workspace.spec.ts'] },
  )
})

test('non-gate argv passes through untouched and in order', () => {
  const argv = ['--project', 'parallel', '-g', 'edge drop', '--workers=1']
  assert.deepEqual(splitGateFlags(argv), { gates: [], args: argv })
  // Order matters: `-g` and its value must stay adjacent, and `--project`'s
  // separate-token form must not be re-joined.
  assert.deepEqual(
    splitGateFlags(['--ruler-gate', '--project', 'serial', '-g', 'ruler']).args,
    ['--project', 'serial', '-g', 'ruler'],
  )
})

test('a flag that merely looks like a gate is left for Playwright to reject', () => {
  // Only keys of EXTRA_GATES are ours. Swallowing an unrecognized `--*-gate`
  // would turn a typo into a silently skipped gate instead of a loud failure.
  assert.deepEqual(
    splitGateFlags(['--memory-gate', '--ruler-gate']),
    { gates: ['--ruler-gate'], args: ['--memory-gate'] },
  )
})

test('no gate flag survives into either planned Playwright run', () => {
  // The composition `runE2E` actually performs — split first, then plan. This is
  // the assertion that breaks if a future gate is added to EXTRA_GATES but the
  // split is bypassed at the call site.
  const { gates, args } = splitGateFlags(['--ruler-gate', 'dock-workspace.spec.ts'])
  const runs = planE2ERuns(args)
  assert.deepEqual(runs, [
    ['--project=serial', '--pass-with-no-tests', 'dock-workspace.spec.ts'],
    ['--project=parallel', '--pass-with-no-tests', 'dock-workspace.spec.ts'],
  ])
  for (const run of runs) for (const gate of gates) assert.ok(!run.includes(gate))
})

// ── splitSliceFlag / planSlicedRuns ────────────────────────────────────────
// `--slice=<name>` reproduces one electron-ci runner's share of the suite. Which
// files each slice takes is e2e/slices.mjs's business (and e2e-split.test.mjs
// asserts the table); what matters here is that the restriction lands on the
// parallel run ALONE, exactly as the workflow's subshell arranges — inherited by
// the serial project it selects no @serial test and Playwright kills the run.

const SERIAL_SLICE = SLICES.find((slice) => slice.serial).name
const OTHER_SLICE = SLICES.find((slice) => !slice.serial).name

test('--slice is extracted and never reaches the Playwright argv', () => {
  const { slice, args } = splitSliceFlag(['--slice=overlap', '-g', 'export'])
  assert.equal(slice, 'overlap')
  assert.deepEqual(args, ['-g', 'export'])
  const without = splitSliceFlag(['-g', 'export'])
  assert.equal(without.slice, null)
  assert.deepEqual(without.args, ['-g', 'export'])
  // Repeated, the last wins — and every copy still leaves the argv.
  assert.deepEqual(splitSliceFlag(['--slice=audio', '--slice=codecs']), {
    slice: 'codecs',
    args: [],
  })
})

test('no --slice survives into any planned Playwright run', () => {
  const { slice, args } = splitSliceFlag(['--slice=' + SERIAL_SLICE, 'audio.spec.ts'])
  const plan = planSlicedRuns(planE2ERuns(args), slice)
  assert.ok(plan.length > 0)
  for (const run of plan) assert.ok(!run.args.some((arg) => arg.startsWith('--slice=')))
})

test('the slice that owns the serial project runs it, unrestricted', () => {
  const runs = planE2ERuns([])
  const plan = planSlicedRuns(runs, SERIAL_SLICE)
  assert.deepEqual(
    plan.map((run) => run.args),
    runs,
  )
  assert.deepEqual(plan[0].env, {}, 'the serial project must inherit no slice restriction')
  assert.deepEqual(plan[1].env, sliceEnv(SERIAL_SLICE))
})

test('every other slice plans the parallel run only', () => {
  // On CI exactly one slice runs the serial project; the rest must not repeat
  // its 3 minutes, and locally the same rule keeps `--slice=` honest about what
  // that runner actually did.
  const runs = planE2ERuns([])
  const plan = planSlicedRuns(runs, OTHER_SLICE)
  assert.deepEqual(
    plan.map((run) => run.args),
    [runs[1]],
  )
  assert.deepEqual(plan[0].env, sliceEnv(OTHER_SLICE))
})

test('an unsliced plan carries no restriction at all', () => {
  const runs = planE2ERuns(['audio.spec.ts'])
  assert.deepEqual(
    planSlicedRuns(runs, null),
    runs.map((args) => ({ args, env: {} })),
  )
})

test('an unknown slice throws instead of restricting to nothing', () => {
  assert.throws(() => planSlicedRuns(planE2ERuns([]), 'overlaps'), /unknown e2e slice/)
})

test('an explicit serial run under a slice that does not own it plans nothing', () => {
  // runE2E turns the empty plan into a preflight error: having run nothing and
  // exited 0 is indistinguishable from a green suite.
  assert.deepEqual(planSlicedRuns(planE2ERuns(['--project=serial']), OTHER_SLICE), [])
})

// ── prepareE2EEnv ──────────────────────────────────────────────────────────
// Each case builds a throwaway apps/desktop-shaped tree; `platform` is always
// passed explicitly so the assertions are host-independent.

const tmpRoots = []
after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

function makeRoot({ ffmpeg = true, addon = true, out = true, hook = true, analyzer = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'weftcut-run-e2e-'))
  tmpRoots.push(root)
  if (analyzer) {
    const dir = path.join(root, 'native', 'target', 'debug')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'media_conformance'), '')
  }
  if (ffmpeg) {
    const dir = path.join(root, 'resources', 'ffmpeg', 'linux')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'ffmpeg'), '')
    writeFileSync(path.join(dir, 'ffprobe'), '')
  }
  if (addon) {
    const dir = path.join(root, 'native', 'decode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'index.linux-x64-gnu.node'), '')
  }
  if (out) {
    const dir = path.join(root, 'out', 'renderer', 'assets')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'index.js'), hook ? 'window.__weftcutTest={}' : 'render()')
  }
  return root
}

const LINUX = (root, extra = {}) => ({
  platform: 'linux',
  root,
  hasPathFfmpeg: () => false,
  ...extra,
})

test('preflight wires bundled ffmpeg, PATH, and the local decode gates', () => {
  const root = makeRoot()
  const { env, errors, notes } = prepareE2EEnv({ PATH: '/usr/bin', DISPLAY: ':0' }, LINUX(root))
  assert.deepEqual(errors, [])
  assert.equal(env.FFMPEG, path.join(root, 'resources', 'ffmpeg', 'linux', 'ffmpeg'))
  assert.equal(env.FFPROBE, path.join(root, 'resources', 'ffmpeg', 'linux', 'ffprobe'))
  assert.equal(
    env.PATH,
    `${path.join(root, 'resources', 'ffmpeg', 'linux')}${path.delimiter}/usr/bin`,
  )
  assert.equal(env.WEFTCUT_DECODE_E2E, '1')
  assert.equal(notes.length, 3)
})

test('the preflight always names which e2e tier is about to run', () => {
  // A silently shrunken run is indistinguishable from tests having vanished, so
  // BOTH tiers announce themselves — not just the non-default one.
  const root = makeRoot()
  const lean = prepareE2EEnv({ DISPLAY: ':0' }, LINUX(root))
  assert.match(lean.notes.join('\n'), /@matrix cells excluded/)
  const full = prepareE2EEnv({ DISPLAY: ':0', WEFTCUT_E2E_FULL: '1' }, LINUX(root))
  assert.match(full.notes.join('\n'), /@matrix cells included/)
})

test('an explicit FFMPEG wins and leaves PATH untouched', () => {
  const root = makeRoot()
  const { env } = prepareE2EEnv(
    { PATH: '/usr/bin', DISPLAY: ':0', FFMPEG: '/opt/ffmpeg/ffmpeg' },
    LINUX(root),
  )
  assert.equal(env.FFMPEG, '/opt/ffmpeg/ffmpeg')
  assert.equal(env.PATH, '/usr/bin')
})

test('decode gates stay off under CI and honor an explicit opt-out', () => {
  const root = makeRoot()
  const ci = prepareE2EEnv({ DISPLAY: ':0', CI: 'true' }, LINUX(root))
  assert.equal(ci.env.WEFTCUT_DECODE_E2E, undefined)
  const optOut = prepareE2EEnv({ DISPLAY: ':0', WEFTCUT_DECODE_E2E: '0' }, LINUX(root))
  assert.equal(optOut.env.WEFTCUT_DECODE_E2E, '0')
  const noAddon = prepareE2EEnv({ DISPLAY: ':0' }, LINUX(makeRoot({ addon: false })))
  assert.equal(noAddon.env.WEFTCUT_DECODE_E2E, undefined)
})

test('a missing or flag-less build is a fatal preflight error', () => {
  const noOut = prepareE2EEnv({ DISPLAY: ':0' }, LINUX(makeRoot({ out: false })))
  assert.equal(noOut.errors.length, 1)
  assert.match(noOut.errors[0], /build:e2e/)
  const noHook = prepareE2EEnv({ DISPLAY: ':0' }, LINUX(makeRoot({ hook: false })))
  assert.equal(noHook.errors.length, 1)
  assert.match(noHook.errors[0], /VITE_WEFTCUT_E2E/)
})

test('a display-less Linux run fails fast locally but not under CI', () => {
  const root = makeRoot()
  const local = prepareE2EEnv({}, LINUX(root))
  assert.equal(local.errors.length, 1)
  assert.match(local.errors[0], /DISPLAY/)
  const ci = prepareE2EEnv({ CI: 'true' }, LINUX(root))
  assert.deepEqual(ci.errors, [])
  const wayland = prepareE2EEnv({ WAYLAND_DISPLAY: 'wayland-0' }, LINUX(root))
  assert.deepEqual(wayland.errors, [])
})

test('no ffmpeg anywhere degrades to a warning note, not an error', () => {
  const root = makeRoot({ ffmpeg: false })
  const missing = prepareE2EEnv({ DISPLAY: ':0' }, LINUX(root))
  assert.deepEqual(missing.errors, [])
  assert.equal(missing.env.FFMPEG, undefined)
  assert.match(missing.notes.join('\n'), /ffmpeg:fetch/)
  const onPath = prepareE2EEnv(
    { DISPLAY: ':0' },
    LINUX(root, { hasPathFfmpeg: () => true }),
  )
  assert.ok(!onPath.notes.some((n) => n.includes('ffmpeg:fetch')))
})

test('a missing analyzer is announced, because the cost it hides is silent', () => {
  // The gates still pass without it — they just compile it inside the first one,
  // where cargo's progress is captured and dropped. The note is the only warning
  // a reader gets before a spec absorbs minutes for no visible reason.
  const built = prepareE2EEnv({ DISPLAY: ':0' }, LINUX(makeRoot()))
  assert.ok(!built.notes.some((n) => n.includes('analyzer:build')))
  const missing = prepareE2EEnv({ DISPLAY: ':0' }, LINUX(makeRoot({ analyzer: false })))
  assert.deepEqual(missing.errors, [])
  assert.match(missing.notes.join('\n'), /analyzer:build/)
})
