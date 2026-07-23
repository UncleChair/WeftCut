import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { planE2ERuns, prepareE2EEnv } from './run-e2e.mjs'

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

// ── prepareE2EEnv ──────────────────────────────────────────────────────────
// Each case builds a throwaway apps/desktop-shaped tree; `platform` is always
// passed explicitly so the assertions are host-independent.

const tmpRoots = []
after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

function makeRoot({ ffmpeg = true, addon = true, out = true, hook = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'weftcut-run-e2e-'))
  tmpRoots.push(root)
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
  assert.equal(notes.length, 2)
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
