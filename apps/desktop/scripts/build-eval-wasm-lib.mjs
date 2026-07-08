import { execFileSync as nodeExecFileSync } from 'node:child_process'

export const WASM_TARGET = 'wasm32-unknown-unknown'

function formatCommandError(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    return error.message
  }
  return String(error)
}

export function assertWasmTargetInstalled({ execFileSync = nodeExecFileSync } = {}) {
  let installed
  try {
    installed = execFileSync('rustup', ['target', 'list', '--installed'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(
      [
        'Unable to check Rust targets with rustup.',
        'Install Rust through rustup, then run:',
        `  rustup target add ${WASM_TARGET}`,
        '',
        `Original error: ${formatCommandError(error)}`,
      ].join('\n'),
    )
  }

  const targets = String(installed)
    .split(/\r?\n/)
    .map((target) => target.trim())
    .filter(Boolean)

  if (!targets.includes(WASM_TARGET)) {
    throw new Error(
      [
        `${WASM_TARGET} target is not installed.`,
        'Install it once for this Rust toolchain:',
        `  rustup target add ${WASM_TARGET}`,
      ].join('\n'),
    )
  }
}
