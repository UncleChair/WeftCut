import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertWasmTargetInstalled } from './build-eval-wasm-lib.mjs'

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
