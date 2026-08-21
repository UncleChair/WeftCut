import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PREBUILT_ENV, assertWasmTargetInstalled, usePrebuiltWasm } from './build-eval-wasm-lib.mjs'

test('build:wasm explains how to install the wasm target before invoking cargo', () => {
  assert.throws(
    () => assertWasmTargetInstalled({
      execFileSync(command, args) {
        assert.equal(command, 'rustup')
        assert.deepEqual(args, ['target', 'list', '--installed'])
        return 'x86_64-unknown-linux-gnu\n'
      },
    }),
    /wasm32-unknown-unknown target is not installed[\s\S]*rustup target add wasm32-unknown-unknown/,
  )
})

test('build:wasm invokes cargo unless a restored artifact is declared', () => {
  const out = '/repo/evalWasm.generated.ts'

  assert.equal(usePrebuiltWasm(out, { env: {}, fileExists: () => true }), false)
  assert.equal(
    usePrebuiltWasm(out, { env: { [PREBUILT_ENV]: '1' }, fileExists: (path) => path === out }),
    true,
  )
})

test('a declared-but-absent artifact fails loudly instead of passing silently', () => {
  assert.throws(
    () => usePrebuiltWasm('/repo/evalWasm.generated.ts', {
      env: { [PREBUILT_ENV]: '1' },
      fileExists: () => false,
    }),
    new RegExp(`${PREBUILT_ENV} is set but[\\s\\S]*does not exist`),
  )
})
