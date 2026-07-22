import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planE2ERuns } from './run-e2e.mjs'

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
