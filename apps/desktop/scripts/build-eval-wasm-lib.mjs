import { execFileSync as nodeExecFileSync } from 'node:child_process'
import { existsSync as nodeExistsSync } from 'node:fs'

export const WASM_TARGET = 'wasm32-unknown-unknown'

/// Set when the generated module was restored from a cache keyed on the very
/// Rust sources that produce it (.github/actions/rust-artifacts). Every CI leg
/// that merely CONSUMES the wasm still chains build:wasm through an npm script
/// — typecheck, build:e2e, vitest — so without this those legs would each need
/// a Rust toolchain and a wasm32 target for an output they already have.
export const PREBUILT_ENV = 'WEFTCUT_EVAL_WASM_PREBUILT'

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

/// Whether to reuse an already-generated module instead of invoking cargo. The
/// cache key is the authority on freshness — this is the restore telling the
/// build its output is current, not a switch for skipping a stale build — so a
/// set flag with no file is a hard error rather than a silent pass.
export function usePrebuiltWasm(outputPath, { env = process.env, fileExists = nodeExistsSync } = {}) {
  if (!env[PREBUILT_ENV]) return false
  if (!fileExists(outputPath)) {
    throw new Error(
      [
        `${PREBUILT_ENV} is set but ${outputPath} does not exist.`,
        'Nothing restored the generated module, so there is no artifact to reuse.',
        `Unset ${PREBUILT_ENV} to build it from source.`,
      ].join('\n'),
    )
  }
  return true
}
