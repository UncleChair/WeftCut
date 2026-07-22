import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

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

export function runE2E(args = process.argv.slice(2)) {
  const cli = require.resolve('@playwright/test/cli')
  for (const runArgs of planE2ERuns(args)) {
    const result = spawnSync(
      process.execPath,
      [cli, 'test', '-c', 'playwright.config.ts', ...runArgs],
      { cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))), stdio: 'inherit' },
    )
    if (result.error) throw result.error
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runE2E()
}
